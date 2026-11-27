"""Stop main-page legacy asset delivery after a known local save failure.

Run after the complete production assembly. The PC page owns a separate
SessionGuard and does not use the main record writer; it is not changed here.
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "sentlog/cloud-sync.js"
MARKER = "// sentlog-cloud-asset-save-failure-gate-v212"
GUARD = "    if(window.SentlogRecords?.failed)window.SentlogRecords.assertSafe();"
START = "function captureAssetReceiveScope(deviceId){"
END = "window.sentlogCaptureAssetReceiveScope=captureAssetReceiveScope;"

source = PATH.read_text()
assert source.count(START) == source.count(END) == 1, "Build the real cloud asset receiver first"
start, end = source.index(START), source.index(END) + len(END)
scope = source[start:end]
assert "code:'FILE_RECEIVE_SCOPE_CHANGED'" in scope, "Preserve the existing receive identity/import guard"
assert "async function pullProjectAssets(" in source and "async function collaborationFileRound(" in source

if MARKER in source:
    assert source.count(MARKER) == 1 and scope.count(GUARD) == 1, "Cloud asset guard marker is inconsistent"
else:
    anchor = "  };\n  validate();return validate;\n}"
    assert scope.count(anchor) == 1 and GUARD not in scope, "Cloud receive validator changed"
    updated = scope.replace(anchor, GUARD + "\n" + anchor)
    PATH.write_text(MARKER + "\n" + source[:start] + updated + source[end:])

print("Built main cloud asset save-failure gate v212; PC source unchanged")
