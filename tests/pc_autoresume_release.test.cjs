'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const pc=fs.readFileSync('sentlog-pc/index.html','utf8');
assert(pc.includes("const PC_AUTO_SYNC_PREF='sentlogPcAutoSyncEnabledV1'"));
assert(pc.includes('クラウド登録済みファイルのPC処理完了（端末から未送信のファイルは未確認）'));
assert(pc.includes("$('startBtn').onclick=()=>start(true)"));
assert(pc.includes("await resumeAutoSync();\n  log('PC同期画面を起動しました')"));
assert(!pc.includes('timer=setInterval(syncOnce,5000)'));
for(const match of pc.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
  if(match[1].trim())new vm.Script(match[1]);
const begin=pc.indexOf('async function pcFolderGranted(){');
const end=pc.indexOf("$('loginBtn').onclick=");
assert(begin>=0&&end>begin);
const runtime=pc.slice(begin,end);
const sleep=()=>new Promise(resolve=>setImmediate(resolve));
function setup(allowed,pref){
  const settings=new Map(pref===undefined?[]:[['sentlogPcAutoSyncEnabledV1',pref]]),
    calls={sync:0,prompt:0,queries:0,schedule:0,stopped:0,events:[]};
  const rootHandle={queryPermission:async()=>{calls.queries++;return allowed.value;}};
  const s={console,PC_AUTO_SYNC_PREF:'sentlogPcAutoSyncEnabledV1',localStorage:{getItem:k=>settings.get(k)||null,setItem:(k,v)=>settings.set(k,v)},
    rootHandle,session:{user:{id:'owner'}},busy:false,navigator:{onLine:true},document:{hidden:false},
    timer:null,log:m=>calls.events.push(m),refreshUI:()=>{},setSync:(text,level)=>calls.events.push([text,level]),
    async permission(){calls.prompt++;allowed.value='granted';return true;},
    async syncOnce(){calls.sync++;},
    setInterval(fn,ms){assert.equal(ms,15000);calls.schedule++;return {fn};},
    clearInterval(){calls.stopped++;}};
  vm.createContext(s);vm.runInContext(runtime,s);
  return {s,calls,settings,allowed};
}
(async()=>{
  {
    const f=setup({value:'granted'});
    await f.s.resumeAutoSync();await sleep();
    assert.equal(f.calls.sync,0,'never auto start for a PC without explicit opt-in');
    assert.equal(f.calls.prompt,0);
    await f.s.start(true);await sleep();
    assert.equal(f.calls.schedule,1);assert.equal(f.calls.sync,1);
    assert.equal(f.settings.get('sentlogPcAutoSyncEnabledV1'),'1');
    await f.s.stop();await f.s.resumeAutoSync();await sleep();
    assert.equal(f.calls.schedule,1,'STOP remains effective after a new page load');
    assert.equal(f.settings.get('sentlogPcAutoSyncEnabledV1'),'0');
  }
  {
    const f=setup({value:'prompt'},'1');
    await f.s.resumeAutoSync();await sleep();
    assert.equal(f.calls.prompt,0,'background startup must NEVER request folder access');
    assert.equal(f.calls.sync,0);assert.equal(f.calls.schedule,0);
    await f.s.start(true);await sleep();
    assert.equal(f.calls.prompt,1,'only a user click can request write access');
    assert.equal(f.calls.sync,1);
  }
  {
    const f=setup({value:'granted'},'1');
    await f.s.resumeAutoSync();await sleep();
    assert.equal(f.calls.prompt,0);assert.equal(f.calls.sync,1);
    await f.s.autoSyncOnce();assert.equal(f.calls.sync,2);
    f.s.navigator.onLine=false;await f.s.autoSyncOnce();assert.equal(f.calls.sync,2);
    f.s.navigator.onLine=true;f.s.document.hidden=true;await f.s.autoSyncOnce();assert.equal(f.calls.sync,2);
    f.s.document.hidden=false;f.allowed.value='prompt';await f.s.autoSyncOnce();
    assert.equal(f.calls.sync,2);assert.equal(f.calls.prompt,0);
  }
  console.log('PASS PC consented autostart, automatic permission safety, STOP and offline/hidden protection');
})().catch(e=>{console.error(e);process.exitCode=1});
