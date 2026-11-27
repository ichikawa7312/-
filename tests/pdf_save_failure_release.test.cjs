'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const index=fs.readFileSync('sentlog/index.html','utf8');
const url='pdf-recovery.js?v=20261127-pdf-save-failure-gate-211',marker='sentlog-pdf-save-failure-gate-v211';
assert.equal(index.split(url).length-1,2);
assert(index.includes("['"+url+"','"+marker+"']"));
assert(index.includes('src="./'+url+'"'));
assert(fs.readFileSync('sentlog/pdf-recovery.js','utf8').startsWith('// '+marker+'\n'));
assert(fs.readFileSync('sentlog-pc/index.html','utf8').includes('src="../sentlog/'+url+'"'));
assert(!fs.readFileSync('sentlog/drawing-export-view.html','utf8').includes('pdf-recovery.js'));
assert(index.includes("['phone-runtime.js?v=211','v2.11']"));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v253'"));
for(const file of ['sentlog/phone-runtime.js','sentlog-pc/index.html'])
  assert(fs.readFileSync(file,'utf8').includes('v2.11 · 保存失敗中のPDF受信を待機'));
for(const [name,version,expected]of [
  ['record-store','20261127-storage-lifecycle-210','sentlog-storage-lifecycle-v210'],
  ['storage-diagnostics','20261127-storage-lifecycle-210','sentlog-storage-lifecycle-v210'],
  ['storage-diagnostics-ui','20261127-storage-lifecycle-210','sentlog-storage-lifecycle-v210'],
  ['cloud-sync','20261127-normalization-noop-209','sentlog-normalization-noop-v209'],
  ['delta-sync-indexeddb','20261127-durable-proof-read-206','sentlog-durable-proof-read-v206'],
  ['delta-sync-core','20261127-bounded-receive-207','sentlog-bounded-receive-v207'],
  ['delta-sync-app-runtime','20261127-file-journal-wake-207','sentlog-file-journal-wake-v207']
])assert(index.includes("['"+name+'.js?v='+version+"','"+expected+"']"));
assert(index.includes("storageRestore.href='./storage-restore.html?v=20261127-startup-backup-recovery-208'"));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const name of ['pdf_recovery_failure_gate','pdf_save_failure_release'])
  assert(flow.includes('node tests/'+name+'.test.cjs'));
console.log('PASS v2.11 PDF failure release: current main/PC receiver, preserved writer/diagnostics/sync/proof/recovery, and release gates');
