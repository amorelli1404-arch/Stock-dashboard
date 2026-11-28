/* Index Workstation data sources.
 * IX.Sim: deterministic, correlated ES/NQ 1-minute sessions (overnight + RTH) that keep ticking.
 * IX.Live: real SPY/QQQ perpetual candles (with taker-buy volume, so delta is real), mega-cap candles and investingLive
 * headlines. It is a proxy: levels are ETF prices, not CME futures prices. */
(function (g) {
  "use strict";
  var IX = g.IX, MIN = 60000, DAY = 86400000;
  IX.MAX_BARS = 9000;

  function mulberry32(a) { return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- Simulator ---------- */
  var SESSIONS_BACK = 6, SIM_START_MIN = 642 /* 10:42 ET */;
  var SAMPLE_HEADLINES = [
    { back: 1, min: 510, title: "Sample: scheduled data release hits at 8:30 ET" }, { back: 1, min: 795, title: "Sample: mega-cap chip company updates guidance" },
    { back: 0, min: 510, title: "Sample: pre-market data release lands" }, { back: 0, min: 600, title: "Sample: large-cap tech leads an early rotation" }, { back: 0, min: 622, title: "Sample: index-wide tariff headline crosses" }
  ];

  /* The simulator only builds full regular sessions, so holidays and early-close days are skipped. */
  function weekdaysEnding(ms, count) {
    var p = IX.etParts(ms), d = Date.UTC(p.y, p.m - 1, p.d), out = [];
    while (out.length < count) {
      var wd = new Date(d).getUTCDay(), iso = new Date(d).toISOString().slice(0, 10);
      if (wd !== 0 && wd !== 6 && IX.HOLIDAYS.indexOf(iso) < 0 && !IX.EARLY_CLOSE[iso]) out.unshift(d);
      d -= DAY;
    }
    return out;
  }
  function etAt(dayUtc, minute) { var d = new Date(dayUtc); return g.OF.calendar.etToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(minute / 60), minute % 60); }

  function Sim(opts) {
    var o = opts || {};
    this.rng = mulberry32((o.seed || 20261128) >>> 0);
    var days = weekdaysEnding(o.now || Date.now(), SESSIONS_BACK);
    this.now = etAt(days[days.length - 1], SIM_START_MIN);
    this.price = { ES: IX.ROOTS.ES.base, NQ: IX.ROOTS.NQ.base };
    this.drift = 0; this.driftUntil = 0; this.forming = null; this.mega = {};
    var self = this;
    this.planned = SAMPLE_HEADLINES.map(function (h) { return { ts: etAt(days[days.length - 1 - h.back], h.min), title: h.title, sign: self.rng() < 0.5 ? -1 : 1, sample: true }; });
    this.bars = { ES: [], NQ: [] };
    days.forEach(function (day) {
      for (var t = etAt(day - DAY, 1080), end = Math.min(etAt(day, 1020), self.now); t < end; t += MIN) {
        if (!IX.marketOpen(t)) continue;
        var pair = self.generate(t);
        self.bars.ES.push(pair.ES); self.bars.NQ.push(pair.NQ);
      }
    });
    this.daily = { ES: this.history("ES", days[0]), NQ: this.history("NQ", days[0]) };
    IX.MEGACAPS.forEach(function (c) { self.mega[c.s] = (self.rng() - 0.48) * 2.4; });
    this.headlines = [];
    this.publish();
  }

  Sim.prototype.gauss = function () { var u = 1 - this.rng(), v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* One correlated minute for ES and NQ. Volume follows a U shape in RTH and delta leans with the bar's direction. */
  Sim.prototype.generate = function (t) {
    var p = IX.etParts(t), rth = IX.isRth(t), openBurst = rth && p.min < 600 ? 1.7 : 1;
    if (t >= this.driftUntil) { this.drift = (this.rng() - 0.5) * (rth ? 0.34 : 0.1); this.driftUntil = t + (30 + this.rng() * 90) * MIN; }
    var common = this.gauss(), impulse = 0;
    this.planned.forEach(function (h) { var k = (t - h.ts) / MIN; if (k >= 0 && k < 4) impulse += h.sign * [4.5, 2.5, 1.2, 0.6][k | 0]; });
    var sig = (rth ? 1.35 : 0.5) * openBurst;
    var moves = { ES: common * sig + this.drift + impulse, NQ: (0.8 * common + 0.6 * this.gauss()) * sig * 4.5 + this.drift * 4.6 + impulse * 4.8 };
    var u = rth ? 1 + 1.6 * Math.exp(-(p.min - 570) / 32) + 1.1 * Math.exp(-(960 - p.min) / 28) : 0.13;
    var out = {}, self = this;
    ["ES", "NQ"].forEach(function (root) {
      var o = self.price[root], c = IX.roundTick(o + moves[root]), wick = (root === "ES" ? 1 : 4.2) * sig * 0.7;
      var h = IX.roundTick(Math.max(o, c) + Math.abs(self.gauss()) * wick), l = IX.roundTick(Math.min(o, c) - Math.abs(self.gauss()) * wick);
      var v = Math.max(5, Math.round((root === "ES" ? 2600 : 900) * u * Math.exp(0.35 * self.gauss()) * (impulse ? 2.4 : 1)));
      var share = Math.max(0.08, Math.min(0.92, 0.5 + 0.16 * Math.tanh(moves[root] / (root === "ES" ? sig : sig * 4.5)) + 0.05 * self.gauss()));
      self.price[root] = c;
      out[root] = { t: t, o: o, h: h, l: l, c: c, v: v, buy: Math.round(v * share) };
    });
    return out;
  };

  Sim.prototype.history = function (root, firstDay) {
    var out = [], price = this.bars[root][0].o, d = firstDay - DAY, vol = root === "ES" ? 0.009 : 0.013;
    while (out.length < 330) {
      var wd = new Date(d).getUTCDay();
      if (wd !== 0 && wd !== 6) { out.unshift({ t: d, c: IX.roundTick(price) }); price /= 1 + 0.0004 + vol * this.gauss(); }
      d -= DAY;
    }
    return out;
  };

  function partial(full, frac) {
    var c = IX.roundTick(full.o + (full.c - full.o) * frac), v = Math.max(1, Math.round(full.v * frac));
    return { t: full.t, o: full.o, h: IX.roundTick(Math.max(full.o, c, full.o + (full.h - full.o) * frac)), l: IX.roundTick(Math.min(full.o, c, full.o + (full.l - full.o) * frac)), c: c, v: v, buy: Math.min(v, Math.round(full.buy * frac)) };
  }

  Sim.prototype.publish = function () { var now = this.now; this.headlines = this.planned.filter(function (h) { return h.ts <= now; }).sort(function (a, b) { return b.ts - a.ts; }); };

  /* Moves the simulated clock forward. Finished minutes become final bars; the current minute shows as forming. */
  Sim.prototype.advance = function (ms) {
    this.now += ms;
    var guard = 0;
    while (!IX.marketOpen(this.now) && guard++ < 6000) this.now += MIN;
    var curMin = Math.floor(this.now / MIN) * MIN, self = this;
    function put(pair) {
      ["ES", "NQ"].forEach(function (r) { var a = self.bars[r]; if (a.length && a[a.length - 1].t === pair[r].t) a[a.length - 1] = pair[r]; else a.push(pair[r]); });
    }
    if (this.forming && this.forming.ES.t < curMin) { put(this.forming); this.forming = null; }
    var lastT = this.forming ? this.forming.ES.t : this.bars.ES[this.bars.ES.length - 1].t;
    for (var t = lastT + MIN, n = 0; t < curMin && n < 3000; t += MIN, n++) if (IX.marketOpen(t)) put(this.generate(t));
    var frac = (this.now - curMin) / MIN;
    if (frac > 0 && IX.marketOpen(curMin)) {
      if (!this.forming) this.forming = this.generate(curMin);
      put({ ES: partial(this.forming.ES, frac), NQ: partial(this.forming.NQ, frac) });
    }
    ["ES", "NQ"].forEach(function (r) { if (self.bars[r].length > IX.MAX_BARS) self.bars[r].splice(0, self.bars[r].length - IX.MAX_BARS); });
    IX.MEGACAPS.forEach(function (c) { self.mega[c.s] += self.gauss() * 0.012 * Math.sqrt(Math.min(ms, 10 * MIN) / MIN); });
    this.publish();
  };

  Sim.prototype.megaCaps = function () { var m = this.mega; return IX.MEGACAPS.map(function (c) { return { s: c.s, pct: m[c.s] }; }); };
  IX.Sim = Sim;

  /* ---------- Live proxy ---------- */
  var FAPI = "https://fapi.binance.com/fapi/v1/klines";
  var NEWS_URL = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent("https://www.forexlive.com/feed/news");
  var PAGES = 6, POLL_MS = 5000, MEGA_MS = 30000, NEWS_MS = 120000, DAILY_MS = 600000, TIMEOUT = 9000;

  IX.parseBars = function (rows) {
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r) return;
      var b = { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], buy: +r[9] };
      if (isFinite(b.t) && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.v >= 0 && b.buy >= 0 && IX.marketOpen(b.t)) out.push(b);
    });
    return out;
  };

  function merge(old, fresh) {
    var map = new Map();
    old.concat(fresh).forEach(function (b) { map.set(b.t, b); });
    var out = Array.from(map.values()).sort(function (a, b) { return a.t - b.t; });
    return out.length > IX.MAX_BARS ? out.slice(-IX.MAX_BARS) : out;
  }

  function getJson(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }, function (e) { clearTimeout(timer); throw e; });
  }

  function Live() { this.bars = { ES: [], NQ: [] }; this.daily = { ES: [], NQ: [] }; this.mega = {}; this.headlines = []; this.lastAt = 0; this.error = ""; this.newsError = false; this.timers = []; this.stopped = true; }

  Live.prototype.start = function (onUpdate, isActive) {
    var self = this;
    this.stop(); this.stopped = false;
    function done() { if (!self.stopped) onUpdate(); }
    function every(ms, fn) { self.timers.push(setInterval(function () { if (!self.stopped && isActive()) fn(); }, ms)); }
    /* Walks back in pages of 1500 one-minute candles so the previous session is available even after a weekend. */
    function backfill(root, page, end) {
      return getJson(FAPI + "?symbol=" + IX.ROOTS[root].symbol + "&interval=1m&limit=1500" + (end ? "&endTime=" + end : "")).then(function (rows) {
        if (self.stopped) return;
        self.bars[root] = merge(self.bars[root], IX.parseBars(rows));
        self.lastAt = Date.now(); self.error = "";
        done();
        if (page + 1 < PAGES && Array.isArray(rows) && rows.length) return backfill(root, page + 1, rows[0][0] - 1);
      });
    }
    function fail(e) { self.error = "Live proxy data is unreachable: " + e.message; done(); }
    function recent(root) {
      getJson(FAPI + "?symbol=" + IX.ROOTS[root].symbol + "&interval=1m&limit=5").then(function (rows) { self.bars[root] = merge(self.bars[root], IX.parseBars(rows)); self.lastAt = Date.now(); self.error = ""; done(); }).catch(fail);
    }
    function daily(root) {
      getJson(FAPI + "?symbol=" + IX.ROOTS[root].symbol + "&interval=1d&limit=500").then(function (rows) { self.daily[root] = (rows || []).map(function (r) { return { t: +r[0], c: +r[4] }; }); done(); }).catch(function () { /* performance stays blank */ });
    }
    function mega() {
      IX.MEGACAPS.forEach(function (c) {
        getJson(FAPI + "?symbol=" + c.s + "USDT&interval=15m&limit=500").then(function (rows) { self.mega[c.s] = IX.parseBars(rows); done(); }).catch(function () { /* keep the last value */ });
      });
    }
    function news() {
      getJson(NEWS_URL).then(function (j) {
        self.headlines = g.GB.parseFeed(j, "investingLive").filter(function (h) { return IX.isIndexHeadline(h.title); }).map(function (h) { return { ts: h.ts, title: h.title, link: h.link, source: h.source }; });
        self.newsError = false; done();
      }).catch(function () { self.newsError = true; done(); });
    }
    ["ES", "NQ"].forEach(function (r) { backfill(r, 0).catch(fail); daily(r); });
    mega(); news();
    every(POLL_MS, function () { recent("ES"); recent("NQ"); });
    every(MEGA_MS, mega); every(NEWS_MS, news); every(DAILY_MS, function () { daily("ES"); daily("NQ"); });
  };

  Live.prototype.stop = function () { this.stopped = true; this.timers.forEach(clearInterval); this.timers = []; };

  /* Intraday change of each mega-cap against its previous regular-session close. */
  Live.prototype.megaCaps = function () {
    var m = this.mega;
    return IX.MEGACAPS.map(function (c) {
      var bars = m[c.s] || [], sessions = bars.length ? IX.buildSessions(bars) : [], L = sessions.length ? IX.levels(sessions) : null, last = bars.length ? bars[bars.length - 1].c : null;
      return { s: c.s, pct: L && L.pdc > 0 && last > 0 ? (last / L.pdc - 1) * 100 : null };
    });
  };
  IX.Live = Live;
})(globalThis);
