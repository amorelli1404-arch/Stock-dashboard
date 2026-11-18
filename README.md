# Index Watch

Dark-mode stock and news analytics dashboard (S&P 500 / Nasdaq 100): Trade Desk, Trading Terminal, **Order Flow (futures)**, Macro, Fundamentals, Sentiment Engine, Technical & Flow, Story Feed, Event Map.

Open `index.html` in a browser (or serve the folder, e.g. `python -m http.server`). Figures in most panels are illustrative; Buy/Sell is a UI mockup and places no real orders.

Trade-history persistence and CSV export rely on the claude.ai Artifact runtime (`window.claude` db/downloads capabilities); outside it the page falls back to local-only demo data and clipboard export.

## Order Flow view

Depth of market ladder (walls, iceberg absorption), footprint chart (bid x ask per price, imbalances, POC), CVD sub-chart with divergence detection, session volume profile / TPO (POC, VAH, VAL, HVN, LVN), session VWAP with 1 and 2 sigma bands, click-to-anchor VWAP, HTF levels (PDH/PDL/PDC, ONH/ONL, weekly open) and a high-impact economic calendar countdown.

Two feed modes, toggled in the view:

| Mode | Source | Notes |
|---|---|---|
| Simulated replay | Seeded simulator (ES, NQ, CL, GC, BTCUSDT, ETHUSDT) | Deterministic per seed, speed 1x to 60x, pause and restart. Prices are illustrative. |
| Live feed | WebSocket provider | `binance` works out of the box (BTCUSDT, ETHUSDT). Everything else goes through a relay. |

### Files

```
orderflow/config.js     all tunables: symbols, tick sizes, thresholds, live settings
orderflow/analytics.js  pure functions: profile, value area, TPO, VWAP, imbalance, CVD divergence, walls, icebergs
orderflow/calendar.js   economic calendar, New York time handling, countdown severity
orderflow/engine.js     market state: bars, volume at price, CVD, VWAP, anchors, book, alerts
orderflow/feeds.js      SimulatedFeed, reconnecting WebSocketFeed, provider adapters
orderflow/render.js     canvas renderers (ladder, footprint, CVD, profile)
orderflow/ui.js         controls, render loop (requestAnimationFrame, throttled), widgets
tests/orderflow.test.js unit tests
```

Data flows one way: feed -> normalized events -> engine state -> renderers. Feeds can push at any rate; drawing is throttled to `maxFps` and only happens when state changed.

### Run the tests

```
node --test tests/
```

### Connect a real feed

URL parameters select the mode without editing code: `?feed=live&symbol=BTCUSDT`, `?feed=live&provider=relay&url=wss://your-relay/stream?symbol={symbol}`.

**Futures vendors (CME via Databento, Rithmic, Polygon)** need an API key. Never put that key in this page. Run a small server-side relay that authenticates with the vendor and republishes messages in the normalized format below, then use the `relay` provider (or `OF.feeds.registerProvider` for a custom adapter).

Normalized messages (one object or an array of objects per WebSocket frame):

```json
{ "type": "trade",  "price": 6481.25, "size": 3, "side": "buy", "ts": 1763480000000 }
{ "type": "book",   "bids": [[6481.00, 40], [6480.75, 55]], "asks": [[6481.25, 38], [6481.50, 61]] }
{ "type": "delta",  "side": "b", "price": 6481.00, "size": 42 }
{ "type": "quote",  "bid": 6481.00, "bidSize": 40, "ask": 6481.25, "askSize": 38 }
{ "type": "levels", "pdh": 6521.5, "pdl": 6440.0, "pdc": 6475.0, "onh": 6490.0, "onl": 6470.5, "wo": 6460.0 }
```

- `side` on a trade is the **aggressor**: `buy` lifted the offer, `sell` hit the bid. If omitted it is inferred from the quote.
- `delta` size 0 removes the level. `side` is `b` (bid) or `a` (ask).
- `ts` is epoch milliseconds. Add the symbol to `OF.config.symbols` with its tick size and size floors.

Custom adapter skeleton:

```js
OF.feeds.registerProvider("mine", {
  label: "My vendor",
  supports: (symbol) => true,
  url: (symbol, live) => "wss://my-relay/stream?symbol=" + symbol,   // string or array of URLs
  subscribe: (symbol) => [{ action: "subscribe", symbol }],          // sent after open
  normalize: (frame) => [ /* normalized events */ ],
  loadLevels: (symbol) => fetch("...").then((r) => r.json())         // optional HTF levels
});
```

### Caveats

- Binance publishes trades and depth on different endpoints (`/market` and `/public`), so that adapter opens two sockets. Their stream layout has changed before; if Binance changes it again, update `binance.url` in `feeds.js`.
- Live prices on the claude.ai artifact copy may be blocked by the sandbox's network policy; run the repo copy for live data.
- Calendar dates: FOMC decision dates are the 2026 schedule, CPI dates are approximate, NFP and ISM use the usual weekday rule. Verify against the official calendars or replace the list with `OF.calendar.setEvents([...])`.
- "Latency" in live mode is receive time minus exchange timestamp, so it includes any clock skew on your machine.
