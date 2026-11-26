'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const token='20261127-startup-backup-recovery-208',marker='sentlog-startup-backup-recovery-v208';
const index=fs.readFileSync('sentlog/index.html','utf8'),page=fs.readFileSync('sentlog/storage-restore.html','utf8');
const worker=fs.readFileSync('sentlog/sw.js','utf8'),flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const name of ['backup-format','startup-backup-recovery']){
  assert(page.includes('./'+name+'.js?v='+token));
  assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// '+marker+'\n'));
  assert(!index.includes(name+'.js'),'startup recovery is loaded only in its independent page');
  assert(!worker.includes(name+'.js'),'recovery must not require app cache installation');
}
assert(page.includes('<!-- '+marker+' -->'));assert(!worker.includes('storage-restore.html'));
assert(page.includes("connect-src 'none'"));
for(const name of ['record-store.js','cloud-sync.js','part01.txt','delta-sync-app-runtime.js'])assert(!page.includes(name));
assert(!page.includes('serviceWorker'));assert(/<a id="recoveryOpen" class="button" hidden>/.test(page));
assert(index.includes("storageRestore.href='./storage-restore.html?v="+token+"'"));
assert(index.includes("storageCheck.href='./storage-check.html'"));
assert(index.includes("['phone-runtime.js?v=208','v2.08']"));
assert(worker.includes("const CACHE='sentlog-pwa-v250'"));
for(const file of ['sentlog/phone-runtime.js','sentlog-pc/index.html'])assert(fs.readFileSync(file,'utf8').includes('v2.08 · 起動停止時のバックアップ復旧'));
// The independently verified 206/207 writer, CAS and synchronization modules
// retain their own exact resource identities in the recovery release.
for(const [name,version,expected]of [
  ['record-store','20261127-startup-protection-206','sentlog-startup-protection-v206'],
  ['delta-sync-indexeddb','20261127-durable-proof-read-206','sentlog-durable-proof-read-v206'],
  ['delta-sync-core','20261127-bounded-receive-207','sentlog-bounded-receive-v207'],
  ['delta-sync-app-runtime','20261127-file-journal-wake-207','sentlog-file-journal-wake-v207'],
  ['cloud-sync','20261127-file-journal-wake-207','sentlog-file-journal-wake-v207']
])assert(index.includes("['"+name+'.js?v='+version+"','"+expected+"']"));
for(const name of ['startup_backup_recovery','startup_backup_recovery_release'])assert(flow.includes('node tests/'+name+'.test.cjs'));
for(const name of ['backup-format.js','startup-backup-recovery.js','storage-restore.html'])assert(flow.includes("'"+name+"'"));
assert(fs.readFileSync('.github/workflows/sentlog-delta-application.yml','utf8').includes('python tests/startup_backup_recovery_ui.py'));
// The actual failed-init branch exposes one same-tab recovery link, without
// weakening init or fetching the application after storage has been refused.
(async()=>{
  let init=0,fetches=0;const nodes=[];
  const context={window:{SentlogRecords:{startupProtectionVersion:1,getFileWriteDedupVersion:()=>1,
    getFileWriteCapabilities:()=>({fileWriteDedupVersion:1}),init(){init++;throw Error('PRESERVED_STARTUP_FAILURE');}}},
    fetch(){fetches++;throw Error('unexpected app fetch');},document:{body:{replaceChildren(){},append(){}},
      createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
  vm.createContext(context);await vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(index)[1],context);
  assert.equal(init,1);assert.equal(fetches,0);assert(nodes.some(n=>n.textContent==='PRESERVED_STARTUP_FAILURE'));
  const links=nodes.filter(n=>n.tag==='a'&&n.textContent==='バックアップから復旧');assert.equal(links.length,1);
  assert.equal(links[0].href,'./storage-restore.html?v='+token);assert.equal(links[0].target,undefined);assert.equal(links[0].onclick,undefined);
  console.log('PASS v2.08: guarded same-tab recovery link, isolated versioned resources, retained writers and published-byte coverage');
})().catch(error=>{console.error(error);process.exitCode=1;});
