#!/usr/bin/env python3
"""Local relay: Databento live CME data (GLBX.MDP3, MBP-10) -> normalized WebSocket messages for the dashboard.

The Databento API key stays in relay/.env (or the environment) and never reaches the browser.

    pip install databento websockets
    python relay/databento_relay.py            # live CME data (needs DATABENTO_API_KEY and a CME license)
    python relay/databento_relay.py --mock     # synthetic data, no key, to test the dashboard connection

Dashboard: Order Flow -> Live feed -> Provider "Databento (CME, local relay)".
Protocol: see README ("Normalized messages"). Each WebSocket frame is a JSON array of events.
"""
import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.asyncio.server import serve

DATASET = "GLBX.MDP3"
SYMBOLS = {"ES": "ES.c.0", "NQ": "NQ.c.0", "CL": "CL.c.0", "GC": "GC.c.0"}
PRICE_SCALE = 1e9          # Databento fixed-point prices
UNDEF_PRICE = 2 ** 63 - 1  # empty book level
FLUSH_MS = 25
BOOK_MS = 100
DEFAULT_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def load_env(path):
    """Minimal .env reader; real environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def as_char(x):
    """Databento enums/bytes/ints -> single character string."""
    if hasattr(x, "value"):
        x = x.value
    if isinstance(x, bytes):
        return x.decode(errors="ignore")
    if isinstance(x, int):
        return chr(x)
    return str(x)


class Feed:
    """Collects events for one symbol and fans them out to subscribers on a short timer."""

    def __init__(self, symbol):
        self.symbol = symbol
        self.subs = set()
        self.out = []
        self.book = None
        self.book_dirty = False
        self.last_book_at = 0.0
        self.levels = None
        self.tasks = []

    def push(self, event):
        self.out.append(event)

    def set_book(self, bids, asks):
        self.book = {"type": "book", "bids": bids, "asks": asks}
        self.book_dirty = True

    async def send_all(self, events):
        if not events or not self.subs:
            return
        text = json.dumps(events, separators=(",", ":"))
        for ws in list(self.subs):
            try:
                await ws.send(text)
            except websockets.ConnectionClosed:
                self.subs.discard(ws)

    async def flusher(self):
        while True:
            await asyncio.sleep(FLUSH_MS / 1000)
            events, self.out = self.out, []
            now = time.monotonic()
            if self.book_dirty and now - self.last_book_at >= BOOK_MS / 1000:
                events.append(self.book)
                self.book_dirty = False
                self.last_book_at = now
            await self.send_all(events)

    async def run(self):
        raise NotImplementedError

    def start(self):
        self.tasks = [asyncio.create_task(self.flusher()), asyncio.create_task(self.guarded_run())]

    async def guarded_run(self):
        try:
            await self.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # surface the failure to the dashboard instead of dying silently
            print(f"[{self.symbol}] feed error: {exc}", file=sys.stderr)
            self.push({"type": "notice", "text": f"Relay feed error for {self.symbol}: {exc}"})

    def stop(self):
        for task in self.tasks:
            task.cancel()
        self.tasks = []


class DatabentoFeed(Feed):
    def __init__(self, symbol, api_key):
        super().__init__(symbol)
        self.api_key = api_key
        self.client = None

    def on_record(self, rec):
        import databento as db

        if not isinstance(rec, db.MBP10Msg):
            return
        px = rec.price
        if as_char(rec.action) == "T" and rec.size > 0 and px != UNDEF_PRICE:
            event = {"type": "trade", "price": px / PRICE_SCALE, "size": int(rec.size), "ts": rec.ts_event // 1_000_000}
            side = {"B": "buy", "A": "sell"}.get(as_char(rec.side))  # side = aggressor ("A" = sell aggressor)
            if side:
                event["side"] = side
            self.push(event)
        bids, asks = [], []
        for lvl in rec.levels:
            if lvl.bid_sz > 0 and lvl.bid_px != UNDEF_PRICE:
                bids.append([lvl.bid_px / PRICE_SCALE, int(lvl.bid_sz)])
            if lvl.ask_sz > 0 and lvl.ask_px != UNDEF_PRICE:
                asks.append([lvl.ask_px / PRICE_SCALE, int(lvl.ask_sz)])
        self.set_book(bids, asks)

    async def run(self):
        import databento as db

        loop = asyncio.get_running_loop()
        self.client = db.Live(key=self.api_key)
        # Callbacks run on the client's thread; hand records to the event loop.
        self.client.add_callback(lambda rec: loop.call_soon_threadsafe(self.on_record, rec))
        self.client.subscribe(dataset=DATASET, schema="mbp-10", stype_in="continuous", symbols=[SYMBOLS[self.symbol]])
        self.client.start()
        await asyncio.gather(self.load_levels(), self.client.wait_for_close())

    async def load_levels(self):
        try:
            levels = await asyncio.to_thread(self.fetch_levels)
        except Exception as exc:
            self.push({"type": "notice", "text": f"Higher-timeframe levels unavailable: {exc}"})
            return
        self.levels = levels
        self.push(levels)

    def fetch_levels(self):
        """PDH/PDL/PDC from the last completed regular session, ONH/ONL from the globex session, weekly open."""
        import databento as db
        from zoneinfo import ZoneInfo

        et = ZoneInfo("America/New_York")
        now = datetime.now(timezone.utc)
        hist = db.Historical(self.api_key)
        df = hist.timeseries.get_range(
            dataset=DATASET, schema="ohlcv-1m", stype_in="continuous", symbols=[SYMBOLS[self.symbol]],
            start=(now - timedelta(days=9)).isoformat(),
        ).to_df()
        if df.empty:
            raise RuntimeError("no historical bars returned")
        df.index = df.index.tz_convert(et)
        minutes = df.index.hour * 60 + df.index.minute
        rth = df[(minutes >= 9 * 60 + 30) & (minutes < 16 * 60)]
        today = now.astimezone(et).date()
        prior = rth[rth.index.date < today]
        if prior.empty:
            raise RuntimeError("no completed regular session found")
        day = prior[prior.index.date == prior.index.date.max()]
        out = {"type": "levels", "pdh": float(day["high"].max()), "pdl": float(day["low"].min()), "pdc": float(day["close"].iloc[-1])}

        now_et = now.astimezone(et)
        session_end = now_et.replace(hour=9, minute=30, second=0, microsecond=0)
        if now_et < session_end:
            session_end = now_et
        session_start = (session_end - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
        if now_et.weekday() == 0:  # Monday morning: the overnight session began Sunday 18:00
            session_start = (now_et - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
        overnight = df[(df.index >= session_start) & (df.index < session_end)]
        if not overnight.empty:
            out["onh"], out["onl"] = float(overnight["high"].max()), float(overnight["low"].min())

        days_since_sunday = (now_et.weekday() + 1) % 7
        week_start = (now_et - timedelta(days=days_since_sunday)).replace(hour=18, minute=0, second=0, microsecond=0)
        week = df[df.index >= week_start]
        if not week.empty:
            out["wo"] = float(week["open"].iloc[0])
        return out

    def stop(self):
        super().stop()
        if self.client is not None:
            try:
                self.client.stop()
            except Exception:
                pass


class MockFeed(Feed):
    """Synthetic ES/NQ/CL/GC-shaped data over the same protocol. Not real prices."""

    BASE = {"ES": (6481.25, 0.25), "NQ": (23118.75, 0.25), "CL": (61.52, 0.01), "GC": (4052.3, 0.1)}

    async def run(self):
        base, tick = self.BASE[self.symbol]
        mid = round(base / tick)
        self.push({"type": "notice", "text": "MOCK relay: synthetic data, not a real market"})
        self.levels = {"type": "levels", "pdh": base + 30 * tick, "pdl": base - 25 * tick, "pdc": base - 2 * tick,
                       "onh": base + 10 * tick, "onl": base - 8 * tick, "wo": base - 12 * tick}
        self.push(self.levels)
        while True:
            side = "buy" if random.random() < 0.5 else "sell"
            if random.random() < 0.18:
                mid += 1 if side == "buy" else -1
            price = round((mid + (1 if side == "buy" else 0)) * tick, 6)
            self.push({"type": "trade", "price": price, "size": random.randint(1, 8), "side": side, "ts": int(time.time() * 1000)})
            bids = [[round((mid - i) * tick, 6), random.randint(5, 80)] for i in range(10)]
            asks = [[round((mid + 1 + i) * tick, 6), random.randint(5, 80)] for i in range(10)]
            self.set_book(bids, asks)
            await asyncio.sleep(random.uniform(0.02, 0.12))


class Hub:
    def __init__(self, factory):
        self.factory = factory
        self.feeds = {}

    async def add(self, symbol, ws):
        feed = self.feeds.get(symbol)
        if feed is None:
            feed = self.feeds[symbol] = self.factory(symbol)
            feed.start()
        feed.subs.add(ws)
        late = [e for e in (feed.levels, feed.book) if e]
        await feed.send_all(late)

    def remove(self, symbol, ws):
        feed = self.feeds.get(symbol)
        if not feed:
            return
        feed.subs.discard(ws)
        if not feed.subs:
            feed.stop()
            del self.feeds[symbol]


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mock", action="store_true", help="serve synthetic data (no API key needed)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    load_env(Path(__file__).with_name(".env"))
    if args.mock:
        hub = Hub(MockFeed)
    else:
        key = os.environ.get("DATABENTO_API_KEY", "")
        if not key:
            sys.exit("DATABENTO_API_KEY is not set. Put it in relay/.env (see relay/.env.example) or use --mock.")
        hub = Hub(lambda symbol: DatabentoFeed(symbol, key))

    # Browsers send an Origin header: only localhost pages (and extra origins you list) may connect, so other
    # websites cannot read your licensed market data through this socket.
    extra = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
    origins = [DEFAULT_ORIGIN, "null", None] + extra  # "null" is file://, None is non-browser clients

    async def handler(ws):
        query = parse_qs(urlparse(ws.request.path).query)
        symbol = (query.get("symbol", [""])[0]).upper()
        if symbol not in SYMBOLS:
            await ws.close(1008, "unknown symbol")
            return
        await hub.add(symbol, ws)
        try:
            await ws.wait_closed()
        finally:
            hub.remove(symbol, ws)

    async with serve(handler, args.host, args.port, origins=origins):
        print(f"Relay listening on ws://{args.host}:{args.port}/stream?symbol=ES  ({'MOCK' if args.mock else 'Databento ' + DATASET})")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
