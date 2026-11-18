/* Terminal renderers: liquidity heatmap, per-bar delta histogram, session / IB / ORB levels,
 * position lines and the time mapping that keeps the crosshair synchronised across panels.
 * Pure drawing: reads market state and the `ctl` object, never mutates the market. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});
  var R = OF.render, U = R.u, F = OF.fmt, A = OF.analytics;
  var rgba = U.rgba, MONO = U.MONO, AMBER = U.AMBER, yU = U.yU;

  var IB_COLOR = "#58a6ff", ORB_COLOR = "#d29922", RAMP_STEPS = 32, MIN_INTENSITY = 0.04, SAMPLE_CAP = 4000;
  var RAMP = [[0, [13, 20, 38]], [0.15, [24, 58, 104]], [0.4, [38, 166, 154]], [0.7, [251, 191, 36]], [1, [255, 255, 255]]];

  /* ---------- Time <-> x mapping, shared by every bar-aligned panel ---------- */
  function timeToX(m, n, w, t) {
    var vb = U.visibleBars(m, n);
    if (!vb.count || t < vb.bars[0].t) return null;
    return slotTimeX(vb, R.layoutX(w, n), n, m.cfg.barMs, t);
  }

  function slotTimeX(vb, lay, n, barMs, t) {
    for (var i = vb.bars.length - 1; i >= 0; i--) {
      if (t >= vb.bars[i].t) return lay.x0 + (n - vb.count + i + Math.min(1, (t - vb.bars[i].t) / barMs)) * lay.barW;
    }
    return null;
  }

  function xToTime(m, n, w, x) {
    var vb = U.visibleBars(m, n), lay = R.layoutX(w, n);
    if (!vb.count || x < lay.x0 || x >= lay.x1) return null;
    var pos = (x - lay.x0) / lay.barW - (n - vb.count), i = Math.floor(pos);
    if (i < 0 || i >= vb.count) return null;
    return vb.bars[i].t + (pos - i) * m.cfg.barMs;
  }

  /* ---------- Heatmap colour ramp ---------- */
  var rampColors = (function () {
    var out = [];
    for (var i = 0; i < RAMP_STEPS; i++) {
      var t = i / (RAMP_STEPS - 1), k = 1;
      while (k < RAMP.length - 1 && RAMP[k][0] < t) k++;
      var a = RAMP[k - 1], b = RAMP[k], f = (t - a[0]) / (b[0] - a[0]);
      out.push("rgb(" + [0, 1, 2].map(function (c) { return Math.round(a[1][c] + (b[1][c] - a[1][c]) * f); }).join(",") + ")");
    }
    return out;
  })();

  /* Intensity reference: twice the 95th percentile of resting sizes in view, never below 1.5x the wall threshold, so only real walls glow. */
  function heatRef(cols, from, wallMin) {
    var vals = [], step = Math.max(1, Math.ceil(((cols.length - from) * 40) / SAMPLE_CAP));
    for (var i = from; i < cols.length; i += step) {
      var c = cols[i];
      for (var j = 1; j < c.b.length; j += 2) vals.push(c.b[j]);
      for (j = 1; j < c.a.length; j += 2) vals.push(c.a[j]);
    }
    if (!vals.length) return wallMin;
    vals.sort(function (a, b) { return a - b; });
    return Math.max(vals[Math.floor(vals.length * 0.95)] * 2, wallMin * 1.5);
  }

  function firstVisibleCol(cols, t0) {
    var i = cols.length;
    while (i > 0 && cols[i - 1].t >= t0) i--;
    return i;
  }

  function paintHeat(octx, m, cols, from, geom) {
    var ref = heatRef(cols, from, m.sym.wallMin), hh = Math.max(1, geom.rowPx), iv = geom.iv, last = -1;
    for (var i = from; i < cols.length; i++) {
      var c = cols[i], xa = geom.xOf(c.t), xb = i + 1 < cols.length ? geom.xOf(cols[i + 1].t) : geom.xOf(c.t + iv);
      if (xa == null) continue;
      var cw = Math.max(1, Math.ceil((xb == null ? xa + 2 : xb) - xa));
      for (var side = 0; side < 2; side++) {
        var arr = side ? c.a : c.b;
        for (var j = 0; j < arr.length; j += 2) {
          var tick = arr[j];
          if (tick < geom.lo || tick > geom.hi) continue;
          var q = arr[j + 1] / ref;
          if (q < MIN_INTENSITY) continue;
          var bucket = Math.min(RAMP_STEPS - 1, Math.floor(q * (RAMP_STEPS - 1)));
          if (bucket !== last) { octx.fillStyle = rampColors[bucket]; last = bucket; }
          octx.fillRect(xa, geom.yOf(tick) - hh / 2, cw, hh);
        }
      }
    }
  }

  function levelSize(col, tick) {
    var best = 0;
    [col.b, col.a].forEach(function (arr) { for (var j = 0; j < arr.length; j += 2) if (arr[j] === tick) best = arr[j + 1]; });
    return best;
  }

  function colAtTime(cols, t) {
    var best = null;
    for (var i = cols.length - 1; i >= 0; i--) { if (cols[i].t <= t) { best = cols[i]; break; } }
    return best;
  }

  function drawBookNow(ctx, m, lay, w, top, rowPx, hi, lo, yOf, pal) {
    var x0 = lay.x1 + 6, len = w - x0 - 6, maxS = 1e-9;
    m.bids.forEach(function (s) { if (s > maxS) maxS = s; });
    m.asks.forEach(function (s) { if (s > maxS) maxS = s; });
    ctx.fillStyle = pal.faint; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "left"; ctx.fillText("BOOK NOW", x0, 11);
    [[m.bids, pal.bull], [m.asks, pal.bear]].forEach(function (d) {
      d[0].forEach(function (s, tick) {
        if (tick < lo || tick > hi) return;
        ctx.fillStyle = rgba(d[1], 0.65); ctx.fillRect(x0, yOf(tick) - Math.max(1, rowPx) / 2, Math.max(1, (s / maxS) * len), Math.max(1, rowPx - 0.5));
      });
    });
  }

  function drawHeatOverlays(ctx, m, cols, from, geom, lay, pal, ctl) {
    var pts = [], blockMin = m.sym.blockMin || m.sym.iceMin || 1;
    for (var i = from; i < cols.length; i++) {
      var c = cols[i], xa = geom.xOf(c.t), xb = i + 1 < cols.length ? geom.xOf(cols[i + 1].t) : geom.xOf(c.t + geom.iv);
      if (xa == null) continue;
      var xm = xb == null ? xa : (xa + xb) / 2;
      if (c.px != null && c.px >= geom.lo && c.px <= geom.hi) pts.push([xm, geom.yOf(c.px)]);
      if (c.bt != null && c.bs >= blockMin * 0.5 && c.bt >= geom.lo && c.bt <= geom.hi) {
        var rad = Math.min(14, 3 + Math.sqrt(c.bs / blockMin) * 3), col = c.bside === "buy" ? pal.bull : pal.bear;
        ctx.fillStyle = rgba(col, 0.5); ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(xm, geom.yOf(c.bt), rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      c.pulls.forEach(function (p) {
        if (p.tick < geom.lo || p.tick > geom.hi) return;
        ctx.strokeStyle = AMBER; ctx.lineWidth = 1.6; var y = geom.yOf(p.tick);
        ctx.beginPath(); ctx.moveTo(xm - 4, y - 4); ctx.lineTo(xm + 4, y + 4); ctx.moveTo(xm + 4, y - 4); ctx.lineTo(xm - 4, y + 4); ctx.stroke();
      });
    }
    U.polyline(ctx, pts, "rgba(240,246,252,0.9)", 1.4);
  }

  function drawHeatAxis(ctx, m, geom, lay, w, pal) {
    var ts = m.tickSize, every = Math.max(1, Math.ceil(14 / geom.rowPx));
    ctx.font = "10px " + MONO; ctx.textAlign = "right";
    for (var tick = geom.hi; tick >= geom.lo; tick--) {
      if ((geom.hi - tick) % every) continue;
      ctx.fillStyle = pal.muted; ctx.fillText(F.price(tick * ts, ts), lay.x0 - 5, geom.yOf(tick) + 3);
    }
    if (m.l1.last != null) {
      var yl = geom.yOf(A.toTick(m.l1.last, ts));
      ctx.strokeStyle = rgba(pal.accent, 0.8); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(lay.x0, yl); ctx.lineTo(lay.x1, yl); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = pal.accent; ctx.fillRect(0, yl - 8, lay.x0 - 2, 16);
      ctx.fillStyle = "#0d1117"; ctx.font = "bold 10px " + MONO; ctx.fillText(F.price(m.l1.last, ts), lay.x0 - 5, yl + 4);
    }
  }

  function drawHeatCross(ctx, m, cols, geom, lay, h, top, ctl, pal) {
    var x = ctl.crossT == null ? null : timeToX(m, ctl.visibleBars, lay.x1 + lay.profileW, ctl.crossT);
    ctx.strokeStyle = rgba(pal.text, 0.28); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    if (x != null) { ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, h - 6); }
    var y = ctl.crossTick == null ? null : geom.yOf(ctl.crossTick);
    if (y != null && y >= top && y <= h - 6) { ctx.moveTo(lay.x0, Math.round(y) + 0.5); ctx.lineTo(lay.x1, Math.round(y) + 0.5); }
    ctx.stroke(); ctx.setLineDash([]);
    if (ctl.hoverCanvas !== "heat" || x == null || y == null) return;
    var col = colAtTime(cols, ctl.crossT), tick = Math.round(ctl.crossTick), size = col ? levelSize(col, tick) : 0;
    var lines = [F.price(tick * m.tickSize, m.tickSize) + "  " + F.time(ctl.crossT), size ? "Resting " + F.size(size, m.sym.sizeDec) : "No resting size"];
    ctx.font = "10px " + MONO;
    var bw = Math.max(ctx.measureText(lines[0]).width, ctx.measureText(lines[1]).width) + 12, tx = x + 12 + bw > lay.x1 ? x - 12 - bw : x + 12, ty = Math.min(Math.max(y - 16, top), h - 40);
    ctx.fillStyle = rgba(pal.surface, 0.95); ctx.fillRect(tx, ty, bw, 32);
    ctx.strokeStyle = pal.accent; ctx.strokeRect(tx + 0.5, ty + 0.5, bw - 1, 31);
    ctx.textAlign = "left"; ctx.fillStyle = pal.text; ctx.fillText(lines[0], tx + 6, ty + 13);
    ctx.fillStyle = pal.muted; ctx.fillText(lines[1], tx + 6, ty + 26);
  }

  /* ---------- Liquidity heatmap ---------- */
  function drawHeat(canvas, m, ctl) {
    var s = U.setup(canvas), ctx = s.ctx, w = s.w, h = s.h, pal = U.palette(), n = ctl.visibleBars;
    var vb = U.visibleBars(m, n), cols = m.heat.cols;
    if (!vb.count || cols.length < 2) { U.message(ctx, w, h, "Collecting order book history…", pal); return; }
    var lay = R.layoutX(w, n), top = 16, chartH = h - top - 6, pr = U.priceRange(m, vb), barMs = m.cfg.barMs, t0 = vb.bars[0].t;
    var rowPx = chartH / (pr.hi - pr.lo + 1), iv = cols.length > 1 ? cols[cols.length - 1].t - cols[cols.length - 2].t : barMs;
    var geom = {
      lo: pr.lo, hi: pr.hi, rowPx: rowPx, iv: Math.max(iv, 1),
      xOf: function (t) { return slotTimeX(vb, lay, n, barMs, t); },
      yOf: function (tick) { return top + (pr.hi - tick + 0.5) * rowPx; }
    };
    var from = firstVisibleCol(cols, t0), dpr = window.devicePixelRatio || 1, last = cols[cols.length - 1];
    var key = [w, h, dpr, n, cols.length, last.t, pr.lo, pr.hi, t0, from].join(":"), cache = m._heatCache;
    if (!cache || cache.key !== key) {
      var oc = cache ? cache.canvas : document.createElement("canvas");
      oc.width = Math.floor(w * dpr); oc.height = Math.floor(h * dpr);
      var octx = oc.getContext("2d");
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.fillStyle = "#0a0e14"; octx.fillRect(lay.x0, top, lay.x1 - lay.x0, chartH);
      paintHeat(octx, m, cols, from, geom);
      m._heatCache = cache = { key: key, canvas: oc };
    }
    ctx.drawImage(cache.canvas, 0, 0, w, h);

    ctx.strokeStyle = rgba(pal.border, 0.6); ctx.lineWidth = 1;
    vb.bars.forEach(function (b, i) { var x = lay.x0 + (n - vb.count + i) * lay.barW + 0.5; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - 6); ctx.stroke(); });
    drawHeatOverlays(ctx, m, cols, from, geom, lay, pal, ctl);
    drawHeatAxis(ctx, m, geom, lay, w, pal);
    drawBookNow(ctx, m, lay, w, top, rowPx, pr.hi, pr.lo, geom.yOf, pal);
    ctx.fillStyle = pal.faint; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("LIQUIDITY HEATMAP  resting limit orders, brighter = larger  ·  × pulled without trading  ·  circles = large prints", lay.x0 + 6, 11);
    drawHeatCross(ctx, m, cols, geom, lay, h, top, ctl, pal);
    return { hi: pr.hi, lo: pr.lo, top: top, rowPx: rowPx };
  }

  /* ---------- Delta histogram ---------- */
  function drawDelta(canvas, m, ctl) {
    var s = U.setup(canvas), ctx = s.ctx, w = s.w, h = s.h, pal = U.palette(), n = ctl.visibleBars, dec = m.sym.sizeDec;
    var vb = U.visibleBars(m, n);
    if (!vb.count) { U.message(ctx, w, h, "Waiting for trades…", pal); return; }
    var lay = R.layoutX(w, n), top = 16, bottom = 20, mid = top + (h - top - bottom) / 2, half = (h - top - bottom) / 2 - 12, maxAbs = 1e-9;
    vb.bars.forEach(function (b) { maxAbs = Math.max(maxAbs, Math.abs(b.delta), Math.abs(b.dMax), Math.abs(b.dMin)); });
    function y(v) { return mid - (v / maxAbs) * half; }

    ctx.strokeStyle = rgba(pal.text, 0.3); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(lay.x0, Math.round(mid) + 0.5); ctx.lineTo(lay.x1, Math.round(mid) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "10px " + MONO; ctx.textAlign = "right"; ctx.fillStyle = pal.muted;
    [maxAbs, 0, -maxAbs].forEach(function (v) { ctx.fillText(F.signed(v, dec), lay.x0 - 5, y(v) + 3); });
    ctx.fillStyle = pal.faint; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("DELTA per bar  buy minus sell volume  ·  wick = intrabar max / min", lay.x0 + 6, 11);

    vb.bars.forEach(function (b, i) {
      var cx = lay.x0 + (n - vb.count + i + 0.5) * lay.barW, bw = Math.max(3, lay.barW * 0.5), col = b.delta >= 0 ? pal.bull : pal.bear;
      ctx.strokeStyle = rgba(col, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, y(b.dMax)); ctx.lineTo(cx, y(b.dMin)); ctx.stroke();
      ctx.fillStyle = rgba(col, 0.85); ctx.fillRect(cx - bw / 2, Math.min(y(0), y(b.delta)), bw, Math.max(1, Math.abs(y(b.delta) - y(0))));
      if (lay.barW >= 34) {
        ctx.font = "bold 10px " + MONO; ctx.textAlign = "center"; ctx.fillStyle = col;
        ctx.fillText(F.signed(b.delta, dec), cx, b.delta >= 0 ? y(b.delta) - 4 : y(b.delta) + 12);
        if (lay.barW >= 56 && b.vol > 0) { ctx.font = "9px " + MONO; ctx.fillStyle = pal.faint; ctx.fillText(Math.round(b.delta / b.vol * 100) + "%", cx, h - 6); }
      }
    });
    var chx = ctl.crossT == null ? null : timeToX(m, n, w, ctl.crossT);
    if (chx != null) {
      ctx.strokeStyle = rgba(pal.text, 0.25); ctx.setLineDash([3, 3]); ctx.beginPath();
      ctx.moveTo(Math.round(chx) + 0.5, top); ctx.lineTo(Math.round(chx) + 0.5, h - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    var cur = vb.bars[vb.bars.length - 1], x = lay.x1 + 8;
    ctx.textAlign = "left"; ctx.font = "9px sans-serif"; ctx.fillStyle = pal.faint; ctx.fillText("SESSION Δ", x, 28);
    ctx.font = "bold 13px " + MONO; ctx.fillStyle = m.delta >= 0 ? pal.bull : pal.bear; ctx.fillText(F.signed(m.delta, dec), x, 46);
    ctx.font = "9px sans-serif"; ctx.fillStyle = pal.faint; ctx.fillText("THIS BAR", x, 68);
    ctx.font = "bold 11px " + MONO; ctx.fillStyle = cur.delta >= 0 ? pal.bull : pal.bear; ctx.fillText(F.signed(cur.delta, dec), x, 84);
    ctx.font = "9px " + MONO; ctx.fillStyle = pal.muted;
    ctx.fillText("B " + F.size(cur.bv, dec), x, 100); ctx.fillText("S " + F.size(cur.sv, dec), x, 112);
  }

  /* ---------- Sessions, Initial Balance and Opening Range ---------- */
  function levelLine(ctx, v, pal, price, label, color, dash, tickSize) {
    var y = yU(v, price / tickSize);
    if (y < v.chartTop || y > v.chartTop + v.chartH) return;
    U.polyline(ctx, [[v.x0, y], [v.x1, y]], rgba(color, 0.85), 1.2, dash);
    var text = label + " " + F.price(price, tickSize);
    ctx.font = "bold 9px sans-serif"; ctx.textAlign = "right";
    var tw = ctx.measureText(text).width + 6;
    ctx.fillStyle = rgba(pal.surface, 0.88); ctx.fillRect(v.x1 - tw - 3, y - 9, tw, 11);
    ctx.fillStyle = color; ctx.fillText(text, v.x1 - 6, y);
  }

  function sessionLevels(ctx, m, v, pal, ctl) {
    if (ctl.showIB === false) return;
    var ib = m.ib.get(), orb = m.orb.get(), ts = m.tickSize;
    if (ib) {
      var yh = yU(v, ib.h / ts), yl = yU(v, ib.l / ts), top = Math.max(v.chartTop, yh), bot = Math.min(v.chartTop + v.chartH, yl);
      if (bot > top) { ctx.fillStyle = rgba(IB_COLOR, 0.06); ctx.fillRect(v.x0, top, v.x1 - v.x0, bot - top); }
      levelLine(ctx, v, pal, ib.h, "IB H", IB_COLOR, [8, 4], ts);
      levelLine(ctx, v, pal, ib.l, "IB L", IB_COLOR, [8, 4], ts);
    }
    if (orb) {
      levelLine(ctx, v, pal, orb.h, "ORB H", ORB_COLOR, [2, 3], ts);
      levelLine(ctx, v, pal, orb.l, "ORB L", ORB_COLOR, [2, 3], ts);
    }
  }

  /* ---------- Simulated position, bracket and working orders ---------- */
  function tag(ctx, v, pal, y, text, color) {
    ctx.font = "bold 9px " + MONO; ctx.textAlign = "left";
    var tw = ctx.measureText(text).width + 8, x = (v.x0 + v.x1) / 2 - tw / 2;
    ctx.fillStyle = rgba(pal.surface, 0.92); ctx.fillRect(x, y - 7, tw, 13);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y - 6.5, tw - 1, 12);
    ctx.fillStyle = color; ctx.fillText(text, x + 4, y + 3);
  }

  function tradeLines(ctx, m, v, pal, acct) {
    if (!acct) return;
    var ts = m.tickSize, items = [];
    if (acct.pos) {
      var T = OF.trading, pnl = T.unrealized(acct, m);
      items.push([acct.avg, (acct.pos > 0 ? "LONG " : "SHORT ") + Math.abs(acct.pos) + " @ " + F.price(acct.avg, ts) + "  " + (pnl >= 0 ? "+$" : "-$") + Math.abs(pnl).toFixed(2), acct.pos > 0 ? pal.bull : pal.bear, [], 1.6]);
      if (acct.stop != null) items.push([acct.stop, "STOP " + F.price(acct.stop, ts), pal.bear, [5, 4], 1]);
      if (acct.target != null) items.push([acct.target, "TARGET " + F.price(acct.target, ts), pal.bull, [5, 4], 1]);
    }
    acct.orders.forEach(function (o) { items.push([o.price, (o.side === "buy" ? "BUY " : "SELL ") + "LMT " + o.qty, o.side === "buy" ? pal.bull : pal.bear, [2, 3], 1]); });
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x0, v.chartTop, v.x1 - v.x0, v.chartH); ctx.clip();
    items.forEach(function (it) {
      var y = yU(v, it[0] / ts);
      if (y < v.chartTop || y > v.chartTop + v.chartH) return;
      U.polyline(ctx, [[v.x0, y], [v.x1, y]], it[2], it[4], it[3]);
      tag(ctx, v, pal, y, it[1], it[2]);
    });
    ctx.restore();
  }

  /* Labels drawn on the ladder row for a price: working orders, position average, stop and target. */
  function ladderMarks(acct, tick, tickSize, pal) {
    var out = [];
    if (!acct) return out;
    function at(p) { return p != null && A.toTick(p, tickSize) === tick; }
    acct.orders.forEach(function (o) { if (at(o.price)) out.push({ color: o.side === "buy" ? pal.bull : pal.bear, label: (o.side === "buy" ? "B" : "S") + o.qty }); });
    if (acct.pos && at(acct.avg)) out.push({ color: pal.accent, label: "POS" + (acct.pos > 0 ? "+" : "") + acct.pos });
    if (acct.pos && at(acct.stop)) out.push({ color: pal.bear, label: "SL" });
    if (acct.pos && at(acct.target)) out.push({ color: pal.bull, label: "TP" });
    return out;
  }

  OF.renderExt = {
    drawHeat: drawHeat, drawDelta: drawDelta, sessionLevels: sessionLevels, tradeLines: tradeLines, ladderMarks: ladderMarks,
    timeToX: timeToX, xToTime: xToTime, levelSize: levelSize, colAtTime: colAtTime
  };
})(globalThis);
