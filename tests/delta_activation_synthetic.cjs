'use strict';
// Entirely invented records. Counts and upper bounds are workload dimensions,
// not exported production rows. No customer fixture/profile is read here.
const assert=require('node:assert/strict');
const C=require('../sentlog/record-collaboration.js');
const PROFILES={
 compact:{drawings:58,records:654,photos:1742,concentration:124,maxPoints:614,legacy:142,memos:60,dimensions:17,minNodes:20,maxNodes:26},
 wide:{drawings:118,records:587,photos:2090,concentration:58,maxPoints:1464,legacy:137,memos:20,dimensions:1,minNodes:19,maxNodes:33}
};
const uuid=(group,n)=>group+'-0000-4000-8000-'+String(n+1).padStart(12,'0');
function metadataNodes(value){return 1+(value&&typeof value==='object'&&!Array.isArray(value)?Object.values(value).reduce((n,v)=>n+metadataNodes(v),0):0);}
function generate(name){
 const p=PROFILES[name];assert(p,'known synthetic profile');
 const metas=[],drawings=[];
 for(let i=0;i<p.drawings;i++){
  const meta={id:uuid('44000000',i),name:'Synthetic drawing '+i,pdfFileId:uuid('55000000',i),sourceType:'pdf',originalName:'invented-plan.pdf'};
  const state={shapes:[],collabDeletedRecords:[],pageSettings:{'1':{scale:100,rotation:0,unit:'m'}},custom:{preserved:['synthetic',1]},currentPage:1};
  // 14 nodes before padding: meta 5, state 8, order 1; depth reaches 4.
  const wanted=p.minNodes+i%(p.maxNodes-p.minNodes+1);
  for(let j=14;j<wanted;j++)meta['syntheticField'+j]='value-'+j;
  assert.equal(metadataNodes(Object.fromEntries(Object.entries(meta).filter(([k])=>k!=='id')))+
   metadataNodes(Object.fromEntries(Object.entries(state).filter(([k])=>!['shapes','collabDeletedRecords','currentPage'].includes(k))))+1,wanted);
  metas.push(structuredClone(meta));drawings.push({meta,state});
 }
 const snapshot={project:{id:'synthetic-'+name,name:'Invented '+name+' workload',createdAt:1700000000000,collaborationVersion:1,
  drawings:metas,custom:{preserved:true}},drawings,unknownHeader:{preserved:true}};
 const eligible=p.records-p.memos-p.dimensions,photoCounts=Array(p.records).fill(0),peak=name==='wide'?36:30;
 const peakIndex=p.legacy+p.memos+p.dimensions;photoCounts[peakIndex]=peak;
 let rest=p.photos-peak,slots=eligible-1;
 for(let i=0;i<p.records;i++)if(i!==peakIndex&&(i<p.legacy||i>=peakIndex)){
  const n=Math.floor(rest/slots);photoCounts[i]=n;rest-=n;slots--;
 }
 assert.equal(rest,0);let photoNo=0;
 for(let i=0;i<p.records;i++){
  const legacy=i<p.legacy,memo=i>=p.legacy&&i<p.legacy+p.memos,dimension=i>=p.legacy+p.memos&&i<peakIndex;
  const count=legacy?(i===0?p.maxPoints:(name==='wide'?[64,128,256,512,768]:[16,32,64,96])[i%4+(name==='wide'&&i%11===0?1:0)]):2;
  const points=Array.from({length:count},(_,j)=>({x:(j*37+i*101)/113.1,y:(j*61+i*79)/127.3}));
  const photos=Array.from({length:photoCounts[i]},()=>{const n=photoNo++;return {id:uuid('66000000',n),name:'synthetic-evidence-'+String(n).padStart(5,'0')+'.jpg',size:900000};});
  const raw={id:uuid('77000000',i),page:1,kind:legacy?'polyline':dimension?'dimension':'point',points,
   point:{x:i/11.3,y:i/17.9},type:'Synthetic damage',memo:i%9===0?'Invented observation '+i:'',photos,
   ...(memo?{recordKind:'drawing-memo',memoType:'line',text:'Invented memo'}:
    dimension?{recordKind:'dimension-line',unit:'m',manualText:''}:
    legacy?{member:'synthetic member',no:'',strokeWidth:1.5}:
    {recordKind:'field-record',recordType:'damage',displayKind:'point',surveyItems:[],recordNo:i+1})};
  const r=C.upgrade(raw);
  const target=i<p.concentration?0:1+(i-p.concentration)%(p.drawings-1);
  snapshot.drawings[target].state.shapes.push(r);
 }
 assert.equal(photoNo,p.photos);
 // Retain real conflict/delete branches as a small part of the invented data.
 const actor={deviceId:uuid('22000000',0),deviceName:'Synthetic phone'};
 let sample=drawings[0].state.shapes.at(-1);
 const expectedHeads=C.view(sample).fields.type.headIds;
 const left=C.setField(sample,'type','left',{actor,at:1,revisionId:'synthetic-left',expectedHeads});
 const right=C.setField(sample,'type','right',{actor,at:1,revisionId:'synthetic-right',expectedHeads});
 drawings[0].state.shapes[drawings[0].state.shapes.length-1]=C.mergeRecords(left,right).record;
 const removed=drawings[1].state.shapes.pop();
 drawings[1].state.collabDeletedRecords.push(C.markDeleted(removed,{actor,at:2,revisionId:'synthetic-delete',expectedToken:C.revisionToken(removed)}));
 const rows=drawings.flatMap(d=>[...d.state.shapes,...d.state.collabDeletedRecords]);
 assert.equal(rows.length,p.records);assert.equal(rows.flatMap(r=>r.photos).length,p.photos);
 return {snapshot,profile:{name,...p,jsonBytes:Buffer.byteLength(JSON.stringify(snapshot)),
  maxRecordsPerDrawing:Math.max(...drawings.map(d=>d.state.shapes.length+d.state.collabDeletedRecords.length)),
  pointCount:rows.reduce((n,r)=>n+(r.points?.length||0),0)}};
}
module.exports={generate,PROFILES};
