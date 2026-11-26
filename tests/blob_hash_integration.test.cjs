'use strict';
// Exercise real production hash call sites with immutable 9 MiB PDF/photo
// Blobs. Any attempt to materialize an entire large Blob fails this test.
const assert=require('node:assert/strict');
const {createHash,webcrypto}=require('node:crypto'),{IDBFactory}=require('fake-indexeddb');
const Source=require('../sentlog/delta-sync-legacy-source.js'),Migration=require('../sentlog/delta-sync-migration.js');
const Assets=require('../sentlog/delta-sync-assets.js'),Transport=require('../sentlog/delta-sync-asset-transport.js');
const C=require('../sentlog/record-collaboration.js');
const CHUNK=2*1024*1024,size=9*1024*1024+13,bytes=new Uint8Array(size).fill(7);
const sha256=createHash('sha256').update(bytes).digest('hex'),photo=new Blob([bytes],{type:'image/jpeg'}),pdf=new Blob([bytes],{type:'application/pdf'});
const scope={ownerId:'10000000-0000-4000-8000-000000000001',projectId:'10000000-0000-4000-8000-000000000002',deviceId:'10000000-0000-4000-8000-000000000003'};
const localProjectId='bounded-local',WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',copy=structuredClone;
if(!globalThis.crypto?.subtle)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
let passed=0;async function test(name,run){await run();passed++;console.log('PASS',name);}
(async()=>{
  const native=Blob.prototype.arrayBuffer,reads=[];let afterRead=null;
  Blob.prototype.arrayBuffer=async function(){
    assert(this.size<=CHUNK,'a production hash call attempted a whole '+this.size+' byte Blob read');
    reads.push(this.size);const value=await native.call(this);afterRead?.(this);return value;
  };
  try{
    await test('legacy capture and migration stage preserve large PDF/photo bytes using only bounded reads',async()=>{
      const factory=new IDBFactory(),meta={id:'drawing',name:'Synthetic',sourceType:'pdf',fileName:'large.pdf',pageCount:1};
      const state={fileName:'large.pdf',sourceType:'pdf',pageCount:1,shapes:[C.upgrade({id:'record',memo:'Retained note',
        photos:[{id:'photo',name:'large.jpg',size,sha256}]})],collabDeletedRecords:[]};
      const cutoff={version:1,kind:'sentlog-journal-cutoff',bindingId:'bounded-binding',scope:copy(scope),localProjectId,
        cutoffSeq:0,sourceRevision:1,sourceMeta:{schema:1,revision:1},rawEntries:[[WS,JSON.stringify({projects:[{id:localProjectId,name:'Test',drawings:[meta]}]})],
          [DRAW+'drawing',JSON.stringify(state)]],files:[{key:'background:drawing',value:pdf},{key:'photo:drawing:photo',value:photo}]};
      const journal={version:1,assertFence:()=>true,bindingFor:()=>({cutoff}),readCutoff:async()=>copy(cutoff)};
      const source=Source.createSource({journal,indexedDB:factory,localStorage:{getItem:()=>null},crypto:webcrypto});
      const wrapped={capture:id=>source.capture(id,{recordCutoff:cutoff}),recheck:snapshot=>source.recheck(snapshot)};
      const store=Migration.createStore({...scope,indexedDB:factory}),migration=Migration.createCoordinator({source:wrapped,store,localProjectId,currentScope:()=>scope});
      try{
        const first=await wrapped.capture(localProjectId);assert.equal(first.readyForStaging,true);assert.equal(first.files.length,2);
        assert(first.files.every(file=>file.sha256===sha256&&file.size===size));
        const staged=await migration.stage('bounded-files');assert.equal(staged.status,'verified-copy');
        const saved=await migration.readCopy('bounded-files');assert.equal(saved.snapshot.files.length,2);
        assert(saved.snapshot.files.every(file=>file.sha256===sha256&&file.size===size));
        assert.deepEqual(saved.snapshot.rawEntries,first.rawEntries);assert.equal(pdf.size,size);assert.equal(photo.size,size);
      }finally{migration.close();source.close();}
    });
    await test('asset byte verification uses the same hash and preserves cancellation guards',async()=>{
      await Assets.verifyBlob(photo,{size,sha256});
      await assert.rejects(()=>Assets.verifyBlob(photo,{size,sha256:'f'.repeat(64)}),error=>error.code==='ASSET_CONTENT_MISMATCH');
      let valid=true,started=0;const stopped=Object.assign(Error('guard expired'),{code:'SYNTHETIC_GUARD'});
      afterRead=()=>{started++;valid=false;};
      try{await assert.rejects(()=>Assets.verifyBlob(photo,{size,sha256},{validate:()=>{if(!valid)throw stopped;}}),error=>error===stopped);
        assert.equal(started,1,'scope change stops before the next chunk');
      }finally{afterRead=null;}
    });
    await test('asset upload and download keep exact content identities while hashing large files in chunks',async()=>{
      const rows=[],sent=[],requests=[],current={scope:copy(scope)};
      const response=(value,status=200)=>({ok:status<300,status,json:async()=>copy(value)});
      const fetch=async(url,options={})=>{
        const u=new URL(url),path=u.pathname;requests.push([path,options.method||'GET']);
        if(path==='/auth/v1/user')return response({id:scope.ownerId});
        if(path==='/rest/v1/sentlog_projects')return response([{id:scope.projectId,owner_id:scope.ownerId,status:'active',client_key:localProjectId}]);
        if(path==='/rest/v1/sentlog_devices')return response([{id:scope.deviceId,owner_id:scope.ownerId,active:true}]);
        if(path==='/rest/v1/sentlog_assets'){
          if(options.method==='POST'){rows.push({...JSON.parse(options.body),id:'20000000-0000-4000-8000-000000000001'});return response([rows[0]],201);}
          const selected=rows.filter(row=>[...u.searchParams].every(([field,query])=>{
            if(!query.startsWith('eq.'))return true;let value=query.slice(3);if(value.startsWith('"'))value=JSON.parse(value);return String(row[field])===value;
          }));return response(selected);
        }
        if(path.startsWith('/storage/v1/object/sentlog-temp/')){assert.equal(options.body,photo);assert.equal(options.headers['x-upsert'],'false');sent.push(path);return response({stored:true});}
        if(path.startsWith('/storage/v1/object/authenticated/sentlog-temp/'))return {ok:true,status:200,headers:{get:()=>String(size)},blob:async()=>photo};
        throw Error('unexpected synthetic request '+path);
      };
      const transport=Transport.createTransport({url:'https://synthetic.invalid',key:'synthetic-public-key',scope,localProjectId,
        session:()=>({user:{id:scope.ownerId},access_token:'synthetic-token'}),ensureSession:async()=>{},authGeneration:()=>0,
        subscribeAuth:()=>()=>{},currentScope:()=>current.scope,fetch,online:()=>true});
      try{
        const result=await transport.uploadPhoto({drawingId:'drawing',photoId:'photo',sha256,size,mimeType:'image/jpeg'},photo);
        assert.equal(result.uploaded,true);assert.equal(result.reference.sha256,sha256);assert.equal(result.reference.size,size);assert.equal(sent.length,1);
        assert.equal(await transport.download(result.reference),photo);
        const before=sent.length;afterRead=()=>{current.scope={...scope,ownerId:'foreign'};};
        try{await assert.rejects(()=>transport.uploadPhoto({drawingId:'drawing',photoId:'second'},photo),error=>error.code==='ASSET_SCOPE');
          assert.equal(sent.length,before,'changed scope cannot send bytes after hashing starts');
        }finally{afterRead=null;}
        assert(!requests.some(([path])=>path.includes('ack_photo')),'hash verification cannot create a delivery receipt');
      }finally{transport.close();}
    });
    assert(reads.length>40,'large files must exercise several production verification passes');
    assert(Math.max(...reads)<=CHUNK);
  }finally{Blob.prototype.arrayBuffer=native;}
  console.log('PASS bounded Blob hash integration:',passed,'groups; actual 9 MiB PDF/photo call sites, no whole-file reads, identities and guards preserved');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
