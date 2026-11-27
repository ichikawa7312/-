'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const index=fs.readFileSync('sentlog/index.html','utf8'),pc=fs.readFileSync('sentlog-pc/index.html','utf8');
for(const [name,version,marker,pcCount]of [
  ['record-store','20261127-cutoff-resume-212','sentlog-cutoff-resume-v212',0],
  ['photo-recovery','20261127-photo-save-failure-gate-212','sentlog-photo-save-failure-gate-v212',1],
  ['delta-sync-app-runtime','20261127-delta-save-failure-gate-212','sentlog-delta-save-failure-gate-v212',0],
  ['cloud-sync','20261127-cloud-asset-save-failure-gate-212','sentlog-cloud-asset-save-failure-gate-v212',0]
]){
  const url=name+'.js?v='+version;
  assert.equal(index.split(url).length-1,2);assert(index.includes("['"+url+"','"+marker+"']"));
  assert(index.includes('./'+url));assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// '+marker+'\n'));
  assert.equal(pc.split(url).length-1,pcCount);assert(!fs.readFileSync('sentlog/drawing-export-view.html','utf8').includes(name+'.js'));
}
assert(index.includes("['phone-runtime.js?v=212','v2.12']"));
assert(fs.readFileSync('sentlog/sw.js','utf8').includes("const CACHE='sentlog-pwa-v254'"));
for(const file of ['sentlog/phone-runtime.js','sentlog-pc/index.html'])assert(fs.readFileSync(file,'utf8').includes('v2.12 · 添付の再試行と写真受信を改善'));
for(const [name,version,marker]of [
  ['pdf-recovery','20261127-pdf-save-failure-gate-211','sentlog-pdf-save-failure-gate-v211'],
  ['storage-diagnostics','20261127-storage-lifecycle-210','sentlog-storage-lifecycle-v210'],
  ['storage-diagnostics-ui','20261127-storage-lifecycle-210','sentlog-storage-lifecycle-v210'],
  ['delta-sync-indexeddb','20261127-durable-proof-read-206','sentlog-durable-proof-read-v206'],
  ['delta-sync-core','20261127-bounded-receive-207','sentlog-bounded-receive-v207']
])assert(index.includes("['"+name+'.js?v='+version+"','"+marker+"']"));
assert(index.includes("storageRestore.href='./storage-restore.html?v=20261127-startup-backup-recovery-208'"));
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
for(const name of ['delta_cutoff_files','photo_recovery_failure_gate','delta_save_failure_gate','cloud_asset_save_failure_gate','recovery_retry_release'])assert(flow.includes('node tests/'+name+'.test.cjs'));
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
(async()=>{
  let cases=0;
  for(const cutoffResumeVersion of [undefined,0,1])for(const storageLifecycleVersion of [undefined,0,1])
    for(const startupProtectionVersion of [undefined,0,1])for(const fileWriteDedupVersion of [undefined,0,1]){
      let initialized=0,fetched=0;const saved=new Map([['record','preserved']]),nodes=[];
      const records={cutoffResumeVersion,storageLifecycleVersion,startupProtectionVersion,getFileWriteCapabilities:()=>({fileWriteDedupVersion}),
        init(){initialized++;saved.set('record','init reached');throw Error('CURRENT_WRITER_INIT');}};
      const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('unexpected fetch');},
        document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
      vm.createContext(context);await vm.runInContext(boot,context);
      const current=cutoffResumeVersion===1&&storageLifecycleVersion===1&&startupProtectionVersion===1&&fileWriteDedupVersion===1;
      assert.equal(initialized,current?1:0);assert.equal(fetched,0);
      assert.equal(saved.get('record'),current?'init reached':'preserved');
      assert(nodes.some(node=>node.textContent?.includes(current?'CURRENT_WRITER_INIT':'保存処理の最新版')));cases++;
    }
  assert.equal(cases,81);
  console.log('PASS v2.12 recovery retry release: 81 executed-writer combinations, current main/PC resources, preserved sync/proof/recovery and release gates');
})().catch(error=>{console.error(error);process.exitCode=1;});
