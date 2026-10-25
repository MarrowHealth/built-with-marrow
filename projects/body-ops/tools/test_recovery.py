#!/usr/bin/env python3
"""Crash test for the bridge, no Docker or InfluxDB needed.

A fake InfluxDB keeps points in memory (writes add, deletes remove) and can
hang its writes. The test:

1. starts the bridge, sends a year-style food delivery and a metrics delivery,
   and kills the bridge with SIGKILL while the first write is hanging,
   so the phone already has its 204 but nothing reached the database;
2. starts the bridge again and, at once, sends a newer food delivery for the
   same day (one entry instead of two);
3. checks the resulting points: the metrics point exists, the day holds only
   the newer food entry, and every file is marked done;
4. starts a third time and checks nothing is written again.

    python3 tools/test_recovery.py
"""
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge", "bridge.py")
TOKEN = "test-token"
DAY = "2001-01-02"


class FakeInflux:
    def __init__(self):
        self.points = {}  # (measurement, tags) -> fields line, latest wins like InfluxDB
        self.writes = 0
        self.hang = threading.Event()
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                if self.path.startswith("/api/v2/write"):
                    if fake.hang.is_set():
                        time.sleep(30)  # the bridge is killed during this
                        return
                    with fake.lock:
                        fake.writes += 1
                        for line in body.splitlines():
                            # tags end at the first unescaped space, the time follows the last one
                            cut = re.search(r"(?<!\\) ", line).start()
                            head, rest = line[:cut], line[cut + 1:]
                            fields, ts = rest.rsplit(" ", 1)
                            fake.points[(head, ts)] = fields
                elif self.path.startswith("/api/v2/delete"):
                    pred = json.loads(body)["predicate"]
                    day = re.search(r'day="([^"]+)"', pred).group(1)
                    with fake.lock:
                        for k in [k for k in fake.points if k[0].startswith("meal,") and f"day={day}" in k[0]]:
                            del fake.points[k]
                self.send_response(204)
                self.end_headers()

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def meals(self):
        with self.lock:
            return sorted(v for k, v in self.points.items() if k[0].startswith("meal,"))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(env, port):
    p = subprocess.Popen([sys.executable, BRIDGE], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/{TOKEN}", timeout=1)
            return p
        except OSError:
            time.sleep(0.1)
    raise SystemExit("bridge did not start: " + (p.stdout.read() if p.poll() is not None else ""))


def post(port, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/{TOKEN}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def food(*entries):
    return {"data": {"days": [{"day": DAY, "entries": [
        {"meal": "lunch", "name": n, "kcal": k, "protein_g": 10, "carbs_g": 10, "fat_g": 5,
         "logged_at": f"{DAY}T12:00:00Z"} for n, k in entries]}]}}


METRICS = {"data": {"metrics": [{"name": "step_count", "units": "count", "data": [{"date": DAY, "qty": 8000}]}]}}


def wait_idle(port, want_done, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        st = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/{TOKEN}", timeout=2))
        if st["queued"] == 0 and len(st["recent"]) >= want_done:
            return st
        time.sleep(0.2)
    raise SystemExit(f"bridge did not finish: {st}")


def main():
    fake = FakeInflux()
    archive = tempfile.mkdtemp(prefix="bridge-archive-")
    port = free_port()
    env = {**os.environ, "INFLUX_URL": fake.url, "INFLUX_TOKEN": "x", "BRIDGE_TOKEN": TOKEN, "ARCHIVE_DIR": archive,
           "BRIDGE_HOST": "127.0.0.1", "BRIDGE_PORT": str(port), "TZ_NAME": "UTC"}
    ok = True

    # 1. Two deliveries accepted, then the bridge dies mid-write.
    fake.hang.set()
    b = start(env, port)
    assert post(port, food(("Old breakfast", 400), ("Old lunch", 700))) == 204
    assert post(port, METRICS) == 204
    time.sleep(1.0)
    b.send_signal(signal.SIGKILL)
    b.wait()
    print("1. killed after two 204s, points in the database:", len(fake.points))

    # 2. Restart, and a newer snapshot of the same day arrives right away.
    fake.hang.clear()
    b = start(env, port)
    assert post(port, food(("New lunch", 650))) == 204
    wait_idle(port, 3)
    meals = fake.meals()
    steps = [v for k, v in fake.points.items() if k[0].startswith("daily,") and "step_count" in k[0]]
    done = open(os.path.join(archive, "processed.log")).read().splitlines()
    checks = [("the metrics delivery was written after the restart", steps == ["qty=8000.0"]),
              ("the day holds only the newer food entry", len(meals) == 1 and "New lunch" in meals[0]),
              ("all three deliveries are marked done", len(done) == 3 and all(l.endswith("\tok") for l in done))]
    b.send_signal(signal.SIGTERM)
    b.wait()

    # 3. A clean restart writes nothing again.
    before = fake.writes
    b = start(env, port)
    time.sleep(1.0)
    checks.append(("a clean restart writes nothing again", fake.writes == before))
    b.send_signal(signal.SIGTERM)
    b.wait()

    for name, passed in checks:
        print(("ok    " if passed else "FAIL  ") + name)
        ok &= passed
    print("recovery test passed" if ok else "recovery test FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
