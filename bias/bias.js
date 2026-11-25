/* Globe / Bias: instrument table, the daily-bias score, trading-session clock and headline helpers.
 * Pure functions with no DOM, so they run in Node for tests. The score is a transparent rule-based read of live prices:
 * it is not a forecast and not advice. */
(function (g) {
  "use strict";
  var GB = (g.GB = g.GB || {});

  var DAY = 86400000, MIN = 60000;

  /* sigma is a typical daily move in percent, used to scale today's move. proxy marks instruments priced through a tracker. */
  GB.INSTRUMENTS = [
    { id: "NQ", name: "NQ", flag: "us", market: "fut", symbol: "QQQUSDT", proxy: "QQQ", sigma: 1.3, dec: 2, words: ["nasdaq", "tech", "chip", "semiconductor", "nvidia", "apple", "microsoft", "ai ", "qqq", "megacap"] },
    { id: "ES", name: "ES", flag: "us", market: "fut", symbol: "SPYUSDT", proxy: "SPY", sigma: 0.9, dec: 2, words: ["s&p", "wall street", "stocks", "equities", "dow", "spx", "fed", "treasury", "earnings"] },
    { id: "GC", name: "GC", flag: "au", market: "fut", symbol: "XAUUSDT", proxy: "XAU", sigma: 0.9, dec: 1, words: ["gold", "bullion", "safe haven", "safe-haven", "xau", "precious"] },
    { id: "EURUSD", name: "EURUSD", flag: "eu", market: "spot", symbol: "EURUSDT", proxy: null, via: "EUR/USDT spot", sigma: 0.45, dec: 5, words: ["euro", "eur", "ecb", "eurozone", "lagarde", "dollar", "usd", "dxy"] }
  ];

  /* Trading sessions in UTC minutes of the day. The page shows them in the viewer's local time. */
  GB.SESSIONS = [
    { id: "tokyo", name: "Tokyo", from: 60, to: 300 },
    { id: "london", name: "London", from: 420, to: 600 },
    { id: "newyork", name: "New York", from: 870, to: 1260 }
  ];

  function pad(n) { return String(n).padStart(2, "0"); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  GB.dayStartUtc = function (ms) { return Math.floor(ms / DAY) * DAY; };

  /* "10h39", "0h09": hours and zero-padded minutes, rounded up so a countdown never shows 0h00 early. */
  GB.fmtCountdown = function (ms) {
    var mins = Math.max(0, Math.ceil(ms / MIN));
    return Math.floor(mins / 60) + "h" + pad(mins % 60);
  };

  GB.timeAgo = function (ts, now) {
    var m = Math.max(0, Math.floor((now - ts) / MIN));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " h " + (m % 60) + " min ago";
    var d = Math.floor(h / 24);
    return d + " d " + (h % 24) + " h ago";
  };

  /* ---------- Sessions ---------- */
  function isWeekend(ms) { var d = new Date(ms).getUTCDay(); return d === 0 || d === 6; }

  /* Next opening time at or after `now`, skipping weekends. */
  function nextOpen(s, now) {
    var day = GB.dayStartUtc(now);
    for (var i = 0; i < 9; i++) {
      var start = day + i * DAY + s.from * MIN;
      if (start > now && !isWeekend(start)) return start;
    }
    return now;
  }

  GB.sessionState = function (s, now) {
    var day = GB.dayStartUtc(now), start = day + s.from * MIN, end = day + s.to * MIN;
    if (now >= start && now < end && !isWeekend(now)) return { id: s.id, name: s.name, open: true, ms: end - now, at: start, end: end };
    var next = nextOpen(s, now);
    return { id: s.id, name: s.name, open: false, ms: next - now, at: next, end: next + (s.to - s.from) * MIN };
  };

  /* ---------- Daily bias ---------- */
  var WEIGHTS = { move: 0.5, range: 0.3, momentum: 0.2 }, MOMENTUM_BARS = 12, MIN_BARS = 6, SET_BARS = 36, STALE_MS = 2 * 3600000, LABEL_AT = 20;
  GB.WEIGHTS = WEIGHTS;

  /* candles: [{t, o, h, l, c}] ascending in time, 5-minute bars. Only bars since 00:00 UTC count as "today". */
  GB.score = function (candles, sigma, now, livePrice) {
    var start = GB.dayStartUtc(now), today = candles.filter(function (c) { return c.t >= start; });
    if (!today.length || (candles.length && now - candles[candles.length - 1].t > STALE_MS && livePrice == null)) {
      return { ready: false, state: "Waiting", dayType: "Waiting for Asia", reason: "no recent data" };
    }
    var open = today[0].o, last = livePrice != null ? livePrice : today[today.length - 1].c, hi = -Infinity, lo = Infinity;
    today.forEach(function (c) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; });
    if (last > hi) hi = last; if (last < lo) lo = last;
    var pct = (last / open - 1) * 100;
    if (today.length < MIN_BARS) return { ready: false, state: "Forming", dayType: "Forming", pct: pct, open: open, hi: hi, lo: lo, last: last, reason: "early in the day" };

    var rangePos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
    var back = today.length > MOMENTUM_BARS ? today[today.length - 1 - MOMENTUM_BARS].c : today[0].o;
    var mom = (last / back - 1) * 100;
    var A = clamp(pct / sigma, -2, 2) / 2, B = (rangePos - 0.5) * 2, C = clamp(mom / (sigma / 4), -2, 2) / 2;
    var score = Math.round(100 * (WEIGHTS.move * A + WEIGHTS.range * B + WEIGHTS.momentum * C));
    var rangePct = (hi / lo - 1) * 100, dayType;
    if (Math.abs(pct) >= 0.7 * sigma && (rangePos <= 0.25 || rangePos >= 0.75)) dayType = "Trend day";
    else if (rangePct <= 0.6 * sigma) dayType = "Range day";
    else dayType = "Balanced";
    return {
      ready: true, score: score, label: score >= LABEL_AT ? "Bullish" : score <= -LABEL_AT ? "Bearish" : "Neutral", state: today.length >= SET_BARS ? "Set" : "Forming", dayType: dayType,
      pct: pct, rangePos: rangePos, momentum: mom, open: open, hi: hi, lo: lo, last: last, bars: today.length,
      parts: { move: A, range: B, momentum: C }, rangePct: rangePct
    };
  };

  /* ---------- Headlines ---------- */
  var ALERT_RE = /\b(breaking|alert|plunge[sd]?|surge[sd]?|soar(s|ed)?|tumbl(e|es|ed)|crash(es|ed)?|spike[sd]?|escalat\w*|war|attack\w*|strike[sd]?|tariff\w*|sanction\w*|halt(s|ed)?|default\w*|emergency|fomc|cpi|nfp|payrolls|rate (cut|hike)|intervention|ceasefire|missile|invasion)\b/i;
  GB.isAlert = function (title) { return ALERT_RE.test(String(title || "")); };

  function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim(); }
  GB.stripTags = stripTags;

  /* rss2json: pubDate is "YYYY-MM-DD HH:MM:SS" in UTC. Only http(s) links are kept. */
  GB.parseFeed = function (json, source) {
    var out = [];
    ((json && json.items) || []).forEach(function (it) {
      var title = stripTags(it && it.title), ts = Date.parse(String(it && it.pubDate || "").replace(" ", "T") + "Z"), link = String(it && it.link || "");
      if (!title || !isFinite(ts)) return;
      out.push({ title: title, ts: ts, link: /^https?:\/\//i.test(link) ? link : null, source: source || "investingLive", desc: stripTags(it.description || it.content).slice(0, 280) });
    });
    return out.sort(function (a, b) { return b.ts - a.ts; });
  };

  GB.related = function (items, inst, limit) {
    var out = [];
    items.forEach(function (it) {
      var t = (it.title + " " + (it.desc || "")).toLowerCase();
      if (inst.words.some(function (w) { return t.indexOf(w) >= 0; })) out.push(it);
    });
    return out.slice(0, limit || 3);
  };

  GB.fmtPrice = function (v, dec) { return Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
  GB.fmtPct = function (v) { return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(2) + "%"; };

  /* Binance kline row -> candle. */
  GB.parseKlines = function (rows) {
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r) return;
      var c = { t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) };
      if (isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0) out.push(c);
    });
    return out;
  };
})(globalThis);
