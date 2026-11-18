/* Economic calendar: schedule, countdowns and alert severity. Always uses the wall clock (never the replay clock).
 * Dates below are a convenience default. CPI dates are approximate and NFP/ISM follow the usual weekday rule,
 * so verify against the official BLS / Fed / ISM calendars, or replace the list with OF.calendar.setEvents(). */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  var NY = "America/New_York";
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });

  function nyParts(ms) {
    var o = {};
    dtf.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== "literal") o[p.type] = Number(p.value); });
    return o;
  }
  function nyOffset(ms) {
    var p = nyParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }
  /* Converts a New York wall-clock time to a UTC timestamp, handling DST. */
  function etToUtc(y, m, d, h, mi) {
    var guess = Date.UTC(y, m - 1, d, h, mi), utc = guess - nyOffset(guess);
    return guess - nyOffset(utc);
  }

  var FOMC_DECISIONS = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  var CPI_APPROX = ["2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"];

  function ymd(s) { var p = s.split("-"); return [Number(p[0]), Number(p[1]), Number(p[2])]; }

  function firstWeekday(year, month, weekday) {
    var d = new Date(Date.UTC(year, month - 1, 1));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCDate();
  }
  function firstBusinessDay(year, month) {
    var d = new Date(Date.UTC(year, month - 1, 1));
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCDate();
  }

  function buildEvents(nowMs, monthsAhead) {
    var base = nyParts(nowMs), events = [], span = monthsAhead || 7, i;
    FOMC_DECISIONS.forEach(function (s) {
      var p = ymd(s);
      events.push({ id: "fomc-" + s, name: "FOMC rate decision", ts: etToUtc(p[0], p[1], p[2], 14, 0), impact: "high", approx: false });
    });
    CPI_APPROX.forEach(function (s) {
      var p = ymd(s);
      events.push({ id: "cpi-" + s, name: "CPI", ts: etToUtc(p[0], p[1], p[2], 8, 30), impact: "high", approx: true });
    });
    for (i = -1; i < span; i++) {
      var m0 = base.month - 1 + i, y = base.year + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12 + 1;
      events.push({ id: "nfp-" + y + "-" + m, name: "Nonfarm Payrolls", ts: etToUtc(y, m, firstWeekday(y, m, 5), 8, 30), impact: "high", approx: true });
      events.push({ id: "ism-" + y + "-" + m, name: "ISM Manufacturing", ts: etToUtc(y, m, firstBusinessDay(y, m), 10, 0), impact: "medium", approx: true });
    }
    return events.sort(function (a, b) { return a.ts - b.ts; });
  }

  var current = null;
  function events(nowMs) { return current || (current = buildEvents(nowMs == null ? Date.now() : nowMs)); }
  function setEvents(list) { current = list.slice().sort(function (a, b) { return a.ts - b.ts; }); }

  /* Events that have not happened yet (or happened within the last `graceMs`). */
  function upcoming(list, nowMs, n, graceMs) {
    var grace = graceMs == null ? 5 * 60000 : graceMs;
    return list.filter(function (e) { return e.ts - nowMs > -grace; }).slice(0, n);
  }

  /* imminent <= 15 min, soon <= 60 min, released within 5 min after, otherwise scheduled. */
  function severity(msUntil) {
    if (msUntil < 0) return msUntil > -5 * 60000 ? "released" : "past";
    if (msUntil <= 15 * 60000) return "imminent";
    if (msUntil <= 60 * 60000) return "soon";
    return "scheduled";
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function formatCountdown(ms) {
    var neg = ms < 0, t = Math.floor(Math.abs(ms) / 1000);
    var d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var core = (d ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
    return neg ? core + " ago" : core;
  }

  OF.calendar = {
    etToUtc: etToUtc, buildEvents: buildEvents, events: events, setEvents: setEvents,
    upcoming: upcoming, severity: severity, formatCountdown: formatCountdown
  };
})(globalThis);
