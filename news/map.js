/* Story map: draws the live news pins, their popups and the list under the map, and shows when it last updated.
 * Feed text is always written with textContent. */
(function (g) {
  "use strict";
  var NEWS = g.NEWS, GB = g.GB;
  if (!NEWS || typeof document === "undefined") return;

  var SVG = "http://www.w3.org/2000/svg", LIST_MAX = 24, TICK_MS = 1000, POPUP_ITEMS = 3;
  var COLORS = { critical: "#ff3b30", high: "#ff7a00", elevated: "#ffd000", info: "#e6e6e6" };
  var activeId = null, filter = "all", sig = "";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function link(item, cls, text) {
    var a = el(item.link ? "a" : "span", cls, text);
    if (item.link) { a.href = item.link; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }
  function meta(item) { return item.source + " · " + GB.timeAgo(item.ts, Date.now()); }
  function pins() { return NEWS.state.pins.filter(function (p) { return filter === "all" || p.kind === filter; }); }

  function hidePopup() {
    activeId = null;
    $("mapTooltip").classList.remove("show");
    document.querySelectorAll(".map-pin.active").forEach(function (n) { n.classList.remove("active"); });
  }

  function showPopup(pin, node) {
    var tip = $("mapTooltip"), wrap = $("mapWrap").getBoundingClientRect(), at = node.getBoundingClientRect();
    tip.textContent = "";
    tip.appendChild(el("span", "mt-loc", pin.loc + (pin.count > 1 ? " · " + pin.count + " stories" : "")));
    pin.items.slice(0, POPUP_ITEMS).forEach(function (it) {
      var row = el("div", "mt-item");
      row.appendChild(link(it, "mt-link", it.title));
      row.appendChild(el("span", "mt-meta", meta(it)));
      tip.appendChild(row);
    });
    tip.classList.add("show");
    var left = at.left - wrap.left + 16, top = at.top - wrap.top - 10, w = tip.offsetWidth || 300, h = tip.offsetHeight || 140;
    if (left + w > wrap.width - 4) left = Math.max(4, at.left - wrap.left - w - 10);
    if (top + h > wrap.height - 4) top = Math.max(4, wrap.height - h - 4);
    tip.style.left = left + "px"; tip.style.top = Math.max(4, top) + "px";
  }

  function activate(id, node) {
    if (activeId === id) { hidePopup(); return; }
    hidePopup();
    var pin = pins().filter(function (p) { return p.id === id; })[0];
    if (!pin) return;
    activeId = id; node.classList.add("active"); showPopup(pin, node);
  }

  function drawPins() {
    var layer = $("mapPins"), project = g.IW_PROJECT;
    layer.textContent = "";
    /* Older pins are drawn first so the newest sit on top. */
    pins().slice().sort(function (a, b) { return a.latest - b.latest; }).forEach(function (p) {
      var pt = project(p.lon, p.lat), group = document.createElementNS(SVG, "g"), halo = document.createElementNS(SVG, "circle"), dot = document.createElementNS(SVG, "circle"), title = document.createElementNS(SVG, "title");
      if (pt[1] < 4 || pt[1] > 456) pt[1] = Math.max(4, Math.min(456, pt[1]));
      group.setAttribute("class", "map-pin"); group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("data-pin", p.id);
      group.setAttribute("aria-label", p.loc + ": " + p.items[0].title);
      group.setAttribute("transform", "translate(" + pt[0].toFixed(1) + "," + pt[1].toFixed(1) + ")");
      title.textContent = p.loc + ": " + p.items[0].title;
      var r = Math.min(8, 3.5 + Math.sqrt(p.count));
      halo.setAttribute("class", "map-pin-halo"); halo.setAttribute("r", r); dot.setAttribute("class", "map-pin-dot"); dot.setAttribute("r", r);
      halo.style.fill = dot.style.fill = COLORS[p.sev];
      /* Only fresh stories pulse. */
      if (Date.now() - p.latest > 3 * 3600000) halo.style.display = "none";
      if (p.kind === "disaster") { dot.style.stroke = "#fff"; dot.style.strokeWidth = "1.6"; }
      group.appendChild(title); group.appendChild(halo); group.appendChild(dot);
      group.addEventListener("click", function (e) { e.stopPropagation(); activate(p.id, group); });
      group.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(p.id, group); } });
      layer.appendChild(group);
    });
  }

  function drawList() {
    var box = $("mapList"), list = pins().slice().sort(function (a, b) { return b.latest - a.latest; }).slice(0, LIST_MAX);
    box.textContent = "";
    if (!list.length) box.appendChild(el("p", "map-empty", NEWS.state.loading ? "Fetching the latest headlines…" : "No located stories right now. The next refresh will try again."));
    list.forEach(function (p) {
      var card = el("div", "card map-list-item"), dot = el("span", "map-list-pin"), body = el("div");
      dot.style.background = COLORS[p.sev];
      body.appendChild(el("span", "map-list-loc", p.loc + (p.count > 1 ? " · " + p.count : "")));
      body.appendChild(link(p.items[0], "map-list-title", p.items[0].title));
      body.appendChild(el("span", "map-list-meta", meta(p.items[0])));
      card.appendChild(dot); card.appendChild(body); box.appendChild(card);
    });
  }

  function render() {
    var s = NEWS.state, next = filter + ":" + s.updatedAt + ":" + s.pins.length + ":" + s.loading + ":" + Math.floor(Date.now() / 60000);
    if (next === sig) return;
    sig = next;
    var open = activeId;
    hidePopup(); drawPins(); drawList();
    if (open) { var node = document.querySelector('.map-pin[data-pin="' + open + '"]'); if (node) activate(open, node); }
    var all = NEWS.state.pins, news = all.filter(function (p) { return p.kind === "news"; }).length;
    $("mapPinCount").textContent = news + " news locations · " + (all.length - news) + " disaster alerts";
  }

  function clock(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

  function renderStatus() {
    var s = NEWS.state, left = Math.max(0, Math.round((s.nextAt - Date.now()) / 1000));
    $("newsUpdated").textContent = s.loading ? "Updating now…" : s.updatedAt ? "Updated " + clock(s.updatedAt) + " · next update in " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") : "Not updated yet";
    var box = $("newsSources"), names = NEWS.SOURCES.concat([{ id: "gdacs", name: "GDACS" }]);
    names.forEach(function (src, i) {
      var chip = box.children[i] || box.appendChild(el("span", "news-src"));
      var ok = s.status[src.id], cls = "news-src " + (ok === true ? "ok" : ok === false ? "bad" : "");
      if (chip.className !== cls) chip.className = cls;
      if (chip.textContent !== src.name) chip.textContent = src.name;
      chip.title = ok === false ? "Failed on the last refresh. Showing its earlier items if any." : ok ? "Loaded on the last refresh" : "From the saved copy until the next refresh";
    });
  }

  function init() {
    if (!$("mapPins") || !g.IW_PROJECT) return;
    document.addEventListener("click", function (e) { if (!e.target.closest(".map-tooltip")) hidePopup(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hidePopup(); });
    $("newsRefresh").addEventListener("click", function () { if (!NEWS.refreshNow()) $("newsUpdated").textContent = "Just refreshed. Try again in a minute."; });
    document.querySelectorAll("[data-news-filter]").forEach(function (b) {
      b.addEventListener("click", function () {
        filter = b.getAttribute("data-news-filter");
        document.querySelectorAll("[data-news-filter]").forEach(function (x) { x.classList.toggle("active", x === b); });
        render();
      });
    });
    NEWS.subscribe(function () { sig = ""; render(); renderStatus(); });
    NEWS.start();
    render(); renderStatus();
    setInterval(function () { renderStatus(); render(); }, TICK_MS);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(globalThis);
