'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(name,'utf8');
const index=read('sentlog/index.html'),pc=read('sentlog-pc/index.html'),sw=read('sentlog/sw.js');
const modules=[
 ['record-store','20261127-record-safety-214','sentlog-record-safety-v214',2,0],
 ['storage-ui','20261127-failure-history-214','sentlog-failure-history-v214',2,0],
 ['page-replacement','20261127-page-context-214','sentlog-page-context-v214',2,0],
 ['archive-pc','20261127-pc-archive-preserve-214','sentlog-pc-archive-preserve-v214',0,1],
 ['pc-safe-backup','20261127-pc-acquisition-214','sentlog-pc-acquisition-v214',0,1],
];
for(const [name,token,marker,mainCount,pcCount]of modules){
 const url=name+'.js?v='+token;
 assert.equal(index.split(url).length-1,mainCount,name+' main resource count');
 assert.equal(pc.split(url).length-1,pcCount,name+' PC resource count');
 assert(read('sentlog/'+name+'.js').startsWith('// '+marker+'\n'));
 if(mainCount)assert(index.includes("['"+url+"','"+marker+"']"));
}
assert(index.includes("['phone-runtime.js?v=214','v2.14']"));
assert(read('sentlog/phone-runtime.js').includes("window.SENTLOG_BUILD = 'v2.14'"));
for(const text of [pc,read('sentlog/phone-runtime.js')])assert(text.includes('v2.14 · 記録保存と原本保護を改善'));
assert.deepEqual(sw.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v256']);
for(const name of ['cloud-check.html','cloud-check.js','cloud-check-auth.js']){
 assert(fs.existsSync('sentlog/'+name));assert(!sw.includes("'"+name+"'"),'Account checks must stay outside static cache');
}
assert(index.includes('cloud-check.html'));
assert(index.includes("storageCheck.href='./storage-check.html'"));
assert(index.includes("storageRestore.href='./storage-restore.html?v=20261127-startup-backup-recovery-208'"));
assert(!pc.includes('cloud-check.js'));
const boot=/<script>([\s\S]*?)<\/script>/.exec(index)[1];
const fields=['recordBatchNoopVersion','recordFailureHistoryVersion','cutoffResumeVersion','storageLifecycleVersion','startupProtectionVersion','fileWriteDedupVersion','expectedFileStatesVersion'];
async function main(){
 let count=0,validCount=0;
 let rows=[[]];for(const _ of fields)rows=rows.flatMap(row=>[undefined,0,1].map(value=>[...row,value]));
 for(const row of rows){
  const caps=Object.fromEntries(fields.map((field,i)=>[field,row[i]]));
  let initialized=0,fetched=0;const nodes=[],saved=new Map([['record','unchanged']]);
  const records={...caps,getFileWriteCapabilities:()=>({fileWriteDedupVersion:caps.fileWriteDedupVersion,expectedFileStatesVersion:caps.expectedFileStatesVersion}),
   init(){initialized++;saved.set('record','init reached');throw Error('CURRENT_WRITER_INIT');}};
  const context={window:{SentlogRecords:records},fetch(){fetched++;throw Error('unexpected fetch');},
   document:{body:{replaceChildren(){},append(){}},createElement(tag){const node={tag,style:{},append(){}};nodes.push(node);return node;}}};
  vm.createContext(context);await vm.runInContext(boot,context);
  const valid=row.every(value=>value===1);if(valid)validCount++;
  assert.equal(initialized,valid?1:0,JSON.stringify(caps));assert.equal(fetched,0);
  assert.equal(saved.get('record'),valid?'init reached':'unchanged');
  assert(nodes.some(node=>node.textContent?.includes(valid?'CURRENT_WRITER_INIT':'保存処理の最新版')));
  assert(nodes.some(node=>node.tag==='a'&&node.href?.includes('cloud-check.html')));
  count++;
 }
 assert.equal(count,2187);assert.equal(validCount,1);
 console.log('PASS v2.14 release: 2187 executed-writer capability combinations, fixed resource identities, preserved recovery links and cache-isolated account check');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
