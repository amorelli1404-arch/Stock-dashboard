/* 3D globe scene (CesiumJS, loaded lazily from a CDN). Owns the viewer, basemaps, event markers, route layers,
 * camera flights and picking. The HUD (hud.js) drives it through the GX.scene API and never touches Cesium. */
(function (g) {
  "use strict";
  var GX = (g.GX = g.GX || {});
  var C = null, V = null;

  var CESIUM_VERSION = "1.119.0", CESIUM_BASE = "https://cdn.jsdelivr.net/npm/cesium@" + CESIUM_VERSION + "/Build/Cesium/";
  var BORDERS_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson";
  var TERRAIN_URL = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
  var GOOGLE_3D = "https://tile.googleapis.com/v1/3dtiles/root.json?key=";
  var KEY_STORE = "indexwatch.globe.googleKey";
  var MAX_BEACONS = 36, ORBIT_RAD_PER_S = 0.1, FLY_PITCH_DEG = -38, MIN_ZOOM_M = 60, RING_PERIOD_MS = 2600, STATUS_REFRESH_MS = 30000;

  var ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/";
  var BASEMAPS = {
    photo: { label: "Photorealistic 3D", layers: [{ url: ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", max: 19, credit: "Imagery © Esri, Maxar, Earthstar Geographics" }], terrain: true },
    dark: { label: "Dark Tactical", layers: [{ url: ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", max: 16, credit: "Tiles © Esri, HERE, Garmin, OpenStreetMap contributors" },
      { url: ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", max: 16, credit: "Tiles © Esri" }], terrain: false },
    terrain: { label: "Terrain Elevation", layers: [{ url: ESRI + "World_Topo_Map/MapServer/tile/{z}/{y}/{x}", max: 19, credit: "Tiles © Esri, USGS, NOAA" }], terrain: true },
    maritime: { label: "Maritime & Airspace", layers: [{ url: ESRI + "Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", max: 13, credit: "Tiles © Esri, GEBCO, NOAA" },
      { url: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", max: 17, credit: "© OpenSeaMap contributors" }], terrain: false }
  };
  GX.BASEMAPS = BASEMAPS;

  var S = {
    ready: false, layerOn: {}, events: [], predicate: function () { return true; }, points: null, pointByEv: new Map(),
    ds: {}, beaconSig: "", stormSig: "", timeMs: Date.now(), exStatus: {}, exStamp: 0, terrain: null, tileset: null, basemap: null,
    orbit: null, selected: null, impact: null, onPick: null, onFrame: null, frames: 0, fps: 0, fpsStamp: 0, bordersLoaded: false
  };

  GX.LAYERS.forEach(function (l) { S.layerOn[l.id] = l.id !== "air"; });

  /* ---------- Loading ---------- */
  function loadCesium() {
    if (g.Cesium) return Promise.resolve(g.Cesium);
    g.CESIUM_BASE_URL = CESIUM_BASE;
    return new Promise(function (resolve, reject) {
      var css = document.createElement("link");
      css.rel = "stylesheet"; css.href = CESIUM_BASE + "Widgets/widgets.css";
      document.head.appendChild(css);
      var s = document.createElement("script");
      s.src = CESIUM_BASE + "Cesium.js";
      s.onload = function () { g.Cesium ? resolve(g.Cesium) : reject(new Error("Cesium did not initialise")); };
      s.onerror = function () { reject(new Error("Could not load CesiumJS from the CDN. Check your connection or content blocker.")); };
      document.head.appendChild(s);
    });
  }

  function color(css, a) { var c = C.Color.fromCssColorString(css); return a == null ? c : c.withAlpha(a); }
  function pos(lon, lat, h) { return C.Cartesian3.fromDegrees(lon, lat, h || 0); }
  function sevColor(sev, a) { return color(GX.SEV[sev].color, a); }
  function dataSource(id) { var d = new C.CustomDataSource(id); V.dataSources.add(d); S.ds[id] = d; return d; }

  /* ---------- Viewer ---------- */
  function createViewer(container) {
    V = new C.Viewer(container, {
      baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, vrButton: false, shouldAnimate: false,
      selectionIndicatorDisabled: true, contextOptions: { webgl: { alpha: false, antialias: true } }
    });
    var sc = V.scene, gl = sc.globe;
    gl.enableLighting = true; gl.showGroundAtmosphere = true; gl.baseColor = color("#0a1020");
    gl.nightFadeOutDistance = 4e7; gl.nightFadeInDistance = 1e7;
    sc.skyAtmosphere.show = true; sc.highDynamicRange = false; sc.backgroundColor = color("#03060a");
    sc.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_M;
    sc.screenSpaceCameraController.maximumZoomDistance = 6e7;
    /* Left drag pans, Shift+drag tilts, Ctrl+drag tilts and rotates around the point under the cursor. */
    var T = C.CameraEventType, ctl = sc.screenSpaceCameraController;
    ctl.rotateEventTypes = [T.LEFT_DRAG];
    ctl.tiltEventTypes = [T.MIDDLE_DRAG, T.PINCH, { eventType: T.LEFT_DRAG, modifier: C.KeyboardEventModifier.SHIFT }, { eventType: T.LEFT_DRAG, modifier: C.KeyboardEventModifier.CTRL }];
    ctl.zoomEventTypes = [T.WHEEL, T.PINCH, T.RIGHT_DRAG];
    V.cesiumWidget.creditContainer.classList.add("gx-credits");
  }

  /* ---------- Basemaps ---------- */
  function addImagery(def) {
    var opt = { url: def.url, maximumLevel: def.max, credit: def.credit };
    if (def.sub) opt.subdomains = def.sub;
    return V.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider(opt));
  }

  function loadTerrain() {
    if (S.terrain !== null) return Promise.resolve(S.terrain);
    return C.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL).then(function (p) { S.terrain = p; return p; }, function () { S.terrain = false; return false; });
  }

  function removeTileset() {
    if (S.tileset) { V.scene.primitives.remove(S.tileset); S.tileset = null; }
    V.scene.globe.show = true;
  }

  GX.googleKey = {
    get: function () { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } },
    set: function (k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (e) { /* not persisted */ } }
  };

  /* Resolves to {mode, note}. Photorealistic 3D needs a Google Map Tiles API key; without one it falls back to satellite imagery. */
  function setBasemap(id) {
    var def = BASEMAPS[id] || BASEMAPS.photo;
    S.basemap = id;
    V.imageryLayers.removeAll();
    removeTileset();
    def.layers.forEach(addImagery);
    var tasks = [def.terrain ? loadTerrain() : Promise.resolve(false)];
    return Promise.all(tasks).then(function (r) {
      if (S.basemap !== id) return { mode: "superseded" };
      V.terrainProvider = r[0] || new C.EllipsoidTerrainProvider();
      V.scene.globe.depthTestAgainstTerrain = !!r[0];
      var note = def.terrain && !r[0] ? "3D terrain unavailable, using flat imagery." : "";
      var key = id === "photo" ? GX.googleKey.get() : "";
      if (!key) return { mode: id === "photo" ? "satellite" : id, note: id === "photo" ? "Satellite imagery. Add a Google Map Tiles API key for Photorealistic 3D." + (note ? " " + note : "") : note };
      return C.Cesium3DTileset.fromUrl(GOOGLE_3D + encodeURIComponent(key), { showCreditsOnScreen: true }).then(function (ts) {
        if (S.basemap !== id) { ts.destroy(); return { mode: "superseded" }; }
        S.tileset = V.scene.primitives.add(ts);
        V.scene.globe.show = false;
        return { mode: "google3d", note: "" };
      }, function () { return { mode: "satellite", note: "Google 3D Tiles failed to load (check the API key). Showing satellite imagery." }; });
    });
  }

  /* ---------- Static layers ---------- */
  function buildRoutes() {
    var supply = dataSource("supply");
    GX.SHIP_ARCS.forEach(function (a, i) {
      var pts = GX.greatCircle(a.from[0], a.from[1], a.to[0], a.to[1], 90, a.peakM);
      var flat = []; pts.forEach(function (p) { flat.push(p.lon, p.lat, p.h); });
      supply.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(flat), width: 3, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.22, color: color("#2DD4BF", 0.85) }) }, gx: { type: "route", name: a.name } });
      for (var k = 0; k < 3; k++) {
        (function (offset) {
          supply.entities.add({ position: new C.CallbackProperty(function () {
            var ph = ((performance.now() / 14000) + offset + i * 0.13) % 1, p = pts[Math.min(pts.length - 1, Math.floor(ph * (pts.length - 1)))];
            return pos(p.lon, p.lat, p.h);
          }, false), point: { pixelSize: 6, color: color("#E6FFFB"), outlineColor: color("#2DD4BF", 0.6), outlineWidth: 3 }, gx: { type: "route", name: a.name } });
        })(k / 3);
      }
    });
    GX.CHOKEPOINTS.forEach(function (c) {
      supply.entities.add({ position: pos(c.lon, c.lat, 0), point: { pixelSize: 9, color: color("#FFA726"), outlineColor: color("#000", 0.6), outlineWidth: 1 },
        label: { text: c.name.toUpperCase(), font: "600 11px JetBrains Mono, monospace", fillColor: color("#FFE0B2"), outlineColor: color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -16), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.6e7) }, gx: { type: "chokepoint", item: c } });
    });

    var air = dataSource("air");
    GX.AIR_CORRIDORS.forEach(function (a) {
      var flat = []; a.pts.forEach(function (p) { flat.push(p[0], p[1], 0); });
      air.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(flat), width: 9, arcType: C.ArcType.GEODESIC, material: color("#C9D1D9", 0.16) }, gx: { type: "route", name: a.name } });
    });

    var cables = dataSource("cables");
    GX.CABLES.forEach(function (a) {
      var flat = []; a.pts.forEach(function (p) { flat.push(p[0], p[1], 0); });
      cables.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(flat), width: 2, arcType: C.ArcType.GEODESIC, material: new C.PolylineDashMaterialProperty({ color: color("#79C0FF", 0.85), dashLength: 14 }) }, gx: { type: "route", name: a.name } });
    });

    var macro = dataSource("macro");
    GX.CENTRAL_BANKS.forEach(function (b) {
      macro.entities.add({ position: pos(b.lon, b.lat, 0), point: { pixelSize: 8, color: color("#58A6FF"), outlineColor: color("#fff", 0.7), outlineWidth: 1 },
        label: { text: b.name, font: "600 10px JetBrains Mono, monospace", fillColor: color("#CFE4FF"), outlineColor: color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -14), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 6e6) }, gx: { type: "bank", item: b } });
    });

    var mk = dataSource("markets");
    GX.EXCHANGES.forEach(function (ex) {
      function st() { return S.exStatus[ex.id] || { state: "closed", local: "--:--" }; }
      var palette = { open: "#3FB950", pre: "#FFEE58", closed: "#6E7681" };
      mk.entities.add({ position: pos(ex.lon, ex.lat, 0),
        point: { pixelSize: 11, color: new C.CallbackProperty(function () { return color(palette[st().state]); }, false), outlineColor: color("#fff", 0.8), outlineWidth: 1 },
        label: { text: new C.CallbackProperty(function () { return ex.name + "  " + st().state.toUpperCase() + "  " + st().local; }, false), font: "600 11px JetBrains Mono, monospace", fillColor: color("#fff"),
          outlineColor: color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -18), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.2e7) },
        gx: { type: "exchange", item: ex } });
    });
  }

  function loadBorders() {
    if (S.bordersLoaded) return;
    S.bordersLoaded = true;
    var ds = dataSource("borders");
    ds.show = !!S.layerOn.borders;
    C.GeoJsonDataSource.load(BORDERS_URL, { fill: C.Color.TRANSPARENT, stroke: color("#8B949E", 0.55), strokeWidth: 1 }).then(function (src) {
      src.entities.values.forEach(function (e) { if (e.polygon) { e.polygon.fill = false; e.polygon.outline = true; e.polygon.outlineColor = color("#9AA4B2", 0.5); e.polygon.height = 0; } });
      ds.entities.suspendEvents();
      src.entities.values.forEach(function (e) { ds.entities.add(e); });
      ds.entities.resumeEvents();
    }, function () { S.bordersLoaded = false; });
  }

  /* ---------- Events ---------- */
  function pointSize(ev) {
    if (ev.kind === "quake") return Math.max(4, Math.min(18, 4 + (ev.mag - 2.5) * 1.8));
    return { info: 7, elevated: 9, high: 12, critical: 15 }[ev.sev];
  }

  function setEvents(list) {
    S.events = list;
    if (!S.points) { S.points = new C.PointPrimitiveCollection(); V.scene.primitives.add(S.points); }
    S.points.removeAll();
    S.pointByEv.clear();
    list.forEach(function (ev) {
      var p = S.points.add({ position: pos(ev.lon, ev.lat, 3000), pixelSize: pointSize(ev), color: sevColor(ev.sev, 0.92), outlineColor: color("#000", 0.55), outlineWidth: 1,
        scaleByDistance: new C.NearFarScalar(1.5e6, 1.4, 3e7, 0.7) });
      p.id = { gx: { type: "event", item: ev } };
      S.pointByEv.set(ev, p);
    });
    S.beaconSig = S.stormSig = "";
    refresh();
  }

  function setLayer(id, on) {
    S.layerOn[id] = on;
    if (S.ds[id]) S.ds[id].show = on;
    if (id === "borders" && on && S.ready) loadBorders();
    refresh();
  }

  function setPredicate(fn) { S.predicate = fn; refresh(); }

  /* Beacons (light pillar + shockwave ring) for the most severe or freshest visible events. */
  function rebuildBeacons(visible, recentMs) {
    var cand = visible.filter(function (e) { return GX.SEV[e.sev].rank >= 3 || S.timeMs - e.t < recentMs; })
      .sort(function (a, b) { return GX.SEV[b.sev].rank - GX.SEV[a.sev].rank || b.t - a.t; }).slice(0, MAX_BEACONS);
    var sig = cand.map(function (e) { return e.id; }).join("|");
    if (sig === S.beaconSig) return;
    S.beaconSig = sig;
    var ds = S.ds.beacons || dataSource("beacons");
    ds.entities.removeAll();
    cand.forEach(function (ev, i) {
      var rank = GX.SEV[ev.sev].rank, h = 90000 + rank * 70000, col = GX.SEV[ev.sev].color, r = Math.max(40000, Math.min(450000, ev.radiusKm * 1000 * 0.6));
      ds.entities.add({ polyline: { positions: [pos(ev.lon, ev.lat, 0), pos(ev.lon, ev.lat, h)], width: 3, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: color(col, 0.9) }) }, gx: { type: "event", item: ev } });
      var off = i * 370;
      function ph() { return ((performance.now() + off) % RING_PERIOD_MS) / RING_PERIOD_MS; }
      ds.entities.add({ position: pos(ev.lon, ev.lat, 0), gx: { type: "event", item: ev }, ellipse: {
        semiMajorAxis: new C.CallbackProperty(function () { return 8000 + r * ph(); }, false), semiMinorAxis: new C.CallbackProperty(function () { return 8000 + r * ph(); }, false),
        material: new C.ColorMaterialProperty(new C.CallbackProperty(function () { return color(col, 0.42 * (1 - ph())); }, false)), outline: true,
        outlineColor: new C.CallbackProperty(function () { return color(col, 0.9 * (1 - ph())); }, false), height: 0 } });
    });
  }

  function rebuildStorms(visible) {
    var storms = visible.filter(function (e) { return e.kind === "storm" && e.track; }).slice(0, 12);
    var sig = storms.map(function (e) { return e.id; }).join("|");
    if (sig === S.stormSig) return;
    S.stormSig = sig;
    var ds = S.ds.storms || dataSource("storms");
    ds.entities.removeAll();
    storms.forEach(function (ev) {
      var flat = []; ev.track.forEach(function (p) { flat.push(p.lon, p.lat, 4000); });
      if (ev.track.length > 1) ds.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(flat), width: 3, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.2, color: color("#A371F7", 0.9) }) }, gx: { type: "event", item: ev } });
      var cone = GX.stormCone(ev.track, 72, 12);
      if (cone) {
        var ring = []; cone.forEach(function (p) { ring.push(p.lon, p.lat); });
        ds.entities.add({ polygon: { hierarchy: C.Cartesian3.fromDegreesArray(ring), material: color("#A371F7", 0.16), outline: true, outlineColor: color("#A371F7", 0.7), height: 0 }, gx: { type: "event", item: ev } });
      }
    });
  }

  /* Re-evaluates which events show for the current time, layer toggles and HUD filters. */
  function refresh() {
    if (!S.points) return;
    var visible = [], recent = 60 * 60 * 1000;
    S.events.forEach(function (ev) {
      var p = S.pointByEv.get(ev), show = !!S.layerOn[ev.layer] && ev.t <= S.timeMs && S.predicate(ev);
      if (p.show !== show) p.show = show;
      if (show) visible.push(ev);
    });
    rebuildBeacons(visible, recent);
    rebuildStorms(visible);
  }

  /* ---------- Time ---------- */
  function setTime(ms) {
    S.timeMs = ms;
    V.clock.currentTime = C.JulianDate.fromDate(new Date(ms));
    if (Math.abs(ms - S.exStamp) > STATUS_REFRESH_MS) {
      S.exStamp = ms;
      GX.EXCHANGES.forEach(function (ex) { S.exStatus[ex.id] = GX.marketStatus(ex, ms); });
    }
  }

  /* ---------- Camera ---------- */
  function stopOrbit() {
    if (!S.orbit) return;
    S.orbit = null;
    V.camera.lookAtTransform(C.Matrix4.IDENTITY);
  }

  function flyTo(lat, lon, opts) {
    var o = opts || {}, cam = V.camera;
    stopOrbit();
    var range = o.range || 350000, center = pos(lon, lat, 0), pitch = C.Math.toRadians(o.pitch == null ? FLY_PITCH_DEG : o.pitch);
    cam.flyToBoundingSphere(new C.BoundingSphere(center, 1), {
      duration: o.duration == null ? 2.8 : o.duration, offset: new C.HeadingPitchRange(cam.heading, pitch, range),
      complete: function () { if (o.orbit) S.orbit = { center: center, heading: cam.heading, pitch: pitch, range: range, last: performance.now() }; }
    });
  }

  function viewHome(duration) {
    stopOrbit();
    V.camera.flyTo({ destination: pos(15, 22, 2.3e7), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 }, duration: duration == null ? 2 : duration });
  }

  function tickOrbit() {
    if (!S.orbit) return;
    var now = performance.now(), dt = Math.min(0.1, (now - S.orbit.last) / 1000), o = S.orbit;
    o.last = now; o.heading += ORBIT_RAD_PER_S * dt;
    V.camera.lookAt(o.center, new C.HeadingPitchRange(o.heading, o.pitch, o.range));
  }

  /* ---------- Selection ---------- */
  function select(ev) {
    S.selected = ev;
    if (S.impact) { V.entities.remove(S.impact); S.impact = null; }
    if (!ev) return;
    var r = Math.max(8000, (ev.radiusKm || 20) * 1000), col = GX.SEV[ev.sev].color;
    S.impact = V.entities.add({ position: pos(ev.lon, ev.lat, 0), ellipse: { semiMajorAxis: r, semiMinorAxis: r, material: color(col, 0.14), outline: true, outlineColor: color(col, 0.95), outlineWidth: 2, height: 0 } });
  }

  function bindInput() {
    var h = new C.ScreenSpaceEventHandler(V.scene.canvas), canvas = V.scene.canvas, last = 0;
    h.setInputAction(function (e) {
      var picked = V.scene.pick(e.position), id = picked && picked.id, ref = id && (id.gx || (id.id && id.id.gx));
      if (ref && S.onPick) S.onPick(ref);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction(function (e) {
      var now = performance.now();
      if (now - last < 60) return;
      last = now;
      var picked = V.scene.pick(e.endPosition), id = picked && picked.id;
      canvas.style.cursor = id && (id.gx || (id.id && id.id.gx)) ? "pointer" : "";
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    ["pointerdown", "wheel", "touchstart"].forEach(function (n) { canvas.addEventListener(n, stopOrbit, { passive: true }); });
  }

  /* Ground elevation in metres, or null when only flat imagery is loaded. */
  function sampleElevation(lat, lon) {
    if (!S.terrain) return Promise.resolve(null);
    return C.sampleTerrainMostDetailed(S.terrain, [C.Cartographic.fromDegrees(lon, lat)]).then(function (r) { var h = r[0] && r[0].height; return isFinite(h) ? h : null; }, function () { return null; });
  }

  /* ---------- Boot ---------- */
  function boot(container) {
    return loadCesium().then(function (cesium) {
      C = cesium;
      createViewer(container);
      buildRoutes();
      S.ready = true;
      setTime(Date.now());
      Object.keys(S.ds).forEach(function (id) { S.ds[id].show = !!S.layerOn[id]; });
      V.scene.preRender.addEventListener(function () { tickOrbit(); if (S.onFrame) S.onFrame(); });
      V.scene.postRender.addEventListener(function () {
        S.frames++;
        var now = performance.now();
        if (now - S.fpsStamp >= 1000) { S.fps = Math.round(S.frames * 1000 / (now - S.fpsStamp)); S.frames = 0; S.fpsStamp = now; }
      });
      bindInput();
      V.camera.setView({ destination: pos(15, 22, 2.6e7) });
      if (S.layerOn.borders) loadBorders();
      return setBasemap("photo");
    });
  }

  GX.scene = {
    boot: boot, setBasemap: setBasemap, setEvents: setEvents, setLayer: setLayer, setPredicate: setPredicate, refresh: refresh, setTime: setTime,
    sampleElevation: sampleElevation, flyTo: flyTo, viewHome: viewHome, stopOrbit: stopOrbit, select: select, getTime: function () { return S.timeMs; },
    onPick: function (fn) { S.onPick = fn; }, onFrame: function (fn) { S.onFrame = fn; },
    fps: function () { return S.fps; }, isLayerOn: function (id) { return !!S.layerOn[id]; },
    setRendering: function (on) { if (V) V.useDefaultRenderLoop = !!on; },
    cameraInfo: function () {
      if (!V) return null;
      var c = V.camera.positionCartographic;
      return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude), alt: c.height, heading: C.Math.toDegrees(V.camera.heading), pitch: C.Math.toDegrees(V.camera.pitch) };
    },
    visibleCount: function () { var n = 0; S.pointByEv.forEach(function (p) { if (p.show) n++; }); return n; }
  };
})(globalThis);
