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
const receiveUrl='delta-sync-core.js?v=20261127-bounded-receive-207',receiveMarker='sentlog-bounded-receive-v207';
assert.equal(index.split(receiveUrl).length-1,2);
assert(index.includes("['"+receiveUrl+"','"+receiveMarker+"']"));
assert(index.includes('./'+receiveUrl));
assert(fs.readFileSync('sentlog/delta-sync-core.js','utf8').startsWith('// '+receiveMarker+'\n'));
const cloud=fs.readFileSync('sentlog/cloud-sync.js','utf8');
assert(cloud.includes('onFileJournaled:({localProjectId})=>editSync.request([localProjectId])'));
assert(cloud.includes('collaborationQuietAuditUntil=Date.now()+90000;'),'unchanged-file audit throttle stays bounded');
assert(index.includes("['record-store.js?v=20261127-startup-protection-206','sentlog-startup-protection-v206']"));
assert(index.includes("['delta-sync-indexeddb.js?v=20261127-durable-proof-read-206','sentlog-durable-proof-read-v206']"));
assert(index.includes("['phone-runtime.js?v=207','v2.07']"));
assert(fs.readFileSync('sentlog/phone-runtime.js','utf8').includes('v2.07 · 記録受信・写真同期の待機を改善'));
assert(fs.readFileSync('sentlog-pc/index.html','utf8').includes('v2.07 · 記録受信・写真同期の待機を改善'));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v249'"));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const test of ['delta_file_journal_wake','delta_receive_batch','delta_journal_receive_contention','file_journal_wake_release'])assert(flow.includes('node tests/'+test+'.test.cjs'));
console.log('PASS v2.07 receive and file-journal wake release: scoped wiring, resource markers, retained safety guards and unchanged audit throttle');
