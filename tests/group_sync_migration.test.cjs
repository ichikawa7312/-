const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const groups=require(path.join(root,'sentlog/drawing-groups.js'));

const legacy={
  project:{id:'p1',name:'案件',updatedAt:100,drawings:[
    {id:'d1',name:'平面図',fileName:'plan.pdf',sourceType:'pdf',createdAt:1,updatedAt:10},
    {id:'d2',name:'断面図',fileName:'section.pdf',sourceType:'pdf',createdAt:2,updatedAt:20}
  ]},
  drawings:[
    {meta:{id:'d1',name:'平面図',fileName:'plan.pdf',sourceType:'pdf',createdAt:1,updatedAt:10},state:{project:'案件',fileName:'plan.pdf',shapes:[],currentPage:1,width:100,height:200,pdfPageInfo:{}}},
    {meta:{id:'d2',name:'断面図',fileName:'section.pdf',sourceType:'pdf',createdAt:2,updatedAt:20},state:{project:'案件',fileName:'section.pdf',shapes:[],currentPage:1,width:100,height:200,pdfPageInfo:{}}}
  ]
};
const normalized=JSON.parse(JSON.stringify(legacy));
for(const d of normalized.project.drawings){
  d.groupId=d.id;d.groupName=d.name;d.sheetName=d.name;d.sheetOrder=1;
}
for(const item of normalized.drawings){
  const d=item.meta;d.groupId=d.id;d.groupName=d.name;d.sheetName=d.name;d.sheetOrder=1;
}

assert.deepEqual(groups.normalizeSnapshotPayload(legacy),groups.normalizeSnapshotPayload(normalized),
  'legacy one-sheet drawings and deterministic v1.71 migration must compare identically');

const grouped=JSON.parse(JSON.stringify(normalized));
grouped.project.drawings[1].groupId='d1';
grouped.project.drawings[1].groupName='平面図';
grouped.project.drawings[1].sheetName='断面図';
grouped.project.drawings[1].name='断面図';
grouped.project.drawings[1].sheetOrder=2;
grouped.drawings[1].meta={...grouped.project.drawings[1]};
assert.notDeepEqual(groups.normalizeSnapshotPayload(legacy),groups.normalizeSnapshotPayload(grouped),
  'real grouping changes must remain visible to conflict detection');

const syncView=fs.readFileSync(path.join(root,'sentlog/sync-view.js'),'utf8');
assert.match(syncView,/SentlogDrawingGroups/);
assert.match(syncView,/normalizeSnapshotPayload/);
assert.match(syncView,/groupFingerprintSchema:2/);

const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
assert.match(cloud,/SYNC_FINGERPRINT_SCHEMA=2/);
assert.match(cloud,/fingerprint_schema:SYNC_FINGERPRINT_SCHEMA/);
if(cloud.includes('collaboration-sync-v1')){
  assert.match(cloud,/before\?\.base_snapshot[\s\S]*Number\(before.fingerprint_schema\|\|0\)>=SYNC_FINGERPRINT_SCHEMA[\s\S]*revision===Number\(before.revision\)/,
    'a matching revision can skip its payload only with a current-schema baseline');
}else{
  assert.match(cloud,/!!meta\?\.fingerprint && Number\(meta\?\.fingerprint_schema\|\|0\)<SYNC_FINGERPRINT_SCHEMA/,
    'old stored fingerprints must force one reconciliation pass');
}
assert.match(cloud,/currentFingerprint=Number\(meta\?\.fingerprint_schema\|\|0\)>=SYNC_FINGERPRINT_SCHEMA/);
assert.match(cloud,/meta\.fingerprint&&currentFingerprint\?localFingerprint!==meta\.fingerprint:Number\(lp\.updatedAt\|\|0\)!==Number\(meta\.local_updated_at\|\|0\)/,
  'pre-v1.72 metadata must use timestamps so deterministic migration is not mistaken for a local edit');

const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/drawing-groups\.js\?v=172/);
assert.match(index,/sync-view\.js\?v=172/);
assert.match(index,/cloud-sync\.js\?v=20261018-group-sync-172/);
assert.match(index,/phone-runtime\.js\?v=172/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/sentlog-pwa-v183/);

console.log('PASS group sync migration: deterministic v1.71 metadata is canonicalized, old fingerprint schema is reconciled once, real grouping edits still differ');

if(cloud.includes('collaboration-sync-v1')){
  const watchdog=setTimeout(()=>{console.error('FAIL legacy schema reconciliation did not settle');process.exit(1);},15000);
  (async()=>{
    const {fixture}=require('./edit_sync_integration.test.cjs'),key='sentlogCloudProjectSyncV2:a';
    const oldSchema=f=>{const m=JSON.parse(f.data.get(key));m.fingerprint_schema=1;m.fingerprint='pre-migration fingerprint';m.local_updated_at=1;f.data.set(key,JSON.stringify(m));};
    const f=fixture();oldSchema(f);
    await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(f.events.filter(e=>e[0]==='payload').length,1,'unchanged server revision still reads a legacy-schema snapshot');
    assert.equal(f.api.getSyncMeta('a').fingerprint_schema,2);assert.equal(f.outgoing().length,0,'schema reconciliation alone does not upload a false local edit');
    oldSchema(f);f.incoming('a',p=>p.drawings[0].state.shapes[0].memo='別端末からの新しい所見');
    await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(JSON.parse(f.data.get('surveyFieldNoteDrawingV1:drawing-a')).shapes[0].memo,'別端末からの新しい所見','unchanged legacy timestamps allow the remote change without a false conflict');
    assert(!f.events.some(e=>e[0]==='merge'));f.stop();
    const g=fixture();oldSchema(g);const ws=JSON.parse(g.data.get('surveyFieldNoteWorkspaceV1'));ws.projects.find(p=>p.id==='a').updatedAt=2;g.data.set('surveyFieldNoteWorkspaceV1',JSON.stringify(ws));
    g.edit('a',d=>d.shapes[0].memo='未送信の変更');g.incoming('a',p=>p.drawings[0].state.shapes[0].memo='同時変更');
    await g.api.syncNow({eventDriven:true,projectIds:['a']});
    assert(g.events.some(e=>e[0]==='merge'),'a real newer legacy timestamp still enters guarded merging');
    assert.equal(JSON.parse(g.data.get('surveyFieldNoteDrawingV1:drawing-a')).shapes[0].memo,'未送信の変更');assert.equal(g.outgoing().length,0);g.stop();
    console.log('PASS legacy metadata schema: forced same-revision read, timestamp fallback, and preserved real local changes');
  })().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
}
