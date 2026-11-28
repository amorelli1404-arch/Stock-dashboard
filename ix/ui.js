/* Index Workstation controller: wires the data source to the chart and the supporting panes (breadth, NQ/ES ratio, levels,
 * headlines, scenario desk), the release countdown, performance and seasonality strips and the prop-firm risk panel.
 * All dynamic text is written with textContent. */
(function (g) {
  "use strict";
  var IX = g.IX, OF = g.OF;
  if (!IX || typeof document === "undefined") return;
  var root = document.getElementById("ixRoot");
  if (!root) return;

  var STORE = "indexwatch.ix.v1", PLAN_STORE = "indexwatch.ix.plans.v1", SEASON_STORE = "indexwatch.ix.season.v1";
  var SIM_TICK_MS = 1000, PANEL_MS = 1000, DRAW_MIN_MS = 80, HVW_MS = 15 * 60000, FRESH_MS = 30000, REACT_MIN = 5, MAX_CSV = 4 * 1024 * 1024, UPCOMING = 6;
  var TOGGLES = [["vpRth", "VP RTH", "#38bdf8"], ["vpEth", "VP ETH", "#a78bfa"], ["ib", "IB 1.5x / 2x", "#38bdf8"], ["pdh", "PDH", "#f87171"], ["pdl", "PDL", "#4ade80"], ["pdc", "PDC", "#cbd5e1"],
    ["onh", "ONH", "#c4b5fd"], ["onl", "ONL", "#93c5fd"], ["open", "RTH Open", "#fde047"], ["or", "OR box", "#2dd4bf"], ["div", "CVD divergences", "#f59e0b"]];
  var TABS = [["breadth", "Breadth"], ["ratio", "NQ / ES"], ["levels", "Levels"], ["news", "Headlines"], ["scen", "Scenarios"]];
  var DEFAULT = { contract: "ES", source: "sim", speed: 10, tf: 5, orMin: 15, tab: "breadth", riskOpen: true, unit: "ticks",
    show: { vpRth: true, vpEth: false, ib: true, pdh: true, pdl: true, pdc: true, onh: true, onl: true, open: true, or: false, div: true },
    risk: { stop: 16, slippageTicks: 1, commission: 4.5, account: 50000, dailyLimit: 1100, trailing: 2000, dayPnl: 0, balance: 50000, peak: 50000, riskPct: "" }, weights: {} };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
  function setCls(n, c) { if (n.className !== c) n.className = c; }
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* not persisted */ } }

  function loadSettings() {
    var s = read(STORE, {}), out = JSON.parse(JSON.stringify(DEFAULT));
    if (IX.CONTRACTS[s.contract]) out.contract = s.contract;
    if (s.source === "sim" || s.source === "live") out.source = s.source;
    if ([1, 10, 60].indexOf(s.speed) >= 0) out.speed = s.speed;
    if ([1, 5, 15].indexOf(s.tf) >= 0) out.tf = s.tf;
    if ([5, 15, 30].indexOf(s.orMin) >= 0) out.orMin = s.orMin;
    if (TABS.some(function (t) { return t[0] === s.tab; })) out.tab = s.tab;
    if (typeof s.riskOpen === "boolean") out.riskOpen = s.riskOpen;
    if (s.unit === "points" || s.unit === "ticks") out.unit = s.unit;
    Object.keys(out.show).forEach(function (k) { if (s.show && typeof s.show[k] === "boolean") out.show[k] = s.show[k]; });
    Object.keys(out.risk).forEach(function (k) { if (s.risk && (typeof s.risk[k] === "number" || s.risk[k] === "")) out.risk[k] = s.risk[k]; });
    if (s.weights && typeof s.weights === "object") out.weights = s.weights;
    return out;
  }

  var S = { set: loadSettings(), sim: null, live: null, dirty: true, lastDraw: 0, geo: null, d: null, cache: {}, view: { barW: 9, off: 0, hover: null }, newsFilter: "all", openNews: null, newsSig: "", scenId: null, scenSig: "", season: read(SEASON_STORE, {}), plans: read(PLAN_STORE, {}) };
  IX.app = S;
  function save() { write(STORE, S.set); }
  function spec() { return IX.CONTRACTS[S.set.contract]; }
  function rootKey() { return spec().root; }
  function source() { return S.set.source === "live" ? S.live : S.sim; }
  function nowMs() { return S.set.source === "sim" ? S.sim.now : Date.now(); }
  function visible() { return root.getClientRects().length > 0 && !document.hidden; }

  /* ---------- Derived data, cached until the bars change ---------- */
  function derived(r) {
    var bars = source().bars[r], last = bars[bars.length - 1];
    if (!last) return null;
    var key = S.set.source + ":" + bars.length + ":" + last.t + ":" + last.c + ":" + last.v, hit = S.cache[r];
    if (hit && hit.key === key) return hit;
    var sessions = IX.buildSessions(bars), cur = sessions[sessions.length - 1];
    hit = S.cache[r] = { key: key, bars: bars, sessions: sessions, cur: cur, last: last.c, levels: IX.levels(sessions), ib: IX.initialBalance(cur.rth), agg: {}, vp: null };
    return hit;
  }
  function aggregated(D, tf) { return D.agg[tf] || (D.agg[tf] = IX.aggregate(D.bars, tf)); }
  function profiles(D, r) {
    if (D.vp) return D.vp;
    var bin = IX.ROOTS[r][S.set.source === "sim" ? "simBin" : "liveBin"], rth = D.cur.rth, label = "";
    /* Before today's open, the RTH profile shown is the previous session's. */
    if (!rth.length) for (var i = D.sessions.length - 2; i >= 0; i--) if (D.sessions[i].rth.length) { rth = D.sessions[i].rth; label = "previous session"; break; }
    D.vp = { rth: IX.profile(rth, bin), eth: IX.profile(D.cur.eth, bin), rthLabel: label };
    return D.vp;
  }

  function chartData() {
    var r = rootKey(), D = derived(r);
    if (!D) return { bars: [], show: S.set.show, levels: {}, divs: [], digits: 2 };
    var bars = aggregated(D, S.set.tf), vp = profiles(D, r);
    return { bars: bars, show: S.set.show, levels: D.levels, ib: D.ib, or: IX.openingRange(D.cur.rth, S.set.orMin), vpRth: vp.rth, vpEth: vp.eth, divs: IX.divergences(bars), session: D.cur.key, span: (S.set.tf - 1) * 60000, digits: 2 };
  }

  /* ---------- Source lifecycle ---------- */
  function startSource() {
    S.cache = {}; S.view.off = 0; S.newsSig = ""; S.openNews = null;
    if (S.live) S.live.stop();
    if (S.set.source === "live") { S.live = S.live || new IX.Live(); S.live.start(function () { S.dirty = true; }, visible); }
    else S.sim = S.sim || new IX.Sim({});
    S.dirty = true;
    syncControls(); panels();
  }

  function status() {
    if (S.set.source === "sim") return ["SIM", "sim", "Simulated ES / NQ sessions on a simulated clock"];
    var L = S.live, have = L.bars.ES.length && L.bars.NQ.length;
    if (!have) return L.error ? ["OFFLINE", "off", L.error] : ["CONNECTING", "wait", "Loading SPY and QQQ candles"];
    if (!IX.marketOpen(Date.now())) return ["CME CLOSED", "wait", "Showing the last session. Weekend and break candles are excluded."];
    return Date.now() - L.lastAt < FRESH_MS ? ["LIVE PROXY", "live", "SPY and QQQ perpetuals stand in for ES and NQ"] : ["DELAYED", "wait", L.error || "No update in the last 30 seconds"];
  }

  /* ---------- Controls ---------- */
  function seg(id, items, current, pick) {
    var box = $(id); box.textContent = "";
    items.forEach(function (it) {
      var b = el("button", it[0] === current ? "active" : "", it[1]); b.type = "button";
      b.addEventListener("click", function () { pick(it[0]); });
      box.appendChild(b);
    });
  }
  function syncControls() {
    var s = S.set;
    seg("ixContract", Object.keys(IX.CONTRACTS).map(function (k) { return [k, k]; }), s.contract, function (v) {
      var changed = IX.CONTRACTS[v].root !== rootKey();
      s.contract = v; if (changed) S.view.off = 0;
      save(); S.dirty = true; syncControls(); panels();
    });
    seg("ixSource", [["sim", "Simulator"], ["live", "Live proxy"]], s.source, function (v) { if (v === s.source) return; s.source = v; save(); startSource(); });
    seg("ixSpeed", [[1, "1x"], [10, "10x"], [60, "60x"]], s.speed, function (v) { s.speed = v; save(); syncControls(); });
    seg("ixTf", [[1, "1m"], [5, "5m"], [15, "15m"]], s.tf, function (v) { s.tf = v; S.view.off = 0; save(); S.dirty = true; syncControls(); });
    seg("ixOrMin", [[5, "5m"], [15, "15m"], [30, "30m"]], s.orMin, function (v) { s.orMin = v; s.show.or = true; save(); S.dirty = true; syncControls(); });
    $("ixSpeedWrap").hidden = s.source !== "sim";
    var box = $("ixToggles"); box.textContent = "";
    TOGGLES.forEach(function (t) {
      var b = el("button", "ix-tog" + (s.show[t[0]] ? " on" : ""), t[1]); b.type = "button"; b.style.setProperty("--c", t[2]);
      b.setAttribute("aria-pressed", String(!!s.show[t[0]]));
      b.addEventListener("click", function () { s.show[t[0]] = !s.show[t[0]]; save(); S.dirty = true; syncControls(); });
      box.appendChild(b);
    });
    seg("ixTabs", TABS, s.tab, function (v) { s.tab = v; save(); syncControls(); panels(); });
    TABS.forEach(function (t) { $("ixPane-" + t[0]).hidden = t[0] !== s.tab; });
    root.classList.toggle("risk-collapsed", !s.riskOpen);
    var rt = $("ixRiskToggle"); rt.setAttribute("aria-expanded", String(s.riskOpen)); rt.textContent = s.riskOpen ? "»" : "«  Risk";
  }

  function bindChart() {
    var main = $("ixChart"), cvd = $("ixCvd"), drag = null;
    function indexAt(x) { var q = S.geo; if (!q) return null; var i = q.start + Math.floor((x - q.x0) / q.barW); return i >= q.start && i < q.end ? i : null; }
    [main, cvd].forEach(function (c) {
      c.addEventListener("pointerdown", function (e) { c.setPointerCapture(e.pointerId); drag = { x: e.clientX, off: S.geo ? S.geo.off : 0 }; });
      c.addEventListener("pointermove", function (e) {
        var r = c.getBoundingClientRect(), x = e.clientX - r.left;
        S.view.hover = { index: indexAt(x), y: c === main ? e.clientY - r.top : null };
        if (drag) S.view.off = Math.max(0, Math.round(drag.off + (e.clientX - drag.x) / S.view.barW));
        S.dirty = true;
      });
      function end(e) { drag = null; if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); }
      c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
      c.addEventListener("pointerleave", function () { S.view.hover = null; S.dirty = true; });
      c.addEventListener("dblclick", function () { S.view.off = 0; S.dirty = true; });
      c.addEventListener("wheel", function (e) { e.preventDefault(); S.view.barW = Math.max(3, Math.min(24, S.view.barW * (e.deltaY > 0 ? 0.88 : 1.14))); S.dirty = true; }, { passive: false });
    });
  }

  /* ---------- Release countdown ---------- */
  function releases(now) { return OF.calendar.events(Date.now()).filter(function (e) { return e.impact === "high" && e.ts > now - 5 * 60000; }); }
  function countdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400);
    return (d ? d + "d " : "") + [Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60].map(function (v) { return String(v).padStart(2, "0"); }).join(":");
  }
  function whenEt(ts) { return new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET"; }

  function renderCountdown() {
    var now = Date.now(), list = releases(now), next = list[0], banner = $("ixCal");
    if (!next) { setText($("ixCalName"), "No further high-impact releases are loaded"); setText($("ixCalWhen"), ""); setText($("ixCalCd"), ""); $("ixHvw").hidden = true; setText($("ixCalNext"), ""); return; }
    var ms = next.ts - now, hot = ms <= HVW_MS;
    setText($("ixCalName"), next.name + (next.approx ? " (date approximate)" : ""));
    setText($("ixCalWhen"), whenEt(next.ts));
    setText($("ixCalCd"), ms > 0 ? countdown(ms) : "RELEASED");
    $("ixHvw").hidden = !hot; banner.classList.toggle("hot", hot);
    setText($("ixCalNext"), list.slice(1, 3).map(function (e) { return e.name + " · " + whenEt(e.ts); }).join("    |    "));
  }

  /* ---------- Performance and seasonality ---------- */
  function pctCell(td, v, why) {
    setText(td, v == null ? "n/a" : IX.arrow(v) + " " + (v > 0 ? "+" : "") + v.toFixed(2) + "%");
    setCls(td, "num " + (v == null ? "na" : v > 0.1 ? "up" : v < -0.1 ? "dn" : ""));
    td.title = v == null ? why : "";
  }
  function renderPerf() {
    var body = $("ixPerf");
    if (!body.children.length) ["ES", "NQ"].forEach(function () { var tr = el("tr"); for (var i = 0; i < 6; i++) tr.appendChild(el(i ? "td" : "th")); body.appendChild(tr); });
    ["ES", "NQ"].forEach(function (r, i) {
      var D = derived(r), cells = body.children[i].children;
      setText(cells[0], S.set.source === "live" ? r + " · " + IX.ROOTS[r].proxy : r);
      body.children[i].classList.toggle("active", r === rootKey());
      if (!D) { for (var k = 1; k < 6; k++) { setText(cells[k], "waiting"); setCls(cells[k], "num na"); } return; }
      var p = IX.performance(source().daily[r] || [], D.last, D.levels.pdc, nowMs()), why = "Price history does not reach back far enough";
      setText(cells[1], D.last.toFixed(2)); setCls(cells[1], "num");
      pctCell(cells[2], p.day, why); pctCell(cells[3], p.month, why); pctCell(cells[4], p.quarter, why); pctCell(cells[5], p.year, why);
    });
    setText($("ixPerfNote"), S.set.source === "live" ? "Day is against the prior RTH close. SPY and QQQ perpetuals listed in 2026, so Year is unavailable." : "Simulated history.");
  }

  function renderSeason() {
    var r = rootKey(), data = S.season[r], box = $("ixSeason"), sig = r + ":" + (data ? data.from + "-" + data.to : "none") + ":" + new Date().getMonth();
    if (box.getAttribute("data-sig") === sig) return;
    box.setAttribute("data-sig", sig); box.textContent = "";
    setText($("ixSeasonTitle"), "Monthly seasonality · " + r);
    $("ixSeasonClear").hidden = !data;
    var max = data ? Math.max.apply(null, data.months.map(function (m) { return Math.abs(m.avg || 0); })) || 1 : 1;
    "JFMAMJJASOND".split("").forEach(function (letter, i) {
      var m = data && data.months[i], cell = el("div", "ix-month" + (i === new Date().getMonth() ? " now" : "") + (m && m.avg != null ? (m.avg >= 0 ? " up" : " dn") : " empty"));
      var track = el("div", "ix-mtrack"), bar = el("i");
      if (m && m.avg != null) { bar.style.height = Math.max(6, Math.abs(m.avg) / max * 48) + "%"; cell.title = letter + ": average " + m.avg.toFixed(2) + "%, positive " + Math.round(m.winPct) + "% of " + m.n + " years"; }
      track.appendChild(bar); cell.appendChild(track); cell.appendChild(el("b", "", letter)); cell.appendChild(el("span", "num", m && m.avg != null ? (m.avg > 0 ? "+" : "") + m.avg.toFixed(1) : ""));
      box.appendChild(cell);
    });
    setText($("ixSeasonNote"), data ? "Average monthly return (%), " + data.from + " to " + data.to + ", from " + data.name + ". Past tendencies, not a forecast." : "No history loaded. Load a CSV with Date and Close columns (10 or more years of " + (r === "ES" ? "S&P 500" : "Nasdaq-100") + " daily or monthly data) to build real tendencies.");
  }
  function bindSeason() {
    var input = $("ixSeasonFile");
    $("ixSeasonLoad").addEventListener("click", function () { input.click(); });
    $("ixSeasonClear").addEventListener("click", function () { delete S.season[rootKey()]; write(SEASON_STORE, S.season); renderSeason(); });
    input.addEventListener("change", function () {
      var f = input.files[0], r = rootKey();
      input.value = "";
      if (!f) return;
      if (f.size > MAX_CSV) { setText($("ixSeasonNote"), "That file is larger than 4 MB."); return; }
      f.text().then(function (text) {
        var res = IX.seasonality(IX.parseCsv(text));
        if (!res) { setText($("ixSeasonNote"), "Could not use that file: it needs Date (YYYY-MM-DD) and Close columns covering at least two years."); return; }
        res.name = f.name.slice(0, 60); S.season[r] = res; write(SEASON_STORE, S.season); $("ixSeason").setAttribute("data-sig", ""); renderSeason();
      });
    });
  }

  /* ---------- Breadth ---------- */
  function weight(sym, idx) { var o = S.set.weights[sym], base = IX.MEGACAPS.filter(function (c) { return c.s === sym; })[0][idx]; return o && typeof o[idx] === "number" ? o[idx] : base; }
  function signed(v, d) { return (v > 0 ? "+" : "") + v.toFixed(d == null ? 2 : d); }
  function tone(v) { return v > 0 ? "up" : v < 0 ? "dn" : ""; }

  function buildBreadth() {
    var body = $("ixBreadthRows"); body.textContent = "";
    IX.MEGACAPS.forEach(function (c) {
      var tr = el("tr"); tr.setAttribute("data-s", c.s);
      tr.appendChild(el("th", "", c.s)); tr.appendChild(el("td", "num"));
      ["es", "nq"].forEach(function (idx) {
        var td = el("td", "num"), inp = document.createElement("input");
        inp.type = "number"; inp.step = "0.1"; inp.min = "0"; inp.max = "25"; inp.value = weight(c.s, idx); inp.setAttribute("aria-label", c.s + " weight in " + idx.toUpperCase());
        inp.addEventListener("change", function () {
          var v = Number(inp.value);
          if (inp.value === "" || !(v >= 0 && v <= 25)) { inp.value = weight(c.s, idx); return; }
          (S.set.weights[c.s] = S.set.weights[c.s] || {})[idx] = v; save(); renderBreadth();
        });
        td.appendChild(inp); tr.appendChild(td);
      });
      tr.appendChild(el("td", "num")); tr.appendChild(el("td", "num"));
      body.appendChild(tr);
    });
  }
  function renderBreadth() {
    var caps = source().megaCaps(), sum = { es: 0, nq: 0 }, have = 0;
    caps.forEach(function (c) {
      var tr = $("ixBreadthRows").querySelector('[data-s="' + c.s + '"]'), cells = tr.children;
      setText(cells[1], c.pct == null ? "waiting" : signed(c.pct) + "%"); setCls(cells[1], "num " + tone(c.pct));
      ["es", "nq"].forEach(function (idx, k) {
        var contrib = c.pct == null ? null : c.pct * weight(c.s, idx) / 100, cell = cells[4 + k];
        if (contrib != null) { sum[idx] += contrib; if (!k) have++; }
        setText(cell, contrib == null ? "" : signed(contrib, 3) + "%"); setCls(cell, "num " + tone(contrib));
      });
    });
    ["es", "nq"].forEach(function (idx) {
      var D = derived(idx.toUpperCase()), node = $("ixImpact-" + idx), pts = D ? sum[idx] / 100 * D.last : null;
      setText(node, have ? signed(sum[idx]) + "%" + (pts == null ? "" : "  ≈ " + signed(pts) + " pts") : "waiting"); setCls(node, "num " + (have ? tone(sum[idx]) : ""));
    });
  }

  /* ---------- Ratio and levels ---------- */
  function renderRatio() {
    var es = derived("ES"), nq = derived("NQ");
    if (!es || !nq) { setText($("ixRatioVal"), "waiting"); return; }
    var series = IX.ratio(aggregated({ bars: es.cur.bars, agg: {} }, 5), aggregated({ bars: nq.cur.bars, agg: {} }, 5)), last = series[series.length - 1];
    if (!last) return;
    var chg = (last.v / series[0].v - 1) * 100, spread = last.nqPct - last.esPct;
    setText($("ixRatioVal"), last.v.toFixed(4));
    setText($("ixRatioChg"), signed(chg) + "% this session"); setCls($("ixRatioChg"), "num " + tone(chg));
    setText($("ixRatioLead"), Math.abs(spread) < 0.05 ? "NQ and ES are moving together." : (spread > 0 ? "NQ is leading ES by " : "NQ is lagging ES by ") + Math.abs(spread).toFixed(2) + " percentage points.");
    IX.drawLines($("ixRatioChart"), [{ label: "NQ/ES", color: "#38bdf8", points: series.map(function (p) { return { x: p.t, v: p.v }; }) }], { digits: 4 });
    IX.drawLines($("ixRelChart"), [{ label: "NQ %", color: "#a78bfa", points: series.map(function (p) { return { x: p.t, v: p.nqPct }; }) }, { label: "ES %", color: "#fde047", points: series.map(function (p) { return { x: p.t, v: p.esPct }; }) }], { zero: true, suffix: "%" });
  }

  function row(cells, cls) { var tr = el("tr", cls || ""); cells.forEach(function (c, i) { var td = el(i ? "td" : "th", i ? "num" : ""); if (typeof c === "object" && c) { td.textContent = c.t; td.className += " " + c.c; } else td.textContent = c; tr.appendChild(td); }); return tr; }
  function renderLevels() {
    var D = derived(rootKey());
    if (!D) return;
    var tbl = $("ixLevelRows"), vp = profiles(D, rootKey()), L = D.levels; tbl.textContent = "";
    var list = [["PDH", L.pdh], ["PDL", L.pdl], ["PDC", L.pdc], ["ONH", L.onh], ["ONL", L.onl], ["RTH Open", L.open]];
    if (vp.rth) list.push(["RTH VAH" + (vp.rthLabel ? " (prior)" : ""), vp.rth.vah], ["RTH POC", vp.rth.poc], ["RTH VAL", vp.rth.val]);
    if (vp.eth) list.push(["ETH VAH", vp.eth.vah], ["ETH POC", vp.eth.poc], ["ETH VAL", vp.eth.val]);
    if (D.ib) list.push(["IB 2.0x up", D.ib.up20], ["IB 1.5x up", D.ib.up15], ["IBH", D.ib.h], ["IBL", D.ib.l], ["IB 1.5x down", D.ib.dn15], ["IB 2.0x down", D.ib.dn20]);
    list.filter(function (x) { return x[1] != null; }).sort(function (a, b) { return b[1] - a[1]; }).forEach(function (x) {
      var dist = x[1] - D.last;
      tbl.appendChild(row([x[0], x[1].toFixed(2), { t: signed(dist), c: tone(dist) }]));
    });
    setText($("ixIbNote"), D.ib ? "Initial Balance " + D.ib.range.toFixed(2) + " pts, " + (D.ib.complete ? "complete" : "still forming") + ". 1.5x and 2.0x are measured from the IB range." : "The Initial Balance starts at 9:30 ET.");
    var m = $("ixOrRows"); m.textContent = "";
    [5, 15, 30].forEach(function (min) {
      var o = IX.openingRange(D.cur.rth, min), st = IX.rangeStatus(o, D.last);
      m.appendChild(row([min + " min", o ? o.h.toFixed(2) : "", o ? o.l.toFixed(2) : "", o ? o.range.toFixed(2) : "", { t: st.toUpperCase(), c: st === "above" ? "up" : st === "below" ? "dn" : "na" }], min === S.set.orMin ? "active" : ""));
    });
  }

  /* ---------- Headlines with price reaction ---------- */
  function reactions(h) { return ["ES", "NQ"].map(function (r) { return { root: r, x: IX.reaction(source().bars[r], h.ts, REACT_MIN) }; }); }
  function renderNews() {
    var list = source().headlines.filter(function (h) { return S.newsFilter === "all" || IX.headlineTags(h.title).indexOf(S.newsFilter) >= 0; }).slice(0, 14);
    var es = derived("ES"), sig = S.set.source + S.newsFilter + S.openNews + list.map(function (h) { return h.ts; }).join(",") + ":" + (es ? Math.floor(es.bars[es.bars.length - 1].t / 60000) : 0);
    if (sig === S.newsSig) return;
    S.newsSig = sig;
    var box = $("ixNews"); box.textContent = "";
    if (!list.length) box.appendChild(el("p", "ix-empty", S.set.source === "live" && S.live.newsError ? "Headlines are unreachable right now. Retrying." : "No ES or NQ headlines yet."));
    list.forEach(function (h) {
      var id = String(h.ts) + h.title.slice(0, 20), open = S.openNews === id, item = el("div", "ix-news" + (open ? " open" : "")), head = el("button", "ix-news-btn");
      head.type = "button"; head.setAttribute("aria-expanded", String(open));
      var meta = el("span", "ix-news-meta");
      meta.appendChild(el("span", "num", new Date(h.ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET"));
      IX.headlineTags(h.title).forEach(function (t) { meta.appendChild(el("span", "ix-tag", t)); });
      if (h.sample) meta.appendChild(el("span", "ix-tag warn", "SIM SAMPLE"));
      head.appendChild(meta); head.appendChild(el("span", "ix-news-title", h.title));
      var badges = el("span", "ix-badges"), rx = reactions(h);
      rx.forEach(function (q) {
        var label = q.root + (S.set.source === "live" ? " (" + IX.ROOTS[q.root].proxy + ")" : "");
        var b = el("span", "ix-react " + (q.x ? tone(q.x.pts) : "na"), q.x ? label + " " + signed(q.x.pts) + " pts" + (q.x.final ? "" : " …") : label + " no data");
        if (q.x) b.title = signed(q.x.pct) + "% in the " + REACT_MIN + " minutes after the headline" + (q.x.final ? "" : " (window still open)");
        badges.appendChild(b);
      });
      head.appendChild(badges);
      head.addEventListener("click", function () { S.openNews = open ? null : id; S.newsSig = ""; renderNews(); });
      item.appendChild(head);
      if (open) {
        var cv = el("canvas", "ix-spark"); cv.setAttribute("aria-label", "Price move from 10 minutes before to 30 minutes after the headline");
        item.appendChild(cv);
        item.appendChild(el("p", "ix-note", "Percent move from the pre-headline price, 10 minutes before to 30 after. The dashed line marks the headline. Timing alone does not show the headline caused the move."));
        if (h.link) { var a = el("a", "ix-link", "Open the story ↗"); a.href = h.link; a.target = "_blank"; a.rel = "noopener noreferrer"; item.appendChild(a); }
      }
      box.appendChild(item);
      if (open) IX.drawLines(item.querySelector("canvas"), rx.filter(function (q) { return q.x; }).map(function (q) { return { label: q.root, color: q.root === "ES" ? "#fde047" : "#a78bfa", points: q.x.series.map(function (p) { return { x: p.m, v: (p.v / q.x.base - 1) * 100 }; }) }; }), { zero: true, markerX: 0, suffix: "%" });
    });
  }

  /* ---------- Scenario desk ---------- */
  function renderScenarios() {
    var list = releases(Date.now()).slice(0, UPCOMING), sel = $("ixScenSel");
    if (!list.length) { setText($("ixScenWhen"), "No upcoming releases are loaded."); $("ixScenRows").textContent = ""; return; }
    if (!list.some(function (e) { return e.id === S.scenId; })) S.scenId = list[0].id;
    var sig = list.map(function (e) { return e.id; }).join() + ":" + S.scenId;
    if (sig === S.scenSig) return;
    S.scenSig = sig; sel.textContent = "";
    list.forEach(function (e) { var o = el("option", "", e.name + " · " + whenEt(e.ts)); o.value = e.id; sel.appendChild(o); });
    sel.value = S.scenId;
    var ev = list.filter(function (e) { return e.id === S.scenId; })[0];
    setText($("ixScenWhen"), whenEt(ev.ts) + (ev.approx ? " (date approximate, verify with the official calendar)" : ""));
    var box = $("ixScenRows"); box.textContent = "";
    IX.scenarios(ev.name).forEach(function (sc, i) {
      var card = el("div", "ix-scen " + ["hi", "mid", "lo"][i]), key = ev.id + ":" + i;
      card.appendChild(el("h4", "", sc.outcome));
      [["ES", sc.es], ["NQ", sc.nq]].forEach(function (p) { var line = el("p"); line.appendChild(el("b", "", p[0])); line.appendChild(document.createTextNode(" " + p[1])); card.appendChild(line); });
      var label = el("label", "", "My plan"), ta = document.createElement("textarea");
      ta.rows = 2; ta.maxLength = 600; ta.value = S.plans[key] || ""; ta.placeholder = "Levels, trigger, size, invalidation";
      ta.addEventListener("input", function () { if (ta.value) S.plans[key] = ta.value; else delete S.plans[key]; write(PLAN_STORE, S.plans); });
      label.appendChild(ta); card.appendChild(label); box.appendChild(card);
    });
  }

  /* ---------- Risk panel ---------- */
  function money(v) { return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function riskInput(contract) {
    var r = S.set.risk;
    return Object.assign({}, r, { contract: contract, stopTicks: r.stop === "" ? "" : S.set.unit === "points" ? r.stop / IX.TICK : r.stop });
  }
  function renderRisk() {
    var c = spec(), res = IX.risk(riskInput(S.set.contract));
    setText($("ixSpec"), S.set.contract + " · $" + c.pointValue + " per point · " + money(c.tickValue) + " per tick · tick 0.25");
    var grid = $("ixRiskOut"), big = $("ixMax"), warn = $("ixRiskWarn");
    grid.textContent = "";
    if (!res.valid) { setText(big, "0"); setText($("ixMaxSub"), ""); warn.hidden = false; setText(warn, res.reason); $("ixAll").textContent = ""; return; }
    setText(big, String(res.maxContracts)); setCls(big, "ix-max num " + (res.maxContracts ? "up" : "dn"));
    setText($("ixMaxSub"), res.maxContracts ? "max " + S.set.contract + " · worst case " + money(res.lossAtMax) : "No size fits inside your limits");
    [["Stop distance", res.stopPoints.toFixed(2) + " pts"], ["Risk per contract", money(res.perContract)], ["Daily room left", money(res.remainingDaily)], ["Trailing room left", money(res.remainingTrailing)], ["Trailing floor", money(res.floor)], ["Binding limit", res.limiter]].forEach(function (p) {
      var line = el("div", "ix-kv"); line.appendChild(el("span", "", p[0])); line.appendChild(el("b", "num", p[1])); grid.appendChild(line);
    });
    warn.hidden = !(res.breached || !res.maxContracts);
    setText(warn, res.breached ? "A limit is already reached. Do not trade." : "One contract with this stop would reach the " + res.limiter + ". Use a tighter stop or a micro contract.");
    var all = $("ixAll"); all.textContent = "";
    Object.keys(IX.CONTRACTS).forEach(function (k) { var x = IX.risk(riskInput(k)), chip = el("div", "ix-chip" + (k === S.set.contract ? " on" : "")); chip.appendChild(el("span", "", k)); chip.appendChild(el("b", "num", x.valid ? String(x.maxContracts) : "0")); all.appendChild(chip); });
  }
  function bindRisk() {
    document.querySelectorAll("[data-risk]").forEach(function (inp) {
      var k = inp.getAttribute("data-risk");
      inp.value = S.set.risk[k];
      /* A blank field stays blank so it is reported as missing and never read as zero. */
      inp.addEventListener("input", function () { var v = inp.value.trim(); S.set.risk[k] = v === "" || !isFinite(Number(v)) ? "" : Number(v); save(); renderRisk(); });
    });
    var unit = $("ixStopUnit");
    unit.value = S.set.unit;
    unit.addEventListener("change", function () {
      var r = S.set.risk;
      if (r.stop !== "") r.stop = unit.value === "points" ? r.stop * IX.TICK : r.stop / IX.TICK;
      S.set.unit = unit.value; $("ixStop").value = r.stop; save(); renderRisk();
    });
    $("ixRiskToggle").addEventListener("click", function () { S.set.riskOpen = !S.set.riskOpen; save(); syncControls(); S.dirty = true; });
  }

  /* ---------- Loops ---------- */
  function panels() {
    if (!visible()) return;
    var st = status(), badge = $("ixBadge");
    setText(badge, st[0]); setCls(badge, "ix-badge " + st[1]); badge.title = st[2];
    setText($("ixStatusText"), st[2]);
    setText($("ixClock"), "ET " + IX.etTime(nowMs()) + (S.set.source === "sim" ? " (sim)" : ""));
    var D = derived(rootKey());
    setText($("ixTitle"), S.set.contract + " · " + spec().name + (S.set.source === "live" ? " · priced through " + IX.ROOTS[rootKey()].proxy : ""));
    setText($("ixQuote"), D ? D.last.toFixed(2) : "");
    var chg = D && D.levels.pdc ? D.last - D.levels.pdc : null;
    setText($("ixChange"), chg == null ? "" : signed(chg) + " (" + signed(chg / D.levels.pdc * 100) + "%)"); setCls($("ixChange"), "num " + tone(chg));
    renderCountdown(); renderPerf(); renderSeason(); renderRisk();
    if (S.set.tab === "breadth") renderBreadth(); else if (S.set.tab === "ratio") renderRatio(); else if (S.set.tab === "levels") renderLevels(); else if (S.set.tab === "news") renderNews(); else renderScenarios();
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!S.dirty || !visible() || ts - S.lastDraw < DRAW_MIN_MS) return;
    S.lastDraw = ts; S.dirty = false;
    S.d = chartData();
    S.geo = IX.drawChart($("ixChart"), S.d, S.view);
    IX.drawCvd($("ixCvd"), S.geo, S.d, S.view);
  }

  function init() {
    buildBreadth(); bindChart(); bindRisk(); bindSeason();
    $("ixScenSel").addEventListener("change", function (e) { S.scenId = e.target.value; S.scenSig = ""; renderScenarios(); });
    seg("ixNewsFilter", [["all", "All"], ["ES", "ES"], ["NQ", "NQ"]], S.newsFilter, function pick(v) { S.newsFilter = v; S.newsSig = ""; seg("ixNewsFilter", [["all", "All"], ["ES", "ES"], ["NQ", "NQ"]], v, pick); renderNews(); });
    if (S.set.source === "live") S.sim = new IX.Sim({});
    startSource();
    setInterval(function () { if (S.set.source === "sim" && visible()) { S.sim.advance(SIM_TICK_MS * S.set.speed); S.dirty = true; } }, SIM_TICK_MS);
    setInterval(panels, PANEL_MS);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(function () { S.dirty = true; }).observe(root);
    document.querySelectorAll('.nav-item[data-view="ix"]').forEach(function (n) { n.addEventListener("click", function () { setTimeout(function () { S.dirty = true; panels(); }, 30); }); });
    requestAnimationFrame(frame);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
