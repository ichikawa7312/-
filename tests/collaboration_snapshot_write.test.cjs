'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// The normal run tests the shipped runtime. An explicit source override permits
// validating a prepared replacement before another worker integrates the file.
const filename=process.env.SENTLOG_UPSERT_SOURCE||path.resolve(__dirname,'../sentlog/collaboration-sync-runtime.txt');
const runtime=fs.readFileSync(filename,'utf8'),start=runtime.indexOf('async function collaborationUpsert(');
assert.ok(start>=0,'actual collaborationUpsert is present');
const end=runtime.indexOf('\n}',start);assert.ok(end>start,'function closing brace is present');
const source=runtime.slice(start,end+2),copy=x=>JSON.parse(JSON.stringify(x));
const cases=[],test=(name,fn)=>cases.push({name,fn});

function fixture(revision=1){
  const cp={id:'11111111-1111-4111-8111-111111111111',client_key:'local-p1'},project={id:'local-p1',name:'現場',updatedAt:10,drawings:[]};
  const h={cp,projects:[project],snapshot:{project:copy(project),drawings:[]},meta:{revision,fingerprint:'old',fingerprint_schema:2},calls:[],saved:[],owner:'owner-a',generation:1,restHook:null,hashHook:null};
  const context={Date,Array,Number,String,Object,Error,JSON,enc:encodeURIComponent,SYNC_FINGERPRINT_SCHEMA:2,collaborationDeviceCache:{id:'device-a'},
    workspace:()=>({projects:h.projects}),projectSnapshot:()=>copy(h.snapshot),
    snapshotFingerprint:async snapshot=>{if(h.hashHook)await h.hashHook();return JSON.stringify(snapshot);},
    getSyncMeta:()=>h.meta,setSyncMeta:(id,meta,baseline)=>{h.saved.push({id,meta:copy(meta),baseline:copy(baseline)});h.meta={...meta,fingerprint_schema:2};},
    collaborationCasConflict:error=>String(error?.message||error).includes('別端末の変更があります。同期を再確認してください。'),
    rest:async(url,options)=>{const call={url,options,body:JSON.parse(options.body)};h.calls.push(call);if(h.restHook)return h.restHook(call);
      return [{project_id:cp.id,revision:call.body.revision,updated_at:'2026-11-19T04:00:00Z'}];}};
  vm.createContext(context);vm.runInContext(source+'\nthis.save=collaborationUpsert;',context);
  h.context=context;h.current={owner:'owner-a',assertCurrent(){if(h.owner!=='owner-a'||h.generation!==1)throw Object.assign(Error('account changed'),{code:'COLLAB_ACCOUNT_CHANGED'});}};
  h.run=(expected=revision)=>context.save(cp,h.projects[0]||project,'device-a',expected,h.current);
  return h;
}
function query(call){return new URL(call.url,'https://example.invalid').searchParams;}
function assertNoReceipt(h){assert.equal(h.saved.length,0,'unsaved/unconfirmed data must not advance the local receipt');}

test('existing snapshot uses revision-conditional PATCH and a small verified receipt',async()=>{
  const h=fixture(),r=await h.run(),c=h.calls[0],q=query(c);
  assert.equal(c.options.method,'PATCH');assert.equal(q.get('project_id'),'eq.'+h.cp.id);assert.equal(q.get('revision'),'eq.1');
  assert.equal(q.get('select'),'project_id,revision,updated_at');assert.equal(q.has('on_conflict'),false);
  assert.equal(c.options.headers.Prefer,'return=representation');assert.equal(c.body.revision,2);assert.equal(c.body.updated_by_device,'device-a');
  assert.equal('project_id' in c.body,false);assert.equal('owner_id' in c.body,false,'UPDATE must not rewrite ownership');
  assert.deepEqual(c.body.payload,h.snapshot);assert.equal(r.skipped,false);assert.equal(r.revision,2);assert.equal(h.saved.length,1);
  assert.equal(h.saved[0].meta.remote_updated_at,'2026-11-19T04:00:00Z');assert.deepEqual(h.saved[0].baseline,h.snapshot);
});
test('a new snapshot uses plain INSERT with the current owner and a small receipt',async()=>{
  const h=fixture(0),r=await h.run(),c=h.calls[0],q=query(c);
  assert.equal(c.options.method,'POST');assert.equal(q.get('select'),'project_id,revision,updated_at');assert.equal(q.has('on_conflict'),false);
  assert.equal(c.options.headers.Prefer,'return=representation');assert.equal(c.body.project_id,h.cp.id);assert.equal(c.body.owner_id,'owner-a');
  assert.equal(c.body.revision,1);assert.equal(r.revision,1);assert.equal(h.saved.length,1);
});
test('zero-row conditional UPDATE remains pending and retains the previous receipt',async()=>{
  const h=fixture();h.restHook=async()=>[];const r=await h.run();assert.equal(r.pending,true);assert.equal(r.revision,1);assertNoReceipt(h);assert.equal(h.meta.revision,1);
});
test('a concurrent new INSERT duplicate is pending rather than a successful save',async()=>{
  const h=fixture(0);h.restHook=async()=>{throw Object.assign(Error('duplicate key'),{status:409,code:'23505'});};
  const r=await h.run();assert.equal(r.pending,true);assert.equal(r.revision,0);assertNoReceipt(h);
});
test('other HTTP 409 failures are not concealed as INSERT conflicts',async()=>{
  for(const code of ['23503',undefined]){const h=fixture(0),error=Object.assign(Error('other conflict'),{status:409,code});h.restHook=async()=>{throw error;};
    await assert.rejects(h.run(),e=>e===error);assertNoReceipt(h);}
});
test('a duplicate error on PATCH is not mistaken for a first-insert race',async()=>{
  const h=fixture(),error=Object.assign(Error('duplicate'),{status:409,code:'23505'});h.restHook=async()=>{throw error;};
  await assert.rejects(h.run(),e=>e===error);assertNoReceipt(h);
});
test('the existing database revision guard still schedules a fresh read',async()=>{
  const h=fixture();h.restHook=async()=>{throw Error('別端末の変更があります。同期を再確認してください。');};
  const r=await h.run();assert.equal(r.pending,true);assert.equal(r.revision,1);assertNoReceipt(h);
});
test('timeout and transport failures preserve the original error and local receipt',async()=>{
  for(const error of [Object.assign(Error('canceling statement due to statement timeout'),{status:500,code:'57014'}),Error('network disconnected')]){
    const h=fixture();h.restHook=async()=>{throw error;};await assert.rejects(h.run(),e=>e===error);assertNoReceipt(h);assert.equal(h.meta.revision,1);
  }
});
test('malformed or mismatched successful responses never confirm a save',async()=>{
  for(const make of [()=>null,()=>({}),()=>[],h=>[{project_id:'another-project',revision:1}],h=>[{project_id:h.cp.id,revision:99}],h=>[{revision:1}],h=>[{project_id:h.cp.id,revision:1},{project_id:h.cp.id,revision:1}]]){
    const h=fixture(0);h.restHook=async()=>make(h);await assert.rejects(h.run(),e=>e.code==='COLLAB_SAVE_UNCONFIRMED');assertNoReceipt(h);
  }
});
test('Postgres bigint returned as a numeric string is a valid receipt',async()=>{
  const h=fixture();h.restHook=async()=>[{project_id:h.cp.id,revision:'2',updated_at:'2026-11-19T04:00:00Z'}];
  assert.equal((await h.run()).revision,2);assert.equal(h.saved.length,1);
});
test('an owner change while hashing prevents any write',async()=>{
  const h=fixture();h.hashHook=async()=>{h.owner='owner-b';};await assert.rejects(h.run(),e=>e.code==='COLLAB_ACCOUNT_CHANGED');
  assert.equal(h.calls.length,0);assertNoReceipt(h);
});
test('an owner change after the request cannot confirm data in the new account',async()=>{
  const h=fixture();h.restHook=async()=>{h.owner='owner-b';return [{project_id:h.cp.id,revision:2}];};
  await assert.rejects(h.run(),e=>e.code==='COLLAB_ACCOUNT_CHANGED');assertNoReceipt(h);
});
test('same-owner generation changes invalidate an in-flight receipt',async()=>{
  const h=fixture();h.restHook=async()=>{h.generation++;return [{project_id:h.cp.id,revision:2}];};
  await assert.rejects(h.run(),e=>e.code==='COLLAB_ACCOUNT_CHANGED');assertNoReceipt(h);
});
test('protocol and history failures retain their permanent retry classification',async()=>{
  for(const prefix of ['COLLAB_UPGRADE_REQUIRED:','COLLAB_HISTORY_REQUIRED:']){const h=fixture(),error=Error(prefix+' guarded');h.restHook=async()=>{throw error;};
    await assert.rejects(h.run(),e=>e===error&&e.retryable===false);assertNoReceipt(h);}
});
test('invalid device responses clear the cached device without confirming a save',async()=>{
  const h=fixture();h.restHook=async()=>{throw Error('COLLAB_DEVICE_REQUIRED: device inactive');};await assert.rejects(h.run(),/COLLAB_DEVICE_REQUIRED:/);
  assert.equal(h.context.collaborationDeviceCache,null);assertNoReceipt(h);
});
test('unchanged fingerprint and a local revision mismatch do not write',async()=>{
  const h=fixture();h.meta.fingerprint=JSON.stringify(h.snapshot);assert.equal((await h.run()).skipped,true);assert.equal(h.calls.length,0);assertNoReceipt(h);
  const other=fixture();other.meta.revision=3;assert.equal((await other.run()).pending,true);assert.equal(other.calls.length,0);assertNoReceipt(other);
});
test('a project removed before saving does not write',async()=>{
  const h=fixture();h.projects=[];assert.equal((await h.run()).skipped,true);assert.equal(h.calls.length,0);assertNoReceipt(h);
});
test('local edits during a save are excluded from its receipt and remain sendable',async()=>{
  const h=fixture(),before=copy(h.snapshot);h.restHook=async c=>{h.snapshot.project.name='送信中の変更';h.snapshot.project.updatedAt=20;h.projects=[copy(h.snapshot.project)];return [{project_id:h.cp.id,revision:c.body.revision}];};
  await h.run();assert.deepEqual(h.saved[0].baseline,before);assert.equal(h.saved[0].meta.fingerprint,JSON.stringify(before));
  h.restHook=null;await h.run(2);assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.payload.project.name,'送信中の変更');assert.equal(h.saved[1].meta.revision,3);
});
test('an accepted write with a lost reply cannot be falsely confirmed by retrying the old revision',async()=>{
  const h=fixture();let serverRevision=1;
  h.restHook=async c=>{if(query(c).get('revision')!=='eq.'+serverRevision)return [];serverRevision=c.body.revision;throw Error('reply lost');};
  await assert.rejects(h.run(),/reply lost/);assertNoReceipt(h);assert.equal(serverRevision,2);
  const retry=await h.run();assert.equal(retry.pending,true);assert.equal(serverRevision,2);assertNoReceipt(h);
});

(async()=>{let passed=0;for(const {name,fn} of cases){await fn();passed++;console.log('ok - '+name);}console.log(passed+' snapshot write tests passed');})().catch(error=>{console.error(error);process.exitCode=1;});
