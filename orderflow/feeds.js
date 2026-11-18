/* Market data feeds. Every feed is an Emitter producing the same normalized events:
 *   status {state:"connecting"|"open"|"closed"|"error", text}   notice string
 *   trade {price,size,side,ts}  book {bids,asks}  delta {side,price,size}  quote {...}  levels {...}  latency ms
 * SimulatedFeed is a deterministic (seeded) replay. WebSocketFeed connects to any provider adapter. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  function Emitter() { this.handlers = {}; }
  Emitter.prototype.on = function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev, payload) {
    (this.handlers[ev] || []).forEach(function (fn) { fn(payload); });
  };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  var STEP_MS = 100, BOOK_DEPTH = 30, SNAPSHOT_DEPTH = 25, MAX_STEPS_PER_TICK = 400, LOOP_MS = 40;

  /* ---------- Simulated market replay ---------- */
  function SimulatedFeed(opts) {
    Emitter.call(this);
    this.cfg = opts.config || OF.config;
    this.seed = opts.seed == null ? this.cfg.replay.seed : opts.seed;
    this.speed = opts.speed || this.cfg.replay.speed;
    this.paused = false;
    this.timer = null;
  }
  SimulatedFeed.prototype = Object.create(Emitter.prototype);

  SimulatedFeed.prototype.start = function (symbolKey) {
    this.stop();
    var sym = this.cfg.symbols[symbolKey];
    this.symKey = symbolKey;
    this.sym = sym;
    this.rng = mulberry32(this.seed ^ hashString(symbolKey));
    this.bias = 0;
    this.warm = true;
    this.ice = new Map();
    this.walls = [];
    this.emit("status", { state: "connecting", text: "Starting replay" });

    var baseTick = Math.round(sym.base / sym.tick);
    this.bestBid = baseTick;
    this.bestAsk = baseTick + 1;
    this.bidSizes = [];
    this.askSizes = [];
    for (var k = 0; k < BOOK_DEPTH; k++) { this.bidSizes.push(this.levelSize()); this.askSizes.push(this.levelSize()); }

    this.emit("levels", this.buildLevels(baseTick));
    var warmupMs = this.cfg.replay.warmupBars * this.cfg.barMs;
    this.simNow = Math.floor(Date.now() / this.cfg.barMs) * this.cfg.barMs - warmupMs;
    var end = this.simNow + warmupMs;
    while (this.simNow < end) this.step();
    this.warm = false;
    this.emitSnapshot();
    this.emit("status", { state: "open", text: "Replay running" });

    var self = this, last = performance.now(), acc = 0;
    (function loop() {
      var now = performance.now();
      if (!self.paused) {
        acc += (now - last) * self.speed;
        var n = 0;
        while (acc >= STEP_MS && n < MAX_STEPS_PER_TICK) { self.step(); acc -= STEP_MS; n++; }
        if (acc > STEP_MS * MAX_STEPS_PER_TICK) acc = 0;
      }
      last = now;
      self.timer = setTimeout(loop, LOOP_MS);
    })();
  };
  SimulatedFeed.prototype.stop = function () { if (this.timer) clearTimeout(this.timer); this.timer = null; };
  SimulatedFeed.prototype.setSpeed = function (s) { this.speed = s; };
  SimulatedFeed.prototype.setPaused = function (p) { this.paused = !!p; };

  SimulatedFeed.prototype.gauss = function () {
    var u = Math.max(this.rng(), 1e-9), v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  SimulatedFeed.prototype.levelSize = function () {
    var raw = this.sym.depth * Math.exp(0.5 * this.gauss() - 0.125);
    return this.roundSize(Math.max(raw, this.sym.sizeStep));
  };
  SimulatedFeed.prototype.roundSize = function (v) {
    var st = this.sym.sizeStep;
    return Math.max(st, Math.round(v / st) * st);
  };
  SimulatedFeed.prototype.price = function (tick) { return Math.round(tick * this.sym.tick * 1e8) / 1e8; };

  SimulatedFeed.prototype.buildLevels = function (baseTick) {
    var r = this.rng.bind(this), range = this.sym.dayRangeTicks, self = this;
    var pdc = baseTick + Math.round(this.gauss() * range * 0.08);
    var lv = {
      pdc: pdc,
      pdh: pdc + Math.round(range * (0.25 + r() * 0.3)),
      pdl: pdc - Math.round(range * (0.2 + r() * 0.3)),
      onh: baseTick + Math.round(range * (0.03 + r() * 0.12)),
      onl: baseTick - Math.round(range * (0.03 + r() * 0.12)),
      wo: baseTick - Math.round(this.gauss() * range * 0.2)
    };
    Object.keys(lv).forEach(function (k) { lv[k] = self.price(lv[k]); });
    return lv;
  };

  SimulatedFeed.prototype.emitTrade = function (tick, size, side, ts) {
    this.emit("trade", { price: this.price(tick), size: size, side: side, ts: ts });
  };
  SimulatedFeed.prototype.emitDelta = function (side, tick, size) {
    if (!this.warm) this.emit("delta", { side: side, price: this.price(tick), size: size });
  };
  SimulatedFeed.prototype.emitSnapshot = function () {
    var self = this, bids = [], asks = [];
    for (var k = 0; k < SNAPSHOT_DEPTH; k++) {
      bids.push([this.price(this.bestBid - k), this.bidSizes[k]]);
      asks.push([this.price(this.bestAsk + k), this.askSizes[k]]);
    }
    this.emit("book", { bids: bids, asks: asks });
    return self;
  };

  /* Executes an aggressive order against the book, refilling icebergs and walking the price when a level is cleared. */
  SimulatedFeed.prototype.consume = function (side, qty, ts) {
    var asks = side === "buy", sizes = asks ? this.askSizes : this.bidSizes, guard = 0;
    while (qty > 1e-9 && guard++ < 200) {
      var tick = asks ? this.bestAsk : this.bestBid, key = (asks ? "a" : "b") + tick, ice = this.ice.get(key);
      var take = Math.min(qty, sizes[0]);
      if (take > 0) { this.emitTrade(tick, this.roundSize(take), side, ts); qty -= take; sizes[0] = Math.round((sizes[0] - take) * 1e6) / 1e6; }
      if (sizes[0] <= 1e-9) {
        if (ice && ice.reserve > 0) {
          var refill = Math.min(ice.peak, ice.reserve);
          sizes[0] = refill;
          ice.reserve -= refill;
          this.emitDelta(asks ? "a" : "b", tick, sizes[0]);
        } else {
          this.ice.delete(key);
          this.shift(asks);
        }
      } else {
        this.emitDelta(asks ? "a" : "b", tick, sizes[0]);
      }
    }
  };

  SimulatedFeed.prototype.shift = function (asks) {
    if (asks) {
      this.askSizes.shift(); this.askSizes.push(this.levelSize()); this.bestAsk++;
      if (this.bestAsk - this.bestBid > 1) { this.bidSizes.unshift(this.levelSize()); this.bidSizes.pop(); this.bestBid = this.bestAsk - 1; }
    } else {
      this.bidSizes.shift(); this.bidSizes.push(this.levelSize()); this.bestBid--;
      if (this.bestAsk - this.bestBid > 1) { this.askSizes.unshift(this.levelSize()); this.askSizes.pop(); this.bestAsk = this.bestBid + 1; }
    }
    if (!this.warm) this.emitSnapshot();
  };

  SimulatedFeed.prototype.poisson = function (lambda) {
    var l = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= this.rng(); } while (p > l && k < 30);
    return k - 1;
  };

  SimulatedFeed.prototype.step = function () {
    var sym = this.sym, r = this.rng.bind(this), ts = this.simNow;
    this.bias = this.bias * 0.985 + this.gauss() * 0.06;
    this.bias = Math.max(-0.6, Math.min(0.6, this.bias));
    var activity = 1.1 + 0.6 * Math.sin(ts / 240000);
    var orders = this.poisson(0.5 * activity), i;

    for (i = 0; i < orders; i++) {
      var pBuy = 0.5 + this.bias * 0.5, side = r() < pBuy ? "buy" : "sell";
      var iceBid = this.ice.has("b" + this.bestBid), iceAsk = this.ice.has("a" + this.bestAsk);
      if (iceBid && r() < 0.45) side = "sell";
      else if (iceAsk && r() < 0.45) side = "buy";
      var size = sym.avgTrade * Math.exp(0.85 * this.gauss() - 0.35);
      if (r() < 0.03) size *= 6 + r() * 6;
      this.consume(side, this.roundSize(size), ts + Math.floor(r() * STEP_MS));
    }

    var churn = 2 + Math.floor(r() * 3);
    for (i = 0; i < churn; i++) {
      var bidSide = r() < 0.5, arr = bidSide ? this.bidSizes : this.askSizes, k = Math.floor(r() * 14);
      var tick = bidSide ? this.bestBid - k : this.bestAsk + k;
      if (this.ice.has((bidSide ? "b" : "a") + tick) || this.walls.some(function (w) { return w.tick === tick; })) continue;
      arr[k] = this.roundSize(arr[k] + (this.levelSize() - arr[k]) * r() * 0.7);
      this.emitDelta(bidSide ? "b" : "a", tick, arr[k]);
    }

    if (this.walls.length < 2 && r() < 0.012) {
      var wBid = r() < 0.5, wk = 3 + Math.floor(r() * 7), wTick = wBid ? this.bestBid - wk : this.bestAsk + wk;
      (wBid ? this.bidSizes : this.askSizes)[wk] = this.roundSize(sym.depth * (7 + r() * 4));
      this.walls.push({ bid: wBid, tick: wTick, until: ts + (20 + r() * 40) * 1000 });
      this.emitDelta(wBid ? "b" : "a", wTick, (wBid ? this.bidSizes : this.askSizes)[wk]);
    }
    var self = this;
    this.walls = this.walls.filter(function (w) {
      var idx = w.bid ? self.bestBid - w.tick : w.tick - self.bestAsk;
      if (idx < 0 || idx >= BOOK_DEPTH) return false;
      var arr = w.bid ? self.bidSizes : self.askSizes;
      if (ts >= w.until) { arr[idx] = self.levelSize(); self.emitDelta(w.bid ? "b" : "a", w.tick, arr[idx]); return false; }
      return true;
    });

    if (this.ice.size === 0 && r() < 0.008) {
      var iBid = r() < 0.5, iTick = iBid ? this.bestBid : this.bestAsk;
      var peak = this.roundSize(sym.depth * 0.22);
      this.ice.set((iBid ? "b" : "a") + iTick, { peak: peak, reserve: this.roundSize(sym.depth * 5) });
      (iBid ? this.bidSizes : this.askSizes)[0] = peak;
      this.emitDelta(iBid ? "b" : "a", iTick, peak);
    }
    this.simNow += STEP_MS;
  };

  /* ---------- Generic WebSocket client with reconnect + stale watchdog ---------- */
  function WebSocketFeed(opts) {
    Emitter.call(this);
    this.cfg = opts.config || OF.config;
    this.provider = opts.provider;
    this.retry = 0;
    this.stopped = true;
    this.sockets = [];
    this.cycle = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastMsg = 0;
  }
  WebSocketFeed.prototype = Object.create(Emitter.prototype);

  WebSocketFeed.prototype.start = function (symbolKey) {
    this.stop();
    this.symKey = symbolKey;
    this.stopped = false;
    this.retry = 0;
    var self = this;
    this.watchdog = setInterval(function () {
      var live = self.sockets.length && self.sockets.every(function (s) { return s.readyState === 1; });
      if (live && Date.now() - self.lastMsg > self.cfg.live.staleAfterMs) {
        self.emit("notice", "No data for " + Math.round(self.cfg.live.staleAfterMs / 1000) + "s, reconnecting");
        self.sockets.forEach(function (s) { s.close(); });
      }
    }, 3000);
    this.connect();
  };

  WebSocketFeed.prototype.closeSockets = function () {
    this.sockets.forEach(function (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try { ws.close(); } catch (e) { /* already closed */ }
    });
    this.sockets = [];
  };

  WebSocketFeed.prototype.stop = function () {
    this.stopped = true;
    this.cycle++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    this.closeSockets();
  };

  /* A provider's url() may return one URL or several (Binance serves trades and depth from different endpoints).
   * The feed is "open" once every socket is open; if any socket drops, all are recycled together. */
  WebSocketFeed.prototype.connect = function () {
    var self = this, p = this.provider, urls;
    try { urls = p.url(this.symKey, this.cfg.live); } catch (e) { urls = null; }
    if (typeof urls === "string") urls = [urls];
    if (!urls || !urls.length || !urls.every(function (u) { return /^wss?:\/\//i.test(u); })) {
      this.emit("status", { state: "error", text: p.unsupported || "No valid WebSocket URL for " + this.symKey });
      return;
    }
    this.emit("status", { state: "connecting", text: "Connecting to " + p.label });
    var cycle = ++this.cycle, opened = 0, failed = false;

    function fail(text) {
      if (failed || self.stopped || cycle !== self.cycle) return;
      failed = true;
      self.closeSockets();
      self.emit("status", { state: "closed", text: text || "Disconnected" });
      self.scheduleReconnect();
    }
    function onOpen(ws, index) {
      return function () {
        opened++;
        var subs = p.subscribe ? p.subscribe(self.symKey, self.cfg.live, index) : [];
        subs.forEach(function (m) { ws.send(typeof m === "string" ? m : JSON.stringify(m)); });
        if (opened < urls.length) return;
        self.retry = 0;
        self.lastMsg = Date.now();
        self.emit("status", { state: "open", text: "Connected to " + p.label });
        if (p.loadLevels) {
          p.loadLevels(self.symKey).then(function (lv) { if (lv) self.emit("levels", lv); })
            .catch(function () { self.emit("notice", "Higher-timeframe levels unavailable from " + p.label); });
        }
      };
    }
    function onMessage(ev) {
      self.lastMsg = Date.now();
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { self.emit("notice", "Ignored a non-JSON message"); return; }
      var events = p.normalize(data) || [], gotLatency = false;
      events.forEach(function (e) {
        if (e.type === "trade" && !gotLatency && e.ts) { gotLatency = true; self.emit("latency", Math.max(0, self.lastMsg - e.ts)); }
        self.route(e);
      });
    }

    this.sockets = [];
    urls.forEach(function (url, index) {
      if (failed) return;
      var ws;
      try { ws = new WebSocket(url); } catch (e) { self.emit("notice", "Could not open WebSocket: " + e.message); fail("Could not connect"); return; }
      self.sockets.push(ws);
      ws.onopen = onOpen(ws, index);
      ws.onmessage = onMessage;
      ws.onerror = function () { self.emit("notice", "WebSocket error"); };
      ws.onclose = function () { fail("Disconnected"); };
    });
  };

  WebSocketFeed.prototype.route = function (e) {
    if (e.type === "trade" || e.type === "book" || e.type === "delta" || e.type === "quote" || e.type === "levels") this.emit(e.type, e);
  };

  WebSocketFeed.prototype.scheduleReconnect = function () {
    var self = this, live = this.cfg.live;
    var delay = Math.min(live.reconnectMaxMs, live.reconnectMinMs * Math.pow(2, this.retry++)) + Math.floor(Math.random() * 300);
    this.emit("status", { state: "connecting", text: "Reconnecting in " + Math.ceil(delay / 1000) + "s" });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(function () { if (!self.stopped) self.connect(); }, delay);
  };

  /* ---------- Provider adapters ---------- */
  function num(x) { return Number(x); }

  var binance = {
    label: "Binance Futures",
    symbols: ["BTCUSDT", "ETHUSDT"],
    supports: function (sym) { return /USDT$/.test(sym); },
    /* Binance serves trades (/market) and depth + best bid/ask (/public) from separate endpoints. */
    url: function (sym) {
      var s = sym.toLowerCase();
      return [
        "wss://fstream.binance.com/market/stream?streams=" + s + "@aggTrade",
        "wss://fstream.binance.com/public/stream?streams=" + s + "@depth20@100ms/" + s + "@bookTicker"
      ];
    },
    subscribe: function () { return []; },
    normalize: function (msg) {
      var d = msg && msg.data ? msg.data : msg;
      if (!d) return [];
      if (d.e === "aggTrade") return [{ type: "trade", price: num(d.p), size: num(d.q), side: d.m ? "sell" : "buy", ts: d.T }];
      if (d.e === "depthUpdate") {
        var b = d.b || d.bids || [], a = d.a || d.asks || [];
        return [{ type: "book", bids: b.map(function (x) { return [num(x[0]), num(x[1])]; }), asks: a.map(function (x) { return [num(x[0]), num(x[1])]; }) }];
      }
      if (d.e === "bookTicker" || (d.b != null && d.B != null && d.a != null && d.A != null)) {
        return [{ type: "quote", bid: num(d.b), bidSize: num(d.B), ask: num(d.a), askSize: num(d.A) }];
      }
      return [];
    },
    loadLevels: function (sym) {
      var base = "https://fapi.binance.com/fapi/v1/klines?symbol=" + encodeURIComponent(sym);
      return Promise.all([fetch(base + "&interval=1d&limit=3"), fetch(base + "&interval=1w&limit=1")]).then(function (rs) {
        return Promise.all(rs.map(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }));
      }).then(function (out) {
        var days = out[0], prev = days[days.length - 2], week = out[1][0];
        if (!prev) return null;
        return { pdh: num(prev[2]), pdl: num(prev[3]), pdc: num(prev[4]), wo: week ? num(week[1]) : null };
      });
    }
  };

  /* Your own server-side relay: it holds the vendor API key and republishes normalized messages. */
  var relay = {
    label: "custom relay",
    supports: function () { return true; },
    url: function (sym, live) { return live.url ? live.url.replace("{symbol}", encodeURIComponent(sym)) : null; },
    subscribe: function (sym, live) {
      return (live.subscribe || []).map(function (m) { return typeof m === "string" ? m.replace("{symbol}", sym) : JSON.parse(JSON.stringify(m).replace("{symbol}", sym)); });
    },
    normalize: function (msg) { return Array.isArray(msg) ? msg : [msg]; },
    unsupported: "Set OF.config.live.url (or ?url=wss://...) to your relay endpoint"
  };

  function needsRelay(label) {
    return { label: label, supports: function () { return false; }, url: function () { return null; }, normalize: function () { return []; },
      unsupported: label + " requires an API key, so run a server-side relay and use the \"relay\" provider" };
  }

  OF.feeds = {
    Emitter: Emitter, SimulatedFeed: SimulatedFeed, WebSocketFeed: WebSocketFeed, mulberry32: mulberry32,
    providers: { binance: binance, relay: relay, databento: needsRelay("Databento"), rithmic: needsRelay("Rithmic"), polygon: needsRelay("Polygon") },
    registerProvider: function (name, provider) { OF.feeds.providers[name] = provider; }
  };
})(globalThis);
