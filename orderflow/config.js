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

    timeframes: [
      { label: "1m", ms: 60000 }, { label: "5m", ms: 300000 }, { label: "15m", ms: 900000 },
      { label: "1h", ms: 3600000 }, { label: "4h", ms: 14400000 }
    ],
    tpoPeriodMs: 1800000,

    /* Sessions in New York minutes-of-day; from > to wraps midnight. */
    sessions: [
      { id: "asia", label: "Asia", from: 1080, to: 180, color: "#8b949e" },
      { id: "london", label: "London", from: 180, to: 570, color: "#d29922" },
      { id: "ny", label: "NY RTH", from: 570, to: 960, color: "#58a6ff" },
      { id: "post", label: "Post", from: 960, to: 1080, color: "#6e7681" }
    ],
    rthOpenMin: 570, ibMinutes: 60, orbMinutes: 15,

    /* Liquidity heatmap: columns per bar keeps the history span proportional to the timeframe. */
    heat: { colsPerBar: 24, minIntervalMs: 500, maxCols: 1000, maxLevels: 80, pullFrac: 0.2, pullTradedFrac: 0.3, pullAlertMs: 5000 },
    tape: { max: 400, rows: 70, sweepGapMs: 60, sweepLevels: 3 },
    trade: { stopDivisor: 25, targetMultiple: 2, maxLossUsd: 500 },

    replay: { speed: 20, speeds: [1, 5, 20, 60], seed: 42, warmupBars: 18, maxWarmupMs: 7200000, tpoPeriodBars: 3 },

    /* Live feed. provider is a key of OF.feeds.providers.
     * "binance"  public Binance USDT-M futures streams (no key needed).
     * "relay"    your own wss:// endpoint that emits normalized messages (see README).
     * Databento / Rithmic / Polygon need an API key: run a small server-side relay
     * that holds the key and re-publishes normalized messages; never put keys in this page. */
    live: {
      provider: "binance",
      url: "",
      databentoUrl: "ws://127.0.0.1:8765/stream?symbol={symbol}",
      subscribe: [],
      reconnectMinMs: 1000,
      reconnectMaxMs: 30000,
      staleAfterMs: 15000,
      backfillPages: 25,
      backfillBars: 12
    },

    /* tick: minimum price increment. dayRangeTicks drives the simulated HTF levels.
     * wallMin / iceMin / imbMin are absolute size floors so tiny books don't raise alerts. */
    symbols: {
      ES: { name: "E-mini S&P 500", tick: 0.25, tickValue: 12.5, base: 6481.25, avgTrade: 3, depth: 45, sizeStep: 1, sizeDec: 0, dayRangeTicks: 220, wallMin: 120, iceMin: 40, imbMin: 5 },
      NQ: { name: "E-mini Nasdaq-100", tick: 0.25, tickValue: 5, base: 23118.75, avgTrade: 2, depth: 30, sizeStep: 1, sizeDec: 0, dayRangeTicks: 600, wallMin: 80, iceMin: 25, imbMin: 3 },
      CL: { name: "WTI Crude Oil", tick: 0.01, tickValue: 10, base: 61.52, avgTrade: 4, depth: 60, sizeStep: 1, sizeDec: 0, dayRangeTicks: 120, wallMin: 200, iceMin: 80, imbMin: 8 },
      GC: { name: "Gold", tick: 0.1, tickValue: 10, base: 4052.3, avgTrade: 2, depth: 30, sizeStep: 1, sizeDec: 0, dayRangeTicks: 200, wallMin: 100, iceMin: 30, imbMin: 4 },
      BTCUSDT: { name: "Bitcoin perp (Binance)", tick: 0.1, tickValue: 0.1, base: 98000, avgTrade: 0.02, depth: 4, sizeStep: 0.001, sizeDec: 3, dayRangeTicks: 8000, wallMin: 12, iceMin: 6, imbMin: 1.5 },
      ETHUSDT: { name: "Ether perp (Binance)", tick: 0.01, tickValue: 0.01, base: 3400, avgTrade: 0.3, depth: 60, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 6000, wallMin: 150, iceMin: 80, imbMin: 10 },

      /* Binance "TradFi" perpetuals: real, free, tick-by-tick order flow on commodities and index/stock trackers.
       * These are USDT-margined perpetuals that track the underlying, not CME contracts. */
      XAUUSDT: { name: "Gold perp (Binance)", tick: 0.01, tickValue: 0.01, base: 3755.37, avgTrade: 0.3, depth: 20, sizeStep: 0.001, sizeDec: 3, dayRangeTicks: 6000, wallMin: 25, iceMin: 8, imbMin: 1.5 },
      XAGUSDT: { name: "Silver perp (Binance)", tick: 0.01, tickValue: 0.01, base: 45.26, avgTrade: 3, depth: 300, sizeStep: 0.001, sizeDec: 3, dayRangeTicks: 200, wallMin: 300, iceMin: 100, imbMin: 10 },
      CLUSDT: { name: "Crude oil perp (Binance)", tick: 0.01, tickValue: 0.01, base: 81.68, avgTrade: 8, depth: 150, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 300, wallMin: 6000, iceMin: 1500, imbMin: 100 },
      BZUSDT: { name: "Brent oil perp (Binance)", tick: 0.01, tickValue: 0.01, base: 88.28, avgTrade: 6, depth: 150, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 300, wallMin: 6000, iceMin: 1500, imbMin: 100 },
      SPYUSDT: { name: "S&P 500 (SPY) perp (Binance)", tick: 0.01, tickValue: 0.01, base: 733.58, avgTrade: 6, depth: 150, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 1000, wallMin: 50, iceMin: 15, imbMin: 4 },
      QQQUSDT: { name: "Nasdaq-100 (QQQ) perp (Binance)", tick: 0.01, tickValue: 0.01, base: 661.27, avgTrade: 5, depth: 120, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 1000, wallMin: 40, iceMin: 12, imbMin: 3 },
      NVDAUSDT: { name: "NVIDIA perp (Binance)", tick: 0.01, tickValue: 0.01, base: 152.81, avgTrade: 10, depth: 200, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 600, wallMin: 60, iceMin: 20, imbMin: 5 },
      TSLAUSDT: { name: "Tesla perp (Binance)", tick: 0.01, tickValue: 0.01, base: 384.33, avgTrade: 4, depth: 100, sizeStep: 0.01, sizeDec: 2, dayRangeTicks: 1100, wallMin: 40, iceMin: 15, imbMin: 4 }
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
