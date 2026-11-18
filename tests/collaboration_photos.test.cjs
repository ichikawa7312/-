// Execute the production photo module, record adapter and collaboration model.
// Only browser I/O is substituted; every async boundary can be held explicitly.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {File}=require('node:buffer');
const model=require('../sentlog/record-collaboration.js');
const originalPure=require('../sentlog/original-photo-store.js');
const source=fs.readFileSync(require.resolve('../sentlog/collaboration-photos.js'),'utf8');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const file=(name='capture.png',contents='original image')=>new File([contents],name,{type:'image/png',lastModified:123});

function fixture(previous){
  const data=previous||{records:new Map(),storage:new Map(),originals:new Map(),meta:new Map(),shared:new Map()};
  if(!data.records.size){
    const projects=['a','b'].map(id=>({id:'project-'+id,name:'Project '+id,updatedAt:1,
      drawings:[{id:'drawing-'+id,name:'Drawing '+id,sourceType:'image',updatedAt:1}]}));
    data.records.set(WS,JSON.stringify({projects}));
    for(const id of ['a','b'])data.records.set(DRAW+'drawing-'+id,JSON.stringify({sourceType:'image',fileName:'plan.svg',
      shapes:[{id:'same-record',kind:'field-record',recordKind:'field-record',recordType:'survey',point:{x:10,y:20},
        photos:[],memo:'Memo '+id,autoLabel:'Record '+id}]}));
  }
  const control={failOriginal:false,failShared:false,failConvert:false,failJournal:false,exclusive:false,makeGate:null,
    makeEntered:null,decodes:0,maxDecodes:0,conversions:0,originalWrites:0,attachmentEvents:0,history:[]};
  const listeners=new Set(),inputs={},windowListeners={};let serial=0;
  for(const id of ['cameraInput','photoInput'])inputs[id]={id,files:[],value:'',listeners:{},
    addEventListener(type,fn){(this.listeners[type]||=([])).push(fn);},
    async emit(type){const e={target:this,stopped:false,prevented:false,stopImmediatePropagation(){this.stopped=true;},preventDefault(){this.prevented=true;}};
      for(const listener of windowListeners[type]||[]){await listener(e);if(e.stopped)break;}
      if(e.stopped)return e;
      for(const listener of this.listeners[type]||[]){await listener(e);if(e.stopped)break;}
      if(!e.stopped&&this['on'+type])await this['on'+type](e);return e;}};
  const originals={...originalPure,
    async stageOriginal(did,pid,blob,meta){
      if(control.failOriginal)throw Error('Synthetic original quota failure');
      const key=did+':'+pid;
      if(data.meta.has(key)){
        const previous=data.meta.get(key);
        assert.equal(previous.photoAssociation.operationId,meta.photoAssociation.operationId);
        return clone(previous);
      }
      control.originalWrites++;data.originals.set(key,blob);
      const row={...clone(meta),key,drawingId:did,photoId:pid,size:blob.size,type:blob.type,
        originalName:blob.name||meta.originalName,storedAt:Date.now(),exportedAt:null};
      data.meta.set(key,row);return clone(row);
    },
    async getOriginal(did,pid){return data.originals.get(did+':'+pid)||null;},
    async listMeta(){return [...data.meta.values()].map(clone);},
    async updatePhotoAssociation(did,pid,association){
      const row=data.meta.get(did+':'+pid);assert(row,'Original must be durable before its association');
      assert.equal(row.photoAssociation.operationId,association.operationId);
      row.photoAssociation=clone(association);return clone(row);
    },
    async rebindPendingOriginal(from,to,pid,meta){
      const key=from+':'+pid,row=data.meta.get(key),blob=data.originals.get(key);
      assert(row&&blob&&row.photoAssociation.status!=='attached');
      const newKey=to+':'+pid,next={...row,...clone(meta),key:newKey,drawingId:to};
      data.originals.set(newKey,blob);data.meta.set(newKey,next);
      if(newKey!==key){data.originals.delete(key);data.meta.delete(key);}return clone(next);
    },
    async makeSharedPhoto(blob){
      control.conversions++;control.decodes++;control.maxDecodes=Math.max(control.maxDecodes,control.decodes);
      try{
        if(control.makeGate){const gate=control.makeGate;control.makeGate=null;control.makeEntered?.resolve();await gate.promise;}
        if(control.failConvert)throw Error('Synthetic decode failure');
        return new Blob([await blob.arrayBuffer()],{type:'image/jpeg'});
      }finally{control.decodes--;}
    },refreshUI(){}
  };
  const store={ready:true,getItem:key=>data.records.get(key)||null,
    batch(writes){if(control.exclusive)throw Error('Synthetic exclusive transaction');for(const [key,value] of writes)data.records.set(key,value);},
    async settled(){},assertSafe(){},get pending(){return control.exclusive;},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const status={textContent:''};
  const context={Blob,File,Promise,Map,Set,JSON,Date,Error,Object,Array,Number,String,RegExp,console,
    setTimeout,clearTimeout,queueMicrotask,crypto:{subtle:require('node:crypto').webcrypto.subtle,randomUUID:()=>`capture-test-${++serial}-${Date.now()}`},
    document:{getElementById:id=>id==='photoStatus'?status:inputs[id]||null,querySelector:()=>null},
    navigator:{userAgent:'Synthetic iPhone'},
    localStorage:{getItem:key=>data.storage.get(key)||null,setItem:(key,value)=>{
      if(control.failJournal&&key==='sentlogPhotoCaptureIntentV1')throw Error('Synthetic journal quota failure');
      data.storage.set(key,value);
    }},
    SentlogOriginalPhotos:originals,SentlogRecords:store,SentlogRecordCollaboration:model,
    SentlogArchive:{byLocal:()=>control.archived?{status:'archived'}:{status:'active'}},
    SentlogCollaboration:{actor:()=>({deviceId:'synthetic-device',deviceName:'iPhone'}),recordHistory:(a,b)=>control.history.push([clone(a),clone(b)])},
    activeProjectId:'project-a',activeDrawingId:'drawing-a',selected:'same-record',
    workspace:JSON.parse(data.records.get(WS)),state:JSON.parse(data.records.get(DRAW+'drawing-a')),
    sentlogAppReady:Promise.resolve(),render(){},renderSelectedPhotos(){},addPhotosToSelected(){},
    async getPhotoBlob(id,did){return data.shared.get(did+':'+id)||null;},
    async savePhotoBlob(id,blob,did){if(control.failShared)throw Error('Synthetic shared-store failure');data.shared.set(did+':'+id,blob);},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
    addEventListener(type,listener){(windowListeners[type]||=([])).push(listener);},
    dispatchEvent(event){if(event.type==='sentlog-photo-attached')control.attachmentEvents++;}
  };
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  function saved(id='a'){return JSON.parse(data.records.get(DRAW+'drawing-'+id));}
  function replace(id,drawing){data.records.set(DRAW+'drawing-'+id,JSON.stringify(drawing));
    if(context.activeDrawingId==='drawing-'+id)context.state=clone(drawing);}
  function select(id){context.activeProjectId='project-'+id;context.activeDrawingId='drawing-'+id;
    context.selected='same-record';context.state=saved(id);context.workspace=JSON.parse(data.records.get(WS));}
  return {context,data,control,inputs,originals,saved,replace,select,status,
    api:context.SentlogCollaborationPhotos,
    releaseExclusive(){control.exclusive=false;for(const listener of listeners)listener();}};
}

let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
  await test('chooser intent precedes selection change, binds same record ID to the original drawing',async()=>{
    const f=fixture();await tick();await f.inputs.cameraInput.emit('click');
    f.select('b');f.inputs.cameraInput.files=[file()];
    await f.inputs.cameraInput.emit('change');
    assert.equal(f.saved('a').shapes[0].photos.length,1);assert.equal(f.saved('b').shapes[0].photos.length,0);
    assert.equal(f.context.activeDrawingId,'drawing-b');assert.equal(f.context.state.shapes[0].memo,'Memo b');
    const meta=[...f.data.meta.values()][0];assert.equal(meta.drawingId,'drawing-a');assert.equal(meta.shapeId,'same-record');
    assert.equal(meta.projectId,'project-a');assert.equal(meta.photoAssociation.status,'attached');
    assert.equal(await f.data.originals.get(meta.key).text(),'original image');
  });

  await test('incoming comment and photo replace the live object during decode without losing either capture',async()=>{
    const f=fixture();await tick();const gate=deferred(),entered=deferred();
    f.control.makeGate=gate;f.control.makeEntered=entered;
    const intent=f.api.prepareInput('cameraInput'),old=f.context.state.shapes[0];
    const pending=f.api.register([file()],intent);await entered.promise;
    assert.equal(f.api.isCommitting(),false,'Image conversion must not lock incoming record changes');
    const remote=f.saved();remote.shapes[0]=model.appendComment(remote.shapes[0],'Remote inspection comment',
      {commentId:'remote-comment',revisionId:'remote-comment-rev',actor:{deviceId:'ipad',deviceName:'iPad'},at:200});
    remote.shapes[0]=model.addPhoto(remote.shapes[0],{id:'remote-photo',name:'remote.jpg'},
      {revisionId:'remote-photo-rev',actor:{deviceId:'ipad',deviceName:'iPad'},at:201});
    f.replace('a',remote);f.context.state.shapes[0].point={x:99,y:101}; // unsaved live movement preview
    gate.resolve();await pending;
    const stored=f.saved().shapes[0],live=f.context.state.shapes[0];
    assert.equal(stored.photos.length,2);assert.equal(live.photos.length,2);
    assert(stored.photos.some(p=>p.id==='remote-photo'));assert(stored.memo.includes('Remote inspection comment'));
    assert.deepEqual(clone(live.point),{x:99,y:101},'A photo append must not overwrite the live position preview');
    assert.deepEqual(model.view(live).fields.geometry.headIds,model.view(stored).fields.geometry.headIds,
      'A legacy live preview must not become a new geometry baseline');
    assert.equal(old.photos.length,0,'No retained pre-await record object may be mutated');
    const own=stored.photos.find(p=>p.id!=='remote-photo');
    assert.equal(stored.collab.photos[own.id].revisions[0].id,'capture:'+own.id);
    assert.equal(f.control.history.length,1,'The local attachment contributes its own undo operation');
  });

  await test('partial failure resumes from durable original with the same photo and operation IDs after reload',async()=>{
    const first=fixture();await tick();first.control.failShared=true;
    const intent=first.api.prepareInput('photoInput');await first.api.register([file('retry.png','exact source')],intent);
    const pending=await first.api.listPending();assert.equal(pending.length,1);assert(pending[0].originalSaved);
    const photoId=pending[0].photoId,operationId=pending[0].operationId;
    assert.equal(first.saved().shapes[0].photos.length,0);
    const second=fixture(first.data);await tick();await second.api.retryPending();await tick();
    assert.equal(second.saved().shapes[0].photos.length,1);assert.equal(second.saved().shapes[0].photos[0].id,photoId);
    const meta=[...second.data.meta.values()][0];assert.equal(meta.photoAssociation.operationId,operationId);
    assert.equal(meta.photoAssociation.status,'attached');assert.equal(second.control.originalWrites,0);
    assert.equal(await second.data.originals.get(meta.key).text(),'exact source');
    await second.api.register([file('retry.png','must never replace source')],intent);
    await second.api.retryPending();assert.equal(second.saved().shapes[0].photos.length,1);
    assert.equal(await second.data.originals.get(meta.key).text(),'exact source');
  });

  await test('missing chooser intent stages targetUnknown instead of attaching to the current selection',async()=>{
    const f=fixture();await tick();f.inputs.photoInput.files=[file('unknown.png')];
    await f.inputs.photoInput.emit('change');
    const rows=await f.api.listPending();assert.equal(rows.length,1);assert.equal(rows[0].target,null);assert(rows[0].originalSaved);
    assert.equal(f.saved().shapes[0].photos.length,0);assert.equal(f.control.conversions,0);
    const photoId=rows[0].photoId;f.select('b');const explicitTarget=f.api.captureTarget();
    await f.api.reassign(photoId,explicitTarget);
    assert.equal(f.saved('a').shapes[0].photos.length,0);assert.equal(f.saved('b').shapes[0].photos[0].id,photoId);
    assert(f.data.originals.has('drawing-b:'+photoId));assert.equal(f.data.originals.size,1);
  });

  await test('same photo ID with different same-length shared bytes is held without overwrite',async()=>{
    const f=fixture();await tick();f.control.failShared=true;
    await f.api.register([file('identity.png','source-A')],f.api.prepareInput('photoInput'));
    const pending=(await f.api.listPending())[0],key='drawing-a:'+pending.photoId;
    assert.equal(pending.photo.sha256.length,64,'The expected identity precedes shared storage');
    const different=new Blob(['source-B'],{type:'image/jpeg'});
    assert.equal(different.size,pending.photo.size);
    f.data.shared.set(key,different);f.control.failShared=false;
    await f.api.retryPending(pending.photoId);
    const held=(await f.api.listPending())[0];
    assert.equal(held.photoId,pending.photoId);assert.equal(held.errorCode,'SHARED_MISMATCH');
    assert.equal(f.saved().shapes[0].photos.length,0);
    assert.equal(await f.data.shared.get(key).text(),'source-B','The existing bytes cannot be overwritten');
    assert.equal(await f.data.originals.get(key).text(),'source-A','The recoverable original stays exact');
    assert.equal(f.data.originals.size,1);
  });

  await test('wrong project ownership holds the photo even when its drawing and record IDs exist',async()=>{
    const f=fixture();await tick();const wrong={...f.api.captureTarget(),projectId:'project-b'};
    await f.api.register([file()],wrong);
    assert.equal(f.saved('a').shapes[0].photos.length,0);assert.equal(f.saved('b').shapes[0].photos.length,0);
    const rows=await f.api.listPending();assert.equal(rows[0].errorCode,'TARGET_MISSING');assert(rows[0].originalSaved);
    await f.api.reassign(rows[0].photoId,f.api.captureTarget());assert.equal(f.saved().shapes[0].photos.length,1);
  });

  await test('original-store failure keeps one reserved ID and retries the retained source',async()=>{
    const f=fixture();await tick();f.control.failOriginal=true;
    await f.api.register([file()],f.api.prepareInput('cameraInput'));
    const first=(await f.api.listPending())[0];assert.equal(first.originalSaved,false);assert.equal(f.data.originals.size,0);
    f.control.failOriginal=false;await f.api.retryPending(first.photoId);
    assert.equal(f.saved().shapes[0].photos[0].id,first.photoId);assert.equal(f.data.originals.size,1);
  });

  await test('deleted target stays deleted and its staged photo can be explicitly assigned elsewhere',async()=>{
    const f=fixture();await tick();const gate=deferred(),entered=deferred();
    f.control.makeGate=gate;f.control.makeEntered=entered;
    const pending=f.api.register([file()],f.api.prepareInput('cameraInput'));await entered.promise;
    const removed=f.saved();removed.collabDeletedRecords=removed.shapes;removed.shapes=[];f.replace('a',removed);f.context.selected=null;
    gate.resolve();await pending;
    const rows=await f.api.listPending();assert.equal(rows.length,1);assert.equal(rows[0].errorCode,'TARGET_DELETED');
    assert.equal(f.saved('a').shapes.length,0);assert.equal(f.saved('a').collabDeletedRecords.length,1);
    f.select('b');await f.api.reassign(rows[0].photoId,f.api.captureTarget());
    assert.equal(f.saved('a').shapes.length,0);assert.equal(f.saved('b').shapes[0].photos.length,1);
  });

  await test('returned camera files survive a later archive input guard without mutating archived records',async()=>{
    const f=fixture();await tick();await f.inputs.cameraInput.emit('click');f.control.archived=true;
    let lateGuard=false;f.inputs.cameraInput.addEventListener('change',()=>{lateGuard=true;f.inputs.cameraInput.files=[];});
    f.inputs.cameraInput.files=[file()];await f.inputs.cameraInput.emit('change');
    assert.equal(lateGuard,false);assert.equal(f.data.originals.size,1);assert.equal(f.saved().shapes[0].photos.length,0);
    assert.equal((await f.api.listPending())[0].errorCode,'TARGET_ARCHIVED');
    f.control.archived=false;await f.api.retryPending();assert.equal(f.saved().shapes[0].photos.length,1);
  });

  await test('overlapping captures and retry share one decoder and append unique stable IDs',async()=>{
    const f=fixture();await tick();const gate=deferred(),entered=deferred();f.control.makeGate=gate;f.control.makeEntered=entered;
    const first=f.api.register([file('same.png','one'),file('same.png','two')],f.api.prepareInput('cameraInput'));
    await entered.promise;
    const second=f.api.register([file('same.png','three')],f.api.prepareInput('photoInput'));
    await tick();const retry=f.api.retryPending();gate.resolve();await Promise.all([first,second,retry]);
    assert.equal(f.control.maxDecodes,1);assert.equal(f.saved().shapes[0].photos.length,3);
    assert.equal(new Set(f.saved().shapes[0].photos.map(p=>p.id)).size,3);assert.equal(f.data.originals.size,3);
    assert.equal(new Set([...f.data.meta.values()].map(m=>m.exportName)).size,3,'Concurrent operations reserve distinct original export names');
    assert.equal((await f.api.listPending()).length,0);
  });

  await test('duplicate callbacks for the same prepared operation allocate and attach only once',async()=>{
    const f=fixture();await tick();const intent=f.api.prepareInput('photoInput'),image=file();
    await Promise.all([f.api.register([image],intent),f.api.register([image],intent)]);
    assert.equal(f.saved().shapes[0].photos.length,1);assert.equal(f.data.originals.size,1);
    assert.equal((await f.api.listPending()).length,0);
  });

  await test('attachment waits for an existing record transaction then rereads its latest comment',async()=>{
    const f=fixture();await tick();const gate=deferred(),entered=deferred();f.control.makeGate=gate;f.control.makeEntered=entered;
    const pending=f.api.register([file()],f.api.prepareInput('cameraInput'));await entered.promise;
    f.control.exclusive=true;gate.resolve();await tick();
    const newer=f.saved();newer.shapes[0].memo='Saved during the transaction';f.replace('a',newer);f.releaseExclusive();
    await pending;assert.equal(f.saved().shapes[0].memo,'Saved during the transaction');assert.equal(f.saved().shapes[0].photos.length,1);
  });

  await test('continuous shutters keep a fixed target, distinct IDs and photos received during conversion',async()=>{
    const f=fixture();await tick();const target=f.api.captureTarget(),gate=deferred(),entered=deferred();
    f.control.makeGate=gate;f.control.makeEntered=entered;
    const first=f.api.prepareCapture(target),firstSave=f.api.register([file('capture.png','first')],first);
    await entered.promise;f.select('b');
    const second=f.api.prepareCapture(target),secondSave=f.api.register([file('capture.png','second')],second);
    assert.notEqual(first.operationId,second.operationId);
    assert.equal(second.target.drawingId,'drawing-a','The shutter must use its camera session target');
    const remote=f.saved('a');
    remote.shapes[0]=model.addPhoto(remote.shapes[0],{id:'peer-between-shots',name:'peer.jpg'},
      {revisionId:'peer-between-shots-rev',actor:{deviceId:'ipad',deviceName:'iPad'},at:900});
    f.replace('a',remote);gate.resolve();
    const [a,b]=await Promise.all([firstSave,secondSave]);
    assert.equal(a[0].originalSaved,true);assert.equal(b[0].originalSaved,true);
    assert.equal(a[0].status,'attached');assert.equal(b[0].status,'attached');
    assert.notEqual(a[0].photoId,b[0].photoId);
    assert.deepEqual(new Set(f.saved('a').shapes[0].photos.map(p=>p.id)),new Set([a[0].photoId,b[0].photoId,'peer-between-shots']));
    assert.equal(f.saved('b').shapes[0].photos.length,0);assert.equal(f.context.activeDrawingId,'drawing-b');
    assert.equal(f.control.maxDecodes,1);assert.equal(f.data.originals.size,2);
    const retried=await f.api.register([file('capture.png','a duplicate callback must not replace the original')],first);
    assert.equal(retried[0].photoId,a[0].photoId);assert.equal(retried[0].originalSaved,true);
    assert.equal(f.saved('a').shapes[0].photos.length,3);
    assert.equal(await f.data.originals.get('drawing-a:'+a[0].photoId).text(),'first');
  });

  await test('continuous capture preparation requires a durable intent and rechecks target availability',async()=>{
    const f=fixture();await tick();const target=f.api.captureTarget();
    f.control.failJournal=true;
    assert.throws(()=>f.api.prepareCapture(target),error=>error.code==='INTENT_SAVE_FAILED');
    f.control.failJournal=false;assert.equal(f.data.originals.size,0);
    f.control.archived=true;
    assert.throws(()=>f.api.prepareCapture(target),error=>error.code==='TARGET_ARCHIVED');
    f.control.archived=false;
    f.data.storage.set('sentlogCloudSessionV1',JSON.stringify({user:{id:'another-owner'}}));
    assert.throws(()=>f.api.prepareCapture(target),error=>error.code==='ACCOUNT_CHANGED');
    f.data.storage.delete('sentlogCloudSessionV1');
    const removed=f.saved();removed.shapes=[];f.replace('a',removed);
    assert.throws(()=>f.api.prepareCapture(target),error=>error.code==='TARGET_DELETED');
  });

  await test('cancelCapture discards only empty intents and cannot cancel submitted or saved photos',async()=>{
    const f=fixture();await tick();const target=f.api.captureTarget();
    const empty=f.api.prepareCapture(target);
    assert.equal(f.api.cancelCapture(empty),true);assert.equal(f.api.cancelCapture(empty),false);
    assert.equal(f.api.cancelCapture(null),false);assert.equal(f.api.cancelCapture({operationId:'__proto__'}),false);
    await assert.rejects(f.api.register([file()],empty),error=>error.code==='INTENT_MISSING');
    assert.equal(f.data.originals.size,0);
    const active=f.api.prepareCapture(target),save=f.api.register([file()],active);
    assert.equal(f.api.cancelCapture(active),false,'A submitted file is protected even before ID allocation');
    const result=await save;
    assert.equal(f.api.cancelCapture(active),false);assert.equal(result[0].originalSaved,true);
    assert.equal(f.saved().shapes[0].photos.length,1);assert.equal(f.data.originals.size,1);
  });

  await test('pending continuous captures report durable originals and cancellation leaves retry identity intact',async()=>{
    const f=fixture();await tick();f.control.failShared=true;
    const intent=f.api.prepareCapture(f.api.captureTarget()),first=await f.api.register([file('pending.png','keep exact source')],intent);
    assert.equal(first[0].status,'pending');assert.equal(first[0].originalSaved,true);
    assert.equal(f.api.cancelCapture(intent),false);assert.equal(f.data.originals.size,1);
    f.control.failShared=false;const next=await f.api.retryPending(first[0].photoId);
    assert.equal(next[0].photoId,first[0].photoId);assert.equal(next[0].status,'attached');assert.equal(next[0].originalSaved,true);
    assert.equal(f.saved().shapes[0].photos.length,1);
    assert.equal(await f.data.originals.get('drawing-a:'+first[0].photoId).text(),'keep exact source');
  });

  await test('continuous save failures never report an unsaved original as saved',async()=>{
    const f=fixture();await tick();f.control.failOriginal=true;
    const intent=f.api.prepareCapture(f.api.captureTarget()),first=await f.api.register([file()],intent);
    assert.equal(first[0].status,'pending');assert.equal(first[0].originalSaved,false);
    assert.equal(f.api.cancelCapture(intent),false,'An unsaved pending source remains available for retry');
    f.control.failOriginal=false;const retry=await f.api.retryPending(first[0].photoId);
    assert.equal(retry[0].photoId,first[0].photoId);assert.equal(retry[0].originalSaved,true);
    assert.equal(f.data.originals.size,1);assert.equal(f.saved().shapes[0].photos.length,1);
  });

  await test('pending originalSaved reflects persisted bytes instead of a stale journal flag',async()=>{
    const f=fixture();await tick();const gate=deferred(),entered=deferred();f.control.makeGate=gate;f.control.makeEntered=entered;
    const pending=f.api.register([file()],f.api.prepareCapture(f.api.captureTarget()));await entered.promise;
    assert.equal(f.data.meta.size,1);f.data.originals.clear();f.control.failConvert=true;gate.resolve();
    const result=await pending;
    assert.equal(result[0].status,'pending');assert.equal(result[0].originalSaved,false);
    assert.equal(f.saved().shapes[0].photos.length,0);
  });

  console.log(`PASS ${passed} safe-capture scenarios using the production module and record model`);
})().catch(error=>{console.error(error);process.exitCode=1;});
