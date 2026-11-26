'use strict';
// Run after build_edit_sync.py. An optional argument selects a compiled checkout.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const C=require(path.join(root,'sentlog/archive-core.js'));
const Model=require(path.join(root,'sentlog/record-collaboration.js'));
const cloud=fs.readFileSync(path.join(root,'sentlog/cloud-sync.js'),'utf8');
assert(cloud.includes('edit-sync-v20261118'),'run the production builders before this integration test');
function section(start,end){
  const a=cloud.indexOf(start),b=cloud.indexOf(end,a+start.length);
  assert(a>=0&&b>a,'compiled integration boundary: '+start);return cloud.slice(a,b);
}
assert(cloud.includes('collaboration-sync-v1'),'run the collaboration synchronization builder before this integration test');
const code=section('function getSyncMeta(','function collectPhotos(')+
  section('async function syncNow(','\n// Integrated in the cloud module')+
  section('function sharedFileText(','// Browser integration.')+
  section('/* collaboration-sync-v1:','\nloadSession();editSyncSessionChanged();');
const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',META='sentlogCloudProjectSyncV2:';
const copy=value=>JSON.parse(JSON.stringify(value));
let passed=0;
async function test(name,fn){
  try{await fn();}catch(error){error.message=name+': '+error.message;throw error;}
  passed++;console.log('PASS '+name);
}

function fixture(){
  let time=100000,serial=0;const timers=new Map();
  const micro=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
  const tick=async ms=>{const end=time+ms;let rounds=0;await micro();while(true){const t=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!t)break;if(++rounds>300)throw Error('timer loop');time=t[1].at;timers.delete(t[0]);t[1].fn();await micro();}time=end;await micro();};
  const events=[],data=new Map(),remote=new Map();
  const controls=[{id:'cloud-a',client_key:'a',status:'active'},{id:'cloud-b',client_key:'b',status:'active'},
    {id:'cloud-c',client_key:'c',status:'archived'}];
  const projects=controls.map(cp=>({id:cp.client_key,name:cp.client_key,updatedAt:1,collaborationVersion:1,
    drawings:[{id:'drawing-'+cp.client_key,name:'図面',fileName:'plan.pdf',sourceType:'pdf',pageCount:1,updatedAt:1}]}));
  data.set(WS,JSON.stringify({projects}));
  for(const p of projects)data.set(DRAW+p.drawings[0].id,JSON.stringify({sourceType:'pdf',fileName:'plan.pdf',pageCount:1,
    currentPage:1,width:1200,height:800,collabDeletedRecords:[],shapes:[Model.upgrade({id:'record-'+p.id,memo:'',point:{x:1,y:2},
      photos:[{id:'photo-'+p.id,name:'写真.jpg',size:100}]})]}));
  const workspace=()=>JSON.parse(data.get(WS));
  const drawingState=id=>JSON.parse(data.get(DRAW+id)||'null');
  const snapshot=p=>({project:copy(p),drawings:p.drawings.map(d=>({meta:copy(d),state:drawingState(d.id)}))});
  const fingerprint=value=>C.snapshotText(value);
  for(const p of projects){
    const payload=snapshot(p),cp=controls.find(c=>c.client_key===p.id);
    remote.set(cp.id,{project_id:cp.id,revision:1,payload,updated_at:'2026-11-18T00:00:00Z'});
    data.set(META+p.id,JSON.stringify({revision:1,fingerprint:fingerprint(payload),fingerprint_schema:2,base_snapshot:payload}));
  }
  const failures={photo:null,pdf:null,archive:false,merge:false,receive:false};
  class ClockDate extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
  const context={console:{warn(){}},setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{at:time+ms,fn});return id;},clearTimeout:id=>timers.delete(id),Map,Set,JSON,Number,String,Array,Math,Promise,Date:ClockDate,structuredClone,
    session:{user:{id:'owner'}},syncing:false,mergeBusy:false,syncNotBefore:0,syncErrorNotBefore:0,
    knownCloudProjects:new Map(),syncConflicts:new Map(),drawingUploadBlocks:new Set(),
    WORKSPACE_KEY:WS,DRAWING_KEY_PREFIX:DRAW,SYNC_META_PREFIX:META,SYNC_FINGERPRINT_SCHEMA:2,
    navigator:{onLine:true},document:{hidden:false,addEventListener(){}},enc:encodeURIComponent,
    SUPABASE_URL:'https://test.invalid',SUPABASE_KEY:'public',DEVICE_KEY:'device',localStorage:{getItem:()=> 'device',setItem(){}},
    workspace,drawingState,snapshotFingerprint:async value=>fingerprint(value),
    msg(){},refreshMergePanel(){},editSync:{wake(){events.push(['wake']);}},
    syncStatus:{begin:()=>1,finish:(_,value)=>events.push(['status',value.level,value.label||''])},
    archive:{ready:true,refresh:async()=>{if(failures.archive)throw Error('archive unavailable');},
      canSync:(cp,manual)=>C.maySync(controls.find(c=>c.id===cp.id),manual),
      includeLocal:(id,manual)=>C.maySync(controls.find(c=>c.client_key===id),manual)},
    ensureSession:async()=>{},ensureDevice:async()=>'device',dbGet:async()=>undefined,
    ensureCloudProject:async p=>{events.push(['ensure-project',p.id]);return controls.find(c=>c.client_key===p.id);},
    rest:async(request,options={})=>{
      const url=new URL(request,'https://test.invalid'),method=options.method||'GET';
      if(url.pathname==='/rest/v1/sentlog_projects'){events.push(['projects']);return copy(controls);}
      assert.equal(url.pathname,'/rest/v1/sentlog_project_snapshots');
      if(method==='POST'||method==='PATCH'){
        const value=JSON.parse(options.body),id=method==='PATCH'?url.searchParams.get('project_id')?.replace(/^eq\./,''):value.project_id;
        const old=remote.get(id);
        assert.equal(url.searchParams.get('select'),'project_id,revision,updated_at','a save returns only its receipt');
        if(method==='PATCH'){
          assert.equal(Object.prototype.hasOwnProperty.call(value,'project_id'),false,'updates cannot change the project identity');
          assert.equal(Object.prototype.hasOwnProperty.call(value,'owner_id'),false,'updates cannot change the owner');
          const expected=url.searchParams.get('revision');
          assert.match(expected||'',/^eq\.\d+$/,'updates include the expected server revision');
          if(!old||String(old.revision)!==expected.slice(3))return [];
        }else{
          assert.equal(url.searchParams.has('on_conflict'),false,'new snapshots use a plain INSERT');
          if(old)throw Object.assign(Error('duplicate snapshot'),{status:409,code:'23505'});
        }
        assert.equal(value.revision,Number(old?.revision||0)+1,'snapshot writes keep the server revision precondition');
        const saved={...copy(old||{}),...copy(value),project_id:id};
        events.push(['snapshot',id]);remote.set(id,saved);return [{project_id:id,revision:saved.revision,updated_at:saved.updated_at}];
      }
      assert.equal(method,'GET');
      const id=url.searchParams.get('project_id')?.replace(/^eq\./,''),row=remote.get(id);
      events.push([url.searchParams.get('select')?.includes('payload')?'payload':'head',id]);
      if(!row)return [];return url.searchParams.get('select')?.includes('payload')?[copy(row)]:[{revision:row.revision,updated_at:row.updated_at}];
    },
    pullProjectAssets:async(cp,device,cycleAssets)=>{events.push(['download',cp.id]);cycleAssets?.set(cp.id,[]);return 0;},
    readProjectAssets:async id=>{events.push(['assets',id]);return [];},
    collectDrawings:p=>p.drawings.map(d=>({drawingId:d.id,fileName:d.fileName})),
    collectPhotos:p=>p.drawings.flatMap(d=>(drawingState(d.id)?.shapes||[]).flatMap(s=>(s.photos||[]).map(photo=>({drawingId:d.id,photo})))),
    uploadDrawing:async(cp,device,item)=>{
      events.push(['uploadPDF',cp.id,item.drawingId]);
      if(failures.pdf===cp.id){failures.pdf=null;throw Error('PDF network');}return {status:'exists'};
    },
    uploadPhoto:async(cp,device,item)=>{
      events.push(['uploadPhoto',cp.id,item.photo.id]);
      if(failures.photo===item.photo.id){failures.photo=null;throw Error('photo network');}return {status:'exists'};
    },
    normalizeMergeSnapshot:value=>value,
    tryMergeProject:async cp=>{events.push(['merge',cp.id]);return {applied:false,waiting:true};}
  };
  context.syncStatus.track=async(label,fn)=>fn();
  context.window={SentlogRecordCollaboration:Model,addEventListener(){},sentlogAppReady:Promise.resolve(),sentlogImporting:false,
    // This fixture exercises the legacy branch against a server without delta
    // rollout. The delta browser suite uses the actual runtime and SQL RPCs.
    SentlogDeltaMigrationRecovery:require('../sentlog/delta-sync-migration-recovery.js'),
    SentlogDeltaDrawingReview:{create:options=>require('../sentlog/delta-sync-drawing-review.js')
      .create({...options,document:{getElementById:()=>null}})},
    SentlogDeltaAppMigration:{createInstaller:()=>async()=>{throw Error('Legacy fixture must not migrate');}},
    SentlogDeltaAppRuntime:{createRuntime:()=>({inspect:async()=>({enabled:false,canActivate:false}),isActive:()=>false,
      reset(){},wake(){},sync:async()=>{throw Error('Legacy fixture must not use a delta writer');}})},
    SentlogRecords:{deltaJournal:{bindingFor:()=>null,listBindingsSync:()=>[]},
      getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),batch:writes=>{for(const [k,v] of writes)data.set(k,v);},settled:async()=>{},assertSafe(){}},
    sentlogSyncView:{commit:async(cp,snap,expected,options)=>{
      if(!options.expectedRecords.every(([k,v])=>(data.get(k)??null)===v))return {applied:false};
      events.push(['commit',cp.id]);if(failures.receive)return {applied:false,reason:'editing'};
      const ws=workspace(),index=ws.projects.findIndex(p=>p.id===cp.client_key);ws.projects[index]=copy(snap.payload.project);
      data.set(WS,JSON.stringify(ws));for(const d of snap.payload.drawings)data.set(DRAW+d.meta.id,JSON.stringify(d.state));
      for(const [k,v] of options.extraWrites)data.set(k,v);
      return {applied:true};
    }}};
  vm.createContext(context);
  const rawApi=vm.runInContext(code+'\n;({syncNow,getSyncMeta,projectSnapshot,metadata:collaborationMetadataWorker,files:collaborationFileWorker,normalize:collaborationNormalizeRecord});',context);
  const api={...rawApi,syncNow:async options=>{const p=rawApi.syncNow(options);await tick(0);const value=await p;await tick(0);return value;}};
  return {api,context,data,remote,controls,events,failures,
    get now(){return time;},advance:tick,stop(){rawApi.metadata.stop();rawApi.files.stop();},
    edit(id,fn){const key=DRAW+'drawing-'+id,d=JSON.parse(data.get(key));fn(d);data.set(key,JSON.stringify(d));},
    incoming(id,fn){const cp=controls.find(c=>c.client_key===id),row=copy(remote.get(cp.id));fn(row.payload);for(const d of row.payload.drawings)for(const s of d.state.shapes){const normalized=rawApi.normalize(s);Object.assign(s,normalized);}row.revision++;remote.set(cp.id,row);},
    assets:()=>events.filter(e=>['download','assets','uploadPDF','uploadPhoto'].includes(e[0])),
    outgoing:()=>events.filter(e=>e[0]==='snapshot')};
}

module.exports={fixture};
if(require.main===module){
const watchdog=setTimeout(()=>{console.error('FAIL integration promise did not settle');process.exitCode=1;process.exit();},15000);
(async()=>{
  await test('the published editor guard ignores a hidden draft after leaving the editor',async()=>{
    const view=fs.readFileSync(path.join(root,'sentlog/sync-view.js'),'utf8');
    const start=view.indexOf('  function busy(){'),end=view.indexOf('  function localView(',start);
    const published=view.match(/\bisBusy:([\s\S]+?),commit,/);
    assert(start>=0&&end>start&&published,'compiled sync view exports its editor guard');
    const fields={damageType:{value:'腐食'},member:{value:''},memo:{value:'未反映の入力'},lineWidth:{value:'1.2'}};
    const context={window:{},document:{hidden:false,activeElement:null,querySelector:()=>null},
      localOperation:0,drawing:null,panStart:null,labelDrag:null,activeTouches:new Set(),
      loading:{style:{display:'none'}},selected:'s1',state:{shapes:[{id:'s1',memo:'保存済み'}]},
      currentView:'editor',$:id=>fields[id]};
    vm.createContext(context);
    const isBusy=vm.runInContext(view.slice(start,end)+'\n;('+published[1]+');',context);
    assert.equal(isBusy(),true,'an actual editor draft still blocks receipt');
    context.currentView='drawings';assert.equal(isBusy(),false,'hidden inspector values cannot block drawing-list synchronization');
    context.currentView='projects';assert.equal(isBusy(),false,'hidden inspector values cannot block project-list synchronization');
    context.currentView='editor';assert.equal(isBusy(),true);fields.memo.value='保存済み';assert.equal(isBusy(),false);
  });
  await test('compiled quick comment and coordinate edits send scoped snapshots without attachment work',async()=>{
    const f=fixture();f.context.syncNotBefore=f.now+5000;
    f.edit('a',d=>d.shapes[0].memo='iPadの調査コメント');
    assert.deepEqual(copy(await f.api.syncNow({eventDriven:true,projectIds:['a']})),{started:true});
    assert.deepEqual(f.outgoing(),[['snapshot','cloud-a']]);assert.equal(f.assets().length,0);
    assert.equal(f.remote.get('cloud-a').payload.drawings[0].state.shapes[0].memo,'iPadの調査コメント');
    assert.equal(f.context.syncNotBefore,105000,'a quick cycle cannot move the full-cycle deadline');
    assert(!f.events.some(e=>e[1]==='cloud-b'||e[1]==='cloud-c'),'a scoped quick cycle leaves other projects alone');
    await f.advance(1000);f.edit('a',d=>d.shapes[0].point={x:42,y:81});await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(f.assets().length,0);assert.equal(f.outgoing().length,2);assert.equal(f.context.syncNotBefore,105000);
    const before=f.events.length,result=await f.api.syncNow();assert.equal(result.started,false);assert.equal(result.retryAt,105000);assert.equal(f.events.length,before);
    await f.advance(4000);await f.api.syncNow();assert(f.assets().some(e=>e[0]==='download'&&e[1]==='cloud-a'),'periodic full verification still runs at its original deadline');
  });
  await test('compiled quick new-photo sends retain the file pipeline',async()=>{
    const f=fixture();f.edit('a',d=>d.shapes[0].photos.push({id:'new-photo',name:'撮影.jpg',size:200}));
    await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert(f.assets().some(e=>e[0]==='download'&&e[1]==='cloud-a'));
    assert(f.assets().some(e=>e[0]==='uploadPhoto'&&e[2]==='new-photo'));
    assert.equal(f.api.getSyncMeta('a').revision,2);
  });
  if(cloud.includes('sentlog-sync-wait-v202'))await test('progress display failures cannot stop the real metadata worker or its snapshot save',async()=>{
    for(const beginWork of [()=>{throw Error('display unavailable');},()=>({update(){throw Error('display update');},finish(){throw Error('display close');}})]){
      const f=fixture();f.context.syncStatus.beginWork=beginWork;
      f.edit('a',d=>d.shapes[0].memo='表示機能が失敗しても保存する記録');
      await f.api.syncNow({eventDriven:true,projectIds:['a']});
      assert.deepEqual(f.outgoing(),[['snapshot','cloud-a']]);
      assert.equal(f.remote.get('cloud-a').payload.drawings[0].state.shapes[0].memo,'表示機能が失敗しても保存する記録');
      assert.equal(f.api.metadata.running,false);f.stop();
    }
  });
  await test('an asset failure after baseline advancement retries files and preserves the error deadline',async()=>{
    const f=fixture();f.edit('a',d=>d.shapes[0].photos.push({id:'new-photo',size:200}));f.failures.photo='new-photo';
    await f.api.syncNow({eventDriven:true,projectIds:['a']});const failed={started:true,retryAt:f.api.files.retryAt};
    assert.equal(failed.started,true);assert.equal(failed.retryAt,f.now+30000);
    assert(f.api.getSyncMeta('a').base_snapshot.drawings[0].state.shapes[0].photos.some(p=>p.id==='new-photo'),
      'this regression requires the real CAS worker to advance the baseline before the asset fails');
    const count=f.assets().length;await f.advance(1000);f.edit('a',d=>d.shapes[0].memo='待機中も保存');
    const blocked=await f.api.syncNow({eventDriven:true,projectIds:['a']});assert.equal(blocked.started,true,'metadata still progresses while failed files back off');assert.equal(f.api.files.retryAt,failed.retryAt);assert.equal(f.assets().length,count);
    await f.advance(29000);const retried=await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(retried.started,true);assert.equal(retried.retryAt,undefined);
    assert.equal(f.events.filter(e=>e[0]==='uploadPhoto'&&e[2]==='new-photo').length,2,
      'a matching base snapshot cannot hide an unsuccessful file upload on the retry');
    assert.equal(f.context.syncErrorNotBefore,0,'the failed project success clears its own completed retry, while unrelated retries remain scoped');
    assert.equal(f.remote.get('cloud-a').payload.drawings[0].state.shapes[0].memo,'待機中も保存');
    await f.advance(10000);await f.api.syncNow();assert.equal(f.context.syncErrorNotBefore,0,'a successful unscoped automatic cycle clears the marker');
  });
  await test('caught PDF errors also retain file work for the next cycle',async()=>{
    const f=fixture();f.edit('a',d=>d.pageReplacements={'1':{updatedAt:5,pdfHash:'a'.repeat(64),pdfSize:500}});f.failures.pdf='cloud-a';
    await f.api.syncNow({eventDriven:true,projectIds:['a']});const failed={started:true,retryAt:f.api.files.retryAt};assert.equal(failed.retryAt,f.now+30000);
    assert(f.events.some(e=>e[0]==='status'&&e[1]==='error'&&e[2]==='一部の案件を要確認'));
    await f.advance(30000);await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(f.events.filter(e=>e[0]==='uploadPDF').length,2,'per-drawing errors cannot be mistaken for a completed attachment pass');
  });
  await test('a successful manual sync of another project cannot clear unfinished attachment work',async()=>{
    const f=fixture();f.edit('a',d=>d.shapes[0].photos.push({id:'new-photo',size:200}));f.failures.photo='new-photo';
    await f.api.syncNow({eventDriven:true,projectIds:['a']});const failed={started:true,retryAt:f.api.files.retryAt};assert.equal(failed.retryAt,f.now+30000);
    await f.api.syncNow({force:true,manualProject:'cloud-c'});
    assert(f.assets().some(e=>e[0]==='download'&&e[1]==='cloud-c'),'the unrelated manual archive request really succeeds');
    await f.advance(30000);await f.api.syncNow({eventDriven:true,projectIds:['a']});
    assert.equal(f.events.filter(e=>e[0]==='uploadPhoto'&&e[2]==='new-photo').length,2,
      'another project succeeding must not make the failed project eligible for the unchanged-file shortcut');
  });
  await test('remote comment heads apply in place without asset work while new remote photos fetch assets',async()=>{
    const f=fixture();f.incoming('a',p=>p.drawings[0].state.shapes[0].memo='別端末の入力');
    await f.api.syncNow({eventDriven:true,projectIds:['a']});assert(f.events.some(e=>e[0]==='commit'));assert.equal(f.assets().length,0);assert.equal(f.outgoing().length,0);
    assert.equal(JSON.parse(f.data.get(DRAW+'drawing-a')).shapes[0].memo,'別端末の入力');
    f.incoming('a',p=>p.drawings[0].state.shapes[0].photos.push({id:'remote-photo',size:300}));
    await f.api.syncNow({eventDriven:true,projectIds:['a']});assert(f.assets().some(e=>e[0]==='download'&&e[1]==='cloud-a'));
  });
  await test('scoped fast synchronization preserves archive and verification barriers',async()=>{
    const f=fixture();f.controls[0].checking=true;
    for(const id of ['a','c'])f.edit(id,d=>d.shapes[0].memo='local edit');
    await f.api.syncNow({eventDriven:true,projectIds:['a','c']});assert.equal(f.assets().length,0);assert.equal(f.outgoing().length,0);
    assert.equal(f.context.knownCloudProjects.size,3,'discovery retains the complete project map even for a scoped cycle');
    f.controls[0].checking=false;await f.api.syncNow({force:true,manualProject:'cloud-c'});
    assert(f.assets().some(e=>e[0]==='download'&&e[1]==='cloud-c'));assert.equal(f.outgoing().length,0,'manual archive access remains read-only');
  });
  await test('unavailable archive controls and concurrent remote edits fail closed',async()=>{
    const f=fixture();f.failures.archive=true;
    const failure=await f.api.syncNow({eventDriven:true,projectIds:['a']});assert.equal(failure.started,true);assert.equal(f.api.metadata.retryAt,f.now+30000);assert.equal(f.outgoing().length,0);assert.equal(f.assets().length,0);
    const g=fixture();g.edit('a',d=>d.shapes[0].memo='local');g.incoming('a',p=>p.drawings[0].state.shapes[0].memo='remote');
    const guarded=await g.api.syncNow({eventDriven:true,projectIds:['a']});assert.equal(guarded.started,true);
    assert(g.events.some(e=>e[0]==='merge'));assert.equal(g.outgoing().length,0);assert.equal(g.assets().length,0);
    assert.equal(JSON.parse(g.data.get(DRAW+'drawing-a')).shapes[0].memo,'local');assert.equal(g.remote.get('cloud-a').payload.drawings[0].state.shapes[0].memo,'remote');
  });
  console.log(passed+' compiled edit-sync integration scenarios passed');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));

}
