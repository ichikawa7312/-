'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(name,'utf8'),index=read('sentlog/index.html');
const token='20261128-operation-memory-216',marker='sentlog-operation-memory-v216';
const page=read('sentlog/storage-maintenance.html'),startup=read('sentlog/startup-storage-maintenance.js');
for(const name of ['record-store','storage-maintenance-ui','sync-view']){
  assert.equal(index.split(name+'.js?v='+token).length-1,2,name+' checked and executed');
  assert(index.includes("['"+name+'.js?v='+token+"','"+marker+"']"));
  assert(read('sentlog/'+name+'.js').startsWith('// '+marker+'\n'));
}
assert(startup.startsWith('// '+marker+'\n'));
assert(index.includes("['phone-runtime.js?v=216','v2.16']"));
assert(index.includes('storage-maintenance.html?v='+token));
for(const name of ['phone-runtime.js','../sentlog-pc/index.html'])
  assert(read('sentlog/'+name).includes('v2.16 · 操作時の負荷軽減と容量整理'));
const worker=read('sentlog/sw.js');
assert.deepEqual(worker.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v258']);
for(const name of ['storage-maintenance.html','startup-storage-maintenance.js'])
  assert.equal(worker.split("'"+name+"'").length-1,1);
assert(page.includes("connect-src 'none'"));
assert(!/(?:cloud-sync|phone-runtime|part0[1-9]|pdf\.min|supabase)/.test(page),
  'Independent maintenance must not start normal app, authentication, PDF rendering or sync');
assert(!/\bfetch\s*\(|deleteDatabase|\.clear\s*\(|location\.reload|serviceWorker/.test(startup),
  'Independent startup must not fetch data, erase stores, reload or update workers');
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
(async()=>{
  let count=0,valid=0;
  for(const maintenanceInitVersion of [undefined,0,1])for(const journalReadBudgetVersion of [undefined,0,1]){
    let initialized=0,fetched=0;const nodes=[];
    const records={maintenanceInitVersion,journalReadBudgetVersion,storageMaintenanceVersion:1,projectionNoopVersion:1,
      recordBatchNoopVersion:1,recordFailureHistoryVersion:1,cutoffResumeVersion:1,storageLifecycleVersion:1,startupProtectionVersion:1,
      getFileWriteCapabilities:()=>({fileWriteDedupVersion:1,expectedFileStatesVersion:1}),
      init(){initialized++;throw Error('CURRENT_WRITER_INIT');}};
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('Unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    const accepted=maintenanceInitVersion===1&&journalReadBudgetVersion===1;
    assert.equal(initialized,accepted?1:0);assert.equal(fetched,0);
    assert(nodes.some(n=>n.textContent?.includes(accepted?'CURRENT_WRITER_INIT':'保存処理の最新版')));
    assert(nodes.some(n=>n.href==='./storage-maintenance.html?v='+token));
    count++;if(accepted)valid++;
  }
  assert.equal(count,9);assert.equal(valid,1);
  console.log('PASS v2.16 release: exact resources, isolated maintenance route and nine executed-writer capability gates');
})().catch(error=>{console.error(error);process.exitCode=1;});
