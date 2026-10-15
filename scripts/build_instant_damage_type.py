"""Guarded Sentlog v1.45 UI update after existing v1.44 build steps.
Only changes version/cache markers. Real user projects/files are never touched.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'Instant-category integration mismatch: {path}: expected {count} for {old[:80]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))
change('sentlog/index.html',"'v1.44'","'v1.45'")
change('sentlog/index.html','phone-runtime.js?v=144','phone-runtime.js?v=145',2)
change('sentlog/phone-runtime.js','v1.44','v1.45',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v155';","const CACHE='sentlog-pwa-v156';")
change('tests/full_management.py',"window.SENTLOG_BUILD==='v1.44'","window.SENTLOG_BUILD==='v1.45'")
change('tests/full_archive_click.py',"window.SENTLOG_BUILD==='v1.44'","window.SENTLOG_BUILD==='v1.45'")
change('tests/capacity_ui.py',"window.SENTLOG_BUILD==='v1.44'","window.SENTLOG_BUILD==='v1.45'")
change('tests/shape_move_ui.py',"window.SENTLOG_BUILD==='v1.44'","window.SENTLOG_BUILD==='v1.45'")
change('tests/capacity.test.cjs',"'v1.44'","'v1.45'")
change('tests/resilience.test.cjs',"'v1.44'","'v1.45'",1)
print('Built Sentlog v1.45: damage category instantly updates labels and numbering')
