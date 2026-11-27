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
  let flight=null,retryAt=0,failures=0,lastRaw,lastRequired,authGeneration=0;
  const subscribers=new Set();
  function read(){try{return JSON.parse(store.getItem(key)||'null')}catch{return null}}
  function required(){return store.getItem(marker)==='1'}
  const identity=s=>JSON.stringify([s?.user?.id||null,s?.access_token||null,s?.refresh_token||null]);
  let observed=identity(read()),previousOwner=read()?.user?.id||null;
  lastRaw=store.getItem(key);lastRequired=required();
  function notify(forceChange=false){
   lastRaw=store.getItem(key);const next=read(),needsLogin=required(),nextIdentity=identity(next);
   const changed=forceChange||observed!==nextIdentity||lastRequired!==needsLogin;
   const event=!next?.access_token?'SIGNED_OUT':!previousOwner||previousOwner!==next.user?.id?'SIGNED_IN':'TOKEN_REFRESHED';
   observed=nextIdentity;previousOwner=next?.user?.id||null;lastRequired=needsLogin;
   if(changed)authGeneration++;
   // Display failures cannot undo a persisted login or hide it from fences.
   try{options.onChange?.(next,needsLogin);}catch{}
   if(changed)for(const listener of [...subscribers])try{listener(event,next,{generation:authGeneration,reauthRequired:needsLogin});}catch{}
  }
  function adopt(){if(store.getItem(key)!==lastRaw||required()!==lastRequired)notify();return read()}
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
  function rejectSession(previous,generation){
   const current=adopt();if(!same(current,previous)||authGeneration!==generation)return changed(current,previous);
   store.removeItem(key);store.setItem(marker,'1');retryAt=0;notify();
   const e=Error(MESSAGE);e.code='REAUTH_REQUIRED';throw e;
  }
  function retry(message){
   failures++;retryAt=now()+Math.min(60000,5000*Math.pow(2,Math.min(failures-1,4)));
   const e=Error(message||'ログイン更新の通信を確認できませんでした。記録は保持し、間隔を空けて再確認します。');
   e.code='AUTH_RETRY_LATER';return e;
  }
  async function refresh(){
   const previous=adopt(),generation=authGeneration;
   if(!previous){const e=Error(required()?MESSAGE:'ログインしてください。');e.code='REAUTH_REQUIRED';throw e;}
   if(fresh(previous))return previous;
   if(now()<retryAt){const e=Error('ログイン更新の通信待ちです。間隔を空けて再確認します。');e.code='AUTH_RETRY_LATER';throw e;}
   if(!previous.refresh_token)return rejectSession(previous,generation);
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
    const current=adopt();if(!same(current,previous)||authGeneration!==generation)return changed(current,previous);
    throw retry();
   }finally{clearTimeout(timeout)}
   const current=adopt();if(!same(current,previous)||authGeneration!==generation)return changed(current,previous);
   if(!response.ok){
    const code=String(data.code||data.error_code||data.error||'');
    const invalid=['refresh_token_already_used','refresh_token_not_found','session_not_found','session_expired','invalid_refresh_token','invalid_grant','user_not_found','user_banned'].includes(code)
     || /invalid refresh token|refresh token.*(not found|already used|expired)/i.test(String(data.msg||data.message||data.error_description||''));
    if([400,401,403].includes(response.status)&&invalid)return rejectSession(previous,generation);
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
  root.addEventListener?.('storage',e=>{if(e.key===key||e.key===marker||e.key===null){
   retryAt=0;failures=0;
   // Storage events can be delivered after logout and re-login have both
   // finished in another tab. The intermediate change still invalidates work
   // even if the current serialized session has returned to the same value.
   notify(e.key===null||e.oldValue!==e.newValue);
  }});
  function subscribe(listener){
   if(typeof listener!=='function')throw Error('認証状態を受け取る関数が必要です');
   adopt();subscribers.add(listener);return()=>subscribers.delete(listener);
  }
  // Reading the generation also adopts a same-tab storage change. The counter
  // distinguishes logout -> login even when the same account/token returns.
  return {read,set,ensure,required,subscribe,generation(){adopt();return authGeneration;},message:MESSAGE};
 }
 root.SentlogSessionGuard={create,message:MESSAGE};
})(typeof window==='undefined'?globalThis:window);
