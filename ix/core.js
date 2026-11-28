/* Index Workstation core: CME contract specs, New York session logic, auction levels, volume profile, CVD, NQ/ES ratio,
 * multi-horizon performance, seasonality, the prop-firm risk engine, headline reactions and scenario templates.
 * Pure logic, no DOM. Uses OF.analytics (volume profile, CVD divergences) and OF.calendar.etToUtc. */
(function (g) {
  "use strict";
  var IX = (g.IX = g.IX || {});

  IX.TICK = 0.25;
  IX.CONTRACTS = {
    ES: { root: "ES", pointValue: 50, tickValue: 12.5, name: "E-mini S&P 500" },
    MES: { root: "ES", pointValue: 5, tickValue: 1.25, name: "Micro E-mini S&P 500" },
    NQ: { root: "NQ", pointValue: 20, tickValue: 5, name: "E-mini Nasdaq-100" },
    MNQ: { root: "NQ", pointValue: 2, tickValue: 0.5, name: "Micro E-mini Nasdaq-100" }
  };
  IX.ROOTS = {
    ES: { proxy: "SPY", symbol: "SPYUSDT", base: 6480, simBin: 1, liveBin: 0.1 },
    NQ: { proxy: "QQQ", symbol: "QQQUSDT", base: 23100, simBin: 4, liveBin: 0.2 }
  };
  /* Approximate index weights in percent. They drift daily; the panel lets the trader edit them. */
  IX.MEGACAPS = [
    { s: "NVDA", es: 7.5, nq: 9.5 }, { s: "AAPL", es: 6.5, nq: 8.5 }, { s: "MSFT", es: 6.0, nq: 8.0 }, { s: "AMZN", es: 4.0, nq: 5.5 },
    { s: "META", es: 2.7, nq: 3.8 }, { s: "GOOGL", es: 2.5, nq: 2.8 }, { s: "TSLA", es: 2.0, nq: 3.2 }
  ];

  var MIN = 60000, RTH_FROM = 570, RTH_TO = 960, ETH_OPEN = 1080, BREAK_FROM = 1020, IB_MINUTES = 60;
  IX.RTH_FROM = RTH_FROM; IX.RTH_TO = RTH_TO;

  /* ---------- New York time and sessions ---------- */
  var fmt = null, cache = new Map();
  function etParts(ms) {
    var key = Math.floor(ms / MIN), hit = cache.get(key);
    if (hit) return hit;
    fmt = fmt || new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    var o = {};
    fmt.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var out = { y: +o.year, m: +o.month, d: +o.day, wd: o.weekday, min: (+o.hour % 24) * 60 + +o.minute };
    if (cache.size > 20000) cache.clear();
    cache.set(key, out);
    return out;
  }
  IX.etParts = etParts;

  /* CME equity index hours: closed Saturday, Sunday before 18:00, Friday from 17:00, and the daily 17:00 to 18:00 break. */
  IX.marketOpen = function (ms) {
    var p = etParts(ms);
    if (p.wd === "Sat") return false;
    if (p.wd === "Sun") return p.min >= ETH_OPEN;
    if (p.wd === "Fri") return p.min < BREAK_FROM;
    return p.min < BREAK_FROM || p.min >= ETH_OPEN;
  };

  function isoDay(utcMs) { return new Date(utcMs).toISOString().slice(0, 10); }
  /* A trading session is named by the day it ends: 18:00 ET onwards belongs to the next calendar day. */
  IX.sessionKey = function (ms) {
    var p = etParts(ms), d = Date.UTC(p.y, p.m - 1, p.d);
    return isoDay(p.min >= ETH_OPEN ? d + 86400000 : d);
  };
  /* US cash-market holidays (no regular session) and 1:00 PM early closes. Extend each year. */
  IX.HOLIDAYS = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"];
  IX.EARLY_CLOSE = { "2026-11-27": 780, "2026-12-24": 780, "2027-11-26": 780 };
  IX.etDay = function (ms) { var p = etParts(ms); return p.y + "-" + String(p.m).padStart(2, "0") + "-" + String(p.d).padStart(2, "0"); };
  IX.isRth = function (ms) {
    var p = etParts(ms);
    if (p.wd === "Sat" || p.wd === "Sun" || p.min < RTH_FROM || p.min >= RTH_TO) return false;
    var day = IX.etDay(ms);
    return IX.HOLIDAYS.indexOf(day) < 0 && p.min < (IX.EARLY_CLOSE[day] || RTH_TO);
  };
  IX.isOvernight = function (ms) { var m = etParts(ms).min; return m >= ETH_OPEN || m < RTH_FROM; };

  /* Ordered sessions from ascending 1-minute bars. */
  IX.buildSessions = function (bars) {
    var list = [], cur = null;
    bars.forEach(function (b) {
      var key = IX.sessionKey(b.t);
      if (!cur || cur.key !== key) { cur = { key: key, bars: [], rth: [], eth: [] }; list.push(cur); }
      cur.bars.push(b);
      if (IX.isRth(b.t)) cur.rth.push(b); else if (IX.isOvernight(b.t)) cur.eth.push(b);
    });
    return list;
  };

  function hiLo(bars) {
    if (!bars.length) return null;
    var h = -Infinity, l = Infinity;
    bars.forEach(function (b) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; });
    return { h: h, l: l };
  }
  IX.hiLo = hiLo;

  /* PDH/PDL/PDC from the previous session's RTH, ONH/ONL from this session's overnight, and this session's RTH open. */
  IX.levels = function (sessions) {
    var cur = sessions[sessions.length - 1], prev = null, i;
    for (i = sessions.length - 2; i >= 0; i--) if (sessions[i].rth.length) { prev = sessions[i]; break; }
    var out = { pdh: null, pdl: null, pdc: null, onh: null, onl: null, open: null };
    if (prev) { var p = hiLo(prev.rth); out.pdh = p.h; out.pdl = p.l; out.pdc = prev.rth[prev.rth.length - 1].c; }
    if (cur) {
      var on = hiLo(cur.eth);
      if (on) { out.onh = on.h; out.onl = on.l; }
      if (cur.rth.length) out.open = cur.rth[0].o;
    }
    return out;
  };

  /* High/low of the first `minutes` of RTH. complete is true once a bar at or after the window end exists. */
  IX.openingRange = function (rth, minutes) {
    var end = RTH_FROM + minutes, inside = rth.filter(function (b) { return etParts(b.t).min < end; }), r = hiLo(inside);
    if (!r) return null;
    var done = rth.some(function (b) { return etParts(b.t).min >= end; });
    return { minutes: minutes, h: r.h, l: r.l, range: r.h - r.l, from: inside[0].t, to: inside[inside.length - 1].t, complete: done };
  };

  /* Initial Balance with 1.5x and 2.0x extension targets on both sides. */
  IX.initialBalance = function (rth) {
    var r = IX.openingRange(rth, IB_MINUTES);
    if (!r) return null;
    /* Targets are rounded to a tradable tick. ETF proxy prices use penny increments, so only futures-style prices are snapped. */
    var snap = function (p) { return Math.abs(r.h / IX.TICK - Math.round(r.h / IX.TICK)) < 1e-6 && r.h > 2000 ? IX.roundTick(p) : p; };
    r.up15 = snap(r.h + 0.5 * r.range); r.up20 = snap(r.h + r.range); r.dn15 = snap(r.l - 0.5 * r.range); r.dn20 = snap(r.l - r.range);
    return r;
  };

  IX.rangeStatus = function (r, last) { return !r || last == null ? "waiting" : !r.complete ? "forming" : last > r.h ? "above" : last < r.l ? "below" : "inside"; };

  /* Volume profile from OHLCV bars: each bar's volume is spread evenly across the price bins it covered. */
  IX.profile = function (bars, bin) {
    var levels = new Map();
    bars.forEach(function (b) {
      if (!(b.v > 0)) return;
      var lo = Math.floor(b.l / bin + 1e-9), hi = Math.floor(b.h / bin + 1e-9), n = hi - lo + 1, per = b.v / n, buyShare = Math.max(0, Math.min(1, b.buy / b.v));
      for (var k = lo; k <= hi; k++) {
        var c = levels.get(k);
        if (!c) { c = { a: 0, b: 0 }; levels.set(k, c); }
        c.a += per * buyShare; c.b += per * (1 - buyShare);
      }
    });
    var vp = g.OF.analytics.volumeProfile(levels, 0.7);
    if (!vp) return null;
    function px(k) { return (k + 0.5) * bin; }
    return { poc: px(vp.poc), vah: px(vp.vah), val: px(vp.val), levels: levels, bin: bin, total: vp.total };
  };

  /* Groups 1-minute bars into `minutes` bars and adds delta and session CVD (reset at each new session). */
  IX.aggregate = function (bars, minutes) {
    var out = [], cur = null, cvd = 0, session = null, span = minutes * MIN;
    bars.forEach(function (b) {
      var t = Math.floor(b.t / span) * span, key = IX.sessionKey(b.t);
      if (key !== session) { session = key; cvd = 0; cur = null; }
      if (!cur || cur.t !== t) { cur = { t: t, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, buy: 0, delta: 0, cvdO: cvd, cvdH: cvd, cvdL: cvd, cvdC: cvd, session: key }; out.push(cur); }
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c; cur.v += b.v; cur.buy += b.buy;
      var d = 2 * b.buy - b.v;
      cur.delta += d; cvd += d; cur.cvdC = cvd;
      if (cvd > cur.cvdH) cur.cvdH = cvd;
      if (cvd < cur.cvdL) cur.cvdL = cvd;
    });
    return out;
  };

  IX.divergences = function (bars) { return g.OF.analytics.cvdDivergences(bars.slice(0, -1)).filter(function (d) { return bars[d.from].session === bars[d.to].session; }); };

  /* NQ/ES ratio on matching timestamps, with relative performance since the first matched bar. */
  IX.ratio = function (es, nq) {
    var byT = new Map(), out = [];
    es.forEach(function (b) { byT.set(b.t, b.c); });
    var base = null;
    nq.forEach(function (b) {
      var e = byT.get(b.t);
      if (!(e > 0)) return;
      if (!base) base = { es: e, nq: b.c };
      out.push({ t: b.t, v: b.c / e, esPct: (e / base.es - 1) * 100, nqPct: (b.c / base.nq - 1) * 100 });
    });
    return out;
  };

  /* ---------- Performance and seasonality ---------- */
  function arrow(v) { return v == null ? "" : v > 0.1 ? "↑" : v < -0.1 ? "↓" : "→"; }
  IX.arrow = arrow;

  /* daily: [{t, c}] ascending. A horizon is null when history does not reach back to the end of the prior period. */
  IX.performance = function (daily, last, prevClose, now) {
    function lastCloseBefore(ms) {
      for (var i = daily.length - 1; i >= 0; i--) if (daily[i].t < ms) return daily[i].c;
      return null;
    }
    var d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth();
    function pct(base) { return base > 0 && last > 0 ? (last / base - 1) * 100 : null; }
    return { last: last, day: pct(prevClose), month: pct(lastCloseBefore(Date.UTC(y, m, 1))), quarter: pct(lastCloseBefore(Date.UTC(y, m - m % 3, 1))), year: pct(lastCloseBefore(Date.UTC(y, 0, 1))) };
  };

  /* CSV with a header row containing Date and Close columns (daily or monthly rows). */
  IX.parseCsv = function (text) {
    var lines = String(text || "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return [];
    var head = lines[0].split(",").map(function (h) { return h.trim().toLowerCase().replace(/"/g, ""); }), di = head.indexOf("date"), ci = head.indexOf("adj close");
    if (ci < 0) ci = head.indexOf("close");
    if (di < 0 || ci < 0) return [];
    var out = [];
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split(","), m = /^"?(\d{4})-(\d{2})-(\d{2})/.exec((c[di] || "").trim()), v = Number(String(c[ci] || "").replace(/"/g, ""));
      if (m && v > 0) out.push({ y: +m[1], m: +m[2], d: +m[3], c: v });
    }
    return out.sort(function (a, b) { return a.y - b.y || a.m - b.m || a.d - b.d; });
  };

  /* Average return and hit rate per calendar month from month-end closes. Needs at least 24 monthly returns. */
  IX.seasonality = function (rows, now) {
    var ends = [];
    rows.forEach(function (r) {
      var k = r.y * 12 + r.m - 1, last = ends[ends.length - 1];
      if (last && last.k === k) last.c = r.c; else ends.push({ k: k, c: r.c });
    });
    var d = new Date(now == null ? Date.now() : now), current = d.getUTCFullYear() * 12 + d.getUTCMonth();
    var stats = Array.from({ length: 12 }, function () { return { sum: 0, up: 0, n: 0 }; }), total = 0, firstY = null, lastY = null;
    for (var i = 1; i < ends.length; i++) {
      if (ends[i].k - ends[i - 1].k !== 1 || ends[i].k >= current) continue;
      var ret = (ends[i].c / ends[i - 1].c - 1) * 100, s = stats[ends[i].k % 12], yr = Math.floor(ends[i].k / 12);
      s.sum += ret; s.n++; if (ret > 0) s.up++; total++;
      if (firstY == null) firstY = yr;
      lastY = yr;
    }
    if (total < 24) return null;
    return { from: firstY, to: lastY, months: stats.map(function (s) { return { avg: s.n ? s.sum / s.n : null, winPct: s.n ? s.up / s.n * 100 : null, n: s.n }; }) };
  };

  /* ---------- Position sizing and prop-firm guard ---------- */
  /* Returns the largest size whose worst-case stop-out stays strictly inside every limit. */
  IX.risk = function (i) {
    var spec = IX.CONTRACTS[i.contract];
    function n(v) { return v === "" || v == null || !isFinite(Number(v)) ? null : Number(v); }
    var stop = n(i.stopTicks), slip = n(i.slippageTicks) || 0, comm = n(i.commission) || 0, account = n(i.account), dll = n(i.dailyLimit), trail = n(i.trailing),
      pnl = n(i.dayPnl) || 0, bal = n(i.balance), peak = n(i.peak), pctCap = n(i.riskPct) || 0;
    if (!spec || !(stop > 0) || !(account > 0) || !(dll > 0) || !(trail > 0) || slip < 0 || comm < 0) return { valid: false, reason: "Enter a stop, account size, daily loss limit and trailing drawdown above zero." };
    if (bal == null) bal = account;
    if (peak == null || peak < bal) peak = Math.max(bal, account);
    var perContract = (stop + slip) * spec.tickValue + comm;
    var remDaily = dll - Math.max(0, -pnl), floor = peak - trail, remTrail = bal - floor, cap = pctCap > 0 ? account * pctCap / 100 : Infinity;
    var budget = Math.min(remDaily, remTrail, cap), limiter = budget === remDaily ? "daily loss limit" : budget === remTrail ? "trailing drawdown" : "risk per trade";
    var max = budget > perContract ? Math.floor((budget - 0.01) / perContract) : 0;
    return { valid: true, perContract: perContract, remainingDaily: remDaily, remainingTrailing: remTrail, floor: floor, budget: Math.max(0, budget), limiter: limiter,
      maxContracts: Math.max(0, max), lossAtMax: Math.max(0, max) * perContract, breached: remDaily <= 0 || remTrail <= 0, stopPoints: stop * IX.TICK, spec: spec };
  };

  /* ---------- Headlines and reactions ---------- */
  var INCLUDE = /\b(nasdaq|s&p|sp500|spx|stocks?|equit\w*|wall street|tech|mega-?cap|nvidia|apple|microsoft|amazon|meta|google|alphabet|tesla|chips?|semiconductors?|earnings|fomc|fed|powell|cpi|ppi|payrolls?|nfp|jobs|jobless|ism|retail sales|gdp|tariffs?)\b/i;
  var EXCLUDE = /\b(gold|silver|oil|crude|wti|brent|opec|yields?|treasur\w*|bonds?|dollar|dxy|forex|fx|eur\w*|yen|jpy|gbp|pound|aud|nzd|cad|chf|yuan|rupee|bitcoin|crypto|russell|dow)\b/i;
  /* Keeps only headlines that bear on ES and NQ; anything about excluded markets is dropped. */
  IX.isIndexHeadline = function (title) { var t = String(title || ""); return INCLUDE.test(t) && !EXCLUDE.test(t); };
  IX.headlineTags = function (title) {
    var t = String(title || "").toLowerCase(), nq = /nasdaq|tech|chip|semiconductor|nvidia|apple|microsoft|amazon|meta|google|alphabet|tesla/.test(t), es = /s&p|sp500|spx|wall street/.test(t);
    return nq && !es ? ["NQ"] : es && !nq ? ["ES"] : ["ES", "NQ"];
  };

  /* Move from the last close before the headline to the close `after` minutes later, from 1-minute bars. */
  IX.reaction = function (bars, ts, after) {
    var start = Math.floor(ts / MIN) * MIN, end = start + (after || 5) * MIN, base = null, last = null, series = [];
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      if (b.t < start) base = b;
      if (b.t >= start - 10 * MIN && b.t <= start + 30 * MIN) series.push({ m: Math.round((b.t - start) / MIN), v: b.c });
      if (b.t >= start && b.t < end) last = b;
    }
    if (!base || !last || start - base.t > 3 * MIN) return null;
    var pts = last.c - base.c, final = bars.length && bars[bars.length - 1].t >= end;
    return { pts: pts, pct: pts / base.c * 100, base: base.c, final: final, series: series };
  };

  /* ---------- Scenario desk ---------- */
  var PLAYS = {
    cpi: [["Hotter than forecast: risk of a sharp sell-off on the print", "Usually the bigger point move; watch for a gap through ONL"], ["Initial two-way whip, then the prior auction tends to resume", "Fade of the first spike is common; wait for the 5-minute close"], ["Cooler than forecast: risk of a squeeze higher", "Often leads ES on the upside; watch ONH and PDH"]],
    jobs: [["Stronger labor print: reaction can run either way, so let the first 5 minutes set direction", "Wider and faster than ES in both directions"], ["Quick spike and retrace is common; trade the levels, not the number", "Often reverts toward the pre-release price"], ["Weaker labor print: watch whether the first move holds the overnight range", "Larger swings; confirm with ES before adding"]],
    fomc: [["Tighter than expected: sell-the-rally risk; the press conference can reverse it", "Higher beta to the surprise than ES"], ["Statement move often reverses during the press conference", "Expect two or three large swings; keep size small"], ["Easier than expected: breakout risk higher into the close", "Tends to outpace ES if the move holds"]],
    other: [["Above forecast: watch whether the first move clears the nearest session level", "Expect a larger point move than ES"], ["Muted reaction likely; the existing structure usually holds", "Look for a return to VWAP or the point of control"], ["Below forecast: watch for rejection or acceptance at the nearest level", "Expect a larger point move than ES"]]
  };
  IX.OUTCOMES = ["Above Forecast", "In Line", "Below Forecast"];
  IX.releaseType = function (name) { return /cpi|ppi|pce|inflation/i.test(name) ? "cpi" : /payroll|nfp|jobless|employment/i.test(name) ? "jobs" : /fomc|fed/i.test(name) ? "fomc" : "other"; };
  IX.scenarios = function (name) { return PLAYS[IX.releaseType(name)].map(function (r, i) { return { outcome: IX.OUTCOMES[i], es: r[0], nq: r[1] }; }); };

  IX.roundTick = function (p) { return Math.round(p / IX.TICK) * IX.TICK; };
})(globalThis);
