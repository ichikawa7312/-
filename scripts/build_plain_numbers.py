"""v1.55: plain numeric labels, after v1.54. No numbering algorithm changes.
Only static source/build/test files are patched; no records or files migrated.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new,count=1):
 p=ROOT/path;s=p.read_text()
 if s.count(old)!=count:
  raise RuntimeError(f'Plain-number integration mismatch: {path}: expected {count} of {old[:80]!r}, got {s.count(old)}')
 p.write_text(s.replace(old,new))
old="""function circledNo(n){n=Number(n||0);if(n>=1&&n<=20)return String.fromCodePoint(0x2460+n-1);if(n>=21&&n<=35)return String.fromCodePoint(0x3251+n-21);if(n>=36&&n<=50)return String.fromCodePoint(0x32B1+n-36);return `(${n})`}
function autoLabelFor(s){return `${s.type||'変状'}${circledNo(s.typeNo)}`}"""
new="""function formatTypeNo(n){
  if(typeof n!=='number'&&typeof n!=='string')return '';
  const value=Number(n);
  return Number.isSafeInteger(value)&&value>0?String(value):'';
}
function autoLabelFor(s){
  if(!s)return '';
  // Numeric fields are authoritative; ignore a stale cached circled autoLabel.
  // Pure formatting: never assign numbers, mutate a record, or parse a user name.
  const number=formatTypeNo(s.typeNo);
  return number?`${s.type||'変状'}-${number}`:(s.autoLabel||s.no||'');
}"""
change('sentlog/part08.txt',old,new)
change('sentlog/part09.txt','const label=s.autoLabel||s.no;','const label=autoLabelFor(s);')
change('sentlog/part09.txt',"$('typeNo').value=s.autoLabel||autoLabelFor(s)","$('typeNo').value=autoLabelFor(s)",2)
change('sentlog/inspector-interaction.js',"const name=shape?(shape.autoLabel || shape.no || autoLabelFor(shape)):'';","const name=autoLabelFor(shape);")
change('sentlog/inspector-interaction.js',"$('typeNo').value=s.autoLabel||autoLabelFor(s)","$('typeNo').value=autoLabelFor(s)")
change('sentlog/label-settings.js',"const label=shape?(shape.autoLabel || shape.no || ''):'';","const label=autoLabelFor(shape);")
change('sentlog/damage-catalog.js','(shape.autoLabel||shape.type)','(autoLabelFor(shape)||shape.type)')
p='sentlog/index.html'
change(p,"[8,'damageLabelRole']","[8,'damageLabelRole'],[7,'function formatTypeNo(n){'],[8,'const label=autoLabelFor(s);']")
change(p,'inspector-interaction.js?v=124','inspector-interaction.js?v=155')
change(p,'label-settings.js?v=147','label-settings.js?v=155')
change(p,'damage-catalog.js?v=153','damage-catalog.js?v=155',2)
change(p,"['label-colors.js?v=154','SentlogLabelColors']", "['label-colors.js?v=154','SentlogLabelColors'],['inspector-interaction.js?v=155','autoLabelFor(s)'],['label-settings.js?v=155','autoLabelFor(shape)']")
change(p,"'v1.54'","'v1.55'")
change(p,'phone-runtime.js?v=154','phone-runtime.js?v=155',2)
change('sentlog/phone-runtime.js','v1.54','v1.55',4)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v165';","const CACHE='sentlog-pwa-v166';")
# Earlier tests run against the final built version, without changing assertions
# about geometry, identities, history, photo relationships or input handling.
for name in ('full_management.py','full_archive_click.py','capacity_ui.py','shape_move_ui.py','instant_damage_type_ui.py','overview_labels_ui.py','polygon_snap_ui.py','polygon_dimensions_ui.py','toolbar_icons_ui.py'):
 change('tests/'+name,"window.SENTLOG_BUILD==='v1.54'","window.SENTLOG_BUILD==='v1.55'")
for name in ('damage_catalog_ui.py','damage_styles_ui.py','label_colors_ui.py','toolbar_help_ui.py'):
 p='tests/'+name;n=(ROOT/p).read_text().count("window.SENTLOG_BUILD==='v1.54'")
 if not n:raise RuntimeError('Missing test version '+p)
 change(p,"window.SENTLOG_BUILD==='v1.54'","window.SENTLOG_BUILD==='v1.55'",n)
for name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs'):
 change('tests/'+name,"'v1.54'","'v1.55'")
for name in ('toolbar_icons.test.cjs','damage_styles.test.cjs','label_colors.test.cjs'):
 change('tests/'+name,'sentlog-pwa-v165','sentlog-pwa-v166')
change('tests/damage_styles.test.cjs','damage-catalog.js?v=153','damage-catalog.js?v=155')
change('tests/instant_damage_type.test.cjs','function circledNo(n){','function formatTypeNo(n){')
for name in ('instant_damage_type.test.cjs','instant_damage_type_ui.py'):
 p='tests/'+name
 for old,new in [('ひび割れ①','ひび割れ-1'),('ひび割れ②','ひび割れ-2'),('浮き①','浮き-1'),('浮き②','浮き-2'),('浮き③','浮き-3')]:
  n=(ROOT/p).read_text().count(old)
  if not n:raise RuntimeError('Missing expected label '+p+' '+old)
  change(p,old,new,n)
# Isolated render/size tests now load the same pure formatter used by the app.
# Keep their old cached-label fixtures: missing numeric fields retain fallback.
helper="const numberingSource=fs.readFileSync('sentlog/part08.txt','utf8');\nconst numberingCode=numberingSource.slice(numberingSource.indexOf('function formatTypeNo(n){'),numberingSource.indexOf('function formatGlobalNo(n){'));\n"
change('tests/leader_line_width.test.cjs','vm.runInContext(renderCode,ctx);',helper+'vm.runInContext(numberingCode+renderCode,ctx);')
change('tests/compact_labels.test.cjs','ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);',helper+'ctx.window=ctx;vm.createContext(ctx);vm.runInContext(numberingCode+code,ctx);')
print('Built Sentlog v1.55: type-1/type-1000 labels; stale label caches ignored for display; numeric fields, numbering rules, photos and geometry unchanged')
