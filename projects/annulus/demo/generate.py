#!/usr/bin/env python3
"""Generate the synthetic demo payload served by `serve.py`.

Nothing here comes from a real person. A seeded random walk produces about
three years of plausible Apple Health style data for a fictional user, feeds
it through the real payload builder (`annulus/overview.py`) via an
in-memory stand-in for InfluxDB, and writes `demo/overview.json`.

    python3 demo/generate.py                 # anchored at 2026-11-16 21:30
    python3 demo/generate.py --today 2027-03-01 --seed 7
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, time as dtime, timedelta, timezone
import json
import math
from pathlib import Path
import random
import re
import sys
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from annulus import overview as ov  # noqa: E402

TZ_OFFSET = 8 * 3600
TZ = timezone(timedelta(seconds=TZ_OFFSET))
SOURCE = 'Demo Watch'

BREAKFASTS = [('燕麦酸奶碗', 420, 22, 55, 12), ('全麦三明治', 380, 20, 42, 14), ('鸡蛋饼配豆浆', 460, 21, 52, 18),
              ('牛奶麦片', 350, 15, 50, 9), ('包子两个 + 茶叶蛋', 480, 22, 60, 16)]
LUNCHES = [('鸡胸肉沙拉', 520, 42, 30, 22), ('牛肉面', 680, 32, 88, 20), ('番茄炒蛋盖饭', 720, 24, 105, 22),
           ('三文鱼饭团套餐', 610, 30, 80, 17), ('黄焖鸡米饭', 780, 38, 92, 26), ('素食 bowl', 560, 22, 78, 16)]
DINNERS = [('清蒸鱼 + 青菜 + 米饭', 640, 40, 70, 18), ('意面配肉酱', 720, 30, 92, 22), ('烤鸡腿 + 土豆泥', 760, 45, 60, 34),
           ('虾仁炒饭', 690, 28, 95, 20), ('火锅（少量）', 900, 48, 60, 50), ('豆腐蔬菜汤 + 杂粮饭', 520, 26, 72, 12)]
SNACKS = [('苹果', 95, 0.5, 25, 0.3), ('拿铁', 190, 10, 15, 9), ('坚果一小把', 170, 5, 6, 15),
          ('蛋白棒', 210, 20, 22, 7), ('香蕉', 105, 1.3, 27, 0.4)]


def iso_noon(d):
    return f'{d.isoformat()}T12:00:00Z'


def utc_iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Persona:
    """Day-by-day synthetic data with seasons, weekly rhythm and slow drifts."""

    def __init__(self, today, now_local, seed, years=3):
        self.rng = random.Random(seed)
        self.today = today
        self.now_local = now_local
        self.start = date(today.year - years, 1, 1)
        self.days = [self.start + timedelta(days=i) for i in range((today - self.start).days + 1)]
        self.daily = defaultdict(dict)       # metric -> day -> {field: value}
        self.samples = []                    # (ts, dur_s, stage)
        self.meals = []                      # pivoted rows
        self.hourly = []                     # pivoted rows
        self.workouts = []                   # pivoted rows
        self._build()

    def _season(self, d):
        return math.cos((d.timetuple().tm_yday - 196) / 365.0 * 2 * math.pi)  # +1 mid-July

    def _build(self):
        r = self.rng
        weight, fitness = 74.5, 0.0
        n = len(self.days)
        for i, d in enumerate(self.days):
            prog = i / max(1, n - 1)
            season = self._season(d)
            weekend = d.weekday() >= 5
            fitness = 0.97 * fitness + 0.03 * r.gauss(0, 1)
            is_today = d == self.today
            frac = 1.0
            if is_today:
                frac = (self.now_local.hour * 60 + self.now_local.minute - 420) / (16 * 60)
                frac = max(0.05, min(1.0, frac))
            if r.random() < 0.015 and not is_today:   # watch left on the charger
                continue

            steps = max(1500, r.gauss(8200 + 1500 * season + (1800 if weekend else 0) + 900 * fitness + 800 * prog, 2300))
            active = max(120, steps * 0.045 + r.gauss(160, 70))
            exercise = max(0, r.gauss(22 + 10 * season + 6 * fitness, 14))
            workout_today = []
            if (d.weekday() in (0, 2, 4) and r.random() < 0.78) or (weekend and r.random() < 0.45):
                kind = r.choices(['traditionalStrengthTraining', 'running', 'cycling', 'yoga', 'hiking'],
                                 [5, 3, 2, 1, 1 + (2 if weekend else 0)])[0]
                mins = {'traditionalStrengthTraining': r.gauss(55, 10), 'running': r.gauss(34, 8),
                        'cycling': r.gauss(48, 12), 'yoga': r.gauss(40, 6), 'hiking': r.gauss(140, 30)}[kind]
                workout_today.append((kind, max(15, mins)))
                exercise += mins * 0.8
                active += mins * (8 if kind != 'yoga' else 3)
            if r.random() < 0.6:
                workout_today.append(('walking', max(15, r.gauss(32, 10))))
            stand = min(16, max(5, round(r.gauss(11.5 + (0.5 if weekend else 0), 1.8))))
            dist = steps * 0.74
            flights = max(0, round(r.gauss(9, 5)))
            rhr = r.gauss(58.5 - 2.5 * prog - 1.0 * fitness + 0.8 * (not weekend), 1.6)
            hrv = max(18, r.gauss(46 + 6 * prog + 3 * fitness, 7))
            vals = {
                'step_count': steps * frac, 'active_energy': active * frac, 'apple_exercise_time': exercise * frac,
                'apple_stand_hour': round(stand * frac), 'apple_stand_time': stand * 6.5 * frac,
                'walking_running_distance': dist * frac, 'flights_climbed': round(flights * frac),
                'basal_energy_burned': 1680 * frac + r.gauss(0, 25),
                'physical_effort': r.gauss(2.3 + exercise / 40, 0.4),
                'resting_heart_rate': rhr, 'heart_rate_variability': hrv,
                'walking_heart_rate_average': rhr + r.gauss(36, 3),
                'walking_speed': max(0.9, r.gauss(1.34 + 0.03 * prog, 0.04)),   # m/s
                'walking_step_length': r.gauss(0.74, 0.015),
                'walking_double_support': r.gauss(27.5, 0.8), 'walking_asymmetry': max(0, r.gauss(1.1, 0.6)),
                'walking_steadiness': min(100, r.gauss(97, 1.5)),
                'time_in_daylight': max(0, r.gauss(38 + 22 * season + (25 if weekend else 0), 15)) * frac,
                'environmental_audio_exposure': r.gauss(66 + (3 if weekend else 0), 3),
                'headphone_audio_exposure': r.gauss(68, 4),
                'wrist_temperature': r.gauss(0.0, 0.25), 'respiratory_rate': r.gauss(14.6, 0.6),
                'blood_oxygen': min(100, r.gauss(97.2, 0.8)),
                'dietary_water': max(600, r.gauss(1900, 380)) * frac,
            }
            if r.random() < 0.08:
                vals['stair_speed_up'] = r.gauss(0.52, 0.04)
                vals['stair_speed_down'] = r.gauss(0.58, 0.05)
            if i % 10 == 0:
                vals['vo2_max'] = 41.5 + 3.0 * prog + r.gauss(0, 0.5)
            if r.random() < 0.05:
                vals['cardio_recovery'] = r.gauss(28, 3)
            if r.random() < 0.02:
                vals['six_minute_walk'] = r.gauss(610, 20)
            # Weight: weekly weigh-ins early on, near daily in the recent year.
            weight += r.gauss(-0.006, 0.03)
            if r.random() < (0.25 if prog < 0.6 else 0.8):
                w = weight + r.gauss(0, 0.35) + 0.4 * season * 0
                vals['body_mass'] = w
                vals['body_fat_percentage'] = r.gauss(19.5 - 2.0 * prog, 0.5)
                vals['lean_body_mass'] = w * (1 - vals['body_fat_percentage'] / 100)
            for metric, v in vals.items():
                self.daily[metric][d.isoformat()] = {'qty': v}
            hr_avg = rhr + r.gauss(18, 3)
            self.daily['heart_rate'][d.isoformat()] = {'qty': hr_avg, 'Min': rhr - r.uniform(4, 8),
                                                     'Max': r.gauss(150 if workout_today else 118, 12)}
            self._sleep(d)
            self._nutrition(d, frac, is_today)
            for kind, mins in workout_today:
                hour = 7 if kind == 'running' else (19 if kind != 'hiking' else 9)
                start = datetime.combine(d, dtime(hour, r.randint(0, 50)), TZ)
                if is_today and start > self.now_local:
                    continue
                self.workouts.append({'_time': utc_iso(start.timestamp()), 'activity': kind, 'source': SOURCE,
                                      'duration_min': round(mins, 1)})
        self._hourly()

    def _sleep(self, d):
        r = self.rng
        weekend_night = d.weekday() in (5, 6)  # woke on Sat/Sun
        bed_min = r.gauss(-42 + (40 if weekend_night else 0), 28)      # minutes from midnight of the wake day
        hours = max(4.6, min(9.4, r.gauss(7.1 + (0.6 if weekend_night else 0), 0.6)))
        awake = max(0.05, r.gauss(0.35, 0.12))
        midnight = datetime.combine(d, dtime(0, 0), TZ)
        bed = midnight + timedelta(minutes=bed_min)
        wake = bed + timedelta(hours=hours + awake)
        deep = hours * r.uniform(0.13, 0.19)
        rem = hours * r.uniform(0.2, 0.26)
        core = hours - deep - rem
        self.daily['sleep_analysis'][d.isoformat()] = {
            'totalSleep': hours, 'core': core, 'deep': deep, 'rem': rem, 'awake': awake,
            'sleepStart_s': bed.timestamp(), 'sleepEnd_s': wake.timestamp(), '_source': SOURCE}
        if (self.today - d).days <= 11:
            t = bed.timestamp()
            end = wake.timestamp()
            cycle = 0
            while t < end - 300:
                plan = ([('core', 18), ('deep', 32 - cycle * 6), ('core', 20), ('rem', 10 + cycle * 6)]
                        if cycle < 4 else [('core', 30), ('rem', 22)])
                for stage, mins in plan:
                    dur = max(3, mins + r.gauss(0, 4)) * 60
                    if stage == 'deep' and mins < 6:
                        continue
                    dur = min(dur, end - t)
                    if dur <= 60:
                        break
                    self.samples.append((t, dur, stage))
                    t += dur
                if r.random() < 0.5 and t < end - 600:
                    dur = r.uniform(2, 9) * 60
                    self.samples.append((t, dur, 'awake'))
                    t += dur
                cycle += 1

    def _nutrition(self, d, frac, is_today):
        r = self.rng
        recent = (self.today - d).days < 120
        if not recent and r.random() < 0.6:
            return  # food logging was patchy before the recent stretch
        plan = [('breakfast', BREAKFASTS, 8, 15), ('lunch', LUNCHES, 12, 20), ('snack', SNACKS, 15, 40),
                ('dinner', DINNERS, 19, 0)]
        if r.random() < 0.5:
            plan.append(('snack', SNACKS, 21, 10))
        totals = defaultdict(float)
        per_meal = defaultdict(float)
        entries = 0
        for idx, (meal, menu, hour, minute) in enumerate(plan):
            when = datetime.combine(d, dtime(hour, minute), TZ) + timedelta(minutes=r.randint(-20, 25))
            if is_today and when > self.now_local:
                continue
            if meal == 'breakfast' and r.random() < 0.08:
                continue
            food, kcal, p, c, f = r.choice(menu)
            k = r.uniform(0.9, 1.15)
            row = {'kcal': kcal * k, 'protein_g': p * k, 'carbs_g': c * k, 'fat_g': f * k}
            for key, v in row.items():
                totals[key] += v
            per_meal[meal] += row['kcal']
            entries += 1
            if (self.today - d).days <= 15:
                self.meals.append({'_time': utc_iso(when.timestamp()), 'idx': str(idx), 'meal': meal,
                                   'day': d.isoformat(), 'food': food, **{k2: round(v, 1) for k2, v in row.items()}})
        if not entries:
            return
        fields = dict(totals)
        fields['entries'] = entries
        for meal, v in per_meal.items():
            fields[meal + '_kcal'] = v
        self.daily['nutrition'][d.isoformat()] = fields

    def _hourly(self):
        r = self.rng
        for back in range(31):
            d = self.today - timedelta(days=back)
            steps_total = (self.daily['step_count'].get(d.isoformat()) or {}).get('qty')
            if steps_total is None:
                continue
            weights = [0.0] * 24
            for h in range(7, 24):
                weights[h] = 0.4 + (2.2 if h in (8, 12, 18) else 0) + (1.0 if 9 <= h <= 20 else 0) + r.random() * 0.8
            total_w = sum(weights)
            for h in range(24):
                ts = datetime.combine(d, dtime(h, 0), TZ)
                if d == self.today and ts + timedelta(hours=1) > self.now_local:
                    break
                asleep = h < 7
                hr = r.gauss(54, 3) if asleep else r.gauss(74 + (12 if h in (8, 19) else 0), 6)
                rows = {
                    'heart_rate': {'value': hr, 'min': hr - r.uniform(4, 12), 'max': hr + r.uniform(8, 40 if not asleep else 10)},
                    'step_count': {'value': steps_total * weights[h] / total_w},
                    'active_energy': {'value': 3 + (steps_total * weights[h] / total_w) * 0.045},
                    'apple_exercise_time': {'value': 0 if asleep else max(0, r.gauss(2 + (14 if h in (8, 19) else 0), 3))},
                    'time_in_daylight': {'value': 0 if (h < 7 or h > 18) else max(0, r.gauss(4 + (8 if h in (12, 13) else 0), 3))},
                }
                if not asleep:
                    rows['environmental_audio_exposure'] = {'value': r.gauss(64, 6)}
                for metric, fields in rows.items():
                    self.hourly.append({'_time': utc_iso(ts.timestamp()), 'metric': metric,
                                        **{k: round(v, 2) for k, v in fields.items()}})


class FakeInflux:
    """Answers exactly the Flux queries Overview.build issues, from a Persona."""

    def __init__(self, persona, sync):
        self.p = persona
        self.sync = sync

    @staticmethod
    def _bounds(flux):
        start = re.search(r'range\(start: ([^,)]+)', flux).group(1).strip()
        stop = re.search(r'stop: ([^)]+)\)', flux)
        return start, (stop.group(1).strip() if stop else None)

    def query(self, flux):
        if 'r._measurement == "sync"' in flux:
            return [dict(self.sync)]
        if 'r._measurement == "daily"' in flux:
            start, stop = self._bounds(flux)
            metrics = set(re.search(r'set: \[([^\]]*)\]', flux).group(1).replace('"', '').split(','))
            rows = []
            for metric, days in self.p.daily.items():
                if metric not in metrics:
                    continue
                for d, fields in days.items():
                    t = iso_noon(date.fromisoformat(d))
                    if t < start or (stop and t >= stop):
                        continue
                    for field, v in fields.items():
                        if field.startswith('_'):
                            continue
                        if stop and field not in ('qty', 'totalSleep'):
                            continue
                        rows.append({'_time': t, '_value': str(v), '_field': field, 'metric': metric,
                                     'source': SOURCE if metric == 'sleep_analysis' else ''})
            return rows
        if 'r._measurement == "sample"' in flux:
            return [{'_time': utc_iso(t), '_value': str(dur), 'stage': st, 'source': SOURCE}
                    for t, dur, st in self.p.samples]
        if 'r._measurement == "meal"' in flux:
            return sorted(self.p.meals, key=lambda m: m['_time'])
        if 'r._measurement == "hourly"' in flux:
            return list(self.p.hourly)
        if 'r._measurement == "workout"' in flux:
            return sorted(self.p.workouts, key=lambda w: w['_time'], reverse=True)
        raise ValueError('unexpected query: ' + flux[:80])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--today', default='2026-11-16', help='local date the demo is anchored to')
    ap.add_argument('--time', default='21:30', help='local time of the snapshot (HH:MM)')
    ap.add_argument('--seed', type=int, default=20261116)
    ap.add_argument('--out', default=str(ROOT / 'demo' / 'overview.json'))
    args = ap.parse_args()

    today = date.fromisoformat(args.today)
    hh, mm = map(int, args.time.split(':'))
    now_local = datetime.combine(today, dtime(hh, mm), TZ)
    now_utc = now_local.astimezone(timezone.utc)
    persona = Persona(today, now_local, args.seed)
    sync = {
        '_time': utc_iso(now_utc.timestamp() - 240),
        'tz_offset_s': str(TZ_OFFSET), 'today': today.isoformat(),
        'last_ingest': (now_local - timedelta(minutes=12)).strftime('%Y-%m-%dT%H:%M:%S'),
        'last_data_day': today.isoformat(), 'total_ms': '1840', 'rsync_ms': '310',
    }

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now_utc if tz else now_utc.replace(tzinfo=None)

    with mock.patch.object(ov, 'datetime', FrozenDatetime):
        payload = ov.Overview(FakeInflux(persona, sync)).build(ov.Overview(FakeInflux(persona, sync))._sync())
    payload['meta']['build_ms'] = 0
    payload['meta']['demo'] = True
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'wrote {args.out} ({Path(args.out).stat().st_size / 1024:.0f} KB, '
          f'{len(persona.days)} days from {persona.start} to {today})')


if __name__ == '__main__':
    main()
