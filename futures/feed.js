/* Futures Desk data layer. One Feed with two sources: a tick-accurate simulator and a WebSocket relay you run yourself.
 * Both push through ingestTrade() and ingestBook(), so the desk never knows where data came from.
 *   trade: { ts, price, size, side: "buy" | "sell" }
 *   book:  { bids: [[price, size], ...], asks: [[price, size], ...] }
 * The feed only reports "live" while a relay socket is open and messages are actually arriving. */
(function (g) {
  "use strict";
  var FD = (g.FD = g.FD || {});

  var STEP_MS = 100, BOOK_EVERY_MS = 200, DEPTH = 40, BOOK_OUT = 30, STALE_MS = 15000, WATCHDOG_MS = 2000, RECONNECT_MIN = 1000, RECONNECT_MAX = 15000;
  var MAX_STEPS_PER_TICK = 600, LOOP_MS = 50, MS_PER_SEC_SIM = 1000;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ---------- Simulator ---------- */
  /* Steps in fixed 100 ms slices of simulated time. A trade fills at the touch and eats the book, so large orders sweep several
   * levels. Regimes alternate between ranging (mean reverting) and trending (one-sided flow). Sizes are lognormal with rare bursts. */
  function Sim(sym, opts) {
    var o = opts || {};
    this.sym = sym; this.rng = mulberry32((o.seed || 1) ^ hash(o.symbol || "X"));
    this.t = o.startTs || Date.now();
    this.bb = Math.round(sym.base / sym.tick);
    this.anchor = this.bb; this.regime = { kind: "range", dir: 1, until: this.t + 120000 };
    this.sigma = 0.9; this.mu = Math.log(sym.avgSize) - this.sigma * this.sigma / 2;
    this.bidSizes = []; this.askSizes = [];
    for (var k = 0; k < DEPTH; k++) { this.bidSizes.push(this.levelSize(k)); this.askSizes.push(this.levelSize(k)); }
    this.sinceBook = 0; this.out = o.out || { trade: function () {}, book: function () {} };
  }

  Sim.prototype.gauss = function () { var u = 1 - this.rng(), v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  Sim.prototype.size = function () {
    var s = Math.exp(this.mu + this.sigma * this.gauss());
    if (this.rng() < 0.03) s *= 4 + this.rng() * 6;
    return Math.max(1, Math.round(s));
  };
  Sim.prototype.levelSize = function (k) { return Math.max(1, Math.round(this.sym.avgSize * (3 + k * 0.45) * (this.sym.depthMult || 1) * Math.exp(0.5 * this.gauss()))); };
  Sim.prototype.price = function (tick) { return Math.round(tick * this.sym.tick * 100) / 100; };
  Sim.prototype.poisson = function (lambda) { var L = Math.exp(-lambda), k = 0, p = 1; do { k++; p *= this.rng(); } while (p > L && k < 60); return k - 1; };

  Sim.prototype.pickRegime = function () {
    var trending = this.rng() < 0.45;
    this.regime = { kind: trending ? "trend" : "range", dir: this.rng() < 0.5 ? -1 : 1, until: this.t + (2 + this.rng() * 4) * 60000 };
    if (!trending) this.anchor = this.bb;
  };

  /* Fills `size` against the opposite side, moving the touch when a level is exhausted. Returns the trades it produced. */
  Sim.prototype.fill = function (side, size) {
    var out = [], sizes = side === "buy" ? this.askSizes : this.bidSizes, other = side === "buy" ? this.bidSizes : this.askSizes;
    while (size > 0) {
      var touch = side === "buy" ? this.bb + 1 : this.bb, take = Math.min(size, sizes[0]);
      out.push({ ts: this.t, price: this.price(touch), size: take, side: side });
      size -= take; sizes[0] -= take;
      if (sizes[0] <= 0) {
        sizes.shift(); sizes.push(this.levelSize(DEPTH - 1));
        this.bb += side === "buy" ? 1 : -1;
        other.unshift(Math.max(1, Math.round(this.levelSize(0) * 0.4))); other.pop();
      }
    }
    return out;
  };

  Sim.prototype.refresh = function () {
    var self = this;
    [this.bidSizes, this.askSizes].forEach(function (arr) {
      arr[0] = Math.max(1, arr[0] + Math.round(self.sym.avgSize * (self.rng() - 0.3) * 2));
      for (var k = 1; k < DEPTH; k++) {
        if (self.rng() < 0.08) arr[k] = Math.max(1, Math.round(arr[k] + (self.levelSize(k) - arr[k]) * self.rng()));
      }
      if (self.rng() < 0.012) arr[2 + Math.floor(self.rng() * 12)] = Math.round(self.sym.rest * (1.2 + self.rng() * 2.5));
    });
  };

  Sim.prototype.snapshot = function () {
    var bids = [], asks = [];
    for (var k = 0; k < BOOK_OUT; k++) { bids.push([this.price(this.bb - k), this.bidSizes[k]]); asks.push([this.price(this.bb + 1 + k), this.askSizes[k]]); }
    return { bids: bids, asks: asks };
  };

  Sim.prototype.step = function () {
    this.t += STEP_MS;
    if (this.t >= this.regime.until) this.pickRegime();
    var trend = this.regime.kind === "trend", pBuy = 0.5;
    if (trend) pBuy = 0.5 + 0.17 * this.regime.dir;
    else pBuy = Math.max(0.3, Math.min(0.7, 0.5 - (this.bb - this.anchor) * 0.025));
    var rate = (trend ? 13 : 8) * (0.6 + this.rng() * 0.8), n = this.poisson(rate * STEP_MS / MS_PER_SEC_SIM);
    for (var i = 0; i < n; i++) {
      var side = this.rng() < pBuy ? "buy" : "sell", trades = this.fill(side, this.size());
      for (var j = 0; j < trades.length; j++) this.out.trade(trades[j]);
    }
    this.refresh();
    this.sinceBook += STEP_MS;
    if (this.sinceBook >= BOOK_EVERY_MS) { this.sinceBook = 0; this.out.book(this.snapshot()); }
  };

  Sim.prototype.advance = function (ms) { for (var done = 0; done < ms; done += STEP_MS) this.step(); };

  /* ---------- Feed ---------- */
  function Feed() {
    this.subs = { trade: [], book: [], status: [] };
    this.mode = "sim"; this.state = "idle"; this.text = ""; this.sim = null; this.timer = null; this.ws = null; this.wsUrl = ""; this.symbol = "MNQ";
    this.paused = false; this.speed = 1; this.lastMsg = 0; this.msgs = 0; this.invalid = 0; this.retry = RECONNECT_MIN; this.retryTimer = null; this.watchdog = null; this.closing = false;
  }

  Feed.prototype.on = function (k, fn) { this.subs[k].push(fn); };
  Feed.prototype.emit = function (k, a) { this.subs[k].forEach(function (fn) { fn(a); }); };

  Feed.prototype.setState = function (state, text) {
    if (this.state === state && this.text === text) return;
    this.state = state; this.text = text;
    this.emit("status", { mode: this.mode, state: state, text: text });
  };

  /* Public interface used by both sources. Bad input is counted and ignored, never thrown. */
  Feed.prototype.ingestTrade = function (t) {
    if (this.paused) return false;
    var ts = Number(t && t.ts);
    if (isFinite(ts) && ts > 0 && ts < 1e11) ts *= 1000;
    var tr = { ts: ts, price: Number(t && t.price), size: Number(t && t.size), side: t && t.side };
    if (!(tr.price > 0) || !(tr.size > 0) || !isFinite(tr.ts)) { this.invalid++; return false; }
    if (tr.side !== "buy" && tr.side !== "sell") tr.side = undefined;
    this.lastMsg = Date.now(); this.msgs++;
    this.emit("trade", tr);
    return true;
  };

  Feed.prototype.ingestBook = function (b) {
    if (this.paused) return false;
    if (!b || !Array.isArray(b.bids) || !Array.isArray(b.asks)) { this.invalid++; return false; }
    this.lastMsg = Date.now(); this.msgs++;
    this.emit("book", { bids: b.bids, asks: b.asks });
    return true;
  };

  Feed.prototype.stop = function () {
    this.closing = true;
    clearTimeout(this.timer); clearTimeout(this.retryTimer); clearInterval(this.watchdog);
    this.timer = this.retryTimer = this.watchdog = null;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } this.ws = null; }
    this.sim = null;
  };

  /* ---------- Simulator source ---------- */
  Feed.prototype.startSim = function (symbol, o) {
    this.stop(); this.closing = false;
    var sym = FD.SYMBOLS[symbol], opts = o || {}, self = this;
    this.mode = "sim"; this.symbol = symbol; this.speed = opts.speed || 1;
    var warm = opts.warmMs == null ? 20 * 60000 : opts.warmMs, bar = opts.barMs || 60000;
    this.sim = new Sim(sym, { symbol: symbol, seed: opts.seed || 20261122, startTs: Math.floor(Date.now() / bar) * bar - warm,
      out: { trade: function (t) { self.ingestTrade(t); }, book: function (b) { self.ingestBook(b); } } });
    var was = this.paused; this.paused = false;
    this.sim.advance(warm);
    this.paused = was;
    this.setState(this.paused ? "paused" : "sim", "Simulated data");
    var last = performance.now(), acc = 0;
    (function loop() {
      var now = performance.now();
      if (!self.paused && self.sim) {
        acc += (now - last) * self.speed;
        var n = 0;
        while (acc >= STEP_MS && n < MAX_STEPS_PER_TICK) { self.sim.step(); acc -= STEP_MS; n++; }
        if (acc > STEP_MS * MAX_STEPS_PER_TICK) acc = 0;
      }
      last = now;
      self.timer = setTimeout(loop, LOOP_MS);
    })();
  };

  Feed.prototype.setSpeed = function (s) { this.speed = s; };
  Feed.prototype.setPaused = function (p) {
    this.paused = !!p;
    if (this.mode === "sim") this.setState(this.paused ? "paused" : "sim", this.paused ? "Paused" : "Simulated data");
    else this.refreshRelayState();
  };

  /* ---------- Relay source ---------- */
  function validUrl(u) { return /^wss?:\/\/[^\s]+$/i.test(String(u || "").trim()); }
  FD.validRelayUrl = validUrl;

  Feed.prototype.connect = function (url, symbol) {
    this.stop(); this.closing = false;
    url = String(url || "").trim();
    this.mode = "relay"; this.symbol = symbol; this.wsUrl = url; this.msgs = 0; this.invalid = 0; this.lastMsg = 0;
    if (!validUrl(url)) { this.setState("disconnected", "Enter a relay address that starts with ws:// or wss://"); return false; }
    this.open();
    var self = this;
    this.watchdog = setInterval(function () { self.refreshRelayState(); }, WATCHDOG_MS);
    return true;
  };

  Feed.prototype.open = function () {
    var self = this, ws;
    this.setState("connecting", "Connecting to relay…");
    try { ws = new WebSocket(this.wsUrl); } catch (e) { this.setState("disconnected", "Relay disconnected — reconnecting…"); this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = function () {
      self.retry = RECONNECT_MIN;
      try { ws.send(JSON.stringify({ action: "subscribe", symbol: self.symbol })); } catch (e) { /* relay may not accept subscribe messages */ }
      self.refreshRelayState();
    };
    ws.onmessage = function (e) { self.onMessage(e.data); self.refreshRelayState(); };
    ws.onerror = function () { /* onclose follows */ };
    ws.onclose = function () {
      if (self.closing || self.ws !== ws) return;
      self.ws = null;
      self.setState("disconnected", "Relay disconnected — reconnecting…");
      self.scheduleRetry();
    };
  };

  Feed.prototype.scheduleRetry = function () {
    var self = this;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () { if (!self.closing) self.open(); }, this.retry);
    this.retry = Math.min(RECONNECT_MAX, this.retry * 2);
  };

  Feed.prototype.onMessage = function (raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { this.invalid++; return; }
    var list = Array.isArray(data) ? data : [data];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== "object") { this.invalid++; continue; }
      if (m.type === "trade") this.ingestTrade(m);
      else if (m.type === "book") this.ingestBook(m);
    }
  };

  /* "live" means the socket is open and data arrived recently. Anything else is reported honestly. */
  Feed.prototype.refreshRelayState = function () {
    if (this.mode !== "relay" || this.closing || !validUrl(this.wsUrl)) return;
    var open = this.ws && this.ws.readyState === 1, now = Date.now();
    if (!open) { if (this.state !== "connecting") this.setState("disconnected", "Relay disconnected — reconnecting…"); return; }
    if (this.paused) { this.setState("paused", "Paused"); return; }
    if (!this.msgs) this.setState("waiting", "Relay connected — waiting for data");
    else if (now - this.lastMsg > STALE_MS) this.setState("stale", "Relay connected — no data for " + Math.round((now - this.lastMsg) / 1000) + "s");
    else this.setState("live", "Live");
  };

  FD.Sim = Sim; FD.Feed = Feed; FD.mulberry32 = mulberry32;
})(globalThis);
