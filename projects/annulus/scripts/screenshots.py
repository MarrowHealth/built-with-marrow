#!/usr/bin/env python3
"""Capture the four tabs from a running demo server (needs `pip install playwright`).

    python3 serve.py &
    python3 scripts/screenshots.py --base http://127.0.0.1:8800
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

TABS = ['today', 'rhythm', 'trends', 'archive']
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'screenshots'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:8800')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--scheme', default='light', choices=['light', 'dark'])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': args.width, 'height': 900}, device_scale_factor=2,
                                color_scheme=args.scheme, locale='zh-CN')
        for tab in TABS:
            page.goto(f'{args.base}/#{tab}')
            page.wait_for_selector('.bento article')
            page.evaluate('document.fonts.ready')
            page.wait_for_timeout(600)
            path = OUT / f'{tab}-{args.width}-{args.scheme}.png'
            page.screenshot(path=str(path), full_page=True)
            print('saved', path)
        browser.close()


if __name__ == '__main__':
    main()
