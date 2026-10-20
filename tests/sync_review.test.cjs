const assert=require('node:assert/strict'),M=require('../sentlog/sync-merge.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const shape=(id,memo='')=>({id,kind:'field-record',recordKind:'field-record',recordType:'photo',type:'全景',page:2,point:{x:100,y:150},points:[{x:100,y:150},{x:100,y:130}],memo,photos:[]});
function pack(shapes){const meta={id:'d',name:'16_操作台',pageCount:7,sourceType:'pdf',fileName:'original.pdf'};return {project:{id:'p',name:'現場',drawings:[meta]},drawings:[{meta:copy(meta),state:{sourceType:'pdf',fileName:'original.pdf',pageCount:7,pageRotations:{},pageSettings:{},shapes:copy(shapes)}}]};}
const base=pack([shape('common')]),local=pack([shape('common'),shape('ipad')]),remote=pack([shape('common'),shape('phone')]);
remote.drawings[0].state.pageRotations={'4':0,'7':0};
let r=M.merge(local,remote,{preserve:true});assert(r.ok);assert.deepEqual(r.payload.drawings[0].state.pageRotations,{});
const turned=copy(remote);turned.drawings[0].state.pageRotations={'4':90};assert(!M.merge(local,turned,{preserve:true,base}).ok);
const l=copy(local),z=copy(remote);l.drawings[0].state.shapes[0].memo='iPadで更新';
// A verified ancestor identifies one-sided changes even in preservation mode.
r=M.merge(l,z,{preserve:true,base});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes[0].memo,'iPadで更新');
const withPhoto=copy(base);withPhoto.drawings[0].state.shapes[0].photos=[{id:'photo',name:'photo.jpg'}];
const noPhoto=copy(withPhoto);noPhoto.drawings[0].state.shapes[0].photos=[];
r=M.merge(noPhoto,withPhoto,{preserve:true,base:withPhoto});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes[0].photos.length,1);
r=M.merge(pack([]),withPhoto,{preserve:true,base:withPhoto});assert(r.ok);assert.equal(r.payload.drawings[0].state.shapes.length,1);
const noDrawing=copy(withPhoto);noDrawing.project.drawings=[];noDrawing.drawings=[];
r=M.merge(noDrawing,withPhoto,{preserve:true,base:withPhoto});assert(r.ok);assert.equal(r.payload.drawings.length,1);
// True conflicting edits require an explicit record choice. Each side's new
// records and photos survive regardless of which annotation body is selected.
z.drawings[0].state.shapes[0].memo='共有側で更新';
l.drawings[0].state.shapes[0].photos=[{id:'local-photo',name:'local.jpg'}];
z.drawings[0].state.shapes[0].photos=[{id:'remote-photo',name:'remote.jpg'}];
const before=JSON.stringify([l,z,base]);
r=M.merge(l,z,{preserve:true,base});assert(!r.ok);assert.equal(r.conflicts[0].kind,'record');assert.equal(r.conflicts[0].recordId,'common');
for(const side of ['local','remote']){
  r=M.merge(l,z,{preserve:true,base,recordChoices:{[M.recordChoiceKey('d','common')]:side}});assert(r.ok);
  const records=r.payload.drawings[0].state.shapes;assert.equal(records.length,3);
  assert.equal(records.find(s=>s.id==='common').memo,side==='local'?'iPadで更新':'共有側で更新');
  assert.deepEqual(records.find(s=>s.id==='common').photos.map(p=>p.id),['remote-photo','local-photo']);
}
assert.equal(JSON.stringify([l,z,base]),before);
assert(!M.merge(l,z,{preserve:true,recordChoices:{[M.recordChoiceKey('other','common')]:'remote'}}).ok);
assert(!M.merge(l,z,{base,recordChoices:{[M.recordChoiceKey('d','common')]:'remote'}}).ok,'automatic sync never applies manual choices');
console.log('PASS zero rotations, real rotations blocked, verified one-sided edits, preservation of deleted records/photos, explicit per-record choices and immutable originals');
