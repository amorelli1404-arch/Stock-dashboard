"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

require("../bias/bias.js");
require("../news/events.js");
const NEWS = globalThis.NEWS;
const NOW = Date.UTC(2026, 10, 28, 14, 0, 0), HOUR = 3600000;
const name = (title, desc) => (NEWS.locate(title, desc) || {}).name;

test("the refresh interval is 30 minutes", () => {
  assert.equal(NEWS.REFRESH_MS, 30 * 60000);
});

test("headlines are placed by the first place they name", () => {
  assert.equal(name("Explosion at a school in eastern Afghanistan kills dozens"), "Afghanistan");
  assert.equal(name("Argentina's bid to stop Falklands oil drilling rejected"), "Argentina");
  assert.equal(name("Iran points to Europe's war role after Italians killed"), "Iran");
  assert.equal(name("Tankers reroute away from the Strait of Hormuz"), "Strait of Hormuz");
  assert.equal(name("South Sudan delays vote"), "South Sudan", "longer name wins");
  assert.equal(name("North Korea fires missile"), "North Korea");
});

test("the US only wins when no other place is named", () => {
  assert.equal(name("U.S. denies Iran claims over carrier"), "Iran");
  assert.equal(name("Trump signs spending bill"), "United States");
  assert.equal(name("US October trade balance widens"), "United States");
  assert.equal(name("Tell us what you think"), undefined, "lowercase 'us' is not a country");
});

test("the summary is used only when the headline names no place, and unplaceable items are skipped", () => {
  assert.equal(name("Rescuers search through the night", "Floods hit northern Vietnam"), "Vietnam");
  assert.equal(name("Markets await the data"), undefined);
  assert.equal(name("A turkey recipe for the holidays"), undefined, "matching is case sensitive");
});

test("severity reflects what the headline describes", () => {
  assert.equal(NEWS.severity("Airstrikes kill 12"), "high");
  assert.equal(NEWS.severity("New tariffs announced"), "elevated");
  assert.equal(NEWS.severity("Museum reopens"), "info");
});

test("clustering groups by place, removes duplicates and stale items, newest first", () => {
  const item = (title, hoursAgo, source = "A") => ({ title, ts: NOW - hoursAgo * HOUR, link: "https://x.test", source, desc: "" });
  const pins = NEWS.cluster([
    item("Japan central bank holds rates", 5), item("Japan quake shakes north", 1), item("JAPAN QUAKE SHAKES NORTH!", 2, "B"),
    item("Chile votes", 3), item("Brazil old story", 60), item("Nothing placeable here", 1), item("Peru from the future", -5)
  ], NOW);
  assert.deepEqual(pins.map((p) => p.loc), ["Japan", "Chile"]);
  assert.equal(pins[0].count, 2, "the duplicate headline is counted once");
  assert.equal(pins[0].items[0].title, "Japan quake shakes north");
  assert.equal(pins[0].sev, "high", "the worst headline at a place sets its colour");
});

test("GDACS alerts keep recent orange and red events with safe links", () => {
  const f = (id, level, todate, url, coords = [80, 15]) => ({ properties: { eventtype: "TC", eventid: id, alertlevel: level, todate, name: "Cyclone " + id, country: "India", url: { report: url } }, geometry: { coordinates: coords } });
  const out = NEWS.parseGdacs({ features: [
    f(1, "Red", "2026-11-27T00:00:00", "https://gdacs.test/1"), f(2, "Orange", "2026-11-01T00:00:00", "https://gdacs.test/2"),
    f(3, "Orange", "2026-11-28T00:00:00", "javascript:alert(1)"), f(4, "Red", "2026-11-28T00:00:00", "https://x", [500, 15]), f(1, "Red", "2026-11-27T00:00:00", "https://gdacs.test/1")
  ] }, NOW);
  assert.deepEqual(out.map((p) => p.id), ["gdacs-TC-1", "gdacs-TC-3"], "old, invalid and duplicate events are dropped; red first");
  assert.equal(out[0].sev, "critical");
  assert.equal(out[1].items[0].link, null, "non-https links are dropped");
  assert.deepEqual(NEWS.parseGdacs(null, NOW), []);
});

test("green quakes and floods are kept as lesser alerts, green wildfires are dropped, serious alerts come first", () => {
  const f = (id, type, level, hoursAgo) => ({ properties: { eventtype: type, eventid: id, alertlevel: level, todate: new Date(NOW - hoursAgo * HOUR).toISOString().slice(0, 19), name: type + id }, geometry: { coordinates: [10, 10] } });
  const out = NEWS.parseGdacs({ features: [f(1, "WF", "Green", 1), f(2, "EQ", "Green", 1), f(3, "FL", "Green", 2), f(4, "DR", "Orange", 48), f(5, "WF", "Red", 30)] }, NOW);
  assert.deepEqual(out.map((p) => p.id), ["gdacs-WF-5", "gdacs-DR-4", "gdacs-EQ-2", "gdacs-FL-3"]);
  assert.deepEqual(out.map((p) => p.sev), ["critical", "high", "elevated", "elevated"]);
});

test("a failed source keeps its earlier items and is reported as failed", async () => {
  const realFetch = globalThis.fetch;
  let failBbc = false;
  globalThis.fetch = async (url) => {
    if (url.includes("gdacs")) return { ok: true, json: async () => ({ features: [] }) };
    if (failBbc && url.includes("bbci")) return { ok: false, status: 429 };
    const place = url.includes("bbci") ? "Kenya" : "Norway";
    const stamp = new Date(Date.now() - 60000).toISOString().slice(0, 19).replace("T", " ");
    return { ok: true, json: async () => ({ items: [{ title: place + " news " + url.length, pubDate: stamp, link: "https://x.test" }] }) };
  };
  try {
    await NEWS.refresh();
    assert.ok(NEWS.state.pins.some((p) => p.loc === "Kenya"));
    failBbc = true;
    await NEWS.refresh();
    assert.equal(NEWS.state.status.bbc, false);
    assert.ok(NEWS.state.pins.some((p) => p.loc === "Kenya"), "earlier items survive");
    assert.ok(NEWS.state.nextAt - Date.now() > 29 * 60000, "next run is about 30 minutes away");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.after(() => NEWS.stop());
