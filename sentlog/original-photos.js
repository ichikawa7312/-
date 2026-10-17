/* Sentlog v1.62: device-local original photos + lightweight shared previews.
 * Originals never enter normal cloud sync. Export recreates the same logical
 * folder structure used by the company-PC sync, in bounded ZIP batches.
 */
(function(root){
  'use strict';
  const S=root.SentlogRecords;
  const DB='surveyFieldNoteDB',STORE='files';
  const WORKSPACE='surveyFieldNoteWorkspaceV1',DRAWING='surveyFieldNoteDrawingV1:';
  const LOCAL='sentlogOriginalPhotoLocalV1',PREFIX='original-photo:';
  const MAX_BATCH_BYTES=450*1024*1024,MAX_BATCH_FILES=250;
  const invalid=/[<>:"/\\|?*\x00-\x1F]/g;
  const safe=(value,fallback='_')=>{
    let s=String(value||fallback).replace(invalid,'_').replace(/[. ]+$/g,'').trim();
    return s||fallback;
  };
  const bytes=n=>{
    n=Number(n)||0;
    if(n<1024)return Math.round(n)+' B';
    if(n<1024**2)return (n/1024).toFixed(1)+' KB';
    if(n<1024**3)return (n/1024**2).toFixed(1)+' MB';
    return (n/1024**3).toFixed(2)+' GB';
  };
  const key=(drawingId,photoId)=>PREFIX+drawingId+':'+photoId;
  function localState(){
    const raw=S.getItem(LOCAL);
    if(!raw)return {version:1,photos:{},lastBatch:null};
    try{
      const value=JSON.parse(raw);
      if(!value||value.version!==1||!value.photos||typeof value.photos!=='object'||Array.isArray(value.photos))throw Error();
      return value;
    }catch(_){throw Error('この端末の原本写真管理情報を読み取れません。原本は削除せず処理を停止しました。');}
  }
  async function saveState(state){
    S.setItem(LOCAL,JSON.stringify(state));
    await S.settled();
  }
  async function openDB(){
    return new Promise((resolve,reject)=>{
      const q=indexedDB.open(DB,1);
      q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains(STORE))q.result.createObjectStore(STORE);};
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
    });
  }
  async function getBlob(k){
    const db=await openDB();
    try{
      return await new Promise((resolve,reject)=>{
        const q=db.transaction(STORE,'readonly').objectStore(STORE).get(k);
        q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
      });
    }finally{db.close();}
  }
  function workspace(){
    try{
      const value=JSON.parse(S.getItem(WORKSPACE)||'{"projects":[]}');
      return Array.isArray(value.projects)?value:{projects:[]};
    }catch(_){return {projects:[]};}
  }
  function drawingState(id){
    try{return JSON.parse(S.getItem(DRAWING+id)||'null');}catch(_){return null;}
  }
  function resolvePath(meta){
    const ws=workspace();
    const project=ws.projects.find(p=>p.id===meta.projectId);
    const drawing=project?.drawings?.find(d=>d.id===meta.drawingId);
    const state=drawingState(meta.drawingId);
    const shape=state?.shapes?.find(s=>s.id===meta.shapeId);
    const projectName=project?.name||meta.projectName||'_案件未設定';
    const drawingName=drawing?.name||meta.drawingName||'_図面未設定';
    const shapeLabel=shape?.autoLabel||meta.shapeLabel||'_変状未設定';
    const dt=new Date(Number(meta.createdAt)||Date.now());
    const year=String(Number.isNaN(+dt)?new Date().getFullYear():dt.getFullYear());
    const fileName=safe(meta.name||('photo-'+meta.photoId+'.jpg'),'photo.jpg');
    return [year,safe(projectName), '写真',safe(drawingName),safe(shapeLabel),fileName].join('/');
  }
  async function storeOriginal(info){
    const file=info?.file;
    if(!(file instanceof Blob))throw Error('原本写真を読み取れません。');
    const photoId=String(info.photoId||''),drawingId=String(info.drawingId||'');
    if(!photoId||!drawingId)throw Error('原本写真の保存先を確認できません。');
    const k=key(drawingId,photoId);
    await S.writeFile(k,file);
    const state=localState();
    state.photos[k]={
      photoId,drawingId,projectId:String(info.projectId||''),shapeId:String(info.shapeId||''),
      projectName:String(info.projectName||''),drawingName:String(info.drawingName||''),
      shapeLabel:String(info.shapeLabel||''),name:String(info.name||file.name||('photo-'+photoId+'.jpg')),
      size:Number(file.size)||0,type:String(file.type||'application/octet-stream'),
      createdAt:Number(info.createdAt)||Date.now(),exportedAt:null,confirmedAt:null,batchId:null
    };
    await saveState(state);
    return state.photos[k];
  }
  function inventory(){
    const state=localState();
    return Object.entries(state.photos).map(([k,v])=>({key:k,...v}));
  }
  function currentProjectId(){
    try{return typeof activeProjectId!=='undefined'&&activeProjectId?String(activeProjectId):'';}catch(_){return '';}
  }
  function sameLocalDay(a,b){
    const x=new Date(Number(a)||0),y=new Date(Number(b)||0);
    return x.getFullYear()===y.getFullYear()&&x.getMonth()===y.getMonth()&&x.getDate()===y.getDate();
  }
  function choose(scope){
    const now=Date.now(),projectId=currentProjectId();
    return inventory().filter(item=>{
      if(item.confirmedAt)return false;
      if(scope==='today')return sameLocalDay(item.createdAt,now);
      if(scope==='project')return !!projectId&&item.projectId===projectId;
      return true;
    }).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  }

  const CRC_TABLE=(()=>{
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
    return table;
  })();
  async function crc32(blob){
    let crc=0xffffffff;
    const update=chunk=>{for(const b of chunk)crc=CRC_TABLE[(crc^b)&255]^(crc>>>8);};
    if(blob.stream){
      const reader=blob.stream().getReader();
      for(;;){const part=await reader.read();if(part.done)break;update(part.value);}
    }else update(new Uint8Array(await blob.arrayBuffer()));
    return (crc^0xffffffff)>>>0;
  }
  function dos(ms){
    const d=new Date(Number(ms)||Date.now());
    const year=Math.max(1980,d.getFullYear());
    return {
      time:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((d.getSeconds()>>1)&31),
      date:(((year-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31)
    };
  }
  function set16(v,o,n){new DataView(v.buffer,v.byteOffset,v.byteLength).setUint16(o,n,true);}
  function set32(v,o,n){new DataView(v.buffer,v.byteOffset,v.byteLength).setUint32(o,n>>>0,true);}
  async function makeZip(entries){
    const encoder=new TextEncoder(),body=[],central=[];
    let offset=0;
    for(const entry of entries){
      const name=encoder.encode(entry.path),size=Number(entry.blob.size);
      if(size>0xffffffff)throw Error('1ファイルがZIPの上限を超えています：'+entry.path);
      const checksum=await crc32(entry.blob),stamp=dos(entry.createdAt);
      const local=new Uint8Array(30+name.length);
      set32(local,0,0x04034b50);set16(local,4,20);set16(local,6,0x0800);set16(local,8,0);
      set16(local,10,stamp.time);set16(local,12,stamp.date);set32(local,14,checksum);
      set32(local,18,size);set32(local,22,size);set16(local,26,name.length);set16(local,28,0);local.set(name,30);
      const center=new Uint8Array(46+name.length);
      set32(center,0,0x02014b50);set16(center,4,20);set16(center,6,20);set16(center,8,0x0800);set16(center,10,0);
      set16(center,12,stamp.time);set16(center,14,stamp.date);set32(center,16,checksum);
      set32(center,20,size);set32(center,24,size);set16(center,28,name.length);set16(center,30,0);set16(center,32,0);
      set16(center,34,0);set16(center,36,0);set32(center,38,0);set32(center,42,offset);center.set(name,46);
      body.push(local,entry.blob);central.push(center);offset+=local.length+size;
    }
    const centralOffset=offset,centralSize=central.reduce((n,x)=>n+x.length,0);
    if(centralOffset+centralSize>0xffffffff)throw Error('書き出し容量が大きすぎます。分割して書き出してください。');
    const end=new Uint8Array(22);
    set32(end,0,0x06054b50);set16(end,4,0);set16(end,6,0);set16(end,8,entries.length);set16(end,10,entries.length);
    set32(end,12,centralSize);set32(end,16,centralOffset);set16(end,20,0);
    return new Blob([...body,...central,end],{type:'application/zip'});
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={safe,makeZip};return;}
  if(!S||root.SentlogOriginalPhotos)return;
  function uniquePaths(items){
    const used=new Map();
    return items.map(item=>{
      let path=resolvePath(item),n=used.get(path)||0;used.set(path,n+1);
      if(!n)return {...item,path};
      const slash=path.lastIndexOf('/'),dir=path.slice(0,slash+1),name=path.slice(slash+1);
      const dot=name.lastIndexOf('.'),base=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
      path=dir+base+'_'+(n+1)+ext;
      while(used.has(path)){n++;path=dir+base+'_'+(n+1)+ext;}
      used.set(path,1);return {...item,path};
    });
  }
  function batch(items){
    const out=[];let total=0;
    for(const item of items){
      if(out.length && (out.length>=MAX_BATCH_FILES||total+Number(item.size||0)>MAX_BATCH_BYTES))break;
      out.push(item);total+=Number(item.size||0);
    }
    return {items:out,total};
  }
  function ymd(ms=Date.now()){
    const d=new Date(ms);return String(d.getFullYear())+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  }
  function triggerDownload(blob,name){
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),120000);
  }
  async function exportScope(scope){
    await root.sentlogAppReady;await S.settled();S.assertSafe();
    const candidates=choose(scope);if(!candidates.length)throw Error('この条件で書き出す原本写真はありません。');
    const selected=batch(candidates),withPaths=uniquePaths(selected.items),entries=[];
    for(const item of withPaths){
      const blob=await getBlob(item.key);
      if(!(blob instanceof Blob)||blob.size!==Number(item.size))throw Error('原本写真を読み直せません：'+item.name+'。削除はしていません。');
      entries.push({path:item.path,blob,createdAt:item.createdAt});
    }
    const zip=await makeZip(entries),stamp=ymd(),project=currentProjectId();
    let suffix=scope==='today'?'今日':scope==='project'?(workspace().projects.find(p=>p.id===project)?.name||'案件'):'未確認';
    const name='セントログ原本_'+stamp+'_'+safe(suffix,'原本')+'_'+String(entries.length)+'枚.zip';
    triggerDownload(zip,name);
    const state=localState(),batchId='exp-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),at=Date.now();
    for(const item of selected.items){
      const row=state.photos[item.key];if(row){row.exportedAt=at;row.batchId=batchId;}
    }
    state.lastBatch={id:batchId,keys:selected.items.map(x=>x.key),name,at};
    await saveState(state);
    return {name,count:selected.items.length,bytes:selected.total,remaining:Math.max(0,candidates.length-selected.items.length)};
  }
  async function confirmLast(){
    const state=localState(),b=state.lastBatch;
    if(!b?.keys?.length)throw Error('確認待ちの書き出しがありません。');
    if(!root.confirm('書き出したZIPが「ファイル」等に保存できていることを確認しましたか？\n確認後も原本は自動削除しません。')){
      return false;
    }
    const now=Date.now();
    for(const k of b.keys)if(state.photos[k]&&state.photos[k].batchId===b.id)state.photos[k].confirmedAt=now;
    state.lastBatch=null;await saveState(state);return true;
  }
  async function deleteConfirmed(){
    await root.sentlogAppReady;await S.settled();S.assertSafe();
    const state=localState(),rows=Object.entries(state.photos).filter(([,v])=>v.confirmedAt);
    if(!rows.length)throw Error('削除できる確認済み原本はありません。');
    const total=rows.reduce((n,[,v])=>n+Number(v.size||0),0);
    if(!root.confirm('書き出し確認済みの原本 '+rows.length+'枚（約'+bytes(total)+'）を、この端末のセントログから削除しますか？\n共有用写真・PC・Supabaseのデータは変更しません。'))return false;
    const expected=S.getItem(WORKSPACE);
    await S.archiveAtomic({writes:[],deleteFiles:rows.map(([k,v])=>({key:k,size:Number(v.size)||0})),expectedWorkspace:expected});
    const next=localState();for(const [k] of rows)delete next.photos[k];next.lastBatch=null;await saveState(next);
    document.getElementById('sentlogStorageRefresh')?.click();return true;
  }
  function status(){
    const rows=inventory();let unexported=0,waiting=0,confirmed=0,total=0;
    for(const r of rows){total+=Number(r.size||0);if(r.confirmedAt)confirmed++;else if(r.exportedAt)waiting++;else unexported++;}
    return {count:rows.length,total,unexported,waiting,confirmed};
  }
  function hasLocalOriginals(){return inventory().length>0;}

  function installUI(){
    const modal=document.querySelector('#sentlogSettingsModal .modal-card');
    if(!modal||document.getElementById('sentlogOriginalSection'))return;
    const style=document.createElement('style');style.textContent=
      '#sentlogOriginalSection{border:1px solid var(--line);border-radius:10px;padding:0 14px;margin-bottom:12px;text-align:left}'+
      '#sentlogOriginalSection summary{padding:12px 0;min-height:48px;font-size:14px;font-weight:600;cursor:pointer}'+
      '#sentlogOriginalSection p{font-size:12px;line-height:1.65;margin:8px 0;color:#4b5563;overflow-wrap:anywhere}'+
      '#sentlogOriginalSection .sl-original-total{font-size:22px;font-weight:700;color:#111827;margin:6px 0}'+
      '#sentlogOriginalSection .sl-original-actions{display:grid;gap:7px;margin:10px 0 14px}'+
      '#sentlogOriginalSection button{min-height:44px;width:100%;font-size:12px}';
    document.head.appendChild(style);
    const section=document.createElement('details');section.id='sentlogOriginalSection';
    section.innerHTML='<summary>原本写真</summary><p>撮影・追加した端末だけに原本を残します。端末間の通常同期と会社PC自動同期には軽量な共有用写真だけを送ります。</p>'+
      '<div id="sentlogOriginalTotal" class="sl-original-total">確認中…</div><p id="sentlogOriginalStatus"></p>'+
      '<div class="sl-original-actions"><button type="button" id="sentlogOriginalToday">今日の原本を書き出す</button>'+
      '<button type="button" id="sentlogOriginalProject">現在の案件の原本を書き出す</button>'+
      '<button type="button" id="sentlogOriginalConfirm">直前の書き出しを保存確認済みにする</button>'+
      '<button type="button" id="sentlogOriginalDelete">確認済み原本を端末から削除</button></div>'+
      '<p>書き出しは会社PC保管と同じ「年／案件／写真／図面／変状／写真名」の構成です。大容量時は安全のため1回最大250枚・約450MBで分割します。</p>';
    const storage=document.getElementById('sentlogStorageSection'),backup=document.getElementById('sentlogBackupSection');
    if(storage)storage.insertAdjacentElement('afterend',section);else backup?.before(section);
    const total=section.querySelector('#sentlogOriginalTotal'),text=section.querySelector('#sentlogOriginalStatus');
    const today=section.querySelector('#sentlogOriginalToday'),project=section.querySelector('#sentlogOriginalProject');
    const confirm=section.querySelector('#sentlogOriginalConfirm'),del=section.querySelector('#sentlogOriginalDelete');
    const refresh=()=>{
      try{
        const s=status();total.textContent=s.count+'枚 / '+bytes(s.total);
        text.textContent='未書き出し '+s.unexported+'枚 ／ 保存確認待ち '+s.waiting+'枚 ／ 確認済み '+s.confirmed+'枚';
        project.disabled=!currentProjectId()||!choose('project').length;today.disabled=!choose('today').length;
        const st=localState();confirm.disabled=!st.lastBatch?.keys?.length;del.disabled=!s.confirmed;
      }catch(e){total.textContent='確認できません';text.textContent=e.message;}
    };
    async function run(button,fn){
      const label=button.textContent;button.disabled=true;button.textContent='処理中…';
      try{const result=await fn();if(result?.name)alert(result.name+' を書き出しました。'+(result.remaining?'\n同じ条件の残り '+result.remaining+'枚は、もう一度「書き出す」を押してください。':'')+'\nファイルへの保存を確認したら「保存確認済みにする」を押してください。');}
      catch(e){alert('原本写真の処理を完了できませんでした。'+(e.message||e));}
      finally{button.textContent=label;refresh();}
    }
    today.onclick=()=>run(today,()=>exportScope('today'));
    project.onclick=()=>run(project,()=>exportScope('project'));
    confirm.onclick=()=>run(confirm,()=>confirmLast());
    del.onclick=()=>run(del,()=>deleteConfirmed());
    section.addEventListener('toggle',()=>{if(section.open)refresh();});
    document.getElementById('sentlogSettingsBtn')?.addEventListener('click',()=>setTimeout(refresh,0));
    refresh();
  }
  const api={safe,resolvePath,makeZip,storeOriginal,exportScope,confirmLast,deleteConfirmed,status,hasLocalOriginals,key};
  root.SentlogOriginalPhotos=api;
  Promise.resolve(root.sentlogAppReady).then(installUI).catch(()=>installUI());
})(globalThis);
