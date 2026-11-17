"""Build the dashboard payload (`GET /api/ui/overview`) from InfluxDB.

In the demo, `demo/generate.py` runs this module against an in-memory stand-in
for InfluxDB, so the fixture has exactly the shape the frontend expects.

One payload serves the whole page across all four time-horizon tabs. It is
rebuilt off the request path when the sync job publishes a new `sync` point,
so browser requests read memory only.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import logging
import math
import statistics
import threading
import time

log = logging.getLogger('annulus')

DEFAULT_TARGETS = {
    'kcal': 2200.0,
    'protein_g': 120.0,
    'fat_g': 70.0,
    'carbs_g': 260.0,
    'steps': 7000.0,
    'sleep_hours': 7.0,
    'exercise_minutes': 30.0,
    'move_kcal': 600.0,
    'stand_hours': 12.0,
    'water_ml': 2000.0,
}

RECENT_METRICS = (
    'step_count', 'active_energy', 'basal_energy_burned', 'apple_exercise_time',
    'apple_stand_hour', 'apple_stand_time', 'walking_running_distance', 'flights_climbed',
    'physical_effort', 'resting_heart_rate', 'heart_rate_variability', 'heart_rate',
    'wrist_temperature', 'respiratory_rate', 'blood_oxygen', 'body_mass',
    'body_fat_percentage', 'lean_body_mass', 'sleep_analysis', 'nutrition',
    'vo2_max', 'cardio_recovery', 'walking_heart_rate_average', 'walking_speed',
    'walking_step_length', 'walking_double_support', 'walking_asymmetry',
    'walking_steadiness', 'stair_speed_up', 'stair_speed_down', 'six_minute_walk',
    'time_in_daylight', 'environmental_audio_exposure', 'headphone_audio_exposure',
    'dietary_water',
)

ARCHIVE_METRICS = (
    'step_count', 'active_energy', 'apple_exercise_time', 'apple_stand_hour',
    'walking_running_distance', 'flights_climbed', 'resting_heart_rate',
    'heart_rate_variability', 'body_mass', 'sleep_analysis', 'vo2_max',
    'walking_speed', 'environmental_audio_exposure',
)

MONTHLY_FIELDS = {
    'step_count': ('qty', 1.0, 0),
    'active_energy': ('qty', 1.0, 0),
    'apple_exercise_time': ('qty', 1.0, 1),
    'resting_heart_rate': ('qty', 1.0, 1),
    'heart_rate_variability': ('qty', 1.0, 1),
    'body_mass': ('qty', 1.0, 2),
    'sleep_analysis': ('totalSleep', 1.0, 2),
    'vo2_max': ('qty', 1.0, 1),
    'walking_speed': ('qty', 3.6, 2),
    'environmental_audio_exposure': ('qty', 1.0, 1),
}

HOURLY_METRICS = (
    'heart_rate', 'step_count', 'active_energy', 'apple_exercise_time',
    'time_in_daylight', 'environmental_audio_exposure',
)

MEALS = ('breakfast', 'lunch', 'dinner', 'snack')

SPOTLIGHT_SPECS = (
    ('steps', '日均步数', '步', 'higher'),
    ('active_energy', '活动消耗', '千卡', 'higher'),
    ('exercise', '锻炼时长', '分钟', 'higher'),
    ('sleep_hours', '睡眠时长', '小时', 'higher'),
    ('resting_hr', '静息心率', '次/分', 'lower'),
    ('hrv', '心率变异性', '毫秒', 'higher'),
    ('weight', '体重', '公斤', 'neutral'),
    ('walking_speed', '步行速度', '公里/时', 'higher'),
    ('daylight', '户外日照', '分钟', 'higher'),
    ('vo2max', 'VO₂max', '', 'higher'),
)

VITAL_SPECS = (
    ('resting_hr', '静息心率', 'bpm', 'lower'),
    ('hrv', '心率变异性', 'ms', 'higher'),
    ('wrist_temp', '夜间腕温', '°C', 'neutral'),
    ('respiratory_rate', '呼吸频率', '次/分', 'neutral'),
    ('blood_oxygen', '血氧饱和度', '%', 'higher'),
)


def _f(value):
    try:
        v = float(value)
        return round(v, 3) if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _r(value, decimals=2):
    if value is None:
        return None
    if decimals == 0:
        return int(round(value))
    return round(value, decimals)


def _set(values):
    return '[' + ','.join(f'"{v}"' for v in values) + ']'


def _quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def _parse_iso(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


class Overview:
    TTL = 60

    def __init__(self, influx):
        self.influx = influx
        self.lock = threading.Lock()
        self.payload = None
        self.version = None
        self.checked = 0.0
        self.refreshing = False

    # -- public
    def get(self):
        now = time.monotonic()
        with self.lock:
            payload, stale = self.payload, now - self.checked > self.TTL
            if payload is not None and stale and not self.refreshing:
                self.refreshing = True
                threading.Thread(target=self._refresh, daemon=True, name='overview-refresh').start()
        if payload is None:
            self._refresh(force=True)
            with self.lock:
                payload = self.payload
        return payload

    def warm(self):
        threading.Thread(target=self._refresh, kwargs={'force': True}, daemon=True,
                         name='overview-warm').start()

    # -- build
    def _refresh(self, force=False):
        try:
            sync = self._sync()
            version = sync.get('at')
            if force or version != self.version or self.payload is None:
                started = time.perf_counter()
                payload = self.build(sync)
                payload['meta']['build_ms'] = round((time.perf_counter() - started) * 1000)
                with self.lock:
                    self.payload, self.version = payload, version
                log.info('overview rebuilt build_ms=%s', payload['meta']['build_ms'])
        except Exception as error:  # keep serving the last good payload
            log.error('overview refresh failed type=%s', type(error).__name__)
            if self.payload is None:
                raise
        finally:
            with self.lock:
                self.checked = time.monotonic()
                self.refreshing = False

    def _q(self, flux):
        return self.influx.query('from(bucket: "health") ' + flux)

    def _sync(self):
        rows = self._q('|> range(start: -30d) |> filter(fn: (r) => r._measurement == "sync") '
                       '|> last() |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")')
        if not rows:
            return {}
        row = rows[0]
        out = {'at': row.get('_time')}
        for k, v in row.items():
            if k.startswith('_') or k in ('result', 'table', ''):
                continue
            out[k] = _f(v) if k not in ('last_ingest', 'last_data_day', 'today') else v
        return out

    def build(self, sync):
        offset = int(sync.get('tz_offset_s') or 28800)
        tz = timezone(timedelta(seconds=offset))
        now_utc = datetime.now(timezone.utc)
        today = sync.get('today') or now_utc.astimezone(tz).strftime('%Y-%m-%d')
        today_date = date.fromisoformat(today)

        targets = dict(DEFAULT_TARGETS)
        for k in DEFAULT_TARGETS:
            val = sync.get('target_' + k)
            if isinstance(val, (int, float)) and val > 0:
                targets[k] = float(val)
        if isinstance(sync.get('target_active_energy'), (int, float)) and sync['target_active_energy'] > 0:
            targets['move_kcal'] = float(sync['target_active_energy'])

        cutoff_dt = now_utc - timedelta(days=400)
        cutoff_iso = cutoff_dt.strftime('%Y-%m-%dT%H:%M:%SZ')

        # 1. Recent 400 days of daily measurements.
        daily_recent = defaultdict(dict)
        for r in self._q(
            f'|> range(start: {cutoff_iso}) '
            f'|> filter(fn: (r) => r._measurement == "daily" and contains(value: r.metric, set: {_set(RECENT_METRICS)})) '
            '|> keep(columns: ["_time", "_value", "_field", "metric", "source"])'
        ):
            day = r['_time'][:10]
            slot = daily_recent[r['metric']].setdefault(day, {})
            val = _f(r['_value'])
            if val is not None:
                slot[r['_field']] = val
            if r.get('source') and r['metric'] == 'sleep_analysis':
                slot['_source'] = r['source']

        def series(metric, field='qty', days=400, scale=1.0, decimals=2):
            floor = (today_date - timedelta(days=days - 1)).isoformat() if days else '0000-01-01'
            out = []
            for d, fields in sorted(daily_recent.get(metric, {}).items()):
                if d < floor:
                    continue
                v = fields.get(field)
                if v is not None:
                    out.append([d, _r(v * scale, decimals)])
            return out

        daily_out = {
            'steps': series('step_count', decimals=0),
            'active_energy': series('active_energy', decimals=0),
            'basal_energy': series('basal_energy_burned', decimals=0),
            'exercise': series('apple_exercise_time', decimals=0),
            'stand_hour': series('apple_stand_hour', decimals=0),
            'stand_time': series('apple_stand_time', decimals=0),
            'distance': series('walking_running_distance', scale=0.001, decimals=2),
            'flights': series('flights_climbed', decimals=0),
            'physical_effort': series('physical_effort', decimals=2),
            'resting_hr': series('resting_heart_rate', decimals=1),
            'hrv': series('heart_rate_variability', decimals=1),
            'wrist_temp': series('wrist_temperature', decimals=2),
            'respiratory_rate': series('respiratory_rate', decimals=1),
            'blood_oxygen': series('blood_oxygen', decimals=1),
            'weight': series('body_mass', decimals=2),
            'body_fat': series('body_fat_percentage', decimals=1),
            'lean_mass': series('lean_body_mass', decimals=2),
            'vo2max': series('vo2_max', decimals=1),
            'cardio_recovery': series('cardio_recovery', decimals=1),
            'walking_hr': series('walking_heart_rate_average', decimals=1),
            'walking_speed': series('walking_speed', scale=3.6, decimals=2),
            'walking_step_length': series('walking_step_length', scale=100.0, decimals=1),
            'walking_double_support': series('walking_double_support', decimals=1),
            'walking_asymmetry': series('walking_asymmetry', decimals=2),
            'walking_steadiness': series('walking_steadiness', decimals=1),
            'stair_speed_up': series('stair_speed_up', decimals=2),
            'stair_speed_down': series('stair_speed_down', decimals=2),
            'six_minute_walk': series('six_minute_walk', decimals=0),
            'daylight': series('time_in_daylight', decimals=0),
            'env_audio': series('environmental_audio_exposure', decimals=1),
            'headphone_audio': series('headphone_audio_exposure', decimals=1),
            'water_ml': series('dietary_water', days=120, decimals=0),
            'heart_rate': [
                [d, _r(v.get('Min'), 1), _r(v.get('qty'), 1), _r(v.get('Max'), 1)]
                for d, v in sorted(daily_recent.get('heart_rate', {}).items())[-120:]
                if v.get('qty') is not None
            ],
        }

        # 2. Sleep nights (last 60) + raw sleep stage segments (last 10 nights).
        sleep_samples = defaultdict(list)
        for r in self._q(
            '|> range(start: -12d) '
            '|> filter(fn: (r) => r._measurement == "sample" and r.metric == "sleep_analysis" and r._field == "dur_s") '
            '|> keep(columns: ["_time", "_value", "stage", "source"])'
        ):
            stage = r.get('stage')
            dur_s = _f(r.get('_value'))
            if not stage or dur_s is None or dur_s <= 0:
                continue
            start_s = int(_parse_iso(r['_time']).timestamp())
            sleep_samples[r.get('source') or ''].append((start_s, int(round(start_s + dur_s)), stage))

        sleep = []
        recent_sleep = sorted(daily_recent.get('sleep_analysis', {}).items())[-60:]
        for idx, (d, v) in enumerate(recent_sleep):
            if v.get('totalSleep') is None:
                continue
            item = {'night': d, 'hours': round(v['totalSleep'], 2)}
            for stage in ('core', 'deep', 'rem', 'awake', 'asleep'):
                if v.get(stage) is not None:
                    item[stage] = round(v[stage], 2)
            bed_s = v.get('sleepStart_s')
            wake_s = v.get('sleepEnd_s')
            midnight = datetime.strptime(d, '%Y-%m-%d').replace(tzinfo=tz)
            if bed_s:
                bed_dt = datetime.fromtimestamp(bed_s, tz)
                item['bed'] = bed_dt.strftime('%H:%M')
                item['bed_min'] = int(round((bed_dt - midnight).total_seconds() / 60))
            if wake_s:
                wake_dt = datetime.fromtimestamp(wake_s, tz)
                item['wake'] = wake_dt.strftime('%H:%M')
                item['wake_min'] = int(round((wake_dt - midnight).total_seconds() / 60))
            if idx >= len(recent_sleep) - 10 and bed_s and wake_s:
                src = v.get('_source') or ''
                pool = sleep_samples.get(src) or [s for segs in sleep_samples.values() for s in segs]
                segs = sorted(
                    ([s0, s1, st] for s0, s1, st in pool if s0 < wake_s + 1200 and s1 > bed_s - 1200),
                    key=lambda x: x[0],
                )
                if segs:
                    item['segments'] = segs
            sleep.append(item)

        # 3. Nutrition (400d daily) + itemized meals (14d).
        nutrition = []
        for d, v in sorted(daily_recent.get('nutrition', {}).items()):
            if v.get('kcal') is None and v.get('protein_g') is None:
                continue
            nutrition.append({
                'day': d,
                'kcal': _r(v.get('kcal'), 0),
                'protein_g': _r(v.get('protein_g'), 1),
                'carbs_g': _r(v.get('carbs_g'), 1),
                'fat_g': _r(v.get('fat_g'), 1),
                'entries': _r(v.get('entries'), 0),
                'meals': {m: _r(v.get(m + '_kcal'), 0) for m in MEALS if v.get(m + '_kcal')},
            })

        meals_by_day = defaultdict(list)
        for r in self._q(
            '|> range(start: -15d) |> filter(fn: (r) => r._measurement == "meal") '
            '|> pivot(rowKey: ["_time", "idx", "meal", "day"], columnKey: ["_field"], valueColumn: "_value") '
            '|> group() |> sort(columns: ["_time"])'
        ):
            day_k = r.get('day') or ''
            if not day_k:
                continue
            t = _parse_iso(r['_time']).astimezone(tz)
            meals_by_day[day_k].append({
                'meal': r.get('meal') or 'other',
                'food': r.get('food') or '',
                'kcal': _r(_f(r.get('kcal')), 0),
                'protein_g': _r(_f(r.get('protein_g')), 1),
                'carbs_g': _r(_f(r.get('carbs_g')), 1),
                'fat_g': _r(_f(r.get('fat_g')), 1),
                't': t.strftime('%H:%M'),
            })
        meals_by_day = dict(sorted(meals_by_day.items())[-14:])

        # 4. Hourly intraday (last 7d) + 30d 24-hour circadian profile.
        hourly_all = defaultdict(list)
        circ_buckets = {h: defaultdict(list) for h in range(24)}
        for r in self._q(
            f'|> range(start: -30d) |> filter(fn: (r) => r._measurement == "hourly" and '
            f'contains(value: r.metric, set: {_set(HOURLY_METRICS)})) '
            '|> pivot(rowKey: ["_time", "metric"], columnKey: ["_field"], valueColumn: "_value")'
        ):
            metric = r.get('metric')
            val = _f(r.get('value'))
            if not metric or val is None:
                continue
            t = _parse_iso(r['_time']).astimezone(tz)
            item = {'t': t.strftime('%Y-%m-%d %H:00'), 'v': _r(val, 1)}
            if metric == 'heart_rate':
                item['lo'] = _r(_f(r.get('min')), 0)
                item['hi'] = _r(_f(r.get('max')), 0)
            hourly_all[metric].append(item)
            circ_buckets[t.hour][metric].append(val)

        hourly_floor = (today_date - timedelta(days=7)).isoformat()
        hourly = {}
        for metric, items in hourly_all.items():
            items.sort(key=lambda x: x['t'])
            recent_items = [it for it in items if it['t'][:10] >= hourly_floor]
            hourly[metric] = recent_items[-168:] if recent_items else items[-48:]

        # Cumulative metrics (steps, energy, daylight) average over every day in the
        # window, so an hour with no record counts as zero rather than being skipped.
        # Level metrics (heart rate, audio) average only the hours that were measured.
        circ_days = len({
            it['t'][:10] for metric in ('step_count', 'active_energy', 'heart_rate')
            for it in hourly_all.get(metric, [])
        }) or 1

        def per_day(vals, decimals):
            return _r(sum(vals) / circ_days, decimals) if vals else None

        def per_record(vals, decimals):
            return _r(sum(vals) / len(vals), decimals) if vals else None

        circadian = []
        for h in range(24):
            b = circ_buckets[h]
            circadian.append({
                'h': h,
                'hr': per_record(b['heart_rate'], 1),
                'steps': per_day(b['step_count'], 0),
                'kcal': per_day(b['active_energy'], 1),
                'daylight': per_day(b['time_in_daylight'], 1),
                'audio': per_record(b['environmental_audio_exposure'], 1),
            })

        # 5. Vitals 30-day personal baselines (P15 / P50 / P85).
        vitals = self._build_vitals(daily_out)

        # 6. Automated 30d vs prior-90d trend spotlights.
        sleep_series = [[s['night'], s['hours']] for s in sleep]
        spotlights = self._build_spotlights({**daily_out, 'sleep_hours': sleep_series}, today_date)

        # 7. All-time historical daily (2019-01-01 to cutoff_iso) + workouts.
        all_daily = defaultdict(dict)
        for metric in ARCHIVE_METRICS:
            for d, fields in daily_recent.get(metric, {}).items():
                all_daily[metric][d] = dict(fields)

        for r in self._q(
            f'|> range(start: 2019-01-01T00:00:00Z, stop: {cutoff_iso}) '
            f'|> filter(fn: (r) => r._measurement == "daily" and '
            f'contains(value: r.metric, set: {_set(ARCHIVE_METRICS)}) and '
            '(r._field == "qty" or r._field == "totalSleep")) '
            '|> keep(columns: ["_time", "_value", "_field", "metric"])'
        ):
            metric = r['metric']
            field = r['_field']
            if (metric == 'sleep_analysis') != (field == 'totalSleep'):
                continue
            val = _f(r['_value'])
            if val is not None:
                all_daily[metric][r['_time'][:10]] = {field: val}

        # All-time workouts (one query).
        recent_workouts = []
        workouts_by_year = defaultdict(lambda: defaultdict(lambda: [0, 0.0]))
        total_workouts = 0
        total_workout_min = 0.0
        longest_workout = None
        workout_cutoff_day = (today_date - timedelta(days=400)).isoformat()

        for r in self._q(
            '|> range(start: 2019-01-01T00:00:00Z) |> filter(fn: (r) => r._measurement == "workout") '
            '|> pivot(rowKey: ["_time", "activity", "source"], columnKey: ["_field"], valueColumn: "_value") '
            '|> group() |> sort(columns: ["_time"], desc: true)'
        ):
            mins = _f(r.get('duration_min'))
            if mins is None or mins <= 0:
                continue
            t = _parse_iso(r['_time']).astimezone(tz)
            day_s = t.strftime('%Y-%m-%d')
            yr = day_s[:4]
            act = r.get('activity') or 'Workout'
            total_workouts += 1
            total_workout_min += mins
            bucket = workouts_by_year[yr][act]
            bucket[0] += 1
            bucket[1] += mins
            if longest_workout is None or mins > longest_workout[1]:
                longest_workout = [day_s, _r(mins, 0), act]
            if day_s >= workout_cutoff_day and len(recent_workouts) < 80:
                recent_workouts.append({
                    'start': t.strftime('%Y-%m-%d %H:%M'),
                    'day': day_s,
                    'activity': act,
                    'minutes': _r(mins, 0),
                })

        workouts_by_year_out = {
            yr: {act: [cnt, _r(mval, 0)] for act, (cnt, mval) in sorted(acts.items(), key=lambda kv: -kv[1][1])}
            for yr, acts in sorted(workouts_by_year.items())
        }

        monthly, archive_years, lifetime = self._build_archive(
            all_daily, targets, total_workouts, total_workout_min, longest_workout
        )

        return {
            'meta': {
                'snapshot_at': sync.get('at'),
                'last_ingest': sync.get('last_ingest'),
                'last_data_day': sync.get('last_data_day'),
                'today': today,
                'tz_offset_s': offset,
                'sync_ms': sync.get('total_ms'),
                'rsync_ms': sync.get('rsync_ms'),
            },
            'targets': targets,
            'daily': daily_out,
            'sleep': sleep,
            'nutrition': nutrition,
            'meals_by_day': meals_by_day,
            'meals_today': meals_by_day.get(today, []),
            'hourly': hourly,
            'circadian': circadian,
            'vitals': vitals,
            'spotlights': spotlights,
            'workouts': recent_workouts,
            'workouts_by_year': workouts_by_year_out,
            'monthly': monthly,
            'archive_years': archive_years,
            'lifetime': lifetime,
        }

    @staticmethod
    def _build_vitals(daily_out):
        vitals = {}
        for key, label, unit, polarity in VITAL_SPECS:
            pts = daily_out.get(key) or []
            if not pts:
                continue
            latest_day, latest_val = pts[-1]
            anchor = date.fromisoformat(latest_day)
            floor = (anchor - timedelta(days=29)).isoformat()
            win = sorted(v for d, v in pts if floor <= d <= latest_day and v is not None)
            if len(win) < 3:
                win = sorted(v for _, v in pts[-30:] if v is not None)
            p15 = _quantile(win, 0.15)
            p50 = _quantile(win, 0.50)
            p85 = _quantile(win, 0.85)
            sd = statistics.stdev(win) if len(win) >= 2 else 0.0
            status = 'typical'
            if p15 is not None and p85 is not None:
                if latest_val > p85:
                    status = 'high'
                elif latest_val < p15:
                    status = 'low'
            vitals[key] = {
                'label': label,
                'unit': unit,
                'polarity': polarity,
                'latest_day': latest_day,
                'latest': _r(latest_val, 2),
                'p15': _r(p15, 2),
                'p50': _r(p50, 2),
                'p85': _r(p85, 2),
                'sd': _r(sd, 2),
                'delta': _r(latest_val - p50, 2) if p50 is not None else None,
                'status': status,
            }
        return vitals

    @staticmethod
    def _build_spotlights(series_map, today_date):
        out = []
        for key, label, unit, polarity in SPOTLIGHT_SPECS:
            pts = series_map.get(key) or []
            if len(pts) < 12:
                continue
            anchor = min(today_date, date.fromisoformat(pts[-1][0]))
            rec_floor = (anchor - timedelta(days=29)).isoformat()
            base_floor = (anchor - timedelta(days=119)).isoformat()
            recent = [v for d, v in pts if rec_floor <= d <= anchor.isoformat() and v is not None]
            base = [v for d, v in pts if base_floor <= d < rec_floor and v is not None]
            min_rec = 3 if key == 'vo2max' else 7
            min_base = 4 if key == 'vo2max' else 12
            if len(recent) < min_rec or len(base) < min_base:
                continue
            avg_r = sum(recent) / len(recent)
            avg_b = sum(base) / len(base)
            delta = avg_r - avg_b
            sd_b = statistics.stdev(base) if len(base) >= 2 else 0.0
            if sd_b < 1e-6:
                sd_b = max(abs(avg_b) * 0.05, 1e-3)
            z = delta / sd_b
            pct = (delta / avg_b * 100.0) if avg_b else 0.0
            spark = [[d, v] for d, v in pts if base_floor <= d <= anchor.isoformat()]
            out.append({
                'key': key,
                'label': label,
                'unit': unit,
                'polarity': polarity,
                'avg_recent': _r(avg_r, 2),
                'avg_base': _r(avg_b, 2),
                'delta': _r(delta, 2),
                'pct': _r(pct, 1),
                'z_score': _r(z, 2),
                'n_recent': len(recent),
                'n_base': len(base),
                'spark': spark,
            })
        out.sort(key=lambda x: abs(x['z_score']), reverse=True)
        return out

    @staticmethod
    def _build_archive(all_daily, targets, total_workouts, total_workout_min, longest_workout):
        # Monthly averages across all years.
        monthly = {}
        for metric, (field, scale, decimals) in MONTHLY_FIELDS.items():
            by_month = defaultdict(list)
            for d, fields in all_daily.get(metric, {}).items():
                v = fields.get(field)
                if v is not None:
                    by_month[d[:7]].append(v * scale)
            monthly[metric] = [
                [m, _r(sum(vals) / len(vals), decimals)]
                for m, vals in sorted(by_month.items())
            ]

        # Collect every known day across tracked archive metrics.
        all_days = sorted({
            d
            for metric in ('step_count', 'active_energy', 'apple_exercise_time', 'apple_stand_hour',
                           'walking_running_distance', 'sleep_analysis', 'resting_heart_rate',
                           'heart_rate_variability', 'vo2_max')
            for d in all_daily.get(metric, {})
        })

        def get_qty(metric, d, field='qty'):
            return all_daily.get(metric, {}).get(d, {}).get(field)

        archive_years = defaultdict(list)
        perfect_days = 0
        move_streak = 0
        longest_move_streak = 0
        prev_move_day = None
        move_target = targets['move_kcal']
        ex_target = targets['exercise_minutes']
        stand_target = targets['stand_hours']

        for d in all_days:
            kcal = get_qty('active_energy', d)
            steps = get_qty('step_count', d)
            ex = get_qty('apple_exercise_time', d)
            stand = get_qty('apple_stand_hour', d)
            slp = get_qty('sleep_analysis', d, 'totalSleep')
            if any(v is not None for v in (kcal, steps, ex, stand, slp)):
                archive_years[d[:4]].append([
                    d[5:],
                    _r(kcal, 0),
                    _r(steps, 0),
                    _r(ex, 0),
                    _r(stand, 0),
                    _r(slp, 1),
                ])
            if kcal is not None and kcal >= move_target:
                cur_date = date.fromisoformat(d)
                if prev_move_day and (cur_date - prev_move_day).days == 1:
                    move_streak += 1
                else:
                    move_streak = 1
                prev_move_day = cur_date
                if move_streak > longest_move_streak:
                    longest_move_streak = move_streak
                if (ex is not None and ex >= ex_target) and (stand is not None and stand >= stand_target):
                    perfect_days += 1

        def total_sum(metric, scale=1.0):
            return sum((f.get('qty') or 0.0) for f in all_daily.get(metric, {}).values()) * scale

        def extreme(metric, fn, field='qty', scale=1.0, decimals=0):
            items = [
                (d, f.get(field) * scale)
                for d, f in all_daily.get(metric, {}).items()
                if f.get(field) is not None and f.get(field) > 0
            ]
            if not items:
                return None
            best_d, best_v = fn(items, key=lambda kv: kv[1])
            return [best_d, _r(best_v, decimals)]

        lifetime = {
            'first_day': all_days[0] if all_days else None,
            'tracked_days': len(all_days),
            'total_steps': _r(total_sum('step_count'), 0),
            'total_distance_km': _r(total_sum('walking_running_distance', 0.001), 0),
            'total_active_kcal': _r(total_sum('active_energy'), 0),
            'total_exercise_hours': _r(total_sum('apple_exercise_time', 1.0 / 60.0), 0),
            'total_flights': _r(total_sum('flights_climbed'), 0),
            'total_workouts': total_workouts,
            'total_workout_hours': _r(total_workout_min / 60.0, 0),
            'perfect_ring_days': perfect_days,
            'longest_move_streak': longest_move_streak,
            'records': {
                'max_steps': extreme('step_count', max, decimals=0),
                'max_distance_km': extreme('walking_running_distance', max, scale=0.001, decimals=1),
                'max_active_kcal': extreme('active_energy', max, decimals=0),
                'max_exercise_min': extreme('apple_exercise_time', max, decimals=0),
                'longest_workout': longest_workout,
                'min_rhr': extreme('resting_heart_rate', min, decimals=1),
                'max_hrv': extreme('heart_rate_variability', max, decimals=1),
                'max_vo2max': extreme('vo2_max', max, decimals=1),
            },
        }
        return monthly, dict(sorted(archive_years.items())), lifetime
