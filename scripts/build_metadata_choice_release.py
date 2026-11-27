"""Publish stable metadata choices after the complete v2.12 checks finish."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MODULE = 'delta-sync-metadata-ui'
OLD_TOKEN = '20261121-heavy-sync'
TOKEN = '20261127-metadata-choice-213'
MARKER = 'SentlogDeltaMetadataStableUI'
OLD_LABEL = 'v2.12 · 添付の再試行と写真受信を改善'
LABEL = 'v2.13 · 同期中の設定選択を改善'
OLD_CACHE = 'sentlog-pwa-v254'
CACHE = 'sentlog-pwa-v255'

# Only these tests run against the final release identities. Older archive
# workflows keep their own build stages and expectations.
# Counts are: cache generation, quoted app version, phone URL, release label.
TEST_IDENTITIES = {
    'tests/storage_recovery_release.test.cjs': (1, 1, 1, 1),
    'tests/startup_protection_release.test.cjs': (1, 0, 0, 0),
    'tests/file_journal_wake_release.test.cjs': (1, 1, 1, 2),
    'tests/startup_backup_recovery_release.test.cjs': (1, 1, 1, 1),
    'tests/cloud_normalization_release.test.cjs': (1, 1, 1, 1),
    'tests/storage_lifecycle_release.test.cjs': (1, 1, 1, 1),
    'tests/pdf_save_failure_release.test.cjs': (1, 1, 1, 1),
    'tests/recovery_retry_release.test.cjs': (1, 1, 1, 1),
    'tests/drawing_export_ui.py': (0, 1, 0, 0),
}
IDENTITIES = (
    (OLD_CACHE, CACHE),
    ("'v2.12'", "'v2.13'"),
    ('phone-runtime.js?v=212', 'phone-runtime.js?v=213'),
    (OLD_LABEL, LABEL),
)
pending = {}


def source(name):
    return pending.get(name, (ROOT / name).read_text(encoding='utf-8'))


def change(name, old, new, count=1):
    value = source(name)
    if value.count(old) != count:
        raise RuntimeError(f'Metadata choice release integration changed: {name}: {old!r}')
    pending[name] = value.replace(old, new)


index = source('sentlog/index.html')
if ("['phone-runtime.js?v=212','v2.12']" not in index
        or MARKER in index
        or re.findall(r'sentlog-pwa-v\d+', source('sentlog/sw.js')) != [OLD_CACHE]):
    raise RuntimeError('Metadata choice release requires a fresh complete v2.12')

# The loader marker must identify the real fixed API. Do not manufacture a
# marker or capability for an old UI while assembling a newer shell.
subprocess.run(['node', '-e', """
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:{structuredClone}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),context,{filename:process.argv[1]});
const api=context.window.SentlogDeltaMetadataUI;
assert(api,'Metadata UI API is missing');
assert.equal(api.stableRenderVersion,1,'Stable metadata UI is required');
assert.equal(context.window.SentlogDeltaMetadataStableUI,api,'Stable metadata UI alias is required');
assert.equal(typeof api.update,'function');assert.equal(typeof api.clear,'function');
""", 'sentlog/' + MODULE + '.js'], cwd=ROOT, check=True)
if MARKER not in source('sentlog/' + MODULE + '.js'):
    raise RuntimeError('Stable metadata UI loader marker is missing')

old_url = MODULE + '.js?v=' + OLD_TOKEN
new_url = MODULE + '.js?v=' + TOKEN
boundary = r'(?<![A-Za-z0-9_.-])'
for page, count in [('sentlog/index.html', 2), ('sentlog-pc/index.html', 0),
                    ('sentlog/drawing-export-view.html', 0)]:
    references = re.findall(boundary + re.escape(MODULE) + r'\.js\?v=[A-Za-z0-9._-]+', source(page))
    if references != [old_url] * count:
        raise RuntimeError('Unexpected metadata UI references: ' + page)
    if count:
        change(page, old_url, new_url, count)
change('sentlog/index.html', "['" + new_url + "','SentlogDelta']",
       "['" + new_url + "','" + MARKER + "']")
change('sentlog/index.html', 'phone-runtime.js?v=212', 'phone-runtime.js?v=213', 2)
change('sentlog/index.html', "'v2.12'", "'v2.13'")
change('sentlog/phone-runtime.js', 'v2.12', 'v2.13', 4)
change('sentlog/phone-runtime.js', OLD_LABEL.replace('v2.12', 'v2.13'), LABEL)
change('sentlog-pc/index.html', OLD_LABEL, LABEL)
change('sentlog/sw.js', OLD_CACHE, CACHE)

# Keep every behavior assertion, fixture and capability matrix intact. These
# count-checked literal replacements do not scan or rewrite other tests.
for name, counts in TEST_IDENTITIES.items():
    for (old, new), count in zip(IDENTITIES, counts):
        change(name, old, new, count)

for name, value in pending.items():
    (ROOT / name).write_text(value, encoding='utf-8')
for module in [MODULE, 'phone-runtime']:
    subprocess.run(['node', '--check', 'sentlog/' + module + '.js'], cwd=ROOT, check=True)
print('Built v2.13: preserve metadata choices during repeated sync projections; ' + CACHE)
