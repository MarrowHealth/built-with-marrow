#!/usr/bin/env python3
"""Body Ops bridge: Marrow automations into InfluxDB 2.

Marrow's Automations POST JSON on a schedule, from the phone, with the app
closed. This small server takes all five kinds (health metrics as daily
totals or raw samples, workouts, strength log, nutrition diary, symptoms and
mood), keeps a gzip copy of every delivery, answers 204 at once and writes
the data to InfluxDB as line protocol from one worker thread.

Auth: the URL ends in BRIDGE_TOKEN (https://<host>/<token>), or the request
carries "Authorization: Bearer <BRIDGE_TOKEN>". Anything else gets a 404.
GET on the same URL shows the last deliveries (kinds and counts, no values).
CSV gets a 415: pick JSON in Marrow.

Every delivery is written to InfluxDB exactly in the order it arrived. A
delivery counts as done only once its points are written: archive/processed.log
records it. If the bridge stops in between (a crash, a restart, InfluxDB down),
the next start writes every unfinished delivery, oldest first, before any new
one. While InfluxDB is unreachable the worker waits and retries, still in order.

Replay the archive into a fresh bucket (latest wins, safe to repeat):
    python3 bridge.py replay ["2026/10/**/*.json.gz"]

Standard library only. Python 3.9+.
"""
import glob
import gzip
import json
import zlib
import os
import queue
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

INFLUX = os.environ.get("INFLUX_URL", "http://influxdb:8086")
ORG = os.environ.get("INFLUX_ORG", "marrow")
BUCKET = os.environ.get("INFLUX_BUCKET", "health")
TOKEN = os.environ["INFLUX_TOKEN"]
SECRET = os.environ["BRIDGE_TOKEN"]
ARCHIVE = os.environ.get("ARCHIVE_DIR", "/data/archive")
try:
    HOME_TZ = ZoneInfo(os.environ.get("TZ_NAME", "UTC"))
except Exception:  # no tz database in the image: fall back rather than fail
    HOME_TZ = timezone.utc
HOST = os.environ.get("BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("BRIDGE_PORT", "8799"))
MAX_BODY = 256 * 1024 * 1024
CHUNK = 5000

jobs = queue.Queue()
recent = []  # last deliveries, newest first
DONE_LOG = os.path.join(ARCHIVE, "processed.log")
intake = threading.Lock()  # archive name order is queue order

# Exercise name -> main muscle group, for the volume charts. Built from the
# public domain free-exercise-db, as curated in Marrow's exercise library.
try:
    MUSCLES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "muscles.json")))
except OSError:
    MUSCLES = {}
KEYWORDS = (("rear delt", "Shoulders"), ("curl", "Biceps"), ("tricep", "Triceps"), ("chest", "Chest"),
            ("bench", "Chest"), ("press", "Shoulders"), ("row", "Back"), ("pulldown", "Back"), ("pull-up", "Back"),
            ("squat", "Legs"), ("deadlift", "Legs"), ("lunge", "Legs"), ("leg ", "Legs"), ("calf", "Legs"),
            ("crunch", "Core"), ("plank", "Core"))


def muscle(name):
    n = (name or "").lower()
    return MUSCLES.get(n) or next((g for k, g in KEYWORDS if k in n), "Other")


# ---- line protocol -------------------------------------------------------------

def esc(s):
    s = str(s).replace("\n", " ").replace("\r", " ").strip()
    return s.replace("\\", "\\\\").replace(",", "\\,").replace("=", "\\=").replace(" ", "\\ ")


def fval(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        v = float(v)
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return repr(v)  # always a float, so a field never changes type
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'
    return None


def point(meas, tags, fields, ts):
    t = "".join(f",{esc(k)}={esc(v)}" for k, v in sorted(tags.items())
                if v is not None and str(v).strip() != "")
    f = ",".join(f"{esc(k)}={x}" for k, v in fields.items() if (x := fval(v)) is not None)
    if not f or ts is None:
        return None
    return f"{meas}{t} {f} {int(ts)}"


def iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return datetime.strptime(str(s), "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return None


def noon_utc(day):
    d = datetime.strptime(str(day)[:10], "%Y-%m-%d")
    return int(d.replace(hour=12, tzinfo=timezone.utc).timestamp())


def num(d):
    return {k: v for k, v in d.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}


# ---- one function per automation kind ------------------------------------------------

def metrics(data):
    """Daily totals land at noon UTC of their day (so every time zone shows
    the right date). Raw samples land at their start time."""
    for m in data.get("metrics", []):
        name, units = m.get("name"), m.get("units", "")
        for d in m.get("data", []):
            if "start" in d:
                st, en = iso(d["start"]), iso(d.get("end"))
                if not st:
                    continue
                dur = (en - st).total_seconds() if en else 0
                yield point("sample", {"metric": name, "units": units, "stage": d.get("stage"),
                                       "source": d.get("source")},
                            {"value": d.get("qty"), "dur_s": dur}, st.timestamp())
            elif d.get("date"):
                f = num(d)
                for k in ("sleepStart", "sleepEnd"):
                    t = iso(d.get(k))
                    if t:
                        f[k + "_s"] = t.timestamp()
                        f["tz_offset_min"] = t.utcoffset().total_seconds() / 60
                yield point("daily", {"metric": name, "units": units}, f, noon_utc(d["date"]))


def workouts(data):
    for w in data.get("workouts", []):
        st, en = iso(w.get("start")), iso(w.get("end"))
        if not st:
            continue
        f = num(w)
        if en:
            f["end_s"] = en.timestamp()
        yield point("workout", {"activity": w.get("activity"), "source": w.get("source")}, f, st.timestamp())


def strength(data):
    """Sets in one session share a time, so the set number is a tag too:
    without it they would overwrite each other."""
    unit = data.get("unit", "")
    for s in data.get("sets", []):
        t = iso(s.get("time"))
        if not t:
            continue
        yield point("set", {"exercise": s.get("exercise"), "session": s.get("session"),
                            "set_type": s.get("set_type"), "unit": unit, "n": s.get("set"),
                            "muscle": muscle(s.get("exercise"))},
                    num(s), t.timestamp())


def nutrition(data):
    """Whole days arrive, so each day is cleared first: an entry deleted on
    the phone disappears here too."""
    for day in data.get("days", []):
        key = day.get("day")
        if not key:
            continue
        yield ("DELETE", f'_measurement="meal" AND day="{key}"')
        noon_local = datetime.strptime(key, "%Y-%m-%d").replace(hour=12, tzinfo=HOME_TZ)
        for i, e in enumerate(day.get("entries", [])):
            t = iso(e.get("logged_at"))
            # Logged later than eaten (yesterday's dinner, typed today): noon of its day.
            if not t or t.astimezone(HOME_TZ).strftime("%Y-%m-%d") != key:
                t = noon_local
            f = num(e)
            for k, v in (e.get("nutrients") or {}).items():
                if isinstance(v, (int, float)):
                    f["n_" + k] = v
            f["food"] = e.get("name") or ""
            yield point("meal", {"day": key, "idx": i, "meal": e.get("meal")}, f, t.timestamp())


def mood(body):
    for s in body.get("symptoms", []):
        st, en = iso(s.get("start")), iso(s.get("end"))
        if not st:
            continue
        yield point("symptom", {"name": s.get("name"), "severity": s.get("severity"), "source": s.get("source")},
                    {"severity_code": s.get("severity_code"),
                     "dur_s": (en - st).total_seconds() if en else 0}, st.timestamp())
    for m in body.get("state_of_mind", []):
        t = iso(m.get("time"))
        if not t:
            continue
        yield point("mood", {"kind": m.get("kind"), "source": m.get("source")},
                    {"valence": m.get("valence"), "feeling": m.get("feeling") or ""}, t.timestamp())


def classify(body):
    if "symptoms" in body or "state_of_mind" in body:
        return "mood", mood(body)
    data = body.get("data") or {}
    if "metrics" in data:
        raw = any("start" in d for m in data["metrics"][:3] for d in m.get("data", [])[:1])
        return ("samples" if raw else "daily"), metrics(data)
    if "workouts" in data:
        return "workouts", workouts(data)
    if "sets" in data:
        return "strength", strength(data)
    if "days" in data:
        return "nutrition", nutrition(data)
    return "unknown", iter(())


# ---- InfluxDB ----------------------------------------------------------------------------

def influx(path, body, ctype):
    req = urllib.request.Request(f"{INFLUX}{path}", data=body, method="POST",
                                 headers={"Authorization": f"Token {TOKEN}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=120) as r:
        r.read()


def write(lines):
    q = urllib.parse.urlencode({"org": ORG, "bucket": BUCKET, "precision": "s"})
    for i in range(0, len(lines), CHUNK):
        influx(f"/api/v2/write?{q}", "\n".join(lines[i:i + CHUNK]).encode(), "text/plain; charset=utf-8")


def delete(predicate):
    q = urllib.parse.urlencode({"org": ORG, "bucket": BUCKET})
    body = json.dumps({"start": "1970-01-01T00:00:00Z", "stop": "2100-01-01T00:00:00Z",
                       "predicate": predicate}).encode()
    influx(f"/api/v2/delete?{q}", body, "application/json")


def process(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        body = json.load(f)
    kind, items = classify(body)
    lines, n = [], 0
    for it in items:
        if isinstance(it, tuple):  # a delete must land before that day's writes
            if lines:
                write(lines)
                n += len(lines)
                lines = []
            delete(it[1])
        elif it:
            lines.append(it)
    if lines:
        write(lines)
        n += len(lines)
    return kind, n


# ---- HTTP ----------------------------------------------------------------------------------

def archive(raw):
    """Write atomically, named by the microsecond, so a half-written file never
    exists and the names sort in arrival order."""
    now = datetime.now(timezone.utc)
    folder = os.path.join(ARCHIVE, now.strftime("%Y/%m/%d"))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, now.strftime("%H%M%S%f-") + secrets.token_hex(3) + ".json.gz")
    with gzip.open(path + ".tmp", "wb") as f:
        f.write(raw)
    os.replace(path + ".tmp", path)
    return path


def arrival(path):
    """Sort key: day folders, then the time in the name. Names from before the
    microsecond change (HHMMSS-...) sort as that second's start."""
    rel = os.path.relpath(path, ARCHIVE)
    head, name = os.path.split(rel)
    return head, name.split("-", 1)[0].ljust(12, "0"), name


def mark_done(path, status):
    line = f"{os.path.relpath(path, ARCHIVE)}\t{status}\n"
    with open(DONE_LOG, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def unfinished():
    """Deliveries archived but never marked done, oldest first."""
    done = set()
    if os.path.exists(DONE_LOG):
        with open(DONE_LOG, encoding="utf-8") as f:
            done = {ln.split("\t", 1)[0] for ln in f if ln.strip()}
    files = glob.glob(os.path.join(ARCHIVE, "*", "*", "*", "*.json.gz"))
    return sorted((p for p in files if os.path.relpath(p, ARCHIVE) not in done), key=arrival)


def permanent(e):
    """True when retrying can never help: a damaged file or a body InfluxDB rejects."""
    if isinstance(e, urllib.error.HTTPError):
        return e.code < 500 and e.code != 429
    return isinstance(e, (ValueError, KeyError, TypeError, EOFError, gzip.BadGzipFile, zlib.error))


def worker():
    while True:
        path, size = jobs.get()
        t0, attempt = time.time(), 0
        while True:
            try:
                kind, n = process(path)
                mark_done(path, "ok")
                rec = {"kind": kind, "points": n, "ok": True}
                break
            except Exception as e:
                if permanent(e):  # keep the archive, record it, move on
                    mark_done(path, "failed")
                    rec = {"kind": "?", "ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}
                    break
                attempt += 1  # InfluxDB unreachable or busy: wait, then retry this same delivery
                wait = min(300, 5 * 2 ** min(attempt, 6))
                print(json.dumps({"retry": os.path.relpath(path, ARCHIVE), "in_s": wait,
                                  "error": f"{type(e).__name__}: {str(e)[:120]}"}), flush=True)
                time.sleep(wait)
        rec.update({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "bytes": size, "secs": round(time.time() - t0, 1),
                    "file": os.path.relpath(path, ARCHIVE)})
        recent.insert(0, rec)
        del recent[50:]
        print(json.dumps(rec), flush=True)


class Handler(BaseHTTPRequestHandler):
    def authed(self):
        parts = [p for p in urllib.parse.urlparse(self.path).path.split("/") if p]
        bearer = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        return (secrets.compare_digest(parts[-1] if parts else "", SECRET)
                or secrets.compare_digest(bearer, SECRET))

    def reply(self, code, text=""):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if text.startswith(("{", "[")) else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authed():
            return self.reply(404, "not found")
        self.reply(200, json.dumps({"bridge": "ok", "queued": jobs.qsize(), "recent": recent}, indent=1))

    def do_POST(self):
        if not self.authed():
            return self.reply(404, "not found")
        if "csv" in (self.headers.get("Content-Type") or ""):
            return self.reply(415, "Pick JSON as the format in Marrow")
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0 or size > MAX_BODY:
            return self.reply(413, "empty or too large")
        raw = self.rfile.read(size)
        if len(raw) < size:  # the phone gave up mid-upload: never archive half a body
            return self.reply(400, "incomplete body")
        try:
            with intake:
                path = archive(raw)
                jobs.put((path, size))
        except OSError as e:
            return self.reply(500, f"archive failed: {e}")
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):  # the token can be in the path: never log it
        pass


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "replay":
        pattern = sys.argv[2] if len(sys.argv) > 2 else "**/*.json.gz"
        for path in sorted(glob.glob(os.path.join(ARCHIVE, pattern), recursive=True)):
            try:
                kind, n = process(path)
            except ValueError as e:  # a damaged file is skipped, not fatal
                kind, n = f"skipped ({type(e).__name__})", 0
            print(os.path.relpath(path, ARCHIVE), kind, n, flush=True)
        return
    # Unfinished deliveries go first, so they land before anything newer for
    # the same day (a food delivery replaces its whole day).
    os.makedirs(ARCHIVE, exist_ok=True)
    backlog = unfinished()
    for path in backlog:
        jobs.put((path, os.path.getsize(path)))
    if backlog:
        print(f"resuming {len(backlog)} unfinished deliveries, oldest first", flush=True)
    threading.Thread(target=worker, daemon=True).start()
    print(f"bridge listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
