"""Disposable Chromium/WebKit checks for atomic photo queue and receipts.

Only loopback HTTP, synthetic image bytes and a new temporary browser context
are used. This does not test a physical iPhone/iPad or the real company PC.
"""
import argparse
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    report = {"browser": args.browser, "scope": "isolated synthetic photo delivery", "success": False}
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.browser).launch(headless=True)
            try:
                context = browser.new_context()
                page = context.new_page()
                page.set_default_timeout(120000)
                page.goto(f"http://127.0.0.1:{server.server_port}/tests/delta_assets_fixture.html")
                report["cases"] = page.evaluate("""async engine => SentlogAssetTestCases.run({
                    API: SentlogDeltaAssets, CORE: SentlogDeltaSyncCore,
                    indexedDB, IDBObjectStore, suffix: engine
                })""", args.browser)
                report["success"] = True
            finally:
                browser.close()
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        server.shutdown()
        server.server_close()
    print(f"PASS photo delivery on {args.browser}: {len(report['cases'])} cases")


if __name__ == "__main__":
    main()
