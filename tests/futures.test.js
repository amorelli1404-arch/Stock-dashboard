"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

require("../orderflow/config.js");
require("../orderflow/analytics.js");
require("../futures/engine.js");
require("../futures/feed.js");
const FD = globalThis.FD;
const E = FD.engine;

const T0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const mk = (barMs = 60000, over = {}) => E.create("MNQ", Object.assign({ barMs }, over));
const tr = (m, price, size, side, ts) => E.ingestTrade(m, { price, size, side, ts });

function runSim(symbol, ms, seed = 7) {
  const trades = [], books = [];
  const sim = new FD.Sim(FD.SYMBOLS[symbol], { symbol, seed, startTs: T0, out: { trade: (t) => trades.push(t), book: (b) => books.push(b) } });
  sim.advance(ms);
  return { sim, trades, books };
}

/* ---------- Simulator ---------- */
test("simulator is deterministic for a seed and differs across seeds", () => {
  const a = runSim("MNQ", 60000, 5), b = runSim("MNQ", 60000, 5), c = runSim("MNQ", 60000, 6);
  assert.deepEqual(a.trades.slice(0, 50), b.trades.slice(0, 50));
  assert.notDeepEqual(a.trades.slice(0, 50), c.trades.slice(0, 50));
});

test("every simulated price sits on the tick grid, for all four contracts", () => {
  Object.keys(FD.SYMBOLS).forEach((s) => {
    const { trades, books } = runSim(s, 120000);
    assert.ok(trades.length > 200, s + " produced trades");
    trades.forEach((t) => assert.ok(Math.abs(t.price / 0.25 - Math.round(t.price / 0.25)) < 1e-9, s + " " + t.price));
    books.slice(-3).forEach((b) => {
      assert.ok(b.asks[0][0] > b.bids[0][0], "book is not crossed");
      b.bids.concat(b.asks).forEach((r) => assert.ok(Math.abs(r[0] / 0.25 - Math.round(r[0] / 0.25)) < 1e-9 && r[1] >= 1));
    });
  });
});

test("trade sizes are positive integers with a lognormal-like right tail and a mean near the configured average", () => {
  const { trades } = runSim("MNQ", 600000);
  const sizes = trades.map((t) => t.size);
  assert.ok(sizes.every((s) => Number.isInteger(s) && s >= 1));
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length, sorted = sizes.slice().sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(mean > median, "right-skewed: mean above median");
  assert.ok(mean > 1.5 && mean < 9, "mean " + mean);
  assert.ok(sorted[sorted.length - 1] >= 15, "bursts produce occasional large prints");
});

test("buys print at the offer and sells at the bid, and the book stays inside the tick grid after sweeps", () => {
  const { trades } = runSim("ES", 60000);
  assert.ok(trades.some((t) => t.side === "buy") && trades.some((t) => t.side === "sell"));
  const sim = new FD.Sim(FD.SYMBOLS.ES, { symbol: "ES", seed: 1, startTs: T0 });
  const before = sim.bb, fills = sim.fill("buy", 1000);
  assert.ok(fills.length > 1, "a large order sweeps several levels");
  assert.ok(sim.bb > before, "the touch moved up");
  assert.deepEqual(fills.map((f) => f.price), fills.map((f) => f.price).slice().sort((a, b) => a - b));
});

test("simulated flow alternates between trending and ranging regimes", () => {
  const sim = new FD.Sim(FD.SYMBOLS.MNQ, { symbol: "MNQ", seed: 3, startTs: T0 }), kinds = new Set();
  for (let i = 0; i < 30000; i++) { sim.step(); kinds.add(sim.regime.kind); }
  assert.ok(kinds.has("trend") && kinds.has("range"));
});

/* ---------- Engine ---------- */
test("trades build footprint bars with per-price volume, delta, cvd and OHLC", () => {
  const m = mk();
  tr(m, 23100, 5, "buy", T0);
  tr(m, 23100.25, 3, "buy", T0 + 1000);
  tr(m, 23099.75, 4, "sell", T0 + 2000);
  const b = m.bars[0];
  assert.deepEqual([b.o, b.h, b.l, b.c], [92400, 92401, 92399, 92399]);
  assert.equal(b.vol, 12);
  assert.equal(b.delta, 4);
  assert.deepEqual(b.levels.get(92400), { a: 5, b: 0 });
  assert.equal(m.cvd, 4);
  tr(m, 23100, 2, "sell", T0 + 61000);
  assert.equal(m.bars.length, 2);
  assert.equal(m.bars[1].cvdC, 2);
  assert.equal(m.bars[0].closed, true);
});

test("invalid trades are dropped and counted, and stale trades are rejected", () => {
  const m = mk();
  assert.equal(tr(m, NaN, 1, "buy", T0), false);
  assert.equal(tr(m, 23100, 0, "buy", T0), false);
  assert.equal(E.ingestTrade(m, null), false);
  tr(m, 23100, 1, "buy", T0 + 5 * 60000);
  assert.equal(tr(m, 23100, 1, "buy", T0), false, "older than two bars");
  assert.equal(m.dropped, 4);
});

test("side is inferred from the book when a relay omits it", () => {
  const m = mk();
  E.ingestBook(m, { bids: [[23100, 10]], asks: [[23100.25, 10]] });
  tr(m, 23100.25, 1, undefined, T0);
  tr(m, 23100, 1, undefined, T0 + 10);
  assert.deepEqual(m.tape.map((t) => t.side), ["sell", "buy"]);
});

test("diagonal imbalances compare ask[p] with bid[p-1] and bid[p] with ask[p+1], never the same row", () => {
  const levels = new Map([[100, { a: 1, b: 8 }], [101, { a: 12, b: 2 }], [102, { a: 2, b: 9 }], [103, { a: 1, b: 1 }]]);
  const r = E.imbalances(levels, 3, 4);
  assert.deepEqual(Array.from(r.buy), [], "ask 12 at 101 is under 3 x the bid of 8 one tick below");
  assert.deepEqual(Array.from(r.sell), [102], "bid 9 at 102 is over 3 x the ask of 1 one tick above");
});

test("a 300% buy imbalance needs ask >= 3 x the bid one tick below", () => {
  const ok = E.imbalances(new Map([[100, { a: 0, b: 4 }], [101, { a: 12, b: 0 }]]), 3, 4);
  assert.deepEqual(Array.from(ok.buy), [101]);
  const no = E.imbalances(new Map([[100, { a: 0, b: 5 }], [101, { a: 12, b: 0 }]]), 3, 4);
  assert.equal(no.buy.size, 0);
  const sell = E.imbalances(new Map([[100, { a: 0, b: 12 }], [101, { a: 4, b: 0 }]]), 3, 4);
  assert.deepEqual(Array.from(sell.sell), [100]);
  assert.equal(E.imbalances(new Map([[100, { a: 0, b: 0 }], [101, { a: 3, b: 0 }]]), 3, 4).buy.size, 0, "below the minimum volume");
});

test("three or more adjacent imbalances form a stack; a gap breaks it", () => {
  const lv = new Map();
  [100, 101, 102, 103].forEach((p) => lv.set(p, { a: 20, b: 0 }));
  lv.set(105, { a: 20, b: 0 }); lv.set(106, { a: 20, b: 0 });
  const r = E.imbalances(lv, 3, 4);
  assert.deepEqual(r.stacks, [{ side: "buy", lo: 100, hi: 103, n: 4 }]);
});

test("bar close raises a stacked-imbalance alert stamped at the bar end", () => {
  const m = mk(60000, { ratio: 3 });
  [0, 1, 2].forEach((i) => { tr(m, 23100 + i * 0.25, 20, "buy", T0 + i * 100); });
  tr(m, 23100, 1, "buy", T0 + 61000);
  const a = m.alerts.find((x) => x.type === "stacked");
  assert.ok(a, "stack alert");
  assert.equal(a.side, "buy");
  assert.equal(a.ts, T0 + 60000);
});

test("absorption: heavy volume, price pinned within 2 ticks, strongly signed delta", () => {
  const m = mk(60000);
  for (let b = 0; b < 5; b++) tr(m, 23100 + (b % 2) * 0.25, 10, b % 2 ? "buy" : "sell", T0 + b * 60000);
  for (let i = 0; i < 12; i++) tr(m, 23100, 10, "sell", T0 + 5 * 60000 + i * 100);
  tr(m, 23100, 1, "buy", T0 + 6 * 60000);
  const a = m.alerts.find((x) => x.type === "absorption");
  assert.ok(a, "absorption alert");
  assert.equal(a.side, "buy", "selling absorbed by buyers");
});

test("no absorption alert when price moves more than 2 ticks", () => {
  const m = mk(60000);
  for (let b = 0; b < 5; b++) tr(m, 23100, 10, "buy", T0 + b * 60000);
  for (let i = 0; i < 12; i++) tr(m, 23100 + i * 0.25, 10, "sell", T0 + 5 * 60000 + i * 100);
  tr(m, 23100, 1, "buy", T0 + 6 * 60000);
  assert.equal(m.alerts.some((x) => x.type === "absorption"), false);
});

test("delta divergence: new high with negative delta is bearish, new low with positive delta is bullish", () => {
  const m = mk(60000);
  for (let b = 0; b < 6; b++) { tr(m, 23100 + b * 0.25, 5, "buy", T0 + b * 60000); tr(m, 23100 + b * 0.25, 5, "sell", T0 + b * 60000 + 10); }
  tr(m, 23110, 3, "buy", T0 + 6 * 60000);
  tr(m, 23109.75, 9, "sell", T0 + 6 * 60000 + 10);
  tr(m, 23100, 1, "buy", T0 + 7 * 60000);
  const d = m.alerts.find((x) => x.type === "divergence");
  assert.ok(d && d.side === "sell", "bearish");

  const n = mk(60000);
  for (let b = 0; b < 6; b++) { tr(n, 23100 - b * 0.25, 5, "buy", T0 + b * 60000); tr(n, 23100 - b * 0.25, 5, "sell", T0 + b * 60000 + 10); }
  tr(n, 23090, 9, "buy", T0 + 6 * 60000);
  tr(n, 23090.25, 3, "sell", T0 + 6 * 60000 + 10);
  tr(n, 23100, 1, "buy", T0 + 7 * 60000);
  const u = n.alerts.find((x) => x.type === "divergence");
  assert.ok(u && u.side === "buy", "bullish");
});

test("large prints use the configured threshold and are summarised at bar close", () => {
  const m = mk(60000, { big: 30 });
  tr(m, 23100, 29, "buy", T0);
  tr(m, 23100.25, 45, "sell", T0 + 10);
  assert.equal(m.bigCount, 1);
  assert.equal(m.tape[0].big, true);
  assert.equal(m.tape[1].big, false);
  tr(m, 23100, 1, "buy", T0 + 61000);
  assert.match(m.alerts.find((x) => x.type === "large").text, /1 large print.*largest 45 sell/);
});

test("tick() closes a quiet bar so alerts are not delayed", () => {
  const m = mk(60000);
  [0, 1, 2].forEach((i) => tr(m, 23100 + i * 0.25, 20, "buy", T0 + i * 100));
  E.tick(m, T0 + 30000);
  assert.equal(m.alerts.length, 0);
  E.tick(m, T0 + 60001);
  assert.ok(m.alerts.some((a) => a.type === "stacked"));
});

test("memory is bounded: bars, tape and alerts never exceed their caps", () => {
  const m = mk(15000);
  for (let i = 0; i < FD.LIMITS.maxBars + 200; i++) {
    tr(m, 23100 + (i % 7) * 0.25, 40, i % 2 ? "buy" : "sell", T0 + i * 15000);
    tr(m, 23100.25 + (i % 7) * 0.25, 40, "buy", T0 + i * 15000 + 5);
  }
  assert.equal(m.bars.length, FD.LIMITS.maxBars);
  assert.ok(m.tape.length <= FD.LIMITS.tape);
  assert.ok(m.alerts.length <= FD.LIMITS.alerts);
});

test("book ingestion keeps best levels, flags pulls and stacks, and rejects junk", () => {
  const m = mk();
  assert.equal(E.ingestBook(m, { bids: "x", asks: [] }), false);
  assert.equal(E.ingestBook(m, { bids: [], asks: [] }), false);
  const rest = FD.SYMBOLS.MNQ.rest;
  E.ingestBook(m, { bids: [[23100, rest], [23099.75, 10]], asks: [[23100.25, 10], [23100.5, 10]] });
  assert.equal(m.bids[0].tick, 92400);
  E.ingestBook(m, { bids: [[23100, 5], [23099.75, 10]], asks: [[23100.25, 10], [23100.5, rest * 2]] });
  assert.equal(m.flashes.get(92400).kind, "pull");
  assert.equal(m.flashes.get(92402).kind, "stack");
});

test("stats expose POC, value area, VWAP, buy percentage and the session change", () => {
  const m = mk();
  assert.equal(E.stats(m), null, "no stats before the first trade");
  tr(m, 23100, 10, "buy", T0); tr(m, 23100.25, 30, "buy", T0 + 10); tr(m, 23100.5, 10, "sell", T0 + 20);
  const s = E.stats(m);
  assert.equal(s.vol, 50);
  assert.equal(s.delta, 30);
  assert.equal(s.buyPct, 80);
  assert.equal(s.poc, 23100.25);
  assert.ok(Math.abs(s.vwap - (23100 * 10 + 23100.25 * 30 + 23100.5 * 10) / 50) < 1e-9);
  assert.equal(s.change, 0.5);
});

/* ---------- Feed ---------- */
test("feed normalises seconds to milliseconds, drops junk and honours pause", () => {
  const f = new FD.Feed(), got = [];
  f.on("trade", (t) => got.push(t));
  f.ingestTrade({ ts: 1795000000, price: 23100, size: 2, side: "buy" });
  assert.equal(got[0].ts, 1795000000000);
  assert.equal(f.ingestTrade({ ts: T0, price: -1, size: 1, side: "buy" }), false);
  assert.equal(f.ingestBook({ bids: 1 }), false);
  assert.equal(f.invalid, 2);
  f.setPaused(true);
  assert.equal(f.ingestTrade({ ts: T0, price: 23100, size: 1, side: "buy" }), false);
});

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; }
  send(m) { this.sent.push(m); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; this.onopen(); }
  push(obj) { this.onmessage({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
}

test("relay is never reported live until it is open AND data has arrived", () => {
  global.WebSocket = FakeWS;
  const f = new FD.Feed(), states = [], trades = [];
  f.on("status", (s) => states.push(s.state));
  f.on("trade", (t) => trades.push(t));
  assert.equal(f.connect("not a url", "MNQ"), false);
  assert.equal(f.state, "disconnected");
  f.connect("ws://127.0.0.1:9999/stream", "MNQ");
  assert.equal(f.state, "connecting");
  FakeWS.last.open();
  assert.equal(f.state, "waiting", "open but silent is not live");
  assert.deepEqual(JSON.parse(FakeWS.last.sent[0]), { action: "subscribe", symbol: "MNQ" });
  FakeWS.last.push({ type: "trade", ts: T0, price: 23100, size: 2, side: "buy" });
  assert.equal(f.state, "live");
  FakeWS.last.push([{ type: "trade", ts: T0 + 1, price: 23100.25, size: 1, side: "sell" }, { type: "book", bids: [[23100, 5]], asks: [[23100.25, 5]] }, { type: "hello" }]);
  FakeWS.last.push("not json");
  assert.equal(trades.length, 2);
  assert.equal(f.invalid, 1);
  f.lastMsg = Date.now() - 20000;
  f.refreshRelayState();
  assert.equal(f.state, "stale");
  f.stop();
  delete global.WebSocket;
});

test("a dropped relay reports disconnected and reconnects", () => {
  global.WebSocket = FakeWS;
  const f = new FD.Feed();
  f.connect("wss://relay.example/stream", "ES");
  const first = FakeWS.last;
  first.open();
  first.close();
  assert.equal(f.state, "disconnected");
  assert.match(f.text, /reconnecting/);
  f.stop();
  delete global.WebSocket;
});
