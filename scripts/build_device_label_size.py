"""Keep annotation label size device-local without weakening shared-record conflict checks.

Run after the existing guarded production builders. No data or tables are
migrated. Legacy cloud snapshots may contain labelSize; when received they
are ignored, while old local drawings retain their own choice. Historical
snapshot fingerprints are deliberately left unchanged for verified base merge.
"""
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
def change(path,old,new):
    p=ROOT/path
    content=p.read_text(encoding='utf-8')
    if content.count(old)!=1:
        raise RuntimeError('Device label-size integration mismatch: '+path+' '+repr(old[:70])+' ('+str(content.count(old))+')')
    p.write_text(content.replace(old,new,1),encoding='utf-8')

# Do not send local text-size preferences to Supabase. Other drawing state,
# annotations, photos, page rotations and PDF geometry remain unchanged.
change('sentlog/cloud-sync.js',
       "    const safe=typeof structuredClone==='function'?structuredClone(st):JSON.parse(JSON.stringify(st));\n    (safe.shapes||[]).forEach",
       "    const safe=typeof structuredClone==='function'?structuredClone(st):JSON.parse(JSON.stringify(st));\n    delete safe.labelSize; // per-device presentation, not a shared edit\n    (safe.shapes||[]).forEach")

# Ignore the display size ONLY inside the sync merger, never coordinates,
# shape positions, photographs or the shared document layout.
change('sentlog/sync-merge.js',
       "const viewKeys=['currentPage','width','height','pdfPageInfo','nextGlobalNo','typeCounters'];",
       "const viewKeys=['currentPage','width','height','pdfPageInfo','nextGlobalNo','typeCounters','labelSize'];")
# A same-content fast path may return the legacy remote state wholesale.
# Scrub presentation data from the final shared merge payload in all paths.
change('sentlog/sync-merge.js',
       '    for(const d of ds){\n      // Match the editor',
       '    for(const d of ds){\n      delete d.state.labelSize;\n      // Match the editor')

# Preserve old snapshotText() hashing so existing checkpoint fingerprint
# verification still recognizes its baseline, even if it contains a historical
# shared labelSize. Only local dirty-checks ignore this view preference.
change('sentlog/sync-view.js',
       '  function canonical(value){',
       """  const validLabelSize=x=>x==='small'||x==='normal'||x==='large';
  function deviceContent(value){
    const result=content(value);
    if(result)delete result.labelSize;
    return result;
  }
  function canonical(value){""")
change('sentlog/sync-view.js',
       'same(content(before),content(state))',
       'same(deviceContent(before),deviceContent(state))')
change('sentlog/sync-view.js',
       'const changed=!same(content(state),content(incoming));',
       'const changed=!same(deviceContent(state),deviceContent(incoming));')

change('sentlog/sync-view.js',
       """  function localView(incoming,old){
    if(!incoming || !old)return incoming;
    return {...incoming,currentPage:Math.min(Math.max(1,old.currentPage||1),incoming.pageCount||1),
      width:old.width,height:old.height,pdfPageInfo:{...(incoming.pdfPageInfo||{}),...(old.pdfPageInfo||{})}};
  }""",
       """  function localView(incoming,old){
    if(!incoming)return incoming;
    // Legacy cloud data may still contain another device's display size.
    const local={...incoming};delete local.labelSize;
    if(!old)return local;
    return {...local,currentPage:Math.min(Math.max(1,old.currentPage||1),incoming.pageCount||1),
      width:old.width,height:old.height,pdfPageInfo:{...(incoming.pdfPageInfo||{}),...(old.pdfPageInfo||{})},
      ...(validLabelSize(old.labelSize)?{labelSize:old.labelSize}:{})};
  }""")
change('sentlog/sync-view.js',
       'state={...freshDrawingState(project.name),...clone(incoming),currentPage:keep.page,width:keep.width,height:keep.height,',
       "state={...freshDrawingState(project.name),...clone(incoming),labelSize:validLabelSize(state.labelSize)?state.labelSize:'normal',currentPage:keep.page,width:keep.width,height:keep.height,")

change('sentlog/label-settings.js',
       "help.textContent='この図面の全ページに適用。全体表示でも拡大しても文字が大きくなりすぎない設定です。';",
       "help.textContent='文字サイズはこの端末だけの設定です。iPhoneは「小」、iPadは「標準」など別々に設定できます。';")

# Force new client modules to be fetched on every device after publishing.
# Do not touch record-store format or device registrations.
index=ROOT/'sentlog/index.html'
html=index.read_text(encoding='utf-8')
versions={}
for name in ('sync-view','sync-merge','cloud-sync','label-settings'):
    old_versions=re.findall(re.escape(name)+r'\.js\?v=([0-9A-Za-z._-]+)',html)
    if not old_versions or len(set(old_versions))!=1:
        raise RuntimeError('Device label-size runtime preflight mismatch: '+name+' '+str(old_versions))
    old=old_versions[0]
    new='20261105-device-label-207' if name=='cloud-sync' else '207'
    versions[name]=(old,new)
    html=html.replace(f'{name}.js?v={old}',f'{name}.js?v={new}')
index.write_text(html,encoding='utf-8')

sw=ROOT/'sentlog/sw.js'
worker=sw.read_text(encoding='utf-8')
m=re.search(r'sentlog-pwa-v(\d+)',worker)
if not m:raise RuntimeError('Device label-size service-worker version missing')
old_cache=m.group(0)
new_cache='sentlog-pwa-v'+str(int(m.group(1))+1)
sw.write_text(worker.replace(old_cache,new_cache),encoding='utf-8')
for test in (ROOT/'tests').iterdir():
    if test.suffix not in ('.py','.cjs'):continue
    value=test.read_text(encoding='utf-8')
    for name,(old,new) in versions.items():
        value=value.replace(f'{name}.js?v={old}',f'{name}.js?v={new}')
        value=value.replace(name+r'\.js\?v='+old,name+r'\.js\?v='+new)
    value=value.replace(old_cache,new_cache)
    test.write_text(value,encoding='utf-8')

for file in ('sentlog/sync-view.js','sentlog/sync-merge.js','sentlog/cloud-sync.js','sentlog/label-settings.js'):
    subprocess.run(['node','--check',file],cwd=ROOT,check=True)
subprocess.run(['node','tests/sync_device_label.test.cjs'],cwd=ROOT,check=True)
subprocess.run(['node','tests/sync_merge.test.cjs'],cwd=ROOT,check=True)
print('PASS device-local annotation label sizes: independent displays, preserved records, no shared size edits, legacy checkpoint compatibility')
