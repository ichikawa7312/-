/* Sentlog archive v1.33: shared pure helpers, no deletion or account credentials. */
(function(root){
  'use strict';
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const stable=v=>JSON.stringify(canonical(v));
  const snapshotText=payload=>{
    const p=JSON.parse(JSON.stringify(payload||{}));
    if(p.project){delete p.project.updatedAt;for(const d of p.project.drawings||[])delete d.updatedAt;}
    for(const d of p.drawings||[]){if(d.meta)delete d.meta.updatedAt;if(d.state)for(const k of ['currentPage','width','height','pdfPageInfo'])delete d.state[k];}
    return stable(p);
  };
  async function hash(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
  async function matches(blob,file){return blob instanceof Blob&&blob.size===Number(file.byte_size)&&(await hash(blob))===String(file.sha256).toLowerCase();}
  function maySync(control,manualProject){
    if(!control||control.checking)return false;
    return manualProject?control.id===manualProject:control.status==='active';
  }
  function readiness(job,now=Date.now()){
    const reasons=[];
    if(!job||job.state!=='checking'||Date.parse(job.expires_at)<=now)return {ready:false,reasons:['保管確認の期限が切れました。やり直してください。']};
    for(const d of job.required_devices||[]){const r=job.reports?.[d.id];
      if(!r?.clean)reasons.push(d.name+'：'+(r?.reason||'未確認。アプリを開いてください。')+' ['+d.id.slice(0,6)+']');
      else if(!r.at||Date.parse(r.at)<now-90000)reasons.push(d.name+'：確認が古くなりました。アプリを開いてください。');
    }
    if(!job.pc_receipt||Date.parse(job.pc_receipt.verified_at)<now-90000)reasons.push('会社PC：'+(job.pc_error||'案件一式のバックアップ確認待ち。PC自動同期を開いてください。'));
    return {ready:!reasons.length,reasons};
  }
  function receiptParts(path,rootName){
    const parts=String(path||'').split(/[\\/]/);
    if(parts.length<2||parts[0]!==rootName||parts.some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw Error('以前の保管フォルダと保存先が一致しません。');
    return parts.slice(1);
  }
  function backupPack(job,paths){
    const project=JSON.parse(JSON.stringify(job.payload.project));
    const drawingStates={};
    for(const d of job.payload.drawings||[])if(d.meta?.id&&d.state)drawingStates[d.meta.id]=d.state;
    return {format:'sentlog-project-archive',version:1,project_id:job.project_id,job_id:job.id,revision:job.revision,
      catalog_hash:job.catalog_hash,workspace:{projects:[project]},drawingStates,
      files:job.manifest.map(f=>({...f,path:paths[f.key]}))};
  }
  function validatePack(pack,job){
    if(pack?.format!=='sentlog-project-archive'||pack.version!==1||pack.job_id!==job.id||pack.catalog_hash!==job.catalog_hash||
       pack.revision!==job.revision||stable(pack.workspace?.projects?.[0])!==stable(job.payload.project)||pack.files?.length!==job.manifest.length)throw Error('PCの控えの案件情報を照合できません。');
    for(const d of job.payload.drawings||[])if(stable(pack.drawingStates?.[d.meta.id])!==stable(d.state))throw Error('PCの変状記録を照合できません。');
    for(const f of job.manifest){const saved=pack.files.find(x=>x.key===f.key);
      if(!saved||saved.sha256!==f.sha256||saved.byte_size!==f.byte_size||saved.path!=='files/'+f.id)throw Error('PCのファイル一覧を照合できません。');}
    return true;
  }
  const api={stable,snapshotText,hash,matches,maySync,readiness,receiptParts,backupPack,validatePack};
  root.SentlogArchiveCore=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
