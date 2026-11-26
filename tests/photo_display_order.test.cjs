// Real collaboration model, capture service and ledger collector; browser I/O
// only is substituted. Presentation must never become a shared record edit.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {File}=require('node:buffer');
const crypto=require('node:crypto');
const O=require('../sentlog/photo-display-order.js');
const C=require('../sentlog/record-collaboration.js');
const P=require('../sentlog/collaboration-photos.js');
const L=require('../sentlog/photo-ledger.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const names=value=>value.map(p=>p.name);
const actor={deviceId:'order-test',deviceName:'Order test'};
const options=id=>({actor,revisionId:'capture:'+id,at:1000});
const target={projectId:'project',drawingId:'drawing',recordId:'record'};
const photo=(id,name,createdAt,extra={})=>({id,name,createdAt,...extra});

function frozen(value){if(value&&typeof value==='object'){for(const v of Object.values(value))frozen(v);Object.freeze(value);}return value;}
function testPresentation(){
  let record={id:'record',memo:'',photos:[]};
  const shots=[photo('z-shot','first.jpg',1001),photo('a-shot','second.jpg',1002),photo('m-shot','third.jpg',1003)];
  for(const shot of shots)record=C.addPhoto(record,shot,options(shot.id));
  assert.deepEqual(names(record.photos),['second.jpg','third.jpg','first.jpg'],'fixture must reproduce UUID-order defect');
  const original=JSON.stringify(record);frozen(record);
  assert.deepEqual(names(O.ordered(record.photos)),['first.jpg','second.jpg','third.jpg']);
  assert.notEqual(O.ordered(record.photos),record.photos);
  assert.equal(JSON.stringify(record),original);assert(C.matchesProjection(record));
  const reloaded=C.upgrade(JSON.parse(original));
  assert.deepEqual(names(O.ordered(reloaded.photos)),names(shots));
  const remote=C.addPhoto({id:'record',memo:'',photos:[]},photo('b-peer','peer.jpg',1004),options('b-peer'));
  for(const [left,right] of [[record,remote],[remote,record]]){
    const merged=C.mergeRecords(left,right);assert(merged.ok,merged.reason);
    assert.deepEqual(names(O.ordered(merged.record.photos)),['first.jpg','second.jpg','third.jpg','peer.jpg']);
    assert(C.matchesProjection(merged.record));
  }
  const batch=(id,name,batch,index)=>photo(id,name,9999,{captureDisplayOrder:{at:2000,batch,index}});
  const tied=[batch('a','batch-B2','B',1),batch('z','batch-A1','A',0),batch('b','batch-A2','A',1),batch('y','batch-B1','B',0)];
  const ordered=['batch-A1','batch-A2','batch-B1','batch-B2'];
  assert.deepEqual(names(O.ordered(tied)),ordered);
  assert.deepEqual(names(O.ordered(tied.slice().reverse())),ordered);
  const mixed=[photo('z-old','old1',undefined),shots[1],photo('a-old','old2',0),shots[0]];
  assert.deepEqual(names(O.ordered(mixed)),['old1','old2','first.jpg','second.jpg']);
  const invalid=[photo('a','same-first',1000,{captureDisplayOrder:{at:-1,batch:'x',index:0}}),photo('z','same-second',1000)];
  assert.deepEqual(names(O.ordered(invalid)),['same-first','same-second']);
  assert.deepEqual(O.ordered(null),[]);

  const group={id:'group',sheets:[{id:'drawing',sheetName:'Synthetic drawing'}]},states={drawing:{shapes:[{...clone(record),type:'調査',typeNo:1}]}};
  const before=JSON.stringify(states),entries=L.collect(group,states).entries;
  assert.deepEqual(entries.map(e=>e.photoName),names(shots));assert.equal(JSON.stringify(states),before);
  const source=fs.readFileSync(require.resolve('../sentlog/photo-ledger.js'),'utf8');
  const draftSource=source.slice(source.indexOf('  function loadDraft(c){'),source.indexOf('  function saveDraft(){'));
  const saved={version:2,photos:entries.slice().reverse().map((e,i)=>({...e,damageRole:i===0?'overview':'reserve'}))};
  const context={localStorage:{getItem:()=>JSON.stringify(saved)},COMMENT_DRAFT_VERSION:2,draftKey:()=>'',applyEntryDraft:L.applyEntryDraft};
  vm.createContext(context);vm.runInContext(draftSource+'\nglobalThis.applyDraft=loadDraft;',context);
  const current={entries:clone(entries)};context.applyDraft(current);
  assert.deepEqual(current.entries.map(e=>e.photoName),names(shots).reverse(),'saved manual order remains authoritative');
  assert.equal(current.entries[0].damageRole,'overview');
}

function fixture(){
  const data={journal:null,originals:new Map(),meta:new Map(),shared:new Map(),record:{id:'record',memo:'',photos:[]},failIds:new Set(),serial:0,ids:['operation','z-first','a-second'],at:5000};
  const digest=async blob=>crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
  function service(){return P.createService({
    loadJournal:()=>clone(data.journal),saveJournal:value=>{data.journal=clone(value);},
    now:()=>data.at,uuid:()=>data.ids.shift()||'later-'+(++data.serial),actor:()=>actor,
    originals:{
      async listMeta(){return [...data.meta.values()].map(clone);},
      async stageOriginal(did,pid,file,meta){const key=did+':'+pid;if(data.meta.has(key))return clone(data.meta.get(key));
        const row={...clone(meta),key,drawingId:did,photoId:pid,size:file.size,type:file.type};data.originals.set(key,file);data.meta.set(key,row);return clone(row);},
      async getOriginal(did,pid){return data.originals.get(did+':'+pid)||null;},
      async updatePhotoAssociation(did,pid,association){data.meta.get(did+':'+pid).photoAssociation=clone(association);}
    },
    shared:{get:async(pid,did)=>data.shared.get(did+':'+pid)||null,put:async(pid,blob,did)=>data.shared.set(did+':'+pid,blob),
      make:async file=>new Blob([await file.arrayBuffer()],{type:'image/jpeg'}),digest},
    records:{checkTarget:async()=>{},attach:async(t,metadata,entry)=>{
      if(data.failIds.has(metadata.id))throw Error('Synthetic delayed attachment');
      data.record=C.addPhoto(data.record,metadata,{revisionId:'capture:'+entry.photoId,actor:entry.actor,at:entry.at});
    }}
  });}
  return {data,service};
}

async function testDurableOrder(){
  const {data,service}=fixture();let capture=service();
  data.failIds.add('z-first');
  const intent=capture.prepare(target),files=[new File(['one'],'first.jpg',{type:'image/jpeg'}),new File(['two'],'second.jpg',{type:'image/jpeg'})];
  const result=await capture.register(files,intent);
  assert.deepEqual(result.map(r=>r.status),['pending','attached']);
  assert.deepEqual(data.meta.get('drawing:z-first').photoAssociation.captureDisplayOrder,{at:5000,batch:'operation',index:0});
  assert.deepEqual(data.meta.get('drawing:a-second').photoAssociation.captureDisplayOrder,{at:5000,batch:'operation',index:1});
  const reserved=clone(data.meta.get('drawing:z-first').photoAssociation.photo);
  data.failIds.clear();data.at=9000;capture=service();
  const retried=await capture.retryPending();assert.equal(retried[0].status,'attached');
  assert.deepEqual(data.record.photos.find(p=>p.id==='z-first'),reserved,'retry must retain original metadata and order');
  assert.deepEqual(names(O.ordered(data.record.photos)),['first.jpg','second.jpg']);
  assert.equal(data.record.collab.photos['z-first'].revisions.length,1);
  assert(C.matchesProjection(data.record));

  // Simulate a pending capture written before captureDisplayOrder existed,
  // including a lost shared cache, so retry must reconstruct exact metadata.
  const legacy=fixture();let old=legacy.service();legacy.data.failIds.add('z-first');
  await old.register([files[0]],old.prepare(target));
  const association=legacy.data.meta.get('drawing:z-first').photoAssociation;
  delete association.captureDisplayOrder;delete association.photo.captureDisplayOrder;
  delete legacy.data.journal.entries['z-first'].captureDisplayOrder;
  delete legacy.data.journal.entries['z-first'].photo.captureDisplayOrder;
  const expected=JSON.stringify(association.photo);
  legacy.data.shared.clear();legacy.data.failIds.clear();legacy.data.at=12000;old=legacy.service();
  const legacyResult=await old.retryPending();assert.equal(legacyResult[0].status,'attached',legacyResult[0].error);
  const actual=legacy.data.record.photos[0];assert.deepEqual(actual,JSON.parse(expected));
  assert.equal(JSON.stringify(legacy.data.meta.get('drawing:z-first').photoAssociation.photo),expected);
  assert(!Object.hasOwn(actual,'captureDisplayOrder'));
}

(async()=>{
  testPresentation();await testDurableOrder();
  const grid=fs.readFileSync(require.resolve('../sentlog/part06.txt'),'utf8');
  assert(grid.includes('SentlogPhotoDisplayOrder?.ordered(s?.photos||[])'));
  console.log('PASS photo display order: inverse UUIDs, tied batches, merge/reload, immutable protocol, manual ledger order, durable retry and legacy retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
