#!/usr/bin/env python3
"""Check showcase.json: required fields, known connection and data ids,
unique ids, pictures that exist and are not too large. Standard library."""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
CONNECTIONS = {"claude", "claude-desktop", "claude-code", "chatgpt", "codex", "gemini", "gemini-cli", "grok",
               "lechat", "perplexity", "notion", "cursor", "vscode", "zed", "cline", "openclaw", "hermes", "n8n",
               "zapier", "make", "home-assistant", "sheets", "grafana-assistant", "grafana", "influxdb", "strava",
               "custom"}
DATA = {"metrics", "samples", "workouts", "strength", "nutrition", "symptoms", "mcp", "writes"}
REQUIRED = ("id", "title", "summary", "description", "author", "connections", "data", "links", "image", "license",
            "added")

errors = []
doc = json.load(open(os.path.join(ROOT, "showcase.json"), encoding="utf-8"))
seen = set()
for i, p in enumerate(doc.get("projects", [])):
    where = f"project {i} ({p.get('id', '?')})"
    for k in REQUIRED:
        if not p.get(k):
            errors.append(f"{where}: missing {k}")
    pid = p.get("id", "")
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", pid):
        errors.append(f"{where}: id must be lowercase letters, digits and hyphens")
    if pid in seen:
        errors.append(f"{where}: duplicate id")
    seen.add(pid)
    if len(p.get("summary", "")) > 160:
        errors.append(f"{where}: summary is over 160 characters")
    for c in p.get("connections", []):
        if c not in CONNECTIONS:
            errors.append(f"{where}: unknown connection {c!r}")
    for d in p.get("data", []):
        if d not in DATA:
            errors.append(f"{where}: unknown data kind {d!r}")
    links = p.get("links", {})
    if not (links.get("code") or links.get("post")):
        errors.append(f"{where}: links needs code or post")
    for k, v in links.items():
        if not str(v).startswith("https://"):
            errors.append(f"{where}: link {k} must be https")
    if not isinstance(p.get("author"), dict) or not p["author"].get("name"):
        errors.append(f"{where}: author needs a name")
    img = os.path.join(ROOT, p.get("image", ""))
    if not os.path.isfile(img):
        errors.append(f"{where}: image {p.get('image')} not found")
    elif os.path.getsize(img) > 1024 * 1024:
        errors.append(f"{where}: image is over 1 MB")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.get("added", "")):
        errors.append(f"{where}: added must be YYYY-MM-DD")

for e in errors:
    print("error:", e)
print(f"{len(doc.get('projects', []))} projects, {len(errors)} problems")
sys.exit(1 if errors else 0)
