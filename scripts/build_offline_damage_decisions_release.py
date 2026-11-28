"""Release validated explicit local damage decisions after the entire v2.20 build.

No schema, photo, PDF, cloud sync, or file deletion logic changes. Bump the
loaded editor identity and PWA cache as one safe package so an installed iPhone
does not silently continue running the old decision handler.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_EDIT = "20261121-camera-landscape"
NEW_EDIT = "20261128-local-damage-decisions-221"
OLD_LABEL = "v2.20 · 写真保存中の不要な待機を軽減"
NEW_LABEL = "v2.21 · 損傷の変更を端末内に安全に保存"
pending = {}


def source(path):
    return pending.get(path, (ROOT / path).read_text(encoding="utf-8"))


def change(path, old, new, count=1):
    text = source(path)
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"v2.21 anchor differs: {path}: {old[:130]!r} found {actual} expected {count}")
    pending[path] = text.replace(old, new)


editor = source("sentlog/collaboration-editor.js")
if ("offlineDamageDecisionsVersion:1" not in editor
        or "async function confirmDecision({localOnly=false}={})" not in editor
        or "function localDecisionApplied(d,target)" not in editor
        or "deferRender:localOnly" not in editor
        or "localRevisionId" not in editor):
    raise RuntimeError("Verified local deletion/name edit implementation is absent")
if "sentlog-pwa-v262" not in source("sentlog/sw.js"):
    raise RuntimeError("v2.20 source build is required")

index = "sentlog/index.html"
change(index, "collaboration-editor.js?v=" + OLD_EDIT,
       "collaboration-editor.js?v=" + NEW_EDIT, 2)
change(index, "['collaboration-editor.js?v=" + NEW_EDIT + "','requestPhotoRemoval']",
       "['collaboration-editor.js?v=" + NEW_EDIT + "','offlineDamageDecisionsVersion']", 1)
change(index, "phone-runtime.js?v=220", "phone-runtime.js?v=221", 2)
change(index, "['phone-runtime.js?v=221','v2.20']",
       "['phone-runtime.js?v=221','v2.21']", 1)
change("sentlog/phone-runtime.js", OLD_LABEL, NEW_LABEL, 1)
change("sentlog/phone-runtime.js", "v2.20", "v2.21", 3)
change("sentlog-pc/index.html", OLD_LABEL, NEW_LABEL)
change("sentlog/sw.js", "sentlog-pwa-v262", "sentlog-pwa-v263")

# All legacy tests keep the original behavioral assertions. Earlier explicit
# v2.20 release proof was already executed before this final build pass.
for path in (ROOT / "tests").iterdir():
    if path.suffix not in (".py", ".cjs") or path.name == "photo_foreground_release.test.cjs":
        continue
    name = str(path.relative_to(ROOT))
    before = source(name)
    after = before
    for old, new in (
        ("collaboration-editor.js?v=" + OLD_EDIT, "collaboration-editor.js?v=" + NEW_EDIT),
        (r"collaboration-editor\.js\?v=" + OLD_EDIT, r"collaboration-editor\.js\?v=" + NEW_EDIT),
        ("phone-runtime.js?v=220", "phone-runtime.js?v=221"),
        (r"phone-runtime\.js\?v=220", r"phone-runtime\.js\?v=221"),
        ("sentlog-pwa-v262", "sentlog-pwa-v263"),
        (OLD_LABEL, NEW_LABEL),
        ("'v2.20'", "'v2.21'"),
    ):
        after = after.replace(old, new)
    if after != before:
        pending[name] = after

for path, content in pending.items():
    (ROOT / path).write_text(content, encoding="utf-8")
for module in ("collaboration-editor", "phone-runtime"):
    subprocess.run(["node", "--check", "sentlog/" + module + ".js"], cwd=ROOT, check=True)
print("Built v2.21: explicit local offline damage intents, immutable revisions, fresh iPhone cache")
