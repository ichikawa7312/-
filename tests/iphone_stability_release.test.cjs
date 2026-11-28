'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(name,'utf8'),index=read('sentlog/index.html');
const token='20261128-iphone-stability-217',marker='sentlog-iphone-stability-v217';
for(const name of ['record-store','storage-maintenance-ui','sync-view','delta-sync-app-runtime','delta-sync-assets','delta-sync-asset-runtime','photo-thumbnails']){
  assert.equal(index.split(name+'.js?v='+token).length-1,2,name+' checked and executed');
  assert(index.includes("['"+name+'.js?v='+token+"','"+marker+"']"));
  assert(read('sentlog/'+name+'.js').startsWith('// '+marker+'\n'));
}
assert(index.includes("['phone-runtime.js?v=217','v2.17']"));
assert(read('sentlog/delta-sync-assets.js').includes('byteBackedBlobVersion:1'));
assert(read('sentlog/delta-sync-asset-runtime.js').includes('unreadableCacheRepairVersion:1'));
assert(index.indexOf('<script src="./photo-thumbnails.js')>index.lastIndexOf('<script src="./active-media-restore.js'));
assert(index.indexOf('<script src="./photo-thumbnails.js')<index.indexOf('document.open();'));
assert(!/local-work-mode|local-photo-window|work-local\.html/.test(index));
const worker=read('sentlog/sw.js');
assert.deepEqual(worker.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v259']);
assert.equal(worker.split("'photo-thumbnails.js'").length-1,1);
for(const name of ['phone-runtime.js','../sentlog-pc/index.html'])
  assert(read('sentlog/'+name).includes('v2.17 · 起動と写真表示の負荷軽減'));
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
(async()=>{
  for(const startupReadBudgetVersion of [undefined,0,1]){
    let initialized=0,fetched=0;const nodes=[];
    const records={startupReadBudgetVersion,maintenanceInitVersion:1,journalReadBudgetVersion:1,storageMaintenanceVersion:1,
      projectionNoopVersion:1,recordBatchNoopVersion:1,recordFailureHistoryVersion:1,cutoffResumeVersion:1,
      storageLifecycleVersion:1,startupProtectionVersion:1,
      getFileWriteCapabilities:()=>({fileWriteDedupVersion:1,expectedFileStatesVersion:1}),
      init(){initialized++;throw Error('CURRENT_WRITER_INIT');}};
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('Unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    assert.equal(initialized,startupReadBudgetVersion===1?1:0);assert.equal(fetched,0);
    assert(nodes.some(n=>n.textContent?.includes(startupReadBudgetVersion===1?'CURRENT_WRITER_INIT':'保存処理の最新版')));
  }
  console.log('PASS v2.17: normal entry, versioned sync/photo modules, last renderer, static cache and startup capability gate');
})().catch(error=>{console.error(error);process.exitCode=1;});
