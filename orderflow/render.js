/* Canvas renderers. Pure drawing: they read market state and a small `ctl` object
 * ({hoverX, hoverY, hoverCanvas, visibleBars, profileMode}) and never mutate state. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});
  var A = OF.analytics, F = OF.fmt;

  var AXIS_W = 64, STRIP_H = 40, TOP_PAD = 16, MONO = "'JetBrains Mono', 'Roboto Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";
  var AMBER = "#fbbf24", NICE_AGGR = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  var ANCHOR_COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];
  var HTF = [["pdh", "PDH", "#f87171"], ["pdl", "PDL", "#34d399"], ["pdc", "PDC", "#94a3b8"], ["onh", "ONH", "#fbbf24"], ["onl", "ONL", "#60a5fa"], ["wo", "WO", "#c084fc"]];

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr); }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function palette() {
    var cs = getComputedStyle(document.getElementById("ofRoot") || document.documentElement);
    function v(n, fb) { return (cs.getPropertyValue(n) || "").trim() || fb; }
    return { bull: v("--bull", "#10b981"), bear: v("--bear", "#ef4444"), text: v("--text", "#f3f4f6"), muted: v("--text-muted", "#94a3b8"),
      faint: v("--text-faint", "#6b7280"), accent: v("--accent", "#8b5cf6"), bg: v("--bg", "#0d0e15"), surface: v("--surface-solid", "#181925"), border: v("--border", "#2a2c3d") };
  }

  function rgba(color, a) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    var h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  }

  function niceAggr(need) {
    for (var i = 0; i < NICE_AGGR.length; i++) if (NICE_AGGR[i] >= need) return NICE_AGGR[i];
    return NICE_AGGR[NICE_AGGR.length - 1];
  }

  function profileWidth(w) { return Math.round(Math.min(120, Math.max(70, w * 0.15))); }

  /* Shared x layout so the CVD sub-chart lines up bar-for-bar with the footprint. */
  function layoutX(w, n) {
    var pw = profileWidth(w), x0 = AXIS_W, x1 = w - pw;
    return { x0: x0, x1: x1, profileW: pw, barW: (x1 - x0) / n };
  }

  function visibleBars(m, n) {
    var count = Math.min(n, m.bars.length);
    return { count: count, startIdx: m.bars.length - count, bars: m.bars.slice(m.bars.length - count) };
  }

  function message(ctx, w, h, text, pal) {
    ctx.fillStyle = pal.muted;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, h / 2);
  }

  /* Cached per market revision: profile and TPO are the costly parts. */
  function stats(m, ctl) {
    var key = m.rev + ":" + (ctl.tpoPeriod || 0) + ":" + (ctl.profileAggr || 1);
    if (m._statsKey === key) return m._stats;
    m._statsKey = key;
    m._stats = { vp: A.volumeProfile(m.levels, m.cfg.valueAreaPct) };
    return m._stats;
  }

  /* ---------- Depth of Market ladder ---------- */
  function drawLadder(canvas, m, ctl) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, pal = palette(), cfg = m.cfg;
    var headerH = 20, rowH = cfg.ladderRowHeight, rows = Math.max(3, Math.floor((h - headerH) / rowH));
    var lastTick = m.l1.last != null ? A.toTick(m.l1.last, m.tickSize) : (m.l1.bid != null ? A.toTick(m.l1.bid, m.tickSize) : null);
    if (lastTick == null) { message(ctx, w, h, "Waiting for market data…", pal); return; }
    var topTick = lastTick + (ctl.ladderOffset || 0) + Math.floor(rows / 2), dec = m.sym.sizeDec, acct = ctl.acct;
    var bestBid = m.l1.bid != null ? A.toTick(m.l1.bid, m.tickSize) : null, bestAsk = m.l1.ask != null ? A.toTick(m.l1.ask, m.tickSize) : null;
    var wBid = w * 0.21, wPrice = w * 0.25, wAsk = w * 0.21, xPrice = wBid, xAsk = wBid + wPrice, xVol = xAsk + wAsk, wVol = w - xVol;

    var maxBook = 1e-9, maxVol = 1e-9, r, tick;
    for (r = 0; r < rows; r++) {
      tick = topTick - r;
      maxBook = Math.max(maxBook, m.bids.get(tick) || 0, m.asks.get(tick) || 0);
      var lv = m.levels.get(tick);
      if (lv) maxVol = Math.max(maxVol, lv.a + lv.b);
    }

    var tags = new Map(), st = stats(m, ctl);
    function tag(price, label) { if (price == null) return; var t = A.toTick(price, m.tickSize); (tags.get(t) || tags.set(t, []).get(t)).push(label); }
    HTF.forEach(function (d) { tag(m.htf[d[0]], d[1]); });
    tag(m.vwap.value(), "VWAP");
    if (st.vp) { tag(st.vp.poc * m.tickSize, "POC"); tag(st.vp.vah * m.tickSize, "VAH"); tag(st.vp.val * m.tickSize, "VAL"); }

    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = pal.faint;
    ctx.textAlign = "center";
    ctx.fillText("BID", wBid / 2, 13);
    ctx.fillText("PRICE", xPrice + wPrice / 2, 13);
    ctx.fillText("ASK", xAsk + wAsk / 2, 13);
    ctx.fillText("VOL  SELL | BUY", xVol + wVol / 2, 13);

    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180), flashAge = Date.now() - m.lastTradeTs;
    for (r = 0; r < rows; r++) {
      tick = topTick - r;
      var y = headerH + r * rowH, isLast = tick === lastTick, price = F.price(tick * m.tickSize, m.tickSize);
      var bid = m.bids.get(tick), ask = m.asks.get(tick), vol = m.levels.get(tick);
      if (r % 2) { ctx.fillStyle = rgba(pal.border, 0.18); ctx.fillRect(0, y, w, rowH); }
      if (ctl.crossTick != null && Math.round(ctl.crossTick) === tick) { ctx.fillStyle = rgba(pal.text, 0.09); ctx.fillRect(0, y, w, rowH); }

      if (bid) {
        ctx.fillStyle = rgba(pal.bull, 0.38);
        ctx.fillRect(wBid - Math.max(2, (bid / maxBook) * (wBid - 6)), y + 1, Math.max(2, (bid / maxBook) * (wBid - 6)), rowH - 2);
        ctx.fillStyle = pal.text; ctx.textAlign = "right"; ctx.font = (tick === bestBid ? "bold " : "") + "11px " + MONO;
        ctx.fillText(F.size(bid, dec), wBid - 4, y + 13);
        if (m.walls.b.has(tick)) { ctx.strokeStyle = AMBER; ctx.lineWidth = 1.5; ctx.strokeRect(1, y + 1, wBid - 2, rowH - 2); ctx.fillStyle = AMBER; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "left"; ctx.fillText("WALL", 3, y + 12); }
        if (m.tracker.isFlagged("b", tick)) { ctx.strokeStyle = rgba("#f472b6", 0.4 + 0.6 * pulse); ctx.lineWidth = 2; ctx.strokeRect(1, y + 1, wBid - 2, rowH - 2); ctx.fillStyle = "#f472b6"; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "left"; ctx.fillText("ICE", 3, y + 12); }
      }
      if (ask) {
        ctx.fillStyle = rgba(pal.bear, 0.38);
        ctx.fillRect(xAsk + 2, y + 1, Math.max(2, (ask / maxBook) * (wAsk - 6)), rowH - 2);
        ctx.fillStyle = pal.text; ctx.textAlign = "left"; ctx.font = (tick === bestAsk ? "bold " : "") + "11px " + MONO;
        ctx.fillText(F.size(ask, dec), xAsk + 5, y + 13);
        if (m.walls.a.has(tick)) { ctx.strokeStyle = AMBER; ctx.lineWidth = 1.5; ctx.strokeRect(xAsk + 1, y + 1, wAsk - 2, rowH - 2); ctx.fillStyle = AMBER; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "right"; ctx.fillText("WALL", xAsk + wAsk - 3, y + 12); }
        if (m.tracker.isFlagged("a", tick)) { ctx.strokeStyle = rgba("#f472b6", 0.4 + 0.6 * pulse); ctx.lineWidth = 2; ctx.strokeRect(xAsk + 1, y + 1, wAsk - 2, rowH - 2); ctx.fillStyle = "#f472b6"; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "right"; ctx.fillText("ICE", xAsk + wAsk - 3, y + 12); }
      }

      if (isLast) {
        var flash = flashAge < 300 ? 0.55 - flashAge / 700 : 0.3;
        ctx.fillStyle = rgba(m.lastSide === "sell" ? pal.bear : pal.bull, flash + 0.15);
        ctx.fillRect(xPrice, y, wPrice, rowH);
        ctx.strokeStyle = pal.text; ctx.lineWidth = 1; ctx.strokeRect(xPrice + 0.5, y + 0.5, wPrice - 1, rowH - 1);
      } else if (tick === bestBid || tick === bestAsk) {
        ctx.fillStyle = rgba(tick === bestBid ? pal.bull : pal.bear, 0.18);
        ctx.fillRect(xPrice, y, wPrice, rowH);
      }
      ctx.fillStyle = isLast ? pal.text : pal.muted; ctx.textAlign = "right"; ctx.font = (isLast ? "bold " : "") + "11px " + MONO;
      ctx.fillText(price, xPrice + wPrice - 5, y + 13);
      var mine = OF.renderExt.ladderMarks(acct, tick, m.tickSize, pal);
      if (mine.length) {
        ctx.strokeStyle = mine[0].color; ctx.lineWidth = 1.5; ctx.strokeRect(xPrice + 1, y + 1, wPrice - 2, rowH - 2);
        ctx.fillStyle = mine[0].color; ctx.font = "bold 9px " + MONO; ctx.textAlign = "left";
        ctx.fillText(mine.map(function (k) { return k.label; }).join(" "), xPrice + 4, y + 12);
      }
      var tg = mine.length ? null : tags.get(tick);
      if (tg) { ctx.fillStyle = pal.accent; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "left"; ctx.fillText(tg.slice(0, 2).join("/"), xPrice + 3, y + 12); }

      if (vol) {
        var tot = vol.a + vol.b, bw = (tot / maxVol) * (wVol - 6);
        ctx.fillStyle = rgba(pal.bear, 0.35); ctx.fillRect(xVol + 2, y + 2, bw * (vol.b / tot), rowH - 4);
        ctx.fillStyle = rgba(pal.bull, 0.35); ctx.fillRect(xVol + 2 + bw * (vol.b / tot), y + 2, bw * (vol.a / tot), rowH - 4);
        ctx.fillStyle = pal.muted; ctx.font = "9px " + MONO; ctx.textAlign = "right";
        ctx.fillText(F.size(vol.b, dec) + "|" + F.size(vol.a, dec), xVol + wVol - 3, y + 12);
      }
    }
    ctx.strokeStyle = pal.border; ctx.lineWidth = 1;
    [xPrice, xAsk, xVol].forEach(function (x) { ctx.beginPath(); ctx.moveTo(x + 0.5, headerH); ctx.lineTo(x + 0.5, h); ctx.stroke(); });
    return { topTick: topTick, rowH: rowH, headerH: headerH, rows: rows, wBid: wBid, xAsk: xAsk, xPrice: xPrice, wPrice: wPrice };
  }

  /* ---------- Main chart: footprint + VWAP + HTF levels + volume profile ---------- */
  /* Padded tick range covering the visible bars and the last price. Shared by the footprint and heatmap. */
  function priceRange(m, vb) {
    var lo = Infinity, hi = -Infinity;
    vb.bars.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    if (m.l1.last != null) { var lt = A.toTick(m.l1.last, m.tickSize); lo = Math.min(lo, lt); hi = Math.max(hi, lt); }
    var pad = Math.max(2, Math.round((hi - lo) * 0.06));
    return { lo: lo - pad, hi: hi + pad };
  }

  function computeView(m, w, h, n) {
    var vb = visibleBars(m, n);
    if (!vb.count) return null;
    var pr = priceRange(m, vb), lo = pr.lo, hi = pr.hi;
    var chartH = h - TOP_PAD - STRIP_H, aggr = niceAggr(Math.ceil(m.cfg.rowMinPx * (hi - lo + 1) / chartH));
    var kLo = Math.floor(lo / aggr), kHi = Math.floor(hi / aggr), rows = kHi - kLo + 1, lay = layoutX(w, n);
    return { lo: lo, hi: hi, n: n, count: vb.count, startIdx: vb.startIdx, bars: vb.bars, aggr: aggr, kLo: kLo, kHi: kHi, rows: rows, rowH: chartH / rows,
      chartTop: TOP_PAD, chartH: chartH, x0: lay.x0, x1: lay.x1, barW: lay.barW, profileW: lay.profileW, w: w, h: h, tickSize: m.tickSize };
  }
  function yU(v, u) { return v.chartTop + ((v.kHi + 1) - (u + 0.5) / v.aggr) * v.rowH; }
  function uAtY(v, y) { return ((v.kHi + 1) - (y - v.chartTop) / v.rowH) * v.aggr - 0.5; }
  function slotX(v, i) { return v.x0 + (v.n - v.count + i) * v.barW; }

  function sessionLookup(cfg) {
    var by = {};
    cfg.sessions.forEach(function (x) { by[x.id] = x; });
    return by;
  }

  function drawBars(ctx, m, v, pal, ctl) {
    var cfg = m.cfg, dec = m.sym.sizeDec, mode = ctl.fpMode || "bidask", sess = ctl.showSessions === false ? null : sessionLookup(cfg), prevSess = null;
    v.bars.forEach(function (bar, i) {
      var bx = slotX(v, i), sd = sess && sess[bar.sess];
      if (sd) {
        ctx.fillStyle = rgba(sd.color, 0.07); ctx.fillRect(bx, 0, v.barW, v.chartTop + v.chartH + STRIP_H);
        if (bar.sess !== prevSess) {
          ctx.fillStyle = sd.color; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
          ctx.fillText(sd.label.toUpperCase(), bx + 3, 11);
          ctx.fillRect(bx, 0, 2, v.chartTop);
        }
      }
      prevSess = bar.sess;
      var agg = A.aggregate(bar.levels, v.aggr), imb = A.imbalances(agg, cfg.imbalanceRatio, m.sym.imbMin);
      var xc0 = bx + 13, xc1 = bx + v.barW - 3, mid = (xc0 + xc1) / 2, cellW = xc1 - xc0, maxV = 1e-9, bs = A.barStats(agg);
      agg.forEach(function (c) { maxV = mode === "bidask" ? Math.max(maxV, c.a, c.b) : Math.max(maxV, mode === "delta" ? Math.abs(c.a - c.b) : c.a + c.b); });

      var up = bar.c >= bar.o, cc = up ? pal.bull : pal.bear, cx = bx + 7;
      ctx.strokeStyle = cc; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yU(v, bar.h + 0.5)); ctx.lineTo(cx, yU(v, bar.l - 0.5)); ctx.stroke();
      var yo = yU(v, bar.o), yc = yU(v, bar.c);
      ctx.fillStyle = cc; ctx.fillRect(cx - 2.5, Math.min(yo, yc), 5, Math.max(2, Math.abs(yc - yo)));

      var showText = v.rowH >= 10 && cellW >= 50;
      agg.forEach(function (c, k) {
        var y = v.chartTop + (v.kHi - k) * v.rowH;
        if (y + v.rowH < v.chartTop || y > v.chartTop + v.chartH) return;
        if (mode !== "bidask") { drawSingleCell(ctx, c, mode, xc0, y, cellW, v.rowH, maxV, dec, showText, pal); return; }
        var sellImb = imb.sell.has(k), buyImb = imb.buy.has(k);
        ctx.fillStyle = rgba(pal.bear, (sellImb ? 0.35 : 0.06) + 0.3 * (c.b / maxV)); ctx.fillRect(xc0, y, mid - xc0, v.rowH - 0.5);
        ctx.fillStyle = rgba(pal.bull, (buyImb ? 0.35 : 0.06) + 0.3 * (c.a / maxV)); ctx.fillRect(mid, y, xc1 - mid, v.rowH - 0.5);
        if (showText) {
          ctx.font = Math.min(11, Math.floor(v.rowH - 2)) + "px " + MONO;
          ctx.textAlign = "right"; ctx.fillStyle = sellImb ? pal.bear : pal.muted;
          if (sellImb) ctx.font = "bold " + ctx.font;
          ctx.fillText(F.size(c.b, dec), mid - 3, y + v.rowH - 3);
          ctx.font = Math.min(11, Math.floor(v.rowH - 2)) + "px " + MONO;
          ctx.textAlign = "left"; ctx.fillStyle = buyImb ? pal.bull : pal.muted;
          if (buyImb) ctx.font = "bold " + ctx.font;
          ctx.fillText(F.size(c.a, dec), mid + 3, y + v.rowH - 3);
        }
      });
      if (bs.poc != null) {
        ctx.strokeStyle = AMBER; ctx.lineWidth = 1.2;
        ctx.strokeRect(xc0 + 0.5, v.chartTop + (v.kHi - bs.poc) * v.rowH + 0.5, cellW - 1, Math.max(1, v.rowH - 1.5));
      }
      ctx.strokeStyle = rgba(pal.border, 0.7); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx + 0.5, v.chartTop); ctx.lineTo(bx + 0.5, v.chartTop + v.chartH + STRIP_H); ctx.stroke();
      if (i === v.count - 1) { ctx.strokeStyle = rgba(pal.accent, 0.7); ctx.strokeRect(bx + 1, v.chartTop, v.barW - 2, v.chartH); }

      var ty = v.chartTop + v.chartH, tx = bx + v.barW / 2;
      ctx.textAlign = "center"; ctx.font = "bold 10px " + MONO;
      ctx.fillStyle = bar.delta >= 0 ? pal.bull : pal.bear;
      ctx.fillText("Δ" + F.signed(bar.delta, dec), tx, ty + 13);
      if (v.barW >= 44) {
        ctx.font = "10px " + MONO; ctx.fillStyle = pal.muted; ctx.fillText("V" + F.size(bar.vol, dec), tx, ty + 25);
        ctx.fillStyle = pal.faint; ctx.fillText(F.time(bar.t), tx, ty + 37);
      }
    });
  }

  /* One value per price: net delta (ask minus bid) or total volume. */
  function drawSingleCell(ctx, c, mode, x, y, w, rowH, maxV, dec, showText, pal) {
    var val = mode === "delta" ? c.a - c.b : c.a + c.b, strength = Math.abs(val) / maxV;
    var col = mode === "delta" ? (val >= 0 ? pal.bull : pal.bear) : pal.accent;
    ctx.fillStyle = rgba(col, 0.06 + 0.5 * strength); ctx.fillRect(x, y, w, rowH - 0.5);
    if (!showText) return;
    ctx.font = (strength > 0.6 ? "bold " : "") + Math.min(11, Math.floor(rowH - 2)) + "px " + MONO;
    ctx.textAlign = "center"; ctx.fillStyle = strength > 0.15 ? pal.text : pal.muted;
    ctx.fillText(mode === "delta" ? F.signed(val, dec) : F.size(val, dec), x + w / 2, y + rowH - 3);
  }

  function polyline(ctx, pts, color, width, dash) {
    if (pts.length < 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.stroke(); ctx.setLineDash([]);
  }

  function drawOverlays(ctx, m, v, pal) {
    var ts = m.tickSize;
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x0, v.chartTop, v.x1 - v.x0, v.chartH); ctx.clip();

    var vw = [];
    v.bars.forEach(function (b, k) { if (b.vw != null) vw.push({ x: slotX(v, k) + v.barW / 2, p: b.vw, sd: b.sd }); });
    if (vw.length) {
      var band = function (mult) { return vw.map(function (q) { return [q.x, yU(v, (q.p + mult * q.sd) / ts)]; }); };
      var up1 = band(1), dn1 = band(-1).reverse();
      ctx.fillStyle = rgba(AMBER, 0.07); ctx.beginPath();
      up1.concat(dn1).forEach(function (p, k) { if (k) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.fill();
      polyline(ctx, band(2), rgba(AMBER, 0.45), 1, [2, 3]); polyline(ctx, band(-2), rgba(AMBER, 0.45), 1, [2, 3]);
      polyline(ctx, up1, rgba(AMBER, 0.75), 1, [5, 3]); polyline(ctx, band(-1), rgba(AMBER, 0.75), 1, [5, 3]);
      polyline(ctx, vw.map(function (q) { return [q.x, yU(v, q.p / ts)]; }), AMBER, 1.8);
    }

    m.anchors.forEach(function (a, ai) {
      var color = ANCHOR_COLORS[ai % ANCHOR_COLORS.length], pts = [];
      v.bars.forEach(function (b, k) { if (b.av[a.id] != null) pts.push([slotX(v, k) + v.barW / 2, yU(v, b.av[a.id] / ts)]); });
      polyline(ctx, pts, color, 1.8);
      var idx = v.bars.findIndex(function (b) { return b.seq === a.seq; });
      if (idx >= 0) {
        var ax = slotX(v, idx) + 7, bar = v.bars[idx], ay = yU(v, a.edge === "H" ? bar.h + 0.5 : bar.l - 0.5);
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(ax, ay - 5); ctx.lineTo(ax + 5, ay); ctx.lineTo(ax, ay + 5); ctx.lineTo(ax - 5, ay); ctx.closePath(); ctx.fill();
      }
      if (pts.length) { var lp = pts[pts.length - 1]; ctx.fillStyle = color; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "right"; ctx.fillText("AVWAP " + F.time(a.ts), Math.min(lp[0] + 40, v.x1 - 4), lp[1] - 4); }
    });

    var seqBase = m.bars.length ? m.bars[0].seq : 0;
    m.divs.forEach(function (d) {
      var i1 = d.fromSeq - seqBase - v.startIdx, i2 = d.toSeq - seqBase - v.startIdx;
      if (i1 < 0 || i2 >= v.count) return;
      var bull = d.type === "bullish", b1 = v.bars[i1], b2 = v.bars[i2];
      var y1 = yU(v, (bull ? b1.l : b1.h) + (bull ? -0.5 : 0.5)), y2 = yU(v, (bull ? b2.l : b2.h) + (bull ? -0.5 : 0.5));
      var c = bull ? pal.bull : pal.bear;
      polyline(ctx, [[slotX(v, i1) + 7, y1], [slotX(v, i2) + 7, y2]], c, 1.6, [4, 3]);
      ctx.fillStyle = c; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(bull ? "BULL DIV" : "BEAR DIV", slotX(v, i2) + 11, y2 + (bull ? 11 : -4));
    });
    ctx.restore();

    var top = 0, bottom = 0;
    HTF.forEach(function (d) {
      var p = m.htf[d[0]];
      if (p == null) return;
      var y = yU(v, p / ts), label = d[1] + " " + F.price(p, ts);
      ctx.font = "bold 9px sans-serif";
      if (y >= v.chartTop && y <= v.chartTop + v.chartH) {
        polyline(ctx, [[v.x0, y], [v.x1, y]], rgba(d[2], 0.8), 1, [6, 4]);
        var tw = ctx.measureText(label).width + 6;
        ctx.fillStyle = rgba(pal.surface, 0.85); ctx.fillRect(v.x0 + 3, y - 9, tw, 11);
        ctx.fillStyle = d[2]; ctx.textAlign = "left"; ctx.fillText(label, v.x0 + 6, y);
      } else {
        var above = y < v.chartTop;
        ctx.fillStyle = d[2]; ctx.textAlign = "left";
        ctx.fillText((above ? "▲ " : "▼ ") + label, v.x0 + 6, above ? v.chartTop + 10 + 11 * top++ : v.chartTop + v.chartH - 4 - 11 * bottom++);
      }
    });
  }

  function drawProfileOverlay(ctx, m, v, pal, st) {
    var agg = A.aggregate(m.levels, v.aggr), maxV = 1e-9, ts = m.tickSize;
    agg.forEach(function (c) { maxV = Math.max(maxV, c.a + c.b); });
    var px0 = v.x1, pw = v.profileW - 6, vp = st.vp;
    ctx.fillStyle = rgba(pal.surface, 0.55); ctx.fillRect(px0, v.chartTop, v.profileW, v.chartH);
    if (vp) {
      var yH = yU(v, vp.vah + 0.5), yL = yU(v, vp.val - 0.5);
      ctx.fillStyle = rgba(pal.accent, 0.08); ctx.fillRect(px0, yH, v.profileW, yL - yH);
    }
    var pocK = vp ? Math.floor(vp.poc / v.aggr) : null;
    agg.forEach(function (c, k) {
      var y = v.chartTop + (v.kHi - k) * v.rowH, len = ((c.a + c.b) / maxV) * pw;
      if (y + v.rowH < v.chartTop || y > v.chartTop + v.chartH) return;
      ctx.fillStyle = k === pocK ? rgba(AMBER, 0.75) : rgba(pal.accent, 0.5);
      ctx.fillRect(v.w - 2 - len, y + 0.5, len, Math.max(1, v.rowH - 1));
    });
    if (!vp) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x0, v.chartTop, v.w - v.x0, v.chartH); ctx.clip();
    [["POC", vp.poc, AMBER, [], 1.2], ["VAH", vp.vah, pal.accent, [5, 4], 1], ["VAL", vp.val, pal.accent, [5, 4], 1]].forEach(function (d) {
      var y = yU(v, d[1]);
      polyline(ctx, [[v.x0, y], [v.w, y]], rgba(d[2], d[0] === "POC" ? 0.6 : 0.5), d[4], d[3]);
      ctx.fillStyle = d[2]; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(d[0] + " " + F.price(d[1] * ts, ts), v.w - 3, y - 2);
    });
    ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    vp.hvn.forEach(function (t) { ctx.fillStyle = pal.bull; ctx.fillText("▲", v.x1 + 7, yU(v, t) + 3); });
    vp.lvn.forEach(function (t) { ctx.fillStyle = pal.bear; ctx.fillText("▽", v.x1 + 7, yU(v, t) + 3); });
    ctx.restore();
  }

  function drawAxis(ctx, m, v, pal) {
    var every = Math.max(1, Math.ceil(14 / v.rowH)), ts = m.tickSize;
    ctx.font = "10px " + MONO; ctx.textAlign = "right";
    for (var k = v.kHi; k >= v.kLo; k--) {
      if ((v.kHi - k) % every) continue;
      var y = v.chartTop + (v.kHi - k) * v.rowH;
      ctx.strokeStyle = rgba(pal.border, 0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(v.x0, y + 0.5); ctx.lineTo(v.x1, y + 0.5); ctx.stroke();
      ctx.fillStyle = pal.muted;
      ctx.fillText(F.price((k * v.aggr + (v.aggr - 1) / 2) * ts, ts), v.x0 - 5, y + Math.min(v.rowH, 12) - 2);
    }
    ctx.fillStyle = pal.faint; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(v.aggr + (v.aggr === 1 ? " tick" : " ticks") + " / row", 4, 10);
    if (m.l1.last != null) {
      var yl = yU(v, m.l1.last / ts);
      polyline(ctx, [[v.x0, yl], [v.x1, yl]], rgba(pal.accent, 0.7), 1, [2, 3]);
      ctx.fillStyle = pal.accent; ctx.fillRect(0, yl - 8, v.x0 - 2, 16);
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px " + MONO; ctx.textAlign = "right";
      ctx.fillText(F.price(m.l1.last, ts), v.x0 - 5, yl + 4);
    }
  }

  function hoverBarIndex(v, x) {
    if (x < v.x0 || x >= v.x1) return -1;
    var i = Math.floor((x - v.x0) / v.barW) - (v.n - v.count);
    return i >= 0 && i < v.count ? i : -1;
  }

  /* Synchronised crosshair: other panels publish a time and price; this panel maps them to its own pixels. */
  function drawCross(ctx, m, v, ctl, pal) {
    if (ctl.crossT == null && ctl.crossTick == null) return;
    var x = ctl.crossT == null ? null : OF.renderExt.timeToX(m, v.n, v.w, ctl.crossT);
    ctx.strokeStyle = rgba(pal.text, 0.25); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    if (x != null) { ctx.moveTo(Math.round(x) + 0.5, v.chartTop); ctx.lineTo(Math.round(x) + 0.5, v.chartTop + v.chartH); }
    if (ctl.crossTick != null) {
      var y = yU(v, ctl.crossTick);
      if (y >= v.chartTop && y <= v.chartTop + v.chartH) { ctx.moveTo(v.x0, Math.round(y) + 0.5); ctx.lineTo(v.x1, Math.round(y) + 0.5); }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  function drawHover(ctx, m, v, ctl, pal) {
    if (ctl.hoverCanvas !== "main" || ctl.hoverX == null) { drawCross(ctx, m, v, ctl, pal); return; }
    var x = ctl.hoverX, y = ctl.hoverY, i = hoverBarIndex(v, x);
    ctx.strokeStyle = rgba(pal.text, 0.25); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x + 0.5, v.chartTop); ctx.lineTo(x + 0.5, v.chartTop + v.chartH); ctx.moveTo(v.x0, y + 0.5); ctx.lineTo(v.x1, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
    if (i < 0) return;
    var bar = v.bars[i], u = uAtY(v, y), lines = [
      F.time(bar.t) + "   " + F.price(u * m.tickSize, m.tickSize),
      "O " + F.price(bar.o * m.tickSize, m.tickSize) + "  H " + F.price(bar.h * m.tickSize, m.tickSize),
      "L " + F.price(bar.l * m.tickSize, m.tickSize) + "  C " + F.price(bar.c * m.tickSize, m.tickSize),
      "Vol " + F.size(bar.vol, m.sym.sizeDec) + "  Δ " + F.signed(bar.delta, m.sym.sizeDec),
      "click: anchor VWAP here"
    ];
    ctx.font = "10px " + MONO;
    var bw = 0; lines.forEach(function (t) { bw = Math.max(bw, ctx.measureText(t).width); });
    bw += 12;
    var bh = lines.length * 13 + 8, tx = x + 14 + bw > v.x1 ? x - 14 - bw : x + 14, ty = Math.min(Math.max(y - bh / 2, v.chartTop), v.chartTop + v.chartH - bh);
    ctx.fillStyle = rgba(pal.surface, 0.95); ctx.fillRect(tx, ty, bw, bh);
    ctx.strokeStyle = pal.accent; ctx.strokeRect(tx + 0.5, ty + 0.5, bw - 1, bh - 1);
    ctx.textAlign = "left";
    lines.forEach(function (t, k) { ctx.fillStyle = k === 0 ? pal.text : (k === lines.length - 1 ? pal.accent : pal.muted); ctx.fillText(t, tx + 6, ty + 14 + k * 13); });
  }

  function drawMain(canvas, m, ctl) {
    var s = setup(canvas), pal = palette(), v = computeView(m, s.w, s.h, ctl.visibleBars);
    if (!v) { message(s.ctx, s.w, s.h, "Waiting for trades…", pal); return null; }
    var st = stats(m, ctl);
    drawAxis(s.ctx, m, v, pal);
    drawBars(s.ctx, m, v, pal, ctl);
    drawProfileOverlay(s.ctx, m, v, pal, st);
    drawOverlays(s.ctx, m, v, pal);
    OF.renderExt.sessionLevels(s.ctx, m, v, pal, ctl);
    OF.renderExt.tradeLines(s.ctx, m, v, pal, ctl.acct);
    drawHover(s.ctx, m, v, ctl, pal);
    return v;
  }

  /* ---------- Cumulative Volume Delta sub-chart ---------- */
  function drawCVD(canvas, m, ctl) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, pal = palette(), n = ctl.visibleBars;
    var vb = visibleBars(m, n);
    if (!vb.count) { message(ctx, w, h, "Waiting for trades…", pal); return; }
    var lay = layoutX(w, n), top = 14, bottom = 8, lo = Infinity, hi = -Infinity;
    vb.bars.forEach(function (b) { lo = Math.min(lo, b.cvdL); hi = Math.max(hi, b.cvdH); });
    var padV = Math.max((hi - lo) * 0.1, 1e-6); lo -= padV; hi += padV;
    function y(val) { return top + (hi - val) / (hi - lo) * (h - top - bottom); }
    function cx(i) { return lay.x0 + (n - vb.count + i) * lay.barW + 7; }

    ctx.font = "10px " + MONO; ctx.textAlign = "right"; ctx.fillStyle = pal.muted;
    [hi - padV, (hi + lo) / 2, lo + padV].forEach(function (val) {
      ctx.strokeStyle = rgba(pal.border, 0.4); ctx.beginPath(); ctx.moveTo(lay.x0, y(val) + 0.5); ctx.lineTo(lay.x1, y(val) + 0.5); ctx.stroke();
      ctx.fillText(F.size(val, m.sym.sizeDec), lay.x0 - 5, y(val) + 3);
    });
    if (lo < 0 && hi > 0) { ctx.strokeStyle = rgba(pal.text, 0.35); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(lay.x0, y(0) + 0.5); ctx.lineTo(lay.x1, y(0) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = pal.faint; ctx.font = "9px sans-serif"; ctx.textAlign = "left"; ctx.fillText("CVD (cumulative volume delta)", 4, 10);

    var line = [];
    vb.bars.forEach(function (b, i) {
      var c = b.delta >= 0 ? pal.bull : pal.bear, x = cx(i);
      ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y(b.cvdH)); ctx.lineTo(x, y(b.cvdL)); ctx.stroke();
      ctx.fillStyle = c; ctx.fillRect(x - 3, Math.min(y(b.cvdO), y(b.cvdC)), 6, Math.max(2, Math.abs(y(b.cvdC) - y(b.cvdO))));
      line.push([x, y(b.cvdC)]);
    });
    polyline(ctx, line, rgba(pal.accent, 0.8), 1.4);

    var seqBase = m.bars.length ? m.bars[0].seq : 0;
    m.divs.forEach(function (d) {
      var i1 = d.fromSeq - seqBase - vb.startIdx, i2 = d.toSeq - seqBase - vb.startIdx;
      if (i1 < 0 || i2 >= vb.count) return;
      var bull = d.type === "bullish", c = bull ? pal.bull : pal.bear;
      polyline(ctx, [[cx(i1), y(vb.bars[i1].cvdC)], [cx(i2), y(vb.bars[i2].cvdC)]], c, 1.6, [4, 3]);
      ctx.fillStyle = c; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(bull ? "BULL DIV" : "BEAR DIV", cx(i2) + 6, y(vb.bars[i2].cvdC) + (bull ? 12 : -5));
    });
    var chx = ctl.crossT == null ? null : OF.renderExt.timeToX(m, n, w, ctl.crossT);
    if (chx != null) {
      ctx.strokeStyle = rgba(pal.text, 0.25); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(chx) + 0.5, top); ctx.lineTo(Math.round(chx) + 0.5, h - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  /* ---------- Volume profile / TPO side panel ---------- */
  function drawProfilePanel(canvas, m, ctl) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, pal = palette(), st = stats(m, ctl), vp = st.vp, ts = m.tickSize, top = 6, left = 62;
    var tpoMode = ctl.profileMode === "tpo";
    var tpo = tpoMode ? A.tpoProfile(m.bars, ctl.tpoPeriod || 3, 1) : null, src = tpoMode ? tpo : vp;
    if (!src) { message(ctx, w, h, "Waiting for trades…", pal); return; }
    var lo = src.lo, hi = src.hi, rowsTicks = hi - lo + 1, aggr = niceAggr(Math.ceil(11 * rowsTicks / (h - top - 6)));
    var kLo = Math.floor(lo / aggr), kHi = Math.floor(hi / aggr), rows = kHi - kLo + 1, rowH = (h - top - 6) / rows;
    function rowY(k) { return top + (kHi - k) * rowH; }
    function yT(t) { return rowY(Math.floor(t / aggr)) + rowH / 2; }

    var pocK = Math.floor(src.poc / aggr), vahK = Math.floor(src.vah / aggr), valK = Math.floor(src.val / aggr);
    ctx.fillStyle = rgba(pal.accent, 0.09); ctx.fillRect(left, rowY(vahK), w - left, rowY(valK) + rowH - rowY(vahK));

    ctx.font = "10px " + MONO;
    if (!tpoMode) {
      var agg = A.aggregate(m.levels, aggr), maxV = 1e-9;
      agg.forEach(function (c) { maxV = Math.max(maxV, c.a + c.b); });
      agg.forEach(function (c, k) {
        var y = rowY(k), len = ((c.a + c.b) / maxV) * (w - left - 8), sell = len * (c.b / (c.a + c.b));
        ctx.fillStyle = rgba(pal.bear, k === pocK ? 0.8 : 0.45); ctx.fillRect(left, y + 0.5, sell, Math.max(1, rowH - 1));
        ctx.fillStyle = rgba(pal.bull, k === pocK ? 0.8 : 0.45); ctx.fillRect(left + sell, y + 0.5, len - sell, Math.max(1, rowH - 1));
      });
    } else {
      var letterW = 7, cap = Math.floor((w - left - 6) / letterW), clustered = new Map();
      tpo.rows.forEach(function (periods, t) {
        var ck = Math.floor(t / aggr), set = clustered.get(ck);
        if (!set) { set = new Set(); clustered.set(ck, set); }
        periods.forEach(function (p) { set.add(p); });
      });
      clustered.forEach(function (set, k) {
        var periods = Array.from(set).sort(function (a, b) { return a - b; });
        var y = rowY(k), text = periods.map(function (p) { return String.fromCharCode(p % 26 + (p % 52 < 26 ? 65 : 97)); }).join("");
        if (text.length > cap) text = text.slice(0, cap - 1) + "…";
        ctx.fillStyle = k === pocK ? AMBER : pal.text; ctx.textAlign = "left";
        ctx.fillText(text, left + 3, y + rowH - 3);
      });
    }

    var every = Math.max(1, Math.ceil(13 / rowH));
    ctx.textAlign = "right"; ctx.fillStyle = pal.muted;
    for (var k = kHi; k >= kLo; k -= 1) { if ((kHi - k) % every === 0) ctx.fillText(F.price((k * aggr + (aggr - 1) / 2) * ts, ts), left - 5, rowY(k) + Math.min(rowH, 12) - 2); }

    [["POC", src.poc, AMBER], ["VAH", src.vah, pal.accent], ["VAL", src.val, pal.accent]].forEach(function (d) {
      var y = yT(d[1]);
      ctx.strokeStyle = rgba(d[2], 0.7); ctx.lineWidth = 1; ctx.setLineDash(d[0] === "POC" ? [] : [4, 3]);
      ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = d[2]; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "right"; ctx.fillText(d[0], w - 3, y - 2);
    });
    if (!tpoMode && vp) {
      ctx.font = "9px sans-serif"; ctx.textAlign = "left";
      vp.hvn.forEach(function (t) { ctx.fillStyle = pal.bull; ctx.fillText("▲ HVN", left + 2, yT(t) + 3); });
      vp.lvn.forEach(function (t) { ctx.fillStyle = pal.bear; ctx.fillText("▽ LVN", left + 2, yT(t) + 3); });
    }
  }

  OF.render = { drawLadder: drawLadder, drawMain: drawMain, drawCVD: drawCVD, drawProfilePanel: drawProfilePanel,
    hoverBarIndex: hoverBarIndex, uAtY: uAtY, stats: stats, niceAggr: niceAggr, layoutX: layoutX, computeView: computeView,
    /* Shared helpers for render_ext.js */
    u: { setup: setup, palette: palette, rgba: rgba, visibleBars: visibleBars, polyline: polyline, message: message, priceRange: priceRange,
      yU: yU, MONO: MONO, AMBER: AMBER, AXIS_W: AXIS_W, STRIP_H: STRIP_H, TOP_PAD: TOP_PAD, niceAggr: niceAggr } };
})(globalThis);
