"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

require("../bias/bias.js");
const GB = globalThis.GB;

const T = Date.UTC(2026, 10, 25, 14, 30, 0); // Wednesday
const day = GB.dayStartUtc(T);
const bars = (closes, o0 = closes[0]) => closes.map((c, i) => ({ t: day + i * 300000, o: i ? closes[i - 1] : o0, h: Math.max(c, i ? closes[i - 1] : o0) + 0.1, l: Math.min(c, i ? closes[i - 1] : o0) - 0.1, c }));
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => from + (to - from) * i / (n - 1));

test("countdown and time-ago formats match the card style", () => {
  assert.equal(GB.fmtCountdown(10 * 3600000 + 39 * 60000), "10h39");
  assert.equal(GB.fmtCountdown(9 * 60000), "0h09");
  assert.equal(GB.fmtCountdown(0), "0h00");
  assert.equal(GB.fmtCountdown(61 * 1000), "0h02", "rounds up");
  assert.equal(GB.timeAgo(T - 20000, T), "just now");
  assert.equal(GB.timeAgo(T - 9 * 60000, T), "9 min ago");
  assert.equal(GB.timeAgo(T - 69 * 60000, T), "1 h 9 min ago");
  assert.equal(GB.timeAgo(T - (27 * 60 + 5) * 60000, T), "1 d 3 h ago");
});

test("sessions report open or next open, and skip weekends", () => {
  const find = (id, now) => GB.sessionState(GB.SESSIONS.find((s) => s.id === id), now);
  const ny = find("newyork", T); // 14:30 UTC is the open
  assert.equal(ny.open, true);
  assert.equal(ny.ms, 6.5 * 3600000);
  const tokyo = find("tokyo", T);
  assert.equal(tokyo.open, false);
  assert.equal(tokyo.ms, 10.5 * 3600000, "opens tomorrow 01:00 UTC");
  const sat = Date.UTC(2026, 10, 28, 12, 0, 0);
  const monOpen = find("london", sat);
  assert.equal(monOpen.open, false);
  assert.equal(new Date(monOpen.at).getUTCDay(), 1, "next open is Monday");
  assert.equal(find("newyork", Date.UTC(2026, 10, 28, 15, 0, 0)).open, false, "closed on Saturday");
});

test("a steady fall that closes near the low scores bearish and is a trend day", () => {
  const r = GB.score(bars(ramp(100, 98.2, 60)), 1.3, day + 60 * 300000);
  assert.equal(r.ready, true);
  assert.equal(r.label, "Bearish");
  assert.ok(r.score <= -40, "score " + r.score);
  assert.equal(r.dayType, "Trend day");
  assert.equal(r.state, "Set");
  assert.ok(r.pct < -1.5);
});

test("a steady rise scores bullish, and the score is bounded", () => {
  const r = GB.score(bars(ramp(100, 103, 60)), 0.9, day + 60 * 300000);
  assert.equal(r.label, "Bullish");
  assert.ok(r.score > 20 && r.score <= 100);
  const wild = GB.score(bars(ramp(100, 140, 60)), 0.9, day + 60 * 300000);
  assert.ok(wild.score <= 100 && wild.score >= -100);
});

test("a flat, tight day is neutral and a range day", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.05 : -0.05));
  const r = GB.score(bars(closes), 0.9, day + 60 * 300000);
  assert.equal(r.label, "Neutral");
  assert.equal(r.dayType, "Range day");
  assert.ok(Math.abs(r.score) < 20);
});

test("a live price outside the last candle extends the day range and moves the score", () => {
  const c = bars(ramp(100, 100.2, 40));
  const a = GB.score(c, 0.9, day + 40 * 300000);
  const b = GB.score(c, 0.9, day + 40 * 300000, 98.5);
  assert.ok(b.score < a.score);
  assert.equal(b.lo, 98.5);
  assert.equal(b.last, 98.5);
});

test("not enough data reads as forming, and no data or stale data reads as waiting", () => {
  assert.equal(GB.score(bars([100, 100.1, 100.2]), 0.9, day + 900000).state, "Forming");
  const w = GB.score([], 0.9, T);
  assert.equal(w.ready, false);
  assert.equal(w.dayType, "Waiting for Asia");
  const old = bars(ramp(100, 101, 20)).map((c) => Object.assign({}, c, { t: c.t - 3 * 86400000 }));
  assert.equal(GB.score(old, 0.9, T).state, "Waiting", "yesterday's candles alone are not today");
});

test("weights add to one", () => {
  const w = GB.WEIGHTS;
  assert.ok(Math.abs(w.move + w.range + w.momentum - 1) < 1e-9);
});

test("headline parsing: UTC dates, tag stripping, link safety, newest first", () => {
  const items = GB.parseFeed({ items: [
    { title: "Older &amp; quiet", pubDate: "2026-11-25 10:00:00", link: "https://x.test/a", description: "<p>Hello</p>" },
    { title: "Breaking: <b>Tariffs</b> hit", pubDate: "2026-11-25 13:21:00", link: "javascript:alert(1)", description: "" },
    { title: "", pubDate: "2026-11-25 13:00:00", link: "https://x.test/c" },
    { title: "Bad date", pubDate: "nope", link: "https://x.test/d" }
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Breaking: Tariffs hit");
  assert.equal(items[0].link, null, "non-http links are dropped");
  assert.equal(items[1].title, "Older & quiet");
  assert.equal(items[1].desc, "Hello");
  assert.equal(items[1].ts, Date.UTC(2026, 10, 25, 10, 0, 0));
  assert.deepEqual(GB.parseFeed(null), []);
});

test("alert detection and instrument matching", () => {
  assert.equal(GB.isAlert("Oil prices plunge as Middle East escalation fears ease"), true);
  assert.equal(GB.isAlert("Morning coffee thoughts"), false);
  assert.equal(GB.isAlert("Warrant issued for local firm"), false, "whole words only");
  const items = [{ title: "Gold hits record as dollar slips" }, { title: "Nasdaq leads as chip stocks rally" }, { title: "ECB's Lagarde speaks" }];
  const by = (id) => GB.related(items, GB.INSTRUMENTS.find((i) => i.id === id)).map((i) => i.title);
  assert.deepEqual(by("GC"), ["Gold hits record as dollar slips"]);
  assert.deepEqual(by("NQ"), ["Nasdaq leads as chip stocks rally"]);
  assert.ok(by("EURUSD").includes("ECB's Lagarde speaks"));
});

test("klines parse and junk rows are skipped; formatting helpers", () => {
  const c = GB.parseKlines([[1, "10", "11", "9", "10.5"], ["x", "1", "1", "1", "1"], [2, "0", "1", "1", "1"], null]);
  assert.deepEqual(c, [{ t: 1, o: 10, h: 11, l: 9, c: 10.5 }]);
  assert.deepEqual(GB.parseKlines(null), []);
  assert.equal(GB.fmtPrice(25429, 2), "25,429.00");
  assert.equal(GB.fmtPrice(1.09625, 5), "1.09625");
  assert.equal(GB.fmtPct(-3.2399), "-3.24%");
  assert.equal(GB.fmtPct(0), "0.00%");
});
