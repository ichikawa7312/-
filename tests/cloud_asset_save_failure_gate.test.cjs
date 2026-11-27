'use strict';
// Run the same behavioral assertions on the assembled source before/after the
// gate. FakeIndexedDB's injected commit abort is not a native quota simulation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,fullRound,within,hash,ROOT,WS,PREFIX,scopeExport,sourceSHA256}=require('./helpers/cloud_asset_failure_fixture.cjs');
const cases=[],test=(name,run)=>cases.push({name,run});
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
function noLaterDelivery(f){assert.equal(f.calls.writesAfterFailure,0);assert.equal(f.calls.acksAfterFailure,0);
  assert.equal(f.notifications.filter(event=>event.recordFailed).length,0);}
for(const kind of ['photo','drawing']){
  test(kind+': a known record failure stops inventory, save, notification and ACK',async()=>{
    const f=await fixture(kind),before=await f.snapshot(),draft=await f.failCommit();
    await assert.rejects(f.start(),error=>error.name==='QuotaExceededError');
    assert.deepEqual(f.calls,{inventory:0,download:0,write:0,ack:0,writesAfterFailure:0,acksAfterFailure:0});
    assert.equal(f.notifications.length,0);await f.assertPreserved(before,draft);
    await f.retryAndReceive();assert.equal(await f.read(PREFIX+draft.key),draft.raw);
  });
  for(const mutation of ['metadata','editor'])test(kind+': '+mutation+' commit failure during download stops delivery and preserves all durable stores',async()=>{
    const f=await fixture(kind,{hold:'download'}),workspaceBefore=f.records.getItem(WS),work=outcome(f.start());
    await within(f.downloadStarted,'download');const before=await f.snapshot(),draft=await f.failCommit(mutation);
    assert.equal(f.records.getItem(WS)!==workspaceBefore,mutation==='editor','Metadata-only failure must leave the workspace unchanged');
    f.releaseDownload();const result=await within(work,'failed receive');assert(result.error);noLaterDelivery(f);
    assert.equal(await f.read(f.key),undefined);assert.equal(f.notifications.length,0);assert.equal(f.calls.ack,0);
    await f.assertPreserved(before,draft);await f.retryAndReceive();assert.equal(await f.read(PREFIX+draft.key),draft.raw);
  });
  test(kind+': failure while the receipt cache is pending retains the saved asset and blocks the late ACK',async()=>{
    const f=await fixture(kind,{hold:'receipt'}),work=outcome(f.start());await within(f.receiptStarted,'receipt cache');
    assert.equal(await hash(await f.read(f.key)),f.asset.sha256);assert.equal(f.notifications.length,1);
    const before=await f.snapshot(),draft=await f.failCommit();f.releaseReceipt();
    const result=await within(work,'late ACK');assert(result.error);noLaterDelivery(f);assert.equal(f.calls.ack,0);
    assert.equal(f.notifications.length,1,'The valid notification before failure is not undone');await f.assertPreserved(before,draft);
    await f.retryAndReceive();assert.equal(await f.read(PREFIX+draft.key),draft.raw);assert.equal(f.calls.write,1);
  });
  test(kind+': ordinary pending records are allowed and are later committed normally',async()=>{
    const f=await fixture(kind,{hold:'download'}),work=outcome(f.start());await within(f.downloadStarted,'normal pending');
    f.holdPending();const draft=f.setMeta(2);assert(f.records.pending&&!f.records.failed);
    f.releaseDownload();const result=await within(work,'receive while pending');assert.equal(result.value,1);assert.equal(result.error,undefined);
    assert(f.records.pending&&!f.records.failed);assert.equal(f.calls.ack,1);assert.equal(await hash(await f.read(f.key)),f.asset.sha256);
    f.releasePending();await f.records.settled();assert.equal(await f.read(PREFIX+draft.key),draft.raw);assert(!f.records.pending&&!f.records.failed);
  });
  test(kind+': the real file round cannot send an ACK or a complete status after an unrelated metadata failure',async()=>{
    const f=await fixture(kind,{hold:'download'}),round=fullRound(f),work=outcome(round.start());await within(f.downloadStarted,'file round');
    const before=await f.snapshot(),draft=await f.failCommit();f.releaseDownload();const result=await within(work,'file round failure');
    assert.equal(result.error?.name,'QuotaExceededError');assert.equal(round.statuses.filter(status=>status.level==='ok').length,0);
    noLaterDelivery(f);assert.equal(f.notifications.length,0);assert.equal(f.calls.ack,0);await f.assertPreserved(before,draft);
    await f.retryAndReceive();assert.equal(await f.read(PREFIX+draft.key),draft.raw);
  });
  for(const fence of ['owner','device','import'])test(kind+': existing '+fence+' fence still blocks a pending receive',async()=>{
    const f=await fixture(kind,{hold:'download'}),work=outcome(f.start());await within(f.downloadStarted,fence+' fence');
    const before=await f.snapshot();f.change(fence);f.releaseDownload();const result=await within(work,'changed scope');
    assert.equal(result.error?.code,'FILE_RECEIVE_SCOPE_CHANGED');assert.deepEqual(await f.snapshot(),before);
    assert.equal(f.calls.write,0);assert.equal(f.calls.ack,0);assert.equal(f.notifications.length,0);assert(!f.records.failed);
  });
}
test('the PC scope guard remains independent of the main Records API',async()=>{
  const pc=fs.readFileSync(path.join(ROOT,'sentlog-pc/index.html'),'utf8');
  const start=pc.indexOf('function captureAssetReceiveScope('),end=pc.indexOf(scopeExport,start)+scopeExport.length;
  assert(start>=0&&end>start);assert(!pc.includes('sentlog-cloud-asset-save-failure-gate-v212'));
  const storage=new Map([['sentlogPcWebDeviceV1','synthetic-pc-device']]);
  const win={};Object.defineProperty(win,'SentlogRecords',{get(){throw Error('PC scope must not access main records');}});
  const session={access_token:'synthetic-pc-access',user:{id:'synthetic-owner'}};
  vm.runInNewContext(pc.slice(start,end),{window:win,DEVICE_KEY:'sentlogPcWebDeviceV1',localStorage:{getItem:key=>storage.get(key)??null},
    sessionGuard:{generation:()=>1,read:()=>session}});
  win.sentlogCaptureAssetReceiveScope('synthetic-pc-device')();
  assert.throws(()=>win.sentlogCaptureAssetReceiveScope('synthetic-other-device'),error=>error.code==='FILE_RECEIVE_SCOPE_CHANGED');
});
test('identity failures keep their existing code even when record saving has also failed',async()=>{
  const f=await fixture('photo');await f.failCommit();f.change('import');
  await assert.rejects(f.start(),error=>error.code==='FILE_RECEIVE_SCOPE_CHANGED');assert.equal(f.calls.download,0);assert.equal(f.calls.ack,0);
});
(async()=>{
  const report={scope:'Synthetic production-module/FakeIndexedDB regression; no native browser or actual quota claim',sourceSHA256,cases:[]};
  for(const item of cases){try{await item.run();report.cases.push({name:item.name,status:'passed'});console.log('PASS',item.name);}
    catch(error){report.cases.push({name:item.name,status:'failed',error:error.message});
      if(process.env.SENTLOG_CLOUD_ASSET_FAILURE_REPORT)fs.writeFileSync(process.env.SENTLOG_CLOUD_ASSET_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n');throw error;}}
  if(process.env.SENTLOG_CLOUD_ASSET_FAILURE_REPORT)fs.writeFileSync(process.env.SENTLOG_CLOUD_ASSET_FAILURE_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log('PASS cloud asset save-failure gate:',cases.length,'synthetic cases; existing 30-second receipt backoff preserved');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
