'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const part=fs.readFileSync('sentlog/part09.txt','utf8');
const a=part.indexOf('function replacementRecordSummary');
const b=part.indexOf("$('fileInput').onchange",a);
assert(a>=0&&b>a,'safe replacement helpers must be built');
const api=vm.runInNewContext(part.slice(a,b)+';({replacementRecordSummary,replacementFrameCompatible})',{Set,Number,Math});

const previous={sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:210,hMm:297}},width:100,height:100,
  shapes:[{page:3,photos:[{},{}]}]};
assert.deepEqual(JSON.parse(JSON.stringify(api.replacementRecordSummary(previous))),{shapes:1,photos:2,pages:{}});
assert.equal(api.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:210,hMm:297}}}).ok,true);
assert.equal(api.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:1,pdfPageInfo:{'1':{wMm:210,hMm:297}}}).ok,false);
assert.equal(api.replacementFrameCompatible(previous,{sourceType:'image',pageCount:1,width:100,height:100}).ok,false);
assert.equal(api.replacementFrameCompatible(previous,{sourceType:'pdf',pageCount:8,pdfPageInfo:{'3':{wMm:220,hMm:297}}}).ok,false);
console.log('PASS safe replacement preflight blocks page/type/record-frame changes');

const handler=part.slice(b,part.indexOf("$('prevPageBtn')",b));
assert.match(handler,/sentlogReplaceBackupV1:/);
assert.match(handler,/await window\.SentlogRecords\.flush\(\)/);
assert.match(handler,/summary\.shapes\|\|summary\.photos/);
assert.match(handler,/state\.pageStates=\{\}/);
const preserveBlock=handler.slice(handler.indexOf('if(summary.shapes||summary.photos)'));
assert.ok(!preserveBlock.split('}else{')[0].includes('state.shapes=[]'),'recorded replacement must never empty shapes');
assert.ok(handler.indexOf('await window.SentlogRecords.flush()')<handler.indexOf('await openFile(f,true)'),'backup must commit before background replacement');
console.log('PASS recorded replacement preserves shapes/photos throughout openFile and writes backup first');

const store=fs.readFileSync('sentlog/record-store.js','utf8');
assert.match(store,/sentlogReplaceBackupV1:/);
const sync=fs.readFileSync('sentlog/sync-view.js','utf8');
assert.match(sync,/record-loss-guard/);
assert.match(sync,/afterPhotos<beforePhotos/);
console.log('PASS peer sync guard refuses destructive background replacement from cloud');
