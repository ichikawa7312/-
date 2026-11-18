const assert=require('node:assert/strict');
const {createSession,captureStill}=require('../sentlog/continuous-camera.js');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const target={projectId:'p',drawingId:'d',recordId:'r',ownerId:'owner'};
function fixture(){
  let serial=0;const prepared=[],registered=[],canceled=[];
  const photos={prepareCapture(t){const intent={operationId:'op-'+(++serial),target:structuredClone(t)};prepared.push(intent);return intent;},
    cancelCapture(i){canceled.push(i);return true;},
    async register(files,intent){registered.push({files,intent});return [{status:'attached',photoId:intent.operationId,originalSaved:true}];},
    async retryPending(id){return [{status:'attached',photoId:id,originalSaved:true}];}};
  let captureCount=0;
  const session=createSession({target,photos,takePhoto:async()=>{captureCount++;return new Blob(['image'],{type:'image/jpeg'});}});
  return {session,photos,prepared,registered,canceled,get captureCount(){return captureCount;}};
}
async function test(name,fn){await fn();console.log('PASS '+name);}
(async()=>{
  await test('each shutter gets a fresh operation and reuses the opening target',async()=>{
    const f=fixture();for(let i=0;i<3;i++)await f.session.capture();
    assert.equal(f.session.snapshot().saved,3);assert.equal(new Set(f.prepared.map(x=>x.operationId)).size,3);
    for(const p of f.prepared)assert.deepEqual(p.target,target);
    const publicState=f.session.snapshot();publicState.target.recordId='changed';await f.session.capture();
    assert.equal(f.prepared.at(-1).target.recordId,'r');
  });
  await test('rapid taps cannot create parallel photos or false saved counts',async()=>{
    const f=fixture(),gate=defer();f.photos.register=async(files,intent)=>{await gate.promise;return [{status:'attached',photoId:intent.operationId,originalSaved:true}];};
    const first=f.session.capture();assert.equal(f.session.snapshot().busy,true);
    assert.equal((await f.session.capture()).status,'busy');assert.equal(f.session.snapshot().saved,0);
    gate.resolve();await first;assert.equal(f.captureCount,1);assert.equal(f.session.snapshot().saved,1);
  });
  await test('Done waits for local save and does not discard the last picture',async()=>{
    const f=fixture(),gate=defer();f.photos.register=async(files,intent)=>{await gate.promise;return [{status:'attached',photoId:intent.operationId,originalSaved:true}];};
    const capture=f.session.capture();let closed=false;const finish=f.session.close().then(x=>closed=x);
    await Promise.resolve();assert.equal(closed,false);assert.equal(f.session.snapshot().closing,true);
    gate.resolve();await capture;await finish;assert.equal(closed,true);assert.equal(f.session.snapshot().saved,1);
    assert.equal((await f.session.capture()).status,'busy');
  });
  await test('durable pending original is retained without being counted as attached',async()=>{
    const f=fixture();f.photos.register=async(files,intent)=>[{status:'pending',photoId:intent.operationId,originalSaved:true,error:'Target was removed'}];
    await f.session.capture();const s=f.session.snapshot();assert.equal(s.saved,0);assert.equal(s.pending,1);assert.equal(s.unsaved,false);
    assert.equal(await f.session.close(),true);
  });
  await test('unsaved original blocks another capture and Done until retried',async()=>{
    const f=fixture();f.photos.register=async(files,intent)=>[{status:'pending',photoId:intent.operationId,originalSaved:false,error:'Quota'}];
    await f.session.capture();assert.equal(f.session.snapshot().unsaved,true);assert(f.session.unsavedFile() instanceof Blob);
    assert.equal(await f.session.close(),false);assert.equal((await f.session.capture()).status,'unsaved');
    const id=f.prepared[0].operationId;await f.session.retry();assert.equal(f.session.snapshot().entries[0].photoId,id);
    assert.equal(f.session.snapshot().saved,1);assert.equal(f.session.snapshot().unsaved,false);assert.equal(await f.session.close(),true);
  });
  await test('a failure before register returns can retry the same intent and bytes',async()=>{
    const f=fixture();let attempts=0,first;
    f.photos.register=async(files,intent)=>{first||={file:files[0],intent};assert.equal(files[0],first.file);assert.equal(intent,first.intent);
      if(++attempts===1)throw Error('storage read unavailable');return [{status:'attached',photoId:intent.operationId,originalSaved:true}];};
    await f.session.capture();assert.equal(f.session.snapshot().saved,0);assert.equal(await f.session.close(),false);
    await f.session.retry();assert.equal(f.session.snapshot().saved,1);assert.equal(f.prepared.length,1);
  });
  await test('camera failure cancels only its empty intent',async()=>{
    const f=fixture(),session=createSession({target,photos:f.photos,takePhoto:async()=>{throw Error('camera failed');}});
    await session.capture();assert.equal(f.canceled.length,1);assert.equal(session.snapshot().unsaved,false);assert.equal(await session.close(),true);
  });
  await test('review removal changes the visible count without losing capture history',async()=>{
    const f=fixture();await f.session.capture();const id=f.session.snapshot().entries[0].photoId;
    f.session.markRemoved(id,true);assert.equal(f.session.snapshot().saved,0);assert.equal(f.session.snapshot().entries.length,1);
    f.session.markRemoved(id,false);assert.equal(f.session.snapshot().saved,1);
  });
  await test('ImageCapture keeps full still bytes when supported',async()=>{
    const original=new Blob(['full photo'],{type:'image/jpeg'});let calls=0;
    class Capture{constructor(t){assert.equal(t.readyState,'live');}async takePhoto(){calls++;return original;}}
    const blob=await captureStill({}, {readyState:'live'}, Capture, {createElement(){throw Error('must not downscale');}});
    assert.equal(blob,original);assert.equal(calls,1);
  });
  await test('fallback takes the actual stream resolution and releases its canvas',async()=>{
    let dimensions,draws=0;const canvas={width:0,height:0,getContext:()=>({drawImage(v,x,y,w,h){draws++;dimensions=[w,h];}}),toBlob(fn){fn(new Blob(['frame'],{type:'image/jpeg'}));}};
    const video={videoWidth:2560,videoHeight:1920,readyState:4};
    const blob=await captureStill(video,{readyState:'live'},undefined,{createElement:()=>canvas});
    assert(blob.size);assert.deepEqual(dimensions,[2560,1920]);assert.equal(draws,1);assert.equal(canvas.width,1);assert.equal(canvas.height,1);
  });
  await test('ended or not-ready camera never counts an empty photo',async()=>{
    await assert.rejects(captureStill({}, {readyState:'ended'}),/カメラが停止/);
    await assert.rejects(captureStill({videoWidth:0,videoHeight:0,readyState:0},{readyState:'live'},undefined,{}),/準備中/);
  });
  await test('camera interruptions cannot turn a stale video frame into a new photo',async()=>{
    await assert.rejects(captureStill({}, {readyState:'live',muted:true}),/一時停止/);
    const track={readyState:'live',muted:false};
    class InterruptedCapture{async takePhoto(){track.muted=true;throw Error('interrupted');}}
    await assert.rejects(captureStill({videoWidth:100,videoHeight:100,readyState:4},track,InterruptedCapture,
      {createElement(){throw Error('must not save the stale canvas frame');}}),/一時停止/);
  });
})().catch(e=>{console.error(e);process.exitCode=1;});
