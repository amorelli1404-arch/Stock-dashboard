"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

["config", "analytics", "calendar", "sessions", "engine", "feeds", "trading", "audio"].forEach((f) => require(`../orderflow/${f}.js`));
const OF = globalThis.OF;
const A = OF.analytics, E = OF.engine, T = OF.trading;

const T0 = Date.UTC(2026, 6, 15, 14, 0, 0);
const et = (y, mo, d, h, mi) => OF.calendar.etToUtc(y, mo, d, h, mi);
const tr = (price, size, side, ts) => ({ price, size, side, ts });

/* ---------- Sessions, IB / ORB ---------- */
test("sessionOf maps New York time to Asia, London, NY RTH and post, across midnight and DST", () => {
  assert.equal(OF.sessions.sessionOf(et(2026, 7, 15, 2, 0)), "asia");
  assert.equal(OF.sessions.sessionOf(et(2026, 7, 15, 20, 0)), "asia");
  assert.equal(OF.sessions.sessionOf(et(2026, 7, 15, 5, 0)), "london");
  assert.equal(OF.sessions.sessionOf(et(2026, 7, 15, 9, 30)), "ny");
  assert.equal(OF.sessions.sessionOf(et(2026, 1, 15, 15, 59)), "ny");
  assert.equal(OF.sessions.sessionOf(et(2026, 7, 15, 16, 0)), "post");
});

test("Initial Balance and ORB track the window high/low and reset each day", () => {
  const m = E.create("ES", OF.config);
  E.applyTrade(m, tr(6480, 1, "buy", et(2026, 7, 15, 9, 29)));
  E.applyTrade(m, tr(6481, 1, "buy", et(2026, 7, 15, 9, 31)));
  E.applyTrade(m, tr(6486, 1, "buy", et(2026, 7, 15, 9, 40)));
  E.applyTrade(m, tr(6479, 1, "sell", et(2026, 7, 15, 10, 20)));
  E.applyTrade(m, tr(6500, 1, "buy", et(2026, 7, 15, 10, 45)));
  assert.deepEqual(m.ib.get(), { day: "2026-07-15", h: 6486, l: 6479 });
  assert.deepEqual(m.orb.get(), { day: "2026-07-15", h: 6486, l: 6481 });
  E.applyTrade(m, tr(6490, 1, "buy", et(2026, 7, 16, 9, 31)));
  assert.deepEqual(m.ib.get(), { day: "2026-07-16", h: 6490, l: 6490 });
});

test("an opening range breakout raises one alert per direction", () => {
  const m = E.create("ES", OF.config);
  E.applyTrade(m, tr(6481, 1, "buy", et(2026, 7, 15, 9, 31)));
  E.applyTrade(m, tr(6484, 1, "buy", et(2026, 7, 15, 9, 40)));
  E.applyTrade(m, tr(6490, 1, "buy", et(2026, 7, 15, 9, 50)));
  E.applyTrade(m, tr(6491, 1, "buy", et(2026, 7, 15, 9, 51)));
  assert.equal(m.alerts.filter((a) => /Opening range breakout above/.test(a.text)).length, 1);
});

/* ---------- Delta, tape, sweeps, blocks ---------- */
test("bars keep buy and sell volume and the delta high and low", () => {
  const m = E.create("ES", OF.config);
  [["buy", 5], ["sell", 9], ["buy", 2]].forEach(([side, size], i) => E.applyTrade(m, tr(6481, size, side, T0 + i * 100)));
  const b = m.bars[0];
  assert.deepEqual([b.bv, b.sv, b.delta, b.dMax, b.dMin], [7, 9, -2, 5, -4]);
});

test("a fast same-side burst across 3 levels is a sweep and a slow one is not", () => {
  const m = E.create("ES", OF.config);
  [6481, 6481.25, 6481.5].forEach((p, i) => E.applyTrade(m, tr(p, 2, "buy", T0 + i * 10)));
  assert.equal(m.tape.every((e) => e.sweep), true, "earlier prints of the run are flagged too");
  assert.equal(m.alerts.filter((a) => /sweep/.test(a.text)).length, 1);
  const slow = E.create("ES", OF.config);
  [6481, 6481.25, 6481.5].forEach((p, i) => E.applyTrade(slow, tr(p, 2, "buy", T0 + i * 1000)));
  assert.equal(slow.tape.some((e) => e.sweep), false);
});

test("block prints are marked and the tape is capped", () => {
  const cfg = Object.assign({}, OF.config, { tape: Object.assign({}, OF.config.tape, { max: 5 }) });
  const m = E.create("ES", cfg);
  E.applyTrade(m, tr(6481, OF.config.symbols.ES.iceMin, "sell", T0));
  assert.equal(m.tape[0].block, true);
  for (let i = 1; i <= 9; i++) E.applyTrade(m, tr(6481, 1, "buy", T0 + i * 1000));
  assert.equal(m.tape.length, 5);
  assert.equal(m.tape[4].seq, 9);
});

/* ---------- Liquidity heatmap history ---------- */
const bookOf = (m, bidSize, askSize) => {
  const bids = [], asks = [];
  for (let i = 0; i < 3; i++) { bids.push([6481 - i * 0.25, bidSize]); asks.push([6481.25 + i * 0.25, askSize]); }
  E.applyBook(m, bids, asks);
};
const heatCfg = (over) => Object.assign({}, OF.config, { barMs: 1000, heat: Object.assign({}, OF.config.heat, { minIntervalMs: 1000, colsPerBar: 1 }, over) });

test("the heatmap records one column per interval and caps its history", () => {
  const m = E.create("ES", heatCfg({ maxCols: 4 }));
  for (let i = 0; i < 10; i++) { E.applyTrade(m, tr(6481, 1, "buy", T0 + i * 1000)); bookOf(m, 20, 20); }
  assert.equal(m.heat.cols.length, 4);
  assert.deepEqual(m.heat.cols[3].b.slice(0, 2), [A.toTick(6481, 0.25), 20]);
  assert.equal(m.heat.cols[3].px, A.toTick(6481, 0.25));
});

test("a large resting order that vanishes untraded is a pull, one that traded is not", () => {
  const wall = OF.config.symbols.ES.wallMin * 2;
  const run = (consume) => {
    const m = E.create("ES", heatCfg({}));
    E.applyTrade(m, tr(6481, 1, "buy", T0));
    bookOf(m, wall, 20);
    E.applyTrade(m, tr(6481, 1, "sell", T0 + 1000));
    bookOf(m, wall, 20);
    if (consume) E.applyTrade(m, tr(6481, wall, "sell", T0 + 1500));
    E.applyBookDelta(m, "b", 6481, 0);
    E.applyTrade(m, tr(6481, 1, "buy", T0 + 2500));
    E.applyBookDelta(m, "b", 6481, 0);
    return m.heat.cols.reduce((n, c) => n + c.pulls.length, 0);
  };
  assert.ok(run(false) >= 1);
  assert.equal(run(true), 0);
});

/* ---------- Simulated execution ---------- */
function liveMarket(bid, ask) {
  const m = E.create("ES", OF.config);
  E.applyBook(m, [[bid, 50]], [[ask, 50]]);
  E.applyTrade(m, tr(bid, 1, "sell", T0));
  return m;
}
const quote = (m, bid, ask) => E.applyBook(m, [[bid, 50]], [[ask, 50]]);

test("market orders fill at the touch and P&L uses the tick value", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 2, stopTicks: 0, targetTicks: 0 });
  assert.equal(T.marketOrder(a, m, "buy").fill.price, 6481.25);
  quote(m, 6482.0, 6482.25);
  assert.equal(T.unrealized(a, m), (6482.0 - 6481.25) / 0.25 * 12.5 * 2);
  T.flatten(a, m);
  assert.equal(a.pos, 0);
  assert.equal(a.realized, 3 * 12.5 * 2);
});

test("a long bracket sets stop and target from the average and the stop fires", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 1, stopTicks: 4, targetTicks: 8 });
  T.marketOrder(a, m, "buy");
  assert.equal(a.stop, 6480.25);
  assert.equal(a.target, 6483.25);
  quote(m, 6480.0, 6480.25);
  E.applyTrade(m, tr(6480.25, 1, "sell", T0 + 1));
  const ev = T.mark(a, m);
  assert.equal(a.pos, 0);
  assert.ok(a.realized < 0);
  assert.equal(a.stop, null);
  assert.ok(ev.some((e) => e.type === "stop"));
});

test("a long target fills at the target price", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 1, stopTicks: 4, targetTicks: 8 });
  T.marketOrder(a, m, "buy");
  quote(m, 6483.25, 6483.5);
  E.applyTrade(m, tr(6483.25, 1, "buy", T0 + 1));
  const ev = T.mark(a, m);
  assert.ok(ev.some((e) => e.type === "target"));
  assert.equal(a.realized, 8 * 12.5);
});

test("resting limit orders fill only when the tape trades through them", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 1, stopTicks: 0, targetTicks: 0 });
  assert.equal(T.joinBid(a, m).ok, true);
  assert.equal(a.orders.length, 1);
  T.onTrade(a, m, { price: 6481.25, size: 5, side: "buy" });
  assert.equal(a.pos, 0, "a trade above the bid does not fill it");
  T.onTrade(a, m, { price: 6481.0, size: 5, side: "sell" });
  assert.equal(a.pos, 1);
  assert.equal(a.avg, 6481.0);
  assert.equal(a.orders.length, 0);
});

test("a marketable limit order fills at once instead of resting", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { stopTicks: 0, targetTicks: 0 });
  assert.equal(T.limitOrder(a, m, "buy", 6482, 1).fill.price, 6481.25);
  assert.equal(a.orders.length, 0);
});

test("reverse flips the position at the touch and re-arms the bracket", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 3, stopTicks: 4, targetTicks: 8 });
  T.marketOrder(a, m, "buy");
  assert.equal(T.reverse(a, m).ok, true);
  assert.equal(a.pos, -3);
  assert.equal(a.avg, 6481.0);
  assert.equal(a.stop, 6482.0);
  assert.equal(T.reverse(T.createAccount(m), m).ok, false, "nothing to reverse when flat");
});

test("max daily loss flattens, cancels orders and locks trading until reset", () => {
  const m = liveMarket(6481.0, 6481.25);
  const a = T.createAccount(m, { qty: 1, stopTicks: 0, targetTicks: 0, maxLoss: 100 });
  T.marketOrder(a, m, "buy");
  T.joinBid(a, m);
  quote(m, 6478.0, 6478.25);
  E.applyTrade(m, tr(6478.0, 1, "sell", T0 + 1));
  const ev = T.mark(a, m);
  assert.equal(a.locked, true);
  assert.equal(a.pos, 0);
  assert.equal(a.orders.length, 0);
  assert.ok(ev.some((e) => e.type === "lock"));
  assert.equal(T.marketOrder(a, m, "buy").ok, false);
  assert.equal(T.limitOrder(a, m, "buy", 6470, 1).ok, false);
  T.resetDay(a);
  assert.equal(T.marketOrder(a, m, "buy").ok, true);
});

test("orders are rejected cleanly with no quote or a bad quantity", () => {
  const empty = E.create("ES", OF.config);
  assert.equal(T.marketOrder(T.createAccount(empty), empty, "buy").ok, false);
  const m = liveMarket(6481.0, 6481.25);
  assert.equal(T.marketOrder(T.createAccount(m), m, "buy", -1).ok, false);
  assert.equal(T.flatten(T.createAccount(m), m).ok, false);
});

test("audio cues stay silent until enabled and never throw without a Web Audio API", () => {
  assert.equal(OF.audio.play("block"), false);
  assert.equal(OF.audio.enable(), false);
  assert.equal(OF.audio.isEnabled(), false);
});
