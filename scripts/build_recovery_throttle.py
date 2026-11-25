"""Apply bounded PDF/photo recovery after all existing production builders.

Fail closed on changed integration points. No data formats, ACK guards,
storage deletion guards, local write paths or authorization are changed.
"""
from pathlib import Path
import re, subprocess

ROOT=Path(__file__).resolve().parents[1]
TOKEN='20261125-recovery-guard-1'
guard=(ROOT/'sentlog/recovery-throttle.js').read_text(encoding='utf-8').strip()
pending={}
def source(path):
    return pending.get(path,(ROOT/path).read_text(encoding='utf-8'))
def change(path,old,new,count=1):
    text=source(path)
    if text.count(old)!=count:
        raise RuntimeError(f'Recovery load integration changed: {path}: {old[:120]!r}: {text.count(old)}')
    pending[path]=text.replace(old,new)

p='sentlog/pdf-recovery.js'
change(p,'let busy=false;',guard+'\nconst deliveryGuard=createSentlogDeliveryGuard();\nlet busy=false;')
change(p,'  busy=true;\n  try{','  if(!deliveryGuard.begin(JSON.stringify([s.user?.id,id])))return;\n  busy=true;let cycleFailed=false;\n  try{')
# Only another device needs the local sender. Own requests still proceed
# through the existing durable hash verification and acknowledgement below.
change(p,"    const needed=new Set((requests||[]).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));",
         "    const needed=new Set((requests||[]).filter(r=>r.device_id!==id).map(r=>r.asset_id+':'+String(r.expected_sha256).toLowerCase()));")
change(p,'    for(const a of pending){','    for(const a of deliveryGuard.order(pending)){')
change(p,"      if(IS_PC && a.status!=='storage_deleted')continue;",
         "      if(IS_PC && a.status!=='storage_deleted')continue;\n      if(deliveryGuard.full())break;\n      if(!deliveryGuard.take(a))continue;")
change(p,"catch(e){supplyErrors.push((a.file_name||'図面PDF')+'：'+e.message);console.warn('PDF re-delivery',a.id,e.message)}",
         "catch(e){if(deliveryGuard.isTransient(e))throw e;supplyErrors.push((a.file_name||'図面PDF')+'：'+e.message);console.warn('PDF re-delivery',a.id,e.message)}")
change(p,"}catch(e){errors++;console.warn('PDF receive',a.id,e.message)}",
         "}catch(e){if(deliveryGuard.isTransient(e))throw e;errors++;console.warn('PDF receive',a.id,e.message)}")
change(p,"}catch(e){status('PDF同期の確認が必要です：'+e.message)}finally{busy=false}",
         "}catch(e){cycleFailed=true;deliveryGuard.fail(e);status('PDF同期の確認が必要です：'+e.message)}finally{if(!cycleFailed)deliveryGuard.complete();busy=false}")
# Do not rewrite an already outstanding request on every background poll.
# The original explicit recovery authorization and ACK path remain intact.
change(p,"          await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});\n          missing++;",
         "          if(!requestedForThisDevice.has(a.id+':'+String(a.sha256).toLowerCase()))await rpc('sentlog_request_pdf',{p_asset_id:a.id,p_device_id:id});\n          missing++;")
p='sentlog/peer-photo-recovery.js'
change(p," let busy=false,message='',uploadedTotal=0;",
         guard+"\n const deliveryGuard=createSentlogDeliveryGuard();\n let busy=false,message='',uploadedTotal=0;")
change(p,"     if(!r.ok)throw Error(data.message||('通信エラー '+r.status));return data;",
         "     if(!r.ok){const error=Error(data.message||('通信エラー '+r.status));error.status=r.status;throw error;}return data;")
change(p,"     if(!r.ok)throw Error('写真の再送に失敗しました（'+r.status+'）。通信を確認して再試行してください。');",
         "     if(!r.ok){const error=Error('写真の再送に失敗しました（'+r.status+'）。通信を確認して再試行してください。');error.status=r.status;throw error;}")
change(p,"   busy=true;\n   try{",
         "   if(!deliveryGuard.begin(JSON.stringify([sessions()?.user?.id,id])))return;\n   busy=true;let cycleFailed=false;\n   try{")
change(p,"     const ids=[...desired.keys()];let sent=0,errors=[],checked=0;",
         "     const ids=deliveryGuard.order([...desired.keys()]);let sent=0,errors=[],checked=0;")
change(p,"       for(const a of assets){",
         "       for(const a of deliveryGuard.order(assets)){")
change(p,"||sent>=8)break outer;",
         "||sent>=8||deliveryGuard.full())break outer;")
change(p,"         checked++;",
         "         if(!deliveryGuard.take(a))continue;\n         checked++;")
change(p,"catch(e){errors.push(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message);}",
         "catch(e){if(deliveryGuard.isTransient(e))throw e;errors.push(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message);}")
change(p,"}catch(e){show('写真補完の確認：'+(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message));}",
         "}catch(e){cycleFailed=true;deliveryGuard.fail(e);show('写真補完の確認：'+(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message));}")
change(p,"   finally{busy=false;}",
         "   finally{if(!cycleFailed)deliveryGuard.complete();busy=false;}")
# Version every loader reference and corresponding existing test expectation.
versions=set()
for page in ['sentlog/index.html','sentlog-pc/index.html']:
    text=source(page)
    for name in ['pdf-recovery','peer-photo-recovery']:
        pattern=r'(?<!peer-)'+re.escape(name)+r'\.js\?v=([A-Za-z0-9._-]+)'
        for old in re.findall(pattern,text):
            versions.add((name,old))
        text=re.sub(pattern,name+'.js?v='+TOKEN,text)
    pending[page]=text
worker=source('sentlog/sw.js')
old_cache=re.search(r'sentlog-pwa-v\d+',worker).group()
new_cache='sentlog-pwa-v'+str(int(old_cache.rsplit('v',1)[1])+1)
pending['sentlog/sw.js']=worker.replace(old_cache,new_cache)
for f in (ROOT/'tests').iterdir():
    if f.suffix not in ('.cjs','.py'):continue
    path=str(f.relative_to(ROOT));old=source(path);new=old.replace(old_cache,new_cache)
    for name,version in versions:
        new=new.replace(name+'.js?v='+version,name+'.js?v='+TOKEN)
        new=new.replace(name+r'\.js\?v='+version,name+r'\.js\?v='+TOKEN)
    if new!=old:pending[path]=new
for path,text in pending.items():
    (ROOT/path).write_text(text,encoding='utf-8')
for path in ['sentlog/pdf-recovery.js','sentlog/peer-photo-recovery.js','sentlog/recovery-throttle.js']:
    subprocess.run(['node','--check',path],cwd=ROOT,check=True)
subprocess.run(['node','tests/recovery_throttle.test.cjs'],cwd=ROOT,check=True)
print('Built bounded fair PDF/photo recovery; existing byte checks and data guards retained')
