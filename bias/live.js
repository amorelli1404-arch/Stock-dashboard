/* Globe / Bias card: live polling and rendering. Prices come from Binance (TradFi perpetuals and EUR/USDT spot),
 * headlines from the investingLive feed through rss2json. All external text is written with textContent. */
(function (g) {
  "use strict";
  var GB = g.GB;
  if (!GB || typeof document === "undefined") return;
  var root = document.getElementById("gbRoot");
  if (!root) return;

  var FUT = "https://fapi.binance.com/fapi/v1/", SPOT = "https://api.binance.com/api/v3/";
  var NEWS_URL = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent("https://www.forexlive.com/feed/news");
  var PRICE_MS = 4000, CANDLE_MS = 60000, NEWS_MS = 120000, TICK_MS = 1000, FRESH_MS = 15000, CAROUSEL_MS = 8000, PAUSE_MS = 20000, MAX_SLIDES = 6, SWIPE_PX = 40, FETCH_TIMEOUT = 8000, FLASH_MS = 700;

  var S = { candles: {}, price: {}, prevPrice: {}, priceAt: 0, news: [], newsAt: 0, newsError: false, priceError: false, slide: 0, pausedUntil: 0, lastSlideAt: 0, open: null, rows: {}, sig: {} };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
  function setCls(n, c) { if (n.className !== c) n.className = c; }
  function pad(n) { return String(n).padStart(2, "0"); }

  /* The card only polls while it is on screen, so it costs nothing in other views. */
  function active() { return root.getClientRects().length > 0 && !document.hidden; }

  function getJson(url) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, t = setTimeout(function () { if (ctl) ctl.abort(); }, FETCH_TIMEOUT);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }, function (e) { clearTimeout(t); throw e; });
  }
  function base(inst) { return inst.market === "spot" ? SPOT : FUT; }

  /* ---------- Polling ---------- */
  function pollPrices() {
    if (!active()) return;
    var jobs = GB.INSTRUMENTS.map(function (inst) {
      return getJson(base(inst) + "ticker/price?symbol=" + inst.symbol).then(function (j) {
        var p = Number(j.price);
        if (!(p > 0)) throw new Error("bad price");
        S.prevPrice[inst.id] = S.price[inst.id]; S.price[inst.id] = p; return true;
      }).catch(function () { return false; });
    });
    Promise.all(jobs).then(function (r) { if (r.some(Boolean)) { S.priceAt = Date.now(); S.priceError = false; } else S.priceError = true; render(); });
  }

  function pollCandles() {
    if (!active()) return;
    GB.INSTRUMENTS.forEach(function (inst) {
      getJson(base(inst) + "klines?symbol=" + inst.symbol + "&interval=5m&limit=300").then(function (rows) { S.candles[inst.id] = GB.parseKlines(rows); render(); }).catch(function () { /* keep the previous candles */ });
    });
  }

  function pollNews() {
    if (!active()) return;
    getJson(NEWS_URL).then(function (j) {
      var items = GB.parseFeed(j, "investingLive");
      if (!items.length) throw new Error("empty feed");
      S.news = items; S.newsAt = Date.now(); S.newsError = false; S.slide = Math.min(S.slide, MAX_SLIDES - 1); render(); buildDots();
    }).catch(function () { S.newsError = true; render(); });
  }

  /* ---------- Derived state ---------- */
  function read(inst) { return GB.score(S.candles[inst.id] || [], inst.sigma, Date.now(), S.price[inst.id]); }

  function feedStatus() {
    var age = Date.now() - S.priceAt;
    if (!S.priceAt) return S.priceError ? ["OFFLINE", "off"] : ["CONNECTING", "wait"];
    return age <= FRESH_MS ? ["LIVE", "live"] : ["DELAYED", "wait"];
  }

  /* ---------- Flags ---------- */
  var FLAGS = {
    us: '<svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" fill="#f4f4f6"/><g fill="#d6334a"><rect y="0" width="36" height="4"/><rect y="8" width="36" height="4"/><rect y="16" width="36" height="4"/><rect y="24" width="36" height="4"/><rect y="32" width="36" height="4"/></g><rect width="17" height="20" fill="#3a3f8f"/></svg>',
    eu: (function () { var d = ""; for (var i = 0; i < 12; i++) { var a = i / 12 * Math.PI * 2; d += '<circle cx="' + (18 + 9 * Math.cos(a)).toFixed(1) + '" cy="' + (18 + 9 * Math.sin(a)).toFixed(1) + '" r="1.5" fill="#ffd400"/>'; } return '<svg viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" fill="#1d3f9e"/>' + d + "</svg>"; })()
  };

  function icon(inst) {
    var box = el("span", "gb-ico");
    if (inst.flag === "au") { var c = el("span", "gb-circle gb-au", "Au"); box.appendChild(c); return box; }
    var a = el("span", "gb-circle"); a.innerHTML = FLAGS[inst.flag];
    box.appendChild(a);
    if (inst.id === "EURUSD") { var b = el("span", "gb-circle gb-second"); b.innerHTML = FLAGS.us; box.appendChild(b); box.className += " pair"; }
    return box;
  }

  /* ---------- Build ---------- */
  function buildSessions() {
    var box = $("gbSessions");
    box.textContent = "";
    GB.SESSIONS.forEach(function (s) {
      var card = el("div", "gb-session"), top = el("div", "gb-s-top"), dot = el("i", "gb-sq"), name = el("b", "", s.name);
      top.appendChild(dot); top.appendChild(name);
      card.appendChild(top); card.appendChild(el("div", "gb-s-state")); card.appendChild(el("div", "gb-s-win mono"));
      box.appendChild(card);
    });
  }

  function buildRows() {
    var box = $("gbRows");
    box.textContent = "";
    GB.INSTRUMENTS.forEach(function (inst) {
      var row = el("button", "gb-row loading"), mid = el("span", "gb-mid"), l1 = el("span", "gb-line1"), right = el("span", "gb-right"), gauge = el("span", "gb-gauge");
      row.type = "button"; row.setAttribute("data-id", inst.id); row.setAttribute("aria-label", inst.name + " daily bias, open the full read");
      row.appendChild(icon(inst));
      l1.appendChild(el("b", "gb-sym", inst.name));
      if (inst.proxy) { var px = el("i", "gb-proxy", inst.proxy); px.title = inst.name + " is priced through " + inst.proxy; l1.appendChild(px); }
      var label = el("b", "gb-label"), score = el("span", "gb-score");
      l1.appendChild(label); l1.appendChild(score);
      mid.appendChild(l1); mid.appendChild(el("span", "gb-sub"));
      right.appendChild(el("b", "gb-price mono")); right.appendChild(el("span", "gb-pct"));
      ["fill", "knob", "tick"].forEach(function (c) { gauge.appendChild(el("i", c)); });
      row.appendChild(mid); row.appendChild(right); row.appendChild(gauge);
      row.addEventListener("click", function () { openSheet(inst.id); });
      box.appendChild(row);
      S.rows[inst.id] = { row: row, label: label, score: score, sub: mid.lastChild, price: right.firstChild, pct: right.lastChild, fill: gauge.children[0], knob: gauge.children[1] };
    });
  }

  function buildDots() {
    var box = $("gbDots"), n = Math.min(MAX_SLIDES, S.news.length);
    if (box.children.length === n) return;
    box.textContent = "";
    for (var i = 0; i < n; i++) {
      (function (idx) {
        var d = el("button", "gb-dot"); d.type = "button"; d.setAttribute("aria-label", "Headline " + (idx + 1));
        d.addEventListener("click", function () { go(idx, true); });
        box.appendChild(d);
      })(i);
    }
  }

  /* ---------- Render ---------- */
  function renderHead() {
    var st = feedStatus(), live = $("gbLive");
    setCls(live, "gb-live " + st[1]); setText($("gbLiveText"), st[0]);
    var d = new Date();
    setText($("gbClock"), pad(d.getHours()) + ":" + pad(d.getMinutes()));
  }

  function renderSessions() {
    var now = Date.now(), cards = $("gbSessions").children;
    GB.SESSIONS.forEach(function (s, i) {
      var st = GB.sessionState(s, now), c = cards[i], day = GB.dayStartUtc(now);
      setCls(c.firstChild.firstChild, "gb-sq " + (st.open ? "open" : "closed"));
      setText(c.children[1], (st.open ? "closes in " : "opens in ") + GB.fmtCountdown(st.ms));
      var a = new Date(day + s.from * 60000), b = new Date(day + s.to * 60000);
      setText(c.children[2], pad(a.getHours()) + ":" + pad(a.getMinutes()) + "–" + pad(b.getHours()) + ":" + pad(b.getMinutes()));
    });
  }

  function renderAlert() {
    var item = S.news[S.slide], card = $("gbAlert");
    if (!item) {
      setText($("gbPill"), S.newsError ? "OFFLINE" : "NEWS"); setCls($("gbPill"), "gb-pill neutral");
      setText($("gbSrc"), S.newsError ? "investingLive · unreachable, retrying" : "investingLive");
      setText($("gbHead"), S.newsError ? "Headlines are not reachable from this browser right now." : "Waiting for the latest headline.");
      $("gbHead").removeAttribute("href"); card.classList.toggle("plain", true);
      return;
    }
    var isAlert = GB.isAlert(item.title);
    card.classList.toggle("plain", !isAlert);
    setText($("gbPill"), isAlert ? "ALERT" : "NEWS"); setCls($("gbPill"), "gb-pill " + (isAlert ? "alert" : "neutral"));
    setText($("gbSrc"), item.source + " · " + GB.timeAgo(item.ts, Date.now()));
    var h = $("gbHead");
    if (h.textContent !== item.title) { h.classList.remove("in"); void h.offsetWidth; h.classList.add("in"); }
    setText(h, item.title);
    if (item.link) { h.setAttribute("href", item.link); h.setAttribute("target", "_blank"); h.setAttribute("rel", "noopener noreferrer"); } else h.removeAttribute("href");
    var dots = $("gbDots").children;
    for (var i = 0; i < dots.length; i++) setCls(dots[i], "gb-dot" + (i === S.slide ? " on" : ""));
  }

  function flash(node, dir) {
    if (!dir) return;
    node.classList.remove("up", "down"); void node.offsetWidth; node.classList.add(dir > 0 ? "up" : "down");
    setTimeout(function () { node.classList.remove("up", "down"); }, FLASH_MS);
  }

  function renderRows() {
    GB.INSTRUMENTS.forEach(function (inst) {
      var r = S.rows[inst.id], res = read(inst), price = S.price[inst.id];
      r.row.classList.toggle("loading", price == null && !res.ready);
      if (price != null) {
        var txt = GB.fmtPrice(price, inst.dec), prev = S.prevPrice[inst.id];
        if (r.price.textContent !== txt) { flash(r.price, prev != null ? Math.sign(price - prev) : 0); r.price.textContent = txt; }
      }
      if (!res.ready) {
        setText(r.label, "Waiting"); setCls(r.label, "gb-label wait"); setText(r.score, "");
        setText(r.sub, (res.dayType || "Waiting") + " · " + (res.state === "Forming" ? "Forming" : "Waiting"));
        if (res.pct != null) { setText(r.pct, GB.fmtPct(res.pct) + " today"); setCls(r.pct, "gb-pct " + (res.pct < 0 ? "bear" : res.pct > 0 ? "bull" : "")); } else setText(r.pct, "");
        r.knob.style.left = "50%"; r.fill.style.width = "0";
        return;
      }
      var tone = res.label === "Bearish" ? "bear" : res.label === "Bullish" ? "bull" : "neutral";
      setText(r.label, res.label); setCls(r.label, "gb-label " + tone); setText(r.score, (res.score > 0 ? "+" : "") + res.score);
      setText(r.sub, res.dayType + " · " + res.state);
      setText(r.pct, GB.fmtPct(res.pct) + " today"); setCls(r.pct, "gb-pct " + (res.pct < 0 ? "bear" : res.pct > 0 ? "bull" : ""));
      var pos = (res.score + 100) / 2;
      r.knob.style.left = pos + "%"; r.knob.className = "knob " + tone;
      r.fill.className = "fill " + tone; r.fill.style.left = Math.min(50, pos) + "%"; r.fill.style.width = Math.abs(pos - 50) + "%";
    });
  }

  function renderFoot() {
    var t = S.priceAt ? new Date(S.priceAt) : null;
    setText($("gbFoot"), (S.priceError && !S.priceAt ? "Live prices are not reachable from this browser. Retrying every few seconds. " : "") + (t ? "Prices updated " + pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds()) + ". " : ""));
  }

  function render() { renderHead(); renderSessions(); renderRows(); renderAlert(); renderFoot(); if (S.open) renderSheet(); }

  /* ---------- Carousel ---------- */
  function go(i, byUser) {
    var n = Math.min(MAX_SLIDES, S.news.length);
    if (!n) return;
    S.slide = (i + n) % n; S.lastSlideAt = Date.now();
    if (byUser) S.pausedUntil = Date.now() + PAUSE_MS;
    renderAlert();
  }

  function bindCarousel() {
    var card = $("gbAlert"), x0 = null;
    card.addEventListener("pointerdown", function (e) { x0 = e.clientX; });
    card.addEventListener("pointerup", function (e) {
      if (x0 == null) return;
      var dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) >= SWIPE_PX) go(S.slide + (dx < 0 ? 1 : -1), true);
    });
    card.addEventListener("pointercancel", function () { x0 = null; });
  }

  /* ---------- Full read sheet ---------- */
  function bar(name, weight, v, text) {
    var r = el("div", "gb-part"), head = el("div", "gb-part-head"), track = el("div", "gb-part-track"), fill = el("i", v < 0 ? "bear" : "bull");
    head.appendChild(el("span", "", name + " (" + Math.round(weight * 100) + "%)")); head.appendChild(el("b", "mono", text));
    fill.style.left = v < 0 ? (50 + v * 50) + "%" : "50%"; fill.style.width = Math.abs(v) * 50 + "%";
    track.appendChild(fill); track.appendChild(el("u")); r.appendChild(head); r.appendChild(track);
    return r;
  }

  function renderSheet() {
    var inst = GB.INSTRUMENTS.filter(function (i) { return i.id === S.open; })[0], body = $("gbSheetBody");
    if (!inst) return;
    var res = read(inst), price = S.price[inst.id], W = GB.WEIGHTS, key = inst.id + ":" + (res.ready ? res.score : "w") + ":" + (price || 0).toFixed(inst.dec) + ":" + S.news.length;
    if (S.sig.sheet === key) return;
    S.sig.sheet = key;
    body.textContent = "";
    var head = el("div", "gb-sh-head");
    head.appendChild(el("h3", "", inst.name + (inst.proxy || inst.via ? " · via " + (inst.proxy || inst.via) : "")));
    head.appendChild(el("b", "gb-label " + (res.ready ? (res.label === "Bearish" ? "bear" : res.label === "Bullish" ? "bull" : "neutral") : "wait"), res.ready ? res.label + " " + (res.score > 0 ? "+" : "") + res.score : "Waiting for data"));
    body.appendChild(head);
    if (!res.ready) { body.appendChild(el("p", "gb-note", "There is not enough of today's data yet to form a read. It fills in as candles arrive.")); }
    else {
      body.appendChild(el("h4", "gb-dh", "Why this read"));
      body.appendChild(bar("Today's move", W.move, res.parts.move, GB.fmtPct(res.pct)));
      body.appendChild(bar("Position in today's range", W.range, res.parts.range, Math.round(res.rangePos * 100) + "% of the range"));
      body.appendChild(bar("1-hour momentum", W.momentum, res.parts.momentum, GB.fmtPct(res.momentum)));
      body.appendChild(el("h4", "gb-dh", "Today so far (since 00:00 UTC)"));
      var kv = el("div", "gb-kvs");
      [["Open", GB.fmtPrice(res.open, inst.dec)], ["High", GB.fmtPrice(res.hi, inst.dec)], ["Low", GB.fmtPrice(res.lo, inst.dec)], ["Last", GB.fmtPrice(res.last, inst.dec)], ["Range", res.rangePct.toFixed(2) + "%"], ["Day type", res.dayType + " (" + res.state + ")"]].forEach(function (p) {
        var r = el("div", "gb-kv"); r.appendChild(el("span", "", p[0])); r.appendChild(el("b", "mono", p[1])); kv.appendChild(r);
      });
      body.appendChild(kv);
    }
    var rel = GB.related(S.news, inst, 3);
    body.appendChild(el("h4", "gb-dh", "Related headlines"));
    if (!rel.length) body.appendChild(el("p", "gb-note", "No recent headlines mention this market."));
    rel.forEach(function (it) {
      var a = el(it.link ? "a" : "div", "gb-rel");
      if (it.link) { a.href = it.link; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      a.appendChild(el("span", "gb-rel-t", it.title)); a.appendChild(el("span", "gb-rel-s mono", it.source + " · " + GB.timeAgo(it.ts, Date.now())));
      body.appendChild(a);
    });
    body.appendChild(el("p", "gb-note", "A rule-based read of live prices: today's move (50%), position in today's range (30%) and 1-hour momentum (20%), scaled by a typical daily move for this market. Bullish above +20, bearish below -20. It is not a forecast and not investment advice." +
      (inst.proxy ? " " + inst.name + " is priced through " + inst.proxy + ", so levels differ from the futures contract." : "")));
  }

  function openSheet(id) { S.open = id; S.sig.sheet = ""; $("gbSheet").hidden = false; document.body.classList.add("gb-sheet-open"); renderSheet(); $("gbSheetClose").focus(); }
  function closeSheet() { S.open = null; $("gbSheet").hidden = true; document.body.classList.remove("gb-sheet-open"); }

  function bindSheet() {
    $("gbSheetClose").addEventListener("click", closeSheet);
    $("gbSheet").addEventListener("click", function (e) { if (e.target === $("gbSheet")) closeSheet(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.open) { closeSheet(); e.stopPropagation(); } }, true);
  }

  /* ---------- Loop ---------- */
  var timers = {};
  function loop() {
    renderHead(); renderSessions();
    if (S.news.length > 1 && Date.now() >= S.pausedUntil && Date.now() - S.lastSlideAt >= CAROUSEL_MS) go(S.slide + 1, false);
    else renderAlert();
    if (S.open) renderSheet();
  }

  function init() {
    buildSessions(); buildRows(); bindCarousel(); bindSheet(); render();
    pollPrices(); pollCandles(); pollNews();
    timers.p = setInterval(pollPrices, PRICE_MS);
    timers.c = setInterval(pollCandles, CANDLE_MS);
    timers.n = setInterval(pollNews, NEWS_MS);
    timers.t = setInterval(loop, TICK_MS);
    /* Catch up straight away when the card comes back into view. */
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { pollPrices(); pollNews(); } });
    document.querySelectorAll('.nav-item[data-view="feed"]').forEach(function (n) { n.addEventListener("click", function () { setTimeout(function () { pollPrices(); pollCandles(); pollNews(); }, 50); }); });
  }

  GB.live = { state: S, read: read };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
