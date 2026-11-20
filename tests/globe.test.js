"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

require("../globe/data.js");
const GX = globalThis.GX;

const ms = (iso) => Date.parse(iso);

test("severity thresholds for earthquakes and storms", () => {
  assert.equal(GX.sevFromQuake(7.1), "critical");
  assert.equal(GX.sevFromQuake(6.0), "high");
  assert.equal(GX.sevFromQuake(5.2), "elevated");
  assert.equal(GX.sevFromQuake(4.9), "info");
  assert.equal(GX.sevFromWind(100), "critical");
  assert.equal(GX.sevFromWind(64), "high");
  assert.equal(GX.sevFromWind(34), "elevated");
  assert.equal(GX.sevFromWind(20), "info");
  assert.ok(GX.quakeRadiusKm(7) > GX.quakeRadiusKm(5));
  assert.equal(GX.quakeRadiusKm(1), 5, "radius has a visible floor");
});

test("normalizeUsgs maps features, skips malformed rows and sorts newest first", () => {
  const json = { features: [
    { id: "a", geometry: { coordinates: [139.7, 35.6, 30] }, properties: { mag: 6.4, time: 1000, title: "M 6.4 - Japan", place: "Tokyo", url: "u" } },
    { id: "b", geometry: { coordinates: [10, 20, 5] }, properties: { mag: 3.1, time: 5000, title: "M 3.1" } },
    { id: "bad1", geometry: null, properties: { mag: 5, time: 1 } },
    { id: "bad2", geometry: { coordinates: [1, 2, 3] }, properties: { mag: null, time: 1 } },
    { id: "bad3", geometry: { coordinates: ["x", 2] }, properties: { mag: 5, time: 1 } }
  ] };
  const out = GX.normalizeUsgs(json);
  assert.deepEqual(out.map((e) => e.id), ["usgs-b", "usgs-a"]);
  assert.equal(out[1].sev, "high");
  assert.equal(out[1].depthKm, 30);
  assert.equal(out[1].lat, 35.6);
  assert.deepEqual(GX.normalizeUsgs(null), []);
});

test("normalizeEonet keeps wildfires, volcanoes and storms, with the storm track and wind", () => {
  const json = { events: [
    { id: "S1", title: "Hurricane X", categories: [{ id: "severeStorms", title: "Severe Storms" }], sources: [{ url: "https://s" }], geometry: [
      { date: "2026-11-18T00:00:00Z", type: "Point", coordinates: [-60, 15], magnitudeValue: 70, magnitudeUnit: "kts" },
      { date: "2026-11-19T00:00:00Z", type: "Point", coordinates: [-62, 17], magnitudeValue: 100, magnitudeUnit: "kts" }] },
    { id: "W1", title: "Fire", categories: [{ id: "wildfires", title: "Wildfires" }], geometry: [
      { date: "2026-11-19T06:00:00Z", type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }] },
    { id: "V1", title: "Volcano", categories: [{ id: "volcanoes", title: "Volcanoes" }], geometry: [{ date: "2026-11-17T00:00:00Z", type: "Point", coordinates: [10, 10] }] },
    { id: "I1", title: "Iceberg", categories: [{ id: "seaLakeIce", title: "Ice" }], geometry: [{ date: "2026-11-17T00:00:00Z", type: "Point", coordinates: [1, 1] }] }
  ] };
  const out = GX.normalizeEonet(json), by = Object.fromEntries(out.map((e) => [e.kind, e]));
  assert.equal(out.length, 3, "unrelated categories are dropped");
  assert.equal(by.storm.sev, "critical");
  assert.equal(by.storm.track.length, 2);
  assert.equal(by.storm.lat, 17);
  assert.equal(by.volcano.sev, "high");
  assert.deepEqual([by.wildfire.lon, by.wildfire.lat].map((v) => Math.round(v * 10) / 10), [0.8, 0.8]);
  assert.equal(out[0].id, "eonet-W1", "newest first");
});

test("destination and bearing round-trip, and great circles start and end at their endpoints", () => {
  const p = GX.destination(0, 0, 90, 111.19);
  assert.ok(Math.abs(p.lon - 1) < 0.01 && Math.abs(p.lat) < 0.01);
  assert.ok(Math.abs(GX.bearing(0, 0, 0, 10) - 90) < 1e-6);
  const arc = GX.greatCircle(-74, 40.7, 0, 51.5, 40, 1000000);
  assert.equal(arc.length, 41);
  assert.ok(Math.abs(arc[0].lon + 74) < 1e-6 && Math.abs(arc[40].lat - 51.5) < 1e-6);
  assert.equal(arc[0].h, 0);
  assert.equal(Math.round(arc[20].h), 1000000, "peaks mid-route");
  assert.equal(GX.greatCircle(5, 5, 5, 5, 10, 100).length, 1, "degenerate arc");
});

test("stormCone needs a track and widens along the extrapolated heading", () => {
  assert.equal(GX.stormCone([{ lat: 10, lon: -50 }], 72, 12), null);
  const cone = GX.stormCone([{ lat: 10, lon: -50 }, { lat: 11, lon: -51 }], 72, 12);
  assert.equal(cone.length, 14);
  const width = (a, b) => Math.hypot(a.lat - b.lat, a.lon - b.lon);
  assert.ok(width(cone[6], cone[7]) > width(cone[0], cone[13]), "tip is wider than the start");
});

test("parseCoords accepts comma or space separated valid pairs only", () => {
  assert.deepEqual(GX.parseCoords("37.77, -122.42"), { lat: 37.77, lon: -122.42 });
  assert.deepEqual(GX.parseCoords("-33.9 151.2"), { lat: -33.9, lon: 151.2 });
  assert.equal(GX.parseCoords("91, 10"), null);
  assert.equal(GX.parseCoords("10, 181"), null);
  assert.equal(GX.parseCoords("tokyo"), null);
});

test("market sessions follow each exchange's local clock, weekends and the Globex break", () => {
  const ex = (id) => GX.EXCHANGES.find((e) => e.id === id);
  assert.equal(GX.marketStatus(ex("NYSE"), ms("2026-07-15T14:00:00Z")).state, "open");
  assert.equal(GX.marketStatus(ex("NYSE"), ms("2026-07-15T10:00:00Z")).state, "pre");
  assert.equal(GX.marketStatus(ex("NYSE"), ms("2026-07-15T21:00:00Z")).state, "closed");
  assert.equal(GX.marketStatus(ex("NYSE"), ms("2026-07-18T15:00:00Z")).state, "closed", "Saturday");
  assert.equal(GX.marketStatus(ex("NYSE"), ms("2026-07-15T14:00:00Z")).local, "10:00");
  assert.equal(GX.marketStatus(ex("TSE"), ms("2026-07-15T03:00:00Z")).state, "closed", "12:00 JST is the lunch break");
  assert.equal(GX.marketStatus(ex("TSE"), ms("2026-07-15T03:45:00Z")).state, "open", "12:45 JST");
  assert.equal(GX.marketStatus(ex("TSE"), ms("2026-07-15T00:30:00Z")).state, "open", "09:30 JST");
  assert.equal(GX.marketStatus(ex("HKEX"), ms("2026-07-15T02:00:00Z")).state, "open");
  assert.equal(GX.marketStatus(ex("CME"), ms("2026-07-15T21:30:00Z")).state, "closed", "daily break 16:00-17:00 CT");
  assert.equal(GX.marketStatus(ex("CME"), ms("2026-07-15T23:00:00Z")).state, "open");
  assert.equal(GX.marketStatus(ex("CME"), ms("2026-07-18T15:00:00Z")).state, "closed", "Saturday");
});

test("sensitivity tags reflect region, kind and headline keywords, with a fallback", () => {
  assert.ok(GX.sensitivity({ lat: 24, lon: 121, kind: "quake", title: "M 6 Taiwan" }).includes("Semis (SOX, TSMC)"));
  assert.ok(GX.sensitivity({ lat: -20, lon: -70, kind: "quake", title: "M 6 Chile" }).includes("Copper (HG)"));
  assert.ok(GX.sensitivity({ lat: 26, lon: -90, kind: "storm", title: "Storm" }).includes("Nat gas (NG)"));
  assert.ok(GX.sensitivity({ lat: 0, lon: 0, kind: "story", title: "Tariff threat" }).includes("USD"));
  assert.deepEqual(GX.sensitivity({ lat: 0, lon: 0, kind: "quake", title: "x" }), ["Global risk (VIX)"]);
});

test("timeAgo, window filtering and reference data sanity", () => {
  assert.equal(GX.timeAgo(0, 30000), "30s ago");
  assert.equal(GX.timeAgo(0, 600000), "10m ago");
  assert.equal(GX.timeAgo(0, 7200000), "2h ago");
  assert.equal(GX.timeAgo(0, 3 * 86400000), "3d ago");
  assert.deepEqual(GX.filterWindow([{ t: 1 }, { t: 5 }, { t: 9 }], 2, 8), [{ t: 5 }]);
  [].concat(GX.CHOKEPOINTS, GX.EXCHANGES, GX.CENTRAL_BANKS, GX.CITIES).forEach((p) => {
    assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, p.name || p.id);
  });
  assert.equal(new Set(GX.LAYERS.map((l) => l.id)).size, GX.LAYERS.length);
});
