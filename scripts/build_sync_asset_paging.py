"""v1.85: read every asset page before file delivery or merge verification."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new,count=1):
    p=ROOT/path;s=p.read_text()
    if s.count(old)!=count:raise RuntimeError(f'Asset paging integration mismatch: {path}: {old}')
    p.write_text(s.replace(old,new))
source=(ROOT/'sentlog/cloud-sync.js').read_text()
if 'async function readProjectAssets(' not in source or "readProjectAssets(cp.id,'client_key,kind,sha256,byte_size,metadata')" not in source:
    raise RuntimeError('Complete merge asset verification is missing')
replace('sentlog/cloud-sync.js',
        "const assets=await rest('/rest/v1/sentlog_assets?project_id=eq.'+enc(cloudProject.id)+'&status=neq.storage_deleted&select='+fields);",
        "const assets=await readProjectAssets(cloudProject.id,decodeURIComponent(fields),{availableOnly:true});")
replace('sentlog/index.html','cloud-sync.js?v=20261019-pages-181','cloud-sync.js?v=20261020-assets-185',2)
replace('sentlog/index.html',"['cloud-sync.js?v=20261020-assets-185','verifiedPdfPageCounts']", "['cloud-sync.js?v=20261020-assets-185','readProjectAssets']")
replace('sentlog/index.html','phone-runtime.js?v=184','phone-runtime.js?v=185',2)
replace('sentlog/index.html',"['phone-runtime.js?v=185','v1.84']","['phone-runtime.js?v=185','v1.85']")
replace('sentlog/phone-runtime.js','v1.84','v1.85',4)
replace('sentlog/sw.js','sentlog-pwa-v195','sentlog-pwa-v196')
for p in (ROOT/'tests').iterdir():
    if p.suffix not in ('.py','.cjs'):continue
    s=p.read_text();updated=s.replace("SENTLOG_BUILD==='v1.84'","SENTLOG_BUILD==='v1.85'").replace("'v1.84'","'v1.85'").replace('sentlog-pwa-v195','sentlog-pwa-v196')
    updated=updated.replace('phone-runtime.js?v=184','phone-runtime.js?v=185').replace(r'phone-runtime\.js\?v=184',r'phone-runtime\.js\?v=185')
    updated=updated.replace('cloud-sync.js?v=20261019-pages-181','cloud-sync.js?v=20261020-assets-185')
    updated=updated.replace(r'cloud-sync\.js\?v=20261019-pages-181',r'cloud-sync\.js\?v=20261020-assets-185')
    if updated!=s:p.write_text(updated)
print('Built Sentlog v1.85: complete asset listing for merge verification and delivery; original byte checks retained')
