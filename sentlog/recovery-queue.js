/* Recovery inventory: query only relevant rows and never silently stop at the API cap.
 * A request remains in the server queue until the existing verified ACK completes.
 * This helper never writes files, receipts, records, or request rows. */
async function sentlogRecoveryRows(api,table,query,keys,pageSize=400){
 const out=[];let after=null;
 const compare=(a,b)=>{for(const k of keys){if(a[k]<b[k])return -1;if(a[k]>b[k])return 1;}return 0;};
 const safe=v=>typeof v==='string'&&/^[A-Za-z0-9_-]+$/.test(v);
 for(;;){
  let cursor='';
  if(after){
   if(keys.length===1)cursor='&'+keys[0]+'=gt.'+encodeURIComponent(after[keys[0]]);
   else if(keys.length===2)cursor='&or='+encodeURIComponent('('+keys[0]+'.gt.'+after[keys[0]]+',and('+keys[0]+'.eq.'+after[keys[0]]+','+keys[1]+'.gt.'+after[keys[1]]+'))');
   else throw Error('再取得一覧の順序が不明です。');
  }
  const rows=await api(table+'?'+query+'&order='+keys.map(k=>k+'.asc').join(',')+'&limit='+pageSize+cursor);
  if(!Array.isArray(rows))throw Error('再取得一覧を確認できません。');
  for(const r of rows){
   if(!keys.every(k=>safe(r?.[k]))||(after&&compare(r,after)<=0))throw Error('再取得一覧の続きを確認できません。');
   out.push(r);after=r;
  }
  // Page size is 400, below the deployed 1000-row REST cap. A full page
  // must continue even when it contains the last currently available row.
  if(rows.length<pageSize)return out;
 }
}
async function sentlogRecoveryRequests(api,kind,{deviceIds=null,since=null,missingOnly=false}={}){
 if(!['drawing','photo'].includes(kind))throw Error('再取得対象を確認できません。');
 if(deviceIds!==null&&!deviceIds.length)return [];
 const base='received_at=is.null&select=asset_id,device_id,expected_sha256,requested_at,sentlog_assets!inner(kind,status)&sentlog_assets.kind=eq.'+kind+
   (missingOnly?'&sentlog_assets.status=eq.storage_deleted':'')+(since?'&requested_at=gte.'+encodeURIComponent(since):'');
 const get=q=>sentlogRecoveryRows(api,'sentlog_pdf_requests',q,['asset_id','device_id']);
 if(deviceIds===null)return get(base);
 const ids=[...new Set(deviceIds)],out=[];
 if(ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]+$/.test(x)))throw Error('再取得端末を確認できません。');
 for(let i=0;i<ids.length;i+=50)out.push(...await get(base+'&device_id=in.'+encodeURIComponent('('+ids.slice(i,i+50).join(',')+')')));
 return out;
}
function sentlogFreshRecoveryRequest(r,devices,cutoff){
 const d=devices.get(r.device_id);
 return !!d&&(Date.parse(r.requested_at)>=cutoff||Date.parse(d.last_seen_at)>=cutoff);
}
async function sentlogRecoveryDevices(api){
 const rows=await sentlogRecoveryRows(api,'sentlog_devices','active=eq.true&select=id,last_seen_at',['id']);
 return new Map(rows.map(d=>[d.id,d]));
}
async function sentlogLiveRecoveryRequests(api,kind,devices,{self,cutoff,missingOnly=false}){
 const recent=[],older=[];
 for(const d of devices.values()){
  if(d.id===self)continue;
  (Date.parse(d.last_seen_at)>=cutoff?recent:older).push(d.id);
 }
 const recentRows=await sentlogRecoveryRequests(api,kind,{deviceIds:recent,missingOnly});
 const newRows=await sentlogRecoveryRequests(api,kind,{deviceIds:older,since:new Date(cutoff).toISOString(),missingOnly});
 return [...recentRows,...newRows].filter(r=>r.device_id!==self&&sentlogFreshRecoveryRequest(r,devices,cutoff));
}
