'use strict';
// Execute the real standalone controller and the unchanged auth helper. All
// accounts, records, tokens and network responses in this file are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const SOURCE=path.resolve(process.env.SENTLOG_CLOUD_CHECK_SOURCE_ROOT||path.join(__dirname,'..'));
const C=require(path.join(SOURCE,'sentlog/cloud-check.js'));
const AUTH=fs.readFileSync(path.join(SOURCE,'sentlog/cloud-check-auth.js'),'utf8');
const BASE=C.config.baseUrl,OWN=C.config.ownSessionKey,SHARED=C.config.sharedSessionKey;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const pid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const NOW=1800000000000,STAMP='2026-11-27T10:00:00.000Z';
const secret='SYNTHETIC_CREDENTIAL_DO_NOT_RENDER';
const session=(owner=A,extra={})=>({access_token:'access-'+owner,refresh_token:'refresh-'+owner,expires_at:NOW/1000+3600,user:{id:owner,email:'fixture@example.invalid'},...extra});
const project=(n=1,owner=A)=>({id:pid(n),owner_id:owner,name:'合成案件 '+n,status:'active',updated_at:STAMP});
const snapshot=(n=1,owner=A)=>({project_id:pid(n),owner_id:owner,revision:7,updated_at:STAMP});
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await pause();}throw Error('Synthetic condition was not reached');}
function harness({shared=session(),owned=null,fetcher,timeoutMs=1000,storageFailure=false,locks=null}={}){
  const data=new Map([['sentlogRecordsReadyV130','1'],['record-sentinel','SYNTHETIC_UNSAVED_RECORD'],['sentlogCloudDeviceV1','SYNTHETIC_DEVICE'],['unrelated','SYNTHETIC_OTHER']]);
  if(shared)data.set(SHARED,JSON.stringify(shared));if(owned)data.set(OWN,JSON.stringify(owned));
  const before=new Map(data),writes=[],reads=[],requests=[],views=[],listeners=new Map();let clock=NOW;
  const storage={getItem(key){reads.push(key);return data.get(key)??null;},setItem(key,value){writes.push(['set',key]);if(storageFailure)throw Error(secret);data.set(key,value);},removeItem(key){writes.push(['remove',key]);if(storageFailure)throw Error(secret);data.delete(key);}};
  const on=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};
  const off=(name,fn)=>listeners.get(name)?.delete(fn);
  const sandbox={AbortController,setTimeout,clearTimeout,addEventListener:on,localStorage:storage,navigator:{},Date,Promise};
  vm.createContext(sandbox);vm.runInContext(AUTH,sandbox);
  const defaultFetch=async(url,init)=>{
    const u=new URL(url);
    if(u.pathname==='/auth/v1/token')return response(200,{...session(),expires_in:3600});
    if(u.pathname==='/auth/v1/user')return response(200,{id:A,email:'fixture@example.invalid'});
    if(u.pathname==='/rest/v1/sentlog_projects')return response(200,[project()]);
    if(u.pathname==='/rest/v1/sentlog_project_snapshots')return response(200,[snapshot()]);
    throw Error('Unexpected synthetic request');
  };
  const api=C.create({storage,now:()=>clock,sessionGuard:sandbox.SentlogSessionGuard,locks,timeoutMs,
    addEventListener:on,removeEventListener:off,onState:view=>views.push(view),
    fetcher:async(url,init)=>{requests.push({url,init});assert(C.allowedRequest(url,init),'request escaped positive allowlist');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');return (fetcher||defaultFetch)(url,init,defaultFetch);}});
  function unchanged(){for(const [key,value]of before)if(key!==OWN)assert.equal(data.get(key),value,'Changed existing storage '+key);for(const key of data.keys())if(!before.has(key))assert.equal(key,OWN);for(const entry of writes)assert.equal(entry[1],OWN);assert(reads.every(k=>k===OWN||k===SHARED),'read unrelated storage');}
  return {api,data,before,writes,reads,requests,views,unchanged,tick:ms=>clock+=ms,emit(event){for(const fn of listeners.get('storage')||[])fn(event);}};
}
const cases=[];function test(name,run){cases.push({name,run});}
function noSecrets(h){const text=JSON.stringify(h.views);for(const token of [secret,'access-','refresh-'])assert(!text.includes(token),'credential in public state');}

test('opening the page performs no network or writes and reads only auth keys',async()=>{const h=harness();assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);assert.equal(h.api.state().canUseMain,true);h.unchanged();});
test('borrowed main session uses user verification and owner SELECT only',async()=>{
  const h=harness();await h.api.reuseMain();assert.equal(h.api.state().projects.length,1);assert.equal(h.api.state().source,'main');
  assert.deepEqual(h.requests.map(r=>new URL(r.url).pathname),['/auth/v1/user','/rest/v1/sentlog_projects','/rest/v1/sentlog_project_snapshots']);
  for(const r of h.requests){assert.equal(r.init.method,'GET');assert(!r.url.includes('payload'));if(r.url.includes('/rest/'))assert.equal(new URL(r.url).searchParams.get('owner_id'),'eq.'+A);}
  assert.equal(h.api.state().projects[0].projectUpdatedAt,STAMP);assert.equal(h.api.state().projects[0].recordUpdatedAt,STAMP);
  h.api.end();assert.equal(h.writes.length,0);assert.equal(h.requests.length,3);assert.equal(h.api.state().projects.length,0);h.unchanged();noSecrets(h);
});
test('expired borrowed session never uses the shared refresh token',async()=>{const h=harness({shared:session(A,{expires_at:NOW/1000-1})});await assert.rejects(h.api.reuseMain(),{code:'AUTH_EXPIRED'});assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);h.unchanged();});
test('server user mismatch refuses project reads and preserves the shared session',async()=>{const h=harness({fetcher:async()=>response(200,{id:B,email:'other@example.invalid'})});await assert.rejects(h.api.reuseMain(),{code:'INVALID_RESPONSE'});assert.equal(h.requests.length,1);assert.equal(h.api.state().projects.length,0);h.unchanged();});
test('401 on a borrowed session cannot remove or refresh the existing login',async()=>{const h=harness({fetcher:async()=>response(401,{message:secret})});await assert.rejects(h.api.reuseMain());assert.equal(h.requests.length,1);assert.equal(h.writes.length,0);assert.equal(h.api.state().errorCode,'AUTH_REQUIRED');h.unchanged();noSecrets(h);});
test('foreign owner project or snapshot is never displayed',async()=>{
  for(const table of ['sentlog_projects','sentlog_project_snapshots']){
    const h=harness({fetcher:async(url,init,next)=>url.includes('/'+table+'?')?response(200,[table==='sentlog_projects'?project(1,B):snapshot(1,B)]):next(url,init)});
    await assert.rejects(h.api.reuseMain(),{code:'INVALID_RESPONSE'});assert.equal(h.api.state().projects.length,0);h.unchanged();
  }
});
test('empty project and absent snapshot results are represented without claiming a backup',async()=>{
  for(const empty of ['sentlog_projects','sentlog_project_snapshots']){
    const h=harness({fetcher:async(url,init,next)=>url.includes('/'+empty+'?')?response(200,[]):next(url,init)});await h.api.reuseMain();
    if(empty==='sentlog_projects'){assert.equal(h.api.state().projects.length,0);assert.equal(h.requests.length,2);}else assert.equal(h.api.state().projects[0].recordUpdatedAt,null);
    h.unchanged();
  }
});
test('keyset pagination checks every owner and requests only page snapshot metadata',async()=>{
  const h=harness({fetcher:async(url,init,next)=>{
    const u=new URL(url),q=u.searchParams;
    if(u.pathname.endsWith('/sentlog_projects'))return response(200,q.has('id')?[project(101)]:Array.from({length:100},(_,i)=>project(i+1)));
    if(u.pathname.endsWith('/sentlog_project_snapshots'))return response(200,q.get('project_id').includes(pid(101))?[snapshot(101)]:Array.from({length:100},(_,i)=>snapshot(i+1)));
    return next(url,init);
  }});
  await h.api.reuseMain();assert.equal(h.api.state().hasMore,true);await h.api.more();assert.equal(h.api.state().projects.length,101);assert.equal(h.api.state().hasMore,false);
  const pages=h.requests.filter(r=>r.url.includes('/sentlog_projects?'));assert.equal(new URL(pages[1].url).searchParams.get('id'),'gt.'+pid(100));h.unchanged();noSecrets(h);
});
test('malformed, duplicate and out-of-order metadata fail closed',async()=>{
  for(const rows of [[project(),project()],[project(2),project(1)],[{...project(),updated_at:'invalid'}],[{...project(),id:'not-a-uuid'}]]){
    const h=harness({fetcher:async(url,init,next)=>url.includes('/sentlog_projects?')?response(200,rows):next(url,init)});await assert.rejects(h.api.reuseMain());assert.equal(h.api.state().projects.length,0);
  }
  for(const bad of [{...snapshot(),revision:true},{...snapshot(),project_id:pid(99)},{...snapshot(),revision:'1.5'}]){
    const h=harness({fetcher:async(url,init,next)=>url.includes('/sentlog_project_snapshots?')?response(200,[bad]):next(url,init)});await assert.rejects(h.api.reuseMain());assert.equal(h.api.state().projects.length,0);
  }
});
test('normal password login defaults to memory and preserves every existing key',async()=>{const h=harness();await h.api.login('fixture@example.invalid',secret);assert.equal(h.requests.length,4);assert.equal(h.requests[0].init.method,'POST');assert.equal(h.writes.length,0);assert.equal(h.api.state().source,'check');h.api.end();assert.equal(h.requests.length,4);h.unchanged();noSecrets(h);});
test('remembered login writes only a minimal dedicated auth session',async()=>{
  const h=harness();await h.api.login('fixture@example.invalid',secret,true);const saved=JSON.parse(h.data.get(OWN));assert.equal(saved.access_token,session().access_token);assert.deepEqual(Object.keys(saved).sort(),['access_token','expires_at','refresh_token','user']);assert(!h.data.get(OWN).includes(secret));h.unchanged();noSecrets(h);h.api.end();assert(!h.data.has(OWN));h.unchanged();
});
test('auth storage rejection keeps only the current memory login with a visible warning',async()=>{const h=harness({storageFailure:true});await h.api.login('fixture@example.invalid',secret,true);assert.equal(h.api.state().remembered,false);assert(h.api.state().warning);assert.equal(h.api.state().projects.length,1);h.unchanged();noSecrets(h);});
test('remembered dedicated session refreshes only its own token',async()=>{
  const owned=session(A,{access_token:'old-owned-access',refresh_token:'old-owned-refresh',expires_at:NOW/1000-1});
  const h=harness({owned,fetcher:async(url,init,next)=>{
    if(url.includes('grant_type=refresh_token')){assert.deepEqual(JSON.parse(init.body),{refresh_token:'old-owned-refresh'});return response(200,{...session(A,{access_token:'new-owned-access',refresh_token:'new-owned-refresh'}),expires_in:3600});}return next(url,init);
  }});
  await h.api.resume();assert.equal(h.requests.length,4);assert.equal(JSON.parse(h.data.get(OWN)).access_token,'new-owned-access');h.unchanged();
});
test('invalid dedicated refresh removes only its own auth session',async()=>{const h=harness({owned:session(A,{expires_at:NOW/1000-1}),fetcher:async()=>response(400,{code:'refresh_token_not_found'})});await assert.rejects(h.api.resume());assert.equal(h.api.state().errorCode,'AUTH_REQUIRED');assert(!h.data.has(OWN));assert.equal(h.requests.length,1);h.unchanged();});
test('normal login failures and rate limits do not reveal raw server messages',async()=>{for(const status of [400,401,403,429,503]){const h=harness({fetcher:async()=>response(status,{message:secret})});await assert.rejects(h.api.login('fixture@example.invalid',secret));assert.equal(h.api.state().projects.length,0);assert.equal(h.writes.length,0);noSecrets(h);h.unchanged();}});
test('offline and malformed JSON stop without clearing shared authentication',async()=>{
  for(const fetcher of [async()=>{throw Error(secret);},async()=>({status:200,ok:true,json:async()=>{throw Error(secret);}})]){
    const h=harness({fetcher});await assert.rejects(h.api.reuseMain());assert.equal(h.api.state().busy,false);assert.equal(h.api.state().projects.length,0);assert.equal(h.writes.length,0);h.unchanged();noSecrets(h);
  }
});
test('shared account change after headers prevents the late body from populating any list',async()=>{
  const body=deferred();const h=harness({fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});const running=h.api.reuseMain();const rejected=assert.rejects(running);await until(()=>h.requests.length===1);
  h.data.set(SHARED,JSON.stringify(session(B)));h.emit({key:SHARED,oldValue:h.before.get(SHARED),newValue:h.data.get(SHARED)});
  body.resolve({id:A,email:'old@example.invalid'});await rejected;assert.equal(h.api.state().projects.length,0);assert.equal(h.api.state().busy,false);assert.equal(h.api.state().errorCode,'AUTH_CHANGED');assert.equal(h.requests.length,1);assert.equal(h.writes.length,0);
});
test('same-value logout/login event still invalidates an in-flight borrowed response',async()=>{
  const body=deferred(),h=harness({fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});const rejected=assert.rejects(h.api.reuseMain());await until(()=>h.requests.length===1);h.emit({key:SHARED,oldValue:h.data.get(SHARED),newValue:null});body.resolve({id:A});await rejected;assert.equal(h.api.state().errorCode,'AUTH_CHANGED');assert.equal(h.api.state().projects.length,0);h.unchanged();
});
test('direct shared-key changes before a response are detected without a storage event',async()=>{const h=harness({fetcher:async(url,init,next)=>{if(url.includes('/sentlog_projects?'))h.data.set(SHARED,JSON.stringify(session(B)));return next(url,init);}});await assert.rejects(h.api.reuseMain(),{code:'AUTH_CHANGED'});assert.equal(h.api.state().projects.length,0);assert.equal(h.requests.length,2);});
test('cancel after headers releases busy and ignores a late password response',async()=>{
  const body=deferred(),h=harness({fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});const rejected=assert.rejects(h.api.login('fixture@example.invalid',secret,true));await until(()=>h.requests.length===1);h.api.cancel();await rejected;
  assert.equal(h.api.state().busy,false);body.resolve({...session(),expires_in:3600});await pause();assert.equal(h.api.state().projects.length,0);assert.equal(h.api.state().canResume,false);assert(!h.data.has(OWN));assert.equal(h.requests.length,1);h.unchanged();noSecrets(h);
});
test('timeout after headers covers the entire password response body',async()=>{
  const body=deferred(),h=harness({timeoutMs:15,fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});await assert.rejects(h.api.login('fixture@example.invalid',secret,true),{code:'TIMEOUT'});assert.equal(h.api.state().busy,false);assert.equal(h.api.state().errorCode,'TIMEOUT');body.resolve({...session(),expires_in:3600});await pause();assert(!h.data.has(OWN));assert.equal(h.api.state().canResume,false);h.unchanged();
});
test('timeout after snapshot headers cannot display a partial project list',async()=>{
  const body=deferred(),h=harness({timeoutMs:15,fetcher:async(url,init,next)=>url.includes('/sentlog_project_snapshots?')?{status:200,ok:true,json:()=>body.promise}:next(url,init)});await assert.rejects(h.api.reuseMain(),{code:'TIMEOUT'});assert.equal(h.api.state().projects.length,0);assert.equal(h.api.state().busy,false);body.resolve([snapshot()]);await pause();assert.equal(h.api.state().projects.length,0);h.unchanged();
});
test('cancel or timeout during the guard refresh body cannot install late owned tokens',async()=>{
  for(const timeout of [false,true]){
    const body=deferred(),owned=session(A,{expires_at:NOW/1000-1});const h=harness({owned,timeoutMs:timeout?15:1000,fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});
    const rejected=assert.rejects(h.api.resume());await until(()=>h.requests.length===1);if(!timeout)h.api.cancel();await rejected;
    assert.equal(h.api.state().busy,false);body.resolve({...session(A,{access_token:'late-access',refresh_token:'late-refresh'}),expires_in:3600});await pause();assert.equal(h.data.get(OWN),JSON.stringify(owned));assert.equal(h.api.state().projects.length,0);h.unchanged();
  }
});
test('ending a dedicated login during a body read clears it before any late result',async()=>{
  const body=deferred(),h=harness({owned:session(),fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});const rejected=assert.rejects(h.api.resume());await until(()=>h.requests.length===1);h.api.end();body.resolve({id:A});await rejected;assert(!h.data.has(OWN));assert.equal(h.api.state().source,null);assert.equal(h.api.state().projects.length,0);h.unchanged();
});
test('concurrent actions cannot change identity while another operation is busy',async()=>{const body=deferred(),h=harness({fetcher:async()=>({status:200,ok:true,json:()=>body.promise})});const rejected=assert.rejects(h.api.reuseMain());await assert.rejects(h.api.login('fixture@example.invalid',secret),{code:'BUSY'});h.api.cancel();body.resolve({id:A});await rejected;assert.equal(h.requests.length,1);h.unchanged();});
test('expired visible borrowed results disappear on the next ordinary identity check',async()=>{const h=harness();await h.api.reuseMain();h.tick(3600000);h.api.checkIdentity();assert.equal(h.api.state().projects.length,0);assert.equal(h.api.state().errorCode,'AUTH_EXPIRED');assert.equal(h.requests.length,3);h.unchanged();});
test('dedicated session changes during a response cannot borrow the previous account proof',async()=>{
  const h=harness({owned:session(),fetcher:async(url,init,next)=>{if(url.includes('/sentlog_projects?'))h.data.set(OWN,JSON.stringify(session(B)));return next(url,init);}});await assert.rejects(h.api.resume(),{code:'AUTH_CHANGED'});assert.equal(h.api.state().projects.length,0);assert.equal(h.requests.length,2);assert.equal(h.data.get(SHARED),h.before.get(SHARED));
});
test('network contract rejects RPCs, writes, shared logout, arbitrary fields and unscoped reads',async()=>{
  const base=BASE+'/rest/v1/sentlog_projects?select=id%2Cowner_id%2Cname%2Cstatus%2Cupdated_at&owner_id=eq.'+A+'&order=id.asc&limit=100';
  assert(C.allowedRequest(base,{method:'GET'}));
  for(const [url,init]of [
    [base,{method:'POST'}],[base,{method:'PATCH'}],[base,{method:'DELETE'}],[base,{body:'{}'}],
    [base.replace('owner_id=eq.'+A,'owner_id=not.is.null'),{}],[base+'&owner_id=eq.'+B,{}],
    [base.replace('name%2Cstatus','payload%2Cstatus'),{}],[base.replace('limit=100','limit=10000'),{}],
    [base.replace(BASE,'https://attacker.invalid'),{}],[BASE+'/rest/v1/rpc/sentlog_archive_v1',{method:'POST',body:'{}'}],
    [BASE+'/auth/v1/logout?scope=local',{method:'POST'}],[BASE+'/auth/v1/signup',{method:'POST'}],
    [BASE+'/storage/v1/object/sentlog-temp',{method:'DELETE'}],[BASE+'/auth/v1/user?anything=1',{}],
    [BASE+'/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:'e',password:'p',redirect_to:'evil'})}],
    [BASE+'/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:'r',owner_id:B})}]
  ])assert.equal(C.allowedRequest(url,init),false,url);
});

function queuedLocks({honorAbort=false}={}){
  const requests=[];
  return {requests,request(name,options,callback){
    if(typeof options==='function'){callback=options;options={};}
    const task=deferred(),entry={name,options,callbacks:0,aborts:0,
      release(){entry.callbacks++;Promise.resolve().then(callback).then(task.resolve,task.reject);}};
    requests.push(entry);
    if(honorAbort)options.signal?.addEventListener('abort',()=>{entry.aborts++;task.reject(new DOMException('Synthetic native lock abort','AbortError'));},{once:true});
    return task.promise;
  }};
}
for(const operation of ['cancel','end','destroy'])test(operation+' settles queued auth without waiting and rejects its later callback',async()=>{
  // The provider deliberately ignores AbortSignal, so the page itself must
  // settle cancellation and fence the old callback even after another action.
  const locks=queuedLocks(),owned=session(A,{expires_at:NOW/1000-1}),h=harness({owned,locks});let outcome=null;
  const task=h.api.resume().then(()=>{outcome='resolved';},error=>{outcome=error.code;});
  await until(()=>locks.requests.length===1);assert.equal(h.requests.length,0);h.api[operation]();await pause();
  const settledBeforeRelease=outcome,afterStop=h.data.get(OWN),writesAfterStop=h.writes.length;
  locks.requests[0].release();await task;await pause();
  assert.equal(settledBeforeRelease,'CANCELLED','Cancelling a queued lock must settle before its holder releases it');
  assert.equal(outcome,'CANCELLED');assert.equal(h.requests.length,0,'Late queued callback must not start an auth request');
  assert.equal(h.writes.length,writesAfterStop,'Late queued callback must not change an owned session');
  assert.equal(h.data.get(OWN),afterStop);assert.equal(h.api.state().projects.length,0);
  if(operation==='end')assert.equal(h.data.has(OWN),false);else assert.equal(h.data.get(OWN),JSON.stringify(owned));
  h.unchanged();noSecrets(h);
});
test('cancelling before the no-lock refresh microtask starts prevents authentication work',async()=>{
  const owned=session(A,{expires_at:NOW/1000-1}),h=harness({owned,locks:null});
  const rejected=assert.rejects(h.api.resume(),{code:'CANCELLED'});h.api.cancel();await rejected;await pause();
  assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);assert.equal(h.data.get(OWN),JSON.stringify(owned));h.unchanged();
});
test('native-compatible lock cancellation receives an aborted signal and cannot refresh',async()=>{
  const locks=queuedLocks({honorAbort:true}),h=harness({owned:session(A,{expires_at:NOW/1000-1}),locks});
  const rejected=assert.rejects(h.api.resume());await until(()=>locks.requests.length===1);h.api.cancel();await pause();
  // Release as well so an old implementation without a signal still finishes
  // and reports a failed assertion, rather than leaving the test hanging.
  locks.requests[0].release();await rejected;await pause();const request=locks.requests[0];
  assert.equal(request.name,'sentlog-auth:'+OWN);assert.equal(request.options.mode,'exclusive');
  assert.equal(request.options.signal?.aborted,true);assert.equal(request.aborts,1);
  assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);h.unchanged();
});
test('a new login can finish before the cancelled old lock callback is released',async()=>{
  const locks=queuedLocks(),h=harness({owned:session(A,{expires_at:NOW/1000-1}),locks});let outcome=null;
  const task=h.api.resume().then(()=>{outcome='resolved';},error=>{outcome=error.code;});await until(()=>locks.requests.length===1);
  h.api.cancel();await pause();const settledBeforeRelease=outcome;
  await h.api.login('fixture@example.invalid',secret,true);const current=h.data.get(OWN),requestCount=h.requests.length,writeCount=h.writes.length;
  locks.requests[0].release();await task;await pause();
  assert.equal(settledBeforeRelease,'CANCELLED');assert.equal(h.api.state().source,'check');assert.equal(h.api.state().projects.length,1);
  assert.equal(h.requests.length,requestCount);assert.equal(h.writes.length,writeCount);assert.equal(h.data.get(OWN),current);
  assert.equal(h.api.state().errorCode,null);h.unchanged();noSecrets(h);
});
test('a new resume obtains its own auth flight while the cancelled provider still holds the old request',async()=>{
  const locks=queuedLocks(),h=harness({owned:session(A,{expires_at:NOW/1000-1}),locks});let outcome=null;
  const old=h.api.resume().then(()=>{outcome='resolved';},error=>{outcome=error.code;});await until(()=>locks.requests.length===1);
  h.api.cancel();await pause();const settledBeforeRelease=outcome;
  if(settledBeforeRelease!=='CANCELLED'){locks.requests[0].release();await old;assert.equal(settledBeforeRelease,'CANCELLED');}
  const current=h.api.resume();await until(()=>locks.requests.length===2);locks.requests[1].release();await current;
  const value=h.data.get(OWN),requestCount=h.requests.length,writeCount=h.writes.length;
  locks.requests[0].release();await old;await pause();
  assert.equal(requestCount,4);assert.equal(h.requests.length,requestCount);assert.equal(h.writes.length,writeCount);
  assert.equal(h.data.get(OWN),value);assert.equal(h.api.state().projects.length,1);assert.equal(h.api.state().errorCode,null);h.unchanged();
});
test('a failed lock provider does not prevent a later owned refresh',async()=>{
  let calls=0;const locks={request(name,options,callback){if(typeof options==='function')callback=options;
    if(++calls===1)throw Error('Synthetic lock provider failure');return Promise.resolve().then(callback);}};
  const h=harness({owned:session(A,{expires_at:NOW/1000-1}),locks});await assert.rejects(h.api.resume());
  assert.equal(h.api.state().busy,false);assert.equal(h.requests.length,0);assert.equal(h.writes.length,0);
  h.api.cancel();await h.api.resume();assert.equal(calls,2);assert.equal(h.api.state().projects.length,1);assert.equal(h.requests.length,4);h.unchanged();
});

(async()=>{let passed=0;for(const {name,run}of cases){await run();passed++;console.log('PASS '+name);}console.log(passed+' cloud-check contract scenarios passed');})().catch(error=>{console.error(error);process.exitCode=1;});
