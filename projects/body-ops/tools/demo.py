#!/usr/bin/env python3
"""Fill Body Ops with a year of made-up data, sent through the bridge in the
exact shapes Marrow's automations use. Good for trying the dashboard before
connecting your phone, or for screenshots that show nobody's real health.

    python3 tools/demo.py --token <BRIDGE_TOKEN> [--url http://127.0.0.1:8799] [--tz America/New_York]

Every value here is generated. Nothing comes from a real person."""
import argparse
import json
import math
import random
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8799")
ap.add_argument("--token", required=True)
ap.add_argument("--tz", default="UTC")
ap.add_argument("--days", type=int, default=365)
ap.add_argument("--seed", type=int, default=7)
a = ap.parse_args()
TZ = ZoneInfo(a.tz)
rnd = random.Random(a.seed)
today = datetime.now(TZ).date()
days = [today - timedelta(days=i) for i in range(a.days, -1, -1)]


def post(body, what):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{a.url.rstrip('/')}/{a.token}", data=data, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "Marrow-demo"})
    with urllib.request.urlopen(req, timeout=120) as r:
        print(f"sent {what}: {len(data) // 1024} KB, HTTP {r.status}")


def at(d, hours):
    """Local datetime on day d at a (possibly fractional, possibly >24) hour."""
    return datetime.combine(d, time(0), TZ) + timedelta(hours=hours)


def isoz(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def season(d):
    """0 in midwinter, 1 in midsummer (northern hemisphere)."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * (d.timetuple().tm_yday - 15) / 365)


# ---- a plan for every day: sleep, training, how active -----------------------------------------
LIFT_FROM = today - timedelta(days=42)
FOOD_FROM = today - timedelta(days=72)
plan = {}
for d in days:
    wd = d.weekday()
    weekend = wd >= 4  # Friday and Saturday nights run late
    bed = 23.3 + (1.0 if weekend else 0) + rnd.gauss(0, 0.6)
    wake = (8.9 if wd >= 5 else 7.2) + rnd.gauss(0, 0.45) + 24
    lift = d >= LIFT_FROM and wd in (0, 1, 3, 4) and rnd.random() > 0.12
    run = wd in (2, 5) and rnd.random() > 0.3
    plan[d] = {"bed": bed, "wake": wake, "lift": lift, "run": run,
               "active": max(0.3, rnd.gauss(1.0, 0.25) + 0.3 * season(d) + (0.25 if run else 0))}

# ---- sleep: nightly totals and, for the last 90 nights, every stage -------------------------------
daily = {k: [] for k in ("step_count", "walking_running_distance", "active_energy", "basal_energy_burned",
                         "apple_exercise_time", "flights_climbed", "resting_heart_rate", "heart_rate_variability",
                         "respiratory_rate", "blood_oxygen", "time_in_daylight", "environmental_audio_exposure",
                         "headphone_audio_exposure", "wrist_temperature", "sleep_hours")}
units = {"step_count": "count", "walking_running_distance": "m", "active_energy": "kcal",
         "basal_energy_burned": "kcal", "apple_exercise_time": "min", "flights_climbed": "count",
         "resting_heart_rate": "bpm", "heart_rate_variability": "ms", "respiratory_rate": "brpm",
         "blood_oxygen": "%", "time_in_daylight": "min", "environmental_audio_exposure": "dBASPL",
         "headphone_audio_exposure": "dBASPL", "wrist_temperature": "degC", "sleep_hours": "h"}
sleep_points, stage_samples, nights = [], [], {}
for d in days[1:]:
    prev = d - timedelta(days=1)
    start, end = at(prev, plan[prev]["bed"]), at(prev, plan[prev]["wake"])
    t, segs = start, []
    cycle = 0
    while t < end:  # ~90 minute cycles: core, deep (early), core, REM (late)
        early = cycle < 2
        for stage, mins in (("core", rnd.uniform(20, 35)), ("deep", rnd.uniform(25, 45) if early else rnd.uniform(0, 12)),
                            ("core", rnd.uniform(15, 25)), ("rem", rnd.uniform(8, 15) if early else rnd.uniform(20, 35))):
            if mins < 2 or t >= end:
                continue
            e = min(end, t + timedelta(minutes=mins))
            segs.append((stage, t, e))
            t = e
        if rnd.random() < 0.5 and t < end:
            e = min(end, t + timedelta(minutes=rnd.uniform(1, 6)))
            segs.append(("awake", t, e))
            t = e
        cycle += 1
    hours = {s: sum((e - b).total_seconds() for st, b, e in segs if st == s) / 3600 for s in ("core", "deep", "rem", "awake")}
    asleep = hours["core"] + hours["deep"] + hours["rem"]
    nights[d] = (start, end, segs)
    sleep_points.append({"date": d.isoformat(), "totalSleep": round(asleep, 4), "asleep": round(asleep, 4),
                         "deep": round(hours["deep"], 4), "core": round(hours["core"], 4), "rem": round(hours["rem"], 4),
                         "awake": round(hours["awake"], 4),
                         "sleepStart": start.strftime("%Y-%m-%d %H:%M:%S %z"), "sleepEnd": end.strftime("%Y-%m-%d %H:%M:%S %z")})
    daily["sleep_hours"].append({"date": d.isoformat(), "qty": round(asleep, 3)})
    if (today - d).days <= 90:
        stage_samples += [{"start": isoz(b), "end": isoz(e), "qty": 0, "source": "Demo Watch", "stage": st}
                          for st, b, e in segs]

# ---- heart rate every 10 minutes for the year, and the daily numbers ------------------------------------------
workouts, hr_by_month, hr_daily = [], {}, []
for d in days:
    p = plan[d]
    sessions = []
    if p["lift"]:
        s = at(d, rnd.choice((7.0, 17.5, 18.0)))
        sessions.append(("Strength", s, s + timedelta(minutes=rnd.uniform(65, 100)), 105))
    if p["run"]:
        s = at(d, rnd.choice((7.5, 18.5)))
        sessions.append(("Running", s, s + timedelta(minutes=rnd.uniform(25, 50)), 150))
    fitness = (d - days[0]).days / a.days  # slowly fitter over the year
    rest = 61 - 4 * fitness + rnd.gauss(0, 1.5)
    bpm = []
    t = at(d, 0)
    while t < at(d, 24):
        h = (t - at(d, 0)).total_seconds() / 3600
        night = nights.get(d)
        tonight = nights.get(d + timedelta(days=1))
        asleep = (night and night[0] <= t < night[1]) or (tonight and tonight[0] <= t < tonight[1])
        if asleep:
            v = rest - 7 + rnd.gauss(0, 2.5)
        else:
            v = rest + 14 + 10 * math.sin(math.pi * (h - 7) / 14) * p["active"] + rnd.gauss(0, 7)
        for kind, s, e, peak in sessions:
            if s <= t < e:
                v = peak + rnd.gauss(0, 12 if kind == "Strength" else 8)
        bpm.append((t, max(40, round(v))))
        t += timedelta(minutes=10)
    hr_by_month.setdefault(d.strftime("%Y-%m"), []).extend(
        {"start": isoz(t), "end": isoz(t), "qty": v, "source": "Demo Watch"} for t, v in bpm)
    vals = [v for _, v in bpm]
    hr_daily.append({"date": d.isoformat(), "Avg": round(sum(vals) / len(vals), 1), "Min": min(vals), "Max": max(vals)})
    for kind, s, e, peak in sessions:
        mins = (e - s).total_seconds() / 60
        workouts.append({"activity": kind, "start": isoz(s), "end": isoz(e), "duration_min": round(mins, 2),
                         "source": "Demo Watch", "kcal": round(mins * (9 if kind == "Running" else 5)),
                         "avg_hr": peak - 8, **({"distance_mi": round(mins / 9.5, 2)} if kind == "Running" else {})})
    steps = max(1500, rnd.gauss(8200, 2200) * p["active"] + (4500 if p["run"] else 0))
    add = lambda k, v: daily[k].append({"date": d.isoformat(), "qty": round(v, 2)})
    add("step_count", steps)
    add("walking_running_distance", steps * 0.76)
    add("active_energy", steps * 0.045 + (300 if sessions else 0))
    add("basal_energy_burned", 1820 + rnd.gauss(0, 25))
    add("apple_exercise_time", max(3, rnd.gauss(22, 10) + sum((e - s).total_seconds() / 60 for _, s, e, _ in sessions)))
    add("flights_climbed", max(0, rnd.gauss(10, 4)))
    add("resting_heart_rate", rest)
    add("heart_rate_variability", max(25, 62 + 12 * fitness + rnd.gauss(0, 9) + (5 if not sessions else 0)))
    add("respiratory_rate", rnd.gauss(15, 0.5))
    add("blood_oxygen", min(100, rnd.gauss(96.6, 0.8)))
    add("time_in_daylight", max(2, rnd.gauss(25 + 85 * season(d), 20) + (25 if d.weekday() >= 5 else 0)))
    add("environmental_audio_exposure", rnd.gauss(62, 4))
    add("headphone_audio_exposure", rnd.gauss(68, 4))
    add("wrist_temperature", rnd.gauss(35.9, 0.18))

metrics = [{"name": k, "units": units[k], "data": v} for k, v in daily.items()]
metrics.append({"name": "heart_rate", "units": "bpm", "data": hr_daily})
metrics.append({"name": "sleep_analysis", "units": "h", "data": sleep_points})
post({"data": {"metrics": metrics}}, "a year of daily totals")
for month, samples in sorted(hr_by_month.items()):
    post({"data": {"metrics": [{"name": "heart_rate", "units": "bpm", "data": samples}]}}, f"heart rate {month}")
post({"data": {"metrics": [{"name": "sleep_analysis", "units": "stage", "data": stage_samples}]}}, "90 nights of sleep stages")
post({"data": {"workouts": workouts}}, f"{len(workouts)} workouts")

# ---- lifting: a four day split that slowly gets stronger -------------------------------------------------------
SPLIT = {0: [("Barbell Bench Press", 155), ("Incline Dumbbell Press", 55), ("Cable Crossover", 35), ("Cable Triceps Pushdown", 50)],
         1: [("Wide-Grip Lat Pulldown", 140), ("Bent-Over Barbell Row", 135), ("Barbell Curl", 65), ("Face Pull", 40)],
         3: [("Barbell Squat", 185), ("Romanian Deadlift", 155), ("Leg Press", 270), ("Standing Calf Raises", 120)],
         4: [("Seated Dumbbell Shoulder Press", 45), ("Dumbbell Lateral Raise", 20), ("Pull-Up", 0), ("Hammer Curls", 30)]}
sets = []
for w in workouts:
    if w["activity"] != "Strength":
        continue
    start = datetime.fromisoformat(w["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(w["end"].replace("Z", "+00:00"))
    wd = start.astimezone(TZ).weekday()
    weeks = (start.astimezone(TZ).date() - LIFT_FROM).days / 7
    for ex, base in SPLIT.get(wd, SPLIT[0]):
        for n in range(1, 4 + (rnd.random() > 0.6)):
            weight = round((base * (1 + 0.012 * weeks)) / 5) * 5 if base else 0
            reps = int(rnd.choice((6, 8, 8, 10, 10, 12)))
            sets.append({"time": isoz(end), "session": "Workout", "exercise": ex, "set": n, "weight": weight,
                         "reps": reps, "est_1rm": round(weight * (1 + reps / 30)) if weight else 0, "set_type": "work"})
post({"data": {"unit": "lb", "sets": sets, "exercises": [], "muscle_groups": []}}, f"{len(sets)} sets")

# ---- food for the last ten weeks ------------------------------------------------------------------------------
FOODS = {"breakfast": [("Greek Yogurt with Berries", 260, 22, 30, 6), ("Scrambled Eggs and Toast", 420, 26, 30, 21),
                       ("Oatmeal with Peanut Butter", 390, 14, 50, 15)],
         "lunch": [("Chicken Burrito Bowl", 720, 48, 78, 22), ("Turkey Sandwich", 520, 34, 52, 17),
                   ("Salmon Salad", 480, 36, 18, 28)],
         "snack": [("Protein Shake", 180, 30, 8, 3), ("Apple and Almonds", 260, 7, 28, 15), ("Protein Bar", 210, 20, 23, 7)],
         "dinner": [("Pasta with Meat Sauce", 760, 38, 92, 24), ("Steak, Rice and Broccoli", 820, 55, 70, 30),
                    ("Stir Fry with Tofu", 610, 30, 64, 24), ("Pizza, two slices", 620, 26, 70, 24)]}
TIMES = {"breakfast": 8.0, "lunch": 12.6, "snack": 15.5, "dinner": 19.0}
food_days = []
for d in days:
    if d < FOOD_FROM or (rnd.random() < 0.18 and d != today):
        continue
    entries = []
    for meal, hour in TIMES.items():
        if meal == "snack" and rnd.random() < 0.4:
            continue
        name, kcal, p, c, f = rnd.choice(FOODS[meal])
        logged = at(d, hour + rnd.gauss(0, 0.5))
        entries.append({"meal": meal, "name": name, "kcal": kcal, "protein_g": p, "carbs_g": c, "fat_g": f,
                        "logged_at": isoz(logged), "nutrients": {"dietary_fiber": round(c * 0.09, 1),
                                                                 "dietary_sodium": round(kcal * 1.3)}})
    food_days.append({"day": d.isoformat(), "entries": entries})
post({"data": {"days": food_days}}, f"{sum(len(x['entries']) for x in food_days)} meals")

moods = [{"time": isoz(at(d, 21)), "kind": "Daily Mood", "valence": round(max(-1, min(1, rnd.gauss(0.3, 0.35))), 2),
          "feeling": rnd.choice(("calm", "content", "tired", "happy", "stressed")), "source": "Marrow"}
         for d in days[-30:] if rnd.random() < 0.6]
post({"scale": {}, "daily": {}, "symptoms": [], "state_of_mind": moods}, f"{len(moods)} mood entries")
print("done. Give the bridge a few seconds to write, then open Grafana.")
