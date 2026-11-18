/* Market state engine. Feeds push normalized events in; renderers read state out.
 * Events: trade {price,size,side:"buy"|"sell",ts}  book {bids,asks}  delta {side:"b"|"a",price,size}
 *         quote {bid,ask,bidSize,askSize}  levels {pdh,pdl,pdc,onh,onl,wo} */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});
  var A = OF.analytics, S = OF.sessions;

  function create(symbolKey, config) {
    var cfg = config || OF.config, sym = cfg.symbols[symbolKey];
    if (!sym) throw new Error("Unknown symbol " + symbolKey);
    return {
      key: symbolKey, sym: sym, cfg: cfg, tickSize: sym.tick,
      l1: { last: null, bid: null, ask: null, bidSize: 0, askSize: 0, volume: 0 },
      bids: new Map(), asks: new Map(),
      levels: new Map(), bars: [], seq: 0,
      cvd: 0, delta: 0, open: null, high: null, low: null,
      vwap: new A.VWAP(), anchors: [], nextAnchorId: 1,
      htf: {}, divs: [],
      tracker: new A.IcebergTracker(cfg.icebergMultiple, sym.iceMin),
      walls: { b: new Set(), a: new Set() }, alerted: new Set(),
      lastSide: null, lastTradeTs: 0, lastTs: 0,
      alerts: [], trades: 0, rev: 0,
      ib: new S.RangeTracker(cfg.rthOpenMin, cfg.ibMinutes), orb: new S.RangeTracker(cfg.rthOpenMin, cfg.orbMinutes),
      tape: [], tapeSeq: 0, sweep: null,
      heat: { cols: [], lastT: 0, pend: { px: null, big: null, traded: new Map() }, lastPullAlert: 0 }
    };
  }

  function pushAlert(m, level, text, ts) {
    m.alerts.unshift({ level: level, text: text, ts: ts || m.lastTs || Date.now() });
    if (m.alerts.length > m.cfg.maxAlerts) m.alerts.pop();
  }

  function newBar(m, t, tick) {
    return { seq: m.seq++, t: t, o: tick, h: tick, l: tick, c: tick, levels: new Map(), vol: 0, delta: 0,
      bv: 0, sv: 0, dMax: 0, dMin: 0, sess: S.sessionOf(t, m.cfg.sessions),
      cvdO: m.cvd, cvdH: m.cvd, cvdL: m.cvd, cvdC: m.cvd, vw: null, sd: 0, av: {} };
  }

  function inferSide(m, price, hinted) {
    if (hinted === "buy" || hinted === "sell") return hinted;
    if (m.l1.ask != null && price >= m.l1.ask) return "buy";
    if (m.l1.bid != null && price <= m.l1.bid) return "sell";
    return m.l1.last != null && price < m.l1.last ? "sell" : "buy";
  }

  function refreshDivergences(m) {
    var done = m.bars.slice(0, -1);
    m.divs = A.cvdDivergences(done).map(function (d) {
      return { type: d.type, fromSeq: done[d.from].seq, toSeq: done[d.to].seq };
    });
    var last = m.divs[m.divs.length - 1];
    if (last) {
      var key = "div:" + last.type + ":" + last.toSeq;
      if (!m.alerted.has(key)) {
        m.alerted.add(key);
        pushAlert(m, "warn", (last.type === "bearish" ? "Bearish" : "Bullish") + " CVD divergence: price " + (last.type === "bearish" ? "higher high" : "lower low") + " without delta confirmation");
      }
    }
  }

  function applyTrade(m, t) {
    var price = Number(t.price), size = Number(t.size);
    if (!(price > 0) || !(size > 0)) return false;
    var ts = Number(t.ts) || Date.now(), side = inferSide(m, price, t.side), tick = A.toTick(price, m.tickSize);
    var barT = Math.floor(ts / m.cfg.barMs) * m.cfg.barMs, bar = m.bars[m.bars.length - 1];
    if (!bar || barT > bar.t) {
      bar = newBar(m, barT, tick);
      m.bars.push(bar);
      if (m.bars.length > m.cfg.maxBars) m.bars.shift();
      if (m.bars.length > 3) refreshDivergences(m);
    }
    if (tick > bar.h) bar.h = tick;
    if (tick < bar.l) bar.l = tick;
    bar.c = tick;

    var signed = side === "buy" ? size : -size;
    [bar.levels, m.levels].forEach(function (map) {
      var cell = map.get(tick);
      if (!cell) { cell = { b: 0, a: 0 }; map.set(tick, cell); }
      if (side === "buy") cell.a += size; else cell.b += size;
    });
    bar.vol += size;
    if (side === "buy") bar.bv += size; else bar.sv += size;
    bar.delta += signed;
    if (bar.delta > bar.dMax) bar.dMax = bar.delta;
    if (bar.delta < bar.dMin) bar.dMin = bar.delta;
    m.cvd += signed;
    m.delta += signed;
    bar.cvdC = m.cvd;
    if (m.cvd > bar.cvdH) bar.cvdH = m.cvd;
    if (m.cvd < bar.cvdL) bar.cvdL = m.cvd;

    m.vwap.add(price, size);
    bar.vw = m.vwap.value();
    bar.sd = m.vwap.sd();
    m.anchors.forEach(function (a) {
      if (ts >= a.ts) { a.acc.add(price, size); bar.av[a.id] = a.acc.value(); }
    });

    if (m.open == null) m.open = price;
    if (m.high == null || price > m.high) m.high = price;
    if (m.low == null || price < m.low) m.low = price;
    m.l1.last = price;
    m.l1.volume += size;
    m.lastSide = side;
    m.lastTradeTs = Date.now();
    m.lastTs = ts;
    m.trades++;

    var entry = recordTape(m, ts, price, size, side, tick);
    trackRanges(m, ts, price);
    var pend = m.heat.pend;
    pend.px = tick;
    pend.traded.set(tick, (pend.traded.get(tick) || 0) + size);
    if (!pend.big || size > pend.big.size) pend.big = { tick: tick, size: size, side: side };

    var hit = m.tracker.onTrade(side === "buy" ? "a" : "b", tick, size);
    if (hit) {
      entry.ice = true;
      pushAlert(m, "warn", "Iceberg absorption on the " + (hit.side === "b" ? "bid" : "offer") + " at " + OF.fmt.price(hit.tick * m.tickSize, m.tickSize) +
        ": " + OF.fmt.size(hit.traded, m.sym.sizeDec) + " executed vs " + OF.fmt.size(hit.peak, m.sym.sizeDec) + " shown", ts);
    }
    sampleHeat(m);
    m.rev++;
    return true;
  }

  /* ---------- Time & sales: block prints and sweeps ---------- */
  function recordTape(m, ts, price, size, side, tick) {
    var tc = m.cfg.tape, blockMin = m.sym.blockMin || m.sym.iceMin || Infinity;
    var e = { seq: m.tapeSeq++, ts: ts, price: price, size: size, side: side, block: size >= blockMin, sweep: false, ice: false };
    var run = m.sweep, gap = ts - (run ? run.lastTs : 0);
    if (run && run.side === side && gap >= 0 && gap <= tc.sweepGapMs) {
      run.lastTs = ts; run.size += size; run.ticks.add(tick);
      if (run.entries.length < 60) run.entries.push(e);
    } else {
      run = m.sweep = { side: side, lastTs: ts, size: size, ticks: new Set([tick]), entries: [e], flagged: false };
    }
    if (run.ticks.size >= tc.sweepLevels) {
      if (!run.flagged) {
        run.flagged = true;
        run.entries.forEach(function (x) { x.sweep = true; });
        pushAlert(m, "warn", "Aggressive " + (side === "buy" ? "buy" : "sell") + " sweep across " + run.ticks.size + " levels, " +
          OF.fmt.size(run.size, m.sym.sizeDec) + " at " + OF.fmt.price(price, m.tickSize), ts);
      }
      e.sweep = true;
    }
    if (e.block) {
      pushAlert(m, "info", "Block " + side + " print " + OF.fmt.size(size, m.sym.sizeDec) + " at " + OF.fmt.price(price, m.tickSize), ts);
    }
    m.tape.push(e);
    if (m.tape.length > tc.max) m.tape.shift();
    return e;
  }

  /* ---------- Initial Balance and Opening Range ---------- */
  function trackRanges(m, ts, price) {
    m.ib.add(ts, price);
    m.orb.add(ts, price);
    var o = m.orb.get();
    if (!o || !m.orb.closedAt(ts)) return;
    var up = price > o.h, down = price < o.l;
    if (!up && !down) return;
    var key = "orb:" + o.day + (up ? ":up" : ":down");
    if (m.alerted.has(key)) return;
    m.alerted.add(key);
    pushAlert(m, "warn", "Opening range breakout " + (up ? "above " : "below ") + OF.fmt.price(up ? o.h : o.l, m.tickSize), ts);
  }

  /* ---------- Liquidity heatmap history ---------- */
  function heatInterval(m) {
    var hc = m.cfg.heat;
    return Math.max(hc.minIntervalMs, Math.round(m.cfg.barMs / hc.colsPerBar));
  }

  function flat(levels) {
    var out = [];
    levels.forEach(function (l) { out.push(l.tick, l.size); });
    return out;
  }

  /* Resting size that vanished without trading through it: spoofing or liquidity pulling. */
  function findPulls(m, prev, t) {
    var out = [], hc = m.cfg.heat, traded = m.heat.pend.traded, wallMin = m.sym.wallMin;
    /* Feeds that publish a fixed-depth snapshot drop far levels as price moves; only levels still inside the book count. */
    var bidLo = Infinity, askHi = -Infinity;
    m.bids.forEach(function (s, k) { if (k < bidLo) bidLo = k; });
    m.asks.forEach(function (s, k) { if (k > askHi) askHi = k; });
    [["b", prev.b, m.bids], ["a", prev.a, m.asks]].forEach(function (d) {
      for (var i = 0; i < d[1].length; i += 2) {
        var tick = d[1][i], was = d[1][i + 1], now = d[2].get(tick) || 0;
        if (was < wallMin || now >= was * hc.pullFrac) continue;
        if (d[0] === "b" ? tick < bidLo : tick > askHi) continue;
        if ((traded.get(tick) || 0) >= (was - now) * hc.pullTradedFrac) continue;
        out.push({ tick: tick, side: d[0], size: was });
      }
    });
    if (out.length && t - m.heat.lastPullAlert >= hc.pullAlertMs) {
      m.heat.lastPullAlert = t;
      var top = out.reduce(function (a, b) { return b.size > a.size ? b : a; });
      pushAlert(m, "info", "Liquidity pulled from the " + (top.side === "b" ? "bid" : "offer") + " at " + OF.fmt.price(top.tick * m.tickSize, m.tickSize) +
        ": " + OF.fmt.size(top.size, m.sym.sizeDec) + " vanished without trading", t);
    }
    return out;
  }

  function sampleHeat(m) {
    var h = m.heat, hc = m.cfg.heat, t = m.cfg.heatClock === "wall" ? Date.now() : (m.lastTs || Date.now());
    if (h.lastT && t - h.lastT < heatInterval(m)) return;
    if (!m.bids.size && !m.asks.size) return;
    var prev = h.cols[h.cols.length - 1];
    var col = { t: t, b: flat(topLevels(m.bids, -1, hc.maxLevels)), a: flat(topLevels(m.asks, 1, hc.maxLevels)),
      px: h.pend.px, bt: h.pend.big ? h.pend.big.tick : null, bs: h.pend.big ? h.pend.big.size : 0, bside: h.pend.big ? h.pend.big.side : null, pulls: [] };
    if (prev) col.pulls = findPulls(m, prev, t);
    h.cols.push(col);
    if (h.cols.length > hc.maxCols) h.cols.shift();
    h.lastT = t;
    h.pend = { px: h.pend.px, big: null, traded: new Map() };
  }

  function topLevels(map, dir, n) {
    return Array.from(map.keys()).sort(function (a, b) { return dir * (a - b); }).slice(0, n)
      .map(function (k) { return { tick: k, size: map.get(k) }; });
  }

  function refreshBest(m) {
    var bb = null, ba = null;
    m.bids.forEach(function (s, k) { if (bb == null || k > bb) bb = k; });
    m.asks.forEach(function (s, k) { if (ba == null || k < ba) ba = k; });
    if (bb != null) { m.l1.bid = bb * m.tickSize; m.l1.bidSize = m.bids.get(bb); }
    if (ba != null) { m.l1.ask = ba * m.tickSize; m.l1.askSize = m.asks.get(ba); }
  }

  function refreshLiquidity(m) {
    var wallMin = m.sym.wallMin, mult = m.cfg.wallMultiple, next = {
      b: A.detectWalls(topLevels(m.bids, -1, 25), mult, wallMin),
      a: A.detectWalls(topLevels(m.asks, 1, 25), mult, wallMin)
    };
    ["b", "a"].forEach(function (side) {
      next[side].forEach(function (tick) {
        var key = "wall:" + side + tick;
        if (!m.alerted.has(key)) {
          m.alerted.add(key);
          var size = (side === "b" ? m.bids : m.asks).get(tick);
          pushAlert(m, "info", (side === "b" ? "Bid" : "Offer") + " liquidity wall " + OF.fmt.size(size, m.sym.sizeDec) + " at " + OF.fmt.price(tick * m.tickSize, m.tickSize));
        }
      });
      m.walls[side].forEach(function (tick) { if (!next[side].has(tick)) m.alerted.delete("wall:" + side + tick); });
    });
    m.walls = next;
  }

  function applyBook(m, bids, asks) {
    m.bids.clear();
    m.asks.clear();
    (bids || []).forEach(function (r) { var s = Number(r[1]); if (s > 0) m.bids.set(A.toTick(Number(r[0]), m.tickSize), s); });
    (asks || []).forEach(function (r) { var s = Number(r[1]); if (s > 0) m.asks.set(A.toTick(Number(r[0]), m.tickSize), s); });
    m.bids.forEach(function (s, k) { m.tracker.onBookLevel("b", k, s); });
    m.asks.forEach(function (s, k) { m.tracker.onBookLevel("a", k, s); });
    m.tracker.sync("b", m.bids);
    m.tracker.sync("a", m.asks);
    refreshBest(m);
    refreshLiquidity(m);
    sampleHeat(m);
    m.rev++;
  }

  function applyBookDelta(m, side, price, size) {
    var map = side === "b" ? m.bids : m.asks, tick = A.toTick(Number(price), m.tickSize), s = Number(size);
    if (s > 0) map.set(tick, s); else map.delete(tick);
    m.tracker.onBookLevel(side, tick, s);
    refreshBest(m);
    refreshLiquidity(m);
    sampleHeat(m);
    m.rev++;
  }

  function applyQuote(m, q) {
    if (q.bid != null) { m.l1.bid = Number(q.bid); m.l1.bidSize = Number(q.bidSize) || 0; }
    if (q.ask != null) { m.l1.ask = Number(q.ask); m.l1.askSize = Number(q.askSize) || 0; }
    m.rev++;
  }

  function setLevels(m, lv) { m.htf = Object.assign({}, lv); m.rev++; }

  /* Anchors a VWAP at the start of bars[barIndex]. edge ("H"|"L") records which swing the user clicked. */
  function addAnchor(m, barIndex, edge) {
    var bar = m.bars[barIndex];
    if (!bar) return null;
    var id = m.nextAnchorId++, acc = A.anchorFromBars(m.bars, bar.seq, m.tickSize, id);
    var anchor = { id: id, ts: bar.t, seq: bar.seq, edge: edge === "L" ? "L" : "H", acc: acc };
    m.anchors.push(anchor);
    while (m.anchors.length > m.cfg.maxAnchors) {
      var old = m.anchors.shift();
      m.bars.forEach(function (b) { delete b.av[old.id]; });
    }
    m.rev++;
    return anchor;
  }

  function clearAnchors(m) {
    m.anchors = [];
    m.bars.forEach(function (b) { b.av = {}; });
    m.rev++;
  }

  OF.engine = {
    create: create, applyTrade: applyTrade, applyBook: applyBook, applyBookDelta: applyBookDelta,
    applyQuote: applyQuote, setLevels: setLevels, addAnchor: addAnchor, clearAnchors: clearAnchors, pushAlert: pushAlert
  };
})(globalThis);
