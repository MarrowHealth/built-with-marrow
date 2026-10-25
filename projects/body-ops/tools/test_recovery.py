#!/usr/bin/env python3
"""Crash tests for the bridge, no Docker or InfluxDB needed.

A fake InfluxDB keeps points in memory (writes add, deletes remove, a point
with the same tags and time is replaced, as in InfluxDB). Each scenario sends
the same three deliveries:

    A  a food day with two entries
    M  a metrics day
    B  a newer snapshot of the same food day, one entry, sent after a restart

and compares the final points with a run that was never interrupted.

1. Lost write: the bridge is killed (SIGKILL) while A's write hangs, so the
   phone has its 204 but nothing reached the database. On restart A and M
   must be written before B.
2. Write landed, marker did not: the database accepts A's write, then the
   bridge is killed before it can mark A done. On restart A is written a
   second time, and the result must still match, with B landing last.

After each, a clean restart must write nothing again.

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
    """mode "ok" answers at once. "hang" never stores the write. "store_then_hang"
    stores the write and then never answers, like a crash right after the write."""

    def __init__(self):
        self.points = {}
        self.writes = 0
        self.mode = "ok"
        self.landed = threading.Event()
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                if self.path.startswith("/api/v2/write"):
                    if fake.mode == "hang":
                        time.sleep(30)
                        return
                    with fake.lock:
                        fake.writes += 1
                        for line in body.splitlines():
                            # tags end at the first unescaped space, the time follows the last one
                            cut = re.search(r"(?<!\\) ", line).start()
                            fields, ts = line[cut + 1:].rsplit(" ", 1)
                            fake.points[(line[:cut], ts)] = fields
                    if fake.mode == "store_then_hang":
                        fake.landed.set()
                        time.sleep(30)
                        return
                elif self.path.startswith("/api/v2/delete"):
                    day = re.search(r'day="([^"]+)"', json.loads(body)["predicate"]).group(1)
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

    def snapshot(self):
        with self.lock:
            return dict(self.points)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Bridge:
    def __init__(self, fake):
        self.fake = fake
        self.port = free_port()
        self.archive = tempfile.mkdtemp(prefix="bridge-archive-")
        self.env = {**os.environ, "INFLUX_URL": fake.url, "INFLUX_TOKEN": "x", "BRIDGE_TOKEN": TOKEN,
                    "ARCHIVE_DIR": self.archive, "BRIDGE_HOST": "127.0.0.1", "BRIDGE_PORT": str(self.port),
                    "PORT": str(self.port), "TZ_NAME": "UTC"}
        self.proc = None

    def start(self):
        self.proc = subprocess.Popen([sys.executable, BRIDGE], env=self.env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/{TOKEN}", timeout=1)
                return
            except OSError:
                time.sleep(0.1)
        raise SystemExit("bridge did not start")

    def kill(self, sig=signal.SIGKILL):
        self.proc.send_signal(sig)
        self.proc.wait()

    def post(self, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/{TOKEN}", data=json.dumps(body).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status

    def wait_done(self, n, timeout=20):
        end = time.time() + timeout
        log = os.path.join(self.archive, "processed.log")
        while time.time() < end:
            if os.path.exists(log) and len(open(log).read().splitlines()) >= n:
                st = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/{TOKEN}", timeout=2))
                if st["queued"] == 0:
                    return
            time.sleep(0.2)
        raise SystemExit("bridge did not finish")

    def marked(self):
        return open(os.path.join(self.archive, "processed.log")).read().splitlines()


def food(*entries):
    return {"data": {"days": [{"day": DAY, "entries": [
        {"meal": "lunch", "name": n, "kcal": k, "protein_g": 10, "carbs_g": 10, "fat_g": 5,
         "logged_at": f"{DAY}T12:00:00Z"} for n, k in entries]}]}}


A = food(("Old breakfast", 400), ("Old lunch", 700))
M = {"data": {"metrics": [{"name": "step_count", "units": "count", "data": [{"date": DAY, "qty": 8000}]}]}}
B = food(("New lunch", 650))


def uninterrupted():
    fake = FakeInflux()
    b = Bridge(fake)
    b.start()
    for body in (A, M, B):
        assert b.post(body) == 204
    b.wait_done(3)
    b.kill(signal.SIGTERM)
    return fake.snapshot()


def interrupted(mode):
    fake = FakeInflux()
    b = Bridge(fake)
    fake.mode = mode
    b.start()
    assert b.post(A) == 204
    assert b.post(M) == 204
    if mode == "store_then_hang":
        assert fake.landed.wait(10), "A's write never reached the database"
    else:
        time.sleep(1.0)
    b.kill()  # the phone has two 204s
    fake.mode = "ok"
    b.start()
    assert b.post(B) == 204  # newer snapshot of the same day, right after the restart
    b.wait_done(3)
    b.kill(signal.SIGTERM)
    final, marked = fake.snapshot(), b.marked()
    before = fake.writes
    b.start()
    time.sleep(1.0)
    b.kill(signal.SIGTERM)
    return final, marked, fake.writes == before


def main():
    want = uninterrupted()
    ok = True
    for name, mode in (("lost write", "hang"), ("write landed, marker did not", "store_then_hang")):
        final, marked, quiet = interrupted(mode)
        checks = [("final points match a run that was never interrupted", final == want),
                  ("the day holds only the newer food entry",
                   sorted(v for k, v in final.items() if k[0].startswith("meal,")) == sorted(
                       v for k, v in want.items() if k[0].startswith("meal,"))),
                  ("all three deliveries are marked done", len(marked) == 3 and all(m.endswith("\tok") for m in marked)),
                  ("a clean restart writes nothing again", quiet)]
        print(f"{name}:")
        for label, passed in checks:
            print(("  ok    " if passed else "  FAIL  ") + label)
            ok &= passed
    print("recovery tests passed" if ok else "recovery tests FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
