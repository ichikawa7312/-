'use strict';
// The partial DXF, photo-ledger and auto-trace builds load the same v2 writer
// as production. Exercise their actual base file readers without final-builder
// rewriting or a browser so a stale explicit v1 open cannot hide in a branch.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const fake=require('fake-indexeddb'),{webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const part=(file,start,end)=>{const source=read(file),a=source.indexOf(start),b=source.indexOf(end,a+start.length);
 assert(a>=0&&b>a,'reader integration point: '+file);return source.slice(a,b);};
const readers=[
 {name:'drawing reopen, backup and photo display',code:part('sentlog/part05.txt','function openDB(){','async function clearDBFiles(){'),fn:'getDBFile'},
 {name:'cloud file readback',code:part('sentlog/cloud-sync.js','function openDB(){','async function sha256Hex('),fn:'dbGet',prefix:"const DB_NAME='surveyFieldNoteDB';"},
 {name:'shared-photo recovery',code:part('sentlog/photo-recovery.js',' async function localPhoto(key){',' async function downloaded('),fn:'localPhoto'},
 {name:'peer-photo recovery',code:part('sentlog/peer-photo-recovery.js',' async function readLocal(key){',' async function digest('),fn:'readLocal'},
 {name:'PDF recovery',code:part('sentlog/pdf-recovery.js','async function db(name,store,key,value','async function hash('),fn:"key=>db('surveyFieldNoteDB','files',key)"},
 {name:'standalone rescue',code:read('sentlog/rescue.html').split('\n').find(line=>line.startsWith('const open=()=>')),
  prefix:"const DB='surveyFieldNoteDB';",fn:"async key=>{const db=await open();try{return await new Promise((resolve,reject)=>{const q=db.transaction('files','readonly').objectStore('files').get(key);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close();}}"}
];
const factory=new fake.IDBFactory(),sourceDxf=new Blob(['0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n'],{type:'application/dxf'});
const sourcePhoto=new Blob([new Uint8Array([0,255,2,3,128,10,0])],{type:'image/png'});
const workspace=JSON.stringify({projects:[{id:'legacy-project',name:'Fixture',drawings:[{id:'drawing',sourceType:'dxf'}]}]});
const drawing=JSON.stringify({sourceType:'dxf',shapes:[],autoTracePhotos:[{id:'photo',name:'original.png'}]});
const entries=[['background:drawing',sourceDxf],['photo:drawing:photo',sourcePhoto],
 ['__sentlog_records_meta_v130__',{schema:1,revision:7}],
 ['__sentlog_record__:surveyFieldNoteWorkspaceV1',workspace],['__sentlog_record__:surveyFieldNoteDrawingV1:drawing',drawing]];
const open=(name,version,upgrade)=>new Promise((resolve,reject)=>{const q=factory.open(name,...(version===undefined?[]:[version]));
 q.onupgradeneeded=()=>upgrade?.(q.result);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
const equalBlob=async(actual,expected)=>{assert(actual instanceof Blob);assert.equal(actual.type,expected.type);
 assert.deepEqual(new Uint8Array(await actual.arrayBuffer()),new Uint8Array(await expected.arrayBuffer()));};
let checks=0;const pass=name=>{checks++;console.log('PASS '+name);};
function reader(spec,records){const window={SentlogRecords:records};const context=vm.createContext({window,indexedDB:factory,Blob,console});
 vm.runInContext((spec.prefix||'')+'\n'+spec.code+'\n globalThis.readFile='+spec.fn+';',context);return context;}
(async()=>{
 const legacy=await open('surveyFieldNoteDB',1,db=>db.createObjectStore('files'));
 await new Promise((resolve,reject)=>{const tx=legacy.transaction('files','readwrite');for(const [key,value]of entries)tx.objectStore('files').put(value,key);
  tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});legacy.close();
 for(const spec of readers){const context=reader(spec);await equalBlob(await context.readFile('background:drawing'),sourceDxf);
  await equalBlob(await context.readFile('photo:drawing:photo'),sourcePhoto);pass(spec.name+' reads an existing v1 database');}
 const storage=new Map(),window={crypto:webcrypto},context=vm.createContext({window,indexedDB:factory,IDBKeyRange:fake.IDBKeyRange,Blob,AbortController,console,
  navigator:{},crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],
   getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}});
 vm.runInContext(read('sentlog/record-store.js'),context);await window.SentlogRecords.init();const records=window.SentlogRecords;
 assert.equal(records.getItem('surveyFieldNoteWorkspaceV1'),workspace);assert.equal(records.getItem('surveyFieldNoteDrawingV1:drawing'),drawing);
 pass('the real v2 writer upgrades the legacy database without changing its records or files');
 await assert.rejects(()=>open('surveyFieldNoteDB',1),e=>e.name==='VersionError');pass('stale explicit v1 clients still cannot open the v2 writer database');
 let sharedCalls=0;const adapter={...records,openFilesDatabase(){sharedCalls++;return records.openFilesDatabase();}};
 for(const spec of readers){const start=sharedCalls,c=reader(spec,adapter);await equalBlob(await c.readFile('background:drawing'),sourceDxf);
  await equalBlob(await c.readFile('photo:drawing:photo'),sourcePhoto);
  if(spec.name!=='standalone rescue')assert.equal(sharedCalls-start,2,'app reader must use the shared version-aware opener');
  pass(spec.name+' reads exact DXF and photo bytes from the real v2 writer');}
 for(const spec of readers){const c=reader(spec);await equalBlob(await c.readFile('photo:drawing:photo'),sourcePhoto);
  pass(spec.name+' standalone fallback accepts an existing v2 database');}
 const editor=reader(readers[0],adapter),all=await editor.getAllDBFiles();
 assert.equal(all.find(x=>x.key==='__sentlog_record__:surveyFieldNoteDrawingV1:drawing').value,drawing);
 await equalBlob(all.find(x=>x.key==='background:drawing').value,sourceDxf);pass('backup enumeration still includes exact drawing records and original DXF bytes');
 // The shipped loader concatenates raw chunks without separators. Compile
 // and execute that exact save path: a newline inside a split identifier can
 // still parse successfully while failing only when a real photo is saved.
 const assembled=Array.from({length:9},(_,i)=>read('sentlog/part0'+(i+1)+'.txt')).join('');
 const photoStart=assembled.indexOf('function photoDBKey('),photoEnd=assembled.indexOf('function revokePhotoThumbUrls(',photoStart);
 assert(photoStart>=0&&photoEnd>photoStart);vm.runInContext(assembled.slice(photoStart,photoEnd),editor);
 editor.activeDrawingId='another-drawing';await editor.savePhotoBlob('captured-photo',sourcePhoto,'drawing');await records.settled();
 await equalBlob(await editor.getPhotoBlob('captured-photo','drawing'),sourcePhoto);
 assert.equal(await editor.getPhotoBlob('captured-photo','another-drawing'),undefined);
 pass('the exact concatenated camera/auto-trace save helper commits bytes to its captured drawing');
 const pdf=reader(readers.find(x=>x.name==='PDF recovery'),adapter);
 await pdf.db('sentlog-pc-sync','kv','root',{name:'synthetic-pc-folder'});
 assert.deepEqual(await pdf.db('sentlog-pc-sync','kv','root'),{name:'synthetic-pc-folder'});
 const pc=await open('sentlog-pc-sync',1);assert.equal(pc.version,1);assert(pc.objectStoreNames.contains('kv'));pc.close();
 pass('the distinct PC folder database keeps its version-1 KV contract');
 console.log('PASS '+checks+' base file-reader compatibility checks');
})().catch(error=>{console.error(error);process.exitCode=1;});
