/* World event intelligence: constants, normalisers for the live feeds and pure geo helpers.
 * No DOM and no Cesium here so it loads in Node for tests. Everything attaches to globalThis.GX. */
(function (g) {
  "use strict";
  var GX = (g.GX = g.GX || {});

  var EARTH_KM = 6371.0088;
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }

  GX.SEV = {
    critical: { label: "Critical", color: "#EF5350", rank: 4 },
    high: { label: "High", color: "#FFA726", rank: 3 },
    elevated: { label: "Elevated", color: "#FFEE58", rank: 2 },
    info: { label: "Informational", color: "#26A69A", rank: 1 }
  };

  GX.LAYERS = [
    { id: "macro", label: "Macro & Geopolitical", color: "#58A6FF" },
    { id: "quake", label: "Earthquakes", color: "#EF5350" },
    { id: "storm", label: "Cyclones & Storms", color: "#A371F7" },
    { id: "wildfire", label: "Wildfires", color: "#FFA726" },
    { id: "volcano", label: "Volcanoes", color: "#F85149" },
    { id: "supply", label: "Shipping & Chokepoints", color: "#2DD4BF" },
    { id: "air", label: "Flight Corridors", color: "#C9D1D9" },
    { id: "cables", label: "Undersea Cables", color: "#79C0FF" },
    { id: "markets", label: "Market Hubs", color: "#3FB950" },
    { id: "borders", label: "Country Borders", color: "#8B949E" },
    { id: "aircraft", label: "Aircraft (ADS-B)", color: "#E6EDF3", off: true },
    { id: "vessels", label: "Vessels (AIS, simulated)", color: "#56D4DD" },
    { id: "sats", label: "Satellites", color: "#D2A8FF" },
    { id: "gnss", label: "GNSS interference zones", color: "#FF7B72" },
    { id: "landings", label: "Cable landing stations", color: "#79C0FF" },
    { id: "outages", label: "Internet outages", color: "#FFA657", off: true },
    { id: "infra", label: "Infrastructure reference", color: "#F2CC60", off: true }
  ];

  /* ---------- Severity ---------- */
  GX.sevFromQuake = function (m) { return m >= 7 ? "critical" : m >= 6 ? "high" : m >= 5 ? "elevated" : "info"; };
  GX.sevFromWind = function (kt) { return kt >= 96 ? "critical" : kt >= 64 ? "high" : kt >= 34 ? "elevated" : "info"; };

  /* Indicative felt/impact radius in km: a visual aid, not a hazard model. */
  GX.quakeRadiusKm = function (m) { return Math.max(5, Math.pow(10, 0.5 * m - 1.3)); };

  /* ---------- Geo helpers ---------- */
  GX.destination = function (lat, lon, bearingDeg, distKm) {
    var d = distKm / EARTH_KM, b = rad(bearingDeg), p1 = rad(lat), l1 = rad(lon);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
  };

  GX.bearing = function (lat1, lon1, lat2, lon2) {
    var p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  };

  /* Points along the great circle with a parabolic arch of peakM metres, for animated 3D arcs. */
  GX.greatCircle = function (lon1, lat1, lon2, lat2, n, peakM) {
    var p1 = rad(lat1), l1 = rad(lon1), p2 = rad(lat2), l2 = rad(lon2);
    var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((l2 - l1) / 2), 2)));
    if (!d) return [{ lon: lon1, lat: lat1, h: 0 }];
    var out = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n, a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d);
      var x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
      var y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
      var z = a * Math.sin(p1) + b * Math.sin(p2);
      out.push({ lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)), h: 4 * (peakM || 0) * f * (1 - f) });
    }
    return out;
  };

  /* "37.77, -122.42" or "37.77 -122.42" -> {lat, lon}, or null when not a valid coordinate pair. */
  GX.parseCoords = function (text) {
    var m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(text || ""));
    if (!m) return null;
    var lat = Number(m[1]), lon = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat: lat, lon: lon } : null;
  };

  GX.fmtLat = function (v) { return Math.abs(v).toFixed(3) + "°" + (v >= 0 ? "N" : "S"); };
  GX.fmtLon = function (v) { return Math.abs(v).toFixed(3) + "°" + (v >= 0 ? "E" : "W"); };

  GX.timeAgo = function (ms, now) {
    var s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 90) return s + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 129600) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };

  /* ---------- Live feed normalisers ---------- */
  /* USGS GeoJSON summary feed. Magnitude and depth scale the marker and the impact radius. */
  GX.normalizeUsgs = function (json) {
    var out = [];
    ((json && json.features) || []).forEach(function (f) {
      var c = f && f.geometry && f.geometry.coordinates, p = f && f.properties;
      if (!c || !p || !isFinite(c[0]) || !isFinite(c[1]) || !isFinite(p.time)) return;
      var mag = p.mag == null ? NaN : Number(p.mag);
      if (!isFinite(mag)) return;
      out.push({
        id: "usgs-" + f.id, layer: "quake", cat: "nature", kind: "quake", title: p.title || "M " + mag.toFixed(1) + " earthquake",
        lat: c[1], lon: c[0], t: p.time, mag: mag, depthKm: isFinite(c[2]) ? c[2] : null, sev: GX.sevFromQuake(mag),
        url: p.url || null, source: "USGS", desc: (p.place || "") + (p.tsunami ? " (tsunami flag set)" : ""), radiusKm: GX.quakeRadiusKm(mag)
      });
    });
    return out.sort(function (a, b) { return b.t - a.t; });
  };

  var EONET_KIND = { wildfires: "wildfire", volcanoes: "volcano", severeStorms: "storm" };

  function centroid(coords) {
    var ring = Array.isArray(coords[0]) && Array.isArray(coords[0][0]) ? coords[0] : coords, sx = 0, sy = 0, n = 0;
    ring.forEach(function (p) { if (isFinite(p[0]) && isFinite(p[1])) { sx += p[0]; sy += p[1]; n++; } });
    return n ? [sx / n, sy / n] : null;
  }

  /* NASA EONET v3 events: wildfires, volcanoes and storms. Storm geometries are the observed track. */
  GX.normalizeEonet = function (json) {
    var out = [];
    ((json && json.events) || []).forEach(function (e) {
      var cat = (e.categories || [])[0], kind = cat && EONET_KIND[cat.id];
      if (!kind || !(e.geometry || []).length) return;
      var track = [];
      e.geometry.forEach(function (gm) {
        var pt = gm.type === "Point" ? gm.coordinates : centroid(gm.coordinates || []);
        var t = Date.parse(gm.date);
        if (pt && isFinite(pt[0]) && isFinite(pt[1]) && isFinite(t)) track.push({ t: t, lon: pt[0], lat: pt[1], wind: gm.magnitudeUnit === "kts" ? Number(gm.magnitudeValue) : null });
      });
      if (!track.length) return;
      track.sort(function (a, b) { return a.t - b.t; });
      var last = track[track.length - 1], wind = last.wind;
      out.push({
        id: "eonet-" + e.id, layer: kind, cat: "nature", kind: kind, title: e.title, lat: last.lat, lon: last.lon, t: last.t,
        sev: kind === "storm" ? GX.sevFromWind(wind || 0) : kind === "volcano" ? "high" : "elevated",
        wind: wind, track: kind === "storm" ? track : null, url: (e.sources && e.sources[0] && e.sources[0].url) || e.link || null,
        source: "NASA EONET", desc: (cat.title || "") + (wind ? " · max wind " + wind + " kt" : ""), radiusKm: kind === "storm" ? 120 + (wind || 0) * 2 : kind === "volcano" ? 30 : 25
      });
    });
    return out.sort(function (a, b) { return b.t - a.t; });
  };

  /* Illustrative storm cone: extrapolates the last observed heading and widens with time. Not an official forecast. */
  GX.stormCone = function (track, hours, stepHours) {
    if (!track || track.length < 2) return null;
    var a = track[track.length - 2], b = track[track.length - 1], head = GX.bearing(a.lat, a.lon, b.lat, b.lon);
    var kmh = 20, left = [], right = [];
    for (var h = 0; h <= hours; h += stepHours) {
      var c = GX.destination(b.lat, b.lon, head, kmh * h), r = 40 + h * 7;
      left.push(GX.destination(c.lat, c.lon, head - 90, r));
      right.push(GX.destination(c.lat, c.lon, head + 90, r));
    }
    return left.concat(right.reverse());
  };

  GX.filterWindow = function (events, start, end) { return events.filter(function (e) { return e.t >= start && e.t <= end; }); };

  /* ---------- Market sessions ---------- */
  GX.EXCHANGES = [
    { id: "NYSE", name: "NYSE", city: "New York", lat: 40.7069, lon: -74.0113, tz: "America/New_York", days: [1, 2, 3, 4, 5], pre: [[240, 570]], open: [[570, 960]] },
    { id: "CME", name: "CME Globex", city: "Chicago", lat: 41.8827, lon: -87.6324, tz: "America/Chicago", globex: true },
    { id: "LSE", name: "LSE", city: "London", lat: 51.5155, lon: -0.0993, tz: "Europe/London", days: [1, 2, 3, 4, 5], pre: [[470, 480]], open: [[480, 990]] },
    { id: "EUREX", name: "Eurex", city: "Frankfurt", lat: 50.1155, lon: 8.6724, tz: "Europe/Berlin", days: [1, 2, 3, 4, 5], open: [[70, 1320]] },
    { id: "TSE", name: "TSE", city: "Tokyo", lat: 35.682, lon: 139.7745, tz: "Asia/Tokyo", days: [1, 2, 3, 4, 5], pre: [[480, 540]], open: [[540, 690], [750, 930]] },
    { id: "HKEX", name: "HKEX", city: "Hong Kong", lat: 22.2842, lon: 114.1587, tz: "Asia/Hong_Kong", days: [1, 2, 3, 4, 5], pre: [[540, 570]], open: [[570, 720], [780, 960]] }
  ];

  var WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }, fmtCache = {};
  function localClock(tz, ms) {
    var f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var h = Number(o.hour) % 24, m = Number(o.minute);
    return { wd: WD[o.weekday], min: h * 60 + m, text: String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") };
  }

  function inAny(min, ranges) { return (ranges || []).some(function (r) { return min >= r[0] && min < r[1]; }); }

  /* Session status from local exchange time. Weekends only: exchange holidays are not modelled. */
  GX.marketStatus = function (ex, ms) {
    var c = localClock(ex.tz, ms), state;
    if (ex.globex) {
      var closed = c.wd === 6 || (c.wd === 0 && c.min < 1020) || (c.wd === 5 && c.min >= 960) || (c.wd >= 1 && c.wd <= 4 && c.min >= 960 && c.min < 1020);
      state = closed ? "closed" : "open";
    } else if (ex.days.indexOf(c.wd) < 0) state = "closed";
    else state = inAny(c.min, ex.open) ? "open" : inAny(c.min, ex.pre) ? "pre" : "closed";
    return { state: state, local: c.text };
  };

  /* ---------- Static reference layers (approximate, for context) ---------- */
  GX.CHOKEPOINTS = [
    { id: "suez", name: "Suez Canal", lat: 30.4574, lon: 32.3499, note: "About 12% of global trade passes Suez. Red Sea diversions reroute via the Cape." },
    { id: "panama", name: "Panama Canal", lat: 9.08, lon: -79.68, note: "Links Atlantic and Pacific. Draft limits follow Gatun Lake water levels." },
    { id: "hormuz", name: "Strait of Hormuz", lat: 26.57, lon: 56.25, note: "Roughly a fifth of seaborne oil moves through this strait." },
    { id: "malacca", name: "Strait of Malacca", lat: 2.5, lon: 101.8, note: "Main Asia to Europe and Gulf route; busiest oil chokepoint by volume to Asia." },
    { id: "babelmandeb", name: "Bab-el-Mandeb", lat: 12.58, lon: 43.33, note: "Southern gate of the Red Sea and Suez route." },
    { id: "bosphorus", name: "Bosphorus", lat: 41.12, lon: 29.05, note: "Black Sea exit: grain, oil and Caspian exports." },
    { id: "taiwan", name: "Taiwan Strait", lat: 24.5, lon: 119.5, note: "Major container lane and the path for much of the world's advanced chip output." },
    { id: "cape", name: "Cape of Good Hope", lat: -34.36, lon: 18.47, note: "Alternate route when Suez or the Red Sea is disrupted." }
  ];

  GX.SHIP_ARCS = [
    { id: "sha-rtm", name: "Shanghai to Rotterdam", from: [121.8, 31.2], to: [4.05, 51.95], peakM: 1500000 },
    { id: "sin-lax", name: "Singapore to Los Angeles", from: [103.8, 1.26], to: [-118.27, 33.74], peakM: 2200000 },
    { id: "rtn-ngb", name: "Ras Tanura to Ningbo (crude)", from: [50.16, 26.64], to: [121.85, 29.87], peakM: 1200000 },
    { id: "hou-rtm", name: "Houston to Rotterdam (energy)", from: [-95.0, 29.7], to: [4.05, 51.95], peakM: 1300000 },
    { id: "ssz-sha", name: "Santos to Shanghai (ore, grain)", from: [-46.3, -23.96], to: [121.8, 31.2], peakM: 1800000 }
  ];

  GX.AIR_CORRIDORS = [
    { id: "nat", name: "North Atlantic tracks", pts: [[-73.78, 40.64], [-50, 52], [-30, 54], [-0.45, 51.47]] },
    { id: "tpac", name: "Trans-Pacific", pts: [[-118.4, 33.94], [-150, 42], [-175, 48], [140.39, 35.77]] },
    { id: "eurasia", name: "Europe to East Asia", pts: [[8.57, 50.03], [40, 46], [70, 41], [95, 38], [113.9, 22.3]] }
  ];

  GX.CABLES = [
    { id: "tat", name: "Transatlantic (approx.)", pts: [[-76, 36.8], [-50, 41], [-25, 47], [-4.55, 50.83]] },
    { id: "tpac", name: "Transpacific (approx.)", pts: [[-118.4, 33.9], [-150, 32], [-179, 33], [170, 34], [140, 35.3]] },
    { id: "smw", name: "Europe to Asia via Suez (approx.)", pts: [[5.37, 43.3], [29.9, 31.2], [32.5, 29.9], [43.1, 11.6], [72.8, 19.0], [103.8, 1.3]] },
    { id: "afr", name: "West Africa (approx.)", pts: [[-9.1, 38.7], [-17, 20], [3.4, 6.4], [18.4, -33.9]] },
    { id: "satl", name: "South Atlantic (approx.)", pts: [[-38.5, -3.7], [-25, 12], [-8.9, 37.9]] }
  ];

  GX.CENTRAL_BANKS = [
    { id: "fed", name: "Federal Reserve (FOMC)", lat: 38.8929, lon: -77.0459, note: "US policy rate. Decision dates come from the calendar used by Order Flow." },
    { id: "ecb", name: "European Central Bank", lat: 50.1097, lon: 8.7041, note: "Euro area policy rate. Check the ECB calendar for decision dates." },
    { id: "boe", name: "Bank of England", lat: 51.5142, lon: -0.0885, note: "UK policy rate. Check the BoE calendar for MPC dates." },
    { id: "boj", name: "Bank of Japan", lat: 35.6866, lon: 139.7745, note: "Japan policy rate and yield-curve policy." },
    { id: "pboc", name: "People's Bank of China", lat: 39.9139, lon: 116.3606, note: "China policy rates and the daily yuan fixing." }
  ];

  GX.CITIES = [
    ["New York", 40.7128, -74.006], ["London", 51.5072, -0.1276], ["Tokyo", 35.6762, 139.6503], ["Hong Kong", 22.3193, 114.1694],
    ["Singapore", 1.3521, 103.8198], ["Frankfurt", 50.1109, 8.6821], ["Chicago", 41.8781, -87.6298], ["Washington, D.C.", 38.9072, -77.0369],
    ["Beijing", 39.9042, 116.4074], ["Shanghai", 31.2304, 121.4737], ["Dubai", 25.2048, 55.2708], ["Mumbai", 19.076, 72.8777],
    ["Sydney", -33.8688, 151.2093], ["Sao Paulo", -23.5505, -46.6333], ["Johannesburg", -26.2041, 28.0473], ["Moscow", 55.7558, 37.6173],
    ["Istanbul", 41.0082, 28.9784], ["Cairo", 30.0444, 31.2357], ["Seoul", 37.5665, 126.978], ["San Francisco", 37.7749, -122.4194],
    ["Los Angeles", 34.0522, -118.2437], ["Paris", 48.8566, 2.3522], ["Zurich", 47.3769, 8.5417], ["Toronto", 43.6532, -79.3832],
    ["Mexico City", 19.4326, -99.1332], ["Riyadh", 24.7136, 46.6753], ["Tehran", 35.6892, 51.389], ["Taipei", 25.033, 121.5654],
    ["Jakarta", -6.2088, 106.8456], ["Lagos", 6.5244, 3.3792], ["Houston", 29.7604, -95.3698], ["Rotterdam", 51.9244, 4.4777]
  ].map(function (c) { return { name: c[0], lat: c[1], lon: c[2] }; });

  /* ---------- Market sensitivity tags ---------- */
  function inBox(e, la0, la1, lo0, lo1) { return e.lat >= la0 && e.lat <= la1 && e.lon >= lo0 && e.lon <= lo1; }

  GX.sensitivity = function (e) {
    var tags = [], text = ((e.title || "") + " " + (e.desc || "")).toLowerCase();
    if (inBox(e, 20, 46, 118, 146)) tags.push("Semis (SOX, TSMC)", "JPY", "NQ");
    if (inBox(e, -45, -5, -80, -65)) tags.push("Copper (HG)", "Miners (COPX)");
    if (inBox(e, 22, 32, 46, 60)) tags.push("Crude (CL, Brent)", "Tankers", "Gold (GC)");
    if (e.kind === "storm" && inBox(e, 18, 32, -98, -76)) tags.push("Nat gas (NG)", "Crude (CL)", "Refiners");
    if (inBox(e, 32, 42, -125, -114)) tags.push("Tech (NQ)", "Insurers");
    if (e.kind === "wildfire" && inBox(e, 30, 50, -125, -100)) tags.push("Utilities", "Insurers");
    if (/tariff|trade/.test(text)) tags.push("ES", "NQ", "USD");
    if (/sanction|iran|hormuz|oil/.test(text)) tags.push("Crude (CL)", "Gold (GC)");
    if (/semi|chip|nvidia|samsung/.test(text)) tags.push("Semis (SOX)", "NQ");
    if (e.kind === "volcano") tags.push("Airlines", "Aviation insurers");
    var seen = {};
    tags = tags.filter(function (t) { return seen[t] ? false : (seen[t] = true); });
    return tags.length ? tags : ["Global risk (VIX)"];
  };
})(globalThis);
