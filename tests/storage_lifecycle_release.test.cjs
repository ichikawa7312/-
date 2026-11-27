'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const index=fs.readFileSync('sentlog/index.html','utf8');
const token='20261127-storage-lifecycle-210',marker='sentlog-storage-lifecycle-v210';
for(const name of ['record-store','storage-diagnostics','storage-diagnostics-ui']){
  const url=name+'.js?v='+token;
  assert.equal(index.split(url).length-1,2);
  assert(index.includes("['"+url+"','"+marker+"']"));assert(index.includes('./'+url));
  assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// '+marker+'\n'));
}
const pc=fs.readFileSync('sentlog-pc/index.html','utf8');
for(const name of ['storage-diagnostics','storage-diagnostics-ui'])assert(pc.includes('../sentlog/'+name+'.js?v='+token));
assert(index.includes("['phone-runtime.js?v=210','v2.10']"));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v252'"));
for(const file of ['sentlog/phone-runtime.js','sentlog-pc/index.html'])assert(fs.readFileSync(file,'utf8').includes('v2.10 · 保存先の異常検知と診断表示'));
for(const [name,version,expected]of [
  ['cloud-sync','20261127-normalization-noop-209','sentlog-normalization-noop-v209'],
  ['delta-sync-indexeddb','20261127-durable-proof-read-206','sentlog-durable-proof-read-v206'],
  ['delta-sync-core','20261127-bounded-receive-207','sentlog-bounded-receive-v207'],
  ['delta-sync-app-runtime','20261127-file-journal-wake-207','sentlog-file-journal-wake-v207']
])assert(index.includes("['"+name+'.js?v='+version+"','"+expected+"']"));
assert(index.includes("storageRestore.href='./storage-restore.html?v=20261127-startup-backup-recovery-208'"));
for(const name of ['backup-format','startup-backup-recovery'])assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// sentlog-startup-backup-recovery-v208\n'));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const name of ['record_connection_lifecycle','storage_lifecycle_release'])assert(flow.includes('node tests/'+name+'.test.cjs'));
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
async function main(){
  let cases=0;
  for(const storageLifecycleVersion of [undefined,0,1])for(const startupProtectionVersion of [undefined,0,1])for(const fileWriteDedupVersion of [undefined,0,1]){
    let initialized=0,fetched=0;const saved=new Map([['record','preserved']]),nodes=[];
    const records={storageLifecycleVersion,startupProtectionVersion,getFileWriteCapabilities:()=>({fileWriteDedupVersion}),
      init(){initialized++;saved.set('record','init reached');throw Error('CURRENT_WRITER_INIT');}};
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    const current=storageLifecycleVersion===1&&startupProtectionVersion===1&&fileWriteDedupVersion===1;
    assert.equal(initialized,current?1:0);assert.equal(fetched,0);
    assert.equal(saved.get('record'),current?'init reached':'preserved');
    assert(nodes.some(node=>node.textContent?.includes(current?'CURRENT_WRITER_INIT':'保存処理の最新版')));
    cases++;
  }
  assert.equal(cases,27);
  console.log('PASS v2.10 lifecycle release: 27 executed-writer capability combinations, current main/PC resources, preserved sync/proof/recovery and release gates');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
