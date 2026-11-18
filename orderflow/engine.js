/* Market state engine. Feeds push normalized events in; renderers read state out.
 * Events: trade {price,size,side:"buy"|"sell",ts}  book {bids,asks}  delta {side:"b"|"a",price,size}
 *         quote {bid,ask,bidSize,askSize}  levels {pdh,pdl,pdc,onh,onl,wo} */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});
  var A = OF.analytics;

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
      alerts: [], trades: 0, rev: 0
    };
  }

  function pushAlert(m, level, text, ts) {
    m.alerts.unshift({ level: level, text: text, ts: ts || m.lastTs || Date.now() });
    if (m.alerts.length > m.cfg.maxAlerts) m.alerts.pop();
  }

  function newBar(m, t, tick) {
    return { seq: m.seq++, t: t, o: tick, h: tick, l: tick, c: tick, levels: new Map(), vol: 0, delta: 0,
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
    bar.delta += signed;
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

    var hit = m.tracker.onTrade(side === "buy" ? "a" : "b", tick, size);
    if (hit) {
      pushAlert(m, "warn", "Iceberg absorption on the " + (hit.side === "b" ? "bid" : "offer") + " at " + OF.fmt.price(hit.tick * m.tickSize, m.tickSize) +
        ": " + OF.fmt.size(hit.traded, m.sym.sizeDec) + " executed vs " + OF.fmt.size(hit.peak, m.sym.sizeDec) + " shown", ts);
    }
    m.rev++;
    return true;
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
    m.rev++;
  }

  function applyBookDelta(m, side, price, size) {
    var map = side === "b" ? m.bids : m.asks, tick = A.toTick(Number(price), m.tickSize), s = Number(size);
    if (s > 0) map.set(tick, s); else map.delete(tick);
    m.tracker.onBookLevel(side, tick, s);
    refreshBest(m);
    refreshLiquidity(m);
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
