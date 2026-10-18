"""Integrate v1.79 CAD layer names after the v1.78 DXF build."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
pending={}
def change(path,old,new,count=1):
 text=pending.get(path,(ROOT/path).read_text())
 if text.count(old)!=count:raise RuntimeError(f'DXF layers integration mismatch: {path}: {old[:80]!r}')
 pending[path]=text.replace(old,new)

for name in ('dxf','dxf-core','phone-runtime'):
 change('sentlog/index.html',f'{name}.js?v=178',f'{name}.js?v=179',2)
change('sentlog/index.html',"['phone-runtime.js?v=179','v1.78']","['phone-runtime.js?v=179','v1.79']")
change('sentlog/phone-runtime.js','v1.78','v1.79',4)
change('sentlog/index.html','field-records.js?v=168','field-records.js?v=179',2)
change('sentlog/sw.js',"const CACHE='sentlog-pwa-v189';","const CACHE='sentlog-pwa-v190';")
# Add ownership only; geometry, interaction, storage and display stay identical.
change('sentlog/part09.txt','b.textContent=`📷${photoN}`;svg.appendChild(b);','b.dataset.dxfPhotoCountId=s.id;b.textContent=`📷${photoN}`;svg.appendChild(b);')
change('sentlog/field-records.js',"      if(s.recordType==='photo')drawPhotoRecord(s);\n      else if(s.displayKind==='arrow')drawSurveyArrow(s);\n      else drawSurveyPoint(s);", "      const last=svg.lastElementChild;\n      if(s.recordType==='photo')drawPhotoRecord(s);\n      else if(s.displayKind==='arrow')drawSurveyArrow(s);\n      else drawSurveyPoint(s);\n      for(let e=last?last.nextElementSibling:svg.firstElementChild;e;e=e.nextElementSibling)e.dataset.dxfFieldRecordId=s.id;")
for path in (ROOT/'tests').iterdir():
 if path.suffix not in ('.py','.cjs'):continue
 text=path.read_text();updated=text.replace("SENTLOG_BUILD==='v1.78'","SENTLOG_BUILD==='v1.79'").replace('sentlog-pwa-v189','sentlog-pwa-v190')
 if path.name in ('capacity.test.cjs','resilience.test.cjs','toolbar_icons.test.cjs','label_colors.test.cjs','plain_numbers.test.cjs','single_number_ui.test.cjs','optional_symbol_ui.test.cjs'):updated=updated.replace("'v1.78'","'v1.79'")
 updated=updated.replace(r'phone-runtime\.js\?v=178',r'phone-runtime\.js\?v=179').replace(r'field-records\.js\?v=168',r'field-records\.js\?v=179')
 if updated!=text:pending[str(path.relative_to(ROOT))]=updated
for path,text in pending.items():(ROOT/path).write_text(text)
print('Built Sentlog v1.79: unbranded Japanese CAD layers by damage type and annotation purpose')
