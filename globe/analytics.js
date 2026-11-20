/* Spatial analytics: geofences, exposure queries, line of sight, threat rating, rule-based briefing and share-state
 * encoding. Pure functions, no DOM or Cesium, so they run in Node for tests. */
(function (g) {
  "use strict";
  var GX = (g.GX = g.GX || {});
  var R_KM = 6371.0088;
  function rad(d) { return d * Math.PI / 180; }

  GX.haversineKm = function (lat1, lon1, lat2, lon2) {
    var dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
    var a = Math.pow(Math.sin(dp / 2), 2) + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  /* Ray casting on lon/lat. Fences that cross the antimeridian are not supported. */
  GX.pointInPolygon = function (lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /* fence: {type:"circle", lat, lon, rKm} or {type:"polygon", ring:[[lon,lat],...]} */
  GX.inFence = function (f, lat, lon) {
    if (f.type === "circle") return GX.haversineKm(f.lat, f.lon, lat, lon) <= f.rKm;
    return f.ring && f.ring.length >= 3 ? GX.pointInPolygon(lat, lon, f.ring) : false;
  };

  /* Cumulative exposure per ring: everything within radius r of the point. Agricultural belts count when their edge is inside. */
  GX.exposure = function (lat, lon, radiiKm, infra) {
    var rows = infra.map(function (it) { return { item: it, d: GX.haversineKm(lat, lon, it.lat, it.lon) }; });
    return radiiKm.map(function (r) {
      var items = rows.filter(function (x) { return x.d <= r + (x.item.r || 0); }).sort(function (a, b) { return a.d - b.d; });
      var counts = {};
      items.forEach(function (x) { counts[x.item.t] = (counts[x.item.t] || 0) + 1; });
      return { r: r, items: items, counts: counts };
    });
  };

  GX.exposureTags = function (items) {
    var n = {};
    items.forEach(function (x) { (GX.INFRA_TYPES[x.item.t].tags || []).forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
  };

  /* Line of sight over sampled ground heights (metres, evenly spaced from A to B) with earth curvature and standard refraction. */
  GX.losProfile = function (heights, distKm, obsH, tgtH, k) {
    var n = heights.length, D = distKm * 1000, kk = k || 1.333, hA = heights[0] + (obsH || 0), hB = heights[n - 1] + (tgtH || 0);
    var minClear = Infinity, blockedAtKm = null;
    for (var i = 1; i < n - 1; i++) {
      var d = D * i / (n - 1), bulge = d * (D - d) / (2 * R_KM * 1000 * kk), line = hA + (hB - hA) * d / D, clear = line - (heights[i] + bulge);
      if (clear < minClear) minClear = clear;
      if (clear < 0 && blockedAtKm == null) blockedAtKm = d / 1000;
    }
    return { visible: blockedAtKm == null, blockedAtKm: blockedAtKm, minClearanceM: isFinite(minClear) ? minClear : null };
  };

  /* Worst event decides the rating; repeated lower-severity events escalate it one step. Minor events never add up on their own. */
  GX.threatRating = function (events) {
    var n = { critical: 0, high: 0, elevated: 0 };
    events.forEach(function (e) { if (n[e.sev] != null) n[e.sev]++; });
    if (n.critical || n.high >= 4) return "CRITICAL";
    if (n.high || n.elevated >= 8) return "HIGH";
    return n.elevated ? "ELEVATED" : "LOW";
  };

  var RANK = { LOW: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };
  function worst(a, b) { return RANK[a] >= RANK[b] ? a : b; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  /* Rule-based situation briefing over what is in scope. This is templated text, not a language model. */
  GX.buildBriefing = function (c) {
    var ev = c.events || [], sections = [], rating = ev.length ? GX.threatRating(ev) : "LOW";
    var byKind = {};
    ev.forEach(function (e) { (byKind[e.kind] = byKind[e.kind] || []).push(e); });
    var hazards = [];
    if (byKind.quake) { var q = byKind.quake.slice().sort(function (a, b) { return b.mag - a.mag; })[0]; hazards.push(plural(byKind.quake.length, "earthquake") + ", strongest M " + q.mag.toFixed(1) + " (" + q.title.replace(/^M [\d.]+ - /, "") + ")"); }
    if (byKind.storm) { var s = byKind.storm.slice().sort(function (a, b) { return (b.wind || 0) - (a.wind || 0); })[0]; hazards.push(plural(byKind.storm.length, "tropical system") + ", " + s.title + (s.wind ? " at " + s.wind + " kt" : "")); }
    if (byKind.wildfire) hazards.push(plural(byKind.wildfire.length, "wildfire"));
    if (byKind.volcano) hazards.push(plural(byKind.volcano.length, "volcanic alert"));
    var hz = ev.filter(function (e) { return e.cat === "nature"; });
    sections.push({ title: "Natural hazards", rating: hz.length ? GX.threatRating(hz) : "LOW", lines: hazards.length ? hazards : ["No natural-hazard events in scope."] });

    var macro = ev.filter(function (e) { return e.cat === "macro"; });
    sections.push({ title: "Macro and geopolitical", rating: macro.length ? GX.threatRating(macro) : "LOW",
      lines: macro.length ? macro.slice(0, 4).map(function (e) { return e.title; }) : ["No macro or geopolitical items in scope."] });

    var sc = [], scRating = "LOW";
    if ((c.chokepoints || []).length) { sc.push("Chokepoints in scope: " + c.chokepoints.join(", ") + "."); scRating = "ELEVATED"; }
    if (c.vessels && c.vessels.count) {
      sc.push(plural(c.vessels.count, "tracked vessel") + (c.vessels.dark ? ", " + c.vessels.dark + " with transponder gaps (possible dark activity)" : "") + (c.vessels.simulated ? " [simulated feed]" : "") + ".");
      if (c.vessels.dark) scRating = worst(scRating, "HIGH");
    }
    if ((c.exposed || []).length) { sc.push("Exposed assets: " + c.exposed.slice(0, 5).join(", ") + "."); scRating = worst(scRating, "ELEVATED"); }
    if ((c.tags || []).length) sc.push("Sensitivity: " + c.tags.slice(0, 6).join(", ") + ".");
    sections.push({ title: "Supply chain", rating: scRating, lines: sc.length ? sc : ["No supply-chain exposure identified."] });

    var air = [], airRating = "LOW";
    if (c.aircraft && c.aircraft.count) { air.push(plural(c.aircraft.count, "aircraft") + " tracked" + (c.aircraft.military ? ", " + c.aircraft.military + " flagged military" : "") + (c.aircraft.simulated ? " [simulated feed]" : "") + "."); }
    if ((c.gnss || []).length) { air.push("GNSS interference zones: " + c.gnss.join(", ") + "."); airRating = "HIGH"; }
    sections.push({ title: "Airspace and navigation", rating: airRating, lines: air.length ? air : ["No airspace or GNSS items in scope."] });

    var cyber = [], cyberRating = "LOW";
    if ((c.outages || []).length) { cyber.push("Internet disruption signals: " + c.outages.slice(0, 5).join(", ") + "."); cyberRating = c.outages.length >= 3 ? "HIGH" : "ELEVATED"; }
    sections.push({ title: "Cyber and connectivity", rating: cyberRating, lines: cyber.length ? cyber : ["No internet-outage signals in scope."] });

    if ((c.fenceAlerts || []).length) { sections.push({ title: "Geofence alerts", rating: "HIGH", lines: c.fenceAlerts.slice(0, 5) }); rating = worst(rating, "HIGH"); }
    sections.forEach(function (x) { rating = worst(rating, x.rating === "HIGH" && x.title !== "Geofence alerts" ? "ELEVATED" : x.rating); });

    var top = ev.slice().sort(function (a, b) { return (GX.SEV[b.sev].rank - GX.SEV[a.sev].rank) || (b.t - a.t); })[0];
    return { rating: rating, scope: c.scope || "Global", headline: rating + ": " + plural(ev.length, "active event") + " in " + (c.scope || "view") + (top ? ". Highest severity: " + top.title + " (" + GX.SEV[top.sev].label + ")" : "") + ".", sections: sections, generated: c.now };
  };

  /* ---------- Share state ---------- */
  function b64(s) { return (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"); }

  GX.encodeState = function (st) { return b64(unescape(encodeURIComponent(JSON.stringify(st)))); };

  /* Returns a sanitised state or null. Every field is range-checked because the link may come from anyone. */
  GX.decodeState = function (str) {
    var o;
    try { o = JSON.parse(decodeURIComponent(escape(unb64(String(str || ""))))); } catch (e) { return null; }
    if (!o || typeof o !== "object") return null;
    function num(v, lo, hi) { v = Number(v); return isFinite(v) && v >= lo && v <= hi ? v : null; }
    var out = { lat: num(o.lat, -90, 90), lon: num(o.lon, -180, 180), alt: num(o.alt, 10, 6e7), h: num(o.h, -360, 360), p: num(o.p, -90, 90), t: num(o.t, 0, 4e12) };
    if (out.lat == null || out.lon == null || out.alt == null) return null;
    out.base = typeof o.base === "string" && /^[a-z]{3,12}$/.test(o.base) ? o.base : null;
    out.win = typeof o.win === "string" && /^[a-z0-9]{2,8}$/.test(o.win) ? o.win : null;
    out.layers = Array.isArray(o.layers) ? o.layers.filter(function (x) { return typeof x === "string" && /^[a-z]{3,12}$/.test(x); }).slice(0, 30) : null;
    out.sel = typeof o.sel === "string" && /^[\w.:-]{1,60}$/.test(o.sel) ? o.sel : null;
    return out;
  };

  /* Satellite ground footprint radius (km) for a given altitude, at zero elevation angle. */
  GX.satHorizonKm = function (altKm) { return R_KM * Math.acos(R_KM / (R_KM + altKm)); };
})(globalThis);
