'use strict';
// Check the assembled release, including cache/loader consistency. Do not run
// against the historical pre-build HTML kept in the source checkout.
const assert=require('node:assert/strict'),fs=require('node:fs');
const token='20261127-storage-recovery-204',marker='sentlog-storage-recovery-v204';
const index=fs.readFileSync('sentlog/index.html','utf8');
for(const module of ['record-store','storage-ui','record-rescue','cloud-sync','photo-recovery']){
  assert(index.includes("['"+module+'.js?v='+token+"','"+marker+"']"),'loader must validate the current '+module);
  assert(index.includes('./'+module+'.js?v='+token),'executed resource must have the current URL: '+module);
  assert(fs.readFileSync('sentlog/'+module+'.js','utf8').startsWith('// '+marker+'\n'));
}
assert(index.includes('phone-runtime.js?v=204'));
assert(fs.readFileSync('sentlog/phone-runtime.js','utf8').includes('v2.04'));
const pc=fs.readFileSync('sentlog-pc/index.html','utf8');
assert(pc.includes('../sentlog/photo-recovery.js?v='+token));
assert(pc.includes('v2.04 · 保存失敗時の救出・受信保護'));
const sw=fs.readFileSync('sentlog/sw.js','utf8');
assert(sw.includes("const CACHE='sentlog-pwa-v246'"));
for(const file of ['record-rescue.js','record-store.js','photo-recovery.js','storage-ui.js'])assert(sw.includes("'"+file+"'"));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const file of ['record_save_diagnostics','record_rescue_failure','legacy_receive_scope'])assert(flow.includes('node tests/'+file+'.test.cjs'));
console.log('PASS v2.04 loader, executed resources, PC photo recovery, offline cache and release validation gates');
