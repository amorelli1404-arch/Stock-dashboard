/* Trading sessions and range trackers (Initial Balance, Opening Range) in New York time.
 * Pure functions, no DOM. Wall-clock parts are memoised per minute so per-trade calls stay cheap. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  var dtf = null, memoKey = -1, memo = null;

  function formatter() {
    return dtf || (dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }));
  }
  function pad(n) { return String(n).padStart(2, "0"); }

  /* {day:"YYYY-MM-DD", min:minutes since midnight} in New York for an epoch-ms timestamp. */
  function etClock(ts) {
    var key = Math.floor(ts / 60000);
    if (key === memoKey) return memo;
    var o = {};
    formatter().formatToParts(new Date(ts)).forEach(function (p) { if (p.type !== "literal") o[p.type] = Number(p.value); });
    memo = { day: o.year + "-" + pad(o.month) + "-" + pad(o.day), min: (o.hour % 24) * 60 + o.minute };
    memoKey = key;
    return memo;
  }

  function inWindow(min, from, to) { return from <= to ? min >= from && min < to : min >= from || min < to; }

  /* Session definition active at a minute-of-day, or null when none matches. */
  function sessionAt(min, list) {
    for (var i = 0; i < list.length; i++) if (inWindow(min, list[i].from, list[i].to)) return list[i];
    return null;
  }

  function sessionOf(ts, list) {
    var s = sessionAt(etClock(ts).min, list || OF.config.sessions);
    return s ? s.id : null;
  }

  /* High/low of a fixed window after a start time on each New York day (Initial Balance, ORB). */
  function RangeTracker(startMin, lengthMin) {
    this.start = startMin;
    this.end = startMin + lengthMin;
    this.day = null; this.h = null; this.l = null;
  }
  RangeTracker.prototype.add = function (ts, price) {
    var c = etClock(ts);
    if (c.min < this.start || c.min >= this.end) return false;
    if (c.day !== this.day) { this.day = c.day; this.h = price; this.l = price; return true; }
    if (price > this.h) this.h = price;
    if (price < this.l) this.l = price;
    return true;
  };
  RangeTracker.prototype.get = function () { return this.h == null ? null : { day: this.day, h: this.h, l: this.l }; };
  /* True once the window for the tracked day has closed. */
  RangeTracker.prototype.closedAt = function (ts) {
    var c = etClock(ts);
    return this.day != null && c.day === this.day && c.min >= this.end;
  };

  OF.sessions = { etClock: etClock, sessionAt: sessionAt, sessionOf: sessionOf, RangeTracker: RangeTracker, inWindow: inWindow };
})(globalThis);
