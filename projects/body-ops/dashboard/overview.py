"""Body Ops: every kind of data Marrow's automations send, on one Grafana
dashboard. Run `python3 overview.py` to regenerate
../grafana/dashboards/body-ops.json after editing."""
from dash_lib import *

b = Board("body-ops", "Body Ops", time_from="now-30d")
b.add(text("## Body Ops\nHeart, sleep, movement, food, lifting and surroundings, in one place."), 0, 24, 3, newline=True)

# ---- today ------------------------------------------------------------------------
b.row("Today, against my normal")
b.add(stat("Sleep last night", daily("sleep_analysis", "totalSleep"), "suffix: h", VIOLET), 0, 4, 5)
b.add(stat("HRV", daily("heart_rate_variability"), "suffix: ms", TEAL, 0), 4, 4, 5)
b.add(stat("Resting heart rate", daily("resting_heart_rate"), "suffix: bpm", CORAL, 0), 8, 4, 5)
b.add(stat("Steps today", daily("step_count"), "none", BLUE, 0), 12, 4, 5)
b.add(stat("Protein today", flux(f'''from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "meal" and r._field == "protein_g")
  |> group() |> aggregateWindow(every: 1d, fn: sum, createEmpty: true) |> fill(value: 0.0)'''), "massg", AMBER, 0),
      16, 4, 5)
b.add(stat("Daylight today", daily("time_in_daylight"), "suffix: min", GREEN, 0), 20, 4, 5, newline=True)

# ---- last 48 hours ------------------------------------------------------------------
b.row("The last 48 hours")
hr = flux(f'''from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "sample" and r.metric == "heart_rate" and r._field == "value")
  |> group() |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)''')
b.add(series("Heart rate", [target(hr)], "suffix: bpm", fill=18, time_from="48h",
             over=[by_ref("A", "Heart rate", CORAL)], legend=False), 0, 24, 8, newline=True)
END = "date.add(d: duration(v: int(v: {secs} * 1000000000.0) - 1), to: r._time)"
tl = flux(f'''sl = from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "sample" and r.metric == "sleep_analysis" and r._field == "dur_s")
  |> filter(fn: (r) => r.stage == "rem" or r.stage == "core" or r.stage == "deep" or r.stage == "awake") |> group()
wk = from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "workout" and r._field == "duration_min") |> group()
union(tables: [
  sl |> map(fn: (r) => ({{_time: r._time, row: "Sleep", _value: if r.stage == "rem" then "REM" else if r.stage == "core" then "Core" else if r.stage == "deep" then "Deep" else "Awake"}})),
  sl |> map(fn: (r) => ({{_time: {END.format(secs="r._value")}, row: "Sleep", _value: "-"}})),
  wk |> map(fn: (r) => ({{_time: r._time, row: "Workout", _value: r.activity}})),
  wk |> map(fn: (r) => ({{_time: {END.format(secs="r._value * 60.0")}, row: "Workout", _value: "-"}}))])
  |> group(columns: ["row"]) |> sort(columns: ["_time"])''')
STATES = {**STAGE, "Meal": GREEN, "Running": CORAL, "Strength": CORAL, "Cycling": CORAL, "Walking": CORAL}
# No food row: a meal's time is Marrow's default for its slot (breakfast 8 am,
# lunch noon, dinner 6 pm) unless it was logged as it was eaten, so meals
# would sit inside sleep and workouts that they never overlapped.
b.add({"type": "state-timeline", "title": "Sleep and workouts", "targets": [target(tl)], "timeFrom": "48h",
       "fieldConfig": {"defaults": {"color": color(GREY), "custom": {"fillOpacity": 85, "lineWidth": 0},
                                    "mappings": [{"type": "value", "options": {"-": {"color": "transparent", "text": " ",
                                                                                     "index": 99}}}] +
                                    [{"type": "value", "options": {k: {"color": c, "index": i}}}
                                     for i, (k, c) in enumerate(STATES.items())]}, "overrides": []},
       "options": {"showValue": "never", "mergeValues": True, "rowHeight": 0.8, "legend": {"showLegend": False},
                   "tooltip": {"mode": "single"}}}, 0, 24, 5, newline=True)

# ---- the year (the watch has all of it) ------------------------------------------------------
b.row("The year")
heat = flux('''from(bucket: "health") |> range(start: -365d)
  |> filter(fn: (r) => r._measurement == "sample" and r.metric == "heart_rate" and r._field == "value")
  |> group() |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
  |> map(fn: (r) => ({_time: date.truncate(t: r._time, unit: 1d), _value: r._value,
                      hour: if date.hour(t: r._time) < 10 then "0" + string(v: date.hour(t: r._time)) else string(v: date.hour(t: r._time))}))
  |> group(columns: ["hour"]) |> aggregateWindow(every: 1d, fn: mean, createEmpty: false)
  |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: r.hour})) |> group(columns: ["_field"])''')
b.add({"type": "heatmap", "title": "Heart rate by hour of day, every day for a year", "timeFrom": "365d",
       "description": "Each column is a day, each row an hour (midnight at the bottom). Brighter is faster.",
       "targets": [target(heat)], "fieldConfig": {"defaults": {"unit": "suffix: bpm"}, "overrides": []},
       "options": {"calculate": False, "rowsFrame": {"layout": "unknown"}, "cellGap": 0,
                   "yAxis": {"axisPlacement": "left", "reverse": False, "axisLabel": "Hour"},
                   "color": {"mode": "scheme", "scheme": "Magma", "steps": 64, "exponent": 0.5, "reverse": False,
                             "min": 45, "max": 120},
                   "legend": {"show": True}, "tooltip": {"mode": "single", "yHistogram": False},
                   "exemplars": {"color": "transparent"}}}, 0, 24, 10, newline=True)
st = flux(f'''from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "daily" and r.metric == "sleep_analysis")
  |> filter(fn: (r) => r._field == "deep" or r._field == "core" or r._field == "rem" or r._field == "awake")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> keep(columns: ["_time", "deep", "core", "rem", "awake"])''')
p = series("Sleep stages per night", [target(st)], "suffix: h", draw="bars", stack=True, fill=92, time_from="365d",
           over=[by_name(f, c, n) for f, n, c in (("deep", "Deep", VIOLET), ("core", "Core", BLUE),
                                                  ("rem", "REM", TEAL), ("awake", "Awake", AMBER))])
p["transformations"] = [{"id": "organize", "options": {"indexByName": {"_time": 0, "deep": 1, "core": 2, "rem": 3,
                                                                       "awake": 4}}}]
b.add(p, 0, 12, 9)
b.add(clock_panel("When I fell asleep and woke up", time_from="365d"), 12, 12, 9, newline=True)
avg7 = "\n  |> timedMovingAverage(every: 1d, period: 7d)"
b.add(series("Resting heart rate and HRV, 7 day averages",
             [target(daily("resting_heart_rate") + avg7, "A"), target(daily("heart_rate_variability") + avg7, "B")],
             time_from="365d", over=[by_ref("A", "Resting heart rate (bpm)", CORAL),
                                     by_ref("B", "HRV (ms)", TEAL, [{"id": "custom.axisPlacement", "value": "right"}])]),
      0, 12, 8)
steps = daily("step_count")
b.add(series("Steps per day", [target(steps, "A"), target(steps + "\n  |> timedMovingAverage(every: 1d, period: 7d)", "B")],
             time_from="365d", over=[by_ref("A", "Steps", BLUE, [{"id": "custom.drawStyle", "value": "bars"},
                                                                 {"id": "custom.fillOpacity", "value": 60},
                                                                 {"id": "custom.lineWidth", "value": 0}]),
                                     by_ref("B", "7 day average", AMBER)]), 12, 12, 8, newline=True)
b.add(series("Exercise minutes per day", [target(daily("apple_exercise_time"))], "suffix: min", draw="bars", fill=70,
             time_from="365d", over=[by_ref("A", "Exercise", GREEN)], legend=False), 0, 8, 8)
b.add(series("Active calories per day", [target(daily("active_energy"))], "suffix: kcal", draw="bars", fill=70,
             time_from="365d", over=[by_ref("A", "Active calories", CORAL)], legend=False,
             desc="Energy burned through movement, from the watch."), 8, 8, 8)
temp = series("Wrist temperature at night", [target(daily("wrist_temperature"))], "celsius", time_from="365d",
              over=[by_ref("A", "Wrist temperature", AMBER)], legend=False, decimals=1, minv=34.5, maxv=37.5)
b.add(temp, 16, 8, 8, newline=True)

# ---- food (logged since mid August) ---------------------------------------------------------------
b.row("Food")
macros = flux(f'''from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "meal" and (r._field == "protein_g" or r._field == "carbs_g" or r._field == "fat_g"))
  |> group(columns: ["_field"]) |> aggregateWindow(every: 1d, fn: sum, createEmpty: false)
  |> map(fn: (r) => ({{r with _value: if r._field == "fat_g" then r._value * 9.0 else r._value * 4.0}}))''')
b.add(series("Calories per day, by macro", [target(macros)], "suffix: kcal", draw="bars", stack=True, fill=92,
             time_from="75d", over=[by_name(n, c, d) for n, d, c in (("protein_g", "Protein", TEAL),
                                                                    ("carbs_g", "Carbs", AMBER), ("fat_g", "Fat", VIOLET))]),
      0, 12, 9)
split = flux('''from(bucket: "health") |> range(start: -75d)
  |> filter(fn: (r) => r._measurement == "meal" and (r._field == "protein_g" or r._field == "carbs_g" or r._field == "fat_g"))
  |> group(columns: ["_field"]) |> sum() |> group()
  |> map(fn: (r) => ({_field: if r._field == "protein_g" then "Protein" else if r._field == "carbs_g" then "Carbs" else "Fat",
                      _value: if r._field == "fat_g" then r._value * 9.0 else r._value * 4.0}))''')
b.add({"type": "piechart", "title": "Where my calories come from", "targets": [target(split)],
       "transformations": [rows_to_fields()],
       "fieldConfig": {"defaults": {"unit": "suffix: kcal", "decimals": 0},
                       "overrides": [by_name("Protein", TEAL), by_name("Carbs", AMBER), by_name("Fat", VIOLET)]},
       "options": {"pieType": "donut", "displayLabels": ["name", "percent"], "legend": {"showLegend": False},
                   "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                   "tooltip": {"mode": "single"}}}, 12, 4, 9)
foods = '''from(bucket: "health") |> range(start: -365d)
  |> filter(fn: (r) => r._measurement == "meal" and r._field == "food")
  |> map(fn: (r) => ({_time: r._time, food: r._value, _value: 1}))
  |> group(columns: ["food"]) |> count() |> group()
  |> map(fn: (r) => ({Food: r.food, Times: r._value}))
  |> sort(columns: ["Times"], desc: true) |> limit(n: 10)'''
b.add({"type": "barchart", "title": "What I log most", "targets": [target(foods)],
       "fieldConfig": {"defaults": {"color": color(TEAL), "custom": {"fillOpacity": 85, "lineWidth": 0}},
                       "overrides": []},
       "options": {"xField": "Food", "orientation": "horizontal", "showValue": "auto", "barWidth": 0.7,
                   "legend": {"showLegend": False}}}, 16, 8, 9, newline=True)
slots = flux('''from(bucket: "health") |> range(start: -365d)
  |> filter(fn: (r) => r._measurement == "meal" and r._field == "kcal")
  |> group(columns: ["meal"]) |> sum() |> group()
  |> map(fn: (r) => ({rank: if r.meal == "breakfast" then 1 else if r.meal == "lunch" then 2 else if r.meal == "dinner" then 3 else 4,
                      Meal: if r.meal == "breakfast" then "Breakfast" else if r.meal == "lunch" then "Lunch"
                            else if r.meal == "dinner" then "Dinner" else "Snacks", Calories: r._value}))
  |> sort(columns: ["rank"]) |> drop(columns: ["rank"])''')
b.add({"type": "barchart", "title": "Calories by meal", "targets": [target(slots)],
       "description": "Everything logged, by the meal it was logged to.",
       "fieldConfig": {"defaults": {"color": color(AMBER), "custom": {"fillOpacity": 85, "lineWidth": 0}},
                       "overrides": [by_name("Calories", more=[{"id": "unit", "value": "suffix: kcal"}])]},
       "options": {"xField": "Meal", "orientation": "vertical", "showValue": "auto", "barWidth": 0.6,
                   "legend": {"showLegend": False}}}, 0, 12, 8)
prot = flux(f'''from(bucket: "health") |> {RANGE}
  |> filter(fn: (r) => r._measurement == "meal" and r._field == "protein_g")
  |> group() |> aggregateWindow(every: 1d, fn: sum, createEmpty: false)''')
b.add(series("Protein per day", [target(prot)], "massg", draw="bars", fill=80, time_from="75d", legend=False,
             over=[by_ref("A", "Protein", TEAL)]), 12, 12, 8, newline=True)

# ---- training (logged since late September) ------------------------------------------------------
b.row("Training")
SETS = '''sets = from(bucket: "health") |> {rng}
  |> filter(fn: (r) => r._measurement == "set" and (r._field == "weight" or r._field == "reps" or r._field == "est_1rm"))
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> map(fn: (r) => ({{r with volume: r.weight * r.reps}}))
'''
vol = flux(SETS.format(rng=RANGE) + '''sets |> group(columns: ["muscle"]) |> keep(columns: ["_time", "volume", "muscle"])
  |> rename(columns: {volume: "_value"}) |> aggregateWindow(every: 1w, offset: -3d, fn: sum, createEmpty: false)''')
b.add(series("Volume per week (weight x reps), by muscle", [target(vol)], "short", draw="bars", stack=True, fill=92,
             time_from="35d", over=[label_name("muscle")] + [by_name(m, c) for m, c in MUSCLE.items()]), 0, 12, 9)
e1 = flux(SETS.format(rng=RANGE) + '''top = from(bucket: "health") |> range(start: -60d)
  |> filter(fn: (r) => r._measurement == "set" and r._field == "est_1rm" and r._value > 0.0)
  |> group(columns: ["exercise"]) |> count() |> group() |> sort(columns: ["_value"], desc: true) |> limit(n: 5)
  |> findColumn(fn: (key) => true, column: "exercise")
sets |> filter(fn: (r) => contains(value: r.exercise, set: top)) |> group(columns: ["exercise"])
  |> keep(columns: ["_time", "est_1rm", "exercise"]) |> rename(columns: {est_1rm: "_value"})
  |> aggregateWindow(every: 1d, fn: max, createEmpty: false)''')
b.add(series("Estimated one rep max, my five most trained lifts", [target(e1)], "short", points="always",
             time_from="35d", over=[label_name("exercise")]), 12, 12, 9, newline=True)

# ---- surroundings ----------------------------------------------------------------------------------
b.row("Surroundings")
b.add(series("Daylight per day", [target(daily("time_in_daylight"))], "suffix: min", draw="bars", fill=70,
             time_from="365d", over=[by_ref("A", "Daylight", GREEN)], legend=False), 0, 12, 8)
b.add(series("Sound levels", [target(daily("environmental_audio_exposure"), "A"),
                              target(daily("headphone_audio_exposure"), "B")], "suffix: dB", time_from="365d",
             over=[by_ref("A", "Surroundings", BLUE), by_ref("B", "Headphones", VIOLET)]), 12, 12, 8, newline=True)

b.write()
