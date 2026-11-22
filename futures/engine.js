/* Futures Desk engine: instrument table, footprint bars, session profile inputs, DOM state and bar-close detectors
 * (stacked imbalances, absorption, delta divergence, large prints). Pure logic with no DOM, so it runs in Node for tests.
 * Depends on OF.analytics (toTick, volumeProfile) from orderflow/analytics.js. */
(function (g) {
  "use strict";
  var FD = (g.FD = g.FD || {});
  var A = g.OF && g.OF.analytics;

  /* tick is the minimum price increment; avgSize drives the simulator; big is the default large-print threshold in contracts;
   * imbMin is the smallest volume that can count as an imbalance; rest is the resting size that counts as large on the DOM. */
  FD.SYMBOLS = {
    MNQ: { name: "Micro E-mini Nasdaq-100", tick: 0.25, tickValue: 0.5, base: 23118.75, avgSize: 3, big: 40, imbMin: 6, rest: 120, depthMult: 0.75 },
    NQ: { name: "E-mini Nasdaq-100", tick: 0.25, tickValue: 5, base: 23118.75, avgSize: 2, big: 20, imbMin: 4, rest: 60, depthMult: 0.9 },
    MES: { name: "Micro E-mini S&P 500", tick: 0.25, tickValue: 1.25, base: 6481.25, avgSize: 4, big: 50, imbMin: 7, rest: 150, depthMult: 0.9 },
    ES: { name: "E-mini S&P 500", tick: 0.25, tickValue: 12.5, base: 6481.25, avgSize: 3, big: 30, imbMin: 5, rest: 100, depthMult: 1.1 }
  };
  FD.INTERVALS = [{ label: "15s", ms: 15000 }, { label: "30s", ms: 30000 }, { label: "1m", ms: 60000 }, { label: "5m", ms: 300000 }];
  FD.IMBALANCE_RATIOS = [2, 2.5, 3, 4, 5];

  var LIMITS = { maxBars: 600, tape: 200, alerts: 100, bookLevels: 60, flashMs: 900 };
  var STACK_MIN = 3, ABSORB_RANGE_TICKS = 2, ABSORB_VOL_MULT = 1.5, ABSORB_MIN_BARS = 3, ABSORB_LOOKBACK = 20, ABSORB_DELTA_FRAC = 0.25, DIVERGENCE_LOOKBACK = 10, DIVERGENCE_MIN_BARS = 5;
  FD.LIMITS = LIMITS;

  function create(symbol, opts) {
    var sym = FD.SYMBOLS[symbol], o = opts || {};
    if (!sym) throw new Error("Unknown symbol " + symbol);
    return {
      symbol: symbol, sym: sym, tickSize: sym.tick,
      cfg: { barMs: o.barMs || 60000, ratio: o.ratio || 3, big: o.big || sym.big },
      bars: [], levels: new Map(), vol: 0, delta: 0, buyVol: 0, bigCount: 0, cvd: 0, open: null, last: null, lastSide: null, lastTs: 0, firstTs: 0,
      pv: 0, bids: [], asks: [], bidMap: new Map(), askMap: new Map(), flashes: new Map(),
      tape: [], tapeSeq: 0, alerts: [], alertSeq: 0, rev: 0, dropped: 0, trades: 0, _prof: null, _profRev: -1
    };
  }

  function toTick(m, price) { return A.toTick(price, m.tickSize); }

  /* Diagonal imbalances: ask volume at p against bid volume one tick below (buy imbalance),
   * and bid volume at p against ask volume one tick above (sell imbalance). Runs of 3+ adjacent ticks are stacks. */
  function imbalances(levels, ratio, minVol) {
    var buy = new Set(), sell = new Set();
    levels.forEach(function (c, p) {
      var below = levels.get(p - 1), above = levels.get(p + 1), bidBelow = below ? below.b : 0, askAbove = above ? above.a : 0;
      if (c.a >= minVol && c.a >= ratio * bidBelow) buy.add(p);
      if (c.b >= minVol && c.b >= ratio * askAbove) sell.add(p);
    });
    return { buy: buy, sell: sell, stacks: stacksOf(buy, "buy").concat(stacksOf(sell, "sell")) };
  }

  /* An imbalance only counts when its volume is meaningful for this bar: above the instrument floor and above the bar's average per price. */
  function imbMinFor(m, bar) { return Math.max(m.sym.imbMin, bar.levels.size ? bar.vol / bar.levels.size : 0); }

  function stacksOf(set, side) {
    var ticks = Array.from(set).sort(function (a, b) { return a - b; }), out = [], start = null, prev = null;
    function close() { if (start != null && prev - start + 1 >= STACK_MIN) out.push({ side: side, lo: start, hi: prev, n: prev - start + 1 }); }
    ticks.forEach(function (t) {
      if (start != null && t === prev + 1) { prev = t; return; }
      close(); start = prev = t;
    });
    close();
    return out;
  }

  function pocOf(levels) {
    var best = null, bv = -1;
    levels.forEach(function (c, p) { var v = c.a + c.b; if (v > bv || (v === bv && best != null && p > best)) { bv = v; best = p; } });
    return best;
  }

  function newBar(t, tick) {
    return { t: t, o: tick, h: tick, l: tick, c: tick, levels: new Map(), vol: 0, delta: 0, buy: 0, sell: 0, big: [], cvdC: 0, closed: false };
  }

  function pushAlert(m, type, ts, text, extra) {
    m.alerts.unshift(Object.assign({ id: ++m.alertSeq, type: type, ts: ts, text: text }, extra || {}));
    if (m.alerts.length > LIMITS.alerts) m.alerts.pop();
  }

  function fmt(m, tick) { return (tick * m.tickSize).toFixed(2); }

  /* Runs the bar-close detectors. closeTs is the bar's end time, used as the alert timestamp. */
  function closeBar(m, bar, idx) {
    if (bar.closed) return;
    bar.closed = true;
    var closeTs = bar.t + m.cfg.barMs, prior = m.bars.slice(Math.max(0, idx - ABSORB_LOOKBACK), idx);

    var imb = imbalances(bar.levels, m.cfg.ratio, imbMinFor(m, bar));
    imb.stacks.forEach(function (s) {
      pushAlert(m, "stacked", closeTs, "Stacked " + s.side + " imbalance x" + s.n + " at " + fmt(m, s.lo) + " to " + fmt(m, s.hi), { side: s.side, price: s.lo });
    });

    var range = bar.h - bar.l;
    if (prior.length >= ABSORB_MIN_BARS && range <= ABSORB_RANGE_TICKS) {
      var avg = prior.reduce(function (s, b) { return s + b.vol; }, 0) / prior.length;
      if (bar.vol >= ABSORB_VOL_MULT * avg && bar.vol >= m.sym.avgSize * 10) {
        var poc = pocOf(bar.levels), frac = bar.vol ? bar.delta / bar.vol : 0, side = frac <= -ABSORB_DELTA_FRAC ? "buy" : frac >= ABSORB_DELTA_FRAC ? "sell" : null;
        pushAlert(m, "absorption", closeTs, "Absorption at " + fmt(m, poc) + ": " + bar.vol + " contracts traded in a " + range + "-tick range" +
          (side === "buy" ? ", selling absorbed by buyers" : side === "sell" ? ", buying absorbed by sellers" : ", heavy two-sided volume"), { side: side, price: poc });
      }
    }

    var back = m.bars.slice(Math.max(0, idx - DIVERGENCE_LOOKBACK), idx);
    if (back.length >= DIVERGENCE_MIN_BARS) {
      var hh = Math.max.apply(null, back.map(function (b) { return b.h; })), ll = Math.min.apply(null, back.map(function (b) { return b.l; }));
      if (bar.h > hh && bar.delta < 0) pushAlert(m, "divergence", closeTs, "Bearish delta divergence: new high " + fmt(m, bar.h) + " with delta " + bar.delta, { side: "sell", price: bar.h });
      else if (bar.l < ll && bar.delta > 0) pushAlert(m, "divergence", closeTs, "Bullish delta divergence: new low " + fmt(m, bar.l) + " with delta +" + bar.delta, { side: "buy", price: bar.l });
    }

    if (bar.big.length) {
      var top = bar.big.reduce(function (a, b) { return b.size > a.size ? b : a; });
      pushAlert(m, "large", closeTs, bar.big.length + " large print" + (bar.big.length === 1 ? "" : "s") + " (" + m.cfg.big + "+): largest " + top.size + " " + top.side + " at " + fmt(m, top.tick), { side: top.side, price: top.tick });
    }
  }

  function inferSide(m, price, hinted) {
    if (hinted === "buy" || hinted === "sell") return hinted;
    if (m.asks.length && price >= m.asks[0].tick * m.tickSize) return "buy";
    if (m.bids.length && price <= m.bids[0].tick * m.tickSize) return "sell";
    return m.last != null && price < m.last ? "sell" : "buy";
  }

  /* Returns true when the trade was applied. Malformed trades and trades older than two bars are counted and dropped. */
  function ingestTrade(m, t) {
    var price = Number(t && t.price), size = Number(t && t.size), ts = Number(t && t.ts);
    if (!(price > 0) || !(size > 0) || !isFinite(ts)) { m.dropped++; return false; }
    var barMs = m.cfg.barMs, barT = Math.floor(ts / barMs) * barMs, bar = m.bars[m.bars.length - 1];
    if (bar && barT < bar.t - barMs) { m.dropped++; return false; }
    var tick = toTick(m, price), side = inferSide(m, price, t.side);
    if (!bar || barT > bar.t) {
      if (bar) closeBar(m, bar, m.bars.length - 1);
      bar = newBar(barT, tick);
      bar.cvdC = m.cvd;
      m.bars.push(bar);
      if (m.bars.length > LIMITS.maxBars) m.bars.shift();
    }
    if (tick > bar.h) bar.h = tick;
    if (tick < bar.l) bar.l = tick;
    bar.c = tick;

    var signed = side === "buy" ? size : -size;
    [bar.levels, m.levels].forEach(function (map) {
      var c = map.get(tick);
      if (!c) { c = { a: 0, b: 0 }; map.set(tick, c); }
      if (side === "buy") c.a += size; else c.b += size;
    });
    bar.vol += size; bar.delta += signed;
    if (side === "buy") bar.buy += size; else bar.sell += size;
    m.vol += size; m.delta += signed; m.cvd += signed; bar.cvdC = m.cvd;
    if (side === "buy") m.buyVol += size;
    m.pv += price * size;
    if (m.open == null) { m.open = price; m.firstTs = ts; }
    m.last = price; m.lastSide = side; m.lastTs = ts; m.trades++;

    var isBig = size >= m.cfg.big;
    if (isBig) { m.bigCount++; bar.big.push({ size: size, side: side, tick: tick }); }
    m.tape.unshift({ seq: ++m.tapeSeq, ts: ts, price: price, size: size, side: side, big: isBig });
    if (m.tape.length > LIMITS.tape) m.tape.pop();
    m.rev++;
    return true;
  }

  /* Closes the open bar once its time has passed even if no trade arrives, so alerts are not delayed in quiet markets. */
  function tick(m, nowTs) {
    var bar = m.bars[m.bars.length - 1];
    if (bar && !bar.closed && nowTs >= bar.t + m.cfg.barMs) { closeBar(m, bar, m.bars.length - 1); m.rev++; }
  }

  function levelsOf(arr) {
    var out = [], map = new Map();
    (arr || []).forEach(function (r) {
      var p = Number(r && r[0]), s = Number(r && r[1]);
      if (p > 0 && s > 0) out.push([p, s]);
    });
    return { rows: out, map: map };
  }

  /* Book snapshot. Flags levels whose size fell sharply (pull) or jumped (stack) so the DOM can flash them. */
  function ingestBook(m, b) {
    if (!b || !Array.isArray(b.bids) || !Array.isArray(b.asks)) { m.dropped++; return false; }
    var bi = levelsOf(b.bids).rows, as = levelsOf(b.asks).rows;
    if (!bi.length && !as.length) { m.dropped++; return false; }
    bi.sort(function (x, y) { return y[0] - x[0]; }); as.sort(function (x, y) { return x[0] - y[0]; });
    var now = Date.now(), bidMap = new Map(), askMap = new Map();
    function convert(rows, map, prev) {
      var out = [];
      rows.slice(0, LIMITS.bookLevels).forEach(function (r) {
        var tk = toTick(m, r[0]); map.set(tk, r[1]); out.push({ tick: tk, size: r[1] });
        var was = prev.get(tk) || 0;
        if (was >= m.sym.rest * 0.5 && r[1] < was * 0.4) m.flashes.set(tk, { t: now, kind: "pull" });
        else if (r[1] >= m.sym.rest && r[1] > was * 2.5) m.flashes.set(tk, { t: now, kind: "stack" });
      });
      return out;
    }
    m.bids = convert(bi, bidMap, m.bidMap); m.asks = convert(as, askMap, m.askMap);
    m.bidMap = bidMap; m.askMap = askMap;
    m.flashes.forEach(function (f, k) { if (now - f.t > LIMITS.flashMs) m.flashes.delete(k); });
    m.rev++;
    return true;
  }

  function profile(m) {
    if (m._profRev === m.rev) return m._prof;
    m._profRev = m.rev;
    m._prof = m.levels.size ? A.volumeProfile(m.levels, 0.7) : null;
    return m._prof;
  }

  /* Headline numbers for the stats strip. Null until the first trade. */
  function stats(m) {
    if (m.last == null) return null;
    var p = profile(m), tk = m.tickSize;
    return {
      last: m.last, change: m.last - m.open, changePct: (m.last - m.open) / m.open * 100, vol: m.vol, delta: m.delta,
      buyPct: m.vol ? m.buyVol / m.vol * 100 : 50, big: m.bigCount, poc: p ? p.poc * tk : null, vah: p ? p.vah * tk : null, val: p ? p.val * tk : null,
      vwap: m.vol ? m.pv / m.vol : null
    };
  }

  FD.engine = { create: create, ingestTrade: ingestTrade, ingestBook: ingestBook, tick: tick, imbalances: imbalances, imbMinFor: imbMinFor, stats: stats, profile: profile, pocOf: pocOf, closeBar: closeBar };
})(globalThis);
