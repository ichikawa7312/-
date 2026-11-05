"""Raise DXF import/parse/raster-sync ceiling to the existing 25 MiB bucket limit.

Run after build_dxf_raster.py. Do not mutate the guarded source baseline:
the archive/build scripts verify its SHA before constructing the published app.
Original DXF, CAD raster references and inspection records are never rewritten.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 25 * 1024 * 1024

def change(path, before, after):
    file = ROOT / path
    current = file.read_text(encoding='utf-8')
    found = current.count(before)
    if found != 1:
        raise RuntimeError('DXF capacity integration mismatch: ' + path + ' count=' + str(found))
    file.write_text(current.replace(before, after, 1), encoding='utf-8')

change('sentlog/dxf-core.js',
       "bytes.length>8*1024*1024)throw Error('DXFは8MB以下に分けて取り込んでください。')",
       "bytes.length>25*1024*1024)throw Error('DXFは25MB以下のファイルを選んでください。')")
change('sentlog/dxf.js',
       "if(file.size>8*1024*1024)throw Error('DXFは8MB以下に分けて取り込んでください。');",
       "if(file.size>25*1024*1024)throw Error('DXFは25MB以下のファイルを選んでください。');")
# Make the larger file's drawing engine timeout explicit and bounded.
change('sentlog/dxf.js',
       ")),45000);",
       ")),file.size>8*1024*1024?90000:45000);")
# This skip also prevented linked TIFF/PNG image sync even after DXF import.
change('sentlog/dxf-raster.js',
       "source.size>8*1024*1024)continue;",
       "source.size>25*1024*1024)continue;")
# Existing core regression included a hard-coded 8 MiB rejection assertion.
change('tests/dxf.test.cjs',
       "C.scan(new Uint8Array(8*1024*1024+1)),/8MB/",
       "C.scan(new Uint8Array(25*1024*1024+1)),/25MB/")

for file in ('sentlog/dxf-core.js', 'sentlog/dxf.js', 'sentlog/dxf-raster.js'):
    subprocess.run(['node', '--check', file], cwd=ROOT, check=True)
subprocess.run(['node', 'tests/dxf_size.test.cjs'], cwd=ROOT, check=True)
print('DXF import, core validation and TIFF reference sync now accept up to 25 MiB; all source bytes retained')
