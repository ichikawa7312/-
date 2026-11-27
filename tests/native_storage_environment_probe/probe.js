'use strict';
const MIB=1024*1024, limit=96*MIB;
const statusEl=document.getElementById('status'),output=document.getElementById('output');
const report={format:'sentlog-isolated-native-storage-probe-v1',startedAt:null,origin:location.origin,userAgent:navigator.userAgent,secureContext:isSecureContext,maxSyntheticBytes:limit,actualSentlogDataAccessed:false,events:[],writes:[],reads:[]};
let db=null,dbName=null,bytesWritten=0,busy=false;
document.getElementById('environment').textContent='検証先: '+location.origin+' / '+navigator.userAgent;
const show=()=>{output.textContent=JSON.stringify(report,null,2);document.getElementById('export').disabled=false;};
const errorInfo=e=>({name:String(e?.name||'Error'),message:String(e?.message||e||'Unknown error').slice(0,600)});
const event=(kind,details={})=>{report.events.push({at:new Date().toISOString(),kind,...details});show();};
async function estimate(){try{const x=await navigator.storage.estimate();return{usage:x.usage,quota:x.quota,usageDetails:x.usageDetails||null};}catch(e){return{error:errorInfo(e)};}}
const sha=async a=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',a)),x=>x.toString(16).padStart(2,'0')).join('');
function randomBytes(n){const b=new Uint8Array(n);for(let i=0;i<n;i+=65536)crypto.getRandomValues(b.subarray(i,Math.min(i+65536,n)));return b;}
async function open(){dbName='sentlog_synthetic_native_probe_'+crypto.randomUUID();report.databaseName=dbName;
 db=await new Promise((resolve,reject)=>{const q=indexedDB.open(dbName,1);q.onupgradeneeded=()=>{for(const name of ['files','control','journal'])q.result.createObjectStore(name);};q.onerror=()=>reject(q.error);q.onblocked=()=>event('open-blocked');q.onsuccess=()=>resolve(q.result);});
 db.onversionchange=e=>event('versionchange',{oldVersion:e.oldVersion,newVersion:e.newVersion});db.onclose=()=>event('unexpected-close');
 event('opened',{version:db.version});
}
async function put(key,payload,expected){const before=await estimate();const row={key,bytes:payload.size||payload.length,expected,before,requestSucceeded:false,complete:false,aborted:false};report.writes.push(row);
 await new Promise((resolve,reject)=>{let tx;try{tx=db.transaction(['files','control','journal'],'readwrite',{durability:'strict'});}catch(e){row.transactionOpenError=errorInfo(e);reject(e);return;}
  tx.oncomplete=()=>{row.complete=true;row.completeAt=new Date().toISOString();resolve();};tx.onabort=()=>{row.aborted=true;row.transactionError=errorInfo(tx.error);reject(tx.error||Error('transaction aborted'));};
  tx.onerror=e=>{row.requestError=errorInfo(e.target.error);};
  const q=tx.objectStore('files').put(payload,key);q.onsuccess=()=>{row.requestSucceeded=true;};
  tx.objectStore('control').put({key,bytes:row.bytes,expected},key);
 });row.after=await estimate();bytesWritten+=row.bytes;row.totalSyntheticBytes=bytesWritten;show();}
async function readOne(key,expected){let value;await new Promise((resolve,reject)=>{const tx=db.transaction(['files'],'readonly');const q=tx.objectStore('files').get(key);q.onsuccess=()=>{value=q.result;};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
 if(value===undefined)throw Error('Committed synthetic value missing: '+key);
 const raw=value instanceof Blob?await value.arrayBuffer():new TextEncoder().encode(value);
 const actual=await sha(raw),row={at:new Date().toISOString(),key,bytes:raw.byteLength,expected,actual,matched:actual===expected};report.reads.push(row);show();if(!row.matched)throw Error('Synthetic bytes differ: '+key);}
async function readAll(){for(const row of report.writes.filter(x=>x.complete))await readOne(row.key,row.expected);report.finalEstimate=await estimate();event('readback-complete',{completed:report.writes.filter(x=>x.complete).length});}
document.getElementById('start').onclick=async()=>{if(busy)return;busy=true;document.getElementById('start').disabled=true;report.startedAt=new Date().toISOString();statusEl.textContent='合成データを保存しています';
 try{report.before=await estimate();await open();for(let i=0;i<24;i++){const data=randomBytes(4*MIB),digest=await sha(data);await put('synthetic-'+i,new Blob([data]),digest);await readOne('synthetic-'+i,digest);statusEl.textContent='保存・照合済み '+((i+1)*4)+' / 96 MiB';}
 report.outcome='96 MiB committed and verified';await readAll();statusEl.textContent='96 MiBの保存確定と全件読み返しを確認しました';
 }catch(e){report.outcome='failed';report.failure=errorInfo(e);report.failureAt=new Date().toISOString();report.atFailure=await estimate();statusEl.textContent='保存診断で失敗を確認しました: '+report.failure.name;event('failure',report.failure);
  try{await readAll();}catch(readError){report.afterFailureReadError=errorInfo(readError);}
 }finally{busy=false;document.getElementById('read').disabled=!db;show();}};
document.getElementById('read').onclick=async()=>{if(busy)return;busy=true;document.getElementById('read').disabled=true;
 try{await readAll();statusEl.textContent='今回保存できた合成データの再照合が完了しました';}catch(e){report.laterReadFailure={at:new Date().toISOString(),...errorInfo(e)};statusEl.textContent='再照合で失敗を確認しました';}
 finally{busy=false;document.getElementById('read').disabled=false;show();}};
document.getElementById('export').onclick=()=>{const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='synthetic-native-storage-probe.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
