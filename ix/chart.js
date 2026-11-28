/* Index Workstation canvas renderers: auction chart with profile / level / IB / opening-range overlays, the synchronised
 * CVD pane and small line charts. Pure drawing from the data object it is given. */
(function (g) {
  "use strict";
  var IX = g.IX;
  var AXIS = 64, TIME_H = 18, TOP = 20, RIGHT_PAD = 6, VP_FRACTION = 0.17, LABEL_GAP = 12;
  var MONO = "'JetBrains Mono', 'Roboto Mono', ui-monospace, Consolas, monospace";
  var C = { grid: "rgba(148,163,184,0.09)", text: "#e2e8f0", muted: "#94a3b8", faint: "#64748b", up: "#22c55e", dn: "#ef4444", eth: "rgba(30,41,59,0.55)", panel: "#111827",
    poc: "#f59e0b", va: "#ffb84d", ib: "#38bdf8", or: "#2dd4bf", pdh: "#f87171", pdl: "#4ade80", pdc: "#cbd5e1", onh: "#ffd699", onl: "#93c5fd", open: "#fde047" };
  IX.COLORS = C;

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect(), w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr); }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  function line(ctx, x1, y1, x2, y2, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
  }
  function message(ctx, w, h, text) { ctx.fillStyle = C.muted; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.fillText(text, w / 2, h / 2); }
  function etTime(ms) { var p = IX.etParts(ms); return String(Math.floor(p.min / 60)).padStart(2, "0") + ":" + String(p.min % 60).padStart(2, "0"); }
  IX.etTime = etTime;

  function niceStep(span, target) {
    var raw = span / target, pow = Math.pow(10, Math.floor(Math.log10(raw))), steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * pow >= raw) return steps[i] * pow;
    return 10 * pow;
  }

  /* Right-edge labels, pushed apart so overlapping levels stay readable. */
  function drawLabels(ctx, labels, x1, top, bottom) {
    labels.sort(function (a, b) { return a.y - b.y; });
    var prev = top - LABEL_GAP;
    labels.forEach(function (l) { l.at = Math.max(l.y, prev + LABEL_GAP); prev = l.at; });
    var next = bottom + LABEL_GAP;
    for (var i = labels.length - 1; i >= 0; i--) { labels[i].at = Math.min(labels[i].at, next - LABEL_GAP); next = labels[i].at; }
    ctx.font = "700 9px " + MONO; ctx.textAlign = "right";
    labels.forEach(function (l) {
      var tw = ctx.measureText(l.text).width + 8;
      ctx.fillStyle = "rgba(11,15,23,0.9)"; ctx.fillRect(x1 - tw - 2, l.at - 7, tw, 12);
      ctx.fillStyle = l.color; ctx.fillText(l.text, x1 - 6, l.at + 2);
      if (Math.abs(l.at - l.y) > 3) line(ctx, x1 - tw - 8, l.y, x1 - tw - 2, l.at, l.color, 1);
    });
  }

  /* d: {bars, levels, ib, or, vpRth, vpEth, divs, show, session, digits}; view: {barW, off, hover} */
  IX.drawChart = function (canvas, d, view) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, bars = d.bars;
    if (!bars.length) { message(ctx, w, h, "Waiting for price data."); return null; }
    var x1 = w - AXIS, plotW = x1 - RIGHT_PAD, barW = view.barW, n = Math.max(10, Math.floor(plotW / barW));
    var off = Math.max(0, Math.min(view.off, bars.length - 10)), end = bars.length - off, start = Math.max(0, end - n), vis = bars.slice(start, end);
    var x0 = x1 - RIGHT_PAD - vis.length * barW, bottom = h - TIME_H;
    var lo = Infinity, hi = -Infinity;
    vis.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    var pad = (hi - lo) * 0.07 || 1; lo -= pad; hi += pad;
    function y(p) { return TOP + (hi - p) / (hi - lo) * (bottom - TOP); }
    function xi(i) { return x0 + (i - start) * barW + barW / 2; }
    var geo = { start: start, end: end, x0: x0, x1: x1, barW: barW, xi: xi, w: w, vis: vis, off: off };
    function px(p) { return p.toFixed(d.digits); }

    vis.forEach(function (b, k) {
      var x = x0 + k * barW;
      if (!IX.isRth(b.t)) { ctx.fillStyle = C.eth; ctx.fillRect(x, TOP, barW + 0.5, bottom - TOP); }
      if (k && vis[k - 1].session !== b.session) line(ctx, x, TOP, x, bottom, "rgba(226,232,240,0.28)", 1, [2, 4]);
    });
    var step = niceStep(hi - lo, Math.max(4, (bottom - TOP) / 46));
    ctx.font = "10px " + MONO; ctx.textAlign = "left";
    for (var p = Math.ceil(lo / step) * step; p < hi; p += step) { line(ctx, 0, y(p), x1, y(p), C.grid); ctx.fillStyle = C.muted; ctx.fillText(px(p), x1 + 6, y(p) + 3); }
    var every = Math.max(1, Math.ceil(70 / barW));
    ctx.textAlign = "center";
    for (var k = vis.length - 1; k >= 0; k -= every) { var tx = x0 + k * barW + barW / 2; line(ctx, tx, TOP, tx, bottom, C.grid); ctx.fillStyle = C.faint; ctx.fillText(etTime(vis[k].t), tx, h - 5); }

    ctx.save(); ctx.beginPath(); ctx.rect(0, TOP, x1, bottom - TOP); ctx.clip();
    var labels = [];
    function hline(price, label, color, dash, from, width) {
      if (price == null) return;
      if (price < lo || price > hi) return;
      line(ctx, Math.max(0, from || 0), y(price), x1, y(price), color, width || 1, dash);
      labels.push({ y: y(price), text: label + " " + px(price), color: color });
    }
    function histogram(vp, fromRight, tone) {
      if (!vp) return;
      var max = 0, width = plotW * VP_FRACTION, rows = [];
      vp.levels.forEach(function (c, k2) { var v = c.a + c.b; if (v > max) max = v; rows.push([k2, v]); });
      rows.forEach(function (r) {
        var top = y((r[0] + 1) * vp.bin), bot = y(r[0] * vp.bin);
        if (bot < TOP || top > bottom) return;
        var len = r[1] / max * width, mid = (r[0] + 0.5) * vp.bin, inVa = mid >= vp.val && mid <= vp.vah;
        ctx.fillStyle = Math.abs(mid - vp.poc) < vp.bin / 2 ? "rgba(245,158,11,0.75)" : "rgba(" + tone + "," + (inVa ? 0.42 : 0.18) + ")";
        ctx.fillRect(fromRight ? x1 - len : 0, top, len, Math.max(1, bot - top - 0.5));
      });
    }
    if (d.show.vpEth) histogram(d.vpEth, false, "255,184,77");
    if (d.show.vpRth) histogram(d.vpRth, true, "56,189,248");

    function sessionX(from) {
      for (var i = start; i < end; i++) if (bars[i].session === d.session && bars[i].t >= from - 1) return xi(i) - barW / 2;
      return null;
    }
    function box(r, color, fill) {
      var from = sessionX(Math.floor(r.from / 60000) * 60000 - d.span), to = null;
      for (var i = start; i < end; i++) if (bars[i].session === d.session && bars[i].t <= r.to) to = xi(i) + barW / 2;
      if (from == null || to == null || to <= from) return from;
      ctx.fillStyle = fill; ctx.fillRect(from, y(r.h), to - from, y(r.l) - y(r.h));
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(from + 0.5, y(r.h) + 0.5, to - from - 1, y(r.l) - y(r.h) - 1);
      return from;
    }
    if (d.show.ib && d.ib) {
      var ibx = box(d.ib, C.ib, "rgba(56,189,248,0.10)");
      hline(d.ib.h, "IBH", C.ib, [], ibx, 1.2); hline(d.ib.l, "IBL", C.ib, [], ibx, 1.2);
      [[d.ib.up15, "IB 1.5x"], [d.ib.up20, "IB 2.0x"], [d.ib.dn15, "IB 1.5x"], [d.ib.dn20, "IB 2.0x"]].forEach(function (t) { hline(t[0], t[1], "rgba(56,189,248,0.8)", [7, 5], ibx); });
    }
    if (d.show.or && d.or) {
      var orx = box(d.or, C.or, "rgba(45,212,191,0.16)"), name = "OR" + d.or.minutes;
      hline(d.or.h, name + " H", C.or, [3, 3], orx, 1.2); hline(d.or.l, name + " L", C.or, [3, 3], orx, 1.2);
      if (d.or.complete) { hline(d.or.h + d.or.range, name + " +1R", "rgba(45,212,191,0.7)", [2, 6], orx); hline(d.or.l - d.or.range, name + " -1R", "rgba(45,212,191,0.7)", [2, 6], orx); }
    }

    vis.forEach(function (b, k2) {
      var cx = x0 + k2 * barW + barW / 2, up = b.c >= b.o, col = up ? C.up : C.dn, bw = Math.max(1, Math.floor(barW * 0.68));
      line(ctx, cx, y(b.h), cx, y(b.l), col, 1);
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, Math.min(y(b.o), y(b.c)), bw, Math.max(1, Math.abs(y(b.c) - y(b.o))));
    });

    if (d.show.vpRth && d.vpRth) { hline(d.vpRth.poc, "RTH POC", C.poc, [], 0, 1.3); hline(d.vpRth.vah, "RTH VAH", C.ib, [5, 4]); hline(d.vpRth.val, "RTH VAL", C.ib, [5, 4]); }
    if (d.show.vpEth && d.vpEth) { hline(d.vpEth.poc, "ETH POC", "#fbbf24", [10, 3]); hline(d.vpEth.vah, "ETH VAH", C.va, [2, 4]); hline(d.vpEth.val, "ETH VAL", C.va, [2, 4]); }
    var L = d.levels;
    [["pdh", "PDH"], ["pdl", "PDL"], ["pdc", "PDC"], ["onh", "ONH"], ["onl", "ONL"], ["open", "RTH OPEN"]].forEach(function (k3) { if (d.show[k3[0]]) hline(L[k3[0]], k3[1], C[k3[0]], [6, 3]); });

    if (d.show.div) d.divs.forEach(function (v) {
      if (v.from < start || v.to >= end) return;
      var bear = v.type === "bearish", col = bear ? C.dn : C.up, a = bars[v.from], b = bars[v.to], ya = y(bear ? a.h : a.l) + (bear ? -5 : 5), yb = y(bear ? b.h : b.l) + (bear ? -5 : 5);
      line(ctx, xi(v.from), ya, xi(v.to), yb, col, 1.6, [4, 3]);
      ctx.fillStyle = col; ctx.font = "700 9px " + MONO; ctx.textAlign = "center"; ctx.fillText(bear ? "BEAR DIV" : "BULL DIV", xi(v.to), yb + (bear ? -5 : 12));
    });
    ctx.restore();

    var off1 = 0, off2 = 0;
    ctx.font = "700 9px " + MONO; ctx.textAlign = "left";
    [["pdh", "PDH"], ["pdl", "PDL"], ["pdc", "PDC"], ["onh", "ONH"], ["onl", "ONL"], ["open", "OPEN"]].forEach(function (k4) {
      var v = L[k4[0]];
      if (!d.show[k4[0]] || v == null || (v >= lo && v <= hi)) return;
      ctx.fillStyle = C[k4[0]];
      if (v > hi) ctx.fillText("▲ " + k4[1] + " " + px(v), 6 + off1++ * 108, TOP + 11); else ctx.fillText("▼ " + k4[1] + " " + px(v), 6 + off2++ * 108, bottom - 5);
    });
    drawLabels(ctx, labels, x1, TOP + 8, bottom - 8);

    var last = bars[bars.length - 1], yl = y(last.c);
    if (yl >= TOP && yl <= bottom) {
      line(ctx, 0, yl, x1, yl, "rgba(226,232,240,0.45)", 1, [2, 3]);
      ctx.fillStyle = last.c >= last.o ? C.up : C.dn; ctx.fillRect(x1, yl - 8, AXIS, 16);
      ctx.fillStyle = "#06120a"; ctx.font = "700 11px " + MONO; ctx.textAlign = "left"; ctx.fillText(px(last.c), x1 + 6, yl + 4);
    }
    var hv = view.hover, hb = null;
    if (hv && hv.index != null && hv.index >= start && hv.index < end) {
      hb = bars[hv.index];
      line(ctx, xi(hv.index), TOP, xi(hv.index), bottom, "rgba(226,232,240,0.3)", 1, [3, 3]);
      if (hv.y != null && hv.y > TOP && hv.y < bottom) {
        line(ctx, 0, hv.y, x1, hv.y, "rgba(226,232,240,0.3)", 1, [3, 3]);
        ctx.fillStyle = "#334155"; ctx.fillRect(x1, hv.y - 8, AXIS, 16); ctx.fillStyle = C.text; ctx.font = "10px " + MONO; ctx.textAlign = "left";
        ctx.fillText(px(IX.roundTick(hi - (hv.y - TOP) / (bottom - TOP) * (hi - lo))), x1 + 6, hv.y + 3);
      }
    }
    var info = hb || last;
    ctx.font = "11px " + MONO; ctx.textAlign = "left"; ctx.fillStyle = C.muted;
    ctx.fillText(etTime(info.t) + " ET   O " + px(info.o) + "  H " + px(info.h) + "  L " + px(info.l) + "  C " + px(info.c) + "   Δ " + Math.round(info.delta).toLocaleString("en-US"), 8, 12);
    return geo;
  };

  function compact(v) { var a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v * 100) / 100); }

  IX.drawCvd = function (canvas, geo, d, view) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    if (!geo) { message(ctx, w, h, "Cumulative volume delta"); return; }
    var lo = Infinity, hi = -Infinity;
    geo.vis.forEach(function (b) { if (b.cvdL < lo) lo = b.cvdL; if (b.cvdH > hi) hi = b.cvdH; });
    var pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    function y(v) { return 16 + (hi - v) / (hi - lo) * (h - 22); }
    ctx.font = "10px " + MONO; ctx.textAlign = "left";
    [hi - pad, (hi + lo) / 2, lo + pad].forEach(function (v) { line(ctx, 0, y(v), geo.x1, y(v), C.grid); ctx.fillStyle = C.muted; ctx.fillText(compact(v), geo.x1 + 6, y(v) + 3); });
    if (lo < 0 && hi > 0) line(ctx, 0, y(0), geo.x1, y(0), "rgba(226,232,240,0.35)", 1, [4, 4]);
    geo.vis.forEach(function (b, k) {
      var cx = geo.x0 + k * geo.barW + geo.barW / 2, col = b.cvdC >= b.cvdO ? C.up : C.dn, bw = Math.max(1, Math.floor(geo.barW * 0.6));
      line(ctx, cx, y(b.cvdH), cx, y(b.cvdL), col, 1);
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, Math.min(y(b.cvdO), y(b.cvdC)), bw, Math.max(1, Math.abs(y(b.cvdC) - y(b.cvdO))));
    });
    if (d.show.div) d.divs.forEach(function (v) {
      if (v.from < geo.start || v.to >= geo.end) return;
      line(ctx, geo.xi(v.from), y(d.bars[v.from].cvdC), geo.xi(v.to), y(d.bars[v.to].cvdC), v.type === "bearish" ? C.dn : C.up, 1.6, [4, 3]);
    });
    var hv = view.hover;
    if (hv && hv.index != null && hv.index >= geo.start && hv.index < geo.end) line(ctx, geo.xi(hv.index), 14, geo.xi(hv.index), h, "rgba(226,232,240,0.3)", 1, [3, 3]);
    ctx.fillStyle = C.faint; ctx.font = "700 9px " + MONO; ctx.fillText("CVD · net aggressive buying minus selling, resets each session", 8, 11);
  };

  /* series: [{color, points:[{x, v}], label}]; opts: {zero, markerX, digits, suffix} */
  IX.drawLines = function (canvas, series, opts) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h, o = opts || {}, lo = Infinity, hi = -Infinity, minX = Infinity, maxX = -Infinity;
    series.forEach(function (se) { se.points.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }); });
    if (!isFinite(lo)) { message(ctx, w, h, "Not enough data yet."); return; }
    if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    var pad = (hi - lo) * 0.12 || 0.001; lo -= pad; hi += pad;
    function x(v) { return 4 + (v - minX) / Math.max(1e-9, maxX - minX) * (w - 60); }
    function y(v) { return 14 + (hi - v) / (hi - lo) * (h - 20); }
    ctx.font = "9px " + MONO; ctx.textAlign = "right"; ctx.fillStyle = C.muted;
    [hi - pad, lo + pad].forEach(function (v) { line(ctx, 4, y(v), w - 56, y(v), C.grid); ctx.fillText(v.toFixed(o.digits == null ? 2 : o.digits) + (o.suffix || ""), w - 2, y(v) + 3); });
    if (o.zero) line(ctx, 4, y(0), w - 56, y(0), "rgba(226,232,240,0.35)", 1, [4, 4]);
    if (o.markerX != null) line(ctx, x(o.markerX), 12, x(o.markerX), h - 4, C.poc, 1, [3, 3]);
    series.forEach(function (se, i) {
      ctx.strokeStyle = se.color; ctx.lineWidth = 1.6; ctx.beginPath();
      se.points.forEach(function (p, k) { if (k) ctx.lineTo(x(p.x), y(p.v)); else ctx.moveTo(x(p.x), y(p.v)); });
      ctx.stroke();
      ctx.fillStyle = se.color; ctx.textAlign = "left"; ctx.font = "700 9px " + MONO; ctx.fillText(se.label, 6 + i * 44, 10);
    });
  };
})(globalThis);
