/* Order-flow analytics: pure functions, no DOM, no feed knowledge.
 * Price levels are integer "ticks" (price / tickSize) so Map keys are exact. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  function toTick(price, tickSize) { return Math.round(price / tickSize); }
  function fromTick(tick, tickSize) { return Math.round(tick * tickSize * 1e8) / 1e8; }

  /* Groups tick levels into clusters of `aggr` ticks; keys become floor(tick / aggr). */
  function aggregate(levels, aggr) {
    if (aggr <= 1) return levels;
    var out = new Map();
    levels.forEach(function (v, t) {
      var k = Math.floor(t / aggr), cell = out.get(k);
      if (!cell) { cell = { b: 0, a: 0 }; out.set(k, cell); }
      cell.b += v.b;
      cell.a += v.a;
    });
    return out;
  }

  /* Diagonal imbalance: ask volume at k vs bid volume one level below (buy),
   * bid volume at k vs ask volume one level above (sell). */
  function imbalances(levels, ratio, minVol) {
    var buy = new Set(), sell = new Set(), floorVol = Math.max(minVol * 0.25, 1e-9);
    levels.forEach(function (v, k) {
      var below = levels.get(k - 1), above = levels.get(k + 1);
      if (v.a >= minVol && v.a >= ratio * Math.max(below ? below.b : 0, floorVol)) buy.add(k);
      if (v.b >= minVol && v.b >= ratio * Math.max(above ? above.a : 0, floorVol)) sell.add(k);
    });
    return { buy: buy, sell: sell };
  }

  function barStats(levels) {
    var vol = 0, delta = 0, poc = null, pocVol = -1;
    levels.forEach(function (v, k) {
      var t = v.a + v.b;
      vol += t;
      delta += v.a - v.b;
      if (t > pocVol) { pocVol = t; poc = k; }
    });
    return { vol: vol, delta: delta, poc: poc, pocVol: pocVol };
  }

  /* 70% value area grown from the POC by comparing the next two levels each side. */
  function valueArea(vol, pocIdx, pct) {
    var n = vol.length, total = 0, i;
    for (i = 0; i < n; i++) total += vol[i];
    var acc = vol[pocIdx], up = pocIdx, dn = pocIdx;
    while (acc < pct * total && (up < n - 1 || dn > 0)) {
      var canUp = up < n - 1, canDn = dn > 0;
      var upSum = (canUp ? vol[up + 1] : 0) + (up + 2 < n ? vol[up + 2] : 0);
      var dnSum = (canDn ? vol[dn - 1] : 0) + (dn - 2 >= 0 ? vol[dn - 2] : 0);
      if (canUp && (!canDn || upSum >= dnSum)) { acc += upSum; up = Math.min(n - 1, up + 2); }
      else { acc += dnSum; dn = Math.max(0, dn - 2); }
    }
    return { lowIdx: dn, highIdx: up, volume: acc };
  }

  /* Volume profile with POC, VAH/VAL and high/low volume nodes. */
  function volumeProfile(levels, pct) {
    if (!levels || !levels.size) return null;
    var lo = Infinity, hi = -Infinity;
    levels.forEach(function (v, t) { if (t < lo) lo = t; if (t > hi) hi = t; });
    var n = hi - lo + 1, vol = new Array(n).fill(0), total = 0, maxVol = 0, pocIdx = 0, i;
    levels.forEach(function (v, t) { vol[t - lo] = v.a + v.b; });
    var mid = (n - 1) / 2;
    for (i = 0; i < n; i++) {
      total += vol[i];
      if (vol[i] > maxVol || (vol[i] === maxVol && Math.abs(i - mid) < Math.abs(pocIdx - mid))) { maxVol = vol[i]; pocIdx = i; }
    }
    var va = valueArea(vol, pocIdx, pct);

    var sm = vol.map(function (v, j) {
      var a = vol[j - 1] != null ? vol[j - 1] : v, b = vol[j + 1] != null ? vol[j + 1] : v;
      return (a + v + b) / 3;
    });
    var nonZero = sm.filter(function (v) { return v > 0; }), mean = nonZero.length ? nonZero.reduce(function (s, v) { return s + v; }, 0) / nonZero.length : 0;
    var hvn = [], lvn = [];
    for (i = 1; i < n - 1; i++) {
      if (i !== pocIdx && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] >= 1.3 * mean) hvn.push(lo + i);
      if (sm[i] <= sm[i - 1] && sm[i] < sm[i + 1] && sm[i] <= 0.5 * mean) {
        var left = Math.max.apply(null, sm.slice(0, i)), right = Math.max.apply(null, sm.slice(i + 1));
        if (left > 1.5 * sm[i] && right > 1.5 * sm[i]) lvn.push(lo + i);
      }
    }
    return { lo: lo, hi: hi, vol: vol, total: total, maxVol: maxVol, poc: lo + pocIdx, val: lo + va.lowIdx, vah: lo + va.highIdx, vaVolume: va.volume, hvn: hvn, lvn: lvn };
  }

  /* Market Profile: which TPO periods traded at each price. Period = floor(bar.seq / periodBars). */
  function tpoProfile(bars, periodBars, aggr) {
    var rows = new Map(), lo = Infinity, hi = -Infinity, maxPeriod = -1;
    bars.forEach(function (bar) {
      var period = Math.floor(bar.seq / periodBars);
      if (period > maxPeriod) maxPeriod = period;
      bar.levels.forEach(function (v, t) {
        var k = aggr > 1 ? Math.floor(t / aggr) : t, set = rows.get(k);
        if (!set) { set = new Set(); rows.set(k, set); }
        set.add(period);
        if (k < lo) lo = k;
        if (k > hi) hi = k;
      });
    });
    if (!rows.size) return null;
    var counts = new Array(hi - lo + 1).fill(0), pocIdx = 0, mid = (counts.length - 1) / 2, maxCount = 0;
    rows.forEach(function (set, k) { counts[k - lo] = set.size; });
    counts.forEach(function (c, i) {
      if (c > maxCount || (c === maxCount && Math.abs(i - mid) < Math.abs(pocIdx - mid))) { maxCount = c; pocIdx = i; }
    });
    var va = valueArea(counts, pocIdx, OF.config ? OF.config.valueAreaPct : 0.7);
    var sorted = new Map();
    rows.forEach(function (set, k) { sorted.set(k, Array.from(set).sort(function (a, b) { return a - b; })); });
    return { lo: lo, hi: hi, rows: sorted, poc: lo + pocIdx, val: lo + va.lowIdx, vah: lo + va.highIdx, maxCount: maxCount };
  }

  /* Volume-weighted average price with standard deviation. */
  function VWAP() { this.pv = 0; this.v = 0; this.pv2 = 0; }
  VWAP.prototype.add = function (price, size) { this.pv += price * size; this.v += size; this.pv2 += price * price * size; };
  VWAP.prototype.value = function () { return this.v > 0 ? this.pv / this.v : null; };
  VWAP.prototype.sd = function () {
    if (this.v <= 0) return 0;
    var m = this.pv / this.v, variance = this.pv2 / this.v - m * m;
    return variance > 0 ? Math.sqrt(variance) : 0;
  };

  /* Rebuilds an anchored VWAP from stored bars and writes the running value onto each bar as bar.av[id]. */
  function anchorFromBars(bars, fromSeq, tickSize, id) {
    var acc = new VWAP();
    bars.forEach(function (bar) {
      if (bar.seq < fromSeq) return;
      bar.levels.forEach(function (v, t) { acc.add(t * tickSize, v.a + v.b); });
      bar.av = bar.av || {};
      bar.av[id] = acc.value();
    });
    return acc;
  }

  /* Price-vs-CVD divergences between consecutive swing pivots. bars: [{h,l,cvdC}] oldest first.
   * Bearish: higher price high, lower CVD. Bullish: lower price low, higher CVD. */
  function cvdDivergences(bars) {
    var highs = [], lows = [], out = [], i;
    for (i = 1; i < bars.length - 1; i++) {
      if (bars[i].h > bars[i - 1].h && bars[i].h >= bars[i + 1].h) highs.push(i);
      if (bars[i].l < bars[i - 1].l && bars[i].l <= bars[i + 1].l) lows.push(i);
    }
    for (i = 1; i < highs.length; i++) {
      var h1 = bars[highs[i - 1]], h2 = bars[highs[i]];
      if (h2.h > h1.h && h2.cvdC < h1.cvdC) out.push({ type: "bearish", from: highs[i - 1], to: highs[i] });
    }
    for (i = 1; i < lows.length; i++) {
      var l1 = bars[lows[i - 1]], l2 = bars[lows[i]];
      if (l2.l < l1.l && l2.cvdC > l1.cvdC) out.push({ type: "bullish", from: lows[i - 1], to: lows[i] });
    }
    return out;
  }

  /* Resting-liquidity walls: a level far larger than the average of the others. levels: [{tick,size}]. */
  function detectWalls(levels, multiple, minSize) {
    var walls = new Set(), n = levels.length, total = 0;
    if (n < 3) return walls;
    levels.forEach(function (l) { total += l.size; });
    levels.forEach(function (l) {
      var others = (total - l.size) / (n - 1);
      if (l.size >= minSize && l.size >= multiple * others) walls.add(l.tick);
    });
    return walls;
  }

  /* Iceberg absorption: executed volume at a resting level far exceeds the largest size ever shown there
   * while the level is still standing. */
  function IcebergTracker(multiple, minTraded) {
    this.multiple = multiple;
    this.minTraded = minTraded;
    this.entries = new Map();
  }
  IcebergTracker.prototype.onBookLevel = function (side, tick, size) {
    var key = side + tick, e = this.entries.get(key);
    if (!(size > 0)) { this.entries.delete(key); return; }
    if (!e) this.entries.set(key, { peak: size, traded: 0, flagged: false, shown: size });
    else { e.shown = size; if (size > e.peak) e.peak = size; }
  };
  IcebergTracker.prototype.sync = function (side, present) {
    var self = this;
    this.entries.forEach(function (e, key) {
      if (key.charAt(0) === side && !present.has(Number(key.slice(1)))) self.entries.delete(key);
    });
  };
  /* side is the RESTING side that was hit: "a" when a buyer lifted the offer, "b" when a seller hit the bid. */
  IcebergTracker.prototype.onTrade = function (side, tick, size) {
    var e = this.entries.get(side + tick);
    if (!e) return null;
    e.traded += size;
    if (!e.flagged && e.shown > 0 && e.traded >= this.multiple * e.peak && e.traded >= this.minTraded) {
      e.flagged = true;
      return { side: side, tick: tick, traded: e.traded, peak: e.peak };
    }
    return null;
  };
  IcebergTracker.prototype.isFlagged = function (side, tick) {
    var e = this.entries.get(side + tick);
    return !!(e && e.flagged);
  };

  OF.analytics = {
    toTick: toTick, fromTick: fromTick, aggregate: aggregate, imbalances: imbalances, barStats: barStats,
    valueArea: valueArea, volumeProfile: volumeProfile, tpoProfile: tpoProfile, VWAP: VWAP,
    anchorFromBars: anchorFromBars, cvdDivergences: cvdDivergences, detectWalls: detectWalls, IcebergTracker: IcebergTracker
  };
})(globalThis);
