'use strict';
const assert=require('node:assert/strict');
const Runtime=require('../sentlog/delta-sync-app-runtime.js');
const scope={ownerId:'11111111-1111-4111-8111-111111111111',projectId:'55555555-5555-4555-8555-555555555555',deviceId:'33333333-3333-4333-8333-333333333333'};
const cp={id:scope.projectId,client_key:'local-project'};
const session={access_token:'synthetic-test-token',user:{id:scope.ownerId}};
function fixture({code='PGRST202',status=404,bound=false}={}){
  const calls=[];
  const provider={getSession:async()=>session,peekSession:()=>session,getUser:async()=>session.user,
    rpc:async name=>{calls.push(name);return {error:{code,message:'Synthetic RPC error'},status};}};
  const runtime=Runtime.createRuntime({records:{deltaJournal:{listBindings:async()=>bound?[{localProjectId:cp.client_key,scope,phase:'active'}]:[]}},
    session:()=>session,ensureSession:async()=>{},authGeneration:()=>1,subscribeAuth:()=>()=>{},deviceId:()=>scope.deviceId,
    install:async()=>{throw Error('Unexpected migration');},applyProjection:async()=>{throw Error('Unexpected projection');},
    readFile:async()=>null,withFileLock:async(key,fn)=>fn(),actor:()=>({deviceId:scope.deviceId}),
    factories:{provider:()=>provider,store:()=>({close(){}})}});
  return {runtime,calls};
}
(async()=>{
  const missing=fixture();try{
    assert.deepEqual(await missing.runtime.inspect(cp),{enabled:false,canActivate:false,serverInstalled:false});
    assert.deepEqual(missing.calls,['sentlog_delta_inspect_v1']);
    console.log('PASS an unbound legacy project continues after an actual normalized missing-inspect response');
  }finally{missing.runtime.close();}
  for(const options of [{bound:true},{status:403},{code:'42P01'},{code:'42501',status:403},{code:'XX000',status:500}]){
    const f=fixture(options);try{await assert.rejects(()=>f.runtime.inspect(cp));assert.equal(f.calls.length,1);}
    finally{f.runtime.close();}
  }
  console.log('PASS bound, forbidden, missing-table and server-error projects never fall back to the legacy writer');
  const paused=fixture();try{
    const first=await paused.runtime.suspendPhotos(cp),second=await paused.runtime.suspendPhotos(cp);
    assert.equal(first.validate(),true);assert.equal(second.validate(),true);
    assert.equal((await paused.runtime.photos(cp)).skipped,true);first();first();
    assert.throws(()=>first.validate(),error=>error.code==='DELTA_PHOTOS_LEASE');
    assert.equal(second.validate(),true);assert.equal((await paused.runtime.photos(cp)).skipped,true);second();
    globalThis.SentlogCapacity={isCleared:id=>id===cp.id};
    assert.equal((await paused.runtime.photos(cp)).skipped,true);assert.equal(paused.calls.length,0);
    console.log('PASS capacity leases and persisted cleanup markers prevent automatic photo redelivery');
  }finally{delete globalThis.SentlogCapacity;paused.runtime.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
