"""Post-build release identity for foreground photo capture.

Runs after v2.19 assembly. Only changes static version URLs, visible release
label and service-worker cache identity. It never touches IndexedDB schema,
saved photos, sync ownership or the existing release safety predicates.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD_TOKEN = "20261128-iphone-cutoff-memory-219"
TOKEN = "20261128-photo-foreground-220"
OLD_PHOTO_TOKEN = "20261118-collaboration-photos"
OLD_LABEL = "v2.19 · iPhoneの保存・同期負荷を軽減"
LABEL = "v2.20 · 写真保存中の不要な待機を軽減"


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def replace(source, old, new, expected, where):
    count = source.count(old)
    if count != expected:
        raise RuntimeError(f"v2.20 release mismatch in {where}: {old[:100]!r}, found {count}, expected {expected}")
    return source.replace(old, new)


writer = read("sentlog/record-store.js")
photo = read("sentlog/collaboration-photos.js")
if (not writer.startswith("// sentlog-iphone-cutoff-memory-v219\n")
        or "get recordPending(){return pending.size+inFlight>0||operation||exclusive;}" not in writer):
    raise RuntimeError("Tested record-only photo writer is not present")
if ("async function settleRecordWrites(){" not in photo
        or "await settleRecordWrites();" not in photo
        or "return scoped;" not in photo):
    raise RuntimeError("Tested foreground photo attachment is not present")

index = read("sentlog/index.html")
index = replace(index, "record-store.js?v=" + OLD_TOKEN,
                "record-store.js?v=" + TOKEN, 2, "sentlog/index.html")
index = replace(index, "collaboration-photos.js?v=" + OLD_PHOTO_TOKEN,
                "collaboration-photos.js?v=" + TOKEN, 2, "sentlog/index.html")
index = replace(index, "phone-runtime.js?v=219",
                "phone-runtime.js?v=220", 2, "sentlog/index.html")
index = replace(index, "['phone-runtime.js?v=220','v2.19']",
                "['phone-runtime.js?v=220','v2.20']", 1, "sentlog/index.html")
# Keep the v2.19 prefix on unchanged protection code. Its body is tested
# separately; moving the URL ensures the replacement is fetched on phones.
if ("['record-store.js?v=" + TOKEN + "','sentlog-iphone-cutoff-memory-v219']" not in index
        or "['collaboration-photos.js?v=" + TOKEN + "','SentlogCollaborationPhotos']" not in index):
    raise RuntimeError("Versioned writer/photo dependency preflight is missing")

phone = read("sentlog/phone-runtime.js")
if phone.count("v2.19") != 5:
    raise RuntimeError("Phone runtime label/capability identity changed")
phone = replace(phone, OLD_LABEL, LABEL, 1, "sentlog/phone-runtime.js")
phone = phone.replace("v2.19", "v2.20")
# The earlier label replacement has already changed one of five occurrences.
if phone.count("v2.20") != 5:
    raise RuntimeError("Phone runtime version labels are inconsistent")
pc = replace(read("sentlog-pc/index.html"), OLD_LABEL, LABEL, 1, "sentlog-pc/index.html")
worker = replace(read("sentlog/sw.js"), "sentlog-pwa-v261", "sentlog-pwa-v262", 1,
                 "sentlog/sw.js")

pending = {
    "sentlog/index.html": index,
    "sentlog/phone-runtime.js": phone,
    "sentlog-pc/index.html": pc,
    "sentlog/sw.js": worker,
}
# Legacy regression tests are source-version-locked. Advance their release
# expectations without changing any assertions or fixture data.
for path in (ROOT / "tests").iterdir():
    if path.suffix not in (".py", ".cjs"):
        continue
    filename = str(path.relative_to(ROOT))
    before = read(filename)
    after = before
    after = after.replace("record-store.js?v=" + OLD_TOKEN,
                          "record-store.js?v=" + TOKEN)
    after = after.replace("collaboration-photos.js?v=" + OLD_PHOTO_TOKEN,
                          "collaboration-photos.js?v=" + TOKEN)
    after = after.replace("phone-runtime.js?v=219", "phone-runtime.js?v=220")
    after = after.replace(r"phone-runtime\.js\?v=219", r"phone-runtime\.js\?v=220")
    after = after.replace(OLD_LABEL, LABEL)
    after = after.replace("sentlog-pwa-v261", "sentlog-pwa-v262")
    after = after.replace("'v2.19'", "'v2.20'")
    if after != before:
        pending[filename] = after

for path, data in pending.items():
    (ROOT / path).write_text(data, encoding="utf-8")
for name in ("record-store", "collaboration-photos", "phone-runtime"):
    subprocess.run(["node", "--check", "sentlog/" + name + ".js"], cwd=ROOT, check=True)
print("Built v2.20: versioned foreground photo writer, photo attachment and fresh iPhone cache")
