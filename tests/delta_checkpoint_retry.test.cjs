'use strict';
// A concurrent append may invalidate a compatibility checkpoint. Exercise the
// real transport, application coordinator, replica, and metadata/file workers
// together: an ordinary notification must not permanently strand photo work.
// All network/storage adapters are disposable; no browser or service is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module'),{webcrypto}=require('node:crypto');
// Fail closed even if a future production factory stops using our adapter.
// In particular Node exposes WebSocket: leaving the REST provider's default
// Socket would otherwise allow its replica subscription to open a connection.
const unexpectedNetwork=[];
function rejectNetwork(kind){unexpectedNetwork.push(kind);throw Error('Unexpected external '+kind+'; use the fixture adapter');}
globalThis.fetch=()=>rejectNetwork('fetch');
globalThis.WebSocket=class{constructor(){rejectNetwork('WebSocket');}};
const C=require('../sentlog/record-collaboration.js'),D=require('../sentlog/delta-sync-core.js');
const T=require('../sentlog/delta-sync-transport.js'),Runtime=require('../sentlog/delta-sync-app-runtime.js');
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const root=path.resolve(__dirname,'..'),copy=x=>structuredClone(x);
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT='11111111-1111-4111-8111-111111111111',DEVICE='aaaaaaaa-0000-4000-8000-000000000001';
const BASELINE='cccccccc-cccc-4ccc-8ccc-cccccccccccc',scope={ownerId:OWNER,projectId:PROJECT,deviceId:DEVICE};
const STALE={code:'40001',message:'DELTA_CHECKPOINT_STALE_HEAD private server detail'};

function productionRuntime(){
  // Read the actual build substitutions, without running a build or maintaining
  // a second copy of the delta branch. The one excluded substitution belongs
  // to the legacy asset downloader, outside collaboration-sync-runtime.txt.
  const changes=JSON.parse(execFileSync('python',['-c',String.raw`
import ast,json,pathlib
root=pathlib.Path.cwd()
runtime=(root/'sentlog/delta-sync-cloud-runtime.txt').read_text().strip()
changes=[]
for node in ast.parse((root/'scripts/build_delta_sync.py').read_text()).body:
    if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='view' for t in node.targets): break
    if not (isinstance(node,ast.Expr) and isinstance(node.value,ast.Call)): continue
    call=node.value
    if not (isinstance(call.func,ast.Name) and call.func.id=='change' and isinstance(call.args[0],ast.Name) and call.args[0].id=='cloud'): continue
    old=ast.literal_eval(call.args[1])
    new=eval(compile(ast.Expression(call.args[2]),'<cloud build substitution>','eval'),{'__builtins__':{},'runtime':runtime})
    changes.append([old,new])
print(json.dumps(changes))
`],{cwd:root,encoding:'utf8'}));
  let result=fs.readFileSync(path.join(root,'sentlog/collaboration-sync-runtime.txt'),'utf8'),applied=0;
  for(const [before,after] of changes){
    if(before==="    if(a.kind!=='drawing'&&a.kind!=='photo')continue;")continue;
    assert.equal(result.split(before).length-1,1,'production delta worker integration anchor: '+before);
    result=result.replace(before,after);applied++;
  }
  assert.equal(applied,8,'all production worker integration substitutions must be exercised');
  return result;
}

// Reuse the existing application fixture, but not its registered test cases.
// These are dependency injection points before the production runtime boots;
// no production function is replaced after initialization.
const fixturePath=path.join(__dirname,'collaboration_sync.test.cjs');
let fixtureSource=fs.readFileSync(fixturePath,'utf8');
const fixtureEnd=fixtureSource.indexOf("\ntest('unchanged common file references");
assert(fixtureEnd>0,'collaboration fixture boundary');fixtureSource=fixtureSource.slice(0,fixtureEnd);
const runtimeAnchor="const runtime=fs.readFileSync(require.resolve('../sentlog/collaboration-sync-runtime.txt'),'utf8');";
const configureAnchor='  vm.createContext(context);vm.runInContext(fileHelpers+runtime+';
assert.equal(fixtureSource.split(runtimeAnchor).length-1,1);
assert.equal(fixtureSource.split(configureAnchor).length-1,1);
fixtureSource=fixtureSource.replace(runtimeAnchor,'const runtime=__productionRuntime;')
  .replace(configureAnchor,'  __configure(context,h);vm.createContext(context);vm.runInContext(fileHelpers+runtime+');
const makeFixture=new Function('require','__productionRuntime','__configure',fixtureSource+'\nreturn {fixture,microtasks};');
const integratedRuntime=productionRuntime();

function fixture({races=1,error=STALE,httpStatus=409}={}){
  let h;
  const helper=makeFixture(createRequire(fixturePath),integratedRuntime,(context,state)=>{
    h=state;context.session={user:{id:OWNER},access_token:'fixture-access-token'};
    context.localStorage.setItem('device',DEVICE);
    const cp={id:PROJECT,client_key:'p1',name:'現場',status:'active'};
    h.cloudProjects=new Map([[PROJECT,cp]]);context.knownCloudProjects=new Map([[PROJECT,cp]]);
    h.restHook=async(route,options)=>route.includes('sentlog_devices')?
      (options.method?null:[{id:DEVICE,active:true,device_name:'test device'}]):undefined;
    const timers={setTimeout:h.time.setTimer,clearTimeout:h.time.clearTimer};
    const binding={scope:copy(scope),localProjectId:'p1',phase:'active',baselineId:BASELINE};
    const records=context.window.SentlogRecords;
    records.ready=true;
    records.deltaJournal={readBindingState:async()=>copy(binding),bindingStateFor:()=>copy(binding),
      bindingFor:()=>copy(binding),listBindingStatesSync:()=>[copy(binding)]};
    let durable={version:2,scope:copy(scope),cursor:0,outbox:[],records:{[D.keyOf('d1','r1')]:copy(h.base.drawings[0].state.shapes[0])}};
    const store={read:async()=>copy(durable),write:async value=>{durable=copy(value);},
      readProvenance:async()=>({baseline:{baselineId:BASELINE}}),close(){}};
    h.read=()=>copy(durable);h.rpc=[];h.checkpoints=[];h.photos=[];h.authGeneration=1;
    const events=[];h.append=()=>{
      const n=events.length+1,record=C.upgrade({id:'remote-'+n,kind:'field-record',memo:'remote '+n,photos:[]});
      events.push({seq:n,event:{schema:1,eventId:'event-'+n,projectId:PROJECT,deviceId:DEVICE,
        drawingId:'d1',recordId:record.id,kind:'create',record}});return n;
    };h.append();
    const receipt=()=>({schema:1,baselineId:BASELINE,ownerId:OWNER,projectId:PROJECT,snapshotRevision:7,cursor:0,
      recordCount:1,importedCount:1,snapshotSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),
      hashFormat:'postgres-jsonb-text-sha256-v1',state:'active',deltaEnabled:true,
      deviceMigrationVerified:false,assetDeliveryVerified:false});
    const response=(value,status=200)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(value)});
    const fetch=async(url,options)=>{
      assert.equal(new URL(url).origin,'https://example.invalid','only disposable adapter routes are accepted');
      assert.equal(options.headers.Authorization,'Bearer fixture-access-token');
      if(url.endsWith('/auth/v1/user'))return response({id:OWNER});
      const name=url.split('/').at(-1),args=JSON.parse(options.body);h.rpc.push({name,args,at:h.time.now()});
      assert.equal(args.p_project_id,PROJECT);assert.equal(args.p_device_id,DEVICE);
      if(name==='sentlog_delta_inspect_v1')return response({schema:1,...scope,enabled:true,canActivate:true,
        headSeq:events.length,snapshotRevision:7,checking:false,baseline:receipt()});
      if(name==='sentlog_delta_capabilities_v1')return response({schema:2,...scope,atomicGroups:true,
        groupMaxEvents:500,groupMaxBytes:4194304,pageTargetBytes:900000,sharedMetadata:true,certifiedArchive:true,writerJournal:2});
      if(name==='sentlog_delta_list_groups_v1')return response({schema:2,...scope,after:args.p_after,
        headSeq:events.length,events:events.slice(args.p_after,args.p_after+args.p_limit),hasMore:args.p_after+args.p_limit<events.length});
      if(name==='sentlog_delta_publish_checkpoint_v1'){
        h.checkpoints.push({head:args.p_expected_head,requestId:args.p_request_id,at:h.time.now()});
        if(h.checkpoints.length<=races){h.append();return response(error,httpStatus);}
        assert.equal(args.p_expected_head,events.length,'checkpoint retry must use the freshly received server head');
        return response({schema:1,projectId:PROJECT,headSeq:events.length,revision:8,payloadSha256:'c'.repeat(64),payload:copy(h.base)});
      }
      throw Error('unexpected delta RPC '+name);
    };
    const auth=new Set();context.sessionGuard={generation:()=>h.authGeneration,subscribe:fn=>{auth.add(fn);return()=>auth.delete(fn);}};
    h.switchAccount=()=>{context.session={user:{id:OTHER},access_token:'other-fixture-token'};h.authGeneration++;
      for(const fn of auth)fn('SIGNED_IN',context.session);h.api.reset();};
    context.window.SentlogSyncTraffic={withFileLock:async(key,fn)=>fn()};
    context.window.SentlogDeltaMigrationRecovery=require('../sentlog/delta-sync-migration-recovery.js');
    context.window.SentlogDeltaAppMigration={createInstaller:()=>async()=>{throw Error('already active: migration must not run');}};
    context.window.SentlogDeltaAppRuntime={createRuntime:options=>{
      const runtime=Runtime.createRuntime({...options,fetch,network:()=>context.navigator.onLine,visible:()=>!context.document.hidden,
        factories:{
          provider:options=>T.createRestProvider({...options,Socket:null}),
          transport:options=>T.createTransport({...options,timers}),store:()=>store,
          replica:options=>D.createReplica({...options,timers,reconcileIntervalMs:0}),
          // No local edits occur in this test. Storage/UI projection is the
          // fixture boundary; checkpoint sync and cursor proof stay real.
          controller:()=>({drain:async()=>{},project:async()=>({applied:true}),close(){}}),
          bridge:()=>({close(){}}),assetStore:()=>({close(){}}),assetTransport:()=>({close(){}}),
          assets:()=>({sync:async state=>{h.photos.push({at:h.time.now(),cursor:state.snapshot.cursor,
            recordIds:Object.values(state.snapshot.records).map(r=>r.id).sort()});
            return {complete:true,issues:[],message:'fixture photo adapter complete'};},close(){}})
        }});
      h.runtime=runtime;return runtime;
    }};
  });
  const result=helper.fixture();
  vm.runInContext('this.failureMaps={metadata:collaborationMetadataFailures,files:collaborationFileFailures};',result.context);
  const stop=result.stop;result.stop=()=>{stop();result.runtime.close();};
  result.failures=result.context.failureMaps;return result;
}

const cases=[];function test(name,fn){cases.push({name,fn});}
async function begin(h){h.api.files.request(['p1']);await h.time.tick(0);assert.equal(h.checkpoints.length,1);}
function assertPending(h){
  const failure=h.failures.metadata.get('p1');assert(failure,'checkpoint failure must remain visible');
  assert.equal(failure.code,'DELTA_CHECKPOINT_STALE_HEAD');assert.equal(failure.status,409);
  assert.equal(h.photos.length,0,'photos wait for successful metadata');
  assert(h.api.metadata.pending.includes('p1'));assert(h.api.files.pending.includes('p1'));
  assert.equal(failure.retryAt,h.time.now()+30000,'stale checkpoint must have a finite 30-second automatic retry');
}
function assertRecovered(h,expectedHead){
  assert.equal(h.failures.metadata.size,0,JSON.stringify([...h.failures.metadata]));
  assert.equal(h.failures.files.size,0,JSON.stringify([...h.failures.files]));
  assert.equal(h.api.metadata.pending.length,0);assert.equal(h.api.files.pending.length,0);
  assert.equal(h.photos.length,1,'the queued photo pass resumes automatically, exactly once');
  assert.equal(h.photos[0].cursor,expectedHead);assert.equal(h.read().cursor,expectedHead);
  assert.equal(h.read().outbox.length,0);assert.equal(h.photos[0].recordIds.length,expectedHead+1);
  assert(h.photos[0].recordIds.includes('r1'),'the existing record remains present');
}

test('three concurrent appends back off then automatically refresh checkpoint and unblock photos',async()=>{
  const h=fixture({races:3});try{
    await begin(h);assertPending(h);
    for(let attempt=1;attempt<=3;attempt++){
      // Ordinary realtime notifications cannot shorten a project backoff.
      h.channel.onChange({kind:'asset',projectId:PROJECT});
      h.channel.onChange({kind:'record',projectId:PROJECT,revision:99});
      await h.time.tick(29999);assert.equal(h.checkpoints.length,attempt);assert.equal(h.photos.length,0);
      await h.time.tick(1);assert.equal(h.checkpoints.length,attempt+1);
      if(attempt<3)assertPending(h);
    }
    assert.deepEqual(h.checkpoints.map(c=>c.head),[1,2,3,4]);
    assert.deepEqual(h.checkpoints.map(c=>c.at),[100000,130000,160000,190000]);
    assert.equal(new Set(h.checkpoints.map(c=>c.requestId)).size,4,'each newly refreshed checkpoint has its own request identity');
    assertRecovered(h,4);
    assert(h.statuses.some(s=>s.level==='error'),'transient failure is reported, not silently dropped');
    assert.equal(h.statuses.at(-1).level,'ok');
  }finally{h.stop();}
});

test('checkpoint backoff pauses offline and resumes on the existing online event',async()=>{
  const h=fixture();try{
    await begin(h);assertPending(h);h.context.navigator.onLine=false;h.events.offline();
    await h.time.tick(90000);assert.equal(h.checkpoints.length,1);assert.equal(h.photos.length,0);
    h.context.navigator.onLine=true;h.events.online();await h.time.tick(0);
    assert.deepEqual(h.checkpoints.map(c=>c.head),[1,2]);assertRecovered(h,2);
  }finally{h.stop();}
});

test('account reset cancels a stale-checkpoint retry without sending old project files',async()=>{
  const h=fixture();try{
    await begin(h);assertPending(h);h.switchAccount();await h.time.tick(90000);
    assert.equal(h.checkpoints.length,1);assert.equal(h.photos.length,0);
    assert.equal(h.api.metadata.pending.length,0);assert.equal(h.api.files.pending.length,0);
    assert.equal(h.read().cursor,1,'old account durable replica is retained');
  }finally{h.stop();}
});

test('other conflicts, near-matching codes and authorization denials remain stopped',async()=>{
  const matrix=[
    [{code:'40001',message:'DELTA_BASELINE_STALE_HEAD'},409],
    [{code:'40001',message:'DELTA_CHECKPOINT_STALE_HEAD_EXTRA'},409],
    [{code:'40001',message:'serialization failure'},409],
    [{code:'23505',message:'DELTA_CHECKPOINT_STALE_HEAD'},409],
    [{code:'23505',message:'DELTA_EVENT_ID_COLLISION'},409],
    [{code:'55000',message:'DELTA_NOT_ACTIVATED'},409],
    [{message:'DELTA_CHECKPOINT_STALE_HEAD'},409],
    [{code:'40001',message:'DELTA_CHECKPOINT_STALE_HEAD'},401],
    [{code:'40001',message:'DELTA_CHECKPOINT_STALE_HEAD'},403],
    [{code:'42501',message:'DELTA_FORBIDDEN'},403]
  ];
  for(const [error,httpStatus] of matrix){
    const h=fixture({error,httpStatus});try{
      await begin(h);assert.equal(h.photos.length,0);
      const failure=h.failures.metadata.get('p1');
      assert.equal(failure?.retryAt??h.api.metadata.retryAt,Infinity,JSON.stringify({error,httpStatus}));
      h.channel.onChange({kind:'asset',projectId:PROJECT});
      h.channel.onChange({kind:'record',projectId:PROJECT,revision:99});
      await h.time.tick(120000);assert.equal(h.checkpoints.length,1,JSON.stringify({error,httpStatus}));
      assert.equal(h.photos.length,0);assert.equal(h.read().cursor,1);
    }finally{h.stop();}
  }
});

(async()=>{let failures=0;for(const {name,fn} of cases){try{await fn();assert.deepEqual(unexpectedNetwork,[],'no real network adapter may be used');console.log('ok - '+name);}catch(error){failures++;console.error('not ok - '+name);console.error(error);}}
  console.log(`${cases.length-failures}/${cases.length} checkpoint retry cases passed`);if(failures)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
