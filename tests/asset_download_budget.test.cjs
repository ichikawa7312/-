'use strict';
// Exercise the real download snippet and, when present/specified, the exact
// production-built function. Synthetic bytes only; no storage or receipt writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..'),builtRoot=process.env.SENTLOG_BUILT_ROOT?path.resolve(process.env.SENTLOG_BUILT_ROOT):root;
const snippet=fs.readFileSync(path.join(root,'sentlog/bounded-asset-download.txt'),'utf8').trim();
const H=require(path.join(root,'sentlog/blob-sha256.js'));
const cloud=fs.readFileSync(path.join(builtRoot,'sentlog/cloud-sync.js'),'utf8');
const start=cloud.indexOf('async function downloadPrivateAsset('),end=cloud.indexOf('\nasync function ackAsset(',start);
assert(start>=0&&end>start,'production download function boundaries must exist');
const built=cloud.slice(start,end).trim(),sources=[['snippet',snippet]];
if(process.env.SENTLOG_BUILT_ROOT||built.includes('bounded-asset-download-v1')){
  assert.equal(built,snippet,'the production build must use the reviewed download snippet exactly');
  sources.push(['built',built]);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function microtasks(){for(let n=0;n<40;n++)await Promise.resolve();}
function clock(){
  let time=1000,serial=0;const timers=new Map();
  return {now:()=>time,setTimeout(fn,ms){const id=++serial;timers.set(id,{at:time+ms,fn});return id;},clearTimeout:id=>timers.delete(id),
    async tick(ms){const end=time+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();await microtasks();}time=end;await microtasks();},
    elapseWithoutTimers(ms){time+=ms;},get count(){return timers.size;}};
}
const digest=blob=>H.digest(blob,{crypto:webcrypto});
async function fixture(source,options={}){
  const time=clock(),blob=new Blob(['%PDF-1.4 synthetic original bytes'],{type:'application/pdf'});
  const asset={kind:'drawing',storage_path:'synthetic-owner/synthetic-project/drawings/plan A.pdf',byte_size:blob.size,sha256:await digest(blob)};
  const calls={fetch:[],body:0,hash:[],labels:[],activeTracks:0,writes:0,acks:0};
  const response={ok:true,status:200,async blob(){calls.body++;return options.body?options.body():blob;}};
  const context={AbortController,Blob,Date:class extends Date{static now(){return time.now();}},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,
    SUPABASE_URL:'https://synthetic.invalid',BUCKET:'synthetic-temp',enc:encodeURIComponent,headers:()=>({'x-synthetic-auth':'test'}),
    fetch:async(url,opts)=>{calls.fetch.push({url,opts});return options.fetch?options.fetch(response):response;},
    sha256Hex:async(value,opts)=>{calls.hash.push({value,opts});return options.hash?options.hash(value,opts):H.digest(value,{crypto:webcrypto,...opts});},
    syncStatus:{track:async(label,run)=>{calls.labels.push(label);calls.activeTracks++;try{return await run();}finally{calls.activeTracks--;}}}};
  vm.createContext(context);vm.runInContext(source+'\nthis.download=downloadPrivateAsset;',context);
  // These counters represent the existing caller's continuation. They must
  // never be reached after a rejection, including a later ignored HTTP result.
  const run=()=>context.download(asset).then(value=>{calls.writes++;calls.acks++;return value;});
  return {time,blob,asset,response,calls,run};
}
const observe=promise=>{const state={settled:false};state.done=promise.then(value=>{state.settled=true;state.value=value;},error=>{state.settled=true;state.error=error;});return state;};
function rejectedTimeout(f,state){
  assert.equal(state.settled,true);assert.equal(state.error?.code,'ASSET_DOWNLOAD_TIMEOUT');
  assert.equal(f.calls.fetch[0].opts.signal.aborted,true);assert.equal(f.calls.activeTracks,0);assert.equal(f.time.count,0);
  assert.equal(f.calls.writes,0);assert.equal(f.calls.acks,0);
}
let passed=0;async function test(mode,name,run){await run();passed++;console.log('PASS',mode,name);}
async function suite(mode,source){
  await test(mode,'successful original PDF/photo bytes retain size, SHA and request headers',async()=>{
    for(const kind of ['drawing','photo']){
      const f=await fixture(source);f.asset.kind=kind;f.asset.byte_size=String(f.blob.size);f.asset.sha256=f.asset.sha256.toUpperCase();
      assert.equal(await f.run(),f.blob);assert.equal(f.calls.writes,1);assert.equal(f.calls.acks,1);assert.equal(f.time.count,0);assert.equal(f.calls.activeTracks,0);
      assert.equal(f.calls.labels[0],(kind==='drawing'?'PDF・図面':'写真')+'を受信中');
      assert.equal(f.calls.fetch[0].url,'https://synthetic.invalid/storage/v1/object/authenticated/synthetic-temp/synthetic-owner/synthetic-project/drawings/plan%20A.pdf');
      assert.equal(f.calls.fetch[0].opts.headers['x-synthetic-auth'],'test');assert.equal(f.calls.hash[0].opts.signal,f.calls.fetch[0].opts.signal);
      assert.equal(f.calls.fetch[0].opts.signal.aborted,false);
    }
  });
  await test(mode,'headers that never arrive reject at 180 seconds and cannot produce late writes or ACKs',async()=>{
    const hold=deferred(),f=await fixture(source,{fetch:()=>hold.promise}),state=observe(f.run());await microtasks();
    await f.time.tick(179999);assert.equal(state.settled,false);assert.equal(f.time.count,1);await f.time.tick(1);await state.done;rejectedTimeout(f,state);
    hold.resolve(f.response);await microtasks();assert.equal(f.calls.body,0);assert.equal(f.calls.hash.length,0);rejectedTimeout(f,state);
  });
  await test(mode,'a stalled response body is bounded even when it ignores abort and later returns valid bytes',async()=>{
    const hold=deferred(),f=await fixture(source,{body:()=>hold.promise}),state=observe(f.run());await microtasks();assert.equal(f.calls.body,1);
    await f.time.tick(180000);await state.done;rejectedTimeout(f,state);
    hold.resolve(f.blob);await microtasks();assert.equal(f.calls.hash.length,0);rejectedTimeout(f,state);
  });
  await test(mode,'SHA-256 receives the same abort signal and a late hash cannot escape the deadline',async()=>{
    const hold=deferred(),f=await fixture(source,{hash:()=>hold.promise}),state=observe(f.run());await microtasks();assert.equal(f.calls.hash.length,1);
    assert.equal(f.calls.hash[0].opts.signal,f.calls.fetch[0].opts.signal);
    await f.time.tick(180000);await state.done;rejectedTimeout(f,state);
    hold.resolve(f.asset.sha256);await microtasks();rejectedTimeout(f,state);
  });
  await test(mode,'one total deadline spans headers, response bytes and SHA without resetting per stage',async()=>{
    const headers=deferred(),body=deferred(),hash=deferred();
    const f=await fixture(source,{fetch:()=>headers.promise,body:()=>body.promise,hash:()=>hash.promise}),state=observe(f.run());await microtasks();
    await f.time.tick(100000);headers.resolve(f.response);await microtasks();assert.equal(f.calls.body,1);
    await f.time.tick(79999);body.resolve(f.blob);await microtasks();assert.equal(f.calls.hash.length,1);assert.equal(state.settled,false);
    await f.time.tick(1);await state.done;rejectedTimeout(f,state);hash.resolve(f.asset.sha256);await microtasks();rejectedTimeout(f,state);
  });
  await test(mode,'elapsed time is enforced when a suspended browser has not dispatched its timer yet',async()=>{
    const hold=deferred(),f=await fixture(source,{fetch:()=>hold.promise}),state=observe(f.run());await microtasks();
    f.time.elapseWithoutTimers(180001);hold.resolve(f.response);await state.done;rejectedTimeout(f,state);assert.equal(f.calls.body,0);
  });
  await test(mode,'HTTP errors preserve the original status failure and clear the deadline',async()=>{
    const f=await fixture(source,{fetch:()=>({ok:false,status:503,blob:()=>{throw Error('body must not be accepted');}})});
    await assert.rejects(f.run(),/クラウドファイル取得失敗: 503/);assert.equal(f.calls.hash.length,0);assert.equal(f.calls.writes,0);assert.equal(f.calls.acks,0);assert.equal(f.time.count,0);assert.equal(f.calls.activeTracks,0);
  });
  await test(mode,'size mismatch is rejected before hashing or caller writes',async()=>{
    const f=await fixture(source);f.asset.byte_size++;
    await assert.rejects(f.run(),/クラウドファイルのサイズ照合NG/);assert.equal(f.calls.hash.length,0);assert.equal(f.calls.writes,0);assert.equal(f.calls.acks,0);assert.equal(f.time.count,0);assert.equal(f.calls.activeTracks,0);
  });
  await test(mode,'a same-size wrong SHA remains rejected without caller writes or receipts',async()=>{
    const f=await fixture(source);f.asset.sha256='0'.repeat(64);
    await assert.rejects(f.run(),/クラウドファイルのSHA-256照合NG/);assert.equal(f.calls.hash.length,1);assert.equal(f.calls.writes,0);assert.equal(f.calls.acks,0);assert.equal(f.time.count,0);assert.equal(f.calls.activeTracks,0);
  });
  await test(mode,'a network failure is preserved and cannot leave a timer or active status behind',async()=>{
    const failure=new TypeError('synthetic network disconnect'),f=await fixture(source,{fetch:()=>{throw failure;}});
    await assert.rejects(f.run(),error=>error===failure);assert.equal(f.calls.writes,0);assert.equal(f.calls.acks,0);assert.equal(f.time.count,0);assert.equal(f.calls.activeTracks,0);
  });
}
const watchdog=setTimeout(()=>{console.error('FAIL asset download test did not settle');process.exit(1);},15000);
(async()=>{for(const [mode,source]of sources)await suite(mode,source);console.log('PASS',passed,'bounded asset download cases');})()
  .catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
