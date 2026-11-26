"""Reserve known photo rows after the complete startup-protection build.

Only presentation changes: preserve the ordered metadata, handlers, sequential
Blob reads, render-generation checks and object-URL ownership. No release or
cache version is changed here.
"""
import hashlib
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-photo-grid-layout-v1'
HISTORICAL_SHA256 = 'd4d73469abf73358027c29a1f473dcc358644722e4f16f15755bd27e97278afe'
FIXTURE = 'tests/fixtures/render_selected_photos_v205.js'
OLD_OWNERSHIP_SHA256 = 'b9ead633058149a8d06251e16423df2ff70bb9721ccbee74f71dea9864e028cf'
NEW_OWNERSHIP_SHA256 = 'd8b7e5d91f3b7332960f9210274b409871c37943ce99081e816960bd2c2aca7a'


def ownership_hash(source):
    # Match the existing ownership gates' exact, previously reviewed camera
    # presentation normalization. Every other byte remains under the hash.
    source = source.replace(
        'const photos=window.SentlogPhotoDisplayOrder?.ordered(s?.photos||[])||(s?.photos||[]).slice();',
        'const photos=s?.photos||[];').replace('// sentlog-camera-order-return-v1\n', '')
    return hashlib.sha256(source.encode()).hexdigest()


def historical_render(root):
    data = (root / FIXTURE).read_bytes()
    if hashlib.sha256(data).hexdigest() != HISTORICAL_SHA256:
        raise RuntimeError('Historical photo renderer fixture changed')
    return data.decode('utf-8')


def reserve_slots(source):
    """Split the exact historical creation/read loop without rewriting either."""
    loop = '  for(const meta of photos){\n'
    read = '    try{const blob=await getPhotoBlob(meta.id);'
    if source.count(loop) != 1 or source.count(read) != 1:
        raise RuntimeError('Photo renderer loop changed')
    start, read_at = source.index(loop), source.index(read)
    if read_at <= start or not source.endswith('\n  }\n}\n'):
        raise RuntimeError('Photo renderer boundaries changed')
    creation = source[start + len(loop):read_at]
    if creation.count('grid.appendChild(item);') != 1 or 'await ' in creation:
        raise RuntimeError('Photo placeholder creation changed')
    return (source[:start]
            + '  // Reserve every known fixed-aspect slot before any Blob wait.\n'
            + '  const slots=[];\n' + loop + creation
            + '    slots.push({meta,img});\n  }\n'
            + '  for(const {meta,img} of slots){\n'
            + '    if(seq!==photoRenderSeq)return;\n'
            + source[read_at:])


def integrate(root=ROOT):
    part_path, index_path = root / 'sentlog/part06.txt', root / 'sentlog/index.html'
    part, index = part_path.read_text(), index_path.read_text()
    old = historical_render(root)
    gate = 'for(const [i,token] of ['
    if ('sentlog-startup-protection-v206' not in index
            or "['phone-runtime.js?v=206','v2.06']" not in index
            or '// sentlog-camera-order-return-v1\n' not in part
            or MARKER in part or MARKER in index
            or part.count(old) != 1 or index.count(gate) != 1
            or ownership_hash(part) != OLD_OWNERSHIP_SHA256):
        raise RuntimeError('Photo grid layout requires one fresh, complete v2.06 startup-protection build')

    updated_part = part.replace(old, '// ' + MARKER + '\n' + reserve_slots(old))
    updated_index = index.replace(gate, gate + "[5,'" + MARKER + "'],")
    if ownership_hash(updated_part) != NEW_OWNERSHIP_SHA256:
        raise RuntimeError('The reviewed photo-layout change produced unexpected ownership bytes')
    updated_tests = {}
    for name in ['single_number_ui.test.cjs', 'optional_symbol_ui.test.cjs']:
        path = root / 'tests' / name
        value = path.read_text()
        if value.count(OLD_OWNERSHIP_SHA256) != 1:
            raise RuntimeError('Photo ownership validation gate changed: ' + name)
        updated_tests[path] = value.replace(OLD_OWNERSHIP_SHA256, NEW_OWNERSHIP_SHA256)
    # Validate the same joined script the production loader executes before
    # writing either file. Part boundaries can fall inside JS identifiers.
    joined = ''.join(updated_part if number == 6 else
                     (root / 'sentlog' / f'part{number:02d}.txt').read_text()
                     for number in range(1, 10))
    for label, html in [('joined application', joined), ('loader', updated_index)]:
        scripts = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script\s*>', html, re.S | re.I)
        if not scripts:
            raise RuntimeError('Missing inline script in ' + label)
        for script in scripts:
            subprocess.run(['node', '--check'], input=script, text=True, cwd=root, check=True)
    part_path.write_text(updated_part)
    index_path.write_text(updated_index)
    for path, value in updated_tests.items():
        path.write_text(value)
    print('Built stable photo grid rows; Blob reads and release/cache versions unchanged')


if __name__ == '__main__':
    integrate()
