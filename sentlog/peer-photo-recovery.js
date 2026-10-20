/* v1.87: relay verified local photos to another active device without a PC.
   No record edits, recompression, local deletion, or existing-file overwrites. */
(function(){
 'use strict';
 if(location.pathname.includes('/sentlog-pc/'))return;
 const BASE='https://wiulvaqixphuobdielyy.supabase.co',KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
 const enc=encodeURIComponent,allowed=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
 let busy=false,message='',uploadedTotal=0;
 const sessions=()=>{try{return JSON.parse(localStorage.getItem('sentlogCloudSessionV1')||'null')}catch{return null;}};
 function show(text){
   message=text;
   for(const [id,parent] of [['slPeerPhotosList','#projectsView .manager-shell'],['slPeerPhotosSync','#sentlogCloudLoggedIn']]){
     let el=document.getElementById(id);const host=document.querySelector(parent);if(!host)continue;
     if(!el){el=document.createElement('p');el.id=id;el.setAttribute('role','status');el.style.cssText='font-size:12px;line-height:1.65;color:#475569;margin:8px 0';host.append(el);}
     el.textContent=text;
   }
 }
 async function api(path,body){
   const s=sessions();if(!s?.access_token)throw Error('ログインを確認してください。');
   const c=new AbortController(),timer=setTimeout(()=>c.abort(),30000);
   try{
     const options={cache:'no-store',signal:c.signal,headers:{apikey:KEY,Authorization:'Bearer '+s.access_token}};
     if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
     const r=await fetch(BASE+'/rest/v1/'+path,options),data=await r.json().catch(()=>({}));
     if(!r.ok)throw Error(data.message||('通信エラー '+r.status));return data;
   }finally{clearTimeout(timer);}
 }
 async function allRows(table,select){
   const out=[];let after='';
   for(;;){
     const rows=await api(table+'?'+select+'&order=id.asc&limit=400'+(after?'&id=gt.'+enc(after):''));
     if(!Array.isArray(rows))throw Error('端末情報を確認できません。');if(!rows.length)return out;
     for(const row of rows){if(!row.id||row.id<=after)throw Error('端末一覧を確認できません。');after=row.id;out.push(row);}
   }
 }
 async function requests(){
   const out=[];let last=null;
   for(;;){
     const cursor=last?'&or='+enc('(asset_id.gt.'+last.asset_id+',and(asset_id.eq.'+last.asset_id+',device_id.gt.'+last.device_id+'))'):'';
     const rows=await api('sentlog_pdf_requests?received_at=is.null&select=asset_id,device_id,expected_sha256,requested_at&order=asset_id.asc,device_id.asc&limit=400'+cursor);
     if(!Array.isArray(rows))throw Error('写真の受信待ちを確認できません。');if(!rows.length)return out;
     for(const row of rows){
       if(!row.asset_id||!row.device_id||(last&&(row.asset_id<last.asset_id||(row.asset_id===last.asset_id&&row.device_id<=last.device_id))))throw Error('写真の受信待ち一覧を確認できません。');
       last=row;out.push(row);
     }
   }
 }
 async function readLocal(key){
   const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('surveyFieldNoteDB',1);
     q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
   try{return await new Promise((resolve,reject)=>{const q=db.transaction('files','readonly').objectStore('files').get(key);
     q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close();}
 }
 async function digest(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
 async function send(a,id){
   if(!allowed.has(String(a.mime_type).toLowerCase())||Number(a.byte_size)<=0||Number(a.byte_size)>22*1024*1024)return false;
   const d=a.metadata?.drawing_id,p=a.metadata?.photo_id;if(!d||!p)return false;
   const blob=await readLocal('photo:'+d+':'+p);
   if(!(blob instanceof Blob)||!blob.size)return false;
   if(blob.size!==Number(a.byte_size)||await digest(blob)!==String(a.sha256).toLowerCase())
     throw Error('登録内容と一致しない写真があります。元の写真を保持しました。');
   if(document.hidden||!navigator.onLine)return false;
   const params={p_asset_id:a.id,p_device_id:id,p_sha256:a.sha256,p_byte_size:Number(a.byte_size)};
   const claim=await api('rpc/sentlog_device_photo_redelivery_v1',{...params,p_action:'claim'});
   if(!claim?.claimed)return false;
   const session=sessions(),parts=String(claim.storage_path||'').split('/');
   if(!session?.user?.id||parts[0]!==session.user.id||parts[1]!==a.project_id||parts[2]!=='device-redelivery'||parts[3]!==a.id||!claim.token||!parts[4]?.startsWith(claim.token+'.')||parts.length!==5)
     throw Error('写真の送信先を確認できません。');
   const c=new AbortController(),timer=setTimeout(()=>c.abort(),90000);
   try{
     const r=await fetch(BASE+'/storage/v1/object/sentlog-temp/'+parts.map(enc).join('/'),{
       method:'POST',signal:c.signal,headers:{apikey:KEY,Authorization:'Bearer '+session.access_token,
       'Content-Type':a.mime_type,'x-upsert':'false'},body:blob});
     if(!r.ok)throw Error('写真の再送に失敗しました（'+r.status+'）。通信を確認して再試行してください。');
   }finally{clearTimeout(timer);}
   // Finish can be retried after an uncertain response; the next polling cycle
   // observes published assets or waits for the lease to expire before claiming.
   await api('rpc/sentlog_device_photo_redelivery_v1',{...params,p_action:'finish',p_token:claim.token});
   return true;
 }
 async function run(){
   if(busy||document.hidden||!navigator.onLine||window.sentlogImporting||!window.SentlogRecords?.ready)return;
   const id=localStorage.getItem('sentlogCloudDeviceV1');if(!id||!sessions()?.access_token)return;
   busy=true;
   try{
     await window.sentlogManagementSession?.();
     const pending=await requests();
     if(!pending.length){show(uploadedTotal?'端末間の写真補完：'+uploadedTotal+'枚を送信しました。受信済みの写真は端末の写真確認欄で確認できます。':'');return;}
     const devices=await allRows('sentlog_devices','active=eq.true&select=id,last_seen_at,device_type');
     const live=new Map(devices.map(d=>[d.id,d])),cutoff=Date.now()-15*60*1000;
     const desired=new Map();
     for(const q of pending){const peer=live.get(q.device_id);
       if(q.device_id!==id&&peer&&['iphone','ipad','browser'].includes(peer.device_type)&&(Date.parse(q.requested_at)>=cutoff||Date.parse(peer.last_seen_at)>=cutoff)){
         const hashes=desired.get(q.asset_id)||new Set();hashes.add(String(q.expected_sha256).toLowerCase());desired.set(q.asset_id,hashes);
       }
     }
     if(!desired.size){show('写真をそろえるときは、もう一方の端末でもセントログを開いてください。');return;}
     const active=new Set((await allRows('sentlog_projects','status=eq.active&select=id')).map(p=>p.id));
     const ids=[...desired.keys()];let sent=0,errors=[],checked=0;const started=Date.now();
     outer:for(let offset=0;offset<ids.length;offset+=80){
       const assets=await api('sentlog_assets?kind=eq.photo&status=eq.storage_deleted&id=in.'+enc('('+ids.slice(offset,offset+80).join(',')+')')+'&select=id,project_id,mime_type,sha256,byte_size,metadata&limit=100');
       if(!Array.isArray(assets))throw Error('写真情報を確認できません。');
       for(const a of assets){
         if(document.hidden||!navigator.onLine||Date.now()-started>45000||sent>=8)break outer;
         if(!active.has(a.project_id)||!desired.get(a.id)?.has(String(a.sha256).toLowerCase()))continue;
         checked++;
         try{if(await send(a,id)){sent++;uploadedTotal++;show('端末間の写真補完：この端末から'+uploadedTotal+'枚を送信しました。両方の画面を開いておいてください。');}}
         catch(e){errors.push(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message);}
       }
     }
     if(errors.length)show('写真補完の確認：'+errors[0]);
     else if(sent)show('端末間の写真補完：この端末から'+uploadedTotal+'枚を送信しました。受信確認を続けています。');
     else if(checked)show('写真補完：この端末から送れる写真を確認しています。写真が残っているもう一方の端末も開いてください。');
     // Receiving is already hash-verified and durable in photo-recovery.js.
     window.sentlogCheckPhotoRecovery?.();
   }catch(e){show('写真補完の確認：'+(e.name==='AbortError'?'通信が途中で止まりました。次回の確認で再試行します。':e.message));}
   finally{busy=false;}
 }
 window.sentlogCheckPeerPhotos=run;
 Promise.resolve(window.sentlogAppReady).then(()=>{setTimeout(run,4500);setInterval(run,15000);});
 window.addEventListener('online',run);window.addEventListener('pageshow',run);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)run();});
 document.addEventListener('click',e=>{if(e.target?.closest?.('#sentlogCloudSyncNow'))run();if(message)show(message);});
})();
