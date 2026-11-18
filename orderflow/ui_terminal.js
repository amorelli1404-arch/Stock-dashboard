/* Terminal layer on top of ui.js: workspaces, resizable columns, full screen, simulated execution panel,
 * click-to-trade on the ladder, time & sales, audio cues and hotkeys. Talks to ui.js only through OF.ui. */
(function (g) {
  "use strict";
  var OF = g.OF;
  if (!OF || !OF.ui || typeof document === "undefined") return;
  var ui = OF.ui, app = ui.app, T = OF.trading, A = OF.analytics, F = OF.fmt, root = document.getElementById("ofRoot");
  if (!root) return;

  var STORE_KEY = "indexwatch.orderflow.layout", WORKSPACES = ["scalp", "macro", "tape"];
  var SPLIT_MIN = 220, SPLIT_MAX = 560, AUDIO_QUIET_MS = 3000, AUDIO_BURST = 40, CLOCK_MS = 1000;
  var state = { tapeKey: "", seqSeen: -1, pullCols: 0, nativeFs: false, clockSec: 0, msgTimer: null };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function setText(id, text, cls) { var n = $(id); if (n.textContent !== text) n.textContent = text; if (cls != null && n.className !== cls) n.className = cls; }
  function usd(v) { return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2); }

  /* Per-viewer layout preferences. Storage can be unavailable (private mode, sandbox), so it is best effort. */
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  function save(patch) { try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign(load(), patch))); } catch (e) { /* not persisted */ } }

  /* ---------- Workspaces and resizable columns ---------- */
  function setWorkspace(name) {
    if (WORKSPACES.indexOf(name) < 0) name = "scalp";
    root.setAttribute("data-ws", name);
    document.querySelectorAll("[data-of-ws]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-of-ws") === name); });
    save({ ws: name });
    ui.redraw();
  }

  function setColumn(side, px) {
    var w = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, Math.round(px)));
    root.style.setProperty(side === "l" ? "--of-l" : "--of-r", w + "px");
    return w;
  }

  function bindSplitters() {
    document.querySelectorAll(".of-split").forEach(function (bar) {
      var side = bar.getAttribute("data-split");
      bar.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        bar.classList.add("dragging");
      });
      bar.addEventListener("pointermove", function (e) {
        if (!bar.classList.contains("dragging")) return;
        var grid = root.querySelector(".of-grid").getBoundingClientRect();
        var w = setColumn(side, side === "l" ? e.clientX - grid.left : grid.right - e.clientX);
        var patch = {}; patch[side] = w; save(patch);
        ui.redraw();
      });
      function end(e) { bar.classList.remove("dragging"); if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId); }
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
      bar.addEventListener("dblclick", function () { root.style.removeProperty(side === "l" ? "--of-l" : "--of-r"); var p = {}; p[side] = null; save(p); ui.redraw(); });
    });
  }

  /* ---------- Full screen ---------- */
  function setMax(on) {
    root.classList.toggle("of-max", on);
    document.body.classList.toggle("of-max-open", on);
    var b = $("ofFullscreen");
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "Exit full screen" : "Full screen";
    ui.redraw();
  }

  function toggleFullscreen() {
    var on = !root.classList.contains("of-max");
    if (on) {
      setMax(true);
      /* Native full screen hides the browser chrome too; where it is blocked the page stays maximised in place. */
      if (root.requestFullscreen) root.requestFullscreen().catch(function () { /* maximised in page instead */ });
    } else {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
      state.nativeFs = false;
      setMax(false);
    }
  }

  document.addEventListener("fullscreenchange", function () {
    if (document.fullscreenElement === root) { state.nativeFs = true; return; }
    if (state.nativeFs) { state.nativeFs = false; setMax(false); }
  });

  /* ---------- Execution panel ---------- */
  function say(text, kind) {
    var n = $("ofXMsg");
    n.textContent = text;
    n.className = "of-xmsg " + (kind || "");
    clearTimeout(state.msgTimer);
    state.msgTimer = setTimeout(function () { n.textContent = ""; n.className = "of-xmsg"; }, 6000);
  }

  function describe(r) {
    if (r.fill) return (r.fill.side === "buy" ? "Bought " : "Sold ") + r.fill.qty + " @ " + F.price(r.fill.price, app.market.tickSize) + " (" + r.fill.tag + ")";
    if (r.order) return (r.order.side === "buy" ? "Buy" : "Sell") + " limit " + r.order.qty + " @ " + F.price(r.order.price, app.market.tickSize) + " working";
    return "Done";
  }

  /* Runs an execution request and reports the outcome. quiet suppresses the "nothing to do" rejections. */
  function run(result, quiet) {
    if (!result.ok) { if (!quiet) say(result.reason, "bad"); return result; }
    say(describe(result), "good");
    if (result.fill) OF.audio.play("fill");
    ui.redraw();
    return result;
  }

  function readFields() {
    var a = app.acct;
    if (!a) return;
    /* An empty field is invalid input, not zero: zero would silently disable the stop, target or loss limit. */
    function val(id) { var t = $(id).value.trim(), n = Number(t); return t !== "" && isFinite(n) && n >= 0 ? n : null; }
    var qty = val("ofQty"), stop = val("ofStopTicks"), tgt = val("ofTargetTicks"), loss = val("ofMaxLoss");
    if (qty > 0) a.qty = qty;
    if (stop != null) a.stopTicks = stop;
    if (tgt != null) a.targetTicks = tgt;
    if (loss != null) a.maxLoss = loss;
    fillFields(app.market);
    if (a.pos) T.setBracket(a);
    ui.redraw();
  }

  function fillFields(m) {
    var a = app.acct;
    $("ofQty").value = a.qty; $("ofQty").step = m.sym.sizeStep;
    $("ofStopTicks").value = a.stopTicks; $("ofTargetTicks").value = a.targetTicks; $("ofMaxLoss").value = a.maxLoss;
  }

  function bindExecution() {
    ["ofQty", "ofStopTicks", "ofTargetTicks", "ofMaxLoss"].forEach(function (id) { $(id).addEventListener("change", readFields); });
    $("ofBuyMkt").addEventListener("click", function () { readFields(); run(T.marketOrder(app.acct, app.market, "buy")); });
    $("ofSellMkt").addEventListener("click", function () { readFields(); run(T.marketOrder(app.acct, app.market, "sell")); });
    $("ofJoinBid").addEventListener("click", function () { readFields(); run(T.joinBid(app.acct, app.market)); });
    $("ofJoinAsk").addEventListener("click", function () { readFields(); run(T.joinAsk(app.acct, app.market)); });
    $("ofFlatten").addEventListener("click", function () { run(T.flatten(app.acct, app.market)); });
    $("ofReverse").addEventListener("click", function () { run(T.reverse(app.acct, app.market)); });
    $("ofResetDay").addEventListener("click", function () { T.resetDay(app.acct); say("Day reset. Trading unlocked.", "good"); ui.redraw(); });
  }

  /* Reacts to fills, stops, targets and the loss lock raised by the account. */
  function handleEvents(events) {
    events.forEach(function (ev) {
      if (ev.type === "fill") { say(describe({ fill: ev.fill }), "good"); OF.audio.play("fill"); }
      else if (ev.type === "stop") { say("Stop hit @ " + F.price(ev.fill.price, app.market.tickSize), "bad"); OF.audio.play("fill"); }
      else if (ev.type === "target") { say("Target hit @ " + F.price(ev.fill.price, app.market.tickSize), "good"); OF.audio.play("fill"); }
      else if (ev.type === "lock") { say(app.acct.lockReason + ". Position flattened, trading locked.", "bad"); OF.audio.play("lock"); ui.notice(app.acct.lockReason + ". Trading is locked until you reset the day."); }
    });
    if (events.length) ui.redraw();
  }

  function refreshExecution(m) {
    var a = app.acct;
    if (!a) return;
    handleEvents(T.mark(a, m));
    var unreal = T.unrealized(a, m), day = a.realized + unreal, ts = m.tickSize;
    var posText = a.pos ? (a.pos > 0 ? "Long " : "Short ") + Math.abs(a.pos) : "Flat";
    setText("ofPosQty", posText, a.pos > 0 ? "bull" : a.pos < 0 ? "bear" : "");
    setText("ofPosAvg", a.avg == null ? "—" : F.price(a.avg, ts));
    setText("ofPosUnreal", usd(unreal), unreal > 0 ? "bull" : unreal < 0 ? "bear" : "");
    setText("ofPosReal", usd(a.realized), a.realized > 0 ? "bull" : a.realized < 0 ? "bear" : "");
    var used = a.maxLoss > 0 ? Math.max(0, Math.min(100, -day / a.maxLoss * 100)) : 0, fill = $("ofRiskFill");
    fill.style.width = used + "%";
    fill.className = used >= 80 ? "hot" : used >= 50 ? "warn" : "";
    setText("ofRiskText", "Day P&L " + usd(day) + (a.maxLoss > 0 ? "  ·  " + Math.round(used) + "% of " + usd(a.maxLoss) + " loss limit" : "  ·  no loss limit"));
    $("ofLock").hidden = !a.locked;
    if (a.locked) setText("ofLockText", a.lockReason);
    ["ofBuyMkt", "ofSellMkt", "ofJoinBid", "ofJoinAsk", "ofReverse"].forEach(function (id) { $(id).disabled = a.locked; });
    setText("ofFootPos", posText + (a.pos ? " @ " + F.price(a.avg, ts) + "  " + usd(unreal) : "") + "  ·  Day " + usd(day));
  }

  /* ---------- Ladder: click to place limits, right-click to cancel, wheel to scroll ---------- */
  function bindLadder() {
    var c = $("ofLadder");
    c.addEventListener("click", function (e) {
      var geo = app.ladderGeom, m = app.market;
      if (!geo || !m || !app.acct) return;
      var r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, row = Math.floor((y - geo.headerH) / geo.rowH);
      if (row < 0 || row >= geo.rows) return;
      var tick = geo.topTick - row, price = A.fromTick(tick, m.tickSize), side = x < geo.wBid ? "buy" : x >= geo.xAsk && x < geo.xAsk + geo.wBid ? "sell" : null;
      if (!side) return;
      readFields();
      run(T.limitOrder(app.acct, m, side, price));
    });
    c.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (!app.acct) return;
      var n = T.cancelAll(app.acct);
      say(n ? "Cancelled " + n + " working order" + (n === 1 ? "" : "s") : "No working orders", n ? "good" : "");
      ui.redraw();
    });
    c.addEventListener("wheel", function (e) {
      e.preventDefault();
      app.ctl.ladderOffset += e.deltaY > 0 ? -2 : 2;
      ui.redraw();
    }, { passive: false });
  }

  /* ---------- Time & sales ---------- */
  function tapeRow(e, ts, dec) {
    var row = el("div", "of-trow " + e.side + (e.block ? " block" : "") + (e.sweep ? " sweep" : "") + (e.ice ? " ice" : ""));
    row.appendChild(el("span", "t", new Date(e.ts).toTimeString().slice(0, 8)));
    row.appendChild(el("span", "p", F.price(e.price, ts)));
    row.appendChild(el("span", "s", F.size(e.size, dec)));
    var tags = el("span", "of-tags");
    if (e.sweep) tags.appendChild(el("span", "of-tag sweep", "SWEEP"));
    if (e.block) tags.appendChild(el("span", "of-tag block", "BLOCK"));
    if (e.ice) tags.appendChild(el("span", "of-tag ice", "ICE"));
    row.appendChild(tags);
    return row;
  }

  function renderTape(m) {
    var box = $("ofTape");
    if (box.getClientRects().length === 0) return;
    var min = Math.max(0, Number($("ofTapeMin").value) || 0), keyOnly = $("ofTapeKey").checked;
    var sig = m.key + ":" + m.tapeSeq + ":" + min + ":" + keyOnly + ":" + m.cfg.barMs;
    if (sig === state.tapeKey) return;
    state.tapeKey = sig;
    var frag = document.createDocumentFragment(), shown = 0, rows = m.cfg.tape.rows;
    for (var i = m.tape.length - 1; i >= 0 && shown < rows; i--) {
      var e = m.tape[i], key = e.sweep || e.block || e.ice;
      if (keyOnly ? !key : (e.size < min && !key)) continue;
      frag.appendChild(tapeRow(e, m.tickSize, m.sym.sizeDec));
      shown++;
    }
    box.textContent = "";
    if (!shown) box.appendChild(el("p", "of-empty", keyOnly ? "No sweeps, blocks or iceberg hits yet." : "No prints at or above this size yet."));
    box.appendChild(frag);
  }

  /* ---------- Audio cues ---------- */
  function sound(m) {
    if (!OF.audio.isEnabled()) { state.seqSeen = m.tapeSeq - 1; state.pullCols = m.heat.cols.length ? m.heat.cols[m.heat.cols.length - 1].t : 0; return; }
    var fresh = [], i;
    for (i = m.tape.length - 1; i >= 0 && m.tape[i].seq > state.seqSeen; i--) fresh.push(m.tape[i]);
    state.seqSeen = m.tapeSeq - 1;
    var quiet = Date.now() - app.startedAt < AUDIO_QUIET_MS || fresh.length > AUDIO_BURST;
    if (!quiet) {
      if (fresh.some(function (e) { return e.ice; })) OF.audio.play("absorb");
      else if (fresh.some(function (e) { return e.sweep; })) OF.audio.play("sweep");
      else if (fresh.some(function (e) { return e.block; })) OF.audio.play("block");
    }
    var cols = m.heat.cols, last = cols[cols.length - 1], lastT = last ? last.t : 0;
    if (lastT !== state.pullCols) {
      state.pullCols = lastT;
      if (!quiet && last && last.pulls.length) OF.audio.play("pull");
    }
  }

  function bindSound() {
    $("ofSound").addEventListener("click", function () {
      var on = !OF.audio.isEnabled();
      if (on && !OF.audio.enable()) { ui.notice("Audio cues are not available in this browser."); return; }
      if (!on) OF.audio.disable();
      $("ofSound").setAttribute("aria-pressed", String(on));
      $("ofSound").textContent = "Sound: " + (on ? "on" : "off");
      if (on) OF.audio.play("block");
    });
  }

  /* ---------- Hotkeys ---------- */
  function typing(t) {
    var tag = t && t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);
  }

  function bindHotkeys() {
    document.addEventListener("keydown", function (e) {
      if (!ui.visible() || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || !app.acct) return;
      if (e.repeat) { if (e.code === "KeyB" || e.code === "KeyS" || e.code === "KeyX" || e.key === "Escape") e.preventDefault(); return; }
      var handled = true;
      if (e.shiftKey && e.code === "KeyB") run(T.marketOrder(app.acct, app.market, "buy", app.acct.qty, "hotkey buy ask"));
      else if (e.shiftKey && e.code === "KeyS") run(T.marketOrder(app.acct, app.market, "sell", app.acct.qty, "hotkey sell bid"));
      else if (e.shiftKey && e.code === "KeyF") toggleFullscreen();
      else if ((e.shiftKey && e.code === "KeyX") || e.key === "Escape") run(T.flatten(app.acct, app.market, "hotkey flatten"), true);
      else if (e.code === "Space" && !e.shiftKey && !(e.target && /^(BUTTON|A)$/.test(e.target.tagName))) { app.ctl.ladderOffset = 0; ui.redraw(); }
      else handled = false;
      if (handled) e.preventDefault();
    });
    /* A focused button would otherwise "click" on Space release after we used it to recenter. */
    document.addEventListener("keyup", function (e) {
      if (ui.visible() && e.code === "Space" && !typing(e.target) && !(e.target && /^(BUTTON|A)$/.test(e.target.tagName))) e.preventDefault();
    });
  }

  /* ---------- Toolbar toggles ---------- */
  function bindToggles() {
    document.querySelectorAll("[data-of-ws]").forEach(function (b) { b.addEventListener("click", function () { setWorkspace(b.getAttribute("data-of-ws")); }); });
    $("ofFpMode").addEventListener("change", function (e) { app.ctl.fpMode = e.target.value; ui.redraw(); });
    $("ofShowSessions").addEventListener("change", function (e) { app.ctl.showSessions = e.target.checked; ui.redraw(); });
    $("ofShowIB").addEventListener("change", function (e) { app.ctl.showIB = e.target.checked; ui.redraw(); });
    $("ofFullscreen").addEventListener("click", toggleFullscreen);
    ["ofTapeMin", "ofTapeKey"].forEach(function (id) { $(id).addEventListener("input", function () { state.tapeKey = ""; }); });
  }

  /* ---------- Hooks into the core loop ---------- */
  ui.hooks.start.push(function (m) {
    state.tapeKey = "";
    state.seqSeen = -1;
    state.pullCols = 0;
    fillFields(m);
  });

  ui.hooks.trade.push(function (e, m) {
    if (m !== app.market || !app.acct) return;
    handleEvents(T.onTrade(app.acct, m, e));
  });

  ui.hooks.refresh.push(function (m) {
    if (m !== app.market) return;
    renderTape(m);
    refreshExecution(m);
    sound(m);
    var sec = Math.floor(Date.now() / CLOCK_MS);
    if (sec !== state.clockSec) {
      state.clockSec = sec;
      $("ofFootClock").textContent = "ET " + new Date().toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
    }
  });

  function init() {
    var saved = load();
    bindToggles();
    bindSplitters();
    bindExecution();
    bindLadder();
    bindSound();
    bindHotkeys();
    if (saved.l) setColumn("l", saved.l);
    if (saved.r) setColumn("r", saved.r);
    setWorkspace(saved.ws);
    /* Leaving the view while maximised must not leave the page locked. */
    setInterval(function () {
      if (root.classList.contains("of-max") && !ui.visible()) {
        if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
        state.nativeFs = false;
        setMax(false);
      }
    }, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
