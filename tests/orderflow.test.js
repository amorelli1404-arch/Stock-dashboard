"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

["config", "analytics", "calendar", "engine", "feeds"].forEach((f) => require(`../orderflow/${f}.js`));
const OF = globalThis.OF;
const A = OF.analytics;

const cell = (b, a) => ({ b, a });
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

test("toTick / fromTick round trip without float drift", () => {
  assert.equal(A.toTick(6481.25, 0.25), 25925);
  assert.equal(A.fromTick(25925, 0.25), 6481.25);
  assert.equal(A.fromTick(A.toTick(61.52, 0.01), 0.01), 61.52);
});

test("aggregate clusters ticks and sums both sides", () => {
  const agg = A.aggregate(new Map([[10, cell(1, 2)], [11, cell(3, 4)], [12, cell(5, 6)]]), 2);
  assert.deepEqual(agg.get(5), { b: 4, a: 6 });
  assert.deepEqual(agg.get(6), { b: 5, a: 6 });
});

test("imbalances flag diagonal ask-vs-bid and bid-vs-ask dominance", () => {
  const levels = new Map([[10, cell(2, 1)], [11, cell(1, 9)], [12, cell(12, 1)], [13, cell(1, 1)]]);
  const imb = A.imbalances(levels, 3, 2);
  assert.ok(imb.buy.has(11), "ask 9 vs bid 2 below");
  assert.ok(imb.sell.has(12), "bid 12 vs ask 1 above");
  assert.ok(!imb.buy.has(13) && !imb.sell.has(13));
});

test("volumeProfile finds POC, value area, HVN and LVN on a bimodal profile", () => {
  const vols = [5, 20, 40, 20, 5, 1, 5, 20, 40, 20, 5];
  const levels = new Map(vols.map((v, i) => [100 + i, cell(v / 2, v / 2)]));
  const vp = A.volumeProfile(levels, 0.7);
  assert.equal(vp.total, 181);
  assert.ok([102, 108].includes(vp.poc));
  assert.ok(vp.val <= vp.poc && vp.poc <= vp.vah);
  assert.ok(vp.vaVolume >= 0.7 * vp.total);
  assert.ok(vp.lvn.includes(105), "trough between the two peaks");
  assert.ok(vp.hvn.includes(vp.poc === 102 ? 108 : 102), "the second peak is an HVN");
  assert.equal(A.volumeProfile(new Map(), 0.7), null);
});

test("tpoProfile counts distinct periods per price and finds the POC", () => {
  const bar = (seq, ticks) => ({ seq, levels: new Map(ticks.map((t) => [t, cell(1, 1)])) });
  const tpo = A.tpoProfile([bar(0, [10, 11]), bar(1, [11, 12]), bar(2, [11])], 1, 1);
  assert.equal(tpo.poc, 11);
  assert.deepEqual(tpo.rows.get(11), [0, 1, 2]);
  assert.deepEqual(tpo.rows.get(10), [0]);
});

test("VWAP value and standard deviation", () => {
  const v = new A.VWAP();
  assert.equal(v.value(), null);
  v.add(100, 1);
  v.add(102, 3);
  near(v.value(), 101.5);
  near(v.sd(), Math.sqrt(0.75), 1e-9);
});

test("anchorFromBars accumulates from the anchor bar onward and stamps bar.av", () => {
  const bars = [
    { seq: 0, levels: new Map([[100, cell(5, 5)]]), av: {} },
    { seq: 1, levels: new Map([[110, cell(0, 10)]]), av: {} },
    { seq: 2, levels: new Map([[120, cell(0, 10)]]), av: {} },
  ];
  const acc = A.anchorFromBars(bars, 1, 1, 7);
  near(acc.value(), 115);
  assert.equal(bars[0].av[7], undefined);
  near(bars[1].av[7], 110);
  near(bars[2].av[7], 115);
});

test("cvdDivergences: higher high with lower CVD is bearish; none when confirmed", () => {
  const bars = [
    { h: 8, l: 5, cvdC: 0 }, { h: 10, l: 6, cvdC: 50 }, { h: 9, l: 6, cvdC: 40 }, { h: 12, l: 7, cvdC: 30 }, { h: 11, l: 7, cvdC: 35 },
  ];
  assert.deepEqual(A.cvdDivergences(bars), [{ type: "bearish", from: 1, to: 3 }]);
  bars[3].cvdC = 80;
  assert.deepEqual(A.cvdDivergences(bars), []);
});

test("cvdDivergences: lower low with higher CVD is bullish", () => {
  const bars = [
    { h: 20, l: 10, cvdC: 0 }, { h: 19, l: 8, cvdC: -50 }, { h: 21, l: 9, cvdC: -40 }, { h: 20, l: 6, cvdC: -30 }, { h: 22, l: 8, cvdC: -20 },
  ];
  assert.deepEqual(A.cvdDivergences(bars), [{ type: "bullish", from: 1, to: 3 }]);
});

test("detectWalls needs both relative and absolute size", () => {
  const lv = [20, 22, 19, 300, 21].map((size, i) => ({ tick: i, size }));
  assert.deepEqual([...A.detectWalls(lv, 4, 100)], [3]);
  assert.equal(A.detectWalls(lv, 4, 500).size, 0);
  assert.equal(A.detectWalls(lv.slice(0, 2), 4, 1).size, 0);
});

test("IcebergTracker flags once when executed volume dwarfs displayed size", () => {
  const t = new A.IcebergTracker(3, 30);
  assert.equal(t.onTrade("a", 5, 10), null, "unknown level");
  t.onBookLevel("a", 5, 10);
  assert.equal(t.onTrade("a", 5, 20), null);
  const hit = t.onTrade("a", 5, 15);
  assert.deepEqual(hit, { side: "a", tick: 5, traded: 35, peak: 10 });
  assert.equal(t.onTrade("a", 5, 50), null, "flags only once");
  assert.ok(t.isFlagged("a", 5));
  t.onBookLevel("a", 5, 0);
  assert.ok(!t.isFlagged("a", 5), "level removed");
});

test("etToUtc handles standard time, daylight time and the DST jump", () => {
  assert.equal(new Date(OF.calendar.etToUtc(2026, 11, 18, 14, 0)).toISOString(), "2026-11-18T19:00:00.000Z");
  assert.equal(new Date(OF.calendar.etToUtc(2026, 7, 15, 9, 30)).toISOString(), "2026-07-15T13:30:00.000Z");
  assert.equal(new Date(OF.calendar.etToUtc(2026, 3, 8, 3, 0)).toISOString(), "2026-03-08T07:00:00.000Z");
});

test("calendar events include FOMC, NFP on the first Friday and sort ascending", () => {
  const now = Date.UTC(2026, 10, 18, 12, 0);
  const ev = OF.calendar.buildEvents(now);
  const nfp = ev.find((e) => e.id === "nfp-2026-12");
  assert.equal(new Date(nfp.ts).toISOString(), "2026-12-04T13:30:00.000Z");
  assert.ok(ev.some((e) => e.id === "fomc-2026-12-09"));
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].ts >= ev[i - 1].ts);
});

test("calendar severity buckets and countdown formatting", () => {
  const C = OF.calendar, min = 60000;
  assert.equal(C.severity(2 * 60 * min), "scheduled");
  assert.equal(C.severity(45 * min), "soon");
  assert.equal(C.severity(10 * min), "imminent");
  assert.equal(C.severity(-2 * min), "released");
  assert.equal(C.severity(-10 * min), "past");
  assert.equal(C.formatCountdown(90061000), "1d 01:01:01");
  assert.equal(C.formatCountdown(65000), "00:01:05");
  assert.equal(C.formatCountdown(-65000), "00:01:05 ago");
  const list = [{ ts: 1000 }, { ts: 500000 }, { ts: 9e9 }];
  assert.equal(C.upcoming(list, 400000, 5, 0).length, 2);
});

const T0 = Date.UTC(2026, 10, 18, 15, 0, 0);
const trade = (price, size, side, ts) => ({ price, size, side, ts });

test("engine builds footprint bars, delta, CVD and VWAP; rolls bars by time", () => {
  const m = OF.engine.create("ES");
  OF.engine.applyTrade(m, trade(6481.25, 3, "buy", T0));
  OF.engine.applyTrade(m, trade(6481.0, 5, "sell", T0 + 1000));
  OF.engine.applyTrade(m, trade(6481.25, 2, "buy", T0 + 2000));
  assert.equal(m.bars.length, 1);
  const bar = m.bars[0], hi = A.toTick(6481.25, 0.25), lo = A.toTick(6481.0, 0.25);
  assert.deepEqual([bar.o, bar.h, bar.l, bar.c], [hi, hi, lo, hi]);
  assert.deepEqual(bar.levels.get(hi), { b: 0, a: 5 });
  assert.deepEqual(bar.levels.get(lo), { b: 5, a: 0 });
  assert.equal(bar.delta, 0);
  assert.equal(m.cvd, 0);
  near(m.vwap.value(), (6481.25 * 3 + 6481 * 5 + 6481.25 * 2) / 10);
  OF.engine.applyTrade(m, trade(6481.5, 1, "buy", T0 + 61000));
  assert.equal(m.bars.length, 2);
  assert.equal(m.bars[1].cvdO, 0);
  assert.equal(m.cvd, 1);
  assert.equal(m.l1.volume, 11);
});

test("engine rejects malformed trades and infers side from the quote", () => {
  const m = OF.engine.create("ES");
  assert.equal(OF.engine.applyTrade(m, trade(NaN, 1, "buy", T0)), false);
  assert.equal(OF.engine.applyTrade(m, trade(6481, 0, "buy", T0)), false);
  assert.equal(m.bars.length, 0);
  OF.engine.applyQuote(m, { bid: 6481.0, ask: 6481.25, bidSize: 4, askSize: 4 });
  OF.engine.applyTrade(m, { price: 6481.25, size: 1, ts: T0 });
  OF.engine.applyTrade(m, { price: 6481.0, size: 1, ts: T0 });
  assert.equal(m.bars[0].delta, 0);
  assert.equal(m.lastSide, "sell");
});

test("anchored VWAP back-fills from the clicked bar and keeps updating", () => {
  const m = OF.engine.create("ES");
  OF.engine.applyTrade(m, trade(6480, 10, "buy", T0));
  OF.engine.applyTrade(m, trade(6484, 10, "buy", T0 + 61000));
  const a = OF.engine.addAnchor(m, 1, "H");
  near(a.acc.value(), 6484);
  OF.engine.applyTrade(m, trade(6488, 10, "buy", T0 + 62000));
  near(m.anchors[0].acc.value(), 6486);
  near(m.bars[1].av[a.id], 6486);
  OF.engine.clearAnchors(m);
  assert.equal(m.anchors.length, 0);
});

test("engine raises a wall alert once, and clears the latch when the wall disappears", () => {
  const m = OF.engine.create("ES");
  const bids = [], asks = [];
  for (let i = 0; i < 12; i++) { bids.push([6480 - i * 0.25, 40]); asks.push([6480.25 + i * 0.25, 40]); }
  bids[4][1] = 400;
  OF.engine.applyBook(m, bids, asks);
  assert.ok(m.walls.b.has(A.toTick(6479, 0.25)));
  assert.equal(m.alerts.filter((a) => /wall/i.test(a.text)).length, 1);
  OF.engine.applyBook(m, bids, asks);
  assert.equal(m.alerts.filter((a) => /wall/i.test(a.text)).length, 1, "no duplicate alert");
  bids[4][1] = 40;
  OF.engine.applyBook(m, bids, asks);
  assert.equal(m.walls.b.size, 0);
});

test("engine flags iceberg absorption from book + prints", () => {
  const m = OF.engine.create("ES");
  OF.engine.applyBook(m, [[6480, 30]], [[6480.25, 12]]);
  for (let i = 0; i < 4; i++) OF.engine.applyTrade(m, trade(6480.25, 12, "buy", T0 + i));
  assert.ok(m.tracker.isFlagged("a", A.toTick(6480.25, 0.25)));
  assert.equal(m.alerts.filter((a) => /iceberg/i.test(a.text)).length, 1);
});

test("engine records a CVD divergence alert when a bar closes", () => {
  const m = OF.engine.create("ES");
  const seq = [[6481, "buy", 20], [6483, "buy", 1], [6482, "sell", 10], [6486, "buy", 1], [6484, "sell", 30], [6485, "buy", 1]];
  seq.forEach(([p, side, size], i) => OF.engine.applyTrade(m, trade(p, size, side, T0 + i * 61000)));
  OF.engine.applyTrade(m, trade(6485, 1, "buy", T0 + seq.length * 61000));
  assert.ok(m.divs.some((d) => d.type === "bearish"));
  assert.ok(m.alerts.some((a) => /divergence/i.test(a.text)));
});

test("simulated feed is deterministic for a seed and produces a sane book", () => {
  const run = () => {
    const f = new OF.feeds.SimulatedFeed({ seed: 7 }), out = [];
    let book = null;
    f.on("trade", (t) => out.push([t.price, t.size, t.side]));
    f.on("book", (b) => { book = b; });
    f.start("ES");
    f.stop();
    return { out, book };
  };
  const a = run(), b = run();
  assert.ok(a.out.length > 2000);
  assert.deepEqual(a.out.slice(0, 500), b.out.slice(0, 500));
  assert.ok(a.book.bids[0][0] < a.book.asks[0][0]);
  assert.equal(Math.round((a.book.asks[0][0] - a.book.bids[0][0]) / 0.25), 1);
  const differentSeed = (() => { const f = new OF.feeds.SimulatedFeed({ seed: 8 }), o = []; f.on("trade", (t) => o.push([t.price, t.size, t.side])); f.start("ES"); f.stop(); return o; })();
  assert.notDeepEqual(differentSeed.slice(0, 200), a.out.slice(0, 200));
});

test("replay builds bars whose ranges stay realistic for ES", () => {
  const m = OF.engine.create("ES"), f = new OF.feeds.SimulatedFeed({ seed: 42 });
  f.on("trade", (t) => OF.engine.applyTrade(m, t));
  f.on("book", (b) => OF.engine.applyBook(m, b.bids, b.asks));
  f.on("levels", (l) => OF.engine.setLevels(m, l));
  f.start("ES");
  f.stop();
  assert.ok(m.bars.length >= 17);
  const ranges = m.bars.map((b) => b.h - b.l);
  assert.ok(Math.max(...ranges) < 120, `largest bar range ${Math.max(...ranges)} ticks`);
  assert.ok(Math.min(...ranges) >= 0);
  assert.ok(m.htf.pdh > m.htf.pdl);
  assert.ok(m.l1.bid < m.l1.ask);
});

test("simulated book sizes stay bounded over a long run (no compounding growth)", () => {
  for (const key of ["ES", "BTCUSDT"]) {
    const f = new OF.feeds.SimulatedFeed({ seed: 3 }), sym = OF.config.symbols[key];
    let book = null, maxDelta = 0;
    f.on("book", (b) => { book = b; });
    f.on("delta", (d) => { maxDelta = Math.max(maxDelta, d.size); });
    f.start(key);
    for (let i = 0; i < 20000; i++) f.step();
    f.emitSnapshot();
    f.stop();
    const sizes = book.bids.concat(book.asks).map((r) => r[1]);
    assert.ok(Math.max(...sizes) < sym.depth * 25, `${key} largest level ${Math.max(...sizes)}`);
    assert.ok(maxDelta < sym.depth * 25, `${key} largest delta ${maxDelta}`);
    assert.ok(Math.min(...sizes) >= sym.sizeStep);
  }
});

test("Binance adapter normalizes trades, depth and book ticker", () => {
  const p = OF.feeds.providers.binance;
  assert.deepEqual(p.normalize({ stream: "x", data: { e: "aggTrade", p: "98000.1", q: "0.5", m: true, T: 5 } }), [{ type: "trade", price: 98000.1, size: 0.5, side: "sell", ts: 5 }]);
  assert.equal(p.normalize({ data: { e: "aggTrade", p: "1", q: "1", m: false, T: 1 } })[0].side, "buy");
  assert.deepEqual(p.normalize({ data: { e: "depthUpdate", b: [["1", "2"]], a: [["3", "4"]] } }), [{ type: "book", bids: [[1, 2]], asks: [[3, 4]] }]);
  assert.deepEqual(p.normalize({ data: { e: "bookTicker", b: "1", B: "2", a: "3", A: "4" } }), [{ type: "quote", bid: 1, bidSize: 2, ask: 3, askSize: 4 }]);
  assert.deepEqual(p.normalize({ data: { e: "other" } }), []);
  const urls = p.url("BTCUSDT");
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith("wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade"));
  assert.ok(urls[1].startsWith("wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms/btcusdt@bookTicker"));
  assert.ok(p.supports("BTCUSDT") && !p.supports("ES"));
});

test("WebSocketFeed routes messages, reports latency and reconnects after close", () => {
  const sockets = [];
  globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(m) { this.sent.push(m); } close() {} };
  const events = [], statuses = [];
  const provider = {
    label: "mock", url: (s) => `wss://mock/${s}`, subscribe: (s) => [{ sub: s }], normalize: (m) => (Array.isArray(m) ? m : [m]),
  };
  const f = new OF.feeds.WebSocketFeed({ provider });
  f.on("trade", (e) => events.push(e)).on("status", (s) => statuses.push(s.state)).on("latency", (ms) => events.push({ latency: ms }));
  f.start("ES");
  const ws = sockets[0];
  ws.onopen();
  assert.deepEqual(ws.sent, ['{"sub":"ES"}']);
  ws.onmessage({ data: JSON.stringify([{ type: "trade", price: 1, size: 2, side: "buy", ts: Date.now() - 40 }, { type: "bogus" }]) });
  assert.equal(events.filter((e) => e.price === 1).length, 1);
  assert.ok(events.some((e) => e.latency >= 40 && e.latency < 1000));
  ws.onmessage({ data: "not json" });
  ws.onclose();
  assert.deepEqual(statuses.slice(0, 3), ["connecting", "open", "closed"]);
  assert.equal(statuses[3], "connecting");
  f.stop();
  delete globalThis.WebSocket;
});

test("WebSocketFeed with several URLs opens only when all are open and recycles together", () => {
  const sockets = [];
  globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 1; this.closed = false; sockets.push(this); } send() {} close() { this.closed = true; } };
  const statuses = [], trades = [], provider = { label: "dual", url: (s) => [`wss://a/${s}`, `wss://b/${s}`], normalize: (m) => [m] };
  const f = new OF.feeds.WebSocketFeed({ provider });
  f.on("status", (s) => statuses.push(s.state)).on("trade", (t) => trades.push(t));
  f.start("ES");
  assert.equal(sockets.length, 2);
  sockets[0].onopen();
  assert.deepEqual(statuses, ["connecting"], "not open until both sockets open");
  sockets[1].onopen();
  assert.deepEqual(statuses, ["connecting", "open"]);
  sockets[1].onmessage({ data: JSON.stringify({ type: "trade", price: 5, size: 1, side: "buy", ts: 1 }) });
  assert.equal(trades.length, 1);
  sockets[0].onclose();
  sockets[1].onclose && sockets[1].onclose();
  assert.ok(sockets[1].closed, "the surviving socket is recycled");
  assert.deepEqual(statuses.slice(2), ["closed", "connecting"], "one reconnect, not two");
  f.stop();
  delete globalThis.WebSocket;
});

test("backfill is applied before held-back live trades and duplicate ids are dropped", async () => {
  const sockets = [];
  globalThis.WebSocket = class { constructor() { this.readyState = 1; sockets.push(this); } send() {} close() {} };
  let release;
  const provider = {
    label: "hist", url: () => "wss://x", normalize: (m) => [m],
    backfill: () => new Promise((resolve) => { release = () => resolve([1, 2].map((id) => ({ type: "trade", price: 10, size: 1, side: "buy", ts: id, id }))); }),
  };
  const f = new OF.feeds.WebSocketFeed({ provider }), ids = [], notes = [];
  f.on("trade", (t) => ids.push(t.id)).on("notice", (n) => notes.push(n));
  f.start("ES");
  sockets[0].onopen();
  await new Promise((r) => setTimeout(r, 1));
  [2, 3].forEach((id) => sockets[0].onmessage({ data: JSON.stringify({ type: "trade", price: 10, size: 1, side: "buy", ts: 9, id }) }));
  assert.deepEqual(ids, [], "live trades are held while history loads");
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ids, [1, 2, 3]);
  sockets[0].onmessage({ data: JSON.stringify({ type: "trade", price: 10, size: 1, side: "buy", ts: 9, id: 3 }) });
  assert.deepEqual(ids, [1, 2, 3], "replayed id ignored");
  assert.ok(notes.some((n) => /Loaded 2 historical/.test(n)));
  f.stop();
  delete globalThis.WebSocket;
});

test("live trades arriving before every socket is open do not turn the initial backfill into a gap-fill", async () => {
  const sockets = [], calls = [];
  globalThis.WebSocket = class { constructor() { this.readyState = 1; sockets.push(this); } send() {} close() {} };
  const provider = {
    label: "dual", url: () => ["wss://a", "wss://b"], normalize: (m) => [m],
    backfill: (sym, opts) => { calls.push(opts.afterId); return Promise.resolve([{ type: "trade", price: 1, size: 1, side: "buy", ts: 1000, id: 5 }]); },
  };
  const f = new OF.feeds.WebSocketFeed({ provider }), ids = [];
  f.on("trade", (t) => ids.push(t.id));
  f.start("ES");
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ type: "trade", price: 1, size: 1, side: "buy", ts: 2000, id: 9 }) });
  sockets[1].onopen();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [null], "first backfill is a full history load, not a gap-fill");
  assert.deepEqual(ids, [5, 9], "history first, then the live trade that arrived early");
  f.stop();
  delete globalThis.WebSocket;
});

test("backfill failure releases held trades and tells the user", async () => {
  const sockets = [];
  globalThis.WebSocket = class { constructor() { this.readyState = 1; sockets.push(this); } send() {} close() {} };
  const provider = { label: "bad", url: () => "wss://x", normalize: (m) => [m], backfill: () => Promise.reject(new Error("HTTP 429")) };
  const f = new OF.feeds.WebSocketFeed({ provider }), ids = [], notes = [];
  f.on("trade", (t) => ids.push(t.id)).on("notice", (n) => notes.push(n));
  f.start("ES");
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ type: "trade", price: 1, size: 1, side: "buy", ts: 1, id: 7 }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ids, [7]);
  assert.ok(notes.some((n) => /unavailable.*HTTP 429/.test(n)));
  f.stop();
  delete globalThis.WebSocket;
});

test("Binance backfill pages back by id with no gaps or duplicates, and gap-fills after a reconnect", async () => {
  const rows = (from, to) => { const r = []; for (let a = Math.max(0, from); a <= Math.min(to, 2499); a++) r.push({ a, p: "100", q: "1", T: 1000000 + a * 10, m: a % 2 === 0 }); return r; };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const fromId = /fromId=(\d+)/.exec(url);
    const data = fromId ? rows(Number(fromId[1]), Number(fromId[1]) + 999) : rows(1500, 2499);
    return { ok: true, json: async () => data };
  };
  const bf = OF.feeds.providers.binance.backfill;
  const hist = await bf("BTCUSDT", { afterId: null, spanMs: 1e9, maxPages: 3 });
  const ids = hist.map((t) => t.id);
  assert.equal(calls.length, 3);
  assert.equal(ids.length, 2500, "all 2500 fake trades, none repeated where pages overlap");
  assert.deepEqual(ids, ids.slice().sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(hist[0].side, "sell", "even id has buyer-as-maker, so the aggressor sold");
  const short = await bf("BTCUSDT", { afterId: null, spanMs: 5000, maxPages: 9 });
  assert.equal(short.length, 1000, "stops once the requested span is covered");
  calls.length = 0;
  const gap = await bf("BTCUSDT", { afterId: 2100, spanMs: 0, maxPages: 5 });
  assert.ok(/fromId=2101/.test(calls[0]));
  assert.equal(gap[0].id, 2101);
  delete globalThis.fetch;
});

test("databento provider supports only CME symbols and points at the local relay", () => {
  const p = OF.feeds.providers.databento;
  assert.ok(p.supports("ES") && p.supports("GC") && !p.supports("BTCUSDT"));
  assert.equal(p.url("NQ", OF.config.live), "ws://127.0.0.1:8765/stream?symbol=NQ");
  assert.deepEqual(p.normalize([{ type: "trade" }, { type: "book" }]), [{ type: "trade" }, { type: "book" }]);
});

test("WebSocketFeed forwards relay notices", () => {
  const sockets = [];
  globalThis.WebSocket = class { constructor() { this.readyState = 1; sockets.push(this); } send() {} close() {} };
  const f = new OF.feeds.WebSocketFeed({ provider: { label: "n", url: () => "wss://x", normalize: OF.feeds.providers.relay.normalize } }), notes = [];
  f.on("notice", (n) => notes.push(n));
  f.start("ES");
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify([{ type: "notice", text: "MOCK relay" }]) });
  assert.deepEqual(notes, ["MOCK relay"]);
  f.stop();
  delete globalThis.WebSocket;
});

test("engine buckets the same trades into different timeframes", () => {
  const trades = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ price: 6480 + i * 0.25, size: 1, side: "buy", ts: T0 + i * 60000 }));
  const count = (ms) => { const m = OF.engine.create("ES", Object.assign({}, OF.config, { barMs: ms })); trades.forEach((t) => OF.engine.applyTrade(m, t)); return m; };
  assert.equal(count(60000).bars.length, 7);
  const five = count(300000);
  assert.ok(five.bars.length <= 3);
  assert.equal(five.bars.reduce((s, b) => s + b.vol, 0), 7, "no volume lost when re-bucketing");
  assert.equal(count(3600000).bars.length <= 2, true);
});

test("WebSocketFeed reports an error for providers without a usable URL", () => {
  const f = new OF.feeds.WebSocketFeed({ provider: OF.feeds.providers.rithmic }), seen = [];
  f.on("status", (s) => seen.push(s));
  f.start("ES");
  f.stop();
  assert.equal(seen[0].state, "error");
  assert.match(seen[0].text, /relay/);
});
