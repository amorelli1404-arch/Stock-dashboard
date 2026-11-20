# Index Watch

Dark-mode stock and news analytics dashboard (S&P 500 / Nasdaq 100): Futures Desk, Trade Desk, Trading Terminal, **Order Flow (futures)**, Macro, Fundamentals, Sentiment Engine, Technical & Flow, Story Feed, Event Map.

**Live site:** https://amorelli1404-arch.github.io/Stock-dashboard/ (GitHub Pages, served from `main`). Add `?feed=live&symbol=XAUUSDT` to start on real Binance futures data.

Open `index.html` in a browser (or serve the folder, e.g. `python -m http.server`). Figures in most panels are illustrative; Buy/Sell is a UI mockup and places no real orders. The Order Flow terminal's execution is simulated and never reaches a broker.

Trade-history persistence and CSV export rely on the claude.ai Artifact runtime (`window.claude` db/downloads capabilities); outside it the page falls back to local-only demo data and clipboard export.

## Event Map: 3D Globe

The Event Map view has a **Story map / 3D Globe** switch. The globe is a CesiumJS scene (loaded on demand from jsDelivr, so the rest of the app stays light) with a command-center HUD:

- **Basemaps:** Photorealistic 3D, Dark Tactical, Terrain Elevation, Maritime & Airspace. With no key, Photorealistic 3D falls back to Esri satellite imagery on real 3D terrain (Esri world elevation). Paste an optional Google Map Tiles API key under *Layers* to stream Google Photorealistic 3D Tiles; the key stays in your browser's local storage.
- **Lighting:** the day/night terminator and atmosphere follow the timeline clock, so scrubbing time moves the shadow line.
- **Live data (no keys):** USGS earthquakes (past 30 days, scaled by magnitude, with an indicative impact radius) and NASA EONET wildfires, volcanoes and storms. Storms show their observed track plus an *illustrative* extrapolated cone, which is not an official forecast. Feeds refresh every 5 minutes.
- **Layers:** macro/geopolitical (the Story map pins, high-impact US releases from the calendar, central banks), shipping chokepoints with animated great-circle arcs, flight corridors, undersea cables and market hubs with live session status (NYSE, CME Globex, LSE, Eurex, TSE, HKEX). Chokepoints, arcs, corridors and cables are approximate reference data, not live vessel or flight tracking. Exchange status models weekends and lunch breaks but not holidays.
- **HUD:** filterable live feed with *Fly to*, an event dossier (coordinates, sampled elevation, magnitude/depth/wind, impact ring, headlines, rule-based market sensitivity tags), a time scrubber (24H, 7D, 30D, or replay from a date) with play/pause at 1x/5x/20x, and a command palette (`Ctrl+K` or `/`) for cities, exchanges, events or coordinates.
- **Controls:** drag to pan, `Shift`+drag to tilt, `Ctrl`+drag to tilt and rotate, wheel to zoom. `H` toggles Cinema mode (hides the HUD), `Space` plays/pauses the timeline, `Esc` closes the dossier.
- **Performance:** markers are batched point primitives with distance scaling; pillars and shockwave rings are limited to the 36 most severe or freshest events; rendering stops while the globe is off screen.

Third-party tiles and data (Esri, OpenSeaMap, USGS, NASA EONET, Natural Earth) are used under their free terms with attribution shown on the globe. Check each provider's terms before commercial use.

### Analyst tools (multi-domain OSINT layer)

On top of the globe there is a decision-support layer. Read the data-source notes first, because several feeds cannot be reached keyless from a browser.

| Area | What it does | Data status |
|---|---|---|
| Aircraft | Heading trails plus parabolic arcs, regional ADS-B around the camera (airplanes.live, adsb.lol, adsb.fi tried in turn) | Those APIs block browser origins (CORS) in testing, so it falls back to **simulated** traffic between major airports, labelled as such. No military activity is ever simulated. |
| Vessels | Tankers, container ships and bulk carriers on the shipping lanes, with transponder-gap ("dark vessel") flags | **Simulated.** There is no free keyless live AIS feed. |
| Satellites | About 150 public-catalog spacecraft (weather, earth observation, imaging, navigation, US-designated), propagated with SGP4 in the browser and moved by the timeline. Select one for its footprint and ground track. | Live orbital elements from a public TLE mirror. The catalog includes some inactive spacecraft. |
| Next overpass | For any selected place: upcoming low-orbit passes above 10 degrees in 12 h, with countdowns | Computed from the same elements. |
| GNSS / cyber | GPS jamming reference zones, cable landing stations, internet-outage markers | Zones and landings are **reference data** from public reporting, not live. Outages are live from Georgia Tech IODA (country level). |
| Cameras | Chokepoint, hub and infrastructure dossiers link to public live-camera searches | Keyless streams cannot be embedded reliably, so these open in a new tab. |
| Geofences | Draw a circle or polygon (or watch a chokepoint) and get an alert when an event, vessel or aircraft enters. Saved in your browser. | Works on whatever is visible, including simulated layers. |
| Impact rings | 10 / 50 / 250 / 500 km rings around any event, listing exposed ports, airports, refineries, fabs, power sites, farm belts and data centers, with commodity and asset tags | Hand-curated reference list, not a complete register. |
| Measure | Distance, bearing, terrain profile and line of sight between two points (earth curvature and refraction included) | Line of sight along one line, not a full viewshed. Needs the 3D terrain basemap for real elevations. |
| Before / after | Draggable swipe between baseline and current NASA GIBS true-colour imagery, with VIIRS thermal anomalies on the current side | MODIS imagery is coarse (about 250 m). Storm-surge overlays are not included. |
| Briefing | Structured summary of what is in the current view, the world or a geofence, with CRITICAL / HIGH / ELEVATED / LOW ratings per domain | **Rule-based text, not a language model.** |
| Import | Drag a GeoJSON, KML, KMZ or CZML file onto the globe (20 MB limit) | Runs locally in your browser. |
| Share / export | Copy a link that restores camera, layers, basemap, timeline position and selection; export a PNG snapshot or a JSON briefing | Links are validated and range-checked when opened. |

## Futures Desk (ES / MES / NQ / MNQ)

Default landing view. Everything runs on a client-side simulator (seeded ES/NQ paths, sim clock in ET with 1×/10×/60× speed and restart presets):

- **Profile** - RTH and ETH volume profiles with VAH/VAL/POC; Initial Balance box with 1.5× / 2× extensions.
- **Intermarket** - NQ/ES ratio mini-chart, $TNX/VIX/DXY strip with TNX-vs-NQ correlation alerts, Mag 7 heatmap with weighted NQ-point impact.
- **Order flow & catalysts** - CVD sub-pane with price/CVD divergence marks; USD red-folder countdown (FOMC, CPI, NFP, PPI, Fed Chair) with a High Volatility Warning inside 15 minutes.
- **Risk** - CME tick engine (ES $12.50, MES $1.25, NQ $5.00, MNQ $0.50 per tick) and a prop-firm guard (daily loss limit + trailing drawdown) that caps contract size so one stop-out can't breach the rules.
- **Levels** - PDH/PDL/PDC, ONH/ONL, RTH open, and a 5/15/30-minute Opening Range box + matrix.

## Order Flow view

Depth of market ladder (walls, iceberg absorption), footprint chart (bid x ask per price, imbalances, POC), CVD sub-chart with divergence detection, session volume profile / TPO (POC, VAH, VAL, HVN, LVN), session VWAP with 1 and 2 sigma bands, click-to-anchor VWAP, HTF levels (PDH/PDL/PDC, ONH/ONL, weekly open) and a high-impact economic calendar countdown.

Two feed modes, toggled in the view:

| Mode | Source | Notes |
|---|---|---|
| Simulated replay | Seeded simulator (ES, NQ, CL, GC, BTCUSDT, ETHUSDT) | Deterministic per seed, speed 1x to 60x, pause and restart. Prices are illustrative. |
| Live feed | WebSocket provider | `binance` works out of the box (BTCUSDT, ETHUSDT). Everything else goes through a relay. |

### Terminal layout (full screen, workspaces, hotkeys)

- **Full screen:** the *Full screen* button (or `Shift+F`) maximises the terminal to the whole window and asks the browser for native full screen too. Where the browser blocks that (some embedded frames), it stays maximised in place; use the button to leave.
- **Workspaces:** *Scalping DOM* (ladder, execution, footprint, delta, tape), *Macro Structure* (footprint, delta, CVD, profile) and *Tape & Heatmap* (heatmap, ladder, delta, tape). Drag the thin bars between columns to resize them (double-click resets). The choice and widths are remembered per browser.
- **Delta:** a per-bar delta histogram with intrabar max/min wicks and the session total, a *Footprint* cell mode (Bid x Ask, net **Delta** or **Volume** per price), and delta/buy/sell volume on every bar.
- **Liquidity heatmap:** resting limit-order depth over time behind a price trail. Brighter means larger. An amber x marks size that vanished without trading through it (pulling or spoofing); circles mark large prints. History starts when you connect, because exchanges do not publish past book depth.
- **Time & sales:** filter by minimum size. Sweeps (fast same-side burst across 3+ levels), block prints and iceberg hits are highlighted and always shown.
- **Sessions:** Asia, London and NY RTH shading, Initial Balance (first hour of RTH) and a 15 minute Opening Range with a breakout alert. All times are New York time; tunables are in `orderflow/config.js`.
- **Execution (simulated):** Buy/Sell Mkt, Join Bid/Ask, Flatten All, Reverse, click the ladder's bid or ask column to rest a limit (right-click cancels), a stop/target bracket and a max-daily-loss lockout. Fills are simulated against the book: market orders at the touch, limits when the tape trades through them, no queue position. **Nothing is sent to a broker.**
- **Hotkeys:** `Shift+B` buy at the ask, `Shift+S` sell at the bid, `Space` recenter the ladder, `Esc` or `Shift+X` flatten, `Shift+F` full screen. In native full screen the browser uses `Esc` to leave first, so use `Shift+X` there. Sound cues (block print, sweep, absorption, pull, fill) are opt-in via the *Sound* button.
- **Synchronised crosshair:** hovering the footprint, heatmap, delta, CVD or ladder marks the same time and price on the others.

### Timeframes

The Timeframe selector (1m, 5m, 15m, 1h, 4h) re-buckets the footprint, CVD, VWAP, profile and TPO. Bars are built from trades, so history depends on the feed:

- **Replay:** warm-up is capped at 2 hours of simulated time, so 1h and 4h show only a few bars.
- **Binance:** on connect (and after a reconnect, to fill the gap) recent trades are loaded from the REST API before the live stream is applied. That is about 24 seconds of BTC trades per request, `live.backfillPages` (default 25) requests, so roughly 10 minutes of history. Higher timeframes fill in as time passes.
- **Databento:** bars start when the relay connects; no trade history is loaded.

### Free live futures (Binance, no key, no relay)

Live feed + Provider "Binance Futures" streams real tick-by-tick trades and 20-level depth for perpetual futures, with trade history loaded on connect:

| Symbol | Tracks |
|---|---|
| XAUUSDT, XAGUSDT | Gold, silver |
| CLUSDT, BZUSDT | WTI crude, Brent |
| SPYUSDT, QQQUSDT | S&P 500 and Nasdaq-100 (via the SPY / QQQ ETFs) |
| NVDAUSDT, TSLAUSDT | single stocks |
| BTCUSDT, ETHUSDT | crypto |

These are Binance USDT-margined perpetuals that track the underlying. They are real, live, free order flow, but they are **not CME contracts**: prices and volume differ from ES/NQ/CL/GC, and volume is Binance's own. Alert thresholds (`wallMin`, `iceMin`, `imbMin`) were calibrated from observed book sizes and can be tuned per symbol in `orderflow/config.js`. Equity-linked perps may trade thinly or pause outside US market hours. Real CME contracts need a licensed vendor (see below).

### Live CME futures (Databento)

1. `pip install -r relay/requirements.txt`
2. Copy `relay/.env.example` to `relay/.env` and set `DATABENTO_API_KEY` (needs a Databento account with CME Globex MDP 3.0 live data).
3. `python relay/databento_relay.py` (or `--mock` for synthetic data without a key).
4. In the view: Live feed, Provider "Databento (CME, local relay)", symbol ES / NQ / CL / GC.

The relay subscribes to MBP-10 (trades plus 10 levels of depth) on continuous front-month symbols, derives PDH/PDL/PDC, overnight high/low and weekly open from historical 1-minute bars, and binds to `127.0.0.1`. Only pages served from localhost (plus origins in `ALLOWED_ORIGINS`) may connect, so other websites cannot read your licensed data. Trade side comes from Databento's aggressor flag.

Status: the relay's Databento code follows Databento's documented Python API but has not been run against a live account. The `--mock` mode and the dashboard connection are tested.

### Files

```
orderflow/config.js     all tunables: symbols, tick sizes, thresholds, live settings
orderflow/analytics.js  pure functions: profile, value area, TPO, VWAP, imbalance, CVD divergence, walls, icebergs
orderflow/calendar.js   economic calendar, New York time handling, countdown severity
orderflow/engine.js     market state: bars, volume at price, CVD, VWAP, anchors, book, alerts
orderflow/feeds.js      SimulatedFeed, reconnecting WebSocketFeed, provider adapters
orderflow/sessions.js   New York sessions, Initial Balance / Opening Range trackers
orderflow/trading.js    simulated execution: orders, bracket, P&L, daily loss lock
orderflow/audio.js      optional Web Audio cues
orderflow/render.js     canvas renderers (ladder, footprint, CVD, profile)
orderflow/render_ext.js liquidity heatmap, delta histogram, session levels, position lines, crosshair mapping
orderflow/ui.js         controls, render loop (requestAnimationFrame, throttled), widgets
orderflow/ui_terminal.js workspaces, splitters, full screen, execution panel, tape, hotkeys
globe/data.js           event feed normalisers, geo helpers, market sessions, reference layers
globe/scene.js          CesiumJS scene: basemaps, markers, arcs, camera, picking
globe/hud.js            feed drawer, dossier, timeline, command palette
globe/infra.js          reference datasets: infrastructure, GNSS zones, cable landings
globe/analytics.js      geofences, exposure, line of sight, rule-based briefing, share state
globe/intel.js          aircraft, vessels, satellites, outages and reference layers
globe/tools.js          geofence drawing, measure, rings, before/after, import, export
globe/panel.js          toolbar, Briefing and Watch tabs, dossier sections
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
