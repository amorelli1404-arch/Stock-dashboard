/* Order-flow toolkit: configuration and formatting helpers.
 * Every tunable lives here so connecting a real feed needs only config changes. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  OF.config = {
    barMs: 60000,
    maxBars: 240,
    visibleBars: 9,
    minVisibleBars: 5,
    maxVisibleBars: 40,
    ladderRowHeight: 18,
    rowMinPx: 13,
    maxFps: 40,
    uiRefreshMs: 120,

    imbalanceRatio: 3,
    wallMultiple: 4,
    icebergMultiple: 3,
    valueAreaPct: 0.7,
    maxAnchors: 4,
    maxAlerts: 40,

    defaultMode: "replay",
    defaultSymbol: "ES",

    replay: { speed: 20, speeds: [1, 5, 20, 60], seed: 42, warmupBars: 18, tpoPeriodBars: 3 },

    /* Live feed. provider is a key of OF.feeds.providers.
     * "binance"  public Binance USDT-M futures streams (no key needed).
     * "relay"    your own wss:// endpoint that emits normalized messages (see README).
     * Databento / Rithmic / Polygon need an API key: run a small server-side relay
     * that holds the key and re-publishes normalized messages; never put keys in this page. */
    live: {
      provider: "binance",
      url: "",
      subscribe: [],
      reconnectMinMs: 1000,
      reconnectMaxMs: 30000,
      staleAfterMs: 15000,
      tpoPeriodBars: 30
    },

    /* tick: minimum price increment. dayRangeTicks drives the simulated HTF levels.
     * wallMin / iceMin / imbMin are absolute size floors so tiny books don't raise alerts. */
    symbols: {
      ES: { name: "E-mini S&P 500", tick: 0.25, tickValue: 12.5, base: 6481.25, avgTrade: 3, depth: 45, sizeStep: 1, sizeDec: 0, dayRangeTicks: 220, wallMin: 120, iceMin: 40, imbMin: 5 },
      NQ: { name: "E-mini Nasdaq-100", tick: 0.25, tickValue: 5, base: 23118.75, avgTrade: 2, depth: 30, sizeStep: 1, sizeDec: 0, dayRangeTicks: 600, wallMin: 80, iceMin: 25, imbMin: 3 },
      CL: { name: "WTI Crude Oil", tick: 0.01, tickValue: 10, base: 61.52, avgTrade: 4, depth: 60, sizeStep: 1, sizeDec: 0, dayRangeTicks: 120, wallMin: 200, iceMin: 80, imbMin: 8 },
      GC: { name: "Gold", tick: 0.1, tickValue: 10, base: 4052.3, avgTrade: 2, depth: 30, sizeStep: 1, sizeDec: 0, dayRangeTicks: 200, wallMin: 100, iceMin: 30, imbMin: 4 },
      BTCUSDT: { name: "Bitcoin perp (Binance)", tick: 0.1, tickValue: 0.1, base: 98000, avgTrade: 0.02, depth: 4, sizeStep: 0.001, sizeDec: 3, dayRangeTicks: 8000, wallMin: 12, iceMin: 6, imbMin: 1.5 },
      ETHUSDT: { name: "Ether perp (Binance)", tick: 0.01, tickValue: 0.01, base: 3400, avgTrade: 0.3, depth: 60, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 6000, wallMin: 150, iceMin: 80, imbMin: 10 }
    }
  };

  function decimalsOf(step) {
    var s = String(step), i = s.indexOf(".");
    return i < 0 ? 0 : s.length - i - 1;
  }

  OF.fmt = {
    decimalsOf: decimalsOf,
    price: function (p, tickSize) {
      return p == null || !isFinite(p) ? "—" : p.toFixed(decimalsOf(tickSize));
    },
    size: function (v, dec) {
      if (v == null || !isFinite(v)) return "—";
      if (dec === 0 && v >= 10000) return (v / 1000).toFixed(1) + "k";
      return v.toFixed(dec || 0);
    },
    signed: function (v, dec) {
      if (v == null || !isFinite(v)) return "—";
      return (v > 0 ? "+" : "") + v.toFixed(dec || 0);
    },
    time: function (ms) {
      var d = new Date(ms);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
  };
})(globalThis);
