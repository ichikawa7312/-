"""Connect the high-quality file-backed ledger only after the existing build."""
from pathlib import Path
import json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
S=ROOT/'sentlog'
TOKEN='20261125-ledger-hq-1'
def change(s,a,b,count=1):
    if s.count(a)!=count: raise RuntimeError(f'ledger anchor mismatch: {a[:100]}: {s.count(a)}')
    return s.replace(a,b)
p=S/'photo-ledger.js';s=p.read_text(encoding='utf-8')
s=change(s,'  async function zipStored(files){', '''  const isPreparedPhoto=v=>v instanceof Uint8Array&&v.length>0||root.SentlogLedgerStream?.valid(v)===true;
  async function zipStored(files){
    if(files.some(([,v])=>!(v instanceof Uint8Array)&&root.SentlogLedgerStream?.valid(v)===true)){
      return root.SentlogLedgerStream.zip(files,{signal:current?.abort?.signal,confirmPrevious:()=>{
        if(!confirm('前回のExcelは保存済みですか？ 保存済み、または再作成してよい場合のみOKを押してください。元写真・記録は変更しません。'))return false;
        if(current?.downloadUrl){URL.revokeObjectURL(current.downloadUrl);current.downloadUrl=null;}modal?.querySelector('.ledger-download-ready')?.remove();return true;
      }});
    }''')
s=change(s,'!(p.jpeg instanceof Uint8Array)||!p.jpeg.length','!isPreparedPhoto(p.jpeg)')
s=change(s,'const pure={OTHER,MAX_PHOTOS,','const pure={isPreparedPhoto,OTHER,MAX_PHOTOS,')
start=s.index('  async function preparePhotos(entries){');end=s.index('  function download(blob,filename){',start)
s=s[:start]+'''  async function preparePhotos(entries){
    const stream=root.SentlogLedgerStream;if(!stream||stream.version!=='20261125-ledger-hq-1')throw Error('高画質出力機能が未更新です。アプリを更新してください。');
    for(const entry of entries){
      const {drawingId,photoId}=entry;
      entry.jpeg=stream.photo(()=>loadShared(drawingId,photoId),entry.damage+' / '+entry.sheetName,(n,total)=>status('高画質Excelに写真を書き出しています… '+n+' / '+total));
    }
    return {missing:[]};
  }
'''+s[end:]
s=change(s,'if(!modal)return;\n    try{const blob=await loadShared','if(!modal||current?.exporting)return;\n    try{const blob=await loadShared')
s=change(s,'if(!modal||!img.isConnected)return;','if(!modal||current?.exporting||!img.isConnected)return;')
s=change(s,'current.exporting=true;const btn=modal.querySelector','let focusAfter=null;current.exporting=true;current.abort=new AbortController();const btn=modal.querySelector')
s=change(s,'btn.disabled=true;updateSelectionControls();',"btn.disabled=true;updateSelectionControls();cleanPreview();modal.querySelectorAll('.ledger-thumb').forEach(img=>img.removeAttribute('src'));modal.querySelector('.ledger-cancel').hidden=false;")
s=change(s,'finally{for(const e of entries)delete e.jpeg;current.exporting=false;btn.disabled=false;updateSelectionControls();}',"finally{for(const e of entries)delete e.jpeg;current.exporting=false;current.abort=null;modal.querySelector('.ledger-cancel').hidden=true;btn.disabled=false;renderEntries();updateSelectionControls();if(focusAfter)focusLedgerField(...focusAfter);}")
s=change(s,"focusLedgerField(pending[0].key,current.format==='visual3'?'notes':'description');return;","focusAfter=[pending[0].key,current.format==='visual3'?'notes':'description'];return;")
s=change(s,"if(e?.ledgerEntryKey)focusLedgerField(e.ledgerEntryKey,e.ledgerField);","if(e?.ledgerEntryKey)focusAfter=[e.ledgerEntryKey,e.ledgerField];")
s=change(s,'function moveGroup(name,dir){const a=','function moveGroup(name,dir){if(current?.exporting)return;const a=')
s=change(s,'function movePhoto(entry,dir){const same=','function movePhoto(entry,dir){if(current?.exporting)return;const same=')
s=change(s,'formatSelect.onchange=()=>{c.format=','formatSelect.onchange=()=>{if(current?.exporting){formatSelect.value=c.format;return;}c.format=')
s=change(s,"modal.querySelectorAll('.ledger-item input[type=checkbox]').forEach(box=>box.disabled=current.exporting);","""modal.querySelectorAll('.ledger-item input[type=checkbox]').forEach(box=>box.disabled=current.exporting);
    for(const control of modal.querySelectorAll('[data-ledger=format],.ledger-item textarea,.ledger-item input:not([type=checkbox]),.ledger-item select,.ledger-order button,.ledger-section-head button,.ledger-tensile-inner input,.ledger-tensile-inner select,.ledger-save')){if(current.exporting){if(control.dataset.ledgerWasDisabled===undefined)control.dataset.ledgerWasDisabled=String(control.disabled);control.disabled=true;}else if(control.dataset.ledgerWasDisabled!==undefined){control.disabled=control.dataset.ledgerWasDisabled==='true';delete control.dataset.ledgerWasDisabled;}}""")
s=change(s,"controls.lastChild.dataset.ledger='export';","controls.lastChild.dataset.ledger='export';const cancel=button('出力中止',()=>current?.abort?.abort(),'ledger-cancel');cancel.hidden=true;controls.append(cancel);")
# The template/render code remains unchanged; only accept a branded lazy photo reference.
p.write_text(s,encoding='utf-8')
for name,expected in [('damage',3),('tensile',2),('visual3',2)]:
    p=S/f'photo-ledger-{name}.js';s=p.read_text(encoding='utf-8')
    s,n=re.subn(r'!\((\w+)\.jpeg instanceof Uint8Array\)\|\|!\1\.jpeg\.length',r'!(\1.jpeg instanceof Uint8Array&&\1.jpeg.length||root.SentlogLedgerStream?.valid(\1.jpeg)===true)',s)
    if n!=expected:raise RuntimeError('ledger photo validation anchor mismatch '+name)
    p.write_text(s,encoding='utf-8')
p=S/'index.html';s=p.read_text(encoding='utf-8')
versions=set(re.findall(r'(photo-ledger(?:-damage|-tensile|-visual3)?\.js)\?v=([A-Za-z0-9._-]+)',s))
s=re.sub(r'(photo-ledger(?:-damage|-tensile|-visual3)?\.js\?v=)[A-Za-z0-9._-]+',lambda m:m[1]+TOKEN,s)
anchor=r'<script src=\"./photo-ledger.js?v='+TOKEN+r'\">'
s=change(s,anchor,r'<script src=\"./photo-ledger-stream.js?v='+TOKEN+r'\"><\/script>'+anchor)
p.write_text(s,encoding='utf-8')
p=S/'sw.js';s=p.read_text(encoding='utf-8');s=change(s,"'photo-ledger.js'","'photo-ledger-stream.js','photo-ledger.js'")
old=re.search(r'sentlog-pwa-v\d+',s).group();new='sentlog-pwa-v'+str(int(old.rsplit('v',1)[1])+1)
p.write_text(s.replace(old,new),encoding='utf-8')
for path in (ROOT/'tests').iterdir():
    if path.suffix not in ('.cjs','.py'):continue
    s=path.read_text(encoding='utf-8');v=s.replace(old,new)
    for name,version in versions:
        v=v.replace(name+'?v='+version,name+'?v='+TOKEN)
        v=v.replace(name.replace('.js',r'\.js')+r'\?v='+version,name.replace('.js',r'\.js')+r'\?v='+TOKEN)
    if v!=s:path.write_text(v,encoding='utf-8')
# Inline the already tested ZIP library into the worker payload. The optional
# ledger script is available offline; export must not fetch more scripts.
stream=S/'photo-ledger-stream.js'
source=stream.read_text(encoding='utf-8')
payload=(S/'original-photo-zip.js').read_text(encoding='utf-8')+'\n'+source
stream.write_text(change(source,'const WORKER_CODE=null;', 'const WORKER_CODE='+json.dumps(payload,ensure_ascii=True)+';'),encoding='utf-8')
for name in ['photo-ledger','photo-ledger-damage','photo-ledger-tensile','photo-ledger-visual3','photo-ledger-stream']:
    subprocess.run(['node','--check','sentlog/'+name+'.js'],cwd=ROOT,check=True)
print('Built high-quality photo ledger: lazy image references, existing workbook templates, file-backed ZIP')
