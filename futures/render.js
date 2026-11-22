/* Futures Desk canvas renderers: footprint, CVD + delta histogram, DOM ladder and session volume profile.
 * Pure drawing from engine state and a small view object; nothing here mutates the market. */
(function (g) {
  "use strict";
  var FD = (g.FD = g.FD || {});
  var E = FD.engine;

  var AUTO_FIT_BARS = 3, AUTO_ROW_MIN = 10, AUTO_ROW_MAX = 20, AXIS_W = 66, BOTTOM_ROWS = 3, BOTTOM_ROW_H = 16, TOP_PAD = 8, RIGHT_PAD = 8, LADDER_ROW_H = 15, LADDER_HEAD = 22, LADDER_SIDE = 25, PROFILE_AXIS = 56, MIN_PROFILE_ROW = 7;
  var MONO = "'JetBrains Mono', 'Roboto Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace";
  FD.LADDER = { rowH: LADDER_ROW_H, head: LADDER_HEAD, side: LADDER_SIDE };

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect(), w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr); }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function palette(root) {
    var cs = getComputedStyle(root || document.documentElement);
    function v(n, fb) { return (cs.getPropertyValue(n) || "").trim() || fb; }
    return { panel: v("--fd-panel", "#11151b"), panel2: v("--fd-panel-2", "#161b22"), line: v("--fd-line", "#1f262e"), text: v("--fd-text", "#d7dde5"),
      muted: v("--fd-muted", "#7d8793"), faint: v("--fd-faint", "#4d5663"), buy: v("--fd-buy", "#3fb950"), sell: v("--fd-sell", "#f85149"), acc: v("--fd-accent", "#e3b341") };
  }

  function rgba(color, a) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    var h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  }

  function px(m, tick) { return (tick * m.tickSize).toFixed(2); }
  function etClock(ms, secs) { return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: secs ? "2-digit" : undefined }); }
  FD.etClock = etClock;

  function message(ctx, w, h, title, sub, pal) {
    ctx.textAlign = "center"; ctx.fillStyle = pal.text; ctx.font = "600 14px sans-serif"; ctx.fillText(title, w / 2, h / 2 - 4);
    if (sub) { ctx.fillStyle = pal.muted; ctx.font = "12px sans-serif"; ctx.fillText(sub, w / 2, h / 2 + 16); }
  }

  /* ---------- Footprint ---------- */
  /* v: { rowH, colW, off (bars scrolled back), centerTick (null follows price), hover:{x,y}|null }. Returns the geometry other panels align to. */
  function drawFootprint(canvas, m, v, pal) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    if (!m.bars.length) { message(ctx, w, h, "Waiting for the first trade", "The footprint builds as trades arrive.", pal); return null; }
    var colW = v.colW, bottomH = BOTTOM_ROWS * BOTTOM_ROW_H, chartH = h - bottomH - TOP_PAD, lastTick = Math.round(m.last / m.tickSize);
    var nVis = Math.max(1, Math.floor((w - AXIS_W - RIGHT_PAD) / colW)), end = Math.max(1, m.bars.length - v.off), start = Math.max(0, end - nVis), vis = m.bars.slice(start, end);
    var rowH = v.rowH, center = v.centerTick != null ? v.centerTick : lastTick;
    if (v.auto) {
      /* Auto-fit: scale rows to the latest bars with a readable minimum, until the user pans or zooms by hand. */
      var lo = lastTick, hi = lastTick;
      vis.slice(-AUTO_FIT_BARS).forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
      rowH = Math.max(AUTO_ROW_MIN, Math.min(AUTO_ROW_MAX, chartH / (hi - lo + 3))); center = (hi + lo) / 2;
    }
    var rows = Math.max(4, Math.floor(chartH / rowH)), topTick = Math.round(center + rows / 2);
    var xStart = w - RIGHT_PAD - vis.length * colW, showText = rowH >= 10 && colW >= 70, font = Math.min(11, rowH - 2);
    function yOf(tick) { return TOP_PAD + (topTick - tick) * rowH; }
    var geo = { center: center, axisW: AXIS_W, colW: colW, xStart: xStart, vis: vis, startIdx: start, rows: rows, topTick: topTick, rowH: rowH, chartH: chartH, w: w, h: h, yOf: yOf, topPad: TOP_PAD, nVis: nVis };

    var every = Math.max(1, Math.ceil(14 / rowH));
    ctx.font = "10px " + MONO; ctx.textAlign = "right";
    for (var r = 0; r <= rows; r++) {
      var tk = topTick - r, y = yOf(tk);
      if (r % every === 0) { ctx.fillStyle = pal.line; ctx.fillRect(AXIS_W, Math.round(y), w - AXIS_W, 1); ctx.fillStyle = pal.muted; ctx.fillText(px(m, tk), AXIS_W - 6, y + rowH / 2 + 3); }
    }

    vis.forEach(function (bar, i) {
      var x = xStart + i * colW, xc0 = x + 14, xc1 = x + colW - 3, mid = (xc0 + xc1) / 2, cellW = xc1 - xc0;
      var imb = E.imbalances(bar.levels, m.cfg.ratio, E.imbMinFor(m, bar)), poc = E.pocOf(bar.levels), maxCell = 1;
      bar.levels.forEach(function (c) { if (c.a > maxCell) maxCell = c.a; if (c.b > maxCell) maxCell = c.b; });
      ctx.fillStyle = rgba(pal.line, 0.8); ctx.fillRect(Math.round(x), TOP_PAD, 1, chartH + bottomH);

      var up = bar.c >= bar.o, cc = up ? pal.buy : pal.sell, cx = x + 6;
      ctx.fillStyle = cc; ctx.fillRect(Math.round(cx), yOf(bar.h) + 1, 1, Math.max(2, yOf(bar.l) - yOf(bar.h) + rowH - 2));
      var yo = yOf(bar.o) + rowH / 2, yc = yOf(bar.c) + rowH / 2;
      ctx.fillRect(cx - 2, Math.min(yo, yc), 5, Math.max(2, Math.abs(yc - yo)));

      bar.levels.forEach(function (c, tick) {
        if (tick > topTick || tick < topTick - rows) return;
        var y = yOf(tick), sellImb = imb.sell.has(tick), buyImb = imb.buy.has(tick);
        ctx.fillStyle = rgba(pal.sell, (sellImb ? 0.45 : 0.07) + 0.3 * (c.b / maxCell)); ctx.fillRect(xc0, y, mid - xc0, rowH - 1);
        ctx.fillStyle = rgba(pal.buy, (buyImb ? 0.45 : 0.07) + 0.3 * (c.a / maxCell)); ctx.fillRect(mid, y, xc1 - mid, rowH - 1);
        if (sellImb) { ctx.strokeStyle = pal.sell; ctx.lineWidth = 1; ctx.strokeRect(xc0 + 0.5, y + 0.5, mid - xc0 - 1, rowH - 2); }
        if (buyImb) { ctx.strokeStyle = pal.buy; ctx.lineWidth = 1; ctx.strokeRect(mid + 0.5, y + 0.5, xc1 - mid - 1, rowH - 2); }
        if (showText) {
          ctx.font = (sellImb ? "700 " : "") + font + "px " + MONO; ctx.textAlign = "right"; ctx.fillStyle = sellImb ? pal.sell : pal.muted; ctx.fillText(String(c.b), mid - 3, y + rowH - 3);
          ctx.font = (buyImb ? "700 " : "") + font + "px " + MONO; ctx.textAlign = "left"; ctx.fillStyle = buyImb ? pal.buy : pal.muted; ctx.fillText(String(c.a), mid + 3, y + rowH - 3);
        }
      });

      if (poc != null && poc <= topTick && poc >= topTick - rows) { ctx.strokeStyle = pal.acc; ctx.lineWidth = 1.5; ctx.strokeRect(xc0 + 0.5, yOf(poc) + 0.5, cellW - 1, rowH - 2); }
      imb.stacks.forEach(function (st) {
        var yTop = yOf(st.hi), yBot = yOf(st.lo) + rowH - 1, bx = st.side === "buy" ? xc1 + 1 : xc0 - 3;
        ctx.fillStyle = pal.acc; ctx.fillRect(bx, yTop, 2, yBot - yTop);
        ctx.font = "700 9px " + MONO; ctx.textAlign = st.side === "buy" ? "right" : "left"; ctx.fillText("STK" + st.n, st.side === "buy" ? xc1 - 2 : xc0 + 2, yTop - 2);
      });

      var by = TOP_PAD + chartH, tx = x + colW / 2;
      ctx.textAlign = "center"; ctx.font = "700 10px " + MONO; ctx.fillStyle = bar.delta >= 0 ? pal.buy : pal.sell; ctx.fillText((bar.delta > 0 ? "+" : "") + bar.delta, tx, by + 12);
      ctx.font = "10px " + MONO; ctx.fillStyle = pal.muted; ctx.fillText(String(bar.vol), tx, by + 12 + BOTTOM_ROW_H);
      if (colW >= 52) { ctx.fillStyle = pal.faint; ctx.fillText(etClock(bar.t, m.cfg.barMs < 60000), tx, by + 12 + 2 * BOTTOM_ROW_H); }
    });

    ctx.textAlign = "right"; ctx.font = "9px " + MONO; ctx.fillStyle = pal.faint;
    ["DELTA", "VOLUME", "ET"].forEach(function (t, i) { ctx.fillText(t, AXIS_W - 6, TOP_PAD + chartH + 12 + i * BOTTOM_ROW_H); });
    ctx.fillStyle = pal.line; ctx.fillRect(0, TOP_PAD + chartH, w, 1);

    var yl = yOf(lastTick) + rowH / 2;
    if (yl >= TOP_PAD && yl <= TOP_PAD + chartH) {
      ctx.strokeStyle = rgba(pal.text, 0.35); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(AXIS_W, Math.round(yl) + 0.5); ctx.lineTo(w, Math.round(yl) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = pal.panel2; ctx.fillRect(0, yl - 8, AXIS_W - 2, 16);
      ctx.strokeStyle = m.lastSide === "sell" ? pal.sell : pal.buy; ctx.lineWidth = 1; ctx.strokeRect(0.5, yl - 7.5, AXIS_W - 3, 15);
      ctx.fillStyle = pal.text; ctx.font = "700 10px " + MONO; ctx.textAlign = "right"; ctx.fillText(m.last.toFixed(2), AXIS_W - 6, yl + 3.5);
    }
    if (v.hover && v.hover.x > AXIS_W && v.hover.y < TOP_PAD + chartH) {
      ctx.strokeStyle = rgba(pal.text, 0.2); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(AXIS_W, Math.round(v.hover.y) + 0.5); ctx.lineTo(w, Math.round(v.hover.y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      var ht = topTick - Math.floor((v.hover.y - TOP_PAD) / rowH);
      ctx.fillStyle = pal.panel2; ctx.fillRect(0, v.hover.y - 8, AXIS_W - 2, 16); ctx.fillStyle = pal.muted; ctx.textAlign = "right"; ctx.font = "10px " + MONO; ctx.fillText(px(m, ht), AXIS_W - 6, v.hover.y + 3.5);
    }
    return geo;
  }

  /* ---------- CVD + delta histogram ---------- */
  function drawCvd(canvas, m, geo, pal) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    if (!geo || !geo.vis.length) { message(ctx, w, h, "Cumulative delta", "Plots once bars are available.", pal); return; }
    var split = Math.round(h * 0.6), vis = geo.vis, colW = geo.colW, lo = Infinity, hi = -Infinity, maxD = 1;
    vis.forEach(function (b) { lo = Math.min(lo, b.cvdC); hi = Math.max(hi, b.cvdC); maxD = Math.max(maxD, Math.abs(b.delta)); });
    var pad = Math.max((hi - lo) * 0.12, 1); lo -= pad; hi += pad;
    function yc(val) { return 18 + (hi - val) / (hi - lo) * (split - 26); }
    function cx(i) { return geo.xStart + i * colW + colW / 2; }

    ctx.fillStyle = pal.faint; ctx.font = "9px " + MONO; ctx.textAlign = "right"; ctx.fillText("CVD", AXIS_W - 6, 12);
    [hi - pad, (hi + lo) / 2, lo + pad].forEach(function (val) {
      ctx.fillStyle = rgba(pal.line, 0.9); ctx.fillRect(AXIS_W, Math.round(yc(val)), w - AXIS_W, 1);
      ctx.fillStyle = pal.muted; ctx.font = "10px " + MONO; ctx.fillText(Math.round(val).toLocaleString("en-US"), AXIS_W - 6, yc(val) + 3);
    });
    var up = vis[vis.length - 1].cvdC >= vis[0].cvdC, lc = up ? pal.buy : pal.sell;
    ctx.beginPath(); vis.forEach(function (b, i) { if (i) ctx.lineTo(cx(i), yc(b.cvdC)); else ctx.moveTo(cx(i), yc(b.cvdC)); });
    ctx.lineTo(cx(vis.length - 1), split - 6); ctx.lineTo(cx(0), split - 6); ctx.closePath(); ctx.fillStyle = rgba(lc, 0.1); ctx.fill();
    ctx.beginPath(); vis.forEach(function (b, i) { if (i) ctx.lineTo(cx(i), yc(b.cvdC)); else ctx.moveTo(cx(i), yc(b.cvdC)); });
    ctx.strokeStyle = lc; ctx.lineWidth = 1.6; ctx.stroke();
    vis.forEach(function (b, i) { ctx.fillStyle = lc; ctx.fillRect(cx(i) - 1.5, yc(b.cvdC) - 1.5, 3, 3); });

    var hz = split + (h - split) / 2 + 2, half = (h - split) / 2 - 16;
    ctx.fillStyle = pal.line; ctx.fillRect(0, split, w, 1);
    ctx.fillStyle = pal.faint; ctx.font = "9px " + MONO; ctx.textAlign = "right"; ctx.fillText("DELTA", AXIS_W - 6, split + 13);
    ctx.fillStyle = rgba(pal.text, 0.25); ctx.fillRect(AXIS_W, Math.round(hz), w - AXIS_W, 1);
    vis.forEach(function (b, i) {
      var hh = Math.max(1, Math.abs(b.delta) / maxD * half), bw = Math.max(3, colW * 0.5), col = b.delta >= 0 ? pal.buy : pal.sell;
      ctx.fillStyle = rgba(col, 0.85); ctx.fillRect(cx(i) - bw / 2, b.delta >= 0 ? hz - hh : hz, bw, hh);
      if (colW >= 46) { ctx.fillStyle = col; ctx.font = "700 9px " + MONO; ctx.textAlign = "center"; ctx.fillText((b.delta > 0 ? "+" : "") + b.delta, cx(i), b.delta >= 0 ? hz - hh - 3 : hz + hh + 10); }
    });
  }

  /* ---------- DOM ladder ---------- */
  FD.ladderHeight = function () { return LADDER_HEAD + (LADDER_SIDE * 2 + 1) * LADDER_ROW_H; };

  function drawLadder(canvas, m, pal) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    if (m.last == null && !m.bids.length) { message(ctx, w, h, "Waiting for the order book", "Depth appears once the feed sends a book.", pal); return; }
    var mid = m.last != null ? Math.round(m.last / m.tickSize) : (m.bids[0] ? m.bids[0].tick : m.asks[0].tick), lastTick = m.last != null ? Math.round(m.last / m.tickSize) : null;
    var cols = { bid: [0, w * 0.21], price: [w * 0.21, w * 0.43], ask: [w * 0.43, w * 0.64], vol: [w * 0.64, w * 0.82], delta: [w * 0.82, w] };
    var maxBook = 1, maxVol = 1, r, tick, now = Date.now();
    for (r = 0; r <= LADDER_SIDE * 2; r++) {
      tick = mid + LADDER_SIDE - r;
      maxBook = Math.max(maxBook, m.bidMap.get(tick) || 0, m.askMap.get(tick) || 0);
      var lv = m.levels.get(tick); if (lv) maxVol = Math.max(maxVol, lv.a + lv.b);
    }
    var bestBid = m.bids[0] ? m.bids[0].tick : null, bestAsk = m.asks[0] ? m.asks[0].tick : null;
    ctx.font = "700 9px " + MONO; ctx.fillStyle = pal.faint; ctx.textAlign = "center";
    [["BID", "bid"], ["PRICE", "price"], ["ASK", "ask"], ["VOL", "vol"], ["DELTA", "delta"]].forEach(function (c) { ctx.fillText(c[0], (cols[c[1]][0] + cols[c[1]][1]) / 2, 14); });
    ctx.fillStyle = pal.line; ctx.fillRect(0, LADDER_HEAD - 1, w, 1);

    for (r = 0; r <= LADDER_SIDE * 2; r++) {
      tick = mid + LADDER_SIDE - r;
      var y = LADDER_HEAD + r * LADDER_ROW_H, bid = m.bidMap.get(tick), ask = m.askMap.get(tick), lvl = m.levels.get(tick), isLast = tick === lastTick;
      if (r % 2) { ctx.fillStyle = rgba(pal.line, 0.25); ctx.fillRect(0, y, w, LADDER_ROW_H); }
      if (isLast) { ctx.fillStyle = rgba(pal.text, 0.1); ctx.fillRect(0, y, w, LADDER_ROW_H); }
      if (bid) {
        var big = bid >= m.sym.rest, len = Math.max(2, bid / maxBook * (cols.bid[1] - 6));
        ctx.fillStyle = rgba(big ? pal.acc : pal.buy, big ? 0.5 : 0.3); ctx.fillRect(cols.bid[1] - len, y + 1, len, LADDER_ROW_H - 2);
        ctx.fillStyle = pal.text; ctx.font = (big || tick === bestBid ? "700 " : "") + "11px " + MONO; ctx.textAlign = "right"; ctx.fillText(String(bid), cols.bid[1] - 4, y + 11);
      }
      if (ask) {
        var bigA = ask >= m.sym.rest, lenA = Math.max(2, ask / maxBook * (cols.ask[1] - cols.ask[0] - 6));
        ctx.fillStyle = rgba(bigA ? pal.acc : pal.sell, bigA ? 0.5 : 0.3); ctx.fillRect(cols.ask[0] + 2, y + 1, lenA, LADDER_ROW_H - 2);
        ctx.fillStyle = pal.text; ctx.font = (bigA || tick === bestAsk ? "700 " : "") + "11px " + MONO; ctx.textAlign = "left"; ctx.fillText(String(ask), cols.ask[0] + 5, y + 11);
      }
      var fl = m.flashes.get(tick);
      if (fl && now - fl.t < 900) {
        var a = 1 - (now - fl.t) / 900, onBid = bid != null;
        ctx.fillStyle = rgba(pal.acc, 0.55 * a); ctx.fillRect(onBid ? cols.bid[0] : cols.ask[0], y, onBid ? cols.bid[1] : cols.ask[1] - cols.ask[0], LADDER_ROW_H);
        ctx.fillStyle = rgba(pal.acc, a); ctx.font = "700 9px " + MONO; ctx.textAlign = onBid ? "left" : "right"; ctx.fillText(fl.kind === "pull" ? "PULL" : "STACK", onBid ? 3 : cols.ask[1] - 3, y + 11);
      }
      if (tick === bestBid) { ctx.fillStyle = rgba(pal.buy, 0.18); ctx.fillRect(cols.price[0], y, cols.price[1] - cols.price[0], LADDER_ROW_H); }
      else if (tick === bestAsk) { ctx.fillStyle = rgba(pal.sell, 0.18); ctx.fillRect(cols.price[0], y, cols.price[1] - cols.price[0], LADDER_ROW_H); }
      ctx.fillStyle = isLast ? pal.text : pal.muted; ctx.font = (isLast ? "700 " : "") + "11px " + MONO; ctx.textAlign = "right"; ctx.fillText(px(m, tick), cols.price[1] - 6, y + 11);
      if (isLast) { ctx.strokeStyle = m.lastSide === "sell" ? pal.sell : pal.buy; ctx.lineWidth = 1; ctx.strokeRect(cols.price[0] + 0.5, y + 0.5, cols.price[1] - cols.price[0] - 1, LADDER_ROW_H - 1); }
      if (lvl) {
        var tot = lvl.a + lvl.b, vl = tot / maxVol * (cols.vol[1] - cols.vol[0] - 4);
        ctx.fillStyle = rgba(pal.muted, 0.22); ctx.fillRect(cols.vol[0] + 2, y + 2, vl, LADDER_ROW_H - 4);
        ctx.fillStyle = pal.muted; ctx.font = "10px " + MONO; ctx.textAlign = "right"; ctx.fillText(String(tot), cols.vol[1] - 4, y + 11);
        var d = lvl.a - lvl.b;
        ctx.fillStyle = d > 0 ? pal.buy : d < 0 ? pal.sell : pal.muted; ctx.textAlign = "right"; ctx.fillText((d > 0 ? "+" : "") + d, cols.delta[1] - 6, y + 11);
      }
    }
    ctx.fillStyle = pal.line;
    [cols.price[0], cols.ask[0], cols.vol[0], cols.delta[0]].forEach(function (x) { ctx.fillRect(Math.round(x), LADDER_HEAD, 1, h - LADDER_HEAD); });
  }

  /* ---------- Session volume profile ---------- */
  function drawProfile(canvas, m, pal) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, prof = E.profile(m);
    if (!prof) { message(ctx, w, h, "Session profile", "Builds from the first trade.", pal); return; }
    var lo = prof.lo - 2, hi = prof.hi + 2, span = hi - lo + 1, top = 8, bottom = 8, chartH = h - top - bottom;
    var aggr = Math.max(1, Math.ceil(MIN_PROFILE_ROW * span / chartH)), kLo = Math.floor(lo / aggr), kHi = Math.floor(hi / aggr), rows = kHi - kLo + 1, rowH = chartH / rows;
    var vol = new Map(), maxV = 1;
    m.levels.forEach(function (c, t) { var k = Math.floor(t / aggr); vol.set(k, (vol.get(k) || 0) + c.a + c.b); });
    vol.forEach(function (v) { if (v > maxV) maxV = v; });
    function yRow(k) { return top + (kHi - k) * rowH; }
    function yT(t) { return yRow(Math.floor(t / aggr)) + rowH / 2; }
    var pocK = Math.floor(prof.poc / aggr), vahK = Math.floor(prof.vah / aggr), valK = Math.floor(prof.val / aggr), barMax = w - PROFILE_AXIS - 70;
    ctx.fillStyle = rgba(pal.text, 0.04); ctx.fillRect(PROFILE_AXIS, yRow(vahK), w - PROFILE_AXIS, yRow(valK) + rowH - yRow(vahK));
    vol.forEach(function (v, k) {
      var inVa = k <= vahK && k >= valK, len = v / maxV * barMax;
      ctx.fillStyle = k === pocK ? rgba(pal.acc, 0.85) : rgba(pal.text, inVa ? 0.32 : 0.16); ctx.fillRect(PROFILE_AXIS, yRow(k) + 0.5, len, Math.max(1, rowH - 1));
    });
    var every = Math.max(1, Math.ceil(13 / rowH));
    ctx.font = "10px " + MONO; ctx.textAlign = "right"; ctx.fillStyle = pal.muted;
    for (var k = kHi; k >= kLo; k--) if ((kHi - k) % every === 0) ctx.fillText(((k * aggr + (aggr - 1) / 2) * m.tickSize).toFixed(2), PROFILE_AXIS - 5, yRow(k) + Math.min(rowH, 12) - 2);
    function line(t, label, col, dash, wd) {
      var y = yT(t);
      ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(PROFILE_AXIS, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = "700 9px " + MONO; ctx.textAlign = "right"; ctx.fillText(label, w - 4, y - 3);
    }
    line(prof.vah, "VAH", rgba(pal.text, 0.55), [4, 3], 1); line(prof.val, "VAL", rgba(pal.text, 0.55), [4, 3], 1); line(prof.poc, "POC", pal.acc, [], 1.5);
    if (m.vol) line(m.pv / m.vol / m.tickSize, "VWAP", pal.text, [1, 2], 1.5);
    if (m.last != null) {
      var y = yT(m.last / m.tickSize);
      ctx.fillStyle = m.lastSide === "sell" ? pal.sell : pal.buy; ctx.beginPath(); ctx.moveTo(PROFILE_AXIS - 1, y); ctx.lineTo(PROFILE_AXIS + 6, y - 4); ctx.lineTo(PROFILE_AXIS + 6, y + 4); ctx.closePath(); ctx.fill();
    }
  }

  FD.render = { drawFootprint: drawFootprint, drawCvd: drawCvd, drawLadder: drawLadder, drawProfile: drawProfile, palette: palette, AXIS_W: AXIS_W };
})(globalThis);
