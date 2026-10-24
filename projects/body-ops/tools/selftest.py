#!/usr/bin/env python3
"""Send one tiny payload of every shape Marrow uses to your bridge and show
what it reported back. The test points are dated 2 January 2001, so they
never show up in a normal time range.

    python3 tools/selftest.py --token <BRIDGE_TOKEN> [--url https://your-bridge-host]"""
import argparse
import json
import time
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8799")
ap.add_argument("--token", required=True)
a = ap.parse_args()
URL = f"{a.url.rstrip('/')}/{a.token}"
HEAD = {"Content-Type": "application/json", "User-Agent": "Marrow-selftest"}

payloads = {
    "daily": {"data": {"metrics": [
        {"name": "step_count", "units": "count", "data": [{"date": "2001-01-02", "qty": 8746}]},
        {"name": "sleep_analysis", "units": "h", "data": [{"date": "2001-01-02", "totalSleep": 7.4, "deep": 1.1,
         "rem": 1.6, "core": 4.7, "awake": 0.3, "sleepStart": "2001-01-01 23:10:00 +0000",
         "sleepEnd": "2001-01-02 06:50:00 +0000"}]}]}},
    "samples": {"data": {"metrics": [{"name": "heart_rate", "units": "bpm", "data": [
        {"start": "2001-01-02T14:00:00Z", "end": "2001-01-02T14:00:00Z", "qty": 64, "source": "Test"}]}]}},
    "workouts": {"data": {"workouts": [{"activity": "Running", "start": "2001-01-02T15:00:00Z",
                 "end": "2001-01-02T15:30:00Z", "duration_min": 30, "source": "Test", "kcal": 320}]}},
    "strength": {"data": {"unit": "lb", "sets": [{"time": "2001-01-02T16:00:00Z", "session": "Test",
                 "exercise": "Barbell Bench Press", "set": 1, "weight": 135, "reps": 5, "est_1rm": 158,
                 "set_type": "work"}]}},
    "nutrition": {"data": {"days": [{"day": "2001-01-02", "entries": [
        {"meal": "lunch", "name": "Test bowl", "kcal": 600, "protein_g": 40, "carbs_g": 60, "fat_g": 20,
         "logged_at": "2001-01-02T12:30:00Z"}]}]}},
    "mood": {"symptoms": [], "state_of_mind": [{"time": "2001-01-02T20:00:00Z", "kind": "Daily Mood",
                                                "valence": 0.4, "feeling": "calm", "source": "Test"}]},
}
for name, body in payloads.items():
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers=HEAD)
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"POST {name}: HTTP {r.status}")
time.sleep(3)
with urllib.request.urlopen(urllib.request.Request(URL, headers=HEAD), timeout=30) as r:
    status = json.load(r)
bad = 0
for rec in status["recent"][:len(payloads)]:
    print(f"  {rec['kind']:10} {'ok' if rec['ok'] else 'FAILED ' + rec.get('error', '')}")
    bad += not rec["ok"]
print("all good" if not bad else f"{bad} failed: check `docker compose logs bridge`")
