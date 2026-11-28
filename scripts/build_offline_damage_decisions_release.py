"""Release validated offline-first local damage decisions after the entire v2.20 build.

No schema, photo, PDF, cloud sync, or file deletion logic changes. Bump the
loaded editor identity and PWA cache as one safe package so an installed iPhone
does not silently continue running the old decision handler.
"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
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
if ("offlineDamageDecisionsVersion:3" not in editor
        or "async function confirmDecision({localOnly=!navigator.onLine}={})" not in editor
        or "function localDecisionApplied(d,target)" not in editor
        or "deferRender:localOnly" not in editor
        or "localRevisionId" not in editor):
    raise RuntimeError("Verified local deletion/name edit implementation is absent")
if "sentlog-pwa-v262" not in source("sentlog/sw.js"):
    raise RuntimeError("v2.20 source build is required")
# Require the exact optional shared-file reconstruction and owner-fenced
# original read. These are already assembled into cloud-sync by build_delta_sync.
for path, marker in (
    ("sentlog/original-photo-store.js", "async function getOriginalMeta("),
    ("sentlog/delta-sync-asset-runtime.js", "ASSET_ORIGINAL_RECOVERY_BATCH"),
    ("sentlog/delta-sync-app-runtime.js", "recoverShared:recoverShared?"),
    ("sentlog/cloud-sync.js", "async function sentlogDeltaRecoverSharedOriginal("),
):
    if marker not in source(path):
        raise RuntimeError("Missing reviewed original-photo recovery: " + path)


index = "sentlog/index.html"
editor_tokens = re.findall(r'collaboration-editor\.js\?v=([A-Za-z0-9._-]+)', source(index))
if len(editor_tokens)!=2 or len(set(editor_tokens))!=1 or editor_tokens[0]==NEW_EDIT:
    raise RuntimeError("v2.21 expects two matching previous editor references")
old_edit_token = editor_tokens[0]
change(index, "collaboration-editor.js?v=" + old_edit_token,
       "collaboration-editor.js?v=" + NEW_EDIT, 2)
change(index, "['collaboration-editor.js?v=" + NEW_EDIT + "','requestPhotoRemoval']",
       "['collaboration-editor.js?v=" + NEW_EDIT + "','offlineDamageDecisionsVersion']", 1)
# Change cache URLs for every modified runtime, not just the editor. Otherwise
# Safari may run a new shell against stale photo workers after app resume.
RECOVERY_TOKEN = "20261128-safe-original-recovery-221"
recovery_modules = ("original-photo-store", "delta-sync-asset-runtime", "delta-sync-app-runtime", "cloud-sync")
old_versions = {}
for module in recovery_modules:
    found = re.findall(re.escape(module)+r'\.js\?v=([A-Za-z0-9._-]+)',source(index))
    if len(found)!=2 or len(set(found))!=1 or found[0]==RECOVERY_TOKEN:
        raise RuntimeError("Recovery module URL references changed: "+module+": "+str(found))
    old_versions[module]=found[0]
    change(index,module+".js?v="+found[0],module+".js?v="+RECOVERY_TOKEN,2)

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
        *[(module+".js?v="+old_versions[module],module+".js?v="+RECOVERY_TOKEN) for module in recovery_modules],
        ("collaboration-editor.js?v=" + old_edit_token, "collaboration-editor.js?v=" + NEW_EDIT),
        *[(module+r"\.js\?v="+old_versions[module],module+r"\.js\?v="+RECOVERY_TOKEN) for module in recovery_modules],
        (r"collaboration-editor\.js\?v=" + old_edit_token, r"collaboration-editor\.js\?v=" + NEW_EDIT),
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
for module in ("collaboration-editor", "phone-runtime", *recovery_modules):
    subprocess.run(["node", "--check", "sentlog/" + module + ".js"], cwd=ROOT, check=True)
print("Built v2.21: ordinary offline damage edits, immutable revisions and fresh iPhone cache")
