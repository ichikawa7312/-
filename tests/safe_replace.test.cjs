'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const P=require('../sentlog/page-management.js');

const previous={sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:210,hMm:297}},width:100,height:100,
  shapes:[{page:3,photos:[{},{}]}]};
const summary=P.replacementRecordSummary(previous);
assert.equal(summary.shapes,1);assert.equal(summary.photos,2);assert(summary.pages.has(3));
assert.equal(P.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:210,hMm:297}}}).ok,true);
assert.equal(P.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:1,pdfPageInfo:{'1':{wMm:210,hMm:297}}}).ok,false);
assert.equal(P.replacementFrameCompatible(previous,{sourceType:'image',pageCount:1,width:100,height:100}).ok,false);
assert.equal(P.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:220,hMm:297}}}).ok,false);
console.log('PASS safe replacement preflight blocks page/type/record-frame changes');

const manager=fs.readFileSync('sentlog/page-management.js','utf8');
assert.match(manager,/sentlogReplaceBackupV1:/);
assert.match(manager,/await root\.SentlogRecords\.flush\(\)/);
assert.match(manager,/replaceRecordedDrawing/);
assert.match(manager,/if\(!summary\.shapes&&!summary\.photos\)return legacy\.call/);
assert.ok(manager.indexOf('await root.SentlogRecords.flush()')<manager.indexOf('await openFile(file,true)'),'backup must commit before recorded background replacement');
const recorded=manager.slice(manager.indexOf('async function replaceRecordedDrawing'),manager.indexOf('function install()'));
assert.ok(!recorded.includes('state.shapes=[]'),'recorded replacement must never empty shapes');
console.log('PASS recorded replacement preserves shapes/photos and commits backup before openFile');

const store=fs.readFileSync('sentlog/record-store.js','utf8');
assert.match(store,/sentlogReplaceBackupV1:/);
const sync=fs.readFileSync('sentlog/sync-view.js','utf8');
assert.match(sync,/record-loss-guard/);
assert.match(sync,/afterPhotos<beforePhotos/);
assert.match(sync,/afterShapes\.length<beforeShapes\.length/);
const index=fs.readFileSync('sentlog/index.html','utf8');
assert.match(index,/page-management\.js\?v=193/);
console.log('PASS peer sync guard refuses destructive replacement and v1.93 page manager is loaded');
