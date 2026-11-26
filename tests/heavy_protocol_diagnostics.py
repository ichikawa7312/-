"""Opt-in diagnostics for the exact Playwright 1.57 Chromium error adapter.

Only the disposable synthetic CI test process enables this hook. It prints at
most eight bounded error summaries and keeps every original return/throw intact.
The package version, compiled source fingerprint and unique anchor must match.
"""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path


DRIVER_VERSION = '1.57.0-beta-1764944708000'
DRIVER_SHA256 = '4b4da27c16c2ec7094dcc3cc78313eb9ac8f15a9ed3b7589118a883d6d339b7f'
ANCHOR = '''  if (!js.isJavaScriptErrorInEvaluate(error) && !(0, import_protocolError.isSessionClosedError)(error))
    throw new Error("Execution context was destroyed, most likely because of a navigation.");'''

# Keep the original generic rewrite immediately below this independent hook.
# Neither successful protocol results nor application JS exceptions are logged.
HOOK = r'''  if (process.env.SENTLOG_HEAVY_PROTOCOL_DIAGNOSTICS === "1" &&
      !js.isJavaScriptErrorInEvaluate(error) && !(0, import_protocolError.isSessionClosedError)(error)) {
    try {
      if ((rewriteError.sentlogHeavyMessages || 0) < 8) {
        rewriteError.sentlogHeavyMessages = (rewriteError.sentlogHeavyMessages || 0) + 1;
        const raw = String(error.message || "");
        const method = ["Runtime.callFunctionOn", "Runtime.evaluate"].includes(error.method)
          ? error.method : "unknown";
        let reason = raw.split(/\r?\n/, 1)[0].replace(/^Protocol error \([^)]*\):\s*/, "");
        reason = reason.replace(/\b(?:arguments?|parameters?|expression|functionDeclaration|body|payload|data)\s*[:=].*$/i, "[details omitted]")
          .replace(/[\[{].*$/, "[structured details omitted]")
          .replace(/\b(?:https?|wss?|file|blob|data):[^\s)]+/gi, "[url]")
          .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "[quoted]")
          .replace(/\b[A-Za-z]:\\[^\s,;]+/g, "[path]")
          .replace(/(?:[A-Za-z]:)?\/[\w.\-/\\%?=&:#]+/g, "[path]")
          .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[id]")
          .replace(/\b[^\s@]+@[^\s@]+\b/g, "[email]")
          .replace(/\b[0-9a-f]{16,}\b/gi, "[value]")
          .replace(/\b\d+(?:\.\d+)*\b/g, "#");
        // Output only fixed canonical diagnostic words, never an arbitrary
        // unquoted value. Unknown reasons retain their technical terms + hash.
        const words = new Set(("a allocation an argument arguments available bad by call cannot cbor chain closed collected command context contextid could couldnt create current depth deserialization destroyed detached did does empty enabled error evaluate evaluation exceeded execution failed failure find found frame from function get handle id identifier in inspected internal invalid is it javascript length limit long maximum memory message method missing no non not null object of on only out parameter parameters parse parsing promise properties property read reference remote request result returned runtime serialization serialize session specified stack stream target the this timed timeout to too type undefined unexpected unknown unsupported value was were which with world").split(" "));
        reason = (reason.toLowerCase().match(/[^\s:,.()#-]+|[:,.()#-]/g) || []).map(word =>
          words.has(word) || /^[:,.()#-]$/.test(word) ? word : "[redacted]").join(" ")
          .replace(/(?:\[redacted\] ){2,}/g, "[redacted] ").trim().slice(0, 240) || "[redacted]";
        const rawSha256 = require("crypto").createHash("sha256").update(raw).digest("hex");
        process.stderr.write("SENTLOG_HEAVY_CDP_ERROR " + JSON.stringify({method, reason, rawSha256,
          messageCharacters: raw.length}) + "\n");
      }
    } catch (_) {}
  }
'''


def install_protocol_diagnostics():
    if os.environ.get('SENTLOG_HEAVY_PROTOCOL_DIAGNOSTICS') != '1':
        return dict(enabled=False)
    import playwright
    if importlib.metadata.version('playwright') != '1.57.0':
        raise RuntimeError('Heavy protocol diagnostics requires pinned Playwright 1.57.0')
    package = Path(playwright.__file__).resolve().parent / 'driver' / 'package'
    metadata = json.loads((package / 'package.json').read_text(encoding='utf-8'))
    if metadata.get('name') != 'playwright-core' or metadata.get('version') != DRIVER_VERSION:
        raise RuntimeError('Heavy protocol diagnostics driver package version changed')
    target = package / 'lib' / 'server' / 'chromium' / 'crExecutionContext.js'
    original = target.read_bytes()
    if hashlib.sha256(original).hexdigest() != DRIVER_SHA256:
        raise RuntimeError('Heavy protocol diagnostics compiled source fingerprint changed')
    source = original.decode('utf-8')
    if source.count(ANCHOR) != 1:
        raise RuntimeError('Heavy protocol diagnostics error-rewrite anchor changed')
    patched = source.replace(ANCHOR, HOOK + ANCHOR, 1).encode('utf-8')
    target.write_bytes(patched)
    return dict(enabled=True, pythonPackageVersion='1.57.0', driverVersion=DRIVER_VERSION,
                originalSha256=DRIVER_SHA256, patchedSha256=hashlib.sha256(patched).hexdigest(),
                maximumMessages=8, errorPrefix='SENTLOG_HEAVY_CDP_ERROR')
