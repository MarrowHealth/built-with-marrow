#!/usr/bin/env python3
"""Serve the Annulus dashboard with the synthetic demo payload. Standard library only.

    python3 serve.py              # http://127.0.0.1:8800
    python3 serve.py --port 9000 --host 0.0.0.0

Demo mode: no account, no database. `/api/ui/overview` returns
`demo/overview.json`; login and logout always succeed; password change is
refused. In the real deployment the same routes sit in front of a
self-hosted Marrow server, with a hashed password and session cookies.
"""
from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
FIXTURE = ROOT / 'demo' / 'overview.json'
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
mimetypes.add_type('application/manifest+json', '.webmanifest')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if self.path.split('?')[0] in ('/', '/index.html', '/login'):
            self.send_header('Content-Security-Policy', CSP)
        super().end_headers()

    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/ui/overview':
            payload = json.loads(FIXTURE.read_text(encoding='utf-8'))
            return self._json(200, dict(payload, user='demo', csrf='demo'))
        if path == '/login':
            self.path = '/index.html'
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        length = int(self.headers.get('Content-Length') or 0)
        if length:
            self.rfile.read(min(length, 16384))
        if path in ('/auth/login', '/auth/logout'):
            return self._json(200, {'ok': True})
        if path == '/auth/password':
            return self._json(400, {'error': '演示模式不能修改密码'})
        return self._json(404, {'error': '接口不存在'})


def main():
    ap = argparse.ArgumentParser(description='Annulus demo server')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8800)
    args = ap.parse_args()
    if not FIXTURE.exists():
        raise SystemExit('demo/overview.json is missing; run: python3 demo/generate.py')
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Annulus demo on http://{args.host}:{args.port}  (Ctrl+C to stop)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
