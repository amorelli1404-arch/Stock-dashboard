/* Multi-domain telemetry layers: aircraft, vessels, satellites, GNSS interference, cable landings, outages and
 * infrastructure. Keyless live feeds are tried first; where a browser cannot reach one (CORS, no free AIS) the layer
 * falls back to an illustrative simulation that is always labelled as such. */
(function (g) {
  "use strict";
  var GX = g.GX;
  if (!GX || typeof document === "undefined") return;
  (GX.onBoot = GX.onBoot || []).push(init);

  var SAT_LIB = "https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js";
  var SAT_SRI = "sha384-e6V1JVpc+kVNTxT0gEOla7yL4c92Romsw7itPoipfzHbEjzUwPhTv6oeVDMHHzqT";
  var TLE_API = "https://tle.ivanstanojevic.me/api/tle?page-size=60&search=";
  var SAT_QUERIES = [["NOAA", "Weather"], ["METOP", "Weather"], ["GOES", "Weather"], ["SENTINEL", "Earth observation"], ["LANDSAT", "Earth observation"], ["WORLDVIEW", "Imaging"], ["USA", "US government (public catalog)"], ["GPS", "Navigation"], ["ISS", "Space station"]];
  var ADSB = ["https://api.airplanes.live/v2/point/", "https://api.adsb.lol/v2/point/", "https://opendata.adsb.fi/api/v2/lat/"];
  var IODA = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?entityType=country";
  var BORDERS = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson";
  var AC_REFRESH_MS = 15000, AC_MAX_ALT_M = 4e6, AC_TRAIL = 10, SAT_TICK_MS = 1000, SIM_FLIGHTS = 46, VESSELS_PER_ARC = 7, FETCH_TIMEOUT_MS = 7000, KT_TO_MS = 0.514444, FT_TO_M = 0.3048;
  var LEO_MIN_MOTION = 6.4, PASS_STEP_S = 60, PASS_HOURS = 12, MIN_ELEV_DEG = 10;

  var I = (GX.intel = { state: { aircraft: { n: 0, military: 0, simulated: true, source: "" }, vessels: { n: 0, dark: 0 }, sats: { n: 0, status: "" }, outages: [], tle: null } });
  var X, C, V, hud;

  function rnd(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function mk(kind, title, lat, lon, sev, desc, extra) {
    return Object.assign({ id: kind + "-" + Math.abs(Math.round(lat * 1000)) + "-" + Math.abs(Math.round(lon * 1000)), kind: kind, layer: kind, cat: "intel", title: title, lat: lat, lon: lon, t: hud.timeMs(), sev: sev, desc: desc, source: "Reference", radiusKm: 0 }, extra || {});
  }
  function ref(item) { return { type: "generic", item: item }; }
  function visibleLayer(id) { return X.S.layerOn[id]; }

  function timedFetch(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------- Static reference layers ---------- */
  function buildStatic() {
    var gn = X.dataSource("gnss");
    GX.GNSS_ZONES.forEach(function (z, i) {
      var item = mk("gnss", "GNSS interference zone: " + z.name, z.lat, z.lon, "high", z.note + " Reference zone from public reporting, not a live measurement.", { radiusKm: z.r, source: "Public reporting (reference)" });
      item.id = "gnss-" + z.id;
      function ph() { return ((performance.now() + i * 400) % 3000) / 3000; }
      X.addE(gn.entities, { position: X.pos(z.lon, z.lat, 0), gx: ref(item), ellipse: { semiMajorAxis: z.r * 1000, semiMinorAxis: z.r * 1000, height: 0, outline: true,
        material: new C.ColorMaterialProperty(new C.CallbackProperty(function () { return X.color("#FF7B72", 0.12 + 0.12 * Math.sin(ph() * Math.PI * 2)); }, false)), outlineColor: X.color("#FF7B72", 0.85) } });
      X.addE(gn.entities, { position: X.pos(z.lon, z.lat, 0), gx: ref(item), label: { text: "GNSS", font: "700 10px JetBrains Mono, monospace", fillColor: X.color("#FFB4AD"), outlineColor: X.color("#000"), outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.4e7) } });
    });
    var ld = X.dataSource("landings");
    GX.LANDINGS.forEach(function (l) {
      var item = mk("landing", "Cable landing station: " + l.name, l.lat, l.lon, "info", "Approximate submarine cable landing site. A cut or outage here can degrade regional connectivity.", { flyRange: 400000, source: "Reference" });
      X.addE(ld.entities, { position: X.pos(l.lon, l.lat, 0), gx: ref(item), point: { pixelSize: 7, color: X.color("#79C0FF"), outlineColor: X.color("#fff", 0.8), outlineWidth: 1 },
        label: { text: l.name, font: "10px JetBrains Mono, monospace", fillColor: X.color("#CFE4FF"), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -12), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 4e6) } });
    });
    var inf = X.dataSource("infra");
    GX.INFRA.forEach(function (p) {
      var T = GX.INFRA_TYPES[p.t], item = mk("infra", p.n + " (" + T.label + ")", p.lat, p.lon, "info", "Reference asset. Sensitivity: " + T.tags.join(", ") + ".", { flyRange: 300000, radiusKm: p.r || 0, source: "Reference (approximate)" });
      X.addE(inf.entities, { position: X.pos(p.lon, p.lat, 0), gx: ref(item), point: { pixelSize: 6, color: X.color(T.color), outlineColor: X.color("#000", 0.6), outlineWidth: 1 },
        label: { text: p.n, font: "10px JetBrains Mono, monospace", fillColor: X.color(T.color), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -11), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.5e6) } });
    });
  }

  /* ---------- Vessels (simulated AIS) ---------- */
  var vessels = [], vesselPts, vesselTrails;
  function buildVessels() {
    var rng = rnd(20260101), kinds = ["Tanker", "Container ship", "Bulk carrier", "LNG carrier"], colors = { Tanker: "#FFA657", "Container ship": "#56D4DD", "Bulk carrier": "#A5D6FF", "LNG carrier": "#D2A8FF" };
    vesselPts = new C.PointPrimitiveCollection(); vesselTrails = new C.PolylineCollection();
    X.dataSource("vessels");
    V.scene.primitives.add(vesselPts); V.scene.primitives.add(vesselTrails);
    GX.SHIP_ARCS.forEach(function (arc) {
      var path = GX.greatCircle(arc.from[0], arc.from[1], arc.to[0], arc.to[1], 120, 0);
      for (var k = 0; k < VESSELS_PER_ARC; k++) {
        var kind = kinds[Math.floor(rng() * kinds.length)], dark = rng() < 0.14, v = { id: "SIM-" + String(100000 + Math.floor(rng() * 899999)), kind: kind, route: arc.name, path: path, phase: rng(), speedKn: 11 + Math.round(rng() * 7), dark: dark, gapH: dark ? 6 + Math.round(rng() * 24) : 0, color: colors[kind] };
        v.pt = vesselPts.add({ position: X.pos(0, 0, 0), pixelSize: dark ? 8 : 5, color: X.color(dark ? "#FF7B72" : v.color), outlineColor: dark ? X.color("#FF7B72", 0.9) : X.color("#000", 0.5), outlineWidth: dark ? 3 : 1, show: true });
        v.trail = vesselTrails.add({ positions: [X.pos(0, 0, 0), X.pos(0, 0, 0)], width: 1.5, material: C.Material.fromType("Color", { color: X.color(dark ? "#FF7B72" : v.color, 0.55) }) });
        v.item = mk("vessel", kind + " " + v.id, 0, 0, dark ? "high" : "info", "", { id: "vessel-" + v.id, source: "Simulated AIS (no free live AIS feed)", flyRange: 250000 });
        v.pt.id = { gx: ref(v.item) };
        vessels.push(v);
      }
    });
    updateVessels();
  }

  function vesselAt(v, ph) { var i = Math.min(v.path.length - 1, Math.max(0, Math.floor(ph * (v.path.length - 1)))); return v.path[i]; }

  function updateVessels() {
    var on = visibleLayer("vessels"), now = hud.timeMs(), dark = 0;
    vessels.forEach(function (v) {
      v.pt.show = on; v.trail.show = on;
      if (!on) return;
      var ph = (v.phase + now / (86400000 * 40)) % 1, p = vesselAt(v, ph), q = vesselAt(v, (ph + 0.985) % 1);
      v.lat = p.lat; v.lon = p.lon;
      v.item.lat = p.lat; v.item.lon = p.lon;
      v.item.desc = "SIMULATED vessel on the " + v.route + " lane, about " + v.speedKn + " kn." + (v.dark ? " Transponder gap of " + v.gapH + " h: flagged as a possible dark vessel. This is illustrative data, not a real vessel." : " Illustrative position, not a real vessel.");
      v.pt.position = X.pos(p.lon, p.lat, 50);
      if (Math.abs(q.lon - p.lon) < 90) v.trail.positions = [X.pos(q.lon, q.lat, 50), X.pos(p.lon, p.lat, 50)];
      if (v.dark) dark++;
    });
    I.state.vessels = { n: on ? vessels.length : 0, dark: on ? dark : 0, simulated: true };
  }

  /* ---------- Aircraft ---------- */
  var aircraft = new Map(), acPts, acTrails, simFlights = [], acArcs, acLive = null, acBusy = false, acLast = 0;
  var AIRPORTS = null;

  function buildAircraft() {
    X.dataSource("aircraft");
    acPts = new C.PointPrimitiveCollection(); acTrails = new C.PolylineCollection(); acArcs = new C.PolylineCollection();
    [acArcs, acTrails, acPts].forEach(function (p) { V.scene.primitives.add(p); });
    var rng = rnd(77), hubs = GX.INFRA.filter(function (p) { return p.t === "airport"; });
    AIRPORTS = hubs;
    for (var i = 0; i < SIM_FLIGHTS; i++) {
      var a = hubs[Math.floor(rng() * hubs.length)], b = hubs[Math.floor(rng() * hubs.length)];
      if (a === b || GX.haversineKm(a.lat, a.lon, b.lat, b.lon) < 1500) { i--; continue; }
      var path = GX.greatCircle(a.lon, a.lat, b.lon, b.lat, 80, 11000);
      var f = { id: "SIM" + (100 + i), from: a.n, to: b.n, path: path, phase: rng(), period: 8 + rng() * 6 };
      f.pt = acPts.add({ position: X.pos(0, 0, 0), pixelSize: 5, color: X.color("#E6EDF3"), outlineColor: X.color("#000", 0.5), outlineWidth: 1 });
      f.item = mk("aircraft", "SIMULATED flight " + f.id + ": " + a.n + " to " + b.n, a.lat, a.lon, "info", "Illustrative traffic between major airports, not a real flight.", { id: "simac-" + f.id, source: "Simulation", flyRange: 900000 });
      f.pt.id = { gx: ref(f.item) };
      f.trail = acTrails.add({ positions: [X.pos(0, 0, 0), X.pos(0, 0, 0)], width: 1.5, material: C.Material.fromType("Color", { color: X.color("#E6EDF3", 0.5) }) });
      var flat = []; path.forEach(function (p) { flat.push(p.lon, p.lat, p.h); });
      f.arc = acArcs.add({ positions: C.Cartesian3.fromDegreesArrayHeights(flat), width: 1, material: C.Material.fromType("Color", { color: X.color("#8B949E", 0.22) }) });
      simFlights.push(f);
    }
  }

  function updateSimFlights(on) {
    var now = hud.timeMs();
    simFlights.forEach(function (f) {
      var show = on && !acLive;
      f.pt.show = f.trail.show = f.arc.show = show;
      if (!show) return;
      var ph = (f.phase + now / (3600000 * f.period)) % 1, i = Math.min(f.path.length - 1, Math.floor(ph * (f.path.length - 1))), p = f.path[i], q = f.path[Math.max(0, i - 3)];
      f.lat = p.lat; f.lon = p.lon; f.alt = p.h; f.item.lat = p.lat; f.item.lon = p.lon;
      f.pt.position = X.pos(p.lon, p.lat, p.h);
      if (Math.abs(q.lon - p.lon) < 90) f.trail.positions = [X.pos(q.lon, q.lat, q.h), X.pos(p.lon, p.lat, p.h)];
    });
    if (on && !acLive) I.state.aircraft = { n: simFlights.length, military: 0, simulated: true, source: "Illustrative traffic between major airports (live ADS-B unreachable from this browser)" };
  }

  function parseAc(list) {
    var out = [];
    (list || []).forEach(function (a) {
      var lat = Number(a.lat), lon = Number(a.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      var alt = a.alt_baro === "ground" ? 0 : Number(a.alt_baro) * FT_TO_M;
      out.push({ hex: String(a.hex || "").slice(0, 8), call: String(a.flight || "").trim().slice(0, 10), lat: lat, lon: lon, alt: isFinite(alt) ? alt : 0, track: Number(a.track) || 0, gs: Number(a.gs) || 0,
        mil: !!(Number(a.dbFlags) & 1), type: String(a.t || "").slice(0, 6) });
    });
    return out;
  }

  function fetchAircraft(lat, lon) {
    var i = 0;
    function next() {
      if (i >= ADSB.length) return Promise.reject(new Error("no ADS-B provider reachable"));
      var url = ADSB[i] + (i === 2 ? lat.toFixed(3) + "/lon/" + lon.toFixed(3) + "/dist/250" : lat.toFixed(3) + "/" + lon.toFixed(3) + "/250");
      i++;
      return timedFetch(url).then(function (r) { return r.json(); }).then(function (j) { return parseAc(j.ac || j.aircraft); }).catch(next);
    }
    return next();
  }

  function applyAircraft(list, src) {
    var seen = {}, mil = 0;
    list.forEach(function (a) {
      var key = a.hex || a.call; seen[key] = true;
      var s = aircraft.get(key);
      if (!s) {
        s = { pt: acPts.add({ position: X.pos(a.lon, a.lat, a.alt), pixelSize: a.mil ? 7 : 4, color: X.color(a.mil ? "#FF7B72" : "#E6EDF3"), outlineColor: X.color("#000", 0.5), outlineWidth: 1 }), trail: acTrails.add({ positions: [], width: 1.5,
          material: C.Material.fromType("Color", { color: X.color(a.mil ? "#FF7B72" : "#E6EDF3", 0.55) }) }), hist: [] };
        aircraft.set(key, s);
      }
      s.a = a; s.hist.push(X.pos(a.lon, a.lat, a.alt)); if (s.hist.length > AC_TRAIL) s.hist.shift();
      s.pt.position = s.hist[s.hist.length - 1]; if (s.hist.length > 1) s.trail.positions = s.hist;
      if (a.mil) mil++;
      var item = mk("aircraft", (a.call || a.hex || "Aircraft") + (a.mil ? " (military flag)" : ""), a.lat, a.lon, a.mil ? "elevated" : "info",
        "Alt " + Math.round(a.alt) + " m, " + Math.round(a.gs) + " kt, track " + Math.round(a.track) + "°" + (a.type ? ", type " + a.type : "") + ". Position is from a public ADS-B feed; military status comes from the feed's database flag.", { source: src, flyRange: 60000, id: "ac-" + key });
      s.pt.id = { gx: ref(item) };
    });
    aircraft.forEach(function (s, key) { if (!seen[key]) { acPts.remove(s.pt); acTrails.remove(s.trail); aircraft.delete(key); } });
    I.state.aircraft = { n: aircraft.size, military: mil, simulated: false, source: src };
  }

  function pollAircraft() {
    if (acBusy || !visibleLayer("aircraft") || !hud) return;
    var cam = GX.scene.cameraInfo();
    if (!cam || cam.alt > AC_MAX_ALT_M) return;
    acBusy = true; acLast = performance.now();
    fetchAircraft(cam.lat, cam.lon).then(function (list) { acLive = true; applyAircraft(list, "ADS-B (public feed)"); }, function () {
      if (acLive === null) { acLive = false; hud.toast("Live ADS-B is not reachable from this browser. Showing illustrative air traffic.", ""); }
    }).then(function () { acBusy = false; });
  }

  function updateAircraft() {
    var on = visibleLayer("aircraft");
    acPts.show = acTrails.show = acArcs.show = on;
    updateSimFlights(on);
    if (!on) { I.state.aircraft.n = 0; return; }
    if (performance.now() - acLast > AC_REFRESH_MS) pollAircraft();
  }

  /* ---------- Satellites ---------- */
  var sats = [], satPts, satLib = null, satSel = null, satEnts = null, satStamp = 0, satLoading = false;

  function loadSatLib() {
    if (g.satellite) return Promise.resolve(g.satellite);
    if (satLib) return satLib;
    satLib = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SAT_LIB; s.integrity = SAT_SRI; s.crossOrigin = "anonymous"; s.onload = function () { g.satellite ? resolve(g.satellite) : reject(new Error("satellite.js missing")); };
      s.onerror = function () { satLib = null; reject(new Error("could not load satellite.js")); };
      document.head.appendChild(s);
    });
    return satLib;
  }

  function loadSats() {
    if (satLoading || sats.length) return;
    satLoading = true; I.state.sats.status = "Loading orbital elements…";
    Promise.all([loadSatLib()].concat(SAT_QUERIES.map(function (q) {
      return timedFetch(TLE_API + encodeURIComponent(q[0])).then(function (r) { return r.json(); }).then(function (j) { return (j.member || []).map(function (m) { return { m: m, cls: q[1] }; }); }).catch(function () { return []; });
    }))).then(function (res) {
      var lib = res[0], seen = {}, items = [].concat.apply([], res.slice(1));
      items.forEach(function (it) {
        var m = it.m; if (!m.line1 || !m.line2 || seen[m.satelliteId]) return;
        /* The public catalog also lists debris, rocket bodies and ISS sub-modules; keep one entry per real spacecraft. */
        if (/\b(DEB|R\/B|OBJECT)\b|^ISS \((?!ZARYA)/i.test(String(m.name))) return;
        seen[m.satelliteId] = true;
        var rec = lib.twoline2satrec(m.line1, m.line2);
        if (!rec || rec.error) return;
        var s = { name: String(m.name || "SAT").slice(0, 40), id: m.satelliteId, cls: it.cls, rec: rec, leo: rec.no * 1440 / (2 * Math.PI) > LEO_MIN_MOTION, epoch: m.date };
        s.pt = satPts.add({ position: X.pos(0, 0, 0), pixelSize: s.cls.indexOf("US government") === 0 ? 6 : 4, color: X.color(s.cls.indexOf("US government") === 0 ? "#FF7B72" : s.cls === "Weather" ? "#A5D6FF" : "#D2A8FF"), outlineColor: X.color("#000", 0.5), outlineWidth: 1 });
        sats.push(s);
      });
      I.state.sats = { n: sats.length, status: sats.length ? "" : "No orbital elements could be loaded." };
      satLoading = false;
      if (!sats.length) hud.toast("Satellite orbital data could not be loaded.", "");
    }, function (e) { satLoading = false; I.state.sats.status = "Satellite data unavailable: " + e.message; hud.toast(I.state.sats.status, ""); });
  }

  function satState(s, ms) {
    var lib = g.satellite, d = new Date(ms), pv = lib.propagate(s.rec, d);
    if (!pv || !pv.position) return null;
    var gd = lib.eciToGeodetic(pv.position, lib.gstime(d));
    return { lat: gd.latitude, lon: gd.longitude, h: gd.height, latD: gd.latitude * 180 / Math.PI, lonD: gd.longitude * 180 / Math.PI };
  }

  function updateSats() {
    var on = visibleLayer("sats");
    satPts.show = on;
    if (on && !sats.length) loadSats();
    if (!on || !sats.length || !g.satellite) return;
    var now = hud.timeMs();
    if (Math.abs(now - satStamp) < SAT_TICK_MS && !I.satDirty) return;
    satStamp = now; I.satDirty = false;
    sats.forEach(function (s) {
      var st = satState(s, now);
      if (!st) { s.pt.show = false; return; }
      s.pt.show = true; s.st = st;
      s.pt.position = C.Cartesian3.fromRadians(st.lon, st.lat, st.h * 1000);
      if (!s.pt.id) {
        var item = mk("sat", s.name + " (" + s.cls + ")", st.latD, st.lonD, "info", "", { id: "sat-" + s.id, source: "TLE epoch " + (s.epoch || "n/a").slice(0, 10), satRef: s, flyRange: 6e6 });
        s.pt.id = { gx: ref(item) }; s.item = item;
      }
    });
    if (satSel) drawSatSelection();
  }

  function clearSatSelection() { satSel = null; if (satEnts) { satEnts.forEach(function (e) { V.entities.remove(e); }); satEnts = null; } }

  function drawSatSelection() {
    var s = satSel, st = s.st;
    if (!st) return;
    if (satEnts) satEnts.forEach(function (e) { V.entities.remove(e); });
    var foot = Math.min(GX.satHorizonKm(st.h) , 2800) * 1000, track = [];
    for (var m = -45; m <= 45; m += 3) { var q = satState(s, hud.timeMs() + m * 60000); if (q) track.push(q.lonD, q.latD, 0); }
    satEnts = [
      V.entities.add({ position: X.pos(st.lonD, st.latD, 0), ellipse: { semiMajorAxis: foot, semiMinorAxis: foot, height: 0, material: X.color("#D2A8FF", 0.14), outline: true, outlineColor: X.color("#D2A8FF", 0.85) } }),
      V.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArrayHeights(track), width: 2, arcType: C.ArcType.GEODESIC, material: new C.PolylineDashMaterialProperty({ color: X.color("#D2A8FF", 0.9), dashLength: 12 }) } }),
      V.entities.add({ polyline: { positions: [C.Cartesian3.fromRadians(st.lon, st.lat, st.h * 1000), X.pos(st.lonD, st.latD, 0)], width: 1.5, material: X.color("#D2A8FF", 0.7) } })
    ];
  }

  function describeSat(item) {
    var s = item.satRef, st = s.st;
    if (!st) return;
    item.lat = st.latD; item.lon = st.lonD;
    var per = 1440 / (s.rec.no * 1440 / (2 * Math.PI));
    item.desc = "Altitude " + Math.round(st.h) + " km, period " + per.toFixed(0) + " min, ground footprint radius about " + Math.round(Math.min(GX.satHorizonKm(st.h), 2800)) + " km. Orbit propagated from public two-line elements (" + (s.epoch || "epoch n/a").slice(0, 10) + "). Stale elements lose accuracy.";
  }

  /* Next passes over a point for LEO satellites: elevation above MIN_ELEV_DEG, scanned in chunks so the UI stays responsive. */
  I.overpasses = function (lat, lon, onDone) {
    var lib = g.satellite;
    if (!lib || !sats.length) { onDone(null); return; }
    var obs = { latitude: lat * Math.PI / 180, longitude: lon * Math.PI / 180, height: 0 }, start = hud.timeMs(), steps = PASS_HOURS * 3600 / PASS_STEP_S, list = sats.filter(function (s) { return s.leo; }), out = [], idx = 0;
    function one(s) {
      var inPass = false, first = null, maxEl = 0;
      for (var k = 0; k <= steps; k++) {
        var t = start + k * PASS_STEP_S * 1000, d = new Date(t), pv = lib.propagate(s.rec, d);
        if (!pv || !pv.position) continue;
        var look = lib.ecfToLookAngles(obs, lib.eciToEcf(pv.position, lib.gstime(d))), el = look.elevation * 180 / Math.PI;
        if (el >= MIN_ELEV_DEG) { if (!inPass) { inPass = true; first = t; } if (el > maxEl) maxEl = el; }
        else if (inPass) break;
      }
      if (first != null) out.push({ name: s.name, cls: s.cls, t: first, maxEl: maxEl });
    }
    (function chunk() {
      var end = Math.min(list.length, idx + 12);
      for (; idx < end; idx++) one(list[idx]);
      if (idx < list.length) setTimeout(chunk, 0); else onDone(out.sort(function (a, b) { return a.t - b.t; }));
    })();
  };

  /* ---------- Internet outages (IODA) ---------- */
  var centroids = null, outageEnts = null;
  function loadCentroids() {
    if (centroids) return Promise.resolve(centroids);
    return timedFetch(BORDERS).then(function (r) { return r.json(); }).then(function (j) {
      centroids = {};
      (j.features || []).forEach(function (f) {
        var code = f.properties && (f.properties.ISO_A2 || f.properties.ISO_A2_EH), polys = f.geometry && (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates);
        if (!code || !polys) return;
        var best = null, area = -1;
        polys.forEach(function (p) {
          var xs = p[0].map(function (c) { return c[0]; }), ys = p[0].map(function (c) { return c[1]; }), a = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * (Math.max.apply(null, ys) - Math.min.apply(null, ys));
          if (a > area) { area = a; best = [(Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2, (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2]; }
        });
        if (best) centroids[code] = best;
      });
      return centroids;
    });
  }

  function loadOutages() {
    if (outageEnts) return;
    outageEnts = X.dataSource("outages");
    var now = Math.floor(Date.now() / 1000);
    Promise.all([timedFetch(IODA + "&from=" + (now - 86400) + "&until=" + now).then(function (r) { return r.json(); }), loadCentroids()]).then(function (res) {
      var rows = (res[0].data || []).filter(function (d) { return d.event_cnt >= 1 && d.entity && centroids[d.entity.code]; }).sort(function (a, b) { return b.scores.overall - a.scores.overall; }).slice(0, 14);
      rows.forEach(function (d) {
        var c = centroids[d.entity.code], sev = d.event_cnt >= 3 ? "high" : "elevated";
        var item = mk("outage", "Internet disruption signals: " + d.entity.name, c[1], c[0], sev, d.event_cnt + " outage signal(s) in the last 24 h across IODA's BGP, active-probing and darknet sources. Placed at the country's centre; the affected area may be local.", { id: "outage-" + d.entity.code, source: "Georgia Tech IODA", flyRange: 2500000 });
        X.addE(outageEnts.entities, { position: X.pos(c[0], c[1], 0), gx: ref(item), point: { pixelSize: 11, color: X.color(sev === "high" ? "#FFA657" : "#F2CC60", 0.9), outlineColor: X.color("#fff", 0.8), outlineWidth: 1 },
          label: { text: d.entity.code + " ×" + d.event_cnt, font: "700 10px JetBrains Mono, monospace", fillColor: X.color("#FFE1B3"), outlineColor: X.color("#000"), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new C.Cartesian2(0, -14), distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2e7) } });
        I.state.outages.push({ code: d.entity.code, name: d.entity.name, lat: c[1], lon: c[0], n: d.event_cnt });
      });
    }, function (e) { outageEnts = null; hud.toast("Internet outage data unavailable: " + e.message, ""); });
  }

  /* ---------- Wiring ---------- */
  function onLayer(id, on) { if (!on || !hud) return; if (id === "outages") loadOutages(); if (id === "sats") loadSats(); if (id === "aircraft") { acLast = 0; pollAircraft(); } }

  /* Dossier extras for orbital objects: footprint, ground track and refreshed description. */
  function onDossier(ev) {
    if (ev && ev.kind === "sat" && ev.satRef) { clearSatSelection(); satSel = ev.satRef; describeSat(ev); drawSatSelection(); }
    else clearSatSelection();
  }

  function init(h) {
    hud = h; X = GX.scene.ctx(); C = X.C; V = X.V;
    buildStatic(); buildVessels(); buildAircraft();
    satPts = new C.PointPrimitiveCollection(); V.scene.primitives.add(satPts);
    X.dataSource("sats");
    Object.keys(X.S.ds).forEach(function (id) { X.S.ds[id].show = !!X.S.layerOn[id]; });
    GX.scene.onLayer(onLayer);
    var last = 0;
    GX.scene.onFrame(function () {
      var now = performance.now();
      if (now - last < 100) return;
      last = now;
      updateVessels(); updateAircraft(); updateSats();
    });
    h.onDossier(onDossier);
    if (X.S.layerOn.sats) loadSats();
  }

  I.hasSats = function () { return sats.length > 0; };
  I.vesselList = function () { return vessels; };
  I.aircraftList = function () { return aircraft.size ? Array.from(aircraft.values()).map(function (s) { return s.a; }) : simFlights.filter(function (f) { return f.lat != null; }).map(function (f) { return { lat: f.lat, lon: f.lon, hex: f.id, call: f.id, mil: false }; }); };
  I.outageList = function () { return I.state.outages; };
})(globalThis);
