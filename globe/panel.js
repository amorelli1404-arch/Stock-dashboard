/* UI for the analyst tools: toolbar, Briefing and Watch tabs, and extra dossier sections.
 * Every dynamic string is written with textContent. */
(function (g) {
  "use strict";
  var GX = g.GX;
  if (!GX || typeof document === "undefined") return;
  (GX.onBoot = GX.onBoot || []).push(init);
  (GX.onFeeds = GX.onFeeds || []).push(applyHash);

  var BRIEF_REFRESH_MS = 4000, EXPOSE_RADIUS_KM = 250, TOP_EVENTS = 3, NAME_LIMIT = 5;
  var hud, T, scene = GX.scene, ui = {}, briefing = null, scopeVal = "view", briefTimer = null, passTimer = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(cls, text, title, fn) { var b = el("button", cls, text); b.type = "button"; if (title) { b.title = title; b.setAttribute("aria-label", title); } if (fn) b.addEventListener("click", fn); return b; }
  function pill(rating) { return el("span", "gx-rate " + rating.toLowerCase(), rating); }

  /* ---------- Scope helpers ---------- */
  function scopeTest() {
    if (scopeVal === "global") return { label: "the whole world", test: function () { return true; } };
    if (scopeVal.indexOf("fence:") === 0) {
      var f = T.fences.filter(function (x) { return "fence:" + x.id === scopeVal; })[0];
      if (f) return { label: "geofence " + f.name, test: function (lat, lon) { return GX.inFence(f, lat, lon); } };
    }
    var r = scene.viewRect();
    if (!r) return { label: "the current view (global)", test: function () { return true; } };
    return { label: "the current view", test: function (lat, lon) { return lat >= r.south && lat <= r.north && (r.west <= r.east ? lon >= r.west && lon <= r.east : lon >= r.west || lon <= r.east); } };
  }

  function computeBriefing() {
    var sc = scopeTest(), I = GX.intel, X = scene.ctx(), layer = X.S.layerOn;
    var events = hud.visibleEvents().filter(function (e) { return sc.test(e.lat, e.lon); });
    var top = events.slice().sort(function (a, b) { return GX.SEV[b.sev].rank - GX.SEV[a.sev].rank || b.t - a.t; }).slice(0, TOP_EVENTS);
    var exposed = [], tags = [];
    top.forEach(function (e) {
      var ring = GX.exposure(e.lat, e.lon, [EXPOSE_RADIUS_KM], GX.INFRA)[0];
      ring.items.slice(0, 3).forEach(function (x) { if (exposed.indexOf(x.item.n) < 0) exposed.push(x.item.n); });
      GX.exposureTags(ring.items).concat(GX.sensitivity(e)).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); });
    });
    var ves = layer.vessels ? I.vesselList().filter(function (v) { return v.lat != null && sc.test(v.lat, v.lon); }) : [];
    var air = layer.aircraft ? I.aircraftList().filter(function (a) { return sc.test(a.lat, a.lon); }) : [];
    return GX.buildBriefing({
      scope: sc.label, events: events, now: Date.now(), exposed: exposed, tags: tags,
      chokepoints: GX.CHOKEPOINTS.filter(function (c) { return sc.test(c.lat, c.lon); }).map(function (c) { return c.name; }),
      vessels: { count: ves.length, dark: ves.filter(function (v) { return v.dark; }).length, simulated: true },
      aircraft: { count: air.length, military: air.filter(function (a) { return a.mil; }).length, simulated: I.state.aircraft.simulated },
      gnss: layer.gnss ? GX.GNSS_ZONES.filter(function (z) { return sc.test(z.lat, z.lon); }).map(function (z) { return z.name; }) : [],
      outages: layer.outages ? I.outageList().filter(function (o) { return sc.test(o.lat, o.lon); }).map(function (o) { return o.name; }) : [],
      fenceAlerts: T.alerts.slice(0, 5).map(function (a) { return a.text; })
    });
  }

  /* ---------- Briefing tab ---------- */
  function buildBriefPane() {
    var pane = el("div", "gx-brief"), head = el("div", "gx-tools"), sel = document.createElement("select");
    sel.setAttribute("aria-label", "Briefing scope");
    sel.addEventListener("change", function () { scopeVal = sel.value; renderBrief(); });
    head.appendChild(sel);
    head.appendChild(btn("gx-btn gx-btn-sm", "Refresh", "Refresh the briefing", renderBrief));
    pane.appendChild(head);
    ui.scopeSel = sel;
    ui.briefBody = el("div", "gx-brief-body");
    pane.appendChild(ui.briefBody);
    return pane;
  }

  function fillScopes() {
    var sel = ui.scopeSel, keep = scopeVal;
    sel.textContent = "";
    [["view", "Current view"], ["global", "Global"]].concat(T.fences.map(function (f) { return ["fence:" + f.id, "Geofence: " + f.name]; })).forEach(function (o) { var op = el("option", "", o[1]); op.value = o[0]; sel.appendChild(op); });
    sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === keep; }) ? keep : "view";
    scopeVal = sel.value;
  }

  function renderBrief() {
    if (!ui.briefBody || !ui.briefBody.getClientRects().length) return;
    briefing = computeBriefing();
    var b = briefing, box = ui.briefBody;
    box.textContent = "";
    var top = el("div", "gx-brief-top");
    top.appendChild(pill(b.rating));
    top.appendChild(el("span", "gx-dim gx-mono", new Date(b.generated).toISOString().slice(11, 19) + " UTC"));
    box.appendChild(top);
    box.appendChild(el("p", "gx-brief-head", b.headline));
    b.sections.forEach(function (s) {
      var sec = el("div", "gx-brief-sec"), h = el("div", "gx-brief-sh");
      h.appendChild(el("span", "", s.title)); h.appendChild(pill(s.rating));
      sec.appendChild(h);
      var ul = el("ul", "gx-hl");
      s.lines.forEach(function (l) { ul.appendChild(el("li", "", l)); });
      sec.appendChild(ul);
      box.appendChild(sec);
    });
    box.appendChild(el("p", "gx-note", "Rule-based summary of what is in scope. It is templated text, not a language model, and not a forecast."));
  }

  /* ---------- Watch tab ---------- */
  function buildWatchPane() {
    var pane = el("div", "gx-watch");
    ui.fenceList = el("div", ""); ui.alertList = el("div", ""); ui.importList = el("div", ""); ui.measureBox = el("div", "");
    [["Geofences", ui.fenceList], ["Alerts", ui.alertList], ["Measurement", ui.measureBox], ["Imported layers", ui.importList]].forEach(function (s) {
      pane.appendChild(el("h4", "gx-dh", s[0])); pane.appendChild(s[1]);
    });
    var quick = el("div", "gx-acts"), sel = document.createElement("select");
    sel.setAttribute("aria-label", "Chokepoint to watch");
    GX.CHOKEPOINTS.forEach(function (c, i) { var o = el("option", "", c.name); o.value = i; sel.appendChild(o); });
    quick.appendChild(sel);
    quick.appendChild(btn("gx-btn gx-btn-sm", "Watch 100 km", "Create a 100 km geofence at the chokepoint", function () { var c = GX.CHOKEPOINTS[Number(sel.value)]; T.watchPoint(c.name + " watch", c.lat, c.lon, 100); }));
    pane.insertBefore(quick, ui.fenceList.nextSibling);
    return pane;
  }

  function renderFences() {
    if (!ui.fenceList) return;
    var box = ui.fenceList;
    box.textContent = "";
    if (!T.fences.length) box.appendChild(el("p", "gx-empty", "No geofences yet. Use Fence: Circle or Polygon in the toolbar, or watch a chokepoint below."));
    T.fences.forEach(function (f) {
      var r = el("div", "gx-row");
      r.appendChild(el("span", "", f.name + (f.type === "circle" ? " (" + f.rKm + " km)" : " (polygon)")));
      r.appendChild(el("span", "gx-mono gx-dim", (f.count || 0) + " inside"));
      r.appendChild(btn("gx-btn gx-btn-sm", "Remove", "Remove " + f.name, function () { T.removeFence(f.id); }));
      box.appendChild(r);
    });
    var ib = ui.importList; ib.textContent = "";
    if (!T.imports.length) ib.appendChild(el("p", "gx-empty", "Drop a GeoJSON, KML, KMZ or CZML file on the globe, or use Import."));
    T.imports.forEach(function (i) {
      var r = el("div", "gx-row");
      r.appendChild(el("span", "", i.name + " (" + i.count + ")"));
      r.appendChild(btn("gx-btn gx-btn-sm", "Zoom", "Zoom to " + i.name, function () { T.zoomImport(i.id); }));
      r.appendChild(btn("gx-btn gx-btn-sm", "Remove", "Remove " + i.name, function () { T.removeImport(i.id); }));
      ib.appendChild(r);
    });
    fillScopes();
  }

  function renderAlerts() {
    var box = ui.alertList;
    box.textContent = "";
    if (!T.alerts.length) box.appendChild(el("p", "gx-empty", "No alerts. They appear when an event, vessel or aircraft enters a geofence."));
    T.alerts.slice(0, 12).forEach(function (a) {
      var r = el("div", "gx-row");
      r.appendChild(el("span", "gx-mono gx-dim", new Date(a.t).toISOString().slice(11, 19)));
      r.appendChild(el("span", "", a.text));
      box.appendChild(r);
    });
  }

  function drawProfile(canvas, m) {
    var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height, hs = m.heights, lo = Math.min(m.minH, 0), hi = Math.max(m.maxH, 10), n = hs.length;
    ctx.clearRect(0, 0, w, h);
    function y(v) { return h - 6 - (v - lo) / (hi - lo) * (h - 14); }
    ctx.fillStyle = "rgba(121,192,255,0.25)"; ctx.strokeStyle = "#79C0FF"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, h);
    hs.forEach(function (v, i) { ctx.lineTo(i / (n - 1) * w, y(v)); });
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    ctx.beginPath(); hs.forEach(function (v, i) { if (i) ctx.lineTo(i / (n - 1) * w, y(v)); else ctx.moveTo(0, y(v)); }); ctx.stroke();
    ctx.strokeStyle = m.los.visible ? "#3FB950" : "#EF5350"; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(hs[0] + 10)); ctx.lineTo(w, y(hs[n - 1] + 10)); ctx.stroke(); ctx.setLineDash([]);
  }

  function renderMeasure(m) {
    var box = ui.measureBox;
    box.textContent = "";
    if (!m) { box.appendChild(el("p", "gx-empty", "Use Measure in the toolbar, then click two points.")); return; }
    var kv = el("div", "gx-kvs");
    function row(k, v) { var r = el("div", "gx-kv"); r.appendChild(el("span", "", k)); r.appendChild(el("b", "gx-mono", v)); kv.appendChild(r); }
    row("DISTANCE", m.distKm.toFixed(1) + " km (" + (m.distKm * 0.539957).toFixed(1) + " nm)");
    row("BEARING A→B", Math.round(m.bearing) + "°");
    row("TERRAIN", m.terrain ? Math.round(m.minH) + " to " + Math.round(m.maxH) + " m" : "flat imagery, no terrain");
    row("LINE OF SIGHT", m.los.visible ? "clear (10 m at both ends)" : "blocked at " + m.los.blockedAtKm.toFixed(1) + " km");
    box.appendChild(kv);
    var cv = document.createElement("canvas"); cv.width = 300; cv.height = 90; cv.className = "gx-profile"; cv.setAttribute("aria-label", "Terrain elevation profile");
    box.appendChild(cv); drawProfile(cv, m);
    box.appendChild(el("p", "gx-note", "Line of sight uses sampled terrain with earth curvature and standard refraction. It is a single line, not a full viewshed."));
    box.appendChild(btn("gx-btn gx-btn-sm", "Clear", "Clear the measurement", T.clearMeasure));
  }

  /* ---------- Toolbar ---------- */
  function buildToolbar() {
    var bar = el("div", "gx-panel gx-hud gx-tools2");
    var file = document.createElement("input");
    file.type = "file"; file.accept = ".geojson,.json,.kml,.kmz,.czml"; file.multiple = true; file.hidden = true;
    file.addEventListener("change", function () {
      Array.prototype.forEach.call(file.files, function (f) { T.importFile(f).then(function (r) { hud.toast("Imported " + r.name + " (" + r.count + " features)", "good"); hud.showTab("watch"); }, function (e) { hud.toast("Import failed: " + e.message, "bad"); }); });
      file.value = "";
    });
    var items = [
      ["Fence: Circle", "Draw a circular geofence", function () { T.drawFence("circle"); }],
      ["Fence: Polygon", "Draw a polygon geofence", function () { T.drawFence("polygon"); }],
      ["Measure", "Measure distance, bearing, terrain and line of sight", function () { hud.showTab("watch"); T.startMeasure(); }],
      ["Import", "Import GeoJSON, KML, KMZ or CZML", function () { file.click(); }],
      ["Copy link", "Copy a link to this exact view", function () { T.copyLink(); }],
      ["PNG", "Export a snapshot image", function () { T.exportPng(briefing || computeBriefing()); }],
      ["JSON", "Export the briefing as JSON", function () { T.exportJson(briefing || computeBriefing()); }]
    ];
    items.forEach(function (it) { bar.appendChild(btn("gx-btn gx-btn-sm", it[0], it[1], it[2])); });
    bar.appendChild(file);
    return bar;
  }

  /* ---------- Dossier sections ---------- */
  function section(body, title) { body.appendChild(el("h4", "gx-dh", title)); }

  function exposureSection(ev, body) {
    section(body, "Impact radius and exposure");
    var box = el("div", ""), shown = T.ringsAt() && T.ringsAt().lat === ev.lat && T.ringsAt().lon === ev.lon;
    var toggle = btn("gx-btn gx-btn-sm", shown ? "Hide rings" : "Show 10 / 50 / 250 / 500 km rings", "Toggle impact rings", function () {
      if (T.ringsAt() && T.ringsAt().lat === ev.lat && T.ringsAt().lon === ev.lon) T.hideRings(); else T.showRings(ev.lat, ev.lon);
      hud.refreshDossier();
    });
    body.appendChild(toggle);
    var rings = GX.exposure(ev.lat, ev.lon, T.RING_KM, GX.INFRA), kv = el("div", "gx-kvs");
    rings.forEach(function (r) {
      var row = el("div", "gx-kv gx-kv-col"), names = r.items.slice(0, NAME_LIMIT).map(function (x) { return x.item.n + " (" + Math.round(x.d) + " km)"; });
      var head = el("div", "gx-kv-head");
      head.appendChild(el("span", "", "WITHIN " + r.r + " KM"));
      head.appendChild(el("b", "gx-mono", r.items.length + " asset" + (r.items.length === 1 ? "" : "s")));
      row.appendChild(head);
      if (r.items.length) row.appendChild(el("div", "gx-kv-names", names.join(", ") + (r.items.length > NAME_LIMIT ? " and " + (r.items.length - NAME_LIMIT) + " more" : "")));
      kv.appendChild(row);
    });
    box.appendChild(kv);
    var tags = GX.exposureTags(rings[rings.length - 1].items).slice(0, 8), tg = el("div", "gx-tags");
    tags.forEach(function (t) { tg.appendChild(el("span", "gx-tag", t)); });
    if (tags.length) { box.appendChild(el("h4", "gx-dh", "Ripple sensitivity (500 km)")); box.appendChild(tg); }
    box.appendChild(el("p", "gx-note", "Counts come from a hand-curated reference list of ports, airports, refineries, fabs, power sites, farm belts and data centers. It is not a complete register."));
    body.appendChild(box);
  }

  function overpassSection(ev, body) {
    section(body, "Satellite overpasses");
    var out = el("div", ""), go = btn("gx-btn gx-btn-sm", "Compute next passes (12 h)", "Find upcoming low-orbit satellite passes", function () {
      if (!GX.intel.hasSats()) { out.textContent = "Turn on the Satellites layer first and wait for orbital data to load."; return; }
      out.textContent = "Computing…";
      GX.intel.overpasses(ev.lat, ev.lon, function (list) {
        out.textContent = "";
        if (!list || !list.length) { out.appendChild(el("p", "gx-empty", "No passes above 10° elevation in the next 12 hours.")); return; }
        clearInterval(passTimer);
        var rows = list.slice(0, 6).map(function (p) { var r = el("div", "gx-row"), c = el("span", "gx-mono"); r.appendChild(el("span", "", p.name)); r.appendChild(el("span", "gx-dim", p.cls + ", max " + Math.round(p.maxEl) + "°")); r.appendChild(c); out.appendChild(r); return { c: c, t: p.t }; });
        function tick() { rows.forEach(function (x) { var s = Math.max(0, Math.round((x.t - hud.timeMs()) / 1000)); x.c.textContent = "T-" + Math.floor(s / 3600) + "h " + String(Math.floor(s % 3600 / 60)).padStart(2, "0") + "m " + String(s % 60).padStart(2, "0") + "s"; }); }
        tick(); passTimer = setInterval(tick, 1000);
      });
    });
    body.appendChild(go); body.appendChild(out);
    body.appendChild(el("p", "gx-note", "Computed from public two-line elements for a small catalog of low-orbit satellites. The catalog includes some inactive spacecraft, and stale elements lose accuracy."));
  }

  function camSection(ev, body) {
    section(body, "Live cameras");
    var row = el("div", "gx-acts");
    GX.camLinks(ev.title.replace(/\s*\(.*$/, "")).forEach(function (l) { var a = el("a", "gx-btn gx-btn-sm", l.label + " ↗"); a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer"; row.appendChild(a); });
    body.appendChild(row);
    body.appendChild(el("p", "gx-note", "Keyless camera streams cannot be embedded reliably, so these open public directories in a new tab."));
  }

  function actionSection(ev, body) {
    section(body, "Analyst actions");
    var row = el("div", "gx-acts");
    [25, 100, 250].forEach(function (km) { row.appendChild(btn("gx-btn gx-btn-sm", "Watch " + km + " km", "Create a geofence around this location", function () { T.watchPoint(ev.title.slice(0, 28), ev.lat, ev.lon, km); hud.showTab("watch"); })); });
    row.appendChild(btn("gx-btn gx-btn-sm", "Before / after", "Compare baseline satellite imagery with current imagery and thermal anomalies", function () { T.startCompare(ev.lat, ev.lon, ev.t); }));
    body.appendChild(row);
  }

  function onDossier(ev, body) {
    if (!ev) { T.hideRings(); clearInterval(passTimer); return; }
    clearInterval(passTimer);
    if (ev.kind !== "sat") exposureSection(ev, body);
    overpassSection(ev, body);
    if (["chokepoint", "exchange", "infra", "landing", "bank"].indexOf(ev.kind) >= 0) camSection(ev, body);
    actionSection(ev, body);
  }

  /* ---------- Deep links ---------- */
  function applyHash() {
    var m = /[#&]gx=([\w-]+)/.exec(location.hash);
    if (!m || !GX.tools) return;
    var st = GX.decodeState(m[1]);
    if (!st) { hud.toast("That shared link could not be read.", "bad"); return; }
    T.applyState(st);
    hud.toast("Restored the shared view.", "good");
    history.replaceState(null, "", location.href.split("#")[0]);
  }

  function init(h) {
    hud = h; T = GX.tools;
    var stage = hud.stage();
    stage.appendChild(buildToolbar());
    var brief = buildBriefPane(), watch = buildWatchPane();
    hud.addTab("brief", "Briefing", brief, function () { fillScopes(); renderBrief(); });
    hud.addTab("watch", "Watch", watch, function () { renderFences(); renderAlerts(); renderMeasure(T.measure); });
    hud.onDossier(onDossier);
    T.on("fences", function () { renderFences(); });
    T.on("alert", renderAlerts);
    T.on("measure", function (m) { renderMeasure(m); if (m) hud.showTab("watch"); });
    renderFences(); renderAlerts(); renderMeasure(null);
    briefTimer = setInterval(function () { if (ui.briefBody && !brief.hidden) renderBrief(); }, BRIEF_REFRESH_MS);
  }
})(globalThis);
