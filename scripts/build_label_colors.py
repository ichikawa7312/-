"""Guarded v1.54 integration after v1.53; display nodes only, no migrations."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:raise RuntimeError(f'Label color integration mismatch: {path}: expected {count} of {old[:80]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))
p='sentlog/part09.txt'
# Stable record association; never infer a label from DOM order or label text.
change(p,"leader.style.pointerEvents='none';", "leader.dataset.damageLabelId=s.id;leader.dataset.damageLabelRole='leader';\n        leader.style.pointerEvents='none';")
change(p,"if(markerEl){markerEl.style.pointerEvents='none';svg.appendChild(markerEl)}", "if(markerEl){markerEl.dataset.damageLabelId=s.id;markerEl.dataset.damageLabelRole='marker';markerEl.dataset.damageMarkerKind=state.leaderMarker||'open-circle';markerEl.style.pointerEvents='none';svg.appendChild(markerEl)}")
change(p,'t.textContent=label;svg.appendChild(t);', "t.dataset.damageLabelId=s.id;t.dataset.damageLabelRole='name';t.textContent=label;svg.appendChild(t);")
p='sentlog/index.html'
change(p,"[8,'window.sentlogAppReady']", "[8,'window.sentlogAppReady'],[8,'damageLabelRole']")
change(p,"['damage-styles.js?v=153','SentlogDamageStyles']", "['damage-styles.js?v=153','SentlogDamageStyles'],['label-colors.js?v=154','SentlogLabelColors']")
change(p,'<script src="./damage-styles.js?v=153"><\\/script>', '<script src="./damage-styles.js?v=153"><\\/script><script src="./label-colors.js?v=154"><\\/script>')
change(p,"'v1.53'","'v1.54'")
change(p,'phone-runtime.js?v=153','phone-runtime.js?v=154',2)
change('sentlog/phone-runtime.js','v1.53','v1.54',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v164';","const CACHE='sentlog-pwa-v165';")
change('sentlog/sw.js',"'damage-styles.js','record-store.js'","'damage-styles.js','label-colors.js','record-store.js'")
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py','toolbar_icons_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.53'","window.SENTLOG_BUILD==='v1.54'")
for name in ('damage_catalog_ui.py','damage_styles_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.53'","window.SENTLOG_BUILD==='v1.54'",2)
p='tests/toolbar_help_ui.py';n=(ROOT/p).read_text().count("window.SENTLOG_BUILD==='v1.53'")
if not n:raise RuntimeError('Missing help test version')
change(p,"window.SENTLOG_BUILD==='v1.53'","window.SENTLOG_BUILD==='v1.54'",n)
for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs'):
 change('tests/'+name,"'v1.53'","'v1.54'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs'):
 change('tests/'+name,'sentlog-pwa-v164','sentlog-pwa-v165')
print('Built Sentlog v1.54: color-connected names/numbers/leaders/tips; white glyph outline; monochrome/original black; no record writes')
