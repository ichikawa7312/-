'use strict';
// Deterministic, causally valid interleavings. These are record/event tests;
// they do not claim a browser, physical iPhone, or original-file transfer test.
const assert = require('node:assert/strict');
const C = require('../sentlog/record-collaboration.js');
const D = require('../sentlog/delta-sync-core.js');
const copy = x => JSON.parse(JSON.stringify(x));
const baseRecord = () => C.upgrade({
  id: 'record-matrix', recordKind: 'field-record', kind: 'field-record',
  recordType: 'survey', type: '調査', member: '横桁', page: 1,
  point: {x: 10, y: 20}, memo: '既存所見', crackWidthMm: 0.2,
  photos: [{id: 'photo-baseline', name: '元写真.jpg', size: 101, sha256: 'a'.repeat(64)}]
});
function options(device, n, seed) {
  let i = 0;
  return {actor: {deviceId: device, deviceName: device},
    at: seed % 3 === 0 ? 0 : seed % 3 === 1 ? 100000 + n * 100 : 9999999 - n * 100,
    idFactory: () => `${device}:${seed}:${n}:${++i}`};
}
const eventContext = (device, n, seed) => ({projectId: 'project-matrix',
  drawingId: 'drawing-matrix', deviceId: device, eventId: `event:${device}:${seed}:${n}`});
function random(seed) {
  let state = seed >>> 0;
  return () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};
}
function schedule(queues, seed) {
  const next = queues.map(q => q.slice()), out = [], r = random(seed);
  while (next.some(q => q.length)) {
    const ready = next.map((q,i) => q.length ? i : -1).filter(i => i >= 0);
    out.push(next[ready[Math.floor(r() * ready.length)]].shift());
  }
  return out;
}
function replay(base, events, duplicate) {
  let state = copy(base);
  for (const e of events) {
    state = D.combine(state, e);
    if (duplicate) {
      const twice = D.combine(state, e);
      assert(C.equal(twice, state), 'a repeated operation may not add a revision or restore an old value');
      state = twice;
    }
  }
  return state;
}
function revisions(record) {
  const ids = [];
  for (const g of ['comments', 'fields', 'photos'])
    for (const entry of Object.values(record.collab[g]))
      for (const r of entry.revisions) ids.push(r.id);
  for (const r of record.collab.deletion.revisions) ids.push(r.id);
  return new Set(ids);
}
let checks = 0, eventReplays = 0;
function check(name, fn) {
  try {fn(); checks++; console.log('PASS ' + name);}
  catch(e) {e.message = name + ': ' + e.message; throw e;}
}

for (let seed = 1; seed <= 24; seed++) {
  check(`seed ${seed}: 3 offline devices, skewed clocks, 30 edits, reordered delivery and duplicate retries`, () => {
    const base = baseRecord(), snapshots = [], queues = [], addedComments = [], addedPhotos = [];
    for (const device of ['iPhone-A', 'iPad-B', 'PC-C']) {
      let current = copy(base); const events = [];
      for (let n = 0; n < 10; n++) {
        const o = options(device,n,seed), before = copy(current);
        if (n % 3 === 0) {
          const text = `${device} 所見 ${seed}-${n}：日本語・📷・改行\n確認済み`;
          current = C.appendComment(current,text,o); addedComments.push(text);
        } else if (n % 3 === 1) {
          const id = `photo:${device}:${seed}:${n}`;
          current = C.addPhoto(current,{id,name:`写真_${n}.jpg`,size:100+n,sha256:'b'.repeat(64)},o);
          addedPhotos.push(id);
        } else {
          current = C.setField(current,'crackWidthMm',(seed+n)/100,
            {...o,expectedHeads:C.view(current).fields.crackWidthMm.headIds});
        }
        const e = D.diffRecord(before,current,eventContext(device,n,seed));
        assert(e && e.kind === 'patch'); events.push(e);
      }
      snapshots.push(current); queues.push(events);
    }
    const unchanged = JSON.stringify({base,queues,snapshots});
    let oracle = base;
    for (const snapshot of snapshots) {
      const merged = C.mergeRecords(oracle,snapshot,{base}); assert(merged.ok,merged.reason); oracle=merged.record;
    }
    const expectedIds = new Set(snapshots.flatMap(r=>[...revisions(r)]));
    for (let order = 0; order < 4; order++) {
      const events = schedule(queues,seed * 101 + order);
      const result = replay(base,events,true); eventReplays += events.length * 2;
      assert(C.equal(result,oracle),'different causally valid arrivals must converge to immutable-history union');
      assert.deepEqual(revisions(result),expectedIds,'no immutable revision may disappear');
      for (const text of addedComments) assert(result.memo.includes(text));
      assert.deepEqual(new Set(result.photos.map(p=>p.id)),new Set(['photo-baseline',...addedPhotos]));
      assert.equal(C.view(result).comments.length,13);
    }
    assert.equal(JSON.stringify({base,queues,snapshots}),unchanged,'replay may not mutate input snapshots');
  });
}

check('same field disagreement retains all candidates even for exact equal timestamps',()=>{
  const base=baseRecord(), edits=[0.3,0.4,0.5].map((value,i)=>{
    const device=['A','B','C'][i], next=C.setField(base,'crackWidthMm',value,
      {...options(device,1,3),expectedHeads:C.view(base).fields.crackWidthMm.headIds});
    return D.diffRecord(base,next,eventContext(device,1,3));
  });
  const result=replay(base,edits,true),field=C.view(result).fields.crackWidthMm;
  assert(field.conflict);assert.equal(result.crackWidthMm,0.2);
  assert.deepEqual(new Set(field.heads.map(h=>h.value)),new Set([0.3,0.4,0.5]));
  const resolved=C.resolveField(result,'crackWidthMm',0.45,
    {...options('reviewer',5,3),expectedHeads:field.headIds});
  assert.equal(replay(resolved,edits,true).crackWidthMm,0.45);
  assert.equal(C.view(replay(resolved,edits,true)).fields.crackWidthMm.conflict,false);
});

check('delete, photo addition and comment change in six arrival orders preserve pending deletion',()=>{
  const base=baseRecord(),comment=C.view(base).comments[0];
  const branches=[
    C.markDeleted(base,{...options('A',1,4),expectedToken:C.revisionToken(base)}),
    C.addPhoto(base,{id:'new-during-delete',name:'追加.jpg',size:12},options('B',1,4)),
    C.editComment(base,comment.id,'消してはいけない追記',
      {...options('C',1,4),expectedHeads:comment.headIds})
  ];
  const events=branches.map((r,i)=>D.diffRecord(base,r,eventContext(String(i),1,4)));
  for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
    const result=replay(base,order.map(i=>events[i]),true);
    assert(!C.isDeleted(result));assert(C.view(result).pendingDelete);
    assert(result.memo.includes('消してはいけない追記'));
    assert(result.photos.some(p=>p.id==='new-during-delete'));
  }
});

check('5,088 photo references plus a new comment produce a small change and preserve every reference',()=>{
  const raw=baseRecord(); delete raw.collab;
  raw.photos=Array.from({length:5088},(_,i)=>({id:`existing:${i}`,name:`写真_${i}.jpg`,size:200000,sha256:'c'.repeat(64)}));
  const base=C.upgrade(raw),next=C.appendComment(base,'追加した所見だけを送る',options('phone',1,70));
  const e=D.diffRecord(base,next,eventContext('phone',1,70));
  assert(Buffer.byteLength(JSON.stringify(e),'utf8')<2048,'single comment must not include 5,088 old photo references');
  assert.equal(Object.keys(e.patch.photos).length,0);
  const restored=D.combine(base,e);
  assert.equal(restored.photos.length,5088);assert(restored.memo.includes('追加した所見だけを送る'));
  assert(C.equal(restored,next));
});

console.log(`INTERLEAVING RESULT: ${checks} scenario groups, 96 seeded schedules, ${eventReplays} event applications passed.`);
console.log('LIMIT: photo metadata and immutable-record events only; original image bytes, physical iOS and old-app migration remain separate gates.');
