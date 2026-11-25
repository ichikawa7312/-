/* Bounded, fair delivery attempts; temporary state only. No record/file mutations. */
function createSentlogDeliveryGuard({now=()=>Date.now(),maxPerCycle=8,cooldownMs=60000}={}){
 let scope=null,lastId='',attempts=0,retryAt=0,failures=0;
 const until=new Map();
 const idOf=a=>typeof a==='string'?a:String(a.id);
 const keyOf=a=>JSON.stringify([idOf(a),String(a.sha256||'').toLowerCase(),Number(a.byte_size),String(a.storage_path||''),String(a.status||'')]);
 function begin(nextScope){
  if(scope!==nextScope){scope=nextScope;lastId='';retryAt=0;failures=0;until.clear();}
  attempts=0;const t=now();for(const [key,expiry] of until)if(expiry<=t)until.delete(key);
  return t>=retryAt;
 }
 function order(items){
  const sorted=[...items].sort((a,b)=>idOf(a)<idOf(b)?-1:idOf(a)>idOf(b)?1:0);
  const i=sorted.findIndex(a=>idOf(a)>lastId);
  return i>0?[...sorted.slice(i),...sorted.slice(0,i)]:sorted;
 }
 function take(a){
  if(attempts>=maxPerCycle||now()<retryAt)return false;
  const k=keyOf(a);if((until.get(k)||0)>now())return false;
  attempts++;lastId=idOf(a);until.set(k,now()+cooldownMs);return true;
 }
 function isTransient(e){
  const status=Number(e?.status||0),message=String(e?.message||e||'');
  return status===429||(status>=500&&status<=599)||e?.name==='AbortError'||e?.name==='TypeError'||
   /(?:^|\D)(?:429|500|502|503|504|522|524|57014)(?:\D|$)|PGRST00[0-3]|timeout|timed out|network|Failed to fetch|Load failed|通信が.*切れ|接続.*失敗/i.test(message);
 }
 function fail(e){
  if(!isTransient(e))return false;
  failures=Math.min(failures+1,5);retryAt=now()+Math.min(300000,30000*2**(failures-1));return true;
 }
 function complete(){failures=0;retryAt=0;}
 return {begin,order,take,full:()=>attempts>=maxPerCycle,isTransient,fail,complete};
}
