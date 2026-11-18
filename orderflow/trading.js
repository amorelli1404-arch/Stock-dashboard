/* Simulated execution against the live or replayed book. No real orders are ever sent.
 * Pure state machine: an account, market orders filled at the touch, resting limit orders filled when
 * the tape trades through them, a stop/target bracket and a max-daily-loss lockout. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  var MAX_ORDERS = 20, MAX_FILLS = 300;

  function r8(x) { return Math.round(x * 1e8) / 1e8; }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function ok(extra) { return Object.assign({ ok: true }, extra); }
  function rej(reason) { return { ok: false, reason: reason }; }

  function defaults(m) {
    var sym = m.sym, tc = m.cfg.trade, stop = Math.max(4, Math.round(sym.dayRangeTicks / tc.stopDivisor));
    return { qty: sym.sizeDec ? sym.sizeStep * 10 : 1, stopTicks: stop, targetTicks: stop * tc.targetMultiple, maxLoss: tc.maxLossUsd };
  }

  function createAccount(m, opts) {
    var d = defaults(m), o = opts || {};
    return {
      sym: m.sym, pos: 0, avg: null, realized: 0, orders: [], fills: [], nextId: 1,
      stop: null, target: null, locked: false, lockReason: "",
      qty: num(o.qty, d.qty), stopTicks: num(o.stopTicks, d.stopTicks), targetTicks: num(o.targetTicks, d.targetTicks), maxLoss: num(o.maxLoss, d.maxLoss)
    };
  }

  function usd(acct, from, to, qty) { return (to - from) / acct.sym.tick * acct.sym.tickValue * qty; }

  function touch(m, side) {
    var p = side === "buy" ? m.l1.ask : m.l1.bid;
    return p != null ? p : m.l1.last;
  }

  function setBracket(acct) {
    if (!acct.pos) { acct.stop = acct.target = null; return; }
    var dir = acct.pos > 0 ? 1 : -1, tick = acct.sym.tick;
    acct.stop = acct.stopTicks > 0 ? r8(acct.avg - dir * acct.stopTicks * tick) : null;
    acct.target = acct.targetTicks > 0 ? r8(acct.avg + dir * acct.targetTicks * tick) : null;
  }

  function fill(acct, side, qty, price, ts, tag) {
    var signed = side === "buy" ? qty : -qty, prev = acct.pos, pnl = 0;
    if (prev && Math.sign(prev) !== Math.sign(signed)) {
      var closing = Math.min(Math.abs(prev), qty);
      pnl = usd(acct, acct.avg, price, closing) * Math.sign(prev);
      acct.realized = r8(acct.realized + pnl);
    }
    var next = r8(prev + signed), grew = Math.abs(next) > Math.abs(prev);
    if (!next) acct.avg = null;
    else if (!prev || Math.sign(next) !== Math.sign(prev)) acct.avg = price;
    else if (grew) acct.avg = (acct.avg * Math.abs(prev) + price * qty) / Math.abs(next);
    acct.pos = next;
    if (!next || grew || Math.sign(next) !== Math.sign(prev)) setBracket(acct);
    var f = { id: acct.nextId++, ts: ts, side: side, qty: qty, price: price, pnl: pnl, tag: tag };
    acct.fills.push(f);
    if (acct.fills.length > MAX_FILLS) acct.fills.shift();
    return f;
  }

  function clock(m) { return m.lastTs || Date.now(); }

  function unrealized(acct, m) {
    if (!acct.pos) return 0;
    var px = acct.pos > 0 ? touch(m, "sell") : touch(m, "buy");
    return px == null ? 0 : usd(acct, acct.avg, px, Math.abs(acct.pos)) * Math.sign(acct.pos);
  }

  function dayPnl(acct, m) { return acct.realized + unrealized(acct, m); }

  function marketOrder(acct, m, side, qty, tag) {
    if (acct.locked) return rej("Trading locked: max daily loss reached");
    var q = num(qty, acct.qty);
    if (!(q > 0)) return rej("Quantity must be above zero");
    var px = touch(m, side);
    if (px == null) return rej("No market yet");
    return ok({ fill: fill(acct, side, q, px, clock(m), tag || "market") });
  }

  function limitOrder(acct, m, side, price, qty, tag) {
    if (acct.locked) return rej("Trading locked: max daily loss reached");
    var q = num(qty, acct.qty), p = r8(Math.round(num(price, NaN) / acct.sym.tick) * acct.sym.tick);
    if (!(q > 0) || !(p > 0)) return rej("Enter a valid price and quantity");
    var ask = m.l1.ask, bid = m.l1.bid;
    if ((side === "buy" && ask != null && p >= ask) || (side === "sell" && bid != null && p <= bid)) return marketOrder(acct, m, side, q, "marketable limit");
    if (acct.orders.length >= MAX_ORDERS) return rej("Too many working orders");
    var o = { id: acct.nextId++, side: side, price: p, qty: q, tag: tag || "limit" };
    acct.orders.push(o);
    return ok({ order: o });
  }

  function joinBid(acct, m, qty) {
    return m.l1.bid == null ? rej("No bid to join") : limitOrder(acct, m, "buy", m.l1.bid, qty, "join bid");
  }
  function joinAsk(acct, m, qty) {
    return m.l1.ask == null ? rej("No offer to join") : limitOrder(acct, m, "sell", m.l1.ask, qty, "join offer");
  }

  function cancelAll(acct) { var n = acct.orders.length; acct.orders = []; return n; }

  /* Flatten is always allowed, including while locked. */
  function flatten(acct, m, tag) {
    cancelAll(acct);
    if (!acct.pos) return rej("Already flat");
    var side = acct.pos > 0 ? "sell" : "buy", px = touch(m, side);
    if (px == null) return rej("No market yet");
    return ok({ fill: fill(acct, side, Math.abs(acct.pos), px, clock(m), tag || "flatten") });
  }

  function reverse(acct, m) {
    if (acct.locked) return rej("Trading locked: max daily loss reached");
    if (!acct.pos) return rej("No position to reverse");
    var side = acct.pos > 0 ? "sell" : "buy", px = touch(m, side);
    if (px == null) return rej("No market yet");
    cancelAll(acct);
    return ok({ fill: fill(acct, side, Math.abs(acct.pos) * 2, px, clock(m), "reverse") });
  }

  /* Checks stop, target and the daily loss limit. Returns the events that fired. */
  function mark(acct, m) {
    var events = [], last = m.l1.last;
    if (acct.pos && last != null) {
      var long = acct.pos > 0;
      if (acct.stop != null && (long ? last <= acct.stop : last >= acct.stop)) {
        var sp = touch(m, long ? "sell" : "buy");
        events.push({ type: "stop", fill: fill(acct, long ? "sell" : "buy", Math.abs(acct.pos), sp != null ? sp : acct.stop, clock(m), "stop") });
      } else if (acct.target != null && (long ? last >= acct.target : last <= acct.target)) {
        events.push({ type: "target", fill: fill(acct, long ? "sell" : "buy", Math.abs(acct.pos), acct.target, clock(m), "target") });
      }
    }
    if (!acct.locked && acct.maxLoss > 0 && dayPnl(acct, m) <= -acct.maxLoss) {
      flatten(acct, m, "loss limit");
      acct.locked = true;
      acct.lockReason = "Max daily loss of $" + acct.maxLoss + " reached";
      events.push({ type: "lock" });
    }
    return events;
  }

  /* Resting orders fill when the tape trades at or through them. Queue position is not modelled. */
  function onTrade(acct, m, t) {
    var events = [], remaining = [];
    acct.orders.forEach(function (o) {
      var hit = o.side === "buy" ? t.price <= o.price : t.price >= o.price;
      if (hit && !acct.locked) events.push({ type: "fill", fill: fill(acct, o.side, o.qty, o.price, clock(m), o.tag) });
      else remaining.push(o);
    });
    acct.orders = remaining;
    return events.concat(mark(acct, m));
  }

  function resetDay(acct) { acct.realized = 0; acct.locked = false; acct.lockReason = ""; }

  OF.trading = {
    createAccount: createAccount, marketOrder: marketOrder, limitOrder: limitOrder, joinBid: joinBid, joinAsk: joinAsk,
    flatten: flatten, reverse: reverse, cancelAll: cancelAll, mark: mark, onTrade: onTrade, resetDay: resetDay,
    unrealized: unrealized, dayPnl: dayPnl, setBracket: setBracket
  };
})(globalThis);
