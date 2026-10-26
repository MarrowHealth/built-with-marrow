#!/usr/bin/env python3
"""A year in six rings: one picture from the Body Ops database.

Each ring chart is a clock. One ring per day (oldest in the middle), one
slice per hour (midnight at the top), colored by that hour's value: heart
rate, steps, calories burned, sound and daylight from raw samples, and sleep
as one arc per night from falling asleep to waking up.

    python3 rings.py --token <INFLUX_TOKEN> --tz America/New_York [--days 365] [--out out]

Writes out/rings.html with the data inside it. Open it in a browser and press
"Download PNG" for the 3000 x 2320 picture. With Playwright installed
(pip install playwright && playwright install chromium) it also writes
out/rings.png itself.

Needs raw samples for the whole span you want: see README.md.
"""
import argparse
import asyncio
import csv
import io
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--url", default=os.environ.get("INFLUX_URL", "http://127.0.0.1:8086"))
ap.add_argument("--token", default=os.environ.get("INFLUX_TOKEN"), help="InfluxDB token (or INFLUX_TOKEN)")
ap.add_argument("--org", default="marrow")
ap.add_argument("--tz", default=os.environ.get("TZ_NAME", "UTC"), help="your time zone, e.g. Europe/London")
ap.add_argument("--days", type=int, default=365)
ap.add_argument("--out", default=os.path.join(HERE, "out"))
a = ap.parse_args()
if not a.token:
    raise SystemExit("give --token or set INFLUX_TOKEN")

# Each hourly ring: a name, the metric, and how its samples add up inside an hour.
HOURLY = {"heart": ("heart_rate", "mean"), "steps": ("step_count", "sum"), "energy": ("active_energy", "sum"),
          "sound": ("environmental_audio_exposure", "mean"), "daylight": ("time_in_daylight", "sum")}


def query(q):
    head = f'import "timezone"\nimport "date"\noption location = timezone.location(name: "{a.tz}")\n'
    req = urllib.request.Request(
        a.url.rstrip("/") + "/api/v2/query?" + urllib.parse.urlencode({"org": a.org}),
        data=json.dumps({"query": head + q, "type": "flux"}).encode(), method="POST",
        headers={"Authorization": f"Token {a.token}", "Content-Type": "application/json", "Accept": "application/csv"})
    with urllib.request.urlopen(req, timeout=300) as r:
        text = r.read().decode()
    rows = []
    for block in text.split("\r\n\r\n"):
        if block.strip():
            rows += [row for row in csv.DictReader(io.StringIO(block.strip())) if row.get("_value") not in (None, "")]
    return rows


def pull():
    rng = f"range(start: -{a.days}d)"
    tz = ZoneInfo(a.tz)
    today = datetime.now(timezone.utc).astimezone(tz).date()
    first = today - timedelta(days=a.days - 1)

    def local(iso, shift_hours=0):
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(tz) - timedelta(hours=shift_hours)
        return (t.date() - first).days, t

    rings = {}
    for name, (metric, fn) in HOURLY.items():
        # A phone and a watch both count steps and calories, and Apple keeps the higher
        # one per interval rather than adding them. Same here: per device, then the max.
        agg = ('|> group(columns: ["source"]) |> aggregateWindow(every: 1h, fn: sum, createEmpty: false)\n'
               '  |> group(columns: ["_time"]) |> max() |> group()' if fn == "sum"
               else '|> group() |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)')
        rows = query(f'''from(bucket: "health") |> {rng}
  |> filter(fn: (r) => r._measurement == "sample" and r.metric == "{metric}" and r._field == "value")
  {agg} |> keep(columns: ["_time", "_value"])''')
        grid = [[None] * 24 for _ in range(a.days)]
        for r in rows:
            d, t = local(r["_time"], 1)  # a window is stamped with its end, so step back into it
            if 0 <= d < a.days:
                grid[d][t.hour] = round(float(r["_value"]), 1)
        start = next((d for d in range(a.days) if any(v is not None for v in grid[d])), None)
        if start is not None:
            rings[name] = {"from": start, "grid": grid[start:]}
        print(f"{name}: {len(rows)} hours")

    nights = []
    for r in query(f'''from(bucket: "health") |> {rng}
  |> filter(fn: (r) => r._measurement == "daily" and r.metric == "sleep_analysis")
  |> filter(fn: (r) => r._field == "sleepStart_s" or r._field == "sleepEnd_s" or r._field == "tz_offset_min" or r._field == "totalSleep")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> map(fn: (r) => ({{_time: r._time, _value: r.totalSleep, start: r.sleepStart_s, end: r.sleepEnd_s, tz: r.tz_offset_min}}))'''):
        d, _ = local(r["_time"])
        off = float(r["tz"]) * 60
        if 0 <= d < a.days:
            nights.append({"d": d, "s": round((float(r["start"]) + off) % 86400 / 3600, 2),
                           "e": round((float(r["end"]) + off) % 86400 / 3600, 2), "h": round(float(r["_value"]), 2)})
    print(f"sleep: {len(nights)} nights")

    months, cur = [], first.replace(day=1)
    while cur <= today:
        if (cur - first).days >= 0:
            months.append({"d": (cur - first).days, "name": cur.strftime("%b"), "year": cur.year})
        cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
    return {"first": first.isoformat(), "last": today.isoformat(), "days": a.days, "rings": rings,
            "nights": nights, "months": months}


async def render(path):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page(viewport={"width": 3000, "height": 2320}, device_scale_factor=2)
        await pg.goto("file://" + path, wait_until="networkidle")
        await pg.wait_for_function("window.__drawn === true", timeout=60000)
        await pg.add_style_tag(content="#bar { display: none }")
        await pg.wait_for_timeout(500)
        png = path[:-5] + ".png"
        await pg.locator("#poster").screenshot(path=png)
        await browser.close()
    print("wrote", png)


data = pull()
os.makedirs(a.out, exist_ok=True)
html = open(os.path.join(HERE, "rings.html"), encoding="utf-8").read()
page = os.path.join(a.out, "rings.html")
with open(page, "w", encoding="utf-8") as f:
    f.write(html.replace("/*DATA*/null", json.dumps(data, separators=(",", ":")), 1))
print("wrote", page, "(open it in a browser and press Download PNG)")
try:
    import playwright  # noqa: F401
except ImportError:
    pass
else:
    asyncio.run(render(os.path.abspath(page)))
