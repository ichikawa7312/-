'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const M=require('../sentlog/sync-merge.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const shape=(id)=>({id,type:'ひび割れ',kind:'polyline',points:[{x:1,y:2},{x:5,y:6}],no:'調査-'+id,photos:[]});
const pack=(ids,size,updatedAt=1)=>{
  const meta={id:'drawing-1',name:'1階平面',sourceType:'pdf',fileName:'drawing.pdf',pageCount:1,updatedAt};
  return {project:{id:'project-1',name:'同期テスト',updatedAt,drawings:[meta]},
    drawings:[{meta:clone(meta),state:{sourceType:'pdf',fileName:'drawing.pdf',pageCount:1,
      pageRotations:{},pageSettings:{},currentPage:1,width:700,height:900,
      ...(size==null?{}:{labelSize:size}),shapes:ids.map(shape)}}]};
};
const base=pack(['common'],'normal',1);
const iphone=pack(['common','iphone'],'small',2);
const ipad=pack(['common','ipad'],'normal',3);
const sourceRecord=clone(iphone.drawings[0].state);

// Existing local file retains its own font-size choice. A cloud snapshot does
// not include that preference even when the local record does.
const cloud=fs.readFileSync(__dirname+'/../sentlog/cloud-sync.js','utf8');
const a=cloud.indexOf('function projectSnapshot(');
const b=cloud.indexOf('async function upsertSnapshot(',a);
assert(a>0&&b>a,'real snapshot function is available');
const makeSnapshot=record=>vm.runInNewContext(cloud.slice(a,b)+';projectSnapshot',{
  structuredClone,JSON,
  drawingState:id=>id==='drawing-1'?record:null
});
const localSnapshot=makeSnapshot(sourceRecord)(iphone.project);
assert(!Object.hasOwn(localSnapshot.drawings[0].state,'labelSize'),'shared payload must omit local font size');
assert.equal(sourceRecord.labelSize,'small','source file is never modified');

// Legacy snapshots can contain the old shared setting. Merging either an old
// or a new snapshot must never turn device display into a cloud conflict.
let merged=M.merge(localSnapshot,ipad,{base});
assert(merged.ok,'independent annotations + different label sizes must merge');
assert.deepEqual(merged.payload.drawings[0].state.shapes.map(s=>s.id),
  ['common','ipad','iphone']);
assert(!Object.hasOwn(merged.payload.drawings[0].state,'labelSize'),
  'even a remote-state fast path must remove the legacy shared size');
merged=M.merge(iphone,ipad,{base});
assert(merged.ok,'two different legacy label sizes with common ancestor must merge');
assert(!Object.hasOwn(merged.payload.drawings[0].state,'labelSize'));
merged=M.merge(iphone,ipad,{preserve:true});
assert(merged.ok,'explicit preserve-both must not block on font size');
assert(!Object.hasOwn(merged.payload.drawings[0].state,'labelSize'));
merged=M.merge(pack(['common'],'small'),pack(['common'],'normal'),{base});
assert(merged.ok,'font size is not an annotation conflict');
assert(!Object.hasOwn(merged.payload.drawings[0].state,'labelSize'));

// Read the actual sync-view functions: historical snapshot fingerprinting must
// remain intact, while only UI/persist comparisons omit the device preference.
const view=fs.readFileSync(__dirname+'/../sentlog/sync-view.js','utf8');
const va=view.indexOf('  function content(value){');
const vb=view.indexOf('  const same=',va);
const vc=view.indexOf('  function localView(');
const vd=view.indexOf('  async function commit(',vc);
assert(va>=0&&vb>va&&vc>0&&vd>vc,'real sync-view helpers are available');
const viewApi=vm.runInNewContext(
  'const clone=x=>JSON.parse(JSON.stringify(x));\n'+view.slice(va,vb)+'\n'+view.slice(vc,vd)+
  '\n;({content,deviceContent,snapshotText,localView})',{window:{},JSON});
assert.equal(viewApi.content({labelSize:'small'}).labelSize,'small',
  'historical shared fingerprint serialization stays compatible');
assert(!Object.hasOwn(viewApi.deviceContent({labelSize:'small'}),'labelSize'),
  'display-only differences do not create a dirty record');
assert.notEqual(viewApi.snapshotText(iphone),viewApi.snapshotText(ipad),
  'old checkpoint fingerprints remain verifiable');
assert(view.includes('same(deviceContent(before),deviceContent(state))'),
  'font-only edits must not bump shared update timestamps');
assert(view.includes('const changed=!same(deviceContent(state),deviceContent(incoming))'),
  'font-only remote edits must not reset the editor');
assert(view.includes("labelSize:validLabelSize(state.labelSize)?state.labelSize:'normal'"),
  'active editor must keep its current device font size');
const incoming={...ipad.drawings[0].state};
const old={...sourceRecord,currentPage:1,width:100,height:200};
assert.equal(viewApi.localView(incoming,old).labelSize,'small',
  'iPhone keeps small when receiving iPad normal');
assert.equal(viewApi.localView({...sourceRecord},{...incoming,labelSize:'normal'}).labelSize,
  'normal','iPad keeps normal when receiving iPhone small');
assert(!Object.hasOwn(viewApi.localView(incoming,null),'labelSize'),
  'brand-new device must not inherit a legacy remote font setting');
assert(!Object.hasOwn(viewApi.localView(incoming,{labelSize:'invalid'}),'labelSize'),
  'invalid local settings fall back to app default rather than cloud value');

// Geometry/photo edits still require the original conservative handling.
const editedA=pack(['common'],'small'),editedB=pack(['common'],'normal');
editedA.drawings[0].state.shapes[0].points[0].x=80;
editedB.drawings[0].state.shapes[0].points[0].x=100;
assert(!M.merge(editedA,editedB,{base}).ok,'conflicting edits to the same geometry still stop');
const rotate=pack(['common'],'small'),straight=pack(['common'],'normal');
rotate.drawings[0].state.pageRotations={'1':90};
assert(!M.merge(rotate,straight,{base}).ok,'a real drawing rotation conflict still stops');
console.log('PASS device-local label sizes: independent iPhone/iPad display, safe legacy merge, no cloud preference, stable checkpoint fingerprints and protected geometry');
