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
assert.match(cloud,/Number\(meta\?\.fingerprint_schema\|\|0\)<SYNC_FINGERPRINT_SCHEMA/,
  'old fingerprints must force one reconciliation pass');

const index=fs.readFileSync(path.join(root,'sentlog/index.html'),'utf8');
assert.match(index,/drawing-groups\.js\?v=172/);
assert.match(index,/sync-view\.js\?v=172/);
assert.match(index,/cloud-sync\.js\?v=20261018-group-sync-172/);
assert.match(index,/phone-runtime\.js\?v=172/);
const sw=fs.readFileSync(path.join(root,'sentlog/sw.js'),'utf8');
assert.match(sw,/sentlog-pwa-v183/);

console.log('PASS group sync migration: deterministic v1.71 metadata is canonicalized, old fingerprint schema is reconciled once, real grouping edits still differ');
