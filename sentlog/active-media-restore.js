/* Manual, bounded repair of active shared media from the PC backup.
 * Read-only local access; no fake device receipts or delete operations.
 * The server is the durable queue. Reopening resumes only missing files. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.SentlogActiveMediaRestore=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const types={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/heic':'.heic','image/heif':'.heif','image/tiff':'.tiff','application/pdf':'.pdf','application/dxf':'.dxf'};
 const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
 const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const stopError=()=>Object.assign(Error('中断しました。未復旧ファイルは次回に引き継ぎます。'),{code:'RESTORE_STOPPED'});
 const fail=(s,code)=>Object.assign(Error(s),{code});
 async function hash(blob,subtle){
  const bytes=await subtle.digest('SHA-256',await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 }
 async function verify(blob,a,subtle){
  if(!blob||typeof blob.arrayBuffer!=='function'||blob.size!==a.byte_size||await hash(blob,subtle)!==a.sha256)
   throw fail('保存時のサイズまたはSHA-256と一致しません。元ファイルは変更しません。','RESTORE_HASH');
 }
 async function readOriginal(root,a){
  if(!root||typeof root.queryPermission!=='function'||await root.queryPermission({mode:'readwrite'})!=='granted')
   throw fail('会社PCの保管フォルダを選択し、保存許可を確認してください。','RESTORE_FOLDER');
  const parts=String(a.pc_path||'').split(/[\\/]+/);
  if(parts.length<2||parts[0]!==root.name||parts.some(x=>!x||x==='.'||x==='..'||x.includes('\0')))
   throw fail('PC保管先の記録が一致しません。','RESTORE_PATH');
  let dir=root;
  for(const name of parts.slice(1,-1))dir=await dir.getDirectoryHandle(name);
  return (await dir.getFileHandle(parts[parts.length-1])).getFile();
 }
 const sameScope=(a,b)=>a?.owner===b?.owner&&a?.device===b?.device&&uuid(a?.owner)&&uuid(a?.device);
 function validateRow(a,after){
  if(!uuid(a?.id)||!uuid(a.project_id)||(after&&a.id<=after)||!['photo','drawing'].includes(a.kind)
    ||!hex(a.sha256)||!Number.isSafeInteger(a.byte_size)||a.byte_size<=0||typeof a.storage_path!=='string'
    ||typeof a.updated_at!=='string'||!Number.isFinite(Date.parse(a.updated_at)))
    throw fail('クラウド補完対象の識別情報が一致しません。','RESTORE_LIST');
 }
 function validateClaim(a,scope,c){
  if(!uuid(c?.token)||typeof c.storage_path!=='string'||typeof c.object_present!=='boolean')throw fail('補完先の確認に失敗しました。','RESTORE_LEASE');
  const p=c.storage_path.split('/');
  if(p.length!==7||p[0]!==scope.owner||p[1]!==a.project_id||p[2]!=='active-restore'||p[3]!==a.id||p[4]!==a.sha256
   ||!hex(p[5])||p[6]!==c.token+types[a.mime_type])throw fail('補完先の案件・ファイル・内容が一致しません。','RESTORE_LEASE');
 }
 function create({getScope,ensure,getRoot,rpc,upload,download,subtle,online=()=>true,wait=delay,onState=()=>{}}){
  let running=false,stopped=false,stats={checked:0,restored:0,skipped:0,failed:0,lastError:''};
  const emit=(phase,message='')=>onState({...stats,phase,message});
  const assertScope=s=>{if(stopped)throw stopError();if(!online())throw fail('通信が切れました。次回は未復旧分から再開します。','RESTORE_OFFLINE');
   if(!sameScope(s,getScope()))throw fail('同期中にログインまたは端末が変更されました。','RESTORE_SCOPE');};
  const base=a=>({p_asset_id:a.id,p_sha256:a.sha256,p_byte_size:a.byte_size,p_expected_path:a.storage_path,p_expected_updated_at:a.updated_at});
  async function restoreOne(a,scope){
   assertScope(scope);
   if(!a.pc_path)throw fail('一致するPC保存記録がありません。','RESTORE_PC_RECEIPT');
   if(!types[a.mime_type]||a.byte_size>25*1024*1024)throw fail('対象ファイルの形式または容量が現在のStorage設定に対応していません。','RESTORE_FORMAT');
   const file=await readOriginal(getRoot(),a);assertScope(scope);await verify(file,a,subtle);assertScope(scope);
   const args={p_device_id:scope.device,...base(a)};
   const c=await rpc('claim',args,scope);assertScope(scope);
   if(c?.claimed===false&&['leased','already_available'].includes(c.reason))return 'skipped';
   if(c?.claimed!==true)throw fail('補完の予約を確認できません。','RESTORE_LEASE');
   validateClaim(a,scope,c);
   if(!c.object_present){
    try{await upload(c.storage_path,file,a.mime_type,scope);}
    catch(e){if(![400,409].includes(e?.status)||!/(duplicate|already exists|resource already exists)/i.test(e.message))throw e;}
    assertScope(scope);
   }
   // One read-back is intentional: never publish unverified remote bytes.
   const remote=await download(c.storage_path,scope);assertScope(scope);
   await verify(remote,a,subtle);assertScope(scope);
   const done=await rpc('finish',{...args,p_token:c.token},scope);assertScope(scope);
   if(done?.published===true&&done.asset_id===a.id)return 'restored';
   if(done?.published===false&&done.reason==='already_available')return 'skipped';
   throw fail('公開結果を確認できません。次回は未復旧分を確認します。','RESTORE_FINISH');
  }
  const transient=e=>e?.code==='RESTORE_SCOPE'||e?.code==='RESTORE_OFFLINE'||e?.status===401||e?.status===403||e?.status===429
   ||e?.status>=500||e?.name==='AbortError'||e?.name==='TypeError'||/timeout|network|failed to fetch|statement timeout/i.test(String(e?.message||e));
  async function start(){
   if(running)return false;running=true;stopped=false;stats={checked:0,restored:0,skipped:0,failed:0,lastError:''};emit('running','クラウド補完対象を確認中');
   try{
    await ensure();const scope=getScope();if(!sameScope(scope,scope))throw fail('登録済みPCでログインしてください。','RESTORE_SCOPE');
    assertScope(scope);
    const folder=getRoot();
    if(!folder||typeof folder.queryPermission!=='function'||await folder.queryPermission({mode:'readwrite'})!=='granted')
     throw fail('会社PCの保管フォルダを選択し、保存許可を確認してください。','RESTORE_FOLDER');
    let after=null;
    for(;;){
     assertScope(scope);const page=await rpc('list',{p_device_id:scope.device,p_after:after},scope);assertScope(scope);
     if(page?.schema!==1||!Array.isArray(page.rows)||page.rows.length>16)throw fail('補完対象の一覧を確認できません。','RESTORE_LIST');
     if(!page.rows.length)break;
     for(const a of page.rows){
      assertScope(scope);validateRow(a,after);
      try{
       const outcome=await restoreOne(a,scope);stats[outcome]++;
      }catch(e){
       if(stopped||e?.code==='RESTORE_STOPPED'||transient(e)||e?.code==='RESTORE_FOLDER'||e?.code==='RESTORE_LEASE')throw e;
       stats.failed++;stats.lastError=String(e?.message||e);
      }
      after=a.id;stats.checked++;emit('running','写真・図面を順次照合しています。');await wait(250);
     }
     if(page.rows.length<16)break;
     await wait(1000);
    }
    emit(stats.failed||stats.skipped?'review':'complete',stats.failed||stats.skipped?'未確認のファイルがあります。原本を保持して再確認してください。':'今回の対象を処理しました。全端末への受信確認は別途必要です。');
    return true;
   }catch(e){
    stats.lastError=String(e?.message||e);emit(stopped?'stopped':'paused',stats.lastError);return false;
   }finally{running=false;}
  }
  return {start,stop(){stopped=true;},get running(){return running;}};
 }
 function mount({getScope,getSession,ensure,getRoot,baseUrl,apiKey,fetcher=fetch,subtle=crypto.subtle,host=document.querySelector('main')}){
  if(!host||document.getElementById('slActiveMediaRestore'))return;
  const panel=document.createElement('section');panel.id='slActiveMediaRestore';panel.className='card';
  const h=document.createElement('h2');h.textContent='既存写真・図面のクラウド補完';
  const explanation=document.createElement('p');explanation.className='muted';explanation.textContent='使用中案件の未補完ファイルをPCの保管原本から復旧します。元画像や記録は削除しません。最初の補完時のみデータ転送が発生します。';
  const state=document.createElement('p');state.setAttribute('role','status');state.textContent='未実行（必要なときだけ開始）';
  const controls=document.createElement('div');controls.className='row';
  const startButton=document.createElement('button'),stopButton=document.createElement('button');
  startButton.type=stopButton.type='button';startButton.textContent='クラウド補完を開始・再開';stopButton.textContent='中断';stopButton.disabled=true;
  controls.append(startButton,stopButton);panel.append(h,explanation,controls,state);host.append(panel);
  const encodePath=path=>path.split('/').map(encodeURIComponent).join('/');
  async function request(path,options,scope){
   await ensure();
   if(!sameScope(scope,getScope()))throw fail('ログインまたは端末が変更されました。','RESTORE_SCOPE');
   const token=getSession()?.access_token;if(!token)throw fail('再ログインが必要です。','RESTORE_SCOPE');
   const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),90000);
   try{
    const resp=await fetcher(baseUrl+path,{...options,cache:'no-store',signal:ctrl.signal,headers:{apikey:apiKey,Authorization:'Bearer '+token,...options.headers}});
    if(!resp.ok){const t=await resp.text();let msg=t;try{const j=JSON.parse(t);msg=j.message||j.error||t;}catch{}throw Object.assign(Error('HTTP '+resp.status+' '+String(msg).slice(0,250)),{status:resp.status});}
    return options.readBlob?await resp.blob():await resp.json();
   }finally{clearTimeout(timer);}
  }
  const service=create({getScope,ensure,getRoot,subtle,online:()=>navigator.onLine,
   rpc:(action,args,scope)=>request('/rest/v1/rpc/sentlog_active_media_restore_v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,...args})},scope),
   upload:(path,file,mime,scope)=>request('/storage/v1/object/sentlog-temp/'+encodePath(path),{method:'POST',headers:{'Content-Type':mime,'x-upsert':'false'},body:file},scope),
   download:(path,scope)=>request('/storage/v1/object/authenticated/sentlog-temp/'+encodePath(path),{method:'GET',headers:{},readBlob:true},scope),
   onState:s=>{state.textContent='確認 '+s.checked+'件 ／ 復旧 '+s.restored+'件 ／ 他処理待ち '+s.skipped+'件 ／ 要確認 '+s.failed+'件。'+s.message+(s.failed&&s.lastError?' 最終確認: '+s.lastError:'');}});
  startButton.onclick=async()=>{if(service.running)return;if(!confirm('使用中案件の不足ファイルをPC保管原本からクラウドへ補完します。元のデータは削除しません。開始しますか？'))return;
   startButton.disabled=true;stopButton.disabled=false;try{await service.start();}finally{startButton.disabled=false;stopButton.disabled=true;}};
  stopButton.onclick=()=>{service.stop();stopButton.disabled=true;};
 }
 return {create,mount,readOriginal,verify};
});
