'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('sentlog/session-guard.js','utf8');
let passed=0;
const old={access_token:'old',refresh_token:'old-r',expires_at:1,user:{id:'test-user',email:'test@example.invalid'}};
const renewed={access_token:'new',refresh_token:'new-r',expires_in:3600,user:old.user};
function setup(fetcher,values={},locks=null){
 const data=new Map(Object.entries({session:JSON.stringify(old),records:'KEEP',photo:'KEEP',device:'KEEP',...values}));
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
 const changes=[],listeners=[];let time=1000000;
 const root={localStorage:storage,navigator:{},addEventListener:(type,fn)=>listeners.push(fn)};
 const ctx=vm.createContext({window:root,AbortController,setTimeout,clearTimeout,Date,Promise,Error,JSON,Number,String,Math});
 vm.runInContext(source,ctx);
 const options={key:'session',baseUrl:'https://example.invalid',apiKey:'public-test',storage,fetcher,locks,now:()=>time,onChange:(s,r)=>changes.push({s,r})};
 return {guard:root.SentlogSessionGuard.create(options),factory:root.SentlogSessionGuard,options,data,storage,changes,listeners,tick:ms=>time+=ms};
}
const reply=(status,data)=>({ok:status>=200&&status<300,status,json:async()=>data});
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await test('concurrent refresh is single-flight',async()=>{let calls=0;const s=setup(async()=>{calls++;await new Promise(r=>setTimeout(r,5));return reply(200,renewed)});await Promise.all(Array.from({length:20},()=>s.guard.ensure()));assert.equal(calls,1);assert.equal(s.guard.read().access_token,'new');});
 await test('invalid refresh pauses and preserves records/files/device',async()=>{let calls=0;const s=setup(async()=>{calls++;return reply(400,{code:'refresh_token_already_used'})});await assert.rejects(s.guard.ensure(),{code:'REAUTH_REQUIRED'});await assert.rejects(s.guard.ensure());assert.equal(calls,1);for(const k of ['records','photo','device'])assert.equal(s.data.get(k),'KEEP');assert.equal(s.guard.required(),true);assert.equal(s.guard.read(),null);});
 await test('network error retains session and applies backoff',async()=>{let calls=0;const s=setup(async()=>{calls++;throw Error('offline')});await assert.rejects(s.guard.ensure(),{code:'AUTH_RETRY_LATER'});await assert.rejects(s.guard.ensure());assert.equal(calls,1);assert.equal(s.guard.read().refresh_token,'old-r');s.tick(5001);await assert.rejects(s.guard.ensure());assert.equal(calls,2);assert.equal(s.guard.required(),false);});
 await test('5xx and 429 do not discard login',async()=>{for(const status of [429,500,503]){const s=setup(async()=>reply(status,{message:'temporary'}));await assert.rejects(s.guard.ensure());assert.equal(s.guard.read().access_token,'old');assert.equal(s.guard.required(),false);}});
 await test('other tab refreshed token is adopted without a request',async()=>{let calls=0;const s=setup(async()=>{calls++;return reply(200,renewed)});s.storage.setItem('session',JSON.stringify({...renewed,expires_at:100000}));const got=await s.guard.ensure();assert.equal(got.access_token,'new');assert.equal(calls,0);});
 await test('late refresh cannot overwrite newer sign-in',async()=>{let finish;const s=setup(()=>new Promise(r=>finish=r));const p=s.guard.ensure();await Promise.resolve();s.guard.set({...old,access_token:'login-new',refresh_token:'login-r',expires_at:100000});finish(reply(200,renewed));assert.equal((await p).access_token,'login-new');assert.equal(s.guard.read().access_token,'login-new');});
 await test('late rejection cannot erase newer sign-in',async()=>{let finish;const s=setup(()=>new Promise(r=>finish=r));const p=s.guard.ensure();await Promise.resolve();s.guard.set({...old,access_token:'login-new',refresh_token:'login-r',expires_at:100000});finish(reply(400,{code:'refresh_token_already_used'}));assert.equal((await p).access_token,'login-new');assert.equal(s.guard.required(),false);});
 await test('logout during refresh cannot resurrect session',async()=>{let finish;const s=setup(()=>new Promise(r=>finish=r));const p=s.guard.ensure();await Promise.resolve();s.guard.set(null);finish(reply(200,renewed));await assert.rejects(p,{code:'SESSION_CHANGED'});assert.equal(s.guard.read(),null);});
 await test('account change aborts old refresh rather than switching identity',async()=>{let finish;const s=setup(()=>new Promise(r=>finish=r));const p=s.guard.ensure();await Promise.resolve();s.guard.set({...old,user:{id:'other'},access_token:'other',expires_at:100000});finish(reply(200,renewed));await assert.rejects(p,{code:'SESSION_CHANGED'});assert.equal(s.guard.read().user.id,'other');});
 await test('malformed successful response is not saved',async()=>{const s=setup(async()=>reply(200,{...renewed,user:{id:'wrong'}}));await assert.rejects(s.guard.ensure());assert.equal(s.guard.read().access_token,'old');});
 await test('reauth hint survives reload and clears on explicit sign-in',async()=>{const s=setup(async()=>reply(400,{code:'refresh_token_not_found'}));await assert.rejects(s.guard.ensure());const other=s.factory.create(s.options);assert.equal(other.required(),true);other.set({...renewed,expires_at:100000});assert.equal(other.required(),false);});
 await test('two tabs serialize with the same Web Lock and reread storage',async()=>{let chain=Promise.resolve(),calls=0;const locks={request:(name,action)=>{assert.equal(name,'sentlog-auth:session');const next=chain.then(action);chain=next.catch(()=>{});return next}};const s=setup(async()=>{calls++;await new Promise(r=>setTimeout(r,5));return reply(200,renewed)}, {},locks);const other=s.factory.create(s.options);await Promise.all([s.guard.ensure(),other.ensure()]);assert.equal(calls,1);});
 await test('legacy invalid-token message is handled',async()=>{const s=setup(async()=>reply(400,{msg:'Invalid Refresh Token: Refresh Token Not Found'}));await assert.rejects(s.guard.ensure(),{code:'REAUTH_REQUIRED'});});
 await test('auth generation advances for refresh and explicit logout even with the same account',async()=>{
  const s=setup(async()=>reply(200,renewed)),events=[];s.guard.subscribe((event,session,info)=>events.push({event,owner:session?.user?.id||null,generation:info.generation}));
  assert.equal(s.guard.generation(),0);await s.guard.ensure();assert.equal(s.guard.generation(),1);
  const saved=s.guard.read();s.guard.set(saved);assert.equal(s.guard.generation(),1,'identical set does not invalidate work');
  s.guard.set(null);s.guard.set(saved);assert.equal(s.guard.generation(),3);
  assert.deepEqual(events.map(e=>e.event),['TOKEN_REFRESHED','SIGNED_OUT','SIGNED_IN']);assert.deepEqual(events.map(e=>e.generation),[1,2,3]);
 });
 await test('same-token logout and re-login invalidates an older refresh response',async()=>{
  let finish;const s=setup(()=>new Promise(resolve=>finish=resolve)),running=s.guard.ensure();await Promise.resolve();
  s.guard.set(null);s.guard.set({...old});finish(reply(200,renewed));await assert.rejects(running,{code:'SESSION_CHANGED'});
  assert.equal(s.guard.read().access_token,'old');assert.equal(s.guard.required(),false);assert.equal(s.guard.generation(),2);
 });
 await test('late refresh rejection after same-token re-login cannot erase the newer login',async()=>{
  let finish;const s=setup(()=>new Promise(resolve=>finish=resolve)),running=s.guard.ensure();await Promise.resolve();
  s.guard.set(null);s.guard.set({...old});finish(reply(400,{code:'refresh_token_already_used'}));await assert.rejects(running,{code:'SESSION_CHANGED'});
  assert.equal(s.guard.read().access_token,'old');assert.equal(s.guard.required(),false);
 });
 await test('same-owner fresh re-login is retained instead of installing an old refresh result',async()=>{
  let finish;const s=setup(()=>new Promise(resolve=>finish=resolve)),running=s.guard.ensure();await Promise.resolve();
  s.guard.set(null);s.guard.set({...old,expires_at:100000});finish(reply(200,renewed));const current=await running;
  assert.equal(current.access_token,'old');assert.equal(current.expires_at,100000);assert.equal(s.guard.read().access_token,'old');
 });
 await test('generation synchronously adopts same-tab direct storage changes',async()=>{
  const s=setup(async()=>reply(200,renewed)),events=[];s.guard.subscribe(event=>events.push(event));
  s.storage.setItem('session',JSON.stringify({...renewed,expires_at:100000}));assert.equal(s.guard.generation(),1);
  assert.equal(s.guard.read().access_token,'new');assert.deepEqual(events,['TOKEN_REFRESHED']);assert.equal(s.guard.generation(),1);
 });
 await test('listener and UI exceptions cannot hide persisted auth from other subscribers',async()=>{
  const s=setup(async()=>reply(200,renewed)),events=[];s.options.onChange=()=>{throw Error('synthetic display failure');};
  s.guard.subscribe(()=>{throw Error('synthetic observer failure');});s.guard.subscribe((event,session,info)=>events.push([event,session?.user?.id,info.generation]));
  s.guard.set(null);assert.equal(s.guard.read(),null);assert.equal(s.guard.generation(),1);assert.deepEqual(events,[['SIGNED_OUT',undefined,1]]);
 });
 await test('unsubscribing removes only that observer and does not reset the auth fence',async()=>{
  const s=setup(async()=>reply(200,renewed));let removed=0,remaining=0;const stop=s.guard.subscribe(()=>removed++);s.guard.subscribe(()=>remaining++);
  s.guard.set(null);stop();stop();s.guard.set(old);assert.equal(removed,1);assert.equal(remaining,2);assert.equal(s.guard.generation(),2);
 });
 await test('batched cross-tab logout events invalidate work even when storage already contains the same login again',async()=>{
  let finish;const s=setup(()=>new Promise(resolve=>finish=resolve)),events=[];s.guard.subscribe(event=>events.push(event));
  const running=s.guard.ensure();await Promise.resolve();const raw=s.storage.getItem('session');
  for(const listener of s.listeners)listener({key:'session',oldValue:raw,newValue:null});
  assert.equal(s.guard.generation(),1);finish(reply(200,renewed));await assert.rejects(running,{code:'SESSION_CHANGED'});
  assert.equal(s.guard.read().access_token,'old');assert.equal(events.length,1);
 });
 await test('cross-tab clear publishes sign-out while preserving application records and files',async()=>{
  const s=setup(async()=>reply(200,renewed)),events=[];s.guard.subscribe(event=>events.push(event));s.storage.removeItem('session');
  for(const listener of s.listeners)listener({key:null,oldValue:null,newValue:null});assert.equal(s.guard.generation(),1);assert.deepEqual(events,['SIGNED_OUT']);
  for(const key of ['records','photo','device'])assert.equal(s.data.get(key),'KEEP');
 });
 console.log(`${passed} session guard scenarios passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
