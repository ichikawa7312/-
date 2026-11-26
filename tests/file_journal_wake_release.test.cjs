'use strict';
// The deployed shell and both sides of the photo-file wake callback must
// advance together; the writer's independent startup/CAS protections stay.
const assert=require('node:assert/strict'),fs=require('node:fs');
const index=fs.readFileSync('sentlog/index.html','utf8');
const token='20261127-file-journal-wake-207',marker='sentlog-file-journal-wake-v207';
for(const module of ['delta-sync-app-runtime','cloud-sync']){
  const url=module+'.js?v='+token;
  assert.equal(index.split(url).length-1,2,'one validation and one execution reference: '+module);
  assert(index.includes("['"+url+"','"+marker+"']"));
  assert(index.includes('./'+url));
  assert(fs.readFileSync('sentlog/'+module+'.js','utf8').startsWith('// '+marker+'\n'));
}
const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
assert(cloud.includes('onFileJournaled:({localProjectId})=>editSync.request([localProjectId])'));
assert(cloud.includes('collaborationQuietAuditUntil=Date.now()+90000;'),'unchanged-file audit throttle stays bounded');
assert(index.includes("['record-store.js?v=20261127-startup-protection-206','sentlog-startup-protection-v206']"));
assert(index.includes("['delta-sync-indexeddb.js?v=20261127-durable-proof-read-206','sentlog-durable-proof-read-v206']"));
assert(index.includes("['phone-runtime.js?v=207','v2.07']"));
assert(fs.readFileSync('sentlog/phone-runtime.js','utf8').includes('v2.07 · 写真受信後の同期待ちを改善'));
assert(fs.readFileSync('sentlog-pc/index.html','utf8').includes('v2.07 · 写真受信後の同期待ちを改善'));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v249'"));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const test of ['delta_file_journal_wake','file_journal_wake_release'])assert(flow.includes('node tests/'+test+'.test.cjs'));
console.log('PASS v2.07 file-journal wake release: scoped wiring, resource markers, retained safety guards and unchanged audit throttle');
