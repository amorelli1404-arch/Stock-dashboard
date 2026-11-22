/* Futures Desk controller: wires the feed to the engine, owns the controls, tape, alerts, stats strip and status states,
 * and drives the canvas renderers from a throttled requestAnimationFrame loop. Text is always written with textContent. */
(function (g) {
  "use strict";
  var FD = g.FD;
  if (!FD || typeof document === "undefined") return;
  var E = FD.engine, R = FD.render, root = document.getElementById("fdRoot");
  if (!root) return;

  var STORE_KEY = "indexwatch.futures.settings.v1", MIN_FRAME_MS = 33, REFRESH_MS = 200, TAPE_ROWS = 100, ROW_MIN = 9, ROW_MAX = 26, COL_MIN = 48, COL_MAX = 140, NARROW_PX = 560, QUIET_MS = 60000;
  var DEFAULTS = { symbol: "MNQ", interval: 60000, ratio: 3, big: null, tapeMin: 1, speed: 1, source: "sim", relayUrl: "" };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ---------- Settings ---------- */
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { s = {}; }
    var out = Object.assign({}, DEFAULTS);
    if (FD.SYMBOLS[s.symbol]) out.symbol = s.symbol;
    if (FD.INTERVALS.some(function (i) { return i.ms === s.interval; })) out.interval = s.interval;
    if (FD.IMBALANCE_RATIOS.indexOf(s.ratio) >= 0) out.ratio = s.ratio;
    if (Number(s.big) > 0) out.big = Number(s.big);
    if (Number(s.tapeMin) >= 0) out.tapeMin = Number(s.tapeMin);
    if ([1, 5, 20].indexOf(s.speed) >= 0) out.speed = s.speed;
    if (s.source === "relay" || s.source === "sim") out.source = s.source;
    if (typeof s.relayUrl === "string" && s.relayUrl.length < 300) out.relayUrl = s.relayUrl;
    return out;
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(app.s)); } catch (e) { /* not persisted */ } }

  var app = { s: load(), m: null, feed: new FD.Feed(), view: { rowH: 15, colW: 84, off: 0, centerTick: null, hover: null, auto: true }, geo: null, dirty: true, drawnRev: -1, lastDraw: 0, lastLen: 0, pal: null, tapeSig: "", alertSig: -1, rows: [], stripBuilt: false };
  FD.app = app;

  function bigFor(sym) { return app.s.big || FD.SYMBOLS[sym].big; }

  /* A new session starts with the empty-state message; tiles are built when the first trade arrives. */
  function resetStrip() {
    var strip = $("fdStrip");
    strip.textContent = "";
    strip.appendChild(el("div", "fd-empty", "Waiting for the first trade…"));
    app.stripBuilt = false;
  }

  /* ---------- Session lifecycle ---------- */
  function start() {
    var s = app.s;
    app.feed.stop();
    app.m = E.create(s.symbol, { barMs: s.interval, ratio: s.ratio, big: bigFor(s.symbol) });
    app.view.off = 0; app.view.centerTick = null; app.view.auto = true; $("fdRecenter").hidden = true; app.lastLen = 0; app.tapeSig = ""; app.alertSig = -1; app.dirty = true; resetStrip();
    if (s.source === "relay") app.feed.connect(s.relayUrl, s.symbol);
    else app.feed.startSim(s.symbol, { speed: s.speed, barMs: s.interval });
    app.feed.setPaused(app.paused);
    syncControls();
  }

  app.feed.on("trade", function (t) { if (app.m) E.ingestTrade(app.m, t); });
  app.feed.on("book", function (b) { if (app.m) E.ingestBook(app.m, b); });
  app.feed.on("status", function () { app.dirty = true; renderStatus(); });

  /* ---------- Status and empty states ---------- */
  function etParts(ms) {
    var f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { wd: o.weekday, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
  }

  /* CME equity index futures: closed Saturday, Sunday before 18:00 ET, Friday after 17:00 ET, and the 17:00 to 18:00 ET daily break. */
  function marketClosed(ms) {
    var p = etParts(ms);
    return p.wd === "Sat" || (p.wd === "Sun" && p.min < 1080) || (p.wd === "Fri" && p.min >= 1020) || (["Mon", "Tue", "Wed", "Thu"].indexOf(p.wd) >= 0 && p.min >= 1020 && p.min < 1080);
  }

  var BADGE = { sim: ["SIM", "sim"], live: ["LIVE", "live"], connecting: ["CONNECTING", "wait"], waiting: ["WAITING", "wait"], stale: ["NO DATA", "wait"], disconnected: ["OFFLINE", "off"], paused: ["PAUSED", "wait"] };

  function overlayFor(st) {
    var m = app.m;
    if (app.s.source === "sim") return null;
    var lu = m && m.lastTs ? FD.etClock(m.lastTs, false) + " ET" : null, last = lu ? "Last update " + lu : "No data received yet";
    if (st.state === "connecting") return ["Connecting to relay…", app.s.relayUrl];
    if (st.state === "disconnected") return [st.text, app.s.relayUrl ? last : "Paste your relay address above and press Connect."];
    if (st.state === "waiting") return ["Relay connected — waiting for data", "The desk fills as soon as the relay sends trades."];
    if (st.state === "stale") {
      return marketClosed(Date.now()) ? ["Market closed" + (lu ? " — last update " + lu : ""), "The desk resumes automatically when trading reopens."] : ["No data from the relay", last + ". The connection is still open."];
    }
    return null;
  }

  function renderStatus() {
    var f = app.feed, st = { state: f.state, text: f.text }, b = BADGE[st.state] || ["OFFLINE", "off"], badge = $("fdBadge");
    badge.textContent = b[0]; badge.className = "fd-badge " + b[1];
    $("fdStatusText").textContent = st.text;
    var ov = overlayFor(st), box = $("fdOverlay");
    box.hidden = !ov;
    if (ov) { $("fdOverlayTitle").textContent = ov[0]; $("fdOverlaySub").textContent = ov[1]; }
    var sym = FD.SYMBOLS[app.s.symbol];
    $("fdSub").textContent = app.s.symbol + " · " + sym.name + " · tick " + sym.tick.toFixed(2) + " = $" + sym.tickValue.toFixed(2);
  }

  /* ---------- Controls ---------- */
  function seg(id, items, current, onPick) {
    var box = $(id); box.textContent = "";
    items.forEach(function (it) {
      var b = el("button", it.value === current ? "active" : "", it.label);
      b.type = "button"; b.addEventListener("click", function () { onPick(it.value); });
      box.appendChild(b);
    });
  }

  function syncControls() {
    var s = app.s;
    seg("fdSym", Object.keys(FD.SYMBOLS).map(function (k) { return { label: k, value: k }; }), s.symbol, function (v) { s.symbol = v; s.big = null; save(); start(); });
    seg("fdInterval", FD.INTERVALS.map(function (i) { return { label: i.label, value: i.ms }; }), s.interval, function (v) { s.interval = v; save(); start(); });
    seg("fdSource", [{ label: "Simulator", value: "sim" }, { label: "Relay", value: "relay" }], s.source, function (v) { s.source = v; save(); start(); });
    seg("fdSpeed", [1, 5, 20].map(function (x) { return { label: x + "x", value: x }; }), s.speed, function (v) { s.speed = v; save(); app.feed.setSpeed(v); syncControls(); });
    $("fdRatio").value = String(s.ratio);
    $("fdBig").value = bigFor(s.symbol);
    $("fdTapeMin").value = s.tapeMin;
    $("fdRelayUrl").value = s.relayUrl;
    $("fdRelayWrap").hidden = s.source !== "relay";
    $("fdSpeedWrap").hidden = s.source !== "sim";
    $("fdPause").textContent = app.paused ? "Resume" : "Pause";
    renderStatus();
  }

  function bindControls() {
    var s = app.s;
    var ratio = $("fdRatio");
    FD.IMBALANCE_RATIOS.forEach(function (r) { var o = el("option", "", Math.round(r * 100) + "%"); o.value = String(r); ratio.appendChild(o); });
    ratio.addEventListener("change", function () { s.ratio = Number(ratio.value); app.m.cfg.ratio = s.ratio; save(); app.dirty = true; });
    $("fdBig").addEventListener("change", function (e) { var v = Number(e.target.value); if (v > 0) { s.big = v; app.m.cfg.big = v; save(); app.tapeSig = ""; } else e.target.value = bigFor(s.symbol); });
    $("fdTapeMin").addEventListener("change", function (e) { var v = Number(e.target.value); s.tapeMin = v >= 0 ? v : 0; save(); app.tapeSig = ""; });
    $("fdPause").addEventListener("click", function () { app.paused = !app.paused; app.feed.setPaused(app.paused); syncControls(); });
    $("fdConnect").addEventListener("click", function () {
      s.relayUrl = $("fdRelayUrl").value.trim(); save();
      if (!FD.validRelayUrl(s.relayUrl)) { $("fdStatusText").textContent = "Enter a relay address that starts with ws:// or wss://"; return; }
      start();
    });
    $("fdRelayUrl").addEventListener("keydown", function (e) { if (e.key === "Enter") $("fdConnect").click(); });
    $("fdRecenter").addEventListener("click", resetView);
  }

  function resetView() { app.view.off = 0; app.view.centerTick = null; app.view.auto = true; $("fdRecenter").hidden = true; app.dirty = true; }

  /* Hand control of rows and centre to the user, starting from what auto-fit was showing. */
  function leaveAuto() {
    var v = app.view;
    if (!v.auto || !app.geo) return;
    v.auto = false; v.rowH = app.geo.rowH; v.centerTick = app.geo.center;
  }

  /* ---------- Pan and zoom on the footprint ---------- */
  function bindFootprint() {
    var c = $("fdFoot"), drag = null, v = app.view;
    c.addEventListener("pointerdown", function (e) { c.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, off: v.off, moved: false }; });
    c.addEventListener("pointermove", function (e) {
      var r = c.getBoundingClientRect();
      v.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; app.dirty = true;
      if (!drag || !app.m) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; leaveAuto(); drag.ct = v.centerTick; }
      if (!drag.moved) return;
      v.off = Math.max(0, Math.min(app.m.bars.length - 1, Math.round(drag.off + dx / v.colW)));
      v.centerTick = drag.ct + dy / v.rowH;
      $("fdRecenter").hidden = false;
    });
    function end(e) { drag = null; if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); }
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", function () { v.hover = null; app.dirty = true; });
    c.addEventListener("dblclick", resetView);
    c.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.shiftKey && app.m) { v.off = Math.max(0, Math.min(app.m.bars.length - 1, v.off + (e.deltaY > 0 ? -1 : 1))); $("fdRecenter").hidden = v.off === 0 && v.centerTick == null; }
      else if (e.ctrlKey) v.colW = Math.max(COL_MIN, Math.min(COL_MAX, v.colW + (e.deltaY > 0 ? -6 : 6)));
      else { leaveAuto(); v.rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, v.rowH + (e.deltaY > 0 ? -1 : 1))); $("fdRecenter").hidden = false; }
      app.dirty = true;
    }, { passive: false });
  }

  /* ---------- Text panels ---------- */
  function fmtN(n) { return Math.round(n).toLocaleString("en-US"); }
  function fmtSigned(n) { return (n > 0 ? "+" : "") + fmtN(n); }
  function fmtPx(n) { return n.toFixed(2); }

  function renderStrip() {
    var strip = $("fdStrip"), st = E.stats(app.m);
    if (!st) {
      if (app.stripBuilt) { strip.textContent = ""; strip.appendChild(el("div", "fd-empty", "Waiting for the first trade…")); app.stripBuilt = false; }
      return;
    }
    if (!app.stripBuilt) {
      strip.textContent = "";
      ["Last", "Change", "Volume", "Delta", "Buy %", "Big prints", "POC", "VAH", "VAL", "VWAP"].forEach(function (k) {
        var t = el("div", "fd-tile"); t.appendChild(el("span", "k", k)); var v = el("b", "v mono", ""); v.setAttribute("data-k", k); t.appendChild(v); strip.appendChild(t);
      });
      app.stripBuilt = true;
    }
    function set(k, text, cls) { var n = strip.querySelector('[data-k="' + k + '"]'); if (n.textContent !== text) n.textContent = text; var c = "v mono" + (cls ? " " + cls : ""); if (n.className !== c) n.className = c; }
    var up = st.change > 0 ? "buy" : st.change < 0 ? "sell" : "";
    set("Last", fmtPx(st.last), app.m.lastSide === "sell" ? "sell" : "buy");
    set("Change", (st.change > 0 ? "+" : "") + fmtPx(st.change) + " (" + (st.changePct > 0 ? "+" : "") + st.changePct.toFixed(2) + "%)", up);
    set("Volume", fmtN(st.vol)); set("Delta", fmtSigned(st.delta), st.delta > 0 ? "buy" : st.delta < 0 ? "sell" : "");
    set("Buy %", st.buyPct.toFixed(1) + "%"); set("Big prints", String(st.big));
    set("POC", st.poc == null ? "n/a" : fmtPx(st.poc), "acc"); set("VAH", st.vah == null ? "n/a" : fmtPx(st.vah)); set("VAL", st.val == null ? "n/a" : fmtPx(st.val)); set("VWAP", st.vwap == null ? "n/a" : fmtPx(st.vwap));
  }

  function buildTape() {
    var box = $("fdTape"); box.textContent = "";
    for (var i = 0; i < TAPE_ROWS; i++) {
      var r = el("div", "fd-trow"); r.hidden = true;
      r.appendChild(el("span", "t mono")); r.appendChild(el("span", "p mono")); r.appendChild(el("span", "s mono"));
      box.appendChild(r); app.rows.push(r);
    }
    app.tapeEmpty = el("div", "fd-empty", "No prints yet. They stream in here as trades arrive.");
    box.appendChild(app.tapeEmpty);
  }

  function renderTape() {
    var m = app.m, min = app.s.tapeMin, sig = m.tapeSeq + ":" + min + ":" + m.cfg.big;
    if (sig === app.tapeSig) return;
    app.tapeSig = sig;
    var shown = 0, i, e;
    for (i = 0; i < m.tape.length && shown < TAPE_ROWS; i++) {
      e = m.tape[i];
      if (e.size < min && !e.big) continue;
      var r = app.rows[shown], k = r.children;
      r.hidden = false;
      r.className = "fd-trow " + e.side + (e.big ? " big" : "");
      k[0].textContent = FD.etClock(e.ts, true); k[1].textContent = fmtPx(e.price); k[2].textContent = String(e.size);
      shown++;
    }
    for (; shown < TAPE_ROWS; shown++) app.rows[shown].hidden = true;
    app.tapeEmpty.hidden = m.tape.length > 0 && app.rows[0] && !app.rows[0].hidden;
  }

  var ALERT_LABEL = { stacked: "STACKED", absorption: "ABSORPTION", divergence: "DIVERGENCE", large: "LARGE PRINT" };

  function renderAlerts() {
    var m = app.m;
    if (m.alertSeq === app.alertSig) return;
    app.alertSig = m.alertSeq;
    var box = $("fdAlerts"); box.textContent = "";
    if (!m.alerts.length) { box.appendChild(el("div", "fd-empty", "No alerts yet. Stacked imbalances, absorption, delta divergence and large prints are checked as each bar closes.")); return; }
    m.alerts.forEach(function (a) {
      var r = el("div", "fd-alert"), head = el("div", "fd-alert-head");
      head.appendChild(el("span", "t mono", FD.etClock(a.ts, true)));
      head.appendChild(el("span", "chip", ALERT_LABEL[a.type] || a.type.toUpperCase()));
      if (a.side) head.appendChild(el("span", "side " + a.side, a.side === "buy" ? "BUY" : "SELL"));
      r.appendChild(head); r.appendChild(el("div", "fd-alert-text", a.text));
      box.appendChild(r);
    });
  }

  function renderClock() {
    var ms = app.s.source === "sim" ? (app.m.lastTs || Date.now()) : Date.now();
    $("fdClock").textContent = "ET " + FD.etClock(ms, true);
  }

  /* ---------- Render loop ---------- */
  function visible() { return root.getClientRects().length > 0 && !document.hidden; }

  function frame(ts) {
    requestAnimationFrame(frame);
    var m = app.m;
    if (!m || !visible() || ts - app.lastDraw < MIN_FRAME_MS) return;
    var animating = m.flashes.size > 0, changed = app.dirty || m.rev !== app.drawnRev;
    if (!changed && !animating) return;
    app.lastDraw = ts;
    if (m.bars.length !== app.lastLen) { if (app.view.off > 0) app.view.off = Math.min(m.bars.length - 1, app.view.off + (m.bars.length - app.lastLen)); app.lastLen = m.bars.length; }
    var narrow = $("fdFoot").getBoundingClientRect().width < NARROW_PX;
    if (narrow && app.view.colW > 64) app.view.colW = 64;
    app.pal = app.pal || R.palette(root);
    app.geo = R.drawFootprint($("fdFoot"), m, app.view, app.pal);
    R.drawCvd($("fdCvd"), m, app.geo, app.pal);
    R.drawLadder($("fdLadder"), m, app.pal);
    R.drawProfile($("fdProfile"), m, app.pal);
    app.drawnRev = m.rev; app.dirty = false;
  }

  function refresh() {
    var m = app.m;
    if (!m || !visible()) return;
    E.tick(m, app.s.source === "sim" ? m.lastTs : Date.now());
    renderStrip(); renderTape(); renderAlerts(); renderClock(); renderStatus();
  }

  function init() {
    buildTape(); bindControls(); bindFootprint();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(function () { app.dirty = true; }).observe(root);
    start();
    setInterval(refresh, REFRESH_MS);
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
