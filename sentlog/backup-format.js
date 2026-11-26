/* Shared, side-effect-free decoder for the existing sentlog-backup v1 format.
 * The ordinary importer still owns confirmation, sync suspension and replaceAll.
 * Loading/decoding this module never opens a database or starts authentication. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SentlogBackupFormat=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const WORKSPACE='surveyFieldNoteWorkspaceV1',DRAWING='surveyFieldNoteDrawingV1:',SYNC='sentlogCloudProjectSyncV2:';
  function decode(text,options={}){
    const BlobClass=options.Blob||root.Blob,FileClass=options.File||root.File;
    const decode64=options.atob||root.atob,now=options.now||Date.now;
    const pack=JSON.parse(text);
    // These are the existing ordinary importer's acceptance checks, in order.
    if(pack?.format!=='sentlog-backup'||pack.version!==1||!Array.isArray(pack.workspace?.projects)||!Array.isArray(pack.files))
      throw Error('バックアップの形式が不正です');
    const ids=new Set(),projectIds=new Set();
    for(const p of pack.workspace.projects){
      if(typeof p.id!=='string'||!p.id||projectIds.has(p.id)||!Array.isArray(p.drawings))throw Error('案件情報が不正です');
      projectIds.add(p.id);
      for(const d of p.drawings){if(typeof d.id!=='string'||!d.id||ids.has(d.id))throw Error('図面情報が不正です');ids.add(d.id);}
    }
    const records=new Map([[WORKSPACE,JSON.stringify(pack.workspace)]]);
    for(const [id,st] of Object.entries(pack.drawingStates||{})){
      if(!ids.has(id)||!st||!Array.isArray(st.shapes))throw Error('変状記録が不正です');
      records.set(DRAWING+id,JSON.stringify(st));
    }
    for(const p of pack.workspace.projects)records.set(SYNC+p.id,JSON.stringify({revision:0,restored_backup:true,local_updated_at:p.updatedAt||0}));
    const fileKeys=new Set(),files=[];
    for(const f of pack.files){
      if(typeof f.key!=='string'||!(/^(background:|photo:)/.test(f.key)||f.key==='background')||fileKeys.has(f.key)||!/^data:[^;]+;base64,/.test(f.data||''))
        throw Error('添付ファイルの形式が不正です');
      fileKeys.add(f.key);
      const [meta,data]=String(f.data).split(','),match=/^data:([^;]+);base64$/.exec(meta||'');
      const bytes=decode64(data||''),array=new Uint8Array(bytes.length);
      for(let i=0;i<bytes.length;i++)array[i]=bytes.charCodeAt(i);
      const blob=new BlobClass([array],{type:match?match[1]:'application/octet-stream'});
      const value=f.name?new FileClass([blob],f.name,{type:f.type||blob.type,lastModified:f.lastModified||now()}):blob;
      files.push({key:f.key,value});
    }
    return {pack,workspace:pack.workspace,records,files};
  }
  return Object.freeze({version:1,decode,keys:Object.freeze({workspace:WORKSPACE,drawing:DRAWING,sync:SYNC})});
});
