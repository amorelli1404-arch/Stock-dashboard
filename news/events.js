/* Live world events for the Event Map. Pulls several news feeds plus GDACS disaster alerts every 30 minutes, places each
 * headline at the location it names, and groups headlines by place. Depends on GB.parseFeed (bias/bias.js).
 * Placement is by place name in the text, so it is a best guess and can be wrong. */
(function (g) {
  "use strict";
  var NEWS = (g.NEWS = g.NEWS || {});

  var MIN = 60000, HOUR = 3600000;
  NEWS.REFRESH_MS = 30 * MIN;
  var MAX_AGE_MS = 48 * HOUR, MAX_PINS = 40, MAX_PER_PIN = 6, DISASTER_AGE_MS = 7 * 24 * HOUR, FETCH_TIMEOUT = 15000, MANUAL_COOLDOWN_MS = MIN;
  var STORE = "indexwatch.news.v1";
  var PROXY = "https://api.rss2json.com/v1/api.json?rss_url=";
  var GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP";

  NEWS.SOURCES = [
    { id: "bbc", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
    { id: "cnbc", name: "CNBC World", url: "https://www.cnbc.com/id/100727362/device/rss/rss.html" },
    { id: "npr", name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },
    { id: "investinglive", name: "investingLive", url: "https://www.forexlive.com/feed/news" }
  ];

  /* [label, lat, lon, aliases]. Aliases are matched as whole words. Order does not matter: the earliest mention wins. */
  var PLACES = [
    ["Strait of Hormuz", 26.57, 56.25, "Strait of Hormuz|Hormuz"], ["Red Sea", 19.5, 39.0, "Red Sea|Houthis?"], ["Suez Canal", 30.45, 32.35, "Suez"], ["Taiwan Strait", 24.5, 119.5, "Taiwan Strait"], ["Panama", 9.08, -79.68, "Panama"], ["Black Sea", 43.5, 34.0, "Black Sea"], ["South China Sea", 13.0, 114.0, "South China Sea"],
    ["Gaza", 31.42, 34.38, "Gaza|Hamas|Rafah"], ["Israel", 31.78, 35.22, "Israel|Israeli|Israelis|Jerusalem|Tel Aviv|Netanyahu"], ["West Bank", 31.95, 35.25, "West Bank"], ["Lebanon", 33.89, 35.5, "Lebanon|Lebanese|Beirut|Hezbollah"], ["Syria", 33.51, 36.29, "Syria|Syrian|Damascus"], ["Iran", 35.69, 51.39, "Iran|Iranian|Iranians|Tehran"], ["Iraq", 33.31, 44.37, "Iraq|Iraqi|Baghdad"], ["Saudi Arabia", 24.71, 46.68, "Saudi|Saudi Arabia|Riyadh"], ["Yemen", 15.37, 44.19, "Yemen|Yemeni|Sanaa"], ["Qatar", 25.29, 51.53, "Qatar|Doha"], ["UAE", 24.45, 54.38, "UAE|United Arab Emirates|Dubai|Abu Dhabi"], ["Jordan", 31.95, 35.93, "Amman|Jordanian"], ["Turkey", 39.93, 32.86, "Turkey|Turkish|Ankara|Istanbul|Erdogan"],
    ["Ukraine", 50.45, 30.52, "Ukraine|Ukrainian|Ukrainians|Kyiv|Kiev|Zelensky|Zelenskyy|Kharkiv|Odesa"], ["Russia", 55.76, 37.62, "Russia|Russian|Russians|Moscow|Kremlin|Putin"], ["Belarus", 53.9, 27.57, "Belarus|Minsk"], ["Poland", 52.23, 21.01, "Poland|Polish|Warsaw"], ["Germany", 52.52, 13.4, "Germany|German|Berlin|Frankfurt"], ["France", 48.86, 2.35, "France|French|Paris|Macron"], ["United Kingdom", 51.51, -0.13, "UK|Britain|British|England|London|Scotland|Wales|Starmer"], ["Ireland", 53.35, -6.26, "Ireland|Irish|Dublin"], ["Italy", 41.9, 12.5, "Italy|Italian|Italians|Rome"], ["Spain", 40.42, -3.7, "Spain|Spanish|Madrid"], ["Portugal", 38.72, -9.14, "Portugal|Lisbon"], ["Netherlands", 52.37, 4.9, "Netherlands|Dutch|Amsterdam"], ["Belgium", 50.85, 4.35, "Belgium|Brussels|European Union|NATO"], ["Switzerland", 46.95, 7.45, "Switzerland|Swiss|Geneva|Zurich"], ["Sweden", 59.33, 18.07, "Sweden|Swedish|Stockholm"], ["Norway", 59.91, 10.75, "Norway|Norwegian|Oslo"], ["Finland", 60.17, 24.94, "Finland|Finnish|Helsinki"], ["Denmark", 55.68, 12.57, "Denmark|Danish|Copenhagen"], ["Greenland", 64.18, -51.72, "Greenland"], ["Greece", 37.98, 23.73, "Greece|Greek|Athens"], ["Hungary", 47.5, 19.04, "Hungary|Hungarian|Budapest|Orban"], ["Romania", 44.43, 26.1, "Romania|Bucharest"], ["Serbia", 44.79, 20.45, "Serbia|Belgrade"], ["Austria", 48.21, 16.37, "Austria|Vienna"], ["Czechia", 50.08, 14.44, "Czech|Prague"], ["Moldova", 47.01, 28.86, "Moldova"], ["Georgia", 41.72, 44.79, "Tbilisi"], ["Armenia", 40.18, 44.51, "Armenia|Yerevan"], ["Azerbaijan", 40.41, 49.87, "Azerbaijan|Baku"], ["Vatican", 41.9, 12.45, "Vatican|Pope"],
    ["China", 39.9, 116.41, "China|Chinese|Beijing|Xi Jinping|Shanghai|Shenzhen"], ["Hong Kong", 22.32, 114.17, "Hong Kong"], ["Taiwan", 25.03, 121.57, "Taiwan|Taiwanese|Taipei|TSMC"], ["Japan", 35.68, 139.69, "Japan|Japanese|Tokyo"], ["South Korea", 37.57, 126.98, "South Korea|Korean|Seoul|Samsung"], ["North Korea", 39.04, 125.76, "North Korea|Pyongyang|Kim Jong"], ["India", 28.61, 77.21, "India|Indian|New Delhi|Delhi|Mumbai|Modi"], ["Pakistan", 33.68, 73.05, "Pakistan|Pakistani|Islamabad|Karachi"], ["Afghanistan", 34.56, 69.21, "Afghanistan|Afghan|Kabul|Taliban"], ["Bangladesh", 23.81, 90.41, "Bangladesh|Dhaka"], ["Sri Lanka", 6.93, 79.86, "Sri Lanka|Colombo"], ["Nepal", 27.72, 85.32, "Nepal|Kathmandu"], ["Myanmar", 19.76, 96.08, "Myanmar|Burma"], ["Thailand", 13.76, 100.5, "Thailand|Thai|Bangkok"], ["Vietnam", 21.03, 105.85, "Vietnam|Vietnamese|Hanoi"], ["Cambodia", 11.56, 104.92, "Cambodia"], ["Malaysia", 3.14, 101.69, "Malaysia|Kuala Lumpur"], ["Singapore", 1.35, 103.82, "Singapore"], ["Indonesia", -6.21, 106.85, "Indonesia|Indonesian|Jakarta|Sumatra|Java|Bali"], ["Philippines", 14.6, 120.98, "Philippines|Filipino|Manila"], ["Australia", -35.28, 149.13, "Australia|Australian|Sydney|Melbourne|RBA"], ["New Zealand", -41.29, 174.78, "New Zealand|RBNZ|Auckland"], ["Kazakhstan", 51.17, 71.43, "Kazakhstan"],
    ["Egypt", 30.04, 31.24, "Egypt|Egyptian|Cairo"], ["Sudan", 15.5, 32.56, "Sudan|Sudanese|Khartoum|Darfur"], ["South Sudan", 4.86, 31.57, "South Sudan"], ["Ethiopia", 9.03, 38.74, "Ethiopia|Addis Ababa"], ["Somalia", 2.05, 45.32, "Somalia|Somali|Mogadishu"], ["Kenya", -1.29, 36.82, "Kenya|Kenyan|Nairobi"], ["Uganda", 0.35, 32.58, "Uganda|Kampala"], ["Tanzania", -6.79, 39.21, "Tanzania"], ["DR Congo", -4.44, 15.27, "DR Congo|Congo|Congolese|Kinshasa"], ["Rwanda", -1.94, 30.06, "Rwanda|Kigali"], ["Nigeria", 9.08, 7.4, "Nigeria|Nigerian|Abuja|Lagos"], ["Ghana", 5.6, -0.19, "Ghana|Accra"], ["Mali", 12.64, -8.0, "Mali|Bamako"], ["Niger", 13.51, 2.13, "Niger|Niamey"], ["Burkina Faso", 12.37, -1.52, "Burkina Faso"], ["Senegal", 14.72, -17.47, "Senegal|Dakar"], ["Cameroon", 3.85, 11.5, "Cameroon"], ["Libya", 32.89, 13.19, "Libya|Libyan|Tripoli"], ["Tunisia", 36.81, 10.18, "Tunisia|Tunis"], ["Algeria", 36.75, 3.06, "Algeria|Algiers"], ["Morocco", 34.02, -6.84, "Morocco|Rabat"], ["South Africa", -25.75, 28.19, "South Africa|South African|Pretoria|Johannesburg|Cape Town"], ["Zimbabwe", -17.83, 31.05, "Zimbabwe"], ["Mozambique", -25.97, 32.57, "Mozambique"],
    ["Canada", 45.42, -75.7, "Canada|Canadian|Canadians|Ottawa|Toronto|Carney"], ["Mexico", 19.43, -99.13, "Mexico|Mexican|Sheinbaum"], ["Cuba", 23.11, -82.37, "Cuba|Cuban|Havana"], ["Haiti", 18.59, -72.31, "Haiti|Haitian"], ["Venezuela", 10.48, -66.9, "Venezuela|Venezuelan|Caracas|Maduro"], ["Colombia", 4.71, -74.07, "Colombia|Colombian|Bogota"], ["Brazil", -15.79, -47.88, "Brazil|Brazilian|Brasilia|Lula"], ["Argentina", -34.6, -58.38, "Argentina|Argentine|Argentina's|Buenos Aires|Milei"], ["Chile", -33.45, -70.67, "Chile|Chilean|Santiago"], ["Peru", -12.05, -77.04, "Peru|Peruvian|Lima"], ["Ecuador", -0.18, -78.47, "Ecuador|Quito"], ["Bolivia", -16.5, -68.15, "Bolivia"], ["Guyana", 6.8, -58.16, "Guyana"], ["Falkland Islands", -51.7, -57.85, "Falklands?"], ["Honduras", 14.07, -87.19, "Honduras"], ["Guatemala", 14.63, -90.51, "Guatemala"], ["El Salvador", 13.69, -89.22, "El Salvador"], ["Jamaica", 17.97, -76.79, "Jamaica"],
    ["New York", 40.71, -74.0, "New York|Wall Street|Manhattan"], ["California", 38.58, -121.49, "California|Los Angeles|San Francisco|Silicon Valley"], ["Texas", 30.27, -97.74, "Texas|Houston"], ["Florida", 30.44, -84.28, "Florida|Miami"], ["Chicago", 41.88, -87.63, "Chicago"], ["Alaska", 61.22, -149.9, "Alaska"], ["Hawaii", 21.31, -157.86, "Hawaii"]
  ];
  /* The US is often named alongside the real subject ("U.S. denies Iran claims"), so it only wins when nothing else matches. */
  var US_PLACE = ["United States", 38.91, -77.04];
  var US_RE = /(\bU\.S\.(?:A\.)?|\bUS\b|\bUSA\b|\bUnited States\b|\bWashington\b|\bWhite House\b|\bPentagon\b|\bCongress\b|\bFOMC\b|\bFed\b|\bAmerican\b|\bTrump\b)/;
  var MATCHERS = PLACES.map(function (p) { return { name: p[0], lat: p[1], lon: p[2], re: new RegExp("\\b(?:" + p[3] + ")\\b") }; });

  function earliest(text) {
    var best = null, at = Infinity, len = 0;
    MATCHERS.forEach(function (m) {
      var hit = m.re.exec(text);
      /* Earliest mention wins; at the same position the longer phrase wins ("South Sudan" over "Sudan"). */
      if (hit && (hit.index < at || (hit.index === at && hit[0].length > len))) { best = m; at = hit.index; len = hit[0].length; }
    });
    return best;
  }

  /* The headline decides where possible; the summary is only a fallback. Returns {name, lat, lon} or null. */
  NEWS.locate = function (title, desc) {
    var t = String(title || ""), d = String(desc || ""), hit = earliest(t);
    if (hit) return { name: hit.name, lat: hit.lat, lon: hit.lon };
    if (US_RE.test(t)) return { name: US_PLACE[0], lat: US_PLACE[1], lon: US_PLACE[2] };
    hit = earliest(d);
    return hit ? { name: hit.name, lat: hit.lat, lon: hit.lon } : null;
  };

  NEWS.severity = function (title) {
    var t = String(title || "").toLowerCase();
    if (/\b(war|attack\w*|strikes?|struck|killed|kills|dead|deaths?|missiles?|bomb\w*|explosion|invasion|shooting|massacre|earthquakes?|quakes?|coup|hostages?|airstrikes?)\b/.test(t)) return "high";
    if (/\b(sanction\w*|tariff\w*|election\w*|protests?|summit|talks|ceasefire|rate (cut|hike|decision)|central bank|crisis|evacuat\w*|flood\w*|storm|hurricane|typhoon|wildfire)\b/.test(t)) return "elevated";
    return "info";
  };

  function norm(title) { return String(title).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 70); }

  /* items: parsed headlines. Returns pins grouped by place, newest first, with duplicate headlines removed. */
  NEWS.cluster = function (items, now) {
    var seen = new Set(), byPlace = new Map();
    items.slice().sort(function (a, b) { return b.ts - a.ts; }).forEach(function (it) {
      if (!(now - it.ts <= MAX_AGE_MS) || it.ts - now > HOUR) return;
      var key = norm(it.title);
      if (seen.has(key)) return;
      seen.add(key);
      var where = NEWS.locate(it.title, it.desc);
      if (!where) return;
      var pin = byPlace.get(where.name);
      if (!pin) { pin = { id: "news-" + where.name.toLowerCase().replace(/[^a-z]+/g, "-"), loc: where.name, lat: where.lat, lon: where.lon, kind: "news", items: [], count: 0, latest: it.ts, sev: "info" }; byPlace.set(where.name, pin); }
      pin.count++;
      if (pin.items.length < MAX_PER_PIN) pin.items.push({ title: it.title, ts: it.ts, link: it.link, source: it.source });
      var s = NEWS.severity(it.title), rank = { info: 0, elevated: 1, high: 2 };
      if (rank[s] > rank[pin.sev]) pin.sev = s;
    });
    return Array.from(byPlace.values()).sort(function (a, b) { return b.latest - a.latest; }).slice(0, MAX_PINS);
  };

  /* GDACS events from the last week: every orange or red alert, plus green earthquakes, floods and cyclones.
   * Green wildfire notices are routine and numerous, so they are left out. */
  NEWS.parseGdacs = function (json, now) {
    var seen = new Set(), out = [];
    ((json && json.features) || []).forEach(function (f) {
      var p = f && f.properties, c = f && f.geometry && f.geometry.coordinates;
      if (!p || !c || !isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[1]) > 90 || Math.abs(c[0]) > 180) return;
      var end = Date.parse(String(p.todate || p.fromdate || "") + "Z"), id = "gdacs-" + p.eventtype + "-" + p.eventid;
      if (!isFinite(end) || now - end > DISASTER_AGE_MS || seen.has(id)) return;
      seen.add(id);
      var link = p.url && String(p.url.report || ""), level = String(p.alertlevel || "");
      if (level !== "Red" && level !== "Orange" && ["EQ", "FL", "TC", "VO"].indexOf(p.eventtype) < 0) return;
      var title = level + " alert: " + (p.name || p.eventtype) + (p.country ? " (" + p.country + ")" : "");
      out.push({ id: id, loc: p.country || p.name || "Disaster alert", lat: c[1], lon: c[0], kind: "disaster", sev: level === "Red" ? "critical" : level === "Orange" ? "high" : "elevated", latest: Math.min(end, now), count: 1,
        items: [{ title: title, ts: Math.min(end, now), link: /^https:\/\//i.test(link) ? link : null, source: "GDACS" }] });
    });
    var rank = { critical: 2, high: 1, elevated: 0 };
    /* The most serious alerts are kept first when the list is capped. */
    return out.sort(function (a, b) { return rank[b.sev] - rank[a.sev] || b.latest - a.latest; }).slice(0, 15);
  };

  /* ---------- Fetching and the 30-minute schedule ---------- */
  var state = { pins: [], updatedAt: 0, nextAt: 0, loading: false, status: {}, cache: {}, lastManual: 0 };
  var subs = [], timer = null;
  NEWS.state = state;
  NEWS.subscribe = function (fn) { subs.push(fn); if (state.updatedAt) fn(state); };
  function emit() { subs.forEach(function (fn) { try { fn(state); } catch (e) { if (g.console) g.console.warn("news listener failed", e); } }); }

  function getJson(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, t = setTimeout(function () { if (ctl) ctl.abort(); }, FETCH_TIMEOUT);
    return fetch(url, ctl ? { signal: ctl.signal, cache: "no-store" } : undefined).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }, function (e) { clearTimeout(t); throw e; });
  }

  function save() { try { localStorage.setItem(STORE, JSON.stringify({ cache: state.cache, updatedAt: state.updatedAt })); } catch (e) { /* not persisted */ } }
  function restore() {
    try {
      var d = JSON.parse(localStorage.getItem(STORE) || "null");
      if (d && d.cache && isFinite(d.updatedAt)) { state.cache = d.cache; state.updatedAt = d.updatedAt; rebuild(Date.now()); }
    } catch (e) { /* start empty */ }
  }

  function rebuild(now) {
    var items = [];
    NEWS.SOURCES.forEach(function (s) { items = items.concat(state.cache[s.id] || []); });
    state.pins = NEWS.cluster(items, now).concat(state.cache.gdacs || []);
  }

  /* A source that fails keeps its previous items, and is reported as failed. */
  NEWS.refresh = function () {
    if (state.loading) return Promise.resolve(state);
    state.loading = true; emit();
    var jobs = NEWS.SOURCES.map(function (s) {
      return getJson(PROXY + encodeURIComponent(s.url)).then(function (j) {
        var items = g.GB.parseFeed(j, s.name);
        if (!items.length) throw new Error("empty feed");
        state.cache[s.id] = items; state.status[s.id] = true;
      }).catch(function () { state.status[s.id] = false; });
    });
    jobs.push(getJson(GDACS).then(function (j) { state.cache.gdacs = NEWS.parseGdacs(j, Date.now()); state.status.gdacs = true; }).catch(function () { state.status.gdacs = false; }));
    return Promise.all(jobs).then(function () {
      var now = Date.now(), any = Object.keys(state.status).some(function (k) { return state.status[k]; });
      state.loading = false;
      if (any) { state.updatedAt = now; save(); }
      rebuild(now);
      schedule(any ? NEWS.REFRESH_MS : 2 * MIN);
      emit();
      return state;
    });
  };

  function schedule(ms) {
    clearTimeout(timer);
    state.nextAt = Date.now() + ms;
    timer = setTimeout(NEWS.refresh, ms);
  }

  NEWS.refreshNow = function () {
    if (Date.now() - state.lastManual < MANUAL_COOLDOWN_MS) return false;
    state.lastManual = Date.now();
    NEWS.refresh();
    return true;
  };

  /* Browsers throttle timers in background tabs, so an overdue refresh runs as soon as the tab is visible again. */
  function catchUp() { if (state.nextAt && Date.now() >= state.nextAt) NEWS.refresh(); }

  NEWS.start = function () {
    restore();
    var age = Date.now() - state.updatedAt;
    if (state.updatedAt && age < NEWS.REFRESH_MS) { schedule(NEWS.REFRESH_MS - age); emit(); }
    else NEWS.refresh();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", function () { if (!document.hidden) catchUp(); });
    setInterval(catchUp, MIN);
  };

  NEWS.stop = function () { clearTimeout(timer); timer = null; state.nextAt = 0; };
  NEWS.PLACE_COUNT = PLACES.length;
})(globalThis);
