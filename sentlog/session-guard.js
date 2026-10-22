/* v1.89: serialize session refreshes; never touch survey records, files or devices. */
(function(root){
 'use strict';
 const MESSAGE='ログイン情報を更新できないため同期を停止しました。同じアカウントで再ログインしてください。記録・写真は削除していません。';
 function create(options){
  const store=options.storage||root.localStorage;
  const fetcher=options.fetcher||root.fetch.bind(root);
  const locks=options.locks===undefined?root.navigator?.locks:options.locks;
  const now=options.now||Date.now;
  const key=options.key, marker=key+':reauth-required';
  let flight=null,retryAt=0,failures=0,lastRaw;
  function read(){try{return JSON.parse(store.getItem(key)||'null')}catch{return null}}
  function required(){return store.getItem(marker)==='1'}
  function notify(){lastRaw=store.getItem(key);options.onChange?.(read(),required());}
  function adopt(){if(store.getItem(key)!==lastRaw)notify();return read()}
  function set(value){
   if(value)store.setItem(key,JSON.stringify(value));else store.removeItem(key);
   store.removeItem(marker);retryAt=0;failures=0;notify();return value;
  }
  const fresh=s=>!!s?.access_token&&Number(s.expires_at)>now()/1000+60;
  const same=(a,b)=>a?.refresh_token===b?.refresh_token&&a?.access_token===b?.access_token&&a?.user?.id===b?.user?.id;
  function changed(current,previous){
   if(current&&current.user?.id===previous.user?.id&&fresh(current)){notify();return current;}
   const e=Error(current?'ログイン情報が変更されました。次の同期で確認します。':'ログインしてください。');
   e.code='SESSION_CHANGED';throw e;
  }
  function rejectSession(previous){
   const current=read();if(!same(current,previous))return changed(current,previous);
   store.removeItem(key);store.setItem(marker,'1');retryAt=0;notify();
   const e=Error(MESSAGE);e.code='REAUTH_REQUIRED';throw e;
  }
  function retry(message){
   failures++;retryAt=now()+Math.min(60000,5000*Math.pow(2,Math.min(failures-1,4)));
   const e=Error(message||'ログイン更新の通信を確認できませんでした。記録は保持し、間隔を空けて再確認します。');
   e.code='AUTH_RETRY_LATER';return e;
  }
  async function refresh(){
   const previous=adopt();
   if(!previous){const e=Error(required()?MESSAGE:'ログインしてください。');e.code='REAUTH_REQUIRED';throw e;}
   if(fresh(previous))return previous;
   if(now()<retryAt){const e=Error('ログイン更新の通信待ちです。間隔を空けて再確認します。');e.code='AUTH_RETRY_LATER';throw e;}
   if(!previous.refresh_token)return rejectSession(previous);
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
   let response,data;
   try{
    response=await fetcher(options.baseUrl+'/auth/v1/token?grant_type=refresh_token',{
     method:'POST',cache:'no-store',signal:controller.signal,
     headers:{apikey:options.apiKey,'Content-Type':'application/json'},
     body:JSON.stringify({refresh_token:previous.refresh_token})
    });
    data=await response.json().catch(()=>({}));
   }catch(e){
    const current=read();if(!same(current,previous))return changed(current,previous);
    throw retry();
   }finally{clearTimeout(timeout)}
   const current=read();if(!same(current,previous))return changed(current,previous);
   if(!response.ok){
    const code=String(data.code||data.error_code||data.error||'');
    const invalid=['refresh_token_already_used','refresh_token_not_found','session_not_found','session_expired','invalid_refresh_token','invalid_grant','user_not_found','user_banned'].includes(code)
     || /invalid refresh token|refresh token.*(not found|already used|expired)/i.test(String(data.msg||data.message||data.error_description||''));
    if([400,401,403].includes(response.status)&&invalid)return rejectSession(previous);
    throw retry();
   }
   if(!data.access_token||!data.refresh_token||data.user?.id!==previous.user?.id)throw retry('ログイン更新の応答を確認できません。記録を保持して再確認します。');
   const seconds=Number(data.expires_in);
   if(!Number.isFinite(seconds)||seconds<=0)throw retry();
   return set({...data,expires_at:Math.floor(now()/1000)+seconds});
  }
  async function ensure(){
   const current=adopt();if(fresh(current))return current;
   if(flight)return flight;
   const task=locks?.request?locks.request('sentlog-auth:'+key,refresh):Promise.resolve().then(refresh);
   flight=Promise.resolve(task);
   try{return await flight}finally{flight=null}
  }
  root.addEventListener?.('storage',e=>{if(e.key===key||e.key===marker){retryAt=0;failures=0;notify();}});
  return {read,set,ensure,required,message:MESSAGE};
 }
 root.SentlogSessionGuard={create,message:MESSAGE};
})(typeof window==='undefined'?globalThis:window);
