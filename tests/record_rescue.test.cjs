'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const code=fs.readFileSync('sentlog/record-rescue.js','utf8');
const records=new Map();
records.set('surveyFieldNoteWorkspaceV1',JSON.stringify({projects:[{id:'p1',name:'中外製薬',drawings:[{id:'d1',name:'図面1'},{id:'d2',name:'図面2'}]}]}));
records.set('surveyFieldNoteDrawingV1:d1',JSON.stringify({shapes:[{id:'s1',photos:[{id:'ph1'},{id:'ph2'}]}]}));
records.set('surveyFieldNoteDrawingV1:d2',JSON.stringify({shapes:[{id:'s2',photos:[]}]}));

const inserted=[],head={children:[],append(x){this.children.push(x)}};
const saveStatus={id:'saveStatus'};
const header={append(x){inserted.push(x)},insertBefore(x,before){assert.equal(before,saveStatus);inserted.push(x)}};
const body={children:[],append(x){this.children.push(x)}};
const context=vm.createContext({
  console,JSON,Date,Blob,File,
  navigator:{canShare:()=>false},
  URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},
  setTimeout:()=>{},
  alert:()=>{},
  document:{
    body,head,
    querySelector:s=>s==='header'?header:null,
    getElementById:id=>id==='saveStatus'?saveStatus:null,
    createElement:tag=>({
      tag,id:'',type:'',className:'',style:{cssText:''},textContent:'',title:'',disabled:false,
      setAttribute(){},append(){},remove(){},click(){this.clicked=true;}
    })
  },
  SentlogRecords:{
    settled:async()=>{},
    assertSafe:()=>{},
    getItem:key=>records.get(key)??null
  },
  sentlogAppReady:Promise.resolve()
});
context.window=context;context.globalThis=context;
vm.runInContext(code,context);

(async()=>{
  const result=await context.SentlogRecordRescue.build('p1');
  assert.equal(result.stats.projects,1);
  assert.equal(result.stats.drawings,2);
  assert.equal(result.stats.shapes,2);
  assert.equal(result.stats.photos,2);
  assert.equal(result.payload.format,'sentlog-record-rescue');
  assert.equal(result.payload.drawingStates.d1.shapes[0].photos.length,2);
  assert.ok(!('files' in result.payload),'record rescue must stay small and never serialize photo/PDF blobs');
  await Promise.resolve();await Promise.resolve();
  assert.equal(inserted.length,1);
  assert.equal(inserted[0].id,'sentlogRecordRescueBtn');
  assert.equal(inserted[0].textContent,'緊急救出');
  assert.equal(head.children.length,1,'header visibility style is installed');
  console.log('PASS record rescue: local rescue stays lossless and mounts as compact header action');
})().catch(e=>{console.error(e);process.exitCode=1});
