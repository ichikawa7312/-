"""Drive the privacy-safe real-shape sequence through its ordinary HTML buttons.

Two conditions only: Unicode string/code-unit budgets and equal-UTF8 ASCII.
Each gets a new disposable persistent profile. The production startup recovery,
mixed File/Blob values, static cache, seven-file staging, and nine-value receive
run unchanged; this does not execute authentication or the full cloud scheduler.
A successful receive is verified again after a full browser process restart.
No customer data, quota override, profile-file inspection, database clearing,
failure retries, or production-origin access is used. Output has reports only;
native profiles and packaged assets remain in separate temporary directories.
"""
import argparse
import functools
import hashlib
import importlib.util
import json
import re
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version as package_version
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CONDITIONS = ("unicode", "ascii")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_report(page):
    # Read the same JSON shown to a human. Do not evaluate a JavaScript string
    # under the fixture's deliberately unchanged script-src 'self' policy.
    text = page.locator("#report").text_content()
    return json.loads(text) if text else None


def permitted_url(url, origin):
    """Allow only this synthetic origin and same-origin native Blob handles."""
    parsed = urlparse(url)
    base = urlparse(origin)
    if parsed.scheme in ("http", "https"):
        return (parsed.scheme, parsed.netloc) == (base.scheme, base.netloc)
    if url.startswith("blob:" + origin + "/"):
        return re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", url[len("blob:" + origin + "/"):]) is not None
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["chromium", "webkit"], required=True)
    parser.add_argument("--built-root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    summary = {
        "format": "sentlog-real-shape-native-sequence-v1", "engine": args.engine,
        "status": "running", "conditions": [], "playwrightVersion": package_version("playwright"),
        "fixtureSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "scope": "Synthetic production-storage sequence, not login or full cloud scheduler",
        "baselinePrefill": False, "physicalDeviceTested": False, "quotaOverride": False,
        "profileFilesInspected": False, "customerDataUsed": False,
        "restartMethod": "Close persistent context/browser process, relaunch same own disposable profile and loopback origin, click readonly verify",
    }
    server = None
    try:
        spec = importlib.util.spec_from_file_location("sequence_package", ROOT / "scripts" / "prepare_record_restore_sequence.py")
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        with tempfile.TemporaryDirectory(prefix="sentlog-sequence-assets-") as package_dir, tempfile.TemporaryDirectory(prefix="sentlog-sequence-profiles-") as profiles:
            destination = Path(package_dir) / "sequence"
            manifest = packager.package(args.built_root, destination)
            summary["sourceManifest"] = manifest
            write_json(args.out / "source-manifest.json", manifest)

            class Handler(SimpleHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def end_headers(self):
                    self.send_header("Cache-Control", "no-store")
                    super().end_headers()

            handler = functools.partial(Handler, directory=package_dir)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            url = origin + "/sequence/"
            with sync_playwright() as playwright:
                engine = getattr(playwright, args.engine)
                for variant in CONDITIONS:
                    case = {"variant": variant, "status": "running", "baselinePrefill": False,
                            "browserProcessRestarted": False, "blockedRequests": [], "console": [], "pageErrors": []}
                    context = None
                    page = None

                    def route_request(route):
                        if permitted_url(route.request.url, origin):
                            route.continue_()
                        else:
                            if len(case["blockedRequests"]) < 100:
                                case["blockedRequests"].append(route.request.url)
                            route.abort()

                    def install_page(ctx, label):
                        nonlocal page
                        ctx.route("**/*", route_request)
                        opened = ctx.pages[0] if ctx.pages else ctx.new_page()
                        page = opened
                        opened.on("console", lambda message: case["console"].append({"phase": label, "type": message.type, "text": message.text[:4000]})
                                  if message.type in ("warning", "error") and len(case["console"]) < 100 else None)
                        opened.on("pageerror", lambda error: case["pageErrors"].append({"phase": label, "message": str(error)[:4000]})
                                  if len(case["pageErrors"]) < 100 else None)
                        opened.set_default_timeout(15000)
                        opened.goto(url, wait_until="load", timeout=45000)
                        opened.locator('#report[data-ready="true"][data-busy="false"], #report[data-status="failed"][data-busy="false"]').wait_for(state="attached", timeout=30000)
                        loaded = read_report(opened)
                        if loaded and loaded.get("status") == "failed":
                            raise AssertionError("Fixture loading failed: " + json.dumps(loaded.get("firstFailure"), ensure_ascii=False))
                        return opened

                    try:
                        context = engine.launch_persistent_context(str(Path(profiles) / variant), headless=True, service_workers="block")
                        case["browserVersion"] = context.browser.version
                        page = install_page(context, "initial")
                        page.locator("#variant").select_option(variant)
                        assert not page.locator("#baseline").is_checked(), "Primary case must omit optional baseline prefill"
                        page.locator("#start").click()
                        page.locator('#report[data-status="received"][data-busy="false"], #report[data-status="failed"][data-busy="false"]').wait_for(state="attached", timeout=240000)
                        case["initial"] = read_report(page)
                        write_json(args.out / f"{variant}-initial.json", case["initial"])
                        if case["initial"]["status"] != "received":
                            raise AssertionError("Sequence stopped at " + json.dumps(case["initial"].get("firstFailure"), ensure_ascii=False))
                        if case["initial"].get("sourceManifest") != manifest:
                            raise AssertionError("Executed manifest differs from packaged public sources")
                        context.close()
                        context = None
                        page = None
                        context = engine.launch_persistent_context(str(Path(profiles) / variant), headless=True, service_workers="block")
                        case["browserProcessRestarted"] = True
                        case["restartedBrowserVersion"] = context.browser.version
                        page = install_page(context, "restarted")
                        page.locator("#verify").click()
                        page.locator('#report[data-status="verified"][data-busy="false"], #report[data-status="failed"][data-busy="false"]').wait_for(state="attached", timeout=120000)
                        case["restarted"] = read_report(page)
                        if case["restarted"]["status"] != "verified":
                            raise AssertionError("Restart verification stopped at " + json.dumps(case["restarted"].get("firstFailure"), ensure_ascii=False))
                        if case["restarted"].get("loadedSourceManifest") != manifest:
                            raise AssertionError("Restart sources differ from the original source manifest")
                        if case["blockedRequests"] or case["pageErrors"]:
                            raise AssertionError("Unexpected blocked network requests or page errors")
                        case["status"] = "passed"
                    except Exception as error:
                        case["status"] = "failed" if case.get("browserVersion") else "blocked"
                        case["error"] = {"name": type(error).__name__, "message": str(error)}
                        if page is not None:
                            try:
                                case["lastReport"] = read_report(page)
                            except Exception as read_error:
                                case["reportReadError"] = str(read_error)
                    finally:
                        if context is not None:
                            try:
                                context.close()
                            except Exception as close_error:
                                case["closeError"] = str(close_error)
                                case["status"] = "failed"
                        write_json(args.out / f"{variant}.json", case)
                        summary["conditions"].append({"variant": variant, "status": case["status"],
                            "browserVersion": case.get("browserVersion"), "browserProcessRestarted": case["browserProcessRestarted"],
                            "report": f"{variant}.json", "sha256": hashlib.sha256((args.out / f"{variant}.json").read_bytes()).hexdigest(),
                            "firstFailure": (case.get("lastReport") or case.get("initial") or {}).get("firstFailure"), "error": case.get("error")})
                        write_json(args.out / "summary.json", summary)
            summary["status"] = ("passed" if len(summary["conditions"]) == 2 and all(c["status"] == "passed" for c in summary["conditions"])
                                 else "blocked" if summary["conditions"] and all(c["status"] == "blocked" for c in summary["conditions"]) else "failed")
    except Exception as error:
        summary["status"] = "blocked" if not summary["conditions"] else "failed"
        summary["error"] = {"name": type(error).__name__, "message": str(error)}
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        write_json(args.out / "summary.json", summary)
    print(json.dumps({"status": summary["status"], "engine": args.engine, "conditions": summary["conditions"]}, ensure_ascii=False))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
