/* Order-flow view controller: wires controls, feeds, the render loop and the calendar banner.
 * Rendering is decoupled from data: feeds mutate state at any rate, a requestAnimationFrame loop
 * redraws (throttled) only when state changed, and text widgets refresh on a slower timer. */
(function (g) {
  "use strict";
  var OF = g.OF;
  if (!OF || typeof document === "undefined") return;
  var cfg = OF.config, E = OF.engine, R = OF.render, F = OF.fmt, root = document.getElementById("ofRoot");
  if (!root) return;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  var MIN_REDRAW_MS = 100, NOTICE_MS = 9000, RATE_WINDOW_MS = 1000;
  var app = {
    mode: cfg.defaultMode, symbol: cfg.defaultSymbol, speed: cfg.replay.speed, paused: false,
    market: null, feed: null, view: null, drawnRev: -1, dirty: true, lastDraw: 0,
    msgs: 0, lastMsgs: 0, rate: 0, latency: null, errors: 0, noticeTimer: null, lastAlertKey: "", lastStatsRev: -1,
    ctl: { visibleBars: cfg.visibleBars, hoverX: null, hoverY: null, hoverCanvas: null, profileMode: "volume", tpoPeriod: cfg.replay.tpoPeriodBars }
  };
  OF.ui = { app: app };

  /* ---------- Notices and status ---------- */
  function notice(text) {
    var n = $("ofNotice");
    n.textContent = text;
    clearTimeout(app.noticeTimer);
    app.noticeTimer = setTimeout(function () { n.textContent = ""; }, NOTICE_MS);
  }
  function setStatus(state, text) {
    $("ofStatusDot").className = "of-dot " + state;
    $("ofStatusText").textContent = text;
  }

  /* ---------- Feed lifecycle ---------- */
  function guard(fn) {
    return function (payload) {
      app.msgs++;
      try { fn(payload); } catch (e) { app.errors++; notice("Could not process a market data message: " + e.message); }
    };
  }

  function wire(feed, m) {
    feed.on("trade", guard(function (e) { E.applyTrade(m, e); }));
    feed.on("book", guard(function (e) { E.applyBook(m, e.bids, e.asks); }));
    feed.on("delta", guard(function (e) { E.applyBookDelta(m, e.side, e.price, e.size); }));
    feed.on("quote", guard(function (e) { E.applyQuote(m, e); }));
    feed.on("levels", guard(function (e) { E.setLevels(m, e); }));
    feed.on("status", function (s) { setStatus(s.state, s.text); });
    feed.on("notice", notice);
    feed.on("latency", function (ms) { app.latency = ms; });
  }

  function stopFeed() { if (app.feed) { app.feed.stop(); app.feed = null; } }

  function start() {
    stopFeed();
    app.market = E.create(app.symbol, cfg);
    app.latency = null;
    app.view = null;
    app.dirty = true;
    var feed;
    if (app.mode === "replay") {
      app.ctl.tpoPeriod = cfg.replay.tpoPeriodBars;
      feed = new OF.feeds.SimulatedFeed({ config: cfg, speed: app.speed, seed: cfg.replay.seed });
      feed.setPaused(app.paused);
    } else {
      var provider = OF.feeds.providers[cfg.live.provider];
      app.ctl.tpoPeriod = cfg.live.tpoPeriodBars;
      if (!provider || !provider.supports(app.symbol)) {
        setStatus("error", provider && provider.unsupported ? provider.unsupported : "No " + (provider ? provider.label : cfg.live.provider) + " feed for " + app.symbol);
        notice("Pick a supported symbol (e.g. BTCUSDT) or configure a relay provider to stream " + app.symbol + ".");
        return;
      }
      feed = new OF.feeds.WebSocketFeed({ config: cfg, provider: provider });
    }
    wire(feed, app.market);
    app.feed = feed;
    feed.start(app.symbol);
    syncControls();
  }

  function syncControls() {
    var replay = app.mode === "replay";
    document.querySelectorAll("[data-of-mode]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-of-mode") === app.mode); });
    $("ofSpeed").disabled = !replay;
    $("ofPause").disabled = !replay;
    $("ofPause").textContent = app.paused ? "Resume" : "Pause";
    $("ofProviderWrap").hidden = replay;
    $("ofUrlWrap").hidden = replay || cfg.live.provider !== "relay";
  }

  /* ---------- Controls ---------- */
  function buildControls() {
    var sel = $("ofSymbol");
    Object.keys(cfg.symbols).forEach(function (k) { var o = el("option", "", k + " — " + cfg.symbols[k].name); o.value = k; sel.appendChild(o); });
    sel.value = app.symbol;
    var spd = $("ofSpeed");
    cfg.replay.speeds.forEach(function (s) { var o = el("option", "", s + "x"); o.value = s; spd.appendChild(o); });
    spd.value = app.speed;
    var prov = $("ofProvider");
    Object.keys(OF.feeds.providers).forEach(function (k) { var o = el("option", "", OF.feeds.providers[k].label); o.value = k; prov.appendChild(o); });
    prov.value = cfg.live.provider;
    $("ofUrl").value = cfg.live.url;
  }

  function bindControls() {
    document.querySelectorAll("[data-of-mode]").forEach(function (b) {
      b.addEventListener("click", function () { app.mode = b.getAttribute("data-of-mode"); start(); syncControls(); });
    });
    $("ofSymbol").addEventListener("change", function (e) { app.symbol = e.target.value; start(); });
    $("ofSpeed").addEventListener("change", function (e) { app.speed = Number(e.target.value); if (app.feed && app.feed.setSpeed) app.feed.setSpeed(app.speed); });
    $("ofPause").addEventListener("click", function () { app.paused = !app.paused; if (app.feed && app.feed.setPaused) app.feed.setPaused(app.paused); syncControls(); });
    $("ofRestart").addEventListener("click", function () { start(); });
    $("ofProvider").addEventListener("change", function (e) { cfg.live.provider = e.target.value; syncControls(); start(); });
    $("ofUrl").addEventListener("change", function (e) {
      var v = e.target.value.trim();
      if (v && !/^wss?:\/\//i.test(v)) { notice("Relay URL must start with ws:// or wss://"); return; }
      cfg.live.url = v;
      start();
    });
    $("ofClearAnchors").addEventListener("click", function () { if (app.market) { E.clearAnchors(app.market); app.dirty = true; } });
    $("ofZoomIn").addEventListener("click", function () { zoom(-2); });
    $("ofZoomOut").addEventListener("click", function () { zoom(2); });
    document.querySelectorAll("[data-of-prof]").forEach(function (b) {
      b.addEventListener("click", function () {
        app.ctl.profileMode = b.getAttribute("data-of-prof");
        document.querySelectorAll("[data-of-prof]").forEach(function (x) { x.classList.toggle("active", x === b); });
        app.dirty = true;
      });
    });
  }

  function zoom(delta) {
    app.ctl.visibleBars = Math.max(cfg.minVisibleBars, Math.min(cfg.maxVisibleBars, app.ctl.visibleBars + delta));
    app.dirty = true;
  }

  function bindCanvas() {
    var main = $("ofMain"), cvd = $("ofCvd");
    function track(canvas, name) {
      canvas.addEventListener("mousemove", function (e) {
        var r = canvas.getBoundingClientRect();
        app.ctl.hoverX = e.clientX - r.left; app.ctl.hoverY = e.clientY - r.top; app.ctl.hoverCanvas = name; app.dirty = true;
      });
      canvas.addEventListener("mouseleave", function () { app.ctl.hoverX = app.ctl.hoverY = app.ctl.hoverCanvas = null; app.dirty = true; });
    }
    track(main, "main");
    track(cvd, "cvd");
    [main, cvd].forEach(function (c) {
      c.addEventListener("wheel", function (e) { e.preventDefault(); zoom(e.deltaY > 0 ? 1 : -1); }, { passive: false });
    });
    main.addEventListener("click", function (e) {
      var v = app.view, m = app.market;
      if (!v || !m) return;
      var r = main.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, i = R.hoverBarIndex(v, x);
      if (i < 0) return;
      var bar = v.bars[i], u = R.uAtY(v, y), edge = Math.abs(u - bar.h) <= Math.abs(u - bar.l) ? "H" : "L";
      if (E.addAnchor(m, v.startIdx + i, edge)) {
        E.pushAlert(m, "info", "Anchored VWAP at the " + (edge === "H" ? "high" : "low") + " of the " + F.time(bar.t) + " bar");
        app.dirty = true;
      }
    });
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { app.dirty = true; });
      ["ofLadder", "ofMain", "ofCvd", "ofProfile"].forEach(function (id) { ro.observe($(id)); });
    }
  }

  /* ---------- Render loop ---------- */
  function visible() { return root.offsetParent !== null; }

  function safeDraw(name, fn) {
    try { return fn(); } catch (e) { app.errors++; notice("Could not draw " + name + ": " + e.message); return null; }
  }

  function draw() {
    var m = app.market;
    if (!m) return;
    safeDraw("depth of market", function () { R.drawLadder($("ofLadder"), m, app.ctl); });
    app.view = safeDraw("footprint chart", function () { return R.drawMain($("ofMain"), m, app.ctl); });
    safeDraw("CVD", function () { R.drawCVD($("ofCvd"), m, app.ctl); });
    safeDraw("volume profile", function () { R.drawProfilePanel($("ofProfile"), m, app.ctl); });
    app.drawnRev = m.rev;
    app.dirty = false;
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!visible() || !app.market) return;
    var changed = app.dirty || app.market.rev !== app.drawnRev, since = ts - app.lastDraw;
    if (since < 1000 / cfg.maxFps || (!changed && since < MIN_REDRAW_MS)) return;
    app.lastDraw = ts;
    draw();
  }

  /* ---------- Text widgets ---------- */
  function setText(id, text, cls) { var n = $(id); if (n.textContent !== text) n.textContent = text; if (cls != null) n.className = cls; }

  function refreshQuote() {
    var m = app.market;
    if (!m || !visible()) return;
    var ts = m.tickSize, dec = m.sym.sizeDec, l1 = m.l1;
    setText("ofLast", F.price(l1.last, ts), "of-val " + (m.lastSide === "sell" ? "bear" : m.lastSide === "buy" ? "bull" : ""));
    setText("ofBid", l1.bid == null ? "—" : F.price(l1.bid, ts) + " x " + F.size(l1.bidSize, dec));
    setText("ofAsk", l1.ask == null ? "—" : F.price(l1.ask, ts) + " x " + F.size(l1.askSize, dec));
    setText("ofSpread", l1.bid != null && l1.ask != null ? F.price(l1.ask - l1.bid, ts) + " (" + Math.round((l1.ask - l1.bid) / ts) + "t)" : "—");
    setText("ofVol", F.size(l1.volume, dec));
    setText("ofDelta", F.signed(m.delta, dec), "of-val " + (m.delta >= 0 ? "bull" : "bear"));
    var vw = m.vwap.value();
    setText("ofVwap", vw == null ? "—" : F.price(vw, ts) + " ±" + F.price(m.vwap.sd(), ts));
    setText("ofRate", app.rate + " msg/s");
    setText("ofLatency", app.mode === "replay" ? "simulated" : app.latency == null ? "—" : Math.round(app.latency) + " ms");

    if (m.rev !== app.lastStatsRev) {
      app.lastStatsRev = m.rev;
      var vp = R.stats(m, app.ctl).vp, box = $("ofStats");
      box.textContent = "";
      var rows = vp ? [
        ["POC", F.price(vp.poc * ts, ts)], ["VAH", F.price(vp.vah * ts, ts)], ["VAL", F.price(vp.val * ts, ts)],
        ["Value area", Math.round(vp.vaVolume / vp.total * 100) + "% of volume"],
        ["HVN", vp.hvn.length ? vp.hvn.slice(-4).map(function (t) { return F.price(t * ts, ts); }).join("  ") : "none"],
        ["LVN", vp.lvn.length ? vp.lvn.slice(-4).map(function (t) { return F.price(t * ts, ts); }).join("  ") : "none"]
      ] : [["Profile", "waiting for trades"]];
      rows.forEach(function (r) { var row = el("div", "of-stat"); row.appendChild(el("span", "", r[0])); row.appendChild(el("b", "mono", r[1])); box.appendChild(row); });
    }

    var top = m.alerts[0], key = m.alerts.length + ":" + (top ? top.ts + top.text : "");
    if (key !== app.lastAlertKey) {
      app.lastAlertKey = key;
      var list = $("ofAlerts");
      list.textContent = "";
      if (!m.alerts.length) list.appendChild(el("p", "of-empty", "No alerts yet. Walls, icebergs and divergences appear here."));
      m.alerts.slice(0, 8).forEach(function (a) {
        var row = el("div", "of-alert " + a.level);
        row.appendChild(el("span", "mono", F.time(a.ts)));
        row.appendChild(el("span", "", a.text));
        list.appendChild(row);
      });
    }
  }

  function refreshCalendar() {
    var now = Date.now(), list = OF.calendar.upcoming(OF.calendar.events(now), now, 4);
    var nextBox = $("ofCalNext"), alertBox = $("ofCalAlert"), chips = $("ofCalChips");
    if (!list.length) { nextBox.textContent = "No scheduled events loaded"; alertBox.hidden = true; chips.textContent = ""; return; }
    var first = list[0], ms = first.ts - now, sev = OF.calendar.severity(ms);
    nextBox.className = "of-cal-next " + sev;
    nextBox.textContent = "";
    nextBox.appendChild(el("b", "", first.name + (first.approx ? " (~)" : "")));
    nextBox.appendChild(el("span", "mono", (ms < 0 ? "released " : "in ") + OF.calendar.formatCountdown(ms)));
    var msgs = {
      imminent: "High-impact release in under 15 minutes. Expect a volatility spike: widen stops, cut size, avoid resting orders into the print.",
      soon: "High-impact release within the hour. Liquidity usually thins and spreads widen ahead of the number.",
      released: "Release just crossed the tape. Volatility is typically elevated for the next several minutes."
    };
    alertBox.hidden = !(first.impact === "high" && msgs[sev]);
    alertBox.className = "of-cal-alert " + sev;
    alertBox.textContent = msgs[sev] || "";
    chips.textContent = "";
    list.slice(1).forEach(function (e) {
      chips.appendChild(el("span", "of-chip", e.name + " · " + new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
    });
  }

  /* ---------- URL parameters (?feed=live&symbol=BTCUSDT&provider=relay&url=wss://...) ---------- */
  function readParams() {
    var q;
    try { q = new URLSearchParams(g.location.search); } catch (e) { return; }
    var mode = q.get("feed"), sym = (q.get("symbol") || "").toUpperCase(), prov = q.get("provider"), url = q.get("url");
    if (mode === "live" || mode === "replay") app.mode = mode;
    if (cfg.symbols[sym]) app.symbol = sym;
    if (prov && OF.feeds.providers[prov]) cfg.live.provider = prov;
    if (url && /^wss?:\/\//i.test(url)) cfg.live.url = url;
  }

  function init() {
    readParams();
    buildControls();
    bindControls();
    bindCanvas();
    syncControls();
    start();
    setInterval(function () { app.rate = Math.round((app.msgs - app.lastMsgs) * 1000 / RATE_WINDOW_MS); app.lastMsgs = app.msgs; }, RATE_WINDOW_MS);
    setInterval(refreshQuote, cfg.uiRefreshMs);
    setInterval(refreshCalendar, 1000);
    refreshCalendar();
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
