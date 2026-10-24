"""Shared pieces for the Body Ops dashboard generator: Flux helpers, panel
builders, layout. Colors follow the Marrow icon: violet, amber, teal, blue."""
import json
import os

DS = {"type": "influxdb", "uid": "influx"}
RANGE = "range(start: v.timeRangeStart, stop: v.timeRangeStop)"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "grafana", "dashboards")

VIOLET, BLUE, TEAL, AMBER, CORAL, GREEN, GREY = "#7c5cff", "#3b82f6", "#22c3b5", "#f5a524", "#ff5d73", "#4ade80", "#8b93a7"
MUSCLE = {"Chest": CORAL, "Back": BLUE, "Shoulders": AMBER, "Biceps": TEAL, "Triceps": VIOLET,
          "Legs": GREEN, "Core": GREY, "Other": "#c4c9d4"}
STAGE = {"Deep": VIOLET, "Core": BLUE, "REM": TEAL, "Awake": AMBER}


def flux(body, *imports):
    """Every query runs in the dashboard's time zone variable, so days and
    hours are the viewer's own."""
    names = ["timezone", "date", *imports]
    head = "".join(f'import "{n}"\n' for n in dict.fromkeys(names))
    return head + 'option location = timezone.location(name: "${timezone}")\n' + body


def daily(metric, field="qty", rng=RANGE, extra=""):
    return flux(f'from(bucket: "health") |> {rng}\n'
                f'  |> filter(fn: (r) => r._measurement == "daily" and r.metric == "{metric}" and r._field == "{field}")'
                f'{extra}\n  |> keep(columns: ["_time", "_value"])')


def vs_normal(metric, field="qty", scale=1.0, nights=30):
    """Two points: the average of the previous nights, then the latest. A stat
    showing the last value with percent change then reads "vs my normal"."""
    return flux(f'''x = from(bucket: "health") |> range(start: -{nights + 2}d)
  |> filter(fn: (r) => r._measurement == "daily" and r.metric == "{metric}" and r._field == "{field}")
  |> group() |> sort(columns: ["_time"]) |> map(fn: (r) => ({{r with _value: r._value * {scale}}}))
lt = (x |> last() |> findRecord(fn: (key) => true, idx: 0))._time
base = x |> filter(fn: (r) => r._time < lt) |> mean() |> map(fn: (r) => ({{_time: date.sub(d: 1d, from: lt), _value: r._value}}))
union(tables: [base, x |> last() |> keep(columns: ["_time", "_value"])]) |> sort(columns: ["_time"])''')


def color(c):
    return {"mode": "fixed", "fixedColor": c}


def target(q, ref="A"):
    return {"refId": ref, "datasource": DS, "query": q}


def stat(title, q, unit="none", c=BLUE, decimals=1, desc="", spark=True, change=None, text="value", calc="lastNotNull",
         size=None, strings=False):
    o = {"reduceOptions": {"calcs": [calc], "fields": "/^(Value|_value)$/" if strings else "", "values": False},
         "graphMode": "area" if spark else "none", "colorMode": "value", "textMode": text,
         "justifyMode": "center", "showPercentChange": change is not None, "wideLayout": True}
    if change:
        o["percentChangeColorMode"] = change
    if size:
        o["text"] = {"valueSize": size}
    return {"type": "stat", "title": title, "description": desc, "targets": [target(q)],
            "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": color(c)}, "overrides": []},
            "options": o}


def series(title, targets, unit="", draw="line", stack=False, fill=0, over=None, legend=True, desc="",
           decimals=None, time_from=None, points="never", interp="linear", minv=None, maxv=None):
    d = {"unit": unit, "custom": {"drawStyle": draw, "fillOpacity": fill, "lineWidth": 0 if draw == "bars" else 2,
                                  "showPoints": points, "pointSize": 6, "spanNulls": False, "lineInterpolation": interp,
                                  "stacking": {"mode": "normal" if stack else "none", "group": "A"},
                                  "barAlignment": 0, "axisBorderShow": False,
                                  "gradientMode": "opacity" if fill and draw == "line" else "none"}}
    if decimals is not None:
        d["decimals"] = decimals
    if minv is not None:
        d["min"] = minv
    if maxv is not None:
        d["max"] = maxv
    p = {"type": "timeseries", "title": title, "description": desc, "targets": targets,
         "fieldConfig": {"defaults": d, "overrides": over or []},
         "options": {"legend": {"showLegend": legend, "displayMode": "list", "placement": "bottom"},
                     "tooltip": {"mode": "multi", "sort": "none"}}}
    if time_from:
        p["timeFrom"] = time_from
    return p


def by_ref(ref, name, c, more=()):
    return {"matcher": {"id": "byFrameRefID", "options": ref},
            "properties": [{"id": "displayName", "value": name}, {"id": "color", "value": color(c)}, *more]}


def by_name(name, c=None, display=None, more=()):
    props = []
    if display:
        props.append({"id": "displayName", "value": display})
    if c:
        props.append({"id": "color", "value": color(c)})
    return {"matcher": {"id": "byName", "options": name}, "properties": props + list(more)}


def label_name(label):
    """Series named by one of their tags (exercise, muscle, activity)."""
    return {"matcher": {"id": "byRegexp", "options": ".*"},
            "properties": [{"id": "displayName", "value": "${__field.labels.%s}" % label}]}


def rows_to_fields():
    return {"id": "rowsToFields", "options": {"mappings": [
        {"fieldName": "_field", "handlerKey": "field.name"}, {"fieldName": "_value", "handlerKey": "field.value"}]}}


def text(md, transparent=True, mode="markdown"):
    return {"type": "text", "title": "", "transparent": transparent, "options": {"mode": mode, "content": md}}


# The one setting a viewer may want to change: their IANA time zone, used for
# day and hour boundaries in every query.
TZ_VAR = {"type": "textbox", "name": "timezone", "label": "Time zone", "query": "UTC",
          "current": {"text": "UTC", "value": "UTC"}, "options": [{"selected": True, "text": "UTC", "value": "UTC"}],
          "description": "IANA name, e.g. America/New_York or Europe/London"}


class Board:
    def __init__(self, uid, title, time_from="now-30d", time_to="now", refresh="15m"):
        self.uid, self.title = uid, title
        self.time = {"from": time_from, "to": time_to}
        self.refresh = refresh
        self.panels, self.vars, self.y, self.n = [], [], 0, 0

    def row(self, title):
        self.n += 1
        self.panels.append({"type": "row", "title": title, "id": self.n, "collapsed": False,
                            "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1}, "panels": []})
        self.y += 1

    def add(self, p, x, w, h, newline=False):
        self.n += 1
        p.setdefault("id", self.n)
        p.setdefault("datasource", DS)
        p["gridPos"] = {"x": x, "y": self.y, "w": w, "h": h}
        self.panels.append(p)
        if newline:
            self.y += h

    def var(self, v):
        self.vars.append(v)

    def write(self):
        os.makedirs(OUT_DIR, exist_ok=True)
        d = {"uid": self.uid, "title": self.title, "tags": ["marrow"], "timezone": "browser",
             "editable": True, "graphTooltip": 1, "refresh": self.refresh, "schemaVersion": 41, "version": 1,
             "time": self.time, "fiscalYearStartMonth": 0, "liveNow": False, "panels": self.panels,
             "templating": {"list": [TZ_VAR] + self.vars}, "annotations": {"list": []}}
        path = os.path.join(OUT_DIR, f"{self.uid}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1)
        print(f"wrote {os.path.relpath(path)} ({len(self.panels)} panels)")
        return path


# Heatmap rows Monday to Sunday, top to bottom. Grafana orders the rows by
# name, so each label carries leading zero width spaces (more for Monday)
# that sort it without showing.
WEEK_ROWS = 'names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]\nzw = ["\u200b\u200b\u200b\u200b\u200b\u200b\u200b", "\u200b\u200b\u200b\u200b\u200b\u200b", "\u200b\u200b\u200b\u200b\u200b", "\u200b\u200b\u200b\u200b", "\u200b\u200b\u200b", "\u200b\u200b", "\u200b"]\n'
WEEK_LABEL = "zw[(date.weekDay(t: r.day) + 6) % 7] + names[(date.weekDay(t: r.day) + 6) % 7]"

# Grafana's heatmap reads a row-per-bucket timestamp as the END of its column,
# so calendar weeks are stamped with the following Monday.


def _hour(h):
    h = h % 24
    return f"{12 if h % 12 == 0 else h % 12} {'am' if h < 12 else 'pm'}"


# Clock charts plot hours past midnight of the evening before (23.5 is
# 11:30 pm, 31 is 7 am) and label them with value mappings. Grafana's time
# units would format in the viewer's own zone and shift every point.
HOUR_MAP = [{"type": "range", "options": {"from": float(h), "to": h + 0.9999, "result": {"text": _hour(h)}}}
            for h in range(12, 42)]


def clock_hours_flux(rng):
    """Bedtime and wake time per night as hours on that running clock."""
    return flux(f'''from(bucket: "health") |> {rng}
  |> filter(fn: (r) => r._measurement == "daily" and r.metric == "sleep_analysis")
  |> filter(fn: (r) => r._field == "sleepStart_s" or r._field == "sleepEnd_s" or r._field == "tz_offset_min")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> map(fn: (r) => ({{_time: r._time,
      bed: (r.sleepStart_s + r.tz_offset_min * 60.0) % 86400.0 / 3600.0,
      wake: (r.sleepEnd_s + r.tz_offset_min * 60.0) % 86400.0 / 3600.0 + 24.0}}))
  |> map(fn: (r) => ({{r with bed: if r.bed < 12.0 then r.bed + 24.0 else r.bed}}))''')


def clock_panel(title, rng=RANGE, time_from=None):
    over = [by_name("bed", VIOLET, "Fell asleep"), by_name("wake", AMBER, "Woke up")]
    p = series(title, [target(clock_hours_flux(rng))], "none", points="always", draw="points", time_from=time_from,
               over=over)
    p["fieldConfig"]["defaults"]["mappings"] = HOUR_MAP
    p["fieldConfig"]["defaults"]["decimals"] = 1
    return p
