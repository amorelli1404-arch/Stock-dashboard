"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

["config", "analytics", "calendar"].forEach((f) => require(`../orderflow/${f}.js`));
require("../ix/core.js");
require("../ix/data.js");
const OF = globalThis.OF, IX = globalThis.IX;

const et = (y, mo, d, h, mi) => OF.calendar.etToUtc(y, mo, d, h, mi);
const bar = (t, o, h, l, c, v = 100, buy = 50) => ({ t, o, h, l, c, v, buy });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("contract specs match CME point and tick values", () => {
  const spec = (k) => [IX.CONTRACTS[k].pointValue, IX.CONTRACTS[k].tickValue];
  assert.deepEqual(spec("ES"), [50, 12.5]);
  assert.deepEqual(spec("MES"), [5, 1.25]);
  assert.deepEqual(spec("NQ"), [20, 5]);
  assert.deepEqual(spec("MNQ"), [2, 0.5]);
  Object.values(IX.CONTRACTS).forEach((c) => assert.equal(c.pointValue * IX.TICK, c.tickValue));
});

test("CME hours, session naming across the 18:00 open, and RTH", () => {
  assert.equal(IX.marketOpen(et(2026, 11, 20, 10, 0)), true);
  assert.equal(IX.marketOpen(et(2026, 11, 20, 17, 30)), false, "Friday after 17:00");
  assert.equal(IX.marketOpen(et(2026, 11, 21, 12, 0)), false, "Saturday");
  assert.equal(IX.marketOpen(et(2026, 11, 22, 17, 59)), false);
  assert.equal(IX.marketOpen(et(2026, 11, 22, 18, 0)), true, "Sunday open");
  assert.equal(IX.marketOpen(et(2026, 11, 18, 17, 30)), false, "daily break");
  assert.equal(IX.sessionKey(et(2026, 11, 17, 18, 0)), "2026-11-18");
  assert.equal(IX.sessionKey(et(2026, 11, 18, 9, 30)), "2026-11-18");
  assert.equal(IX.isRth(et(2026, 11, 18, 9, 30)), true);
  assert.equal(IX.isRth(et(2026, 11, 18, 16, 0)), false);
  assert.equal(IX.isRth(et(2026, 7, 15, 9, 30)), true, "daylight time too");
});

function twoSessions() {
  return [
    bar(et(2026, 11, 17, 9, 30), 100, 104, 99, 103), bar(et(2026, 11, 17, 15, 59), 103, 110, 98, 105),
    bar(et(2026, 11, 17, 18, 0), 105, 108, 104, 107), bar(et(2026, 11, 18, 4, 0), 107, 109, 101, 102),
    bar(et(2026, 11, 18, 9, 30), 103, 106, 102, 105), bar(et(2026, 11, 18, 9, 36), 105, 107, 104, 106),
    bar(et(2026, 11, 18, 9, 50), 106, 108, 105, 107), bar(et(2026, 11, 18, 10, 29), 107, 109, 103, 104),
    bar(et(2026, 11, 18, 10, 31), 104, 120, 104, 118)
  ];
}

test("previous-day, overnight and RTH-open levels come from the right windows", () => {
  const s = IX.buildSessions(twoSessions());
  assert.equal(s.length, 2);
  assert.deepEqual(IX.levels(s), { pdh: 110, pdl: 98, pdc: 105, onh: 109, onl: 101, open: 103 });
});

test("initial balance uses the first hour only and projects 1.5x and 2x targets", () => {
  const s = IX.buildSessions(twoSessions()), ib = IX.initialBalance(s[1].rth);
  assert.deepEqual([ib.h, ib.l, ib.range, ib.complete], [109, 102, 7, true]);
  assert.deepEqual([ib.up15, ib.up20, ib.dn15, ib.dn20], [112.5, 116, 98.5, 95]);
});

test("opening range respects the 5, 15 and 30 minute windows and reports breakout status", () => {
  const rth = IX.buildSessions(twoSessions())[1].rth;
  const or5 = IX.openingRange(rth, 5), or15 = IX.openingRange(rth, 15), or30 = IX.openingRange(rth, 30);
  assert.deepEqual([or5.h, or5.l], [106, 102]);
  assert.deepEqual([or15.h, or15.l], [107, 102]);
  assert.deepEqual([or30.h, or30.l], [108, 102]);
  assert.equal(IX.rangeStatus(or5, 110), "above");
  assert.equal(IX.rangeStatus(or5, 101), "below");
  assert.equal(IX.rangeStatus(or5, 104), "inside");
  assert.equal(IX.rangeStatus(IX.openingRange(rth.slice(0, 1), 30), 200), "forming");
  assert.equal(IX.openingRange([], 5), null);
});

test("volume profile finds the point of control and keeps total volume", () => {
  const bars = [bar(1, 100, 100, 100, 100, 500, 300), bar(2, 101, 101, 101, 101, 100, 40), bar(3, 99, 101, 99, 100, 90, 45)];
  const vp = IX.profile(bars, 1);
  near(vp.total, 690, 1e-6);
  near(vp.poc, 100.5);
  assert.ok(vp.vah >= vp.poc && vp.val <= vp.poc);
  assert.equal(IX.profile([], 1), null);
});

test("aggregation builds delta and CVD and resets CVD at a new session", () => {
  const bars = [bar(et(2026, 11, 17, 15, 58), 1, 2, 1, 2, 100, 80), bar(et(2026, 11, 17, 15, 59), 2, 3, 2, 3, 100, 70), bar(et(2026, 11, 17, 18, 0), 3, 3, 2, 2, 100, 10)];
  const a = IX.aggregate(bars, 5);
  assert.equal(a.length, 2);
  assert.deepEqual([a[0].delta, a[0].cvdC, a[0].v], [100, 100, 200]);
  assert.deepEqual([a[1].delta, a[1].cvdC], [-80, -80]);
});

test("NQ/ES ratio aligns on timestamps and reports relative performance", () => {
  const es = [bar(1, 100, 100, 100, 100), bar(2, 101, 101, 101, 101)];
  const nq = [bar(1, 400, 400, 400, 400), bar(2, 408, 408, 408, 408), bar(3, 1, 1, 1, 1)];
  const r = IX.ratio(es, nq);
  assert.equal(r.length, 2);
  near(r[1].nqPct, 2); near(r[1].esPct, 1); near(r[0].v, 4);
});

test("performance horizons use the prior period's last close and are null without history", () => {
  const day = (iso, c) => ({ t: Date.parse(iso + "T00:00:00Z"), c });
  const daily = [day("2026-09-30", 100), day("2026-10-30", 110), day("2026-11-27", 120)];
  const p = IX.performance(daily, 121, 120, Date.parse("2026-11-28T12:00:00Z"));
  near(p.month, 10); near(p.quarter, 21); assert.equal(p.year, null);
  near(p.day, (121 / 120 - 1) * 100);
  assert.deepEqual([1, -1, 0, null].map(IX.arrow), ["↑", "↓", "→", ""]);
});

test("seasonality from CSV uses month-end closes, skips the current month and needs two years", () => {
  let csv = "Date,Open,High,Low,Close,Volume\n", price = 100;
  for (let y = 2020; y <= 2023; y++) for (let m = 1; m <= 12; m++) {
    price *= m === 1 ? 1.05 : m === 9 ? 0.97 : 1.001;
    csv += `${y}-${String(m).padStart(2, "0")}-15,1,1,1,${(price * 0.9).toFixed(4)},1\n${y}-${String(m).padStart(2, "0")}-28,1,1,1,${price.toFixed(4)},1\n`;
  }
  const s = IX.seasonality(IX.parseCsv(csv), Date.parse("2026-11-28T00:00:00Z"));
  near(s.months[0].avg, 5, 0.01); near(s.months[8].avg, -3, 0.01);
  assert.equal(s.months[0].winPct, 100); assert.equal(s.months[8].winPct, 0);
  assert.deepEqual([s.from, s.to], [2020, 2023]);
  assert.equal(IX.seasonality(IX.parseCsv("Date,Close\n2026-01-01,1\n2026-02-01,2"), Date.now()), null);
  assert.deepEqual(IX.parseCsv("a,b\n1,2"), []);
});

const base = { contract: "ES", stopTicks: 8, slippageTicks: 0, commission: 0, account: 50000, dailyLimit: 1000, trailing: 2000, dayPnl: 0, balance: 50000, peak: 50000, riskPct: 0 };

test("risk engine never lets one stop-out reach a limit", () => {
  const r = IX.risk(base);
  assert.equal(r.perContract, 100);
  assert.equal(r.maxContracts, 9, "10 contracts would hit the $1000 limit exactly");
  assert.ok(r.lossAtMax < r.remainingDaily);
  assert.equal(r.limiter, "daily loss limit");
  ["ES", "MES", "NQ", "MNQ"].forEach((c) => [1, 4, 13, 40].forEach((s) => {
    const x = IX.risk(Object.assign({}, base, { contract: c, stopTicks: s, slippageTicks: 1, commission: 4.5 }));
    assert.ok(x.lossAtMax < Math.min(x.remainingDaily, x.remainingTrailing));
  }));
});

test("trailing drawdown, prior losses and a risk cap each reduce size", () => {
  const trail = IX.risk(Object.assign({}, base, { peak: 51800, balance: 50200 }));
  assert.equal(trail.floor, 49800);
  assert.equal(trail.remainingTrailing, 400);
  assert.equal(trail.maxContracts, 3);
  assert.equal(trail.limiter, "trailing drawdown");
  assert.equal(IX.risk(Object.assign({}, base, { dayPnl: -700 })).maxContracts, 2);
  assert.equal(IX.risk(Object.assign({}, base, { dayPnl: 900 })).remainingDaily, 1000, "profits do not widen the daily limit");
  assert.equal(IX.risk(Object.assign({}, base, { riskPct: 0.5 })).maxContracts, 2);
  const done = IX.risk(Object.assign({}, base, { dayPnl: -1000 }));
  assert.equal(done.maxContracts, 0);
  assert.equal(done.breached, true);
});

test("risk engine rejects blank or non-positive inputs instead of treating them as zero", () => {
  for (const k of ["stopTicks", "account", "dailyLimit", "trailing"]) {
    assert.equal(IX.risk(Object.assign({}, base, { [k]: "" })).valid, false, k);
    assert.equal(IX.risk(Object.assign({}, base, { [k]: 0 })).valid, false, k);
  }
});

test("headline filter keeps index news and drops excluded markets", () => {
  assert.equal(IX.isIndexHeadline("Nasdaq rallies as Nvidia guides higher"), true);
  assert.equal(IX.isIndexHeadline("US CPI due at 8:30"), true);
  assert.equal(IX.isIndexHeadline("Gold surges as stocks slip"), false);
  assert.equal(IX.isIndexHeadline("Treasury yields jump after CPI"), false);
  assert.equal(IX.isIndexHeadline("Oil falls, S&P steady"), false);
  assert.equal(IX.isIndexHeadline("Morning coffee notes"), false);
  assert.deepEqual(IX.headlineTags("Chip stocks lead"), ["NQ"]);
  assert.deepEqual(IX.headlineTags("S&P closes higher"), ["ES"]);
  assert.deepEqual(IX.headlineTags("FOMC holds"), ["ES", "NQ"]);
});

test("reaction measures from the last close before the headline", () => {
  const t0 = et(2026, 11, 18, 10, 0), bars = [];
  for (let i = -15; i <= 40; i++) bars.push(bar(t0 + i * 60000, 100, 100, 100, i < 0 ? 100 : 100 + Math.min(i + 1, 5) * 2));
  const r = IX.reaction(bars, t0 + 20000, 5);
  assert.equal(r.base, 100);
  assert.equal(r.pts, 10);
  assert.equal(r.final, true);
  assert.equal(r.series[0].m, -10);
  assert.equal(IX.reaction(bars.slice(0, 18), t0 + 20000, 5).final, false, "window still open");
  assert.equal(IX.reaction(bars, t0 - 86400000, 5), null, "no data around the headline");
});

test("scenarios give three outcomes with ES and NQ notes for every release type", () => {
  for (const name of ["CPI", "Nonfarm Payrolls", "FOMC rate decision", "ISM Manufacturing"]) {
    const s = IX.scenarios(name);
    assert.deepEqual(s.map((x) => x.outcome), ["Above Forecast", "In Line", "Below Forecast"]);
    s.forEach((x) => assert.ok(x.es.length > 10 && x.nq.length > 10));
    s.forEach((x) => assert.ok(!/yield|treasur|dollar|gold|oil/i.test(x.es + x.nq), "no excluded markets in the notes"));
  }
});

test("simulator builds correlated, tick-aligned sessions that stop inside market hours", () => {
  const sim = new IX.Sim({ seed: 3, now: et(2026, 11, 28, 12, 0) });
  assert.equal(IX.sessionKey(sim.now), "2026-11-25", "skips the weekend, the early close and Thanksgiving");
  assert.ok(IX.isRth(sim.now));
  for (const root of ["ES", "NQ"]) {
    const bars = sim.bars[root];
    assert.ok(bars.length > 4000);
    bars.forEach((b) => { assert.ok(IX.marketOpen(b.t)); assert.ok(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.buy >= 0 && b.buy <= b.v); assert.ok(Math.abs(b.c * 4 - Math.round(b.c * 4)) < 1e-9); });
    const L = IX.levels(IX.buildSessions(bars));
    Object.values(L).forEach((v) => assert.ok(v != null));
  }
  const again = new IX.Sim({ seed: 3, now: et(2026, 11, 28, 12, 0) });
  assert.deepEqual(again.bars.ES.slice(-5), sim.bars.ES.slice(-5));
  const n = sim.bars.ES.length;
  sim.advance(10 * 60000);
  assert.equal(sim.bars.ES.length, n + 10);
  sim.advance(20000);
  assert.equal(sim.bars.ES.length, n + 11, "a forming bar appears");
  assert.ok(sim.headlines.length >= 3 && sim.headlines.every((h) => /^Sample/.test(h.title)));
});

test("simulator memory stays bounded over a long run", () => {
  const sim = new IX.Sim({ seed: 4, now: et(2026, 11, 18, 12, 0) });
  for (let i = 0; i < 4000; i++) sim.advance(60000);
  assert.ok(sim.bars.ES.length <= IX.MAX_BARS && sim.bars.NQ.length <= IX.MAX_BARS);
});

test("Binance kline rows become bars with taker-buy volume, excluding closed hours", () => {
  const row = (t, vol, buy) => [t, "10", "11", "9", "10.5", String(vol), t + 59999, "0", 1, String(buy), "0", "0"];
  const out = IX.parseBars([row(et(2026, 11, 20, 10, 0), 5, 3), row(et(2026, 11, 21, 10, 0), 5, 3), ["bad"], null]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].v, out[0].buy], [5, 3]);
});

test("holidays have no regular session and early closes end at 1:00 PM, so prior-day levels skip them", () => {
  assert.equal(IX.isRth(et(2026, 11, 26, 11, 0)), false, "Thanksgiving");
  assert.equal(IX.isRth(et(2026, 11, 27, 12, 59)), true);
  assert.equal(IX.isRth(et(2026, 11, 27, 13, 0)), false, "early close");
  const bars = [bar(et(2026, 11, 25, 10, 0), 100, 110, 90, 105), bar(et(2026, 11, 26, 10, 0), 105, 200, 50, 120), bar(et(2026, 11, 27, 10, 0), 120, 121, 119, 120)];
  const L = IX.levels(IX.buildSessions(bars));
  assert.deepEqual([L.pdh, L.pdl, L.pdc], [110, 90, 105]);
});
