/* Analyst tools bound to the viewer: geofences with alerts, measurement and line of sight, impact rings,
 * before/after imagery swipe, drag-and-drop layer import, and share/export. The UI lives in panel.js. */
(function (g) {
  "use strict";
  var GX = g.GX;
  if (!GX || typeof document === "undefined") return;
  (GX.onBoot = GX.onBoot || []).push(init);

  var FENCE_KEY = "indexwatch.globe.fences", MAX_FENCES = 12, MAX_ALERTS = 60, CHECK_MS = 2000, PROFILE_N = 64, RING_KM = [10, 50, 250, 500], MAX_IMPORT_BYTES = 20 * 1024 * 1024, DAY = 86400000;
  var GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/";
  var T = (GX.tools = { fences: [], alerts: [], imports: [], mode: null, measure: null, listeners: { alert: [], fences: [], measure: [], mode: [] } });
  var X, C, V, hud, fenceDs, ringDs, measureEnts = [], draft = [], draftEnts = [], handler, split = null, splitUi = null, ringsAt = null;

  function emit(k, a) { T.listeners[k].forEach(function (fn) { try { fn(a); } catch (e) { /* listener failed */ } }); }
  T.on = function (k, fn) { T.listeners[k].push(fn); };
  function nid() { return "f" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  /* ---------- Picking positions on the globe ---------- */
  function lonLat(win) {
    var ray = V.camera.getPickRay(win), p = ray && V.scene.globe.pick(ray, V.scene);
    if (!p) p = V.camera.pickEllipsoid(win, V.scene.globe.ellipsoid);
    if (!p) return null;
    var c = C.Cartographic.fromCartesian(p);
    return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude) };
  }

  function setMode(m) {
    T.mode = m;
    GX.scene.blockPicking(!!m);
    V.scene.canvas.style.cursor = m ? "crosshair" : "";
    clearDraft();
    emit("mode", m);
  }
  T.cancel = function () { setMode(null); };

  function clearDraft() { draft = []; draftEnts.forEach(function (e) { V.entities.remove(e); }); draftEnts = []; }

  function dot(p, col) { draftEnts.push(V.entities.add({ position: X.pos(p.lon, p.lat, 0), point: { pixelSize: 8, color: X.color(col), outlineColor: X.color("#000"), outlineWidth: 1 } })); }

  /* ---------- Geofences ---------- */
  function loadFences() {
    try {
      var raw = JSON.parse(localStorage.getItem(FENCE_KEY) || "[]");
      T.fences = (Array.isArray(raw) ? raw : []).filter(validFence).slice(0, MAX_FENCES);
    } catch (e) { T.fences = []; }
  }
  function saveFences() { try { localStorage.setItem(FENCE_KEY, JSON.stringify(T.fences.map(function (f) { return { id: f.id, name: f.name, type: f.type, lat: f.lat, lon: f.lon, rKm: f.rKm, ring: f.ring }; }))); } catch (e) { /* not persisted */ } }
  function okLat(v) { return typeof v === "number" && v >= -90 && v <= 90; }
  function okLon(v) { return typeof v === "number" && v >= -180 && v <= 180; }
  function validFence(f) {
    if (!f || typeof f.name !== "string" || typeof f.id !== "string") return false;
    if (f.type === "circle") return okLat(f.lat) && okLon(f.lon) && typeof f.rKm === "number" && f.rKm > 0 && f.rKm <= 5000;
    return f.type === "polygon" && Array.isArray(f.ring) && f.ring.length >= 3 && f.ring.length <= 200 && f.ring.every(function (p) { return Array.isArray(p) && okLon(p[0]) && okLat(p[1]); });
  }

  function renderFences() {
    fenceDs.entities.removeAll();
    T.fences.forEach(function (f) {
      var col = "#FFA726";
      if (f.type === "circle") {
        X.addE(fenceDs.entities, { position: X.pos(f.lon, f.lat, 0), ellipse: { semiMajorAxis: f.rKm * 1000, semiMinorAxis: f.rKm * 1000, height: 0, material: X.color(col, 0.1), outline: true, outlineColor: X.color(col, 0.9), outlineWidth: 2 },
          label: { text: f.name, font: "700 11px JetBrains Mono, monospace", fillColor: X.color("#FFE0B2"), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.5e7) } });
      } else {
        var flat = []; f.ring.forEach(function (p) { flat.push(p[0], p[1]); });
        var cx = f.ring.reduce(function (s, p) { return s + p[0]; }, 0) / f.ring.length, cy = f.ring.reduce(function (s, p) { return s + p[1]; }, 0) / f.ring.length;
        X.addE(fenceDs.entities, { polygon: { hierarchy: C.Cartesian3.fromDegreesArray(flat), height: 0, material: X.color(col, 0.1), outline: true, outlineColor: X.color(col, 0.9) } });
        X.addE(fenceDs.entities, { position: X.pos(cx, cy, 0), label: { text: f.name, font: "700 11px JetBrains Mono, monospace", fillColor: X.color("#FFE0B2"), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.5e7) } });
      }
    });
    emit("fences", T.fences);
  }

  T.addFence = function (f) {
    if (T.fences.length >= MAX_FENCES) { hud.toast("Geofence limit reached (" + MAX_FENCES + "). Remove one first.", "bad"); return null; }
    f.id = nid();
    if (!validFence(f)) { hud.toast("That geofence is not valid.", "bad"); return null; }
    T.fences.push(f);
    saveFences(); renderFences();
    checkFences(true);
    return f;
  };
  T.removeFence = function (id) { T.fences = T.fences.filter(function (f) { return f.id !== id; }); saveFences(); renderFences(); };
  T.watchPoint = function (name, lat, lon, rKm) { return T.addFence({ name: name, type: "circle", lat: lat, lon: lon, rKm: rKm }); };

  T.drawFence = function (type) {
    setMode({ kind: "fence", type: type });
    hud.toast(type === "circle" ? "Click the centre, then click again to set the radius. Esc cancels." : "Click each corner. Double-click or press Enter to finish, Esc to cancel.", "");
  };

  function finishPolygon() {
    if (draft.length < 3) { hud.toast("A polygon needs at least 3 points.", "bad"); return; }
    var ring = draft.map(function (p) { return [Number(p.lon.toFixed(4)), Number(p.lat.toFixed(4))]; });
    setMode(null);
    var f = T.addFence({ name: "Polygon " + (T.fences.length + 1), type: "polygon", ring: ring });
    if (f) hud.toast("Geofence created. Alerts fire when events, vessels or aircraft enter it.", "good");
  }

  function items() {
    var out = [];
    hud.visibleEvents().forEach(function (e) { out.push({ key: "ev:" + e.id, lat: e.lat, lon: e.lon, label: e.title, kind: "event" }); });
    if (X.S.layerOn.vessels) GX.intel.vesselList().forEach(function (v) { if (v.lat != null) out.push({ key: "v:" + v.id, lat: v.lat, lon: v.lon, label: "Vessel " + v.id + (v.dark ? " (transponder gap)" : ""), kind: "vessel" }); });
    if (X.S.layerOn.aircraft) GX.intel.aircraftList().forEach(function (a) { out.push({ key: "a:" + a.hex, lat: a.lat, lon: a.lon, label: "Aircraft " + (a.call || a.hex), kind: "aircraft" }); });
    return out;
  }

  /* quiet: record who is already inside without raising alerts (used when a fence is created or restored). */
  function checkFences(quiet) {
    if (!T.fences.length) return;
    var list = items();
    T.fences.forEach(function (f) {
      var inside = new Set();
      list.forEach(function (it) { if (GX.inFence(f, it.lat, it.lon)) inside.add(it.key); });
      if (!quiet && f.inside) {
        list.forEach(function (it) {
          if (inside.has(it.key) && !f.inside.has(it.key)) {
            var a = { t: Date.now(), fence: f.name, text: it.label + " entered " + f.name, kind: it.kind };
            T.alerts.unshift(a);
            if (T.alerts.length > MAX_ALERTS) T.alerts.pop();
            hud.toast("Geofence alert: " + a.text, "bad");
            emit("alert", a);
          }
        });
      }
      f.inside = inside;
      f.count = inside.size;
    });
  }

  /* ---------- Measure ---------- */
  T.startMeasure = function () { T.clearMeasure(); setMode({ kind: "measure" }); hud.toast("Click point A, then point B. Esc cancels.", ""); };

  T.clearMeasure = function () { measureEnts.forEach(function (e) { V.entities.remove(e); }); measureEnts = []; T.measure = null; emit("measure", null); };

  function sampleTerrain(a, b) {
    var pts = GX.greatCircle(a.lon, a.lat, b.lon, b.lat, PROFILE_N - 1, 0);
    if (!X.S.terrain) return Promise.resolve({ heights: pts.map(function () { return 0; }), terrain: false });
    return C.sampleTerrainMostDetailed(X.S.terrain, pts.map(function (p) { return C.Cartographic.fromDegrees(p.lon, p.lat); })).then(function (r) {
      return { heights: r.map(function (c) { return isFinite(c.height) ? c.height : 0; }), terrain: true };
    }, function () { return { heights: pts.map(function () { return 0; }), terrain: false }; });
  }

  function finishMeasure(a, b) {
    setMode(null);
    var dist = GX.haversineKm(a.lat, a.lon, b.lat, b.lon), brg = GX.bearing(a.lat, a.lon, b.lat, b.lon);
    sampleTerrain(a, b).then(function (s) {
      var los = GX.losProfile(s.heights, dist, 10, 10), col = los.visible ? "#3FB950" : "#EF5350";
      T.measure = { a: a, b: b, distKm: dist, bearing: brg, heights: s.heights, terrain: s.terrain, los: los, minH: Math.min.apply(null, s.heights), maxH: Math.max.apply(null, s.heights) };
      measureEnts.push(V.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray([a.lon, a.lat, b.lon, b.lat]), width: 3, arcType: C.ArcType.GEODESIC, material: new C.PolylineDashMaterialProperty({ color: X.color(col), dashLength: 14 }), clampToGround: false } }));
      [a, b].forEach(function (p, i) { measureEnts.push(V.entities.add({ position: X.pos(p.lon, p.lat, 0), point: { pixelSize: 9, color: X.color(col), outlineColor: X.color("#fff"), outlineWidth: 1 }, label: { text: i ? "B" : "A", font: "700 12px JetBrains Mono, monospace", fillColor: X.color("#fff"), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -16) } })); });
      emit("measure", T.measure);
    });
  }

  /* ---------- Impact rings ---------- */
  T.showRings = function (lat, lon) {
    T.hideRings();
    ringsAt = { lat: lat, lon: lon };
    var cols = ["#EF5350", "#FFA726", "#FFEE58", "#26A69A"];
    RING_KM.forEach(function (km, i) {
      X.addE(ringDs.entities, { position: X.pos(lon, lat, 0), ellipse: { semiMajorAxis: km * 1000, semiMinorAxis: km * 1000, height: 0, fill: false, outline: true, outlineColor: X.color(cols[i], 0.95), outlineWidth: 2 } });
      var p = GX.destination(lat, lon, 0, km);
      X.addE(ringDs.entities, { position: X.pos(p.lon, p.lat, 0), label: { text: km + " km", font: "700 11px JetBrains Mono, monospace", fillColor: X.color(cols[i]), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 6e6) } });
    });
  };
  T.hideRings = function () { ringDs.entities.removeAll(); ringsAt = null; };
  T.ringsAt = function () { return ringsAt; };
  T.RING_KM = RING_KM;

  /* ---------- Before / after imagery swipe ---------- */
  function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

  T.startCompare = function (lat, lon, eventMs) {
    T.stopCompare();
    var now = Date.now(), current = now - 2 * DAY, base = Math.min(eventMs - 14 * DAY, current - 7 * DAY);
    function prov(layer, date, set, ext, max, credit) { return new C.UrlTemplateImageryProvider({ url: GIBS + layer + "/default/" + date + "/" + set + "/{z}/{y}/{x}." + ext, maximumLevel: max, credit: credit }); }
    var left = V.imageryLayers.addImageryProvider(prov("MODIS_Terra_CorrectedReflectance_TrueColor", ymd(base), "GoogleMapsCompatible_Level9", "jpg", 9, "NASA GIBS / MODIS Terra"));
    var right = V.imageryLayers.addImageryProvider(prov("MODIS_Terra_CorrectedReflectance_TrueColor", ymd(current), "GoogleMapsCompatible_Level9", "jpg", 9, "NASA GIBS / MODIS Terra"));
    var heat = V.imageryLayers.addImageryProvider(prov("VIIRS_SNPP_Thermal_Anomalies_375m_All", ymd(current), "GoogleMapsCompatible_Level8", "png", 8, "NASA GIBS / VIIRS thermal anomalies"));
    left.splitDirection = C.SplitDirection.LEFT; right.splitDirection = C.SplitDirection.RIGHT; heat.splitDirection = C.SplitDirection.RIGHT;
    V.scene.splitPosition = 0.5;
    split = { layers: [left, right, heat], base: ymd(base), current: ymd(current) };
    buildSplitUi();
    GX.scene.flyTo(lat, lon, { range: 450000, pitch: -90, duration: 2 });
    emit("mode", { kind: "compare" });
  };

  T.stopCompare = function () {
    if (!split) return;
    split.layers.forEach(function (l) { V.imageryLayers.remove(l, true); });
    V.scene.splitPosition = 0;
    split = null;
    if (splitUi) { splitUi.parentNode.removeChild(splitUi); splitUi = null; }
    emit("mode", null);
  };

  function buildSplitUi() {
    var stage = hud.stage(), box = document.createElement("div"), bar = document.createElement("div"), handle = document.createElement("button");
    box.className = "gx-split";
    bar.className = "gx-split-bar"; handle.className = "gx-split-handle"; handle.type = "button"; handle.setAttribute("aria-label", "Drag to compare before and after imagery"); handle.textContent = "↔";
    var l = document.createElement("span"), r = document.createElement("span"), close = document.createElement("button");
    l.className = "gx-split-l"; l.textContent = "BASELINE " + split.base; r.className = "gx-split-r"; r.textContent = "CURRENT " + split.current + "  + thermal anomalies";
    close.className = "gx-btn gx-split-close"; close.type = "button"; close.textContent = "Close compare";
    close.addEventListener("click", T.stopCompare);
    bar.appendChild(handle); box.appendChild(bar); box.appendChild(l); box.appendChild(r); box.appendChild(close);
    var dragging = false;
    function move(e) {
      if (!dragging) return;
      var rect = stage.getBoundingClientRect(), f = Math.max(0.03, Math.min(0.97, (e.clientX - rect.left) / rect.width));
      bar.style.left = (f * 100) + "%"; V.scene.splitPosition = f;
    }
    handle.addEventListener("pointerdown", function (e) { dragging = true; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", function () { dragging = false; });
    stage.appendChild(box);
    splitUi = box;
  }

  /* ---------- Import ---------- */
  T.importFile = function (file) {
    var name = file.name || "layer", ext = (name.split(".").pop() || "").toLowerCase();
    if (file.size > MAX_IMPORT_BYTES) return Promise.reject(new Error(name + " is larger than 20 MB"));
    var load;
    if (ext === "kml" || ext === "kmz") load = C.KmlDataSource.load(file, { camera: V.scene.camera, canvas: V.scene.canvas });
    else if (ext === "czml") load = file.text().then(function (t) { return C.CzmlDataSource.load(JSON.parse(t)); });
    else if (ext === "geojson" || ext === "json") load = file.text().then(function (t) { return C.GeoJsonDataSource.load(JSON.parse(t), { stroke: X.color("#79C0FF"), fill: X.color("#79C0FF", 0.25), strokeWidth: 2 }); });
    else return Promise.reject(new Error(name + ": unsupported type (use GeoJSON, KML, KMZ or CZML)"));
    return load.then(function (ds) {
      V.dataSources.add(ds);
      var rec = { id: nid(), name: name, ds: ds, count: ds.entities.values.length };
      T.imports.push(rec);
      emit("fences", T.fences);
      return rec;
    });
  };
  T.removeImport = function (id) { var r = T.imports.filter(function (x) { return x.id === id; })[0]; if (r) { V.dataSources.remove(r.ds, true); T.imports = T.imports.filter(function (x) { return x.id !== id; }); emit("fences", T.fences); } };
  T.zoomImport = function (id) { var r = T.imports.filter(function (x) { return x.id === id; })[0]; if (r) V.flyTo(r.ds); };

  function bindDrop() {
    var stage = hud.stage();
    ["dragenter", "dragover"].forEach(function (n) { stage.addEventListener(n, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { e.preventDefault(); stage.classList.add("gx-drop"); } }); });
    ["dragleave", "drop"].forEach(function (n) { stage.addEventListener(n, function () { stage.classList.remove("gx-drop"); }); });
    stage.addEventListener("drop", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) {
        T.importFile(f).then(function (r) { hud.toast("Imported " + r.name + " (" + r.count + " features)", "good"); }, function (err) { hud.toast("Import failed: " + err.message, "bad"); });
      });
    });
  }

  /* ---------- Share and export ---------- */
  T.getState = function () {
    var cam = GX.scene.cameraInfo(), sel = hud.selected();
    return { lat: cam.lat, lon: cam.lon, alt: cam.alt, h: cam.heading, p: cam.pitch, t: hud.timeMs(), base: X.S.basemap, win: hud.windowId(),
      layers: GX.LAYERS.filter(function (l) { return X.S.layerOn[l.id]; }).map(function (l) { return l.id; }), sel: sel ? sel.id : null };
  };

  T.shareUrl = function () { return location.href.split("#")[0] + "#gx=" + GX.encodeState(T.getState()); };

  T.copyLink = function () {
    var url = T.shareUrl();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    var p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url).then(function () { return true; }, fallback) : Promise.resolve(fallback());
    return p.then(function (ok) { hud.toast(ok ? "Link copied. It restores this exact view, layers and time." : "Could not copy automatically: " + url, ok ? "good" : "bad"); return url; });
  };

  function download(name, href) { var a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); }

  T.exportPng = function (briefing) {
    GX.scene.renderNow();
    var src = GX.scene.canvasEl(), out = document.createElement("canvas"), pad = 72;
    out.width = src.width; out.height = src.height + pad;
    var ctx = out.getContext("2d");
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    var cam = GX.scene.cameraInfo(), k = Math.max(1, out.width / 1400);
    ctx.fillStyle = "#e6edf3"; ctx.font = "700 " + 15 * k + "px monospace";
    ctx.fillText(briefing ? briefing.headline.slice(0, 140) : "Index Watch event map", 14 * k, src.height + 26 * k);
    ctx.fillStyle = "#8b949e"; ctx.font = 12 * k + "px monospace";
    ctx.fillText(new Date(hud.timeMs()).toISOString().replace("T", " ").slice(0, 19) + " UTC   LAT " + cam.lat.toFixed(3) + "  LON " + cam.lon.toFixed(3) + "  ALT " + Math.round(cam.alt / 1000) + " km   Imagery and data: Esri, NASA, USGS and others", 14 * k, src.height + 48 * k);
    try { download("intel-snapshot-" + Date.now() + ".png", out.toDataURL("image/png")); hud.toast("PNG snapshot saved.", "good"); }
    catch (e) { hud.toast("Could not export the image: " + e.message, "bad"); }
  };

  T.exportJson = function (briefing, scopeEvents) {
    var data = { generated: new Date().toISOString(), timeline: new Date(hud.timeMs()).toISOString(), view: T.getState(), shareUrl: T.shareUrl(), briefing: briefing || null,
      events: (scopeEvents || hud.visibleEvents()).slice(0, 500).map(function (e) { return { id: e.id, kind: e.kind, title: e.title, severity: e.sev, lat: e.lat, lon: e.lon, time: new Date(e.t).toISOString(), source: e.source }; }),
      geofences: T.fences.map(function (f) { return { name: f.name, type: f.type, lat: f.lat, lon: f.lon, rKm: f.rKm, ring: f.ring, inside: f.count || 0 }; }),
      geofenceAlerts: T.alerts.map(function (a) { return { time: new Date(a.t).toISOString(), fence: a.fence, text: a.text }; }),
      measurement: T.measure ? { distKm: T.measure.distKm, bearing: T.measure.bearing, a: T.measure.a, b: T.measure.b, lineOfSight: T.measure.los.visible } : null,
      notes: ["Simulated layers (AIS vessels, fallback air traffic) are illustrative.", "Infrastructure, chokepoints, cables and GNSS zones are approximate reference data.", "The briefing is rule-based text, not a language model."] };
    download("intel-briefing-" + Date.now() + ".json", URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })));
    hud.toast("Briefing JSON saved.", "good");
  };

  T.applyState = function (st) {
    if (!st) return;
    if (st.base && GX.BASEMAPS[st.base] && st.base !== X.S.basemap) hud.setBasemap(st.base);
    if (st.layers) { GX.LAYERS.forEach(function (l) { GX.scene.setLayer(l.id, st.layers.indexOf(l.id) >= 0); }); if (hud.syncLayers) hud.syncLayers(); }
    if (st.win && ["24h", "7d", "30d"].indexOf(st.win) >= 0) hud.setWindow(st.win);
    if (st.t && st.t < Date.now() - 5000 && st.t >= hud.timeMs() - 31 * DAY) hud.setTime(st.t);
    GX.scene.setCamera(st);
    if (st.sel) { var ev = hud.events().filter(function (e) { return e.id === st.sel; })[0]; if (ev) hud.selectEvent(ev, false); }
  };

  /* ---------- Input ---------- */
  function bindInput() {
    handler = new C.ScreenSpaceEventHandler(V.scene.canvas);
    handler.setInputAction(function (e) {
      if (!T.mode) return;
      var p = lonLat(e.position);
      if (!p) return;
      var m = T.mode;
      if (m.kind === "measure") {
        draft.push(p); dot(p, "#fff");
        if (draft.length === 2) { var a = draft[0], b = draft[1]; finishMeasure(a, b); }
      } else if (m.kind === "fence" && m.type === "circle") {
        draft.push(p); dot(p, "#FFA726");
        if (draft.length === 2) {
          var r = GX.haversineKm(draft[0].lat, draft[0].lon, p.lat, p.lon), c0 = draft[0];
          setMode(null);
          if (r < 1) { hud.toast("Radius too small. Try again.", "bad"); return; }
          T.addFence({ name: "Zone " + (T.fences.length + 1), type: "circle", lat: c0.lat, lon: c0.lon, rKm: Math.round(r) });
          hud.toast("Geofence created: " + Math.round(r) + " km radius.", "good");
        }
      } else if (m.kind === "fence" && m.type === "polygon") { draft.push(p); dot(p, "#FFA726"); }
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(function () { if (T.mode && T.mode.kind === "fence" && T.mode.type === "polygon") { draft.pop(); finishPolygon(); } }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    document.addEventListener("keydown", function (e) {
      if (!T.mode) return;
      if (e.key === "Escape") { setMode(null); e.stopPropagation(); }
      else if (e.key === "Enter" && T.mode.kind === "fence" && T.mode.type === "polygon") { finishPolygon(); e.preventDefault(); }
    }, true);
  }

  function init(h) {
    hud = h; X = GX.scene.ctx(); C = X.C; V = X.V;
    fenceDs = new C.CustomDataSource("fences"); V.dataSources.add(fenceDs);
    ringDs = new C.CustomDataSource("rings"); V.dataSources.add(ringDs);
    loadFences(); renderFences();
    bindInput(); bindDrop();
    var last = 0, first = true;
    GX.scene.onFrame(function () {
      var now = performance.now();
      if (now - last < CHECK_MS) return;
      last = now;
      checkFences(first);
      first = false;
    });
  }
})(globalThis);
