'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(name,'utf8');
const index=read('sentlog/index.html'),writer=read('sentlog/record-store.js'),ui=read('sentlog/storage-maintenance-ui.js');
const token='20261128-storage-maintenance-215',marker='sentlog-storage-maintenance-v215';
for(const name of ['record-store','storage-maintenance-ui']){
  assert.equal(index.split(name+'.js?v='+token).length-1,2,name+' must be checked and loaded exactly once');
  assert(index.includes("['"+name+'.js?v='+token+"','"+marker+"']"));
  assert(read('sentlog/'+name+'.js').startsWith('// '+marker+'\n'));
}
assert(index.includes("['phone-runtime.js?v=215','v2.15']"));
assert(read('sentlog/phone-runtime.js').includes("window.SENTLOG_BUILD = 'v2.15'"));
for(const text of [read('sentlog/phone-runtime.js'),read('sentlog-pc/index.html')])assert(text.includes('v2.15 · 保存の重複抑制と容量整理'));
assert.deepEqual(read('sentlog/sw.js').match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v257']);
assert.equal(read('sentlog/sw.js').split("'storage-maintenance-ui.js'").length-1,1);
for(const name of ['compactRedundantRecords','compactRedundantFiles','compactRedundantPageBackups'])assert(writer.includes(name+'('));
assert(!/\bfetch\s*\(|\blocalStorage\b|\.clear\s*\(|deleteDatabase/.test(ui),'Maintenance UI must not contact the network or clear storage');
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
(async()=>{
  let count=0,valid=0;
  for(const storageMaintenanceVersion of [undefined,0,1])for(const projectionNoopVersion of [undefined,0,1]){
    let initialized=0,fetched=0;const nodes=[];
    const records={storageMaintenanceVersion,projectionNoopVersion,recordBatchNoopVersion:1,recordFailureHistoryVersion:1,
      cutoffResumeVersion:1,storageLifecycleVersion:1,startupProtectionVersion:1,
      getFileWriteCapabilities:()=>({fileWriteDedupVersion:1,expectedFileStatesVersion:1}),
      init(){initialized++;throw Error('CURRENT_WRITER_INIT');}};
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('Unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    const accepted=storageMaintenanceVersion===1&&projectionNoopVersion===1;
    assert.equal(initialized,accepted?1:0);assert.equal(fetched,0);
    assert(nodes.some(n=>n.textContent?.includes(accepted?'CURRENT_WRITER_INIT':'保存処理の最新版')));
    count++;if(accepted)valid++;
  }
  assert.equal(count,9);assert.equal(valid,1);
  console.log('PASS v2.15 release: maintenance resources, cache generation, nine executed-writer capability cases, no UI network or whole-store deletion');
})().catch(error=>{console.error(error);process.exitCode=1;});
