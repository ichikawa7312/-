(function(root){
  'use strict';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',SYNC='sentlogCloudProjectSyncV2:';
  const enc=new TextEncoder(),bytes=text=>enc.encode(text).length;
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const hash=async value=>digest(enc.encode(typeof value==='string'?value:JSON.stringify(value)));
  function random(n,seed){const out=new Uint8Array(n);let x=seed|0;for(let i=0;i<n;i++){x^=x<<13;x^=x>>>17;x^=x<<5;out[i]=(x>>>0)&255;}return out;}
  function text(n,seed){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',raw=random(n,seed);let result='';for(let i=0;i<n;i++)result+=alphabet[raw[i]%alphabet.length];return result;}
  function pad(object,target,variant,seed){
    object.syntheticPadding='';const base=JSON.stringify(object),units=variant==='unicode'?target.units:target.utf8;
    const nonLatin=(target.utf8-units-bytes(base)+base.length)/2,ascii=units-base.length-nonLatin;
    assert(Number.isInteger(nonLatin)&&nonLatin>=0&&Number.isInteger(ascii)&&ascii>=0,'Synthetic shape exceeds its measured string budget');
    // Content is newly generated. The repeat/entropy mix is a controlled
    // approximation, not a claim about native compression or physical bytes.
    const unique=Math.min(ascii,Math.max(32,Math.ceil(target.deflateUTF8*1.25)));
    const repeat='synthetic-record-'+seed+'|';
    object.syntheticPadding=text(unique,seed)+repeat.repeat(Math.ceil((ascii-unique)/repeat.length)).slice(0,ascii-unique)+'あ'.repeat(nonLatin);
    const value=JSON.stringify(object);assert(bytes(value)===target.utf8&&value.length===units,'Synthetic string representation changed');return value;
  }
  function encodedName(spec){if(!spec.file)return '';const n=(spec.nameUtf8-spec.nameUnits)/2;assert(Number.isInteger(n)&&n>=0&&n<=spec.nameUnits,'Unsupported file-name profile');return 'F'.repeat(spec.nameUnits-n)+'名'.repeat(n);}
  const dataURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
  function metrics(value){const s=typeof value==='string'?value:JSON.stringify(value);return {utf8:bytes(s),units:s.length,utf16Bytes:s.length*2,latin1Encodable:!(/[^\u0000-\u00ff]/.test(s))};}
  async function build(profile,variant,{backup=true}={}){
    assert(['unicode','ascii'].includes(variant),'Unknown condition');
    const projects=[],states={},metas=new Map(),manifest=[],backupFiles=[];
    for(const p of profile.projects){
      const project={id:'synthetic-project-'+p.ordinal,name:'Synthetic project '+p.ordinal,drawings:[],createdAt:1,collaborationVersion:1};
      for(const d of p.drawings){
        const id='synthetic-drawing-'+p.ordinal+'-'+d.ordinal,meta={id,name:'Synthetic '+p.ordinal+'/'+d.ordinal};
        const shapes=Array.from({length:d.shapes},(_,i)=>({id:'synthetic-record-'+p.ordinal+'-'+d.ordinal+'-'+i,kind:'point',page:1,point:{x:10+i%20,y:20+Math.floor(i/20)},memo:'',photos:[]}));
        states[id]={shapes,collabDeletedRecords:Array.from({length:d.deleted},(_,i)=>({id:'synthetic-deleted-'+p.ordinal+'-'+d.ordinal+'-'+i,photos:[]}))};
        project.drawings.push(meta);metas.set(p.ordinal+':'+d.ordinal,meta);
      }
      projects.push(project);
    }
    for(const f of profile.files){
      const id=metas.get(f.project+':'+f.drawing).id,photoId='synthetic-photo-'+f.ordinal;
      const key=f.kind==='background'?'background:'+id:'photo:'+id+':'+photoId;
      const raw=random(f.bytes,0x6472345+f.ordinal),sha256=await digest(raw),name=encodedName(f);
      const blob=new Blob([raw],{type:f.type});
      if(f.kind==='photo'&&states[id].shapes.length)states[id].shapes[0].photos.push({id:photoId,type:f.type,size:f.bytes,sha256});
      if(f.kind==='background'){states[id].sourceType=f.type==='application/pdf'?'pdf':f.type==='application/dxf'?'dxf':'image';states[id].fileName='synthetic-source';}
      manifest.push({key,size:f.bytes,type:f.type,name:f.file?name:null,lastModified:f.file?1:null,sha256,file:f.file});
      if(backup)backupFiles.push({key,type:f.type,name,lastModified:1,data:await dataURL(blob)});
    }
    const records=new Map(),stateRows=[];
    for(const p of profile.projects){
      const project=projects[p.ordinal-1];
      for(const d of p.drawings){
        const meta=project.drawings[d.ordinal-1];pad(meta,d.meta,variant,0x1370+p.ordinal*1000+d.ordinal);
        const value=pad(states[meta.id],d.state,variant,0x2970+p.ordinal*1000+d.ordinal);
        stateRows.push({projectOrdinal:p.ordinal,drawingOrdinal:d.ordinal,shapes:d.shapes,...metrics(value),sha256:await hash(value)});
        if(p.ordinal<=profile.beforeProjects)records.set(DRAW+meta.id,value);
      }
      pad(project,p,variant,0x3450+p.ordinal);
    }
    const before={projects:projects.slice(0,profile.beforeProjects)},after={projects};
    const initial=new Map([[WS,JSON.stringify(before)],...records]);
    for(const p of before.projects)initial.set(SYNC+p.id,JSON.stringify({revision:0,restored_backup:true,local_updated_at:p.updatedAt||0}));
    const snapshot=p=>({project:p,drawings:p.drawings.map(meta=>({meta,state:states[meta.id]}))});
    function syncValue(p){
      const base=snapshot(p),fingerprint='0'.repeat(64);
      // Only envelope size is inferred from the original failed batch. These
      // are synthetic timestamps/revisions and are never sent to a server.
      for(let digits=0;digits<=64;digits++){
        const stamp='2026-01-01T00:00:00'+(digits?'.'+'0'.repeat(digits):'')+'Z';
        const value=JSON.stringify({revision:1,local_updated_at:0,remote_updated_at:stamp,fingerprint,fingerprint_schema:2,base_snapshot:base});
        if(p!==projects[6]||bytes(value)===profile.observedIncoming.syncMetadataBytes)return value;
      }
      throw Error('Cannot match the inferred synthetic metadata envelope');
    }
    const baselineWrites=before.projects.map(p=>[SYNC+p.id,syncValue(p)]),incoming=new Map();
    for(const meta of projects[6].drawings)incoming.set(DRAW+meta.id,JSON.stringify(states[meta.id]));
    incoming.set(WS,JSON.stringify(after));incoming.set(SYNC+projects[6].id,syncValue(projects[6]));
    const changedBytes=[...incoming.values()].reduce((n,s)=>n+bytes(s),0);
    assert(incoming.size===9&&changedBytes===profile.observedIncoming.utf8Bytes,'Incoming nine-value byte shape changed');
    assert(initial.size===224&&manifest.length===35&&manifest.reduce((n,f)=>n+f.size,0)===31441939,'Restored shape changed');
    const final=new Map(initial);for(const row of baselineWrites)final.set(...row);for(const row of incoming)final.set(...row);
    const pack=backup?{format:'sentlog-backup',version:1,exportedAt:'2026-01-01T00:00:00.000Z',workspace:before,
      drawingStates:Object.fromEntries(before.projects.flatMap(p=>p.drawings.map(d=>[d.id,states[d.id]]))),files:backupFiles}:null;
    return {variant,projects,initial,baselineWrites,incoming,final,manifest,stateRows,pack,
      summary:{beforeProjects:6,beforeDrawings:217,beforeShapes:1558,afterProjects:7,afterDrawings:224,afterShapes:1851,
        files:35,fileBytes:31441939,fileInstances:8,blobInstances:27,initialRecords:224,
        initialStringUTF8:[...initial.values()].reduce((n,s)=>n+bytes(s),0),initialStringUTF16:[...initial.values()].reduce((n,s)=>n+s.length*2,0),
        incomingRecords:9,incomingUTF8:changedBytes,incomingUTF16:[...incoming.values()].reduce((n,s)=>n+s.length*2,0),
        baselineUTF8:baselineWrites.reduce((n,[,s])=>n+bytes(s),0),stateRows,
        initialWorkspace:metrics(initial.get(WS)),incomingWorkspace:metrics(incoming.get(WS)),incomingValueMetrics:[...incoming.values()].map(metrics)}};
  }
  root.SentlogSequenceModel={build,hash,digest,metrics,keys:{WS,DRAW,SYNC}};
})(globalThis);
