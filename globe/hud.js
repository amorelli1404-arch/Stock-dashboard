/* Command-center HUD for the 3D event globe: live intelligence feed, event dossier, timeline playback,
 * command palette and layer controls. All feed text is written with textContent (never innerHTML). */
(function (g) {
  "use strict";
  var GX = g.GX;
  if (!GX || !GX.scene || typeof document === "undefined") return;
  var scene = GX.scene;

  var USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson";
  var EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=30&limit=400";
  var DAY = 86400000, REFRESH_FEED_MS = 5 * 60000, LIST_MAX = 60, PALETTE_MAX = 10, PLAY_SPAN_S = 240, UI_TICK_MS = 250, LIST_TICK_MS = 1000;
  var WINDOWS = [{ id: "24h", label: "24H", ms: DAY }, { id: "7d", label: "7D", ms: 7 * DAY }, { id: "30d", label: "30D", ms: 30 * DAY }];
  var SPEEDS = [1, 5, 20];

  var H = {
    stage: null, inView: true, booted: false, booting: false, events: [], win: { start: 0, end: 0, id: "24h" }, T: 0, live: true, playing: false, speed: 1,
    q: "", minRank: 1, selected: null, last: 0, lastUi: 0, lastList: 0, listSig: "", scrubbing: false, ui: {}, palette: { open: false, items: [], idx: 0 }, feedStatus: {}
  };

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(cls, text, title) { var b = el("button", cls, text); b.type = "button"; if (title) { b.title = title; b.setAttribute("aria-label", title); } return b; }
  function pad(n) { return String(n).padStart(2, "0"); }
  function utc(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " UTC"; }
  function typing(t) { var tag = t && t.tagName; return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable); }
  /* On screen means laid out, the tab is visible and enough of the globe is in the viewport. */
  function visible() { return !!H.stage && H.stage.getClientRects().length > 0 && !document.hidden && H.inView; }
  function modalOpen() { var m = document.getElementById("modalBackdrop"); return !!m && m.classList.contains("open"); }

  /* ---------- Data ---------- */
  function storyEvents(now) {
    var ref = g.IW_MAP_PINS;
    if (!ref || !ref.pins) return [];
    return ref.pins.map(function (p, i) {
      var title = ref.storyTitle ? ref.storyTitle(p.storyIds[0]) : null;
      return { id: "story-" + p.id, layer: "macro", cat: "macro", kind: "story", title: p.loc + (title ? ": " + title : ""), lat: p.lat, lon: p.lon, t: now - (i + 1) * 47 * 60000,
        sev: /hormuz|tehran/i.test(p.loc) ? "high" : /washington|beijing/i.test(p.loc) ? "elevated" : "info", desc: p.desc, source: "Story feed", radiusKm: 150, storyId: p.storyIds[0] };
    });
  }

  function calendarEvents(now) {
    var OF = g.OF;
    if (!OF || !OF.calendar) return [];
    return OF.calendar.events(now).filter(function (e) { return e.impact === "high" && e.ts <= now && e.ts > now - 30 * DAY; }).map(function (e) {
      return { id: "cal-" + e.id, layer: "macro", cat: "macro", kind: "cbank", title: e.name + (e.approx ? " (approx. date)" : ""), lat: 38.8929, lon: -77.0459, t: e.ts,
        sev: /fomc/i.test(e.name) ? "high" : "elevated", desc: "Scheduled US macro release.", source: "Economic calendar", radiusKm: 120 };
    });
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  function loadFeeds() {
    var now = Date.now(), parts = H.parts || (H.parts = { quakes: [], eonet: [] });
    /* A failed or malformed refresh keeps that source's previous events instead of wiping them. */
    function job(url, key, name, normalize) {
      return fetchJson(url).then(function (j) { parts[key] = normalize(j); H.feedStatus[name] = "ok"; }).catch(function (e) { H.feedStatus[name] = "failed (" + e.message + ")"; });
    }
    return Promise.all([job(USGS_URL, "quakes", "usgs", GX.normalizeUsgs), job(EONET_URL, "eonet", "eonet", GX.normalizeEonet)]).then(function () {
      H.events = [].concat(parts.quakes, parts.eonet, storyEvents(now), calendarEvents(now));
      scene.setEvents(H.events);
      H.listSig = "";
      renderStatus();
    });
  }

  /* ---------- Filtering and time ---------- */
  function passes(ev) {
    if (ev.t < H.win.start) return false;
    if (GX.SEV[ev.sev].rank < H.minRank) return false;
    return !H.q || (ev.title + " " + (ev.desc || "")).toLowerCase().indexOf(H.q) >= 0;
  }

  function visibleEvents() {
    return H.events.filter(function (ev) { return scene.isLayerOn(ev.layer) && ev.t <= H.T && passes(ev); }).sort(function (a, b) { return b.t - a.t; });
  }

  function setWindow(id) {
    var w = WINDOWS.filter(function (x) { return x.id === id; })[0] || WINDOWS[0], now = Date.now();
    H.win = { id: w.id, start: now - w.ms, end: now };
    H.live = true; H.playing = false; H.T = now;
    syncTimeline(true);
    scene.setPredicate(passes);
    H.listSig = "";
  }

  function setReplayFrom(dateStr) {
    var t = Date.parse(dateStr + "T00:00:00Z"), now = Date.now();
    if (!isFinite(t) || t > now) return;
    H.win = { id: "replay", start: t, end: Math.min(t + 7 * DAY, now) };
    H.live = false; H.playing = true; H.T = t;
    scene.setPredicate(passes);
    syncTimeline(true);
  }

  function setT(ms) {
    H.T = Math.max(H.win.start, Math.min(ms, H.win.end));
    scene.setTime(H.T);
  }

  function tick() {
    var now = performance.now(), dt = Math.min(0.25, (now - H.last) / 1000);
    H.last = now;
    if (!H.booted) return;
    if (H.live) { H.win.end = Date.now(); setT(H.win.end); }
    else if (H.playing) {
      var span = H.win.end - H.win.start, next = H.T + dt * H.speed * span / PLAY_SPAN_S;
      if (next >= H.win.end) { next = H.win.end; H.playing = false; syncPlay(); }
      setT(next);
    }
    if (now - H.lastUi >= UI_TICK_MS) { H.lastUi = now; scene.refresh(); syncTimeline(false); renderStatus(); }
    if (now - H.lastList >= LIST_TICK_MS) { H.lastList = now; renderFeed(); }
  }

  /* ---------- Selection and camera ---------- */
  function exchangeEvent(ex) {
    var st = GX.marketStatus(ex, H.T);
    return { id: "ex-" + ex.id, kind: "exchange", layer: "markets", title: ex.name + " (" + ex.city + ")", lat: ex.lat, lon: ex.lon, t: H.T, sev: st.state === "open" ? "info" : "elevated",
      desc: "Session " + st.state.toUpperCase() + ", local time " + st.local + ". Weekends are modelled; exchange holidays are not.", source: "Local exchange clock", radiusKm: 0 };
  }

  function refToEvent(ref) {
    if (ref.type === "event") return ref.item;
    if (ref.type === "exchange") return exchangeEvent(ref.item);
    if (ref.type === "chokepoint") return { id: "cp-" + ref.item.id, kind: "chokepoint", layer: "supply", title: ref.item.name, lat: ref.item.lat, lon: ref.item.lon, t: H.T, sev: "elevated", desc: ref.item.note, source: "Reference", radiusKm: 60 };
    if (ref.type === "bank") return { id: "cb-" + ref.item.id, kind: "bank", layer: "macro", title: ref.item.name, lat: ref.item.lat, lon: ref.item.lon, t: H.T, sev: "info", desc: ref.item.note, source: "Reference", radiusKm: 0 };
    return null;
  }

  function selectEvent(ev, fly) {
    H.selected = ev;
    scene.select(ev && ev.radiusKm ? ev : null);
    renderDossier();
    H.listSig = "";
    if (ev && fly) scene.flyTo(ev.lat, ev.lon, { range: rangeFor(ev), orbit: true });
  }

  function rangeFor(ev) { return Math.max(60000, Math.min(1500000, (ev.radiusKm || 30) * 1000 * 3)); }

  /* ---------- Rendering helpers ---------- */
  function badge(sev) {
    var b = el("span", "gx-badge", GX.SEV[sev].label.toUpperCase());
    b.style.setProperty("--c", GX.SEV[sev].color);
    return b;
  }

  function renderFeed() {
    if (!H.ui.list || !visible()) return;
    var list = visibleEvents(), sig = list.length + ":" + (list[0] ? list[0].id : "") + ":" + H.q + ":" + H.minRank + ":" + (H.selected ? H.selected.id : "") + ":" + Math.floor(Date.now() / 30000);
    H.ui.count.textContent = list.length + " events";
    if (sig === H.listSig) return;
    H.listSig = sig;
    var now = Date.now(), frag = document.createDocumentFragment();
    list.slice(0, LIST_MAX).forEach(function (ev) {
      var row = el("div", "gx-item" + (H.selected && H.selected.id === ev.id ? " active" : ""));
      var top = el("div", "gx-item-top");
      top.appendChild(badge(ev.sev));
      top.appendChild(el("span", "gx-item-ago", GX.timeAgo(ev.t, Math.max(now, H.T))));
      row.appendChild(top);
      row.appendChild(el("div", "gx-item-title", ev.title));
      var meta = el("div", "gx-item-meta");
      meta.appendChild(el("span", "gx-mono", GX.fmtLat(ev.lat) + " " + GX.fmtLon(ev.lon)));
      var fly = btn("gx-btn gx-btn-sm", "Fly to", "Fly to " + ev.title);
      fly.addEventListener("click", function (e) { e.stopPropagation(); selectEvent(ev, true); });
      meta.appendChild(fly);
      row.appendChild(meta);
      row.addEventListener("click", function () { selectEvent(ev, false); scene.flyTo(ev.lat, ev.lon, { range: rangeFor(ev) * 2, orbit: false, duration: 1.8 }); });
      frag.appendChild(row);
    });
    H.ui.list.textContent = "";
    if (!list.length) H.ui.list.appendChild(el("p", "gx-empty", "No events match the current time, layers and filters."));
    H.ui.list.appendChild(frag);
  }

  function renderStatus() {
    if (!H.ui.clockUtc) return;
    var now = Date.now();
    H.ui.clockUtc.textContent = utc(H.T || now);
    H.ui.clockLocal.textContent = "LOCAL " + new Date(now).toLocaleTimeString("en-GB", { hour12: false });
    H.ui.fps.textContent = scene.fps() + " FPS";
    H.ui.stats.textContent = scene.visibleCount() + " ON MAP";
    var cam = scene.cameraInfo();
    if (cam) H.ui.cam.textContent = "ALT " + (cam.alt > 1e5 ? Math.round(cam.alt / 1000).toLocaleString("en-US") + " km" : Math.round(cam.alt).toLocaleString("en-US") + " m") + "  TILT " + Math.round(90 + cam.pitch) + "°";
    GX.EXCHANGES.forEach(function (ex) {
      var chip = H.ui.chips[ex.id], st = GX.marketStatus(ex, H.T || now);
      chip.dot.className = "gx-dot " + st.state;
      chip.time.textContent = st.local;
    });
    var f = H.feedStatus;
    H.ui.feed.textContent = f.usgs ? "USGS " + f.usgs.split(" ")[0] + " · EONET " + (f.eonet || "").split(" ")[0] : "";
  }

  function syncPlay() { if (H.ui.play) H.ui.play.textContent = H.playing ? "Pause" : "Play"; }

  function syncTimeline(force) {
    if (!H.ui.scrub) return;
    if (!H.scrubbing) { var span = H.win.end - H.win.start; H.ui.scrub.value = span > 0 ? Math.round((H.T - H.win.start) / span * 1000) : 1000; }
    H.ui.liveBtn.classList.toggle("active", H.live);
    H.ui.winBtns.forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-win") === H.win.id); });
    H.ui.speedBtns.forEach(function (b) { b.classList.toggle("active", Number(b.getAttribute("data-speed")) === H.speed); });
    H.ui.tlabel.textContent = H.live ? "LIVE" : utc(H.T);
    syncPlay();
    if (force) H.listSig = "";
  }

  function row(k, v, mono) { var r = el("div", "gx-kv"); r.appendChild(el("span", "", k)); r.appendChild(el("b", mono ? "gx-mono" : "", v)); return r; }

  function renderDossier() {
    var d = H.ui.dossier, ev = H.selected;
    d.classList.toggle("open", !!ev);
    if (!ev) return;
    var body = H.ui.dbody;
    body.textContent = "";
    var head = el("div", "gx-dhead");
    head.appendChild(badge(ev.sev));
    head.appendChild(el("span", "gx-dkind", (ev.kind || "").toUpperCase()));
    body.appendChild(head);
    body.appendChild(el("h3", "gx-dtitle", ev.title));
    var grid = el("div", "gx-kvs");
    grid.appendChild(row("TIME", utc(ev.t), true));
    grid.appendChild(row("LAT", GX.fmtLat(ev.lat), true));
    grid.appendChild(row("LON", GX.fmtLon(ev.lon), true));
    var elev = row("ELEV", "sampling…", true);
    grid.appendChild(elev);
    if (ev.mag != null) grid.appendChild(row("MAGNITUDE", "M " + ev.mag.toFixed(1), true));
    if (ev.depthKm != null) grid.appendChild(row("DEPTH", ev.depthKm.toFixed(1) + " km", true));
    if (ev.wind) grid.appendChild(row("MAX WIND", ev.wind + " kt", true));
    if (ev.radiusKm) grid.appendChild(row("IMPACT RADIUS", Math.round(ev.radiusKm) + " km (indicative)", true));
    body.appendChild(grid);
    scene.sampleElevation(ev.lat, ev.lon).then(function (m) { if (H.selected === ev) elev.lastChild.textContent = m == null ? "n/a (flat imagery)" : Math.round(m).toLocaleString("en-US") + " m"; });

    body.appendChild(el("h4", "gx-dh", "Headlines"));
    var hl = el("ul", "gx-hl");
    hl.appendChild(el("li", "", ev.title));
    if (ev.desc) hl.appendChild(el("li", "", ev.desc));
    body.appendChild(hl);
    if (ev.url && /^https?:\/\//i.test(ev.url)) {
      var a = el("a", "gx-link", "Source: " + ev.source + " ↗");
      a.href = ev.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      body.appendChild(a);
    } else body.appendChild(el("p", "gx-src", "Source: " + ev.source));

    body.appendChild(el("h4", "gx-dh", "Market sensitivity"));
    var tags = el("div", "gx-tags");
    GX.sensitivity(ev).forEach(function (t) { tags.appendChild(el("span", "gx-tag", t)); });
    body.appendChild(tags);
    body.appendChild(el("p", "gx-note", "Tags are rule-based associations by region and headline keywords, not a forecast."));

    var acts = el("div", "gx-acts");
    var fly = btn("gx-btn", "Fly to", "Fly to event"), orb = btn("gx-btn", "Orbit", "Orbit around the event");
    fly.addEventListener("click", function () { scene.flyTo(ev.lat, ev.lon, { range: rangeFor(ev), orbit: false }); });
    orb.addEventListener("click", function () { scene.flyTo(ev.lat, ev.lon, { range: rangeFor(ev), orbit: true }); });
    acts.appendChild(fly); acts.appendChild(orb);
    if (ev.storyId != null) {
      var jump = btn("gx-btn", "Open story", "Open the story in the feed");
      jump.addEventListener("click", function () { var a2 = document.querySelector('.mt-link[data-jump="' + ev.storyId + '"]'); if (a2) a2.click(); else document.querySelector('.nav-item[data-view="feed"]').click(); });
      acts.appendChild(jump);
    }
    body.appendChild(acts);
  }

  /* ---------- Command palette ---------- */
  function paletteItems(q) {
    var s = q.trim().toLowerCase(), out = [], coords = GX.parseCoords(q);
    if (coords) out.push({ label: "Go to " + GX.fmtLat(coords.lat) + " " + GX.fmtLon(coords.lon), tag: "COORDS", run: function () { scene.flyTo(coords.lat, coords.lon, { range: 800000 }); } });
    if (!s) return out.concat(GX.EXCHANGES.slice(0, 4).map(placeItem("EXCHANGE", function (x) { return x.name; })));
    function add(list, tag, nameFn, runFn) {
      list.forEach(function (x) {
        var n = nameFn(x), i = n.toLowerCase().indexOf(s);
        if (i >= 0) out.push({ label: n, tag: tag, score: i, run: function () { runFn(x); } });
      });
    }
    add(GX.CITIES, "CITY", function (c) { return c.name; }, function (c) { scene.flyTo(c.lat, c.lon, { range: 120000 }); });
    add(GX.EXCHANGES, "EXCHANGE", function (x) { return x.name + " (" + x.city + ")"; }, function (x) { selectEvent(exchangeEvent(x), true); });
    add(GX.CHOKEPOINTS, "CHOKEPOINT", function (x) { return x.name; }, function (x) { selectEvent(refToEvent({ type: "chokepoint", item: x }), true); });
    add(GX.CENTRAL_BANKS, "CENTRAL BANK", function (x) { return x.name; }, function (x) { selectEvent(refToEvent({ type: "bank", item: x }), true); });
    add(visibleEvents().slice(0, 400), "EVENT", function (e) { return e.title; }, function (e) { selectEvent(e, true); });
    return out.sort(function (a, b) { return (a.score || 0) - (b.score || 0); });
  }

  function placeItem(tag, nameFn) { return function (x) { return { label: nameFn(x), tag: tag, run: function () { selectEvent(exchangeEvent(x), true); } }; }; }

  function renderPalette() {
    var p = H.palette, box = H.ui.pitems;
    box.textContent = "";
    p.items = paletteItems(H.ui.pinput.value).slice(0, PALETTE_MAX);
    p.idx = Math.min(p.idx, Math.max(0, p.items.length - 1));
    if (!p.items.length) box.appendChild(el("p", "gx-empty", "No matches. Try a city, exchange, event or coordinates like 35.68, 139.77."));
    p.items.forEach(function (it, i) {
      var r = el("div", "gx-pitem" + (i === p.idx ? " active" : ""));
      r.appendChild(el("span", "gx-ptag", it.tag));
      r.appendChild(el("span", "", it.label));
      r.addEventListener("click", function () { runPalette(i); });
      box.appendChild(r);
    });
  }

  function openPalette() { H.palette.open = true; H.palette.idx = 0; H.ui.palette.classList.add("open"); H.ui.pinput.value = ""; renderPalette(); H.ui.pinput.focus(); }
  function closePalette() { H.palette.open = false; H.ui.palette.classList.remove("open"); }
  function runPalette(i) { var it = H.palette.items[i]; if (!it) return; closePalette(); it.run(); }

  /* ---------- Layout ---------- */
  function panel(cls) { return el("div", "gx-panel gx-hud " + cls); }

  function buildBar() {
    var bar = panel("gx-bar"), seg = el("div", "gx-seg");
    H.ui.baseBtns = [];
    Object.keys(GX.BASEMAPS).forEach(function (id) {
      var b = btn("", GX.BASEMAPS[id].label, "Basemap: " + GX.BASEMAPS[id].label);
      b.addEventListener("click", function () { applyBasemap(id); });
      b.setAttribute("data-base", id);
      seg.appendChild(b); H.ui.baseBtns.push(b);
    });
    bar.appendChild(seg);
    var lb = btn("gx-btn", "Layers", "Toggle layers");
    bar.appendChild(lb);
    var pop = el("div", "gx-pop");
    GX.LAYERS.forEach(function (l) {
      var lab = el("label", "gx-check"), cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = scene.isLayerOn(l.id);
      cb.addEventListener("change", function () { scene.setLayer(l.id, cb.checked); H.listSig = ""; });
      var dot = el("span", "gx-ldot"); dot.style.background = l.color;
      lab.appendChild(cb); lab.appendChild(dot); lab.appendChild(document.createTextNode(l.label));
      pop.appendChild(lab);
    });
    var keyRow = el("div", "gx-keyrow"), key = document.createElement("input"), save = btn("gx-btn gx-btn-sm", "Save key");
    key.type = "password"; key.placeholder = "Google Map Tiles API key (optional)"; key.autocomplete = "off"; key.value = GX.googleKey.get();
    save.addEventListener("click", function () { GX.googleKey.set(key.value.trim()); applyBasemap("photo"); });
    keyRow.appendChild(key); keyRow.appendChild(save);
    pop.appendChild(keyRow);
    pop.appendChild(el("p", "gx-note", "With a key, Photorealistic 3D streams Google 3D Tiles. Stored only in this browser."));
    bar.appendChild(pop);
    lb.addEventListener("click", function () { pop.classList.toggle("open"); });
    H.ui.note = el("div", "gx-basenote");
    bar.appendChild(H.ui.note);
    return bar;
  }

  function buildTop() {
    var wrap = panel("gx-top"), r1 = el("div", "gx-top-row");
    H.ui.clockUtc = el("span", "gx-mono gx-clock", ""); H.ui.clockLocal = el("span", "gx-mono gx-dim", "");
    H.ui.fps = el("span", "gx-mono gx-dim", ""); H.ui.stats = el("span", "gx-mono gx-dim", ""); H.ui.cam = el("span", "gx-mono gx-dim", ""); H.ui.feed = el("span", "gx-mono gx-dim", "");
    [H.ui.clockUtc, H.ui.clockLocal, H.ui.stats, H.ui.fps].forEach(function (n) { r1.appendChild(n); });
    wrap.appendChild(r1);
    var r2 = el("div", "gx-top-row"); r2.appendChild(H.ui.cam); r2.appendChild(H.ui.feed); wrap.appendChild(r2);
    var r3 = el("div", "gx-top-row gx-top-btns");
    var pal = btn("gx-btn gx-btn-sm", "Search /", "Command palette (Ctrl+K or /)"), home = btn("gx-btn gx-btn-sm", "Home", "Reset the camera to orbit"),
      hide = btn("gx-btn gx-btn-sm", "Cinema (H)", "Hide the HUD"), full = btn("gx-btn gx-btn-sm", "Full screen", "Full screen");
    pal.addEventListener("click", openPalette);
    home.addEventListener("click", function () { scene.viewHome(); });
    hide.addEventListener("click", function () { setCinema(true); });
    H.ui.fullBtn = full;
    full.addEventListener("click", function () { toggleMax(full); });
    [pal, home, hide, full].forEach(function (b) { r3.appendChild(b); });
    wrap.appendChild(r3);
    return wrap;
  }

  function buildChips() {
    var wrap = panel("gx-chips");
    H.ui.chips = {};
    GX.EXCHANGES.forEach(function (ex) {
      var chip = btn("gx-chip", "", "Fly to " + ex.name), dot = el("span", "gx-dot closed"), name = el("span", "", ex.name), time = el("span", "gx-mono gx-dim", "--:--");
      chip.appendChild(dot); chip.appendChild(name); chip.appendChild(time);
      chip.addEventListener("click", function () { selectEvent(exchangeEvent(ex), true); });
      wrap.appendChild(chip);
      H.ui.chips[ex.id] = { dot: dot, time: time };
    });
    return wrap;
  }

  function buildDrawer() {
    var d = panel("gx-drawer"), head = el("div", "gx-dr-head");
    head.appendChild(el("span", "gx-title", "LIVE INTELLIGENCE FEED"));
    H.ui.count = el("span", "gx-mono gx-dim", "");
    head.appendChild(H.ui.count);
    d.appendChild(head);
    var tools = el("div", "gx-tools"), q = document.createElement("input"), sev = document.createElement("select");
    q.type = "search"; q.placeholder = "Filter events"; q.setAttribute("aria-label", "Filter events");
    q.addEventListener("input", function () { H.q = q.value.trim().toLowerCase(); scene.refresh(); H.listSig = ""; renderFeed(); });
    [["1", "All severities"], ["2", "Elevated +"], ["3", "High +"], ["4", "Critical"]].forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; sev.appendChild(op); });
    sev.setAttribute("aria-label", "Minimum severity");
    sev.addEventListener("change", function () { H.minRank = Number(sev.value); scene.refresh(); H.listSig = ""; renderFeed(); });
    tools.appendChild(q); tools.appendChild(sev);
    d.appendChild(tools);
    H.ui.list = el("div", "gx-list");
    H.ui.list.setAttribute("role", "list");
    d.appendChild(H.ui.list);
    var collapse = btn("gx-collapse", "‹", "Collapse the feed");
    collapse.addEventListener("click", function () { d.classList.toggle("collapsed"); collapse.textContent = d.classList.contains("collapsed") ? "›" : "‹"; });
    d.appendChild(collapse);
    return d;
  }

  function buildDossier() {
    var d = panel("gx-dossier"), head = el("div", "gx-dr-head");
    head.appendChild(el("span", "gx-title", "EVENT DOSSIER"));
    var close = btn("gx-btn gx-btn-sm", "Close", "Close the dossier");
    close.addEventListener("click", function () { selectEvent(null, false); scene.stopOrbit(); });
    head.appendChild(close);
    d.appendChild(head);
    H.ui.dbody = el("div", "gx-dbody");
    d.appendChild(H.ui.dbody);
    H.ui.dossier = d;
    return d;
  }

  function buildTimeline() {
    var t = panel("gx-timeline"), r1 = el("div", "gx-tl-row");
    H.ui.winBtns = []; H.ui.speedBtns = [];
    WINDOWS.forEach(function (w) {
      var b = btn("gx-btn gx-btn-sm", w.label, "Show the last " + w.label);
      b.setAttribute("data-win", w.id); b.addEventListener("click", function () { setWindow(w.id); });
      r1.appendChild(b); H.ui.winBtns.push(b);
    });
    var date = document.createElement("input"), dl = el("label", "gx-dim gx-datelab", "Replay from");
    date.type = "date"; date.max = new Date().toISOString().slice(0, 10); date.min = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    date.setAttribute("aria-label", "Replay from date (last 30 days)");
    date.addEventListener("change", function () { if (date.value) setReplayFrom(date.value); });
    dl.appendChild(date); r1.appendChild(dl);
    r1.appendChild(el("span", "gx-spacer"));
    H.ui.play = btn("gx-btn gx-btn-sm", "Play", "Play or pause");
    H.ui.play.addEventListener("click", function () { H.live = false; if (H.T >= H.win.end) H.T = H.win.start; H.playing = !H.playing; syncTimeline(false); });
    r1.appendChild(H.ui.play);
    SPEEDS.forEach(function (s) {
      var b = btn("gx-btn gx-btn-sm", s + "x", "Playback speed " + s + "x");
      b.setAttribute("data-speed", s); b.addEventListener("click", function () { H.speed = s; syncTimeline(false); });
      r1.appendChild(b); H.ui.speedBtns.push(b);
    });
    H.ui.liveBtn = btn("gx-btn gx-btn-sm", "LIVE", "Jump to the present");
    H.ui.liveBtn.addEventListener("click", function () { H.live = true; H.playing = false; syncTimeline(false); });
    r1.appendChild(H.ui.liveBtn);
    t.appendChild(r1);
    var r2 = el("div", "gx-tl-row"), scrub = document.createElement("input");
    scrub.type = "range"; scrub.min = 0; scrub.max = 1000; scrub.value = 1000; scrub.className = "gx-scrub"; scrub.setAttribute("aria-label", "Timeline position");
    scrub.addEventListener("input", function () {
      H.scrubbing = true; H.live = false; H.playing = false;
      setT(H.win.start + Number(scrub.value) / 1000 * (H.win.end - H.win.start));
      scene.refresh(); renderFeed(); syncTimeline(false);
    });
    ["change", "pointerup", "blur"].forEach(function (n) { scrub.addEventListener(n, function () { H.scrubbing = false; }); });
    H.ui.scrub = scrub; H.ui.tlabel = el("span", "gx-mono gx-tlabel", "");
    r2.appendChild(scrub); r2.appendChild(H.ui.tlabel);
    t.appendChild(r2);
    return t;
  }

  function buildPalette() {
    var p = el("div", "gx-palette"), card = el("div", "gx-panel gx-pcard"), inp = document.createElement("input");
    inp.type = "text"; inp.placeholder = "Jump to a city, exchange, event or coordinates"; inp.setAttribute("aria-label", "Command palette"); inp.autocomplete = "off";
    inp.addEventListener("input", function () { H.palette.idx = 0; renderPalette(); });
    p.addEventListener("keydown", function (e) { if (e.key === "Escape") { closePalette(); e.stopPropagation(); } });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { H.palette.idx = Math.min(H.palette.items.length - 1, H.palette.idx + 1); renderPalette(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { H.palette.idx = Math.max(0, H.palette.idx - 1); renderPalette(); e.preventDefault(); }
      else if (e.key === "Enter") { runPalette(H.palette.idx); e.preventDefault(); }
      else if (e.key === "Escape") { closePalette(); e.preventDefault(); e.stopPropagation(); }
    });
    H.ui.pinput = inp; H.ui.pitems = el("div", "gx-pitems");
    card.appendChild(inp); card.appendChild(H.ui.pitems); p.appendChild(card);
    p.addEventListener("mousedown", function (e) { if (e.target === p) closePalette(); });
    H.ui.palette = p;
    return p;
  }

  function setCinema(on) {
    H.stage.classList.toggle("gx-cinema", on);
    H.ui.restore.hidden = !on;
  }

  function toggleMax(button) {
    var on = !H.stage.classList.contains("gx-max");
    H.stage.classList.toggle("gx-max", on);
    document.body.classList.toggle("gx-max-open", on);
    button.textContent = on ? "Exit full screen" : "Full screen";
    if (on && H.stage.requestFullscreen) H.stage.requestFullscreen().catch(function () { /* maximised in page instead */ });
    if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
  }

  function exitMax() {
    if (!H.stage || !H.stage.classList.contains("gx-max")) return;
    H.stage.classList.remove("gx-max"); document.body.classList.remove("gx-max-open");
    if (H.ui.fullBtn) H.ui.fullBtn.textContent = "Full screen";
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
  }

  document.addEventListener("fullscreenchange", function () {
    if (!document.fullscreenElement && H.stage && H.stage.classList.contains("gx-max")) {
      H.stage.classList.remove("gx-max"); document.body.classList.remove("gx-max-open");
    }
  });

  function applyBasemap(id) {
    H.ui.baseBtns.forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-base") === id); });
    H.ui.note.textContent = "Loading " + GX.BASEMAPS[id].label + "…";
    return scene.setBasemap(id).then(function (r) { if (r.mode !== "superseded") H.ui.note.textContent = r.note || (r.mode === "google3d" ? "Google Photorealistic 3D Tiles" : ""); });
  }

  /* ---------- Input ---------- */
  function bindKeys() {
    /* Capture phase so the globe owns Ctrl+K and "/" while it is on screen, instead of the app search box. */
    document.addEventListener("keydown", function (e) {
      if (!visible() || modalOpen()) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopImmediatePropagation(); H.palette.open ? closePalette() : openPalette(); return; }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); e.stopImmediatePropagation(); openPalette(); }
      else if (e.key === "h" || e.key === "H") { setCinema(!H.stage.classList.contains("gx-cinema")); }
      else if (e.code === "Space" && !/^(BUTTON|A)$/.test(e.target.tagName)) { e.preventDefault(); H.live = false; if (H.T >= H.win.end) H.T = H.win.start; H.playing = !H.playing; syncTimeline(false); }
      else if (e.key === "Escape") { if (H.selected) { selectEvent(null, false); scene.stopOrbit(); } else if (H.stage.classList.contains("gx-cinema")) setCinema(false); else exitMax(); }
    }, true);
  }

  /* ---------- Boot ---------- */
  function build(host) {
    var stage = el("div", "gx-stage"), canvas = el("div", "gx-canvas");
    H.stage = stage;
    stage.appendChild(canvas);
    H.ui.loading = el("div", "gx-loading", "Loading the 3D globe…");
    [buildBar(), buildTop(), buildChips(), buildDrawer(), buildDossier(), buildTimeline()].forEach(function (n) { stage.appendChild(n); });
    H.ui.restore = btn("gx-btn gx-restore", "Show HUD (H)", "Show the HUD"); H.ui.restore.hidden = true;
    H.ui.restore.addEventListener("click", function () { setCinema(false); });
    stage.appendChild(H.ui.restore); stage.appendChild(buildPalette()); stage.appendChild(H.ui.loading);
    stage.appendChild(el("p", "gx-hint", "Drag to pan · Shift+drag to tilt · Ctrl+drag to rotate · wheel to zoom"));
    host.appendChild(stage);
    return canvas;
  }

  function boot(host) {
    if (H.booted || H.booting) return;
    H.booting = true;
    var canvas = build(host);
    scene.boot(canvas).then(function (r) {
      H.booted = true; H.booting = false;
      H.ui.loading.hidden = true;
      H.ui.baseBtns.forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-base") === "photo"); });
      H.ui.note.textContent = r.note || "";
      scene.onPick(function (ref) { var ev = refToEvent(ref); if (ev) selectEvent(ev, true); });
      scene.onFrame(tick);
      H.last = performance.now();
      setWindow("24h");
      bindKeys();
      loadFeeds();
      if (typeof IntersectionObserver !== "undefined") {
        new IntersectionObserver(function (es) { H.inView = es[0].isIntersecting && es[0].intersectionRatio >= 0.25; }, { threshold: [0, 0.25, 0.5] }).observe(H.stage);
      }
      /* Feeds only refresh while the globe is on screen; rendering stops when it is not. */
      setInterval(function () { if (visible()) loadFeeds(); }, REFRESH_FEED_MS);
      setInterval(function () {
        scene.setRendering(visible());
        if (H.stage && H.stage.getClientRects().length === 0) exitMax();
      }, 500);
    }, function (e) {
      H.booting = false;
      H.ui.loading.textContent = "The 3D globe could not start: " + e.message;
      H.ui.loading.classList.add("error");
      H.stage.parentNode.removeChild(H.stage);
      H.stage = null;
    });
  }

  function init() {
    var classic = document.getElementById("mapClassic"), wrap = document.getElementById("gxWrap");
    if (!classic || !wrap) return;
    document.querySelectorAll("[data-map-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        var globe = b.getAttribute("data-map-mode") === "globe";
        document.querySelectorAll("[data-map-mode]").forEach(function (x) { x.classList.toggle("active", x === b); });
        if (!globe) exitMax();
        classic.hidden = globe; wrap.hidden = !globe;
        if (globe) boot(wrap);
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
