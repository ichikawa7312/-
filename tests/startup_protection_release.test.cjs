'use strict';
// The completed release must reject a stale executed writer before init(),
// even when an independent dependency fetch could return the newest bytes.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const token='20261127-startup-protection-206',marker='sentlog-startup-protection-v206';
const index=fs.readFileSync('sentlog/index.html','utf8');
assert(index.includes("['record-store.js?v="+token+"','"+marker+"']"));
assert(index.includes('./record-store.js?v='+token));
assert(fs.readFileSync('sentlog/record-store.js','utf8').startsWith('// '+marker+'\n'));
assert(index.includes("[5,'sentlog-photo-grid-layout-v1']"));
assert(fs.readFileSync('sentlog/part06.txt','utf8').includes('// sentlog-photo-grid-layout-v1\n'));
assert.equal(index.split("storageCheck.href='./storage-check.html'").length-1,1);
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
async function main(){
  let cases=0;
  for(const startupProtectionVersion of [undefined,0,1])for(const fileWriteDedupVersion of [undefined,0,1]){
    let initialized=0,fetched=0;const saved=new Map([['record','preserved']]),nodes=[];
    const records={startupProtectionVersion,getFileWriteCapabilities:()=>({fileWriteDedupVersion}),
      init(){initialized++;saved.set('record','init reached');throw Error('CURRENT_WRITER_INIT');}};
    const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('unexpected fetch');},
      document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
    vm.createContext(context);await vm.runInContext(boot,context);
    const current=startupProtectionVersion===1&&fileWriteDedupVersion===1;
    assert.equal(initialized,current?1:0);assert.equal(fetched,0);
    assert.equal(saved.get('record'),current?'init reached':'preserved');
    assert(nodes.some(node=>node.textContent?.includes(current?'CURRENT_WRITER_INIT':'保存処理の最新版')));
    cases++;
  }
  const sw=fs.readFileSync('sentlog/sw.js','utf8');
  assert(sw.includes("const CACHE='sentlog-pwa-v248'"));
  assert(!sw.includes("'storage-check.html'"));assert(!sw.includes("'startup-storage-diagnostics.js'"));
  console.log('PASS startup-protected release: '+cases+' executed-writer combinations, loader markers, recovery link and cache');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
