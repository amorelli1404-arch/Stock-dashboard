# Index Watch

Single-file dark-mode stock and news analytics dashboard (S&P 500 / Nasdaq 100): Futures Desk, Trade Desk, Trading Terminal, Macro, Fundamentals, Sentiment Engine, Technical & Flow, Story Feed, Event Map.

Open `index.html` in a browser. Figures in most panels are illustrative; Buy/Sell is a UI mockup and places no real orders.

Trade-history persistence and CSV export rely on the claude.ai Artifact runtime (`window.claude` db/downloads capabilities); outside it the page falls back to local-only demo data and clipboard export.

## Futures Desk (ES / MES / NQ / MNQ)

Default landing view. Everything runs on a client-side simulator (seeded ES/NQ paths, sim clock in ET with 1×/10×/60× speed and restart presets):

- **Profile** - RTH and ETH volume profiles with VAH/VAL/POC; Initial Balance box with 1.5× / 2× extensions.
- **Intermarket** - NQ/ES ratio mini-chart, $TNX/VIX/DXY strip with TNX-vs-NQ correlation alerts, Mag 7 heatmap with weighted NQ-point impact.
- **Order flow & catalysts** - CVD sub-pane with price/CVD divergence marks; USD red-folder countdown (FOMC, CPI, NFP, PPI, Fed Chair) with a High Volatility Warning inside 15 minutes.
- **Risk** - CME tick engine (ES $12.50, MES $1.25, NQ $5.00, MNQ $0.50 per tick) and a prop-firm guard (daily loss limit + trailing drawdown) that caps contract size so one stop-out can't breach the rules.
- **Levels** - PDH/PDL/PDC, ONH/ONL, RTH open, and a 5/15/30-minute Opening Range box + matrix.
