'use strict';
// Response-reading and status recovery from the real peer-photo source. All
// requests, queues and clocks are disposable fixtures; no files or ACKs change.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const builtRoot=path.resolve(process.env.SENTLOG_BUILT_ROOT||'.');
const source=fs.readFileSync(path.join(builtRoot,'sentlog/peer-photo-recovery.js'),'utf8');
const start=source.indexOf(' async function responseData('),end=source.indexOf(' async function allRows(');
assert(start>=0&&end>start,'real response reader and API boundaries must be present');
const apiSource=source.slice(start,end),guardSource=fs.readFileSync(path.join(builtRoot,'sentlog/recovery-throttle.js'),'utf8');
const builtGuard=source.includes('const deliveryGuard=createSentlogDeliveryGuard();');
const queuePath='sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id';
function apiFixture(fetch){
 const timers=[],cleared=[];
 const context={AbortController,TypeError,Error,Promise,JSON,
  BASE:'https://synthetic.invalid',KEY:'synthetic-public',sessions:()=>({access_token:'synthetic-session'}),fetch,
  setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(id){cleared.push(id);}};
 vm.createContext(context);const api=vm.runInContext(apiSource+'\napi;',context);
 return {api,timers,cleared};
}
async function captureError(run){try{await run();}catch(error){return error;}throw Error('Expected a visible response failure');}
function relayFixture(mode='invalid-json'){
 let now=Date.parse('2026-01-01T00:00:00.000Z'),receiverChecks=0,currentMode=mode;
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const elements=new Map(),messages=[],calls=[],writes=[];
 const element=()=>({id:'',style:{},setAttribute(){},append(child){elements.set(child.id,child);},
  set textContent(value){this.value=value;messages.push(value);}});
 const host=element(),context={Blob,Response,AbortController,Map,Set,Date:ClockDate,console,
  location:{pathname:'/sentlog/'},navigator:{onLine:true},
  document:{hidden:false,getElementById:id=>elements.get(id),querySelector:()=>host,createElement:element,addEventListener(){}},
  localStorage:{getItem:key=>key==='sentlogCloudDeviceV1'?'synthetic-self':key==='sentlogCloudSessionV1'?
   JSON.stringify({access_token:'synthetic-session',user:{id:'synthetic-owner'}}):null},
  setTimeout(){},clearTimeout(){},setInterval(){},addEventListener(){},sentlogAppReady:new Promise(()=>{}),
  SentlogRecords:{ready:true,openFilesDatabase(){writes.push('file-access');throw Error('Unexpected local file access');}},
  sentlogCheckPhotoRecovery(){receiverChecks++;},
  fetch:async(input,options={})=>{
   const url=new URL(input),table=url.pathname.split('/').pop(),q=url.searchParams;
   calls.push({table,method:options.method||'GET',mode:currentMode});
   if(options.method&&options.method!=='GET'){writes.push(table);throw Error('Unexpected mutation');}
   let rows=[];
   if(table==='sentlog_devices')rows=q.has('id')?[]:[{id:'synthetic-peer',last_seen_at:new ClockDate().toISOString(),device_type:'ipad'}];
   else if(table==='sentlog_pdf_requests'){
    if(currentMode==='invalid-json')return new Response('{incomplete-json',{status:200});
    if(currentMode==='empty-body')return new Response('',{status:200});
    if(currentMode==='wrong-shape')return new Response('{"rows":[]}',{status:200});
    if(currentMode==='abort-body')return {ok:true,status:200,json:async()=>{throw Object.assign(Error('synthetic cancelled body'),{name:'AbortError'});}};
    if(currentMode==='read-error')return {ok:true,status:200,json:async()=>{throw new TypeError('Load failed');}};
    if(currentMode==='http-503')return new Response('upstream unavailable',{status:503});
    rows=currentMode==='empty-queue'||q.has('or')?[]:[{asset_id:'synthetic-drawing-asset',device_id:'synthetic-peer',
     expected_sha256:'a'.repeat(64),requested_at:new ClockDate().toISOString()}];
   }else if(table==='sentlog_projects')rows=q.has('id')?[]:[{id:'synthetic-project'}];
   else if(table!=='sentlog_assets')throw Error('Unexpected request '+table);
   return new Response(JSON.stringify(rows),{status:200,headers:{'Content-Type':'application/json'}});
  }};
 context.window=context;vm.createContext(context);vm.runInContext(source,context);
 return {calls,writes,messages,advance:ms=>{now+=ms;},async run(next=currentMode){
  currentMode=next;const before=calls.length,messageCount=messages.length;await context.sentlogCheckPeerPhotos();
  assert.deepEqual(writes,[],'diagnostic and no-candidate cycles cannot write files, queues or ACKs');
  return {calls:calls.length-before,newMessages:messages.length-messageCount,text:elements.get('slPeerPhotosSync')?.value,receiverChecks};
 }};
}
(async()=>{
 const errors=[];
 for(const [body,label]of [['{bad-json','invalid JSON'],['','empty successful response']]){
  const f=apiFixture(async()=>new Response(body,{status:200})),error=await captureError(()=>f.api(queuePath));
  assert.equal(error.name,'TypeError',label);assert.equal(error.code,'PEER_PHOTO_RESPONSE_JSON',label);
  assert.equal(error.status,200);assert.equal(error.resource,'sentlog_pdf_requests');assert.equal(error.cause.name,'SyntaxError');
  assert.match(error.message,/受信待ち一覧の応答形式/);assert.match(error.message,/再試行/);
  assert.equal(f.cleared.length,1);errors.push(error);
 }
 {const cause=new TypeError('Load failed'),f=apiFixture(async()=>({ok:true,status:200,json:async()=>{throw cause;}}));
  const error=await captureError(()=>f.api(queuePath));assert.equal(error.code,'PEER_PHOTO_RESPONSE_READ');
  assert.equal(error.cause,cause);assert.match(error.message,/最後まで読み取れません/);assert.equal(f.cleared.length,1);errors.push(error);}
 {let started,bodyError;const reading=new Promise(resolve=>{started=resolve;});
  const f=apiFixture(async(_input,options)=>({ok:true,status:200,json:()=>new Promise((_resolve,reject)=>{
   options.signal.addEventListener('abort',()=>{bodyError=Object.assign(Error('synthetic abort after headers'),{name:'AbortError'});reject(bodyError);},{once:true});started();})}));
  const pending=captureError(()=>f.api(queuePath));await reading;f.timers[0]();const error=await pending;
  assert.equal(error,bodyError,'after-header cancellation must keep the actual AbortError');
  assert.equal(error.name,'AbortError');assert.equal(f.cleared.length,1);errors.push(error);
 }
 {const f=apiFixture(async()=>new Response('gateway unavailable',{status:503})),error=await captureError(()=>f.api(queuePath));
  assert.equal(error.status,503);assert.match(error.message,/503/);errors.push(error);}
 {const f=apiFixture(async()=>new Response('sign in required',{status:401})),error=await captureError(()=>f.api(queuePath));
  assert.equal(error.status,401);assert.equal(error.name,'Error');assert.match(error.message,/401/);
  const create=vm.runInNewContext(guardSource+'\ncreateSentlogDeliveryGuard;');assert.equal(create().isTransient(error),false);
 }
 {const f=apiFixture(async()=>new Response('[]',{status:200}));assert.deepEqual(await f.api(queuePath),[]);}
 // Use the production guard, not a duplicate retry implementation, to check
 // that response errors retain the classification needed by the final build.
 const makeGuard=vm.runInNewContext(guardSource+'\ncreateSentlogDeliveryGuard;');
 for(const error of errors){
  let now=0;const guard=makeGuard({now:()=>now});assert(guard.begin('synthetic-scope'));assert(guard.fail(error));
  assert.equal(guard.begin('synthetic-scope'),false);now=29999;assert.equal(guard.begin('synthetic-scope'),false);
  now=30000;assert(guard.begin('synthetic-scope'));assert(guard.fail(error));now=89999;assert.equal(guard.begin('synthetic-scope'),false);
  now=90000;assert(guard.begin('synthetic-scope'));guard.complete();assert(guard.fail(error));now=120000;assert(guard.begin('synthetic-scope'));
 }
 for(const mode of ['invalid-json','empty-body','wrong-shape','abort-body','read-error','http-503']){
  const f=relayFixture(mode),first=await f.run();assert.match(first.text,/写真補完の確認：/);assert.match(first.text,/再試行|503/);
  assert.equal(first.receiverChecks,0,'an unreadable inventory cannot start the receiver');
  if(builtGuard){
   assert.equal((await f.run()).calls,0,'failed real built cycle must not immediately poll again');
   f.advance(29999);assert.equal((await f.run()).calls,0);
   f.advance(1);assert((await f.run()).calls>0);
   f.advance(59999);assert.equal((await f.run()).calls,0);
   f.advance(1);
  }
  const recovered=await f.run('valid-no-photo-candidate');assert(recovered.calls>0);assert(recovered.newMessages>0);
  assert.match(recovered.text,/受信待ち一覧を確認しました/);assert.match(recovered.text,/今回はこの端末から写真を送信していません/);
  assert(!/完了|受信済み|枚を送信しました|写真補完の確認：/.test(recovered.text),'no-candidate inventory is not delivered-photo success');
  assert.equal(recovered.receiverChecks,1);assert.notEqual(recovered.text,first.text,'a verified successful cycle replaces the old response error');
  const empty=await f.run('empty-queue');assert.equal(empty.text,'');assert(empty.calls>0);
 }
 console.log('PASS peer photo diagnostics: aborted/body/JSON errors stay visible, original causes and HTTP status preserved, real transient guard uses 30/60s backoff, successful no-candidate scans replace stale errors without delivered claims or writes; embedded build guard='+builtGuard);
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
