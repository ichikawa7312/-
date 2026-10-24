'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const P=require('../sentlog/page-management.js');
const M=require('../sentlog/sync-merge.js');

function payload(pageStates={}){
  const meta={id:'drawing-1',name:'図面A',fileName:'drawing.pdf',sourceType:'pdf',pageCount:8,shapeCount:0,photoCount:0,updatedAt:1};
  const state={project:'案件A',sourceType:'pdf',fileName:'drawing.pdf',pageCount:8,currentPage:1,width:1000,height:700,shapes:[],pageSettings:{},pdfPageInfo:{},pageRotations:{},pageStates,nextGlobalNo:1,typeCounters:{}};
  return {project:{id:'project-1',name:'案件A',drawings:[{...meta}],createdAt:1,updatedAt:1},drawings:[{meta:{...meta},state}]};
}

(function(){
  let s={};
  s=P.setHidden(s,3,true,10);
  assert.equal(P.isHidden(s,3),true);
  assert.deepEqual(P.visiblePages(8,s),[1,2,4,5,6,7,8]);
  s=P.setHidden(s,3,false,20);
  assert.equal(P.isHidden(s,3),false);
  assert.equal(P.pageState(s,3).revision,2);

  const stats=P.pageRecordStats([
    {page:3,kind:'rect',photos:[{},{}]},
    {page:3,recordKind:'dimension-line',kind:'dimension',photos:[]},
    {page:3,recordKind:'drawing-memo',kind:'line',photos:[{}]},
    {page:4,kind:'rect',photos:[{}]}
  ],3);
  assert.deepEqual(stats,{damage:1,dimensions:1,memos:1,photos:3,total:3});
  console.log('PASS page visibility: original page numbers remain stable and records stay attached');

  const base=payload({});
  const local=payload({'3':{hidden:true,revision:1,updatedAt:10}});
  const remote=payload({'5':{hidden:true,revision:1,updatedAt:11}});
  const merged=M.merge(local,remote,{base,now:20});
  assert.equal(merged.ok,true,JSON.stringify(merged.conflicts));
  const ps=merged.payload.drawings[0].state.pageStates;
  assert.equal(ps['3'].hidden,true);
  assert.equal(ps['5'].hidden,true);
  console.log('PASS sync merge: different-page offline hides merge without conflict');

  const tieBase=payload({'3':{hidden:false,revision:1,updatedAt:10}});
  const tieLocal=payload({'3':{hidden:true,revision:2,updatedAt:20}});
  const tieRemote=payload({'3':{hidden:false,revision:2,updatedAt:21}});
  const tied=M.merge(tieLocal,tieRemote,{base:tieBase,now:30});
  assert.equal(tied.ok,true,JSON.stringify(tied.conflicts));
  assert.equal(tied.payload.drawings[0].state.pageStates['3'].hidden,false);
  assert.equal(tied.payload.drawings[0].state.pageStates['3'].revision,3);
  console.log('PASS sync merge: true same-page tie resolves to visible, never surprise-hide');

  const manager=fs.readFileSync('sentlog/page-management.js','utf8');
  assert.ok(!manager.includes("writeFile('background"),'page manager must not rewrite the source PDF');
  const exp=fs.readFileSync('sentlog/drawing-export.js','utf8');
  assert.match(exp,/pageStates\?\.\[String\(n\)\]\?\.hidden/);
  assert.match(exp,/pages:pages\.length/);
  const index=fs.readFileSync('sentlog/index.html','utf8');
  assert.match(index,/page-management\.js\?v=192/);
  console.log('PASS integration: source PDF untouched, export skips hidden pages, v1.92 loader installed');
})();
