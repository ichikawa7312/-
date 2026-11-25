'use strict';
const assert=require('node:assert/strict');
const {createTransport,createRestProvider,createSupabaseProvider}=require('../sentlog/delta-sync-transport.js');
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT='11111111-1111-4111-8111-111111111111',PROJECT2='22222222-2222-4222-8222-222222222222';
const DEVICE='aaaaaaaa-0000-4000-8000-000000000001',BASELINE='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SCOPE={ownerId:OWNER,projectId:PROJECT,deviceId:DEVICE};
const clone=x=>JSON.parse(JSON.stringify(x));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<4;i++)await tick();}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function clock(){let index=0;const pending=new Map();return {pending,
  setTimeout(fn,ms){pending.set(++index,{fn,ms});return index;},clearTimeout(id){pending.delete(id);},
  run(ms){const entries=[...pending].filter(([,v])=>v.ms===ms);assert(entries.length,'expected a scheduled timer at '+ms);
    for(const [id,v] of entries){pending.delete(id);v.fn();}}};}
function event(n=1,projectId=PROJECT){return {schema:1,eventId:'event-'+n,projectId,deviceId:DEVICE,drawingId:'drawing',recordId:'record-'+n,
  kind:'create',record:{id:'record-'+n,collab:{version:1,comments:{},fields:{},photos:{},deletion:{revisions:[{
    id:'alive-'+n,parents:[],actor:{deviceId:DEVICE,deviceName:'test'},at:1,deleted:false,observed:[]}]}}}};}
const ack=e=>({seq:1,duplicate:false,...Object.fromEntries(['eventId','projectId','deviceId','drawingId','recordId'].map(k=>[k,e[k]]))});
const page=(events=[],{after=0,headSeq=events.length,hasMore=after+events.length<headSeq,scope=SCOPE}={})=>({schema:2,...scope,after,headSeq,events,hasMore});
const capabilities=()=>({schema:2,...SCOPE,atomicGroups:true,groupMaxEvents:500,groupMaxBytes:4194304,pageTargetBytes:900000});
const group=()=>({schema:1,kind:'atomic-group',groupId:'move-one',projectId:PROJECT,deviceId:DEVICE,events:[event(1),event(2)]});
const groupAck=g=>({schema:1,groupId:g.groupId,projectId:g.projectId,deviceId:g.deviceId,startSeq:5,endSeq:4+g.events.length,
  duplicate:false,events:g.events.map((e,i)=>{const row=ack(e);delete row.duplicate;row.seq=5+i;return row;})});
const receipt=()=>({schema:1,baselineId:BASELINE,ownerId:OWNER,projectId:PROJECT,snapshotRevision:7,cursor:0,
  recordCount:1,importedCount:1,snapshotSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),
  clientProjectId:'local-project',drawingIds:['drawing','empty-drawing'],metadataCount:1,metadataManifestSha256:'c'.repeat(64),
  hashFormat:'postgres-jsonb-text-sha256-v1',state:'verified',deltaEnabled:false,deviceMigrationVerified:false,assetDeliveryVerified:false});
const recordPage=()=>({receipt:receipt(),records:[{ordinal:1,drawingId:'drawing',recordId:'record-1',
  recordJson:JSON.stringify(event().record),sha256:'d'.repeat(64),manifestEntryJson:'[1,"drawing","record-1","digest"]'}],nextOrdinal:1,hasMore:false});
const metadataPage=()=>({receipt:receipt(),metadata:[{ordinal:1,kind:'project',key:'local-project',metadataJson:'{"id":"local-project"}',
  sha256:'e'.repeat(64),manifestEntryJson:'[1,"project","local-project","digest"]'}],nextOrdinal:1,hasMore:false});
const instances=new Set();
function harness(extra={}){
  let session={access_token:'token-a',user:{id:OWNER}},current=clone(SCOPE),rpcImpl=(name,args)=>({data:name==='sentlog_delta_append_v1'?ack(args.p_envelope):page(),error:null});
  const calls=[],capabilityCalls=[],users=[],subscriptions=[],auth=new Set(),timers=clock();let sessionReads=0,authStops=0;
  let capabilityImpl=()=>({data:capabilities()});
  const provider={
    getSession:async()=>{sessionReads++;return session;},peekSession:()=>session,
    getUser:async token=>{users.push(token);return {id:OWNER};},
    rpc:async(name,args,options)=>{if(name==='sentlog_delta_capabilities_v1'){capabilityCalls.push({name,args,options});return capabilityImpl();}
      calls.push({name,args,options});return rpcImpl(name,args,options);},
    subscribeAuth(fn){auth.add(fn);return ()=>{authStops++;auth.delete(fn);};},
    subscribe(options){const sub={options,stops:0};subscriptions.push(sub);return ()=>sub.stops++;}
  };
  Object.assign(provider,extra.provider||{});
  const transport=createTransport({provider,scope:SCOPE,currentScope:()=>current,timers,retryMs:5,requestTimeoutMs:1000,...extra.transport});instances.add(transport);
  return {transport,provider,calls,capabilityCalls,users,subscriptions,timers,setRpc:fn=>{rpcImpl=fn;},setCapabilities:fn=>{capabilityImpl=fn;},setScope:s=>{current=s;},
    getSession:()=>session,setSession(s,emit=true){session=s;if(emit)for(const fn of auth)fn(s?'TOKEN_REFRESHED':'SIGNED_OUT',s);},
    stats:()=>({sessionReads,authStops})};
}
async function rejects(fn,code){return assert.rejects(Promise.resolve().then(fn),e=>{assert.equal(e.code,code);return true;});}
const cases=[];function test(name,fn){cases.push({name,fn});}

test('authenticated RPC binds owner, project, registered device and event identity',async()=>{
  const h=harness();assert.equal(h.transport.online(),false);
  assert.deepEqual(await h.transport.ready(),{authenticated:true,scope:SCOPE});assert.equal(h.transport.online(),true);
  assert.deepEqual(h.users,['token-a']);assert.deepEqual(await h.transport.push(event()),ack(event()));
  const call=h.calls[0];assert.equal(call.name,'sentlog_delta_append_v1');
  assert.deepEqual(call.args,{p_project_id:PROJECT,p_device_id:DEVICE,p_event_id:'event-1',p_drawing_id:'drawing',p_record_id:'record-1',p_envelope:event()});
  assert.equal(call.options.accessToken,'token-a');assert(call.options.signal instanceof AbortSignal);
  assert.deepEqual(h.users,['token-a']);assert.equal(h.timers.pending.size,0);
  await rejects(()=>h.transport.push(event(1,PROJECT2)),'DELTA_SCOPE');assert.equal(h.calls.length,1);
});
test('a storage session is insufficient until Auth confirms its owner',async()=>{
  const h=harness({provider:{getUser:async()=>({id:OTHER})}});
  await rejects(()=>h.transport.push(event()),'DELTA_SCOPE');assert.equal(h.calls.length,0);assert.equal(h.transport.online(),false);
  h.setSession({access_token:'token-other',user:{id:OTHER}});
  await rejects(()=>h.transport.ready(),'DELTA_SCOPE');h.setSession(null);
  await rejects(()=>h.transport.ready(),'DELTA_LOGIN_REQUIRED');assert.equal(h.calls.length,0);
});
test('caller mutations during authentication cannot rewrite a queued event',async()=>{
  const waiting=deferred(),h=harness({provider:{getUser:()=>waiting.promise}}),e=event();
  const pending=h.transport.push(e);e.recordId='changed';e.record.id='changed';await settle();waiting.resolve({id:OWNER});
  assert.equal((await pending).recordId,'record-1');assert.equal(h.calls[0].args.p_envelope.recordId,'record-1');
});
test('non-JSON event content is rejected before serialization can discard it',async()=>{
  const h=harness();for(const value of [new Blob(['file']),new Date(),()=>{},undefined]){
    const e=event();e.record.extra=value;await rejects(()=>h.transport.push(e),'DELTA_EVENT');}
  assert.equal(h.calls.length,0);assert.equal(h.stats().sessionReads,0);
});
test('acknowledgements must prove this exact durable event',async()=>{
  for(const mutation of [r=>r.seq=0,r=>r.seq='1',r=>r.seq=Number.MAX_SAFE_INTEGER+1,r=>r.deviceId=OTHER,r=>r.recordId='foreign',r=>delete r.duplicate]){
    const h=harness();h.setRpc(()=>{const value=ack(event());mutation(value);return {data:value};});
    await rejects(()=>h.transport.push(event()),'DELTA_NOT_DURABLE');h.transport.close();
  }
});
test('RPC pages preserve byte-limited continuation and exact committed order',async()=>{
  const h=harness();h.setRpc(()=>({data:page([{seq:1,event:event()}],{headSeq:3,hasMore:true})}));
  const rows=await h.transport.list(PROJECT,0,100);assert.equal(rows.length,1);assert.equal(rows.hasMore,true);assert.equal(rows.headSeq,3);
  assert.deepEqual(Object.keys(rows),['0']);assert.deepEqual(h.calls[0].args,{p_project_id:PROJECT,p_device_id:DEVICE,p_after:0,p_limit:100});
  assert.equal(h.calls[0].name,'sentlog_delta_list_groups_v1');
  h.setRpc(()=>({data:page([],{after:3,headSeq:3,hasMore:false})}));assert.equal((await h.transport.list(PROJECT,3,100)).hasMore,false);
});
test('foreign, gapped, truncated and malformed pages fail without a cursor result',async()=>{
  const changes=[r=>r.ownerId=OTHER,r=>r.deviceId=OTHER,r=>r.after=9,r=>r.headSeq='1',r=>r.headSeq=0,
    r=>r.events[0].seq=2,r=>r.events[0].event.projectId=PROJECT2,r=>r.events[0].event.kind='invalid',
    r=>r.hasMore=true,r=>r.events=[],r=>r.schema=3];
  for(const mutate of changes){const h=harness();h.setRpc(()=>{const value=page([{seq:1,event:event()}]);mutate(value);return {data:value};});
    await assert.rejects(h.transport.list(PROJECT,0,100));h.transport.close();}
  const h=harness();for(const args of [[PROJECT,-1,100],[PROJECT,0,501],[PROJECT,0,0],[PROJECT,Number.MAX_SAFE_INTEGER+1,1],[PROJECT2,0,1]])
    await assert.rejects(h.transport.list(...args));assert.equal(h.calls.length,0);
});
test('baseline wrappers preserve server metadata and exact JSON for reconciliation',async()=>{
  const h=harness();h.setRpc(name=>({data:name.includes('metadata_page')?metadataPage():name.includes('read_baseline_page')?recordPage():receipt()}));
  const prepared=await h.transport.prepareBaseline(7);assert.deepEqual(prepared.drawingIds,['drawing','empty-drawing']);assert.equal(prepared.clientProjectId,'local-project');
  assert.deepEqual(await h.transport.importBaselineBatch(BASELINE,50),receipt());
  assert.deepEqual(await h.transport.readBaselinePage(BASELINE,0,20),recordPage());
  assert.deepEqual(await h.transport.readBaselineMetadataPage(BASELINE,0,20),metadataPage());
  assert.deepEqual(h.calls.map(c=>c.name),['sentlog_delta_prepare_baseline_v1','sentlog_delta_import_baseline_batch_v1',
    'sentlog_delta_read_baseline_page_v1','sentlog_delta_read_baseline_metadata_page_v1']);
  assert.deepEqual(h.calls[3].args,{p_project_id:PROJECT,p_device_id:DEVICE,p_baseline_id:BASELINE,p_after:0,p_limit:20});
});
test('baseline receipt, metadata order and page termination are checked before use',async()=>{
  for(const mutate of [r=>r.receipt.projectId=PROJECT2,r=>r.receipt.baselineId=OTHER,r=>r.nextOrdinal=2,r=>r.hasMore=true,
    r=>r.metadata[0].ordinal=0,r=>r.metadata[0].sha256='not-a-digest',r=>r.receipt.metadataCount=2,r=>r.metadata=[]]){
    const h=harness();h.setRpc(()=>{const value=metadataPage();mutate(value);return {data:value};});
    await rejects(()=>h.transport.readBaselineMetadataPage(BASELINE),'DELTA_SERVER');h.transport.close();}
  const h=harness();h.setRpc(()=>({data:{...receipt(),snapshotRevision:8}}));
  await rejects(()=>h.transport.prepareBaseline(7),'DELTA_SERVER');
  await rejects(()=>h.transport.importBaselineBatch('bad',1),'DELTA_BASELINE_ID');
  await rejects(()=>h.transport.readBaselinePage(BASELINE,0,101),'DELTA_PAGE');
});
test('semantic errors remain identifiable and infrastructure errors retain retry policy',async()=>{
  const matrix=[
    [{code:'22023',message:'DELTA_UNKNOWN_PARENT private token-a'},400,'DELTA_UNKNOWN_PARENT',false],
    [{code:'55000',message:'DELTA_NOT_ACTIVATED'},409,'DELTA_NOT_ACTIVATED',false],
    [{code:'42501',message:'private'},403,'DELTA_FORBIDDEN',false],
    [{code:'PGRST301',message:'private'},401,'DELTA_LOGIN_REQUIRED',false],
    [{code:'PGRST202',message:'private'},409,'DELTA_UPGRADE_REQUIRED',false],
    [{code:'40001',message:'private'},409,'40001',false],
    [{code:'23505',message:'private'},409,'23505',false],
    [{code:'22003',message:'private'},400,'22003',false]
  ];
  for(const [error,status,code,retryable] of matrix){const h=harness();h.setRpc(()=>({data:null,error}));
    await assert.rejects(h.transport.push(event()),e=>{assert.equal(e.status,status);assert.equal(e.code,code);assert.equal(e.retryable,retryable);
      assert.equal(e.sqlState,error.code);assert(!e.message.includes('private'));assert(!e.message.includes('token-a'));return true;});h.transport.close();}
  for(const status of [401,403,429,502]){const h=harness();h.setRpc(()=>({data:null,error:{message:'private'},status}));
    await assert.rejects(h.transport.push(event()),e=>{assert.equal(e.status,status);assert.equal(e.retryable,status>=429);return true;});h.transport.close();}
  const h=harness();h.setRpc(()=>{throw new TypeError('private network endpoint token-a');});
  await assert.rejects(h.transport.push(event()),e=>e.retryable===true&&!e.message.includes('token-a'));
});
test('logout cancels a request even when its provider ignores abort',async()=>{
  const h=harness(),waiting=deferred();await h.transport.ready();h.setRpc(()=>waiting.promise);
  const pending=h.transport.push(event());await settle();h.setSession(null);
  await rejects(()=>pending,'DELTA_AUTH_CHANGED');assert.equal(h.calls[0].options.signal.aborted,true);
  waiting.resolve({data:ack(event())});await settle();assert.equal(h.transport.online(),false);assert.equal(h.transport.getStatus().authenticated,false);
});
test('logout also cancels an in-progress Auth user verification',async()=>{
  const waiting=deferred(),h=harness({provider:{getUser:()=>waiting.promise}}),pending=h.transport.ready();
  await settle();h.setSession(null);await rejects(()=>pending,'DELTA_AUTH_CHANGED');waiting.resolve({id:OWNER});await settle();
  assert.equal(h.transport.getStatus().authenticated,false);assert.equal(h.calls.length,0);
});
test('late RPC responses cannot cross a project, device or session change',async()=>{
  for(const kind of ['project','device','token']){const h=harness(),waiting=deferred();await h.transport.ready();h.setRpc(()=>waiting.promise);
    const pending=h.transport.push(event());await settle();
    if(kind==='token')h.setSession({access_token:'new-token',user:{id:OWNER}},false);
    else h.setScope({...SCOPE,[kind==='project'?'projectId':'deviceId']:OTHER});
    waiting.resolve({data:ack(event())});await rejects(()=>pending,kind==='token'?'DELTA_AUTH_CHANGED':'DELTA_SCOPE');
    assert.equal(h.transport.online(),false);h.transport.close();}
});
test('a valid refresh during getSession proceeds with a newly verified token',async()=>{
  const h=harness();h.provider.getSession=async()=>{const s={access_token:'fresh-token',user:{id:OWNER}};h.setSession(s);return s;};
  assert.deepEqual(await h.transport.push(event()),ack(event()));assert.deepEqual(h.users,['fresh-token']);assert.equal(h.calls[0].options.accessToken,'fresh-token');
});
test('external abort, timeout and close release callers without a late RPC',async()=>{
  for(const kind of ['abort','timeout','close']){const waiting=deferred(),h=harness({provider:{getSession:()=>waiting.promise}}),controller=new AbortController();
    const pending=h.transport.push(event(),{signal:controller.signal});await settle();
    if(kind==='abort')controller.abort();else if(kind==='timeout')h.timers.run(1000);else h.transport.close();
    await rejects(()=>pending,{abort:'DELTA_ABORTED',timeout:'DELTA_TIMEOUT',close:'DELTA_CLOSED'}[kind]);
    waiting.resolve(h.getSession());await settle();assert.equal(h.calls.length,0);assert.equal(h.users.length,0);assert.equal(h.timers.pending.size,0);h.transport.close();}
  const h=harness(),controller=new AbortController();controller.abort();
  await rejects(()=>h.transport.push(event(),{signal:controller.signal}),'DELTA_ABORTED');assert.equal(h.stats().sessionReads,0);
});
test('offline transport and disconnect during session or Auth verification never launch a delta RPC',async()=>{
  let online=false;
  const h=harness({transport:{online:()=>online}});
  await rejects(()=>h.transport.inspect(),'DELTA_OFFLINE');
  assert.equal(h.stats().sessionReads,0);assert.equal(h.calls.length,0);
  online=true;const waiting=deferred();h.provider.getSession=()=>waiting.promise;
  const pending=h.transport.inspect();await settle();online=false;waiting.resolve(h.getSession());
  await rejects(()=>pending,'DELTA_OFFLINE');assert.equal(h.calls.length,0);assert.equal(h.users.length,0);
  const verification=deferred(),h2=harness({transport:{online:()=>online},provider:{getUser:()=>verification.promise}});
  online=true;const verifying=h2.transport.inspect();await settle();online=false;verification.resolve({id:OWNER});
  await rejects(()=>verifying,'DELTA_OFFLINE');assert.equal(h2.calls.length,0);
  online=true;h2.setRpc(()=>({data:{schema:1,...SCOPE,enabled:false,canActivate:false,headSeq:0,checking:false,baseline:null}}));
  assert.equal((await h2.transport.inspect()).enabled,false);assert.equal(h2.calls.length,1);
});
test('aborted inspection and late native network rejection cannot escape or enable legacy writes',async()=>{
  const h=harness();const flight=deferred();h.setRpc(()=>flight.promise);
  const ctrl=new AbortController(),pending=h.transport.inspect({signal:ctrl.signal});await settle();
  ctrl.abort();await rejects(()=>pending,'DELTA_ABORTED');assert.equal(h.calls[0].options.signal.aborted,true);
  flight.reject(new TypeError('Load failed due to access control checks.'));await settle();
  assert.equal(h.timers.pending.size,0);
});
test('notifications are validated wake-up hints and readiness requests catch-up',async()=>{
  const h=harness(),notices=[];const off=h.transport.subscribe(PROJECT,v=>notices.push(v));await settle();
  const sub=h.subscriptions[0];assert.equal(sub.options.ownerId,OWNER);assert.equal(sub.options.accessToken,'token-a');
  assert(notices.some(n=>n.reason==='authenticated'));sub.options.onReady();assert.equal(h.transport.getStatus().realtimeConnected,true);
  const before=notices.length;
  for(const v of [{projectId:PROJECT2,seq:1},{projectId:PROJECT,seq:0},{projectId:PROJECT,seq:'2'},{projectId:PROJECT,seq:Infinity}])sub.options.onNotice(v);
  assert.equal(notices.length,before);sub.options.onNotice({projectId:PROJECT,seq:9,record:{id:'must-not-apply'}});
  assert.deepEqual(notices.at(-1),{projectId:PROJECT,seq:9});assert.equal(h.calls.length,0);
  sub.options.onState('CHANNEL_ERROR');assert.equal(sub.stops,1);assert.equal(h.transport.getStatus().realtimeConnected,false);
  h.timers.run(5);await settle();assert.equal(h.subscriptions.length,2);off();assert.equal(h.subscriptions[1].stops,1);
  h.transport.close();assert.equal(h.stats().authStops,1);assert.equal(h.timers.pending.size,0);
});
test('a REST token change drops old channels and re-verifies before reconnecting',async()=>{
  const h=harness(),notices=[];h.transport.subscribe(PROJECT,n=>notices.push(n));await settle();const old=h.subscriptions[0];
  h.setSession({access_token:'token-b',user:{id:OWNER}},false);h.transport.wake();await settle();
  assert.equal(old.stops,1);assert.deepEqual(h.users,['token-a','token-b']);assert.equal(h.subscriptions[1].options.accessToken,'token-b');
  const count=notices.length;old.options.onNotice({projectId:PROJECT,seq:2});assert.equal(notices.length,count);
});

function sdk(){let session={access_token:'sdk-a',user:{id:OWNER}},inAuth=false;const listeners=new Set(),calls=[],channels=[],removed=[],tokens=[];
  const assertUnlocked=()=>assert.equal(inAuth,false,'SDK operation ran inside its synchronous Auth callback');
  const client={auth:{
    async getSession(){assertUnlocked();return {data:{session}};},async getUser(token){assertUnlocked();return {data:{user:{id:session.user.id}}};},
    onAuthStateChange(fn){listeners.add(fn);return {data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};}},
    rpc(name,args){assertUnlocked();const c={name,args};calls.push(c);return {abortSignal(signal){c.signal=signal;return Promise.resolve({data:ack(args.p_envelope)});}};},
    realtime:{async setAuth(token){assertUnlocked();tokens.push(token);}},
    channel(topic,options){assertUnlocked();const c={topic,options,on(type,filter,fn){this.notice=fn;return this;},subscribe(fn){this.state=fn;return this;}};channels.push(c);return c;},
    removeChannel(c){removed.push(c);c.state?.('CLOSED');return Promise.resolve('ok');}};
  return {client,calls,channels,removed,tokens,setSession(s){session=s;inAuth=true;try{for(const fn of listeners)fn(s?'TOKEN_REFRESHED':'SIGNED_OUT',s);}finally{inAuth=false;}}};
}
test('SDK adapter aborts PostgREST queries and shares an owner channel safely',async()=>{
  const s=sdk(),provider=createSupabaseProvider(s.client),timer=clock();
  const a=createTransport({provider,scope:SCOPE,currentScope:()=>SCOPE,timers:timer,retryMs:5});instances.add(a);
  const otherScope={...SCOPE,projectId:PROJECT2};const b=createTransport({provider,scope:otherScope,currentScope:()=>otherScope,timers:timer,retryMs:5});instances.add(b);
  const na=[],nb=[];a.subscribe(PROJECT,x=>na.push(x));b.subscribe(PROJECT2,x=>nb.push(x));await settle();
  assert.equal(s.channels.length,1);assert.equal(s.tokens.length,1);const c=s.channels[0];assert.equal(c.topic,'sentlog-delta:'+OWNER);assert.equal(c.options.config.private,true);
  c.state('SUBSCRIBED');const before=na.length;c.notice({event:'delta',payload:{project_id:PROJECT2,seq:8}});assert.equal(na.length,before);assert.equal(nb.at(-1).seq,8);
  c.notice({event:'delta',payload:{project_id:PROJECT,seq:'9'}});assert.equal(na.length,before);
  await a.push(event());assert(s.calls[0].signal instanceof AbortSignal);a.close();assert.equal(s.removed.length,0);
  const next=nb.length;c.notice({event:'delta',payload:{project_id:PROJECT2,seq:9}});assert.equal(nb.length,next+1);
  b.close();assert.equal(s.removed.length,1);c.notice({event:'delta',payload:{project_id:PROJECT2,seq:10}});assert.equal(nb.length,next+1);
});
test('SDK refresh and signout callbacks never await or call back into Auth synchronously',async()=>{
  const s=sdk(),timers=clock(),transport=createTransport({client:s.client,scope:SCOPE,currentScope:()=>SCOPE,timers,retryMs:5});instances.add(transport);
  transport.subscribe(PROJECT,()=>{});await settle();s.channels[0].state('SUBSCRIBED');
  s.setSession({access_token:'sdk-b',user:{id:OWNER}});assert.equal(s.removed.length,1);timers.run(5);await settle();
  assert.deepEqual(s.tokens,['sdk-a','sdk-b']);s.channels[1].state('SUBSCRIBED');s.setSession(null);
  assert.equal(transport.online(),false);assert.equal(s.removed.length,2);transport.close();assert.equal(timers.pending.size,0);
});

test('REST provider uses verified Auth plus explicit scoped RPC and safe HTTP options',async()=>{
  let current={access_token:'rest-token',user:{id:OWNER},expires_at:1000};const requests=[];
  const provider=createRestProvider({url:'https://example.supabase.co/',key:'sb_publishable_test',session:()=>current,now:()=>1000,Socket:null,
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,status:200,text:async()=>JSON.stringify(url.includes('/auth/')?{id:OWNER}:ack(event()))};}});
  const transport=createTransport({provider,scope:SCOPE,currentScope:()=>SCOPE});instances.add(transport);await transport.push(event());
  assert.equal(requests.length,2);assert.equal(requests[0].url,'https://example.supabase.co/auth/v1/user');
  assert.equal(requests[1].url,'https://example.supabase.co/rest/v1/rpc/sentlog_delta_append_v1');assert.equal(requests[1].options.method,'POST');
  for(const r of requests){assert(!r.url.includes('rest-token'));assert.equal(r.options.headers.Authorization,'Bearer rest-token');
    assert.equal(r.options.headers.apikey,'sb_publishable_test');assert.equal(r.options.credentials,'omit');assert.equal(r.options.redirect,'error');assert.equal(r.options.cache,'no-store');}
  assert.equal(JSON.parse(requests[1].options.body).p_device_id,DEVICE);current=null;assert.equal(transport.getStatus().authenticated,false);
});
test('REST session refresh is coalesced and its channel uses the existing private factory',async()=>{
  let s={access_token:'old',user:{id:OWNER},expires_at:1},refreshes=0,channelOptions,stops=0,wakes=0;
  const wait=deferred();const provider=createRestProvider({url:'https://example.supabase.co',key:'public',session:()=>s,now:()=>100000,Socket:function(){},
    async refreshSession(){refreshes++;await wait.promise;s={access_token:'new',user:{id:OWNER},expires_at:1000};},fetch:async()=>{},
    channelFactory(options){channelOptions=options;return {wake:()=>wakes++,stop:()=>stops++};}});
  const a=provider.getSession(),b=provider.getSession();await settle();assert.equal(refreshes,1);wait.resolve();assert.equal((await a).access_token,'new');assert.equal((await b).access_token,'new');
  const notices=[],states=[];const off=provider.subscribe({active:()=>true,projectId:PROJECT,onReady:()=>{},onNotice:n=>notices.push(n),onState:s=>states.push(s)});
  assert.equal(channelOptions.topicPrefix,'sentlog-delta');assert.equal(wakes,1);channelOptions.onChange({kind:'records',projectId:PROJECT,revision:1});
  channelOptions.onChange({kind:'delta',projectId:PROJECT2,seq:1});assert.equal(notices.length,0);
  channelOptions.onChange({kind:'delta',projectId:PROJECT,seq:2});assert.equal(notices.length,1);channelOptions.onState('DISCONNECTED');assert.deepEqual(states,['DISCONNECTED']);off();assert.equal(stops,1);
});
test('REST provider rejects secret keys and non-origin or insecure endpoints',async()=>{
  const options={url:'https://example.supabase.co',key:'public',session:()=>null,fetch:async()=>{},Socket:null};
  const legacy='e30.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.signature';
  for(const key of ['sb_secret_example',legacy])assert.throws(()=>createRestProvider({...options,key}),{code:'DELTA_TRANSPORT_CONFIG'});
  for(const url of ['http://example.supabase.co','https://user:pass@example.supabase.co','https://example.supabase.co/rest','https://example.supabase.co?key=bad','https://example.supabase.co/#hash'])
    assert.throws(()=>createRestProvider({...options,url}),{code:'DELTA_TRANSPORT_CONFIG'});
});
test('REST non-JSON errors retain HTTP retry classification; malformed successes stop',async()=>{
  for(const status of [429,502,200]){const provider=createRestProvider({url:'https://example.supabase.co',key:'public',session:()=>({access_token:'a',user:{id:OWNER}}),Socket:null,
    fetch:async url=>({ok:url.includes('/auth/')||status===200,status:url.includes('/auth/')?200:status,
      text:async()=>url.includes('/auth/')?JSON.stringify({id:OWNER}):'<html>private token</html>'})});
    const transport=createTransport({provider,scope:SCOPE,currentScope:()=>SCOPE});instances.add(transport);
    await assert.rejects(transport.push(event()),e=>{assert.equal(e.retryable,status!==200);if(status!==200)assert.equal(e.status,status);assert(!e.message.includes('private'));return true;});transport.close();}
});

test('atomic capability is learned from the authorized server, not a caller flag',async()=>{
  let online=true;const h=harness({transport:{online:()=>online}});
  assert.equal(h.transport.getCapabilities().atomicGroups,false);await rejects(()=>h.transport.pushGroup(group()),'DELTA_UPGRADE_REQUIRED');
  assert.equal(h.calls.length,0);await h.transport.ready();assert.equal(h.capabilityCalls.length,1);
  assert.deepEqual(h.capabilityCalls[0].args,{p_project_id:PROJECT,p_device_id:DEVICE});assert.equal(h.transport.getCapabilities().atomicGroups,true);
  online=false;assert.equal(h.transport.getCapabilities().atomicGroups,true);
  h.setScope({...SCOPE,projectId:PROJECT2});assert.equal(h.transport.getCapabilities().atomicGroups,false);
  h.setScope(SCOPE);assert.equal(h.transport.getCapabilities().atomicGroups,false);
});
test('unknown or wrong-scope capability results cannot enable grouped writes',async()=>{
  for(const change of [r=>r.ownerId=OTHER,r=>r.deviceId=OTHER,r=>r.projectId=PROJECT2,r=>r.schema=1,r=>r.atomicGroups=false,
    r=>r.groupMaxBytes=1,r=>r.groupMaxEvents=0,r=>delete r.pageTargetBytes]){
    const h=harness();h.setCapabilities(()=>{const result=capabilities();change(result);return {data:result};});
    await rejects(()=>h.transport.ready(),'DELTA_UPGRADE_REQUIRED');assert.equal(h.transport.getCapabilities().atomicGroups,false);h.transport.close();}
  const h=harness();h.setCapabilities(()=>({error:{code:'PGRST202',message:'missing capability RPC'},status:404}));
  await rejects(()=>h.transport.ready(),'DELTA_UPGRADE_REQUIRED');assert.equal(h.transport.getCapabilities().atomicGroups,false);
});
test('temporary capability outages retain offline support but explicit revocation clears it',async()=>{
  const h=harness();await h.transport.ready();h.setCapabilities(()=>({error:{message:'temporary'},status:503}));
  await assert.rejects(h.transport.ready(),e=>e.retryable===true);assert.equal(h.transport.getCapabilities().atomicGroups,true);
  h.setCapabilities(()=>({error:{code:'42501',message:'stopped device'},status:403}));
  await rejects(()=>h.transport.ready(),'DELTA_FORBIDDEN');assert.equal(h.transport.getCapabilities().atomicGroups,false);
});
test('group append sends one immutable envelope and verifies every ordered acknowledgement',async()=>{
  const h=harness();await h.transport.ready();h.setRpc((name,args)=>({data:groupAck(args.p_group)}));
  const value=group(),pending=h.transport.pushGroup(value);value.events[0].recordId='changed';
  assert.deepEqual(await pending,groupAck(group()));assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'sentlog_delta_append_group_v1');
  assert.deepEqual(h.calls[0].args,{p_project_id:PROJECT,p_device_id:DEVICE,p_group:group()});
  const duplicate={...groupAck(group()),duplicate:true};h.setRpc(()=>({data:duplicate}));assert.deepEqual(await h.transport.pushGroup(group()),duplicate);
});
test('partial, reordered or foreign group acknowledgements do not release any member',async()=>{
  for(const change of [r=>r.groupId='another',r=>r.deviceId=OTHER,r=>r.startSeq=0,r=>r.endSeq=5,r=>r.duplicate='true',
    r=>r.events.pop(),r=>r.events.reverse(),r=>r.events[1].seq=7,r=>r.events[0].drawingId='other',r=>r.events[1].eventId='other',r=>r.schema=2]){
    const h=harness();await h.transport.ready();h.setRpc(()=>{const result=groupAck(group());change(result);return {data:result};});
    await rejects(()=>h.transport.pushGroup(group()),'DELTA_NOT_DURABLE');assert.equal(h.calls.length,1);h.transport.close();}
});
test('mixed pages keep a complete group as one unit and advance to its end sequence',async()=>{
  const h=harness(),g=group();h.setRpc(()=>({data:page([{seq:1,event:event(10)},{seq:2,endSeq:3,group:g},{seq:4,event:event(11)}],{headSeq:4,hasMore:false})}));
  const rows=await h.transport.list(PROJECT,0,3);assert.equal(rows.length,3);assert.equal(rows[1].group.events.length,2);assert.equal(rows[1].endSeq,3);
  assert.equal(rows.headSeq,4);assert.equal(rows.hasMore,false);assert.deepEqual(rows[1].group,g);
  h.setRpc(()=>({data:page([{seq:2,endSeq:3,group:g}],{after:1,headSeq:4,hasMore:true})}));
  const single=await h.transport.list(PROJECT,1,1);assert.equal(single.length,1);assert.equal(single.hasMore,true);assert.equal(single[0].endSeq,3);
});
test('invalid group boundaries and truncated mixed pages fail before cursor publication',async()=>{
  for(const change of [r=>r.events[0].endSeq=1,r=>r.events[0].endSeq=3,r=>r.events[0].seq=2,
    r=>r.events[0].group.events.pop(),r=>r.events[0].group.projectId=PROJECT2,r=>r.events[0].group.events[1].deviceId=OTHER,
    r=>r.events[0].event=event(),r=>r.events[0].group.events[1].eventId=r.events[0].group.events[0].eventId,
    r=>r.hasMore=true,r=>r.schema=1]){
    const h=harness();h.setRpc(()=>{const result=page([{seq:1,endSeq:2,group:group()}],{headSeq:2,hasMore:false});change(result);return {data:result};});
    await assert.rejects(h.transport.list(PROJECT,0,100));h.transport.close();}
});
test('token refresh preserves confirmed capability while logout invalidates it and aborts a group',async()=>{
  const h=harness();await h.transport.ready();h.setSession({access_token:'group-refreshed',user:{id:OWNER}});
  assert.equal(h.transport.getCapabilities().atomicGroups,true);h.setRpc((name,args)=>({data:groupAck(args.p_group)}));
  await h.transport.pushGroup(group());assert.deepEqual(h.users,['token-a','group-refreshed']);assert.equal(h.calls[0].options.accessToken,'group-refreshed');
  const wait=deferred();h.setRpc(()=>wait.promise);const pending=h.transport.pushGroup(group());await settle();h.setSession(null);
  await rejects(()=>pending,'DELTA_AUTH_CHANGED');assert.equal(h.transport.getCapabilities().atomicGroups,false);assert.equal(h.calls[1].options.signal.aborted,true);
  wait.resolve({data:groupAck(group())});await settle();h.setSession({access_token:'group-returned',user:{id:OWNER}});
  assert.equal(h.transport.getCapabilities().atomicGroups,false);await h.transport.ready();assert.equal(h.transport.getCapabilities().atomicGroups,true);
});

(async()=>{let passed=0;for(const {name,fn} of cases){try{await fn();passed++;console.log('PASS '+name);}finally{for(const t of instances)t.close();instances.clear();}}
  console.log('delta transport: '+passed+' contract scenarios passed');})().catch(error=>{console.error(error);process.exitCode=1;});
