'use strict';
// The unmodified browser controller and record writer run in a VM. PDF parsing,
// composition and rendering are synthetic descriptors; this is not a native
// PDF/browser test. Persistence uses actual writer code and FakeIndexedDB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,digest,ROOT,WS,DRAW}=require('./helpers/record_file_fixture.cjs');
const sourcePath=process.env.SENTLOG_PAGE_SOURCE||path.join(ROOT,'sentlog/page-replacement.js');
const code=fs.readFileSync(sourcePath,'utf8'),part=fs.readFileSync(path.join(ROOT,'sentlog/part05.txt'),'utf8');
const persistence=part.slice(part.indexOf('function drawingStorageKey'),part.indexOf('function showError'));
const fileReader=part.slice(part.indexOf('async function getDBFile('),part.indexOf('async function getAllDBFiles'));
const json=JSON.stringify,clone=x=>JSON.parse(json(x));
const key=id=>'background:'+id,backup=id=>'page-replace-backup:'+id,meta=id=>'page-replace-backup-meta:'+id;
function pdf(label,count=8){return new File([json({label,pages:Array.from({length:count},(_,i)=>({id:label+'-'+(i+1),width:720,height:500,rotate:0}))})],label+'.pdf',{type:'application/pdf',lastModified:123});}
const shapes=[{id:'synthetic-damage',kind:'rect',page:3,x:15,y:20,w:50,h:10,memo:'Synthetic note',photos:[{id:'synthetic-photo',key:'photo:a:synthetic-photo'}]},
  {id:'synthetic-dimension',recordKind:'dimension-line',page:3,points:[{x:1,y:2},{x:3,y:4}],photos:[]},
  {id:'synthetic-other-page',recordKind:'drawing-memo',page:5,text:'Synthetic other page',photos:[]}];
function model(id){return {sourceType:'pdf',fileName:'original-'+id+'.pdf',pageCount:8,currentPage:3,shapes:clone(shapes),
  pageSettings:{3:{scaleDenom:100}},pageRotations:{3:0},pageReplacements:{},collabDeletedRecords:[]};}
async function setup(){
  const states={a:model('a'),b:model('b')},workspace={projects:['a','b'].map(id=>({id:'project-'+id,name:'Synthetic '+id,drawings:[{id,name:'Synthetic drawing '+id,fileName:'original-'+id+'.pdf'}]}))};
  const f=await fixture({seed:{[WS]:json(workspace),[DRAW+'a']:json(states.a),[DRAW+'b']:json(states.b)}}),c=f.context;
  const original=pdf('original-a'),other=pdf('original-b'),donor=pdf('donor',1),foreign=pdf('later-foreign');
  await f.records.writeFile(key('a'),original);await f.records.writeFile(key('b'),other);
  const photo=new Blob(['Synthetic photograph body'],{type:'image/jpeg'});await f.records.writeFile('photo:a:synthetic-photo',photo);
  const hooks=new Map(),counts=new Map(),alerts=[],confirmations=[],calls={writes:[],persist:[],opens:[],errors:[]};
  async function hit(name,detail={}){const count=(counts.get(name)||0)+1;counts.set(name,count);if(hooks.has(name))await hooks.get(name)({...detail,count});}
  function once(name,fn){hooks.set(name,async data=>{hooks.delete(name);await fn(data);});}
  Object.assign(c,{document:{getElementById:()=>null},currentView:'editor',activeProjectId:'project-a',activeDrawingId:'a',state:clone(states.a),workspace:clone(workspace),
    drawingOpenSequence:1,drawingFileOpenSequence:1,DRAWING_KEY_PREFIX:DRAW,WORKSPACE_KEY:WS,
    alert:text=>alerts.push(String(text)),confirm:text=>{confirmations.push(String(text));return true;},
    console:{error:(...x)=>calls.errors.push(x.map(v=>v?.code||v?.message||String(v)).join(' ')),warn:()=>{}},
    render:()=>{},renderSelectedPhotos:()=>{},updatePageUI:()=>{},sentlogAppReady:Promise.resolve(),sentlogImporting:false,
    sentlogCloudIdle:()=>hit('idle:cloud'),sentlogPdfRecoveryIdle:()=>hit('idle:pdf')});
  function navigate(id,{sameState=false}={}){c.drawingOpenSequence++;c.drawingFileOpenSequence++;c.currentView='editor';c.activeProjectId='project-'+id;c.activeDrawingId=id;if(!sameState)c.state=clone(states[id]);}
  c.openDB=()=>f.records.openFilesDatabase();vm.runInContext(persistence+'\n'+fileReader,c);
  const get=c.getDBFile,persist=c.persist,nativeWrite=f.records.writeFile.bind(f.records);
  c.getDBFile=async k=>{const value=await get(k);await hit('read:'+k,{value});return value;};
  c.getBackgroundFile=id=>c.getDBFile(key(id||c.activeDrawingId));
  c.saveBackgroundFile=(value,id=c.activeDrawingId)=>f.records.writeFile(key(id),value);
  c.persist=()=>{calls.persist.push(c.activeDrawingId);return persist();};
  f.records.writeFile=async(k,value,options)=>{calls.writes.push({key:k,value,options});await hit('write:'+k,{value,options});return nativeWrite(k,value,options);};
  c.openFile=async(file,save=true)=>{
    const opening=++c.drawingFileOpenSequence,id=c.activeDrawingId;calls.opens.push(id);
    const current=()=>opening===c.drawingFileOpenSequence&&id===c.activeDrawingId&&c.currentView==='editor';
    await hit('open:before',{file,id});if(!current())return;
    if(save)await c.saveBackgroundFile(file,id);if(!current())return;
    const descriptor=JSON.parse(await file.text());if(!current())return;
    c.state.fileName=file.name||c.state.fileName;c.state.sourceType='pdf';c.state.pageCount=descriptor.pages.length;c.persist();
    await hit('open:after',{file,id});
  };
  c.pdfjsLib={getDocument({data}){const d=JSON.parse(Buffer.from(data).toString());return {promise:(async()=>{
    await hit('inspect:'+d.label,{descriptor:d});return {numPages:d.pages.length,getPage:async n=>({rotate:d.pages[n-1].rotate,getViewport:()=>({width:d.pages[n-1].width,height:d.pages[n-1].height})}),destroy:async()=>{}};
  })()};}};
  c.PDFLib={PDFDocument:{load:async data=>{
    const d=JSON.parse(Buffer.from(data).toString());return {data:d,getPageCount:()=>d.pages.length,copyPages:async other=>[clone(other.data.pages[0])],
      removePage:i=>d.pages.splice(i,1),insertPage:(i,p)=>d.pages.splice(i,0,p),save:async()=>{await hit('compose',{descriptor:d});return Buffer.from(json({...d,label:'composed'}));}};
  }}};
  vm.runInContext(code,c,{filename:sourcePath});
  const api=c.SentlogPageReplacement;
  async function settle(){await f.records.settled();f.records.assertSafe();}
  async function untouchedB(){
    assert.equal(await digest(await f.read(key('b'))),await digest(other),'another drawing PDF must not be changed');
    assert.deepEqual(JSON.parse(f.records.getItem(DRAW+'b')),states.b,'another drawing durable record must not be changed');
    const storedWorkspace=JSON.parse(f.records.getItem(WS));assert.deepEqual(storedWorkspace.projects.find(p=>p.id==='project-b'),workspace.projects[1]);
    if(c.activeDrawingId==='b')assert.deepEqual(c.state,states.b,'another drawing in-memory model must not be changed');
  }
  async function intactRecordsA(){const saved=JSON.parse(f.records.getItem(DRAW+'a'));assert.deepEqual(saved.shapes,states.a.shapes);assert.deepEqual(saved.pageSettings,states.a.pageSettings);assert.deepEqual(saved.pageRotations,states.a.pageRotations);assert.equal(await digest(await f.read('photo:a:synthetic-photo')),await digest(photo));}
  function stopped(){assert.ok(alerts.some(x=>/中止|完了できません/.test(x)),'operation must report it did not complete');assert.equal(alerts.some(x=>/ページ目だけを差し替えました|直前のページ差し替え前へ戻しました/.test(x)),false,'stale operation must not report success');}
  return {...f,c,api,original,other,donor,foreign,hooks,counts,alerts,confirmations,calls,once,hit,navigate,nativeWrite,settle,untouchedB,intactRecordsA,stopped};
}
const cases=[],test=(name,fn)=>cases.push([name,fn]);
test('normal replacement changes only page three and undo restores the original hash with all records and photos',async()=>{
  const f=await setup();await f.api.replaceCurrentPage(f.donor);await f.settle();
  const actual=JSON.parse(await(await f.read(key('a'))).text()),original=JSON.parse(await f.original.text());
  assert.equal(actual.pages.length,8);assert.equal(actual.pages[2].id,'donor-1');for(const i of [0,1,3,4,5,6,7])assert.deepEqual(actual.pages[i],original.pages[i]);
  assert.equal(await digest(await f.read(backup('a'))),await digest(f.original));assert.equal(JSON.parse(await(await f.read(meta('a'))).text()).applied,true);
  await f.intactRecordsA();await f.untouchedB();assert.equal(f.c.state.pageReplacements['3'].pdfHash,await digest(await f.read(key('a'))));
  await f.api.undoLast();await f.settle();assert.equal(await digest(await f.read(key('a'))),await digest(f.original));assert.equal(f.c.state.pageReplacements['3'].restored,true);
  assert.equal(f.c.state.pageReplacements['3'].revision,2);assert.equal(JSON.parse(await(await f.read(meta('a'))).text()).applied,false);await f.intactRecordsA();await f.untouchedB();
});
for(const phase of ['read:background:a','inspect:original-a','inspect:donor','idle:cloud','idle:pdf','compose','inspect:composed','open:after'])
test('navigation at '+phase+' never writes another drawing or its records',async()=>{
  const f=await setup();f.once(phase,()=>f.navigate('b'));await f.api.replaceCurrentPage(f.donor);await f.settle();
  await f.untouchedB();await f.intactRecordsA();assert.equal(await digest(await f.read(key('a'))),await digest(f.original));f.stopped();
});
for(const phase of ['inspect:original-a','compose','open:after'])test('reopening the same drawing at '+phase+' invalidates the old state identity',async()=>{
  const f=await setup();f.once(phase,()=>f.navigate('a'));await f.api.replaceCurrentPage(f.donor);await f.settle();
  assert.deepEqual(f.c.state.pageReplacements,{});assert.equal(await digest(await f.read(key('a'))),await digest(f.original));await f.untouchedB();f.stopped();
});
test('an opening epoch change is rejected even when IDs and the state object are retained',async()=>{
  const f=await setup();f.once('compose',()=>f.navigate('a',{sameState:true}));await f.api.replaceCurrentPage(f.donor);await f.settle();
  assert.deepEqual(f.c.state.pageReplacements,{});assert.equal(await digest(await f.read(key('a'))),await digest(f.original));f.stopped();
});
test('an old writer is rejected before even backup and metadata writes',async()=>{
  const f=await setup(),cap=f.records.getFileWriteCapabilities;f.records.getFileWriteCapabilities=()=>({...cap(),expectedFileStatesVersion:undefined});
  await f.api.replaceCurrentPage(f.donor);await f.api.undoLast();assert.equal(f.calls.writes.length,0);assert.equal(f.records.pending,false);await f.untouchedB();
  assert.equal(f.api.navigationGuardVersion,1);
});
for(const phase of ['compose','write:background:a'])test('a later source PDF at '+phase+' is preserved by version comparison',async()=>{
  const f=await setup();f.once(phase,()=>f.nativeWrite(key('a'),f.foreign));await f.api.replaceCurrentPage(f.donor);await f.settle();
  assert.equal(await digest(await f.read(key('a'))),await digest(f.foreign));await f.intactRecordsA();await f.untouchedB();f.stopped();
});
test('a source changed away and back to the same bytes still invalidates the original sequence',async()=>{
  const f=await setup();f.once('compose',async()=>{await f.nativeWrite(key('a'),f.foreign);await f.nativeWrite(key('a'),f.original);});
  await f.api.replaceCurrentPage(f.donor);await f.settle();assert.equal(await digest(await f.read(key('a'))),await digest(f.original));assert.deepEqual(f.c.state.pageReplacements,{});f.stopped();
});
for(const destination of [backup('a'),meta('a')])test('a competing '+destination+' is not overwritten at acquisition',async()=>{
  const f=await setup(),value=new Blob(['Synthetic protected concurrent value']);f.once('write:'+destination,()=>f.nativeWrite(destination,value));
  await f.api.replaceCurrentPage(f.donor);await f.settle();assert.equal(await digest(await f.read(destination)),await digest(value));assert.equal(await digest(await f.read(key('a'))),await digest(f.original));await f.untouchedB();f.stopped();
});
test('a failure before markers rolls back only its captured drawing and verifies the original hash',async()=>{
  const f=await setup();f.once('open:before',()=>{throw Error('Synthetic render rejection');});await f.api.replaceCurrentPage(f.donor);await f.settle();
  assert.equal(await digest(await f.read(key('a'))),await digest(f.original));await f.intactRecordsA();await f.untouchedB();assert.deepEqual(f.c.state.pageReplacements,{});f.stopped();
});
test('navigation during rollback cannot redirect the old source into a new drawing',async()=>{
  const f=await setup();f.once('open:before',()=>{f.once('write:background:a',()=>f.navigate('b'));throw Error('Synthetic render rejection');});
  await f.api.replaceCurrentPage(f.donor);await f.settle();assert.equal(await digest(await f.read(key('a'))),await digest(f.original));await f.untouchedB();f.stopped();
});
test('rollback does not overwrite a later writer and never claims the original was restored',async()=>{
  const f=await setup();f.once('open:before',async()=>{await f.nativeWrite(key('a'),f.foreign);throw Error('Synthetic render rejection after another save');});
  await f.api.replaceCurrentPage(f.donor);await f.settle();assert.equal(await digest(await f.read(key('a'))),await digest(f.foreign));await f.untouchedB();
  assert.ok(f.alerts.at(-1).includes('完了を確認できません'));assert.equal(f.alerts.at(-1).includes('操作前のPDFへ戻しました'),false);f.stopped();
});
test('undo refuses a PDF that changed since the recorded replacement',async()=>{
  const f=await setup();await f.api.replaceCurrentPage(f.donor);await f.settle();f.alerts.length=0;await f.nativeWrite(key('a'),f.foreign);const before=f.calls.writes.length;
  await f.api.undoLast();await f.settle();assert.equal(f.calls.writes.length,before);assert.equal(await digest(await f.read(key('a'))),await digest(f.foreign));await f.untouchedB();f.stopped();
});
test('new undo metadata refuses identical bytes from a later durable generation',async()=>{
  const f=await setup();await f.api.replaceCurrentPage(f.donor);await f.settle();const saved=await f.read(key('a')),savedMeta=JSON.parse(await(await f.read(meta('a'))).text());
  assert.equal(savedMeta.replacementSequence,(await f.state(key('a'))).sequence);
  await f.nativeWrite(key('a'),f.foreign);await f.nativeWrite(key('a'),saved);f.alerts.length=0;const before=f.calls.writes.length;
  await f.api.undoLast();await f.settle();assert.equal(f.calls.writes.length,before);assert.equal(await digest(await f.read(key('a'))),await digest(saved));await f.untouchedB();f.stopped();
});
test('legacy v198 undo metadata without a sequence still verifies hashes and uses the current CAS',async()=>{
  const f=await setup();await f.api.replaceCurrentPage(f.donor);await f.settle();const savedMeta=JSON.parse(await(await f.read(meta('a'))).text());delete savedMeta.replacementSequence;
  await f.nativeWrite(meta('a'),new Blob([json(savedMeta)],{type:'application/json'}));await f.api.undoLast();await f.settle();
  assert.equal(await digest(await f.read(key('a'))),await digest(f.original));assert.equal(f.c.state.pageReplacements['3'].restored,true);await f.intactRecordsA();await f.untouchedB();
});
for(const phase of ['read:page-replace-backup:a','idle:cloud','open:after'])test('undo navigation at '+phase+' preserves the other drawing',async()=>{
  const f=await setup();await f.api.replaceCurrentPage(f.donor);await f.settle();const before=await digest(await f.read(key('a')));f.alerts.length=0;f.once(phase,()=>f.navigate('b'));
  await f.api.undoLast();await f.settle();await f.untouchedB();assert.equal(await digest(await f.read(key('a'))),before);f.stopped();
});
test('the busy guard covers inspection before the confirmation dialog',async()=>{
  const f=await setup();let release,entered;const enteredPromise=new Promise(resolve=>entered=resolve),paused=new Promise(resolve=>release=resolve);
  f.once('inspect:original-a',async()=>{entered();await paused;});const first=f.api.replaceCurrentPage(f.donor);await enteredPromise;
  await f.api.replaceCurrentPage(pdf('second-donor',1));release();await first;await f.settle();assert.equal(f.confirmations.length,1);assert.equal(f.counts.get('compose'),1);await f.untouchedB();
});
test('an existing import owner is retained and no page write starts',async()=>{
  const f=await setup();f.c.sentlogImporting=true;await f.api.replaceCurrentPage(f.donor);assert.equal(f.c.sentlogImporting,true);assert.equal(f.calls.writes.length,0);await f.untouchedB();
});
(async()=>{let passed=0,failed=0;for(const [name,fn]of cases)try{await fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}
  console.log(json({passed,failed,total:cases.length,syntheticPdfAPI:true,actualController:true,actualRecordWriter:true,nativeBrowserExecuted:false}));if(failed)process.exitCode=1;
})();
