'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const index=fs.readFileSync('sentlog/index.html','utf8'),cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
const token='20261127-normalization-noop-209',marker='sentlog-normalization-noop-v209',url='cloud-sync.js?v='+token;
assert.equal(index.split(url).length-1,2);
assert(index.includes("['"+url+"','"+marker+"']"));assert(index.includes('./'+url));
assert(cloud.startsWith('// '+marker+'\n// sentlog-file-journal-wake-v207\n'));
assert(cloud.includes('if(next!==text&&!window.SentlogRecordCollaboration.equal(JSON.parse(text),st))'));
assert(cloud.includes('onFileJournaled:({localProjectId})=>editSync.request([localProjectId])'));
assert(index.includes("['phone-runtime.js?v=209','v2.09']"));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v251'"));
for(const file of ['sentlog/phone-runtime.js','sentlog-pc/index.html'])assert(fs.readFileSync(file,'utf8').includes('v2.09 · 同じ記録の不要な再保存を抑制'));
for(const [name,version,expected]of [
  ['record-store','20261127-startup-protection-206','sentlog-startup-protection-v206'],
  ['delta-sync-indexeddb','20261127-durable-proof-read-206','sentlog-durable-proof-read-v206'],
  ['delta-sync-core','20261127-bounded-receive-207','sentlog-bounded-receive-v207'],
  ['delta-sync-app-runtime','20261127-file-journal-wake-207','sentlog-file-journal-wake-v207']
])assert(index.includes("['"+name+'.js?v='+version+"','"+expected+"']"));
assert(index.includes("storageRestore.href='./storage-restore.html?v=20261127-startup-backup-recovery-208'"));
for(const name of ['backup-format','startup-backup-recovery'])assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// sentlog-startup-backup-recovery-v208\n'));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const name of ['cloud_normalization_noop','cloud_normalization_release'])assert(flow.includes('node tests/'+name+'.test.cjs'));
console.log('PASS v2.09: versioned semantic normalization guard, preserved writer/CAS/receive/wake/recovery resources and release gates');
