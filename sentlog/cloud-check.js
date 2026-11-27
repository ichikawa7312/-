/* Independent account and cloud metadata reader. No editor or sync imports. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.SentlogCloudCheck=api;api.mount(root.document);}
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const BASE='https://wiulvaqixphuobdielyy.supabase.co';
  const KEY='sb_publishable_4pCeFn-wPsEYzFLhCMCINw_VEUfxz0-';
  const OWN='sentlogCloudCheckSessionV1',SHARED='sentlogCloudSessionV1';
  const PAGE=100,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PROJECT_COLUMNS='id,owner_id,name,status,updated_at';
  const SNAPSHOT_COLUMNS='project_id,owner_id,revision,updated_at';
  const fail=(code,message)=>Object.assign(Error(message),{code});
  const messages={
    AUTH_REQUIRED:'この画面でログインして、もう一度確認してください。',
    AUTH_EXPIRED:'セントログのログイン状態の期限が切れています。この画面でログインしてください。',
    AUTH_CHANGED:'ログイン状態が変わったため、確認を止めました。アカウントを選び直してください。',
    AUTH_RETRY_LATER:'ログイン状態を更新できませんでした。通信を確認し、少し待ってから再確認してください。',
    AUTH_STORAGE:'この確認画面のログイン情報を端末に保存・消去できませんでした。ブラウザの保存状態を確認してください。',
    LOGIN_FAILED:'ログインできませんでした。メールアドレスとパスワードを確認してください。',
    INVALID_RESPONSE:'クラウドからの応答を確認できませんでした。一覧を表示せず停止しました。',
    NETWORK:'通信を確認できませんでした。接続を確認して、もう一度お試しください。',
    TIMEOUT:'確認に時間がかかっているため停止しました。通信を確認して、もう一度お試しください。',
    CANCELLED:'確認を中止しました。',
    BUSY:'確認中です。終了または中止してから操作してください。',
    FORBIDDEN_REQUEST:'確認画面の通信先を確認できないため停止しました。'
  };
  function parse(raw){try{return raw?JSON.parse(raw):null;}catch{return null;}}
  function sessionShape(s){return !!s&&typeof s.access_token==='string'&&!!s.access_token&&UUID.test(s.user?.id||'')&&Number.isFinite(s.expires_at);}
  function snapshotIdFilter(value){
    if(typeof value!=='string'||!value.startsWith('in.(')||!value.endsWith(')'))return false;
    const ids=value.slice(4,-1).split(',');return ids.length>0&&ids.length<=PAGE&&ids.every(id=>UUID.test(id))&&new Set(ids).size===ids.length;
  }
  // Every HTTP request, including the reused session guard's refresh, passes
  // this positive allowlist. Redirects, credentials, SDK auto-refresh and RPCs
  // are not part of this standalone screen.
  function allowedRequest(input,init={}){
    let url;try{url=new URL(input);}catch{return false;}
    if(url.origin!==BASE||url.username||url.password||url.hash)return false;
    const method=String(init.method||'GET').toUpperCase(),q=url.searchParams;
    const exact=keys=>[...q.keys()].length===keys.length&&keys.every(k=>q.getAll(k).length===1);
    if(url.pathname==='/auth/v1/token'){
      if(method!=='POST'||!exact(['grant_type']))return false;
      const body=parse(init.body);if(!body||typeof body!=='object'||Array.isArray(body))return false;
      const names=Object.keys(body);
      if(q.get('grant_type')==='password')return names.length===2&&typeof body.email==='string'&&!!body.email&&typeof body.password==='string'&&!!body.password;
      return q.get('grant_type')==='refresh_token'&&names.length===1&&typeof body.refresh_token==='string'&&!!body.refresh_token;
    }
    if(url.pathname==='/auth/v1/user')return method==='GET'&&exact([])&&init.body===undefined;
    if(method!=='GET'||init.body!==undefined||!/^eq\.[0-9a-f-]+$/i.test(q.get('owner_id')||'')||!UUID.test((q.get('owner_id')||'').slice(3)))return false;
    if(url.pathname==='/rest/v1/sentlog_projects'){
      const fields=['select','owner_id','order','limit'];if(q.has('id'))fields.push('id');
      return exact(fields)&&q.get('select')===PROJECT_COLUMNS&&q.get('order')==='id.asc'&&q.get('limit')===String(PAGE)&&(!q.has('id')||q.get('id').startsWith('gt.')&&UUID.test(q.get('id').slice(3)));
    }
    if(url.pathname==='/rest/v1/sentlog_project_snapshots')return exact(['select','owner_id','project_id','order'])&&q.get('select')===SNAPSHOT_COLUMNS&&q.get('order')==='project_id.asc'&&snapshotIdFilter(q.get('project_id'));
    return false;
  }
  function create(options={}){
    const fetcher=options.fetcher||root.fetch.bind(root),now=options.now||Date.now;
    const guardFactory=options.sessionGuard||root.SentlogSessionGuard;
    if(typeof guardFactory?.create!=='function')throw fail('AUTH_REQUIRED','認証機能を読み込めませんでした。ページを開き直してください。');
    let storage;try{storage=options.storage===undefined?root.localStorage:options.storage;}catch{storage=null;}
    const addEvent=options.addEventListener||root.addEventListener?.bind(root);
    const removeEvent=options.removeEventListener||root.removeEventListener?.bind(root);
    const memory=new Map(),controllers=new Set();
    let keep=false,source=null,borrowedRaw=null,epoch=0,activeProof=null,disposed=false;
    let busy=false,cursor=null,checkedAt=null,projects=[],user=null,hasMore=false;
    let status='確認するアカウントを選ぶか、ログインしてください。',warning='',errorCode=null;
    function read(key){try{return storage?.getItem(key)??null;}catch{return null;}}
    function existing(){const s=parse(read(SHARED));return {present:!!s?.access_token,usable:sessionShape(s)&&s.expires_at>now()/1000+5};}
    const initial=read(OWN);if(sessionShape(parse(initial))){keep=true;memory.set(OWN,initial);}
    function ownKey(key){if(key!==OWN&&key!==OWN+':reauth-required')throw fail('AUTH_STORAGE',messages.AUTH_STORAGE);}
    const authStore={
      getItem(key){ownKey(key);return key===OWN&&keep?read(OWN):(memory.get(key)??null);},
      setItem(key,value){
        ownKey(key);
        if(key===OWN&&keep){try{if(!storage)throw Error();storage.setItem(OWN,value);}catch{throw fail('AUTH_STORAGE',messages.AUTH_STORAGE);}}
        memory.set(key,String(value));
      },
      removeItem(key){
        ownKey(key);
        if(key===OWN&&keep&&read(OWN)!==null){try{storage.removeItem(OWN);}catch{throw fail('AUTH_STORAGE',messages.AUTH_STORAGE);}}
        memory.delete(key);
      }
    };
    async function network(url,init={}){
      if(!allowedRequest(url,init))throw fail('FORBIDDEN_REQUEST',messages.FORBIDDEN_REQUEST);
      if(init.signal?.aborted)throw fail('CANCELLED',messages.CANCELLED);
      const controller=new AbortController();controllers.add(controller);
      const upstream=init.signal,abort=()=>controller.abort();upstream?.addEventListener('abort',abort,{once:true});
      if(upstream?.aborted)controller.abort();
      let timedOut=false,rejectAbort;
      const aborted=new Promise((resolve,reject)=>{rejectAbort=reject;});
      const abortedNow=()=>rejectAbort(fail(timedOut?'TIMEOUT':'CANCELLED',messages[timedOut?'TIMEOUT':'CANCELLED']));
      controller.signal.addEventListener('abort',abortedNow,{once:true});
      if(controller.signal.aborted)abortedNow();
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??20000);
      try{
        // Keep the deadline and cancellation alive until the response BODY has
        // been consumed. A late body can never re-enter the session guard after
        // cancel/timeout, even if a transport ignores its AbortSignal.
        const consumed=(async()=>{
          const response=await fetcher(url,{...init,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
          let value,invalid=false;try{value=await response.json();}catch{invalid=true;}
          return {ok:response.ok,status:response.status,json:async()=>{if(invalid)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);return value;}};
        })();
        return await Promise.race([consumed,aborted]);
      }catch(error){
        if(controller.signal.aborted)throw fail(timedOut?'TIMEOUT':'CANCELLED',messages[timedOut?'TIMEOUT':'CANCELLED']);
        throw fail('NETWORK',messages.NETWORK);
      }finally{clearTimeout(timer);controllers.delete(controller);upstream?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abortedNow);}
    }
    const nativeLocks=options.locks===undefined?root.navigator?.locks:options.locks;
    // Waiting for another tab's refresh is also part of this action. Aborting
    // only active fetches leaves a queued refresh free to start after Cancel.
    // Keep the shared guard unchanged and fence its acquisition here instead.
    const authLocks={request(name,callback){
      const id=epoch,controller=new AbortController();controllers.add(controller);
      let rejectAbort;const aborted=new Promise((resolve,reject)=>{rejectAbort=reject;});
      const onAbort=()=>rejectAbort(fail('CANCELLED',messages.CANCELLED));
      controller.signal.addEventListener('abort',onAbort,{once:true});
      function current(){checkEpoch(id);if(controller.signal.aborted)throw fail('CANCELLED',messages.CANCELLED);}
      const invoke=()=>{current();return callback();};
      let acquired;
      try{
        current();acquired=typeof nativeLocks?.request==='function'?
          nativeLocks.request(name,{mode:'exclusive',signal:controller.signal},invoke):Promise.resolve().then(invoke);
      }catch(error){acquired=Promise.reject(error);}
      // The race settles the old guard flight even if an adapter ignores its
      // signal. Its eventual callback must still pass the captured epoch fence.
      return Promise.race([acquired,aborted]).then(value=>{current();return value;},error=>{current();throw error;})
        .finally(()=>{controllers.delete(controller);controller.signal.removeEventListener('abort',onAbort);});
    }};
    const guard=guardFactory.create({key:OWN,storage:authStore,fetcher:network,baseUrl:BASE,apiKey:KEY,now,locks:authLocks});
    function state(){
      const shared=existing();
      return {busy,status,warning,errorCode,user:user?{email:user.email}:null,source,projects:projects.map(p=>({...p})),hasMore,checkedAt,
        canUseMain:shared.usable,sharedExpired:shared.present&&!shared.usable,canResume:sessionShape(guard.read()),remembered:keep};
    }
    function emit(){if(!disposed)options.onState?.(state());}
    function clearView(){user=null;projects=[];cursor=null;checkedAt=null;hasMore=false;activeProof=null;}
    function invalidate(){epoch++;for(const c of controllers)c.abort();controllers.clear();busy=false;clearView();}
    function checkEpoch(id){if(disposed||id!==epoch)throw fail('CANCELLED',messages.CANCELLED);}
    function assertProof(proof,id){
      checkEpoch(id);
      if(!proof||source!==proof.source)throw fail('AUTH_CHANGED',messages.AUTH_CHANGED);
      if(proof.source==='main'){
        if(read(SHARED)!==proof.raw)throw fail('AUTH_CHANGED',messages.AUTH_CHANGED);
      }else{
        const generation=guard.generation(),current=guard.read();
        if(generation!==proof.generation||guard.generation()!==generation||current?.access_token!==proof.token||current?.user?.id!==proof.owner)throw fail('AUTH_CHANGED',messages.AUTH_CHANGED);
      }
      if(proof.expiresAt<=now()/1000+5)throw fail('AUTH_EXPIRED',proof.source==='main'?messages.AUTH_EXPIRED:messages.AUTH_REQUIRED);
    }
    function httpError(response,auth=false){
      if(response.status===401||response.status===403)return fail(auth?'LOGIN_FAILED':'AUTH_REQUIRED',messages[auth?'LOGIN_FAILED':'AUTH_REQUIRED']);
      if(response.status===429)return fail('RATE_LIMIT','確認が混み合っています。少し待ってからお試しください。');
      if(response.status>=500)return fail('SERVICE_UNAVAILABLE','クラウドに接続できませんでした。少し待ってからお試しください。');
      return fail(auth?'LOGIN_FAILED':'READ_FAILED',auth?messages.LOGIN_FAILED:'クラウドの一覧を確認できませんでした（HTTP '+response.status+'）。');
    }
    async function json(path,{method='GET',body,token}={}){
      const init={method,headers:{apikey:KEY,...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})}};
      if(body!==undefined)init.body=JSON.stringify(body);
      const response=await network(BASE+path,init);
      if(!response.ok)throw httpError(response,path.includes('grant_type=password'));
      try{return await response.json();}catch{throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);}
    }
    async function verify(proof,id){
      assertProof(proof,id);
      const value=await json('/auth/v1/user',{token:proof.token});assertProof(proof,id);
      if(!UUID.test(value?.id||'')||value.id!==proof.owner||value.email!==undefined&&value.email!==null&&typeof value.email!=='string')throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
      return {id:value.id,email:value.email||'メールアドレス未確認'};
    }
    function ownProof(){
      const generation=guard.generation(),value=guard.read();if(!sessionShape(value))throw fail('AUTH_REQUIRED',messages.AUTH_REQUIRED);
      if(guard.generation()!==generation)throw fail('AUTH_CHANGED',messages.AUTH_CHANGED);
      return {source:'check',owner:value.user.id,token:value.access_token,expiresAt:value.expires_at,generation};
    }
    async function currentProof(id){
      checkEpoch(id);
      if(source==='main'){
        const value=parse(borrowedRaw);if(!sessionShape(value))throw fail('AUTH_REQUIRED',messages.AUTH_REQUIRED);
        const proof={source:'main',owner:value.user.id,token:value.access_token,expiresAt:value.expires_at,raw:borrowedRaw};assertProof(proof,id);return proof;
      }
      if(source!=='check')throw fail('AUTH_REQUIRED',messages.AUTH_REQUIRED);
      await guard.ensure();checkEpoch(id);const proof=ownProof();assertProof(proof,id);return proof;
    }
    function goodTime(value){return typeof value==='string'&&Number.isFinite(Date.parse(value));}
    async function page(proof,id,after){
      assertProof(proof,id);
      const query=new URLSearchParams({select:PROJECT_COLUMNS,owner_id:'eq.'+proof.owner,order:'id.asc',limit:String(PAGE)});
      if(after)query.set('id','gt.'+after);
      const rows=await json('/rest/v1/sentlog_projects?'+query,{token:proof.token});assertProof(proof,id);
      if(!Array.isArray(rows)||rows.length>PAGE)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
      const ids=new Set();let last=after;
      for(const row of rows){
        if(!row||!UUID.test(row.id||'')||row.owner_id!==proof.owner||typeof row.name!=='string'||!['active','archived'].includes(row.status)||!goodTime(row.updated_at)||ids.has(row.id)||last&&row.id<=last)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
        ids.add(row.id);last=row.id;
      }
      let snapshots=[];
      if(ids.size){
        const sq=new URLSearchParams({select:SNAPSHOT_COLUMNS,owner_id:'eq.'+proof.owner,project_id:'in.('+[...ids].join(',')+')',order:'project_id.asc'});
        snapshots=await json('/rest/v1/sentlog_project_snapshots?'+sq,{token:proof.token});assertProof(proof,id);
      }
      const metadata=new Map();
      if(!Array.isArray(snapshots)||snapshots.length>ids.size)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
      for(const row of snapshots){
        const revision=Number(row?.revision);
        if(!row||!ids.has(row.project_id)||row.owner_id!==proof.owner||metadata.has(row.project_id)||!['number','string'].includes(typeof row.revision)||typeof row.revision==='string'&&!/^\d+$/.test(row.revision)||!Number.isSafeInteger(revision)||revision<0||!goodTime(row.updated_at))throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
        metadata.set(row.project_id,{updatedAt:row.updated_at,revision});
      }
      return {rows:rows.map(row=>({id:row.id,name:row.name,status:row.status,projectUpdatedAt:row.updated_at,
        recordUpdatedAt:metadata.get(row.id)?.updatedAt??null,recordRevision:metadata.get(row.id)?.revision??null})),last,more:rows.length===PAGE};
    }
    function errorState(error){
      const code=error?.code==='REAUTH_REQUIRED'?'AUTH_REQUIRED':error?.code==='SESSION_CHANGED'?'AUTH_CHANGED':error?.code;
      errorCode=code||'INVALID_RESPONSE';status=messages[errorCode]||(['RATE_LIMIT','SERVICE_UNAVAILABLE','READ_FAILED'].includes(errorCode)?error.message:messages.INVALID_RESPONSE);
      clearView();
      if(['AUTH_REQUIRED','AUTH_CHANGED','AUTH_EXPIRED','LOGIN_FAILED'].includes(errorCode)){source=null;borrowedRaw=null;}
    }
    async function action(label,fn,{reset=true}={}){
      if(busy)throw fail('BUSY',messages.BUSY);
      const id=++epoch;if(reset)clearView();busy=true;errorCode=null;status=label;warning='';emit();
      try{await fn(id);checkEpoch(id);}
      catch(error){if(id===epoch&&!disposed)errorState(error);throw error;}
      finally{if(id===epoch&&!disposed){busy=false;emit();}}
    }
    async function load(id,{more=false,verified=null,proof=null}={}){
      proof=proof||await currentProof(id);verified=verified||await verify(proof,id);
      const result=await page(proof,id,more?cursor:null);assertProof(proof,id);
      user=verified;projects=more?[...projects,...result.rows]:result.rows;cursor=result.last;hasMore=result.more;
      checkedAt=new Date(now()).toISOString();activeProof=proof;errorCode=null;
      status=projects.length?'クラウドの案件 '+projects.length+' 件を確認しました。'+(hasMore?' 続きの案件を確認できます。':''):'このアカウントのクラウド案件は見つかりませんでした。';
    }
    function discardOwned(){
      // These are auth-session keys owned by this page, never a shared editor
      // session, migration marker, device registration or record key.
      if(read(OWN)!==null){try{storage.removeItem(OWN);}catch{throw fail('AUTH_STORAGE',messages.AUTH_STORAGE);}}
      keep=false;memory.clear();guard.set(null);
    }
    async function login(email,password,remember=false){
      return action('ログインしています…',async id=>{
        clearView();source=null;borrowedRaw=null;
        if(typeof email!=='string'||!email.trim()||typeof password!=='string'||!password)throw fail('LOGIN_FAILED',messages.LOGIN_FAILED);
        discardOwned();
        const data=await json('/auth/v1/token?grant_type=password',{method:'POST',body:{email:email.trim(),password}});checkEpoch(id);
        const seconds=Number(data?.expires_in);
        if(typeof data?.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token||!UUID.test(data.user?.id||'')||!Number.isFinite(seconds)||seconds<=0)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
        const value={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Math.floor(now()/1000)+seconds,user:{id:data.user.id,email:typeof data.user.email==='string'?data.user.email:''}};
        // Start in memory. Verify the authenticated user before optionally
        // persisting this independent session or requesting project metadata.
        guard.set(value);source='check';let proof=ownProof();const verified=await verify(proof,id);assertProof(proof,id);
        if(remember){keep=true;try{guard.set({...value,user:{id:verified.id,email:verified.email}});}catch(error){keep=false;guard.set(value);warning='ログイン状態を端末に保存できませんでした。この画面を開いている間だけ確認できます。';}}
        proof=ownProof();await load(id,{proof,verified});
      });
    }
    async function reuseMain(){
      return action('セントログのログイン状態を確認しています…',async id=>{
        clearView();source='main';borrowedRaw=read(SHARED);
        await load(id);
      });
    }
    async function resume(){
      return action('保存したログイン状態を確認しています…',async id=>{clearView();source='check';borrowedRaw=null;await load(id);});
    }
    async function refresh(){return action('クラウドの一覧を確認しています…',async id=>{clearView();await load(id);});}
    async function more(){
      if(!hasMore||!user)throw fail('INVALID_RESPONSE',messages.INVALID_RESPONSE);
      return action('続きの案件を確認しています…',async id=>{await load(id,{more:true});},{reset:false});
    }
    function cancel(){invalidate();status=messages.CANCELLED;errorCode='CANCELLED';emit();}
    function end(){
      invalidate();source=null;borrowedRaw=null;warning='';
      try{discardOwned();status='この画面の確認を終了しました。';errorCode=null;}
      catch(error){errorState(error);}
      emit();
    }
    function changed(){invalidate();source=null;borrowedRaw=null;status=messages.AUTH_CHANGED;errorCode='AUTH_CHANGED';emit();}
    function storageEvent(event){
      if((source==='main'&&(event.key===SHARED||event.key===null))||(source==='check'&&keep&&(event.key===OWN||event.key===null)))changed();
      else emit();
    }
    function checkIdentity(){
      if(activeProof){try{assertProof(activeProof,epoch);}catch(error){invalidate();errorState(error);emit();}}
      else emit();
    }
    addEvent?.('storage',storageEvent);
    function destroy(){invalidate();disposed=true;removeEvent?.('storage',storageEvent);}
    emit();
    return {state,login,reuseMain,resume,refresh,more,cancel,end,checkIdentity,destroy};
  }
  function mount(document){
    if(!document?.getElementById('cloudCheckLoginForm'))return null;
    const $=id=>document.getElementById(id),text=(tag,value,cls)=>{const node=document.createElement(tag);node.textContent=value;if(cls)node.className=cls;return node;};
    const date=value=>new Date(value).toLocaleString('ja-JP');
    let lastSignature='';
    function render(s){
      $('cloudCheckStatus').textContent=s.status;$('cloudCheckWarning').hidden=!s.warning;$('cloudCheckWarning').textContent=s.warning;
      $('cloudCheckSignIn').hidden=!!s.user;$('cloudCheckAccount').hidden=!s.user;
      $('cloudCheckUseMain').hidden=!s.canUseMain;$('cloudCheckResume').hidden=!s.canResume;
      $('cloudCheckSessionHint').textContent=s.sharedExpired?'セントログのログイン情報の期限が切れています。この画面でログインしてください。':'セントログと同じアカウントを利用できます。端末に保存するログイン情報は、この確認画面専用です。';
      for(const id of ['cloudCheckUseMain','cloudCheckResume','cloudCheckLogin','cloudCheckRefresh','cloudCheckMore','cloudCheckEmail','cloudCheckPassword','cloudCheckRemember'])$(id).disabled=s.busy;
      $('cloudCheckCancel').hidden=!s.busy;$('cloudCheckEnd').hidden=!(s.busy||s.user||s.canResume||s.source);
      $('cloudCheckMore').hidden=!s.hasMore;$('cloudCheckResults').hidden=!s.checkedAt;
      $('cloudCheckWho').textContent=s.user?.email||'';
      $('cloudCheckSource').textContent=s.source==='main'?'セントログのログイン状態で確認しています。確認の終了は、セントログ本体をログアウトしません。':s.remembered?'この確認画面のログイン状態を端末に保存しています。共有端末では、確認後に「この画面の確認を終了」を押してください。':'この確認画面を開いている間のログインです。';
      $('cloudCheckCheckedAt').textContent=s.checkedAt?'確認日時：'+date(s.checkedAt):'';
      const signature=JSON.stringify(s.projects);if(signature!==lastSignature){
        lastSignature=signature;$('cloudCheckProjects').replaceChildren();
        for(const p of s.projects){
          const item=text('article','', 'project');item.append(text('h3',p.name||'名称未設定'),text('span',p.status==='archived'?'保管中':'使用中','mode'),
            text('p','案件情報の更新日時：'+date(p.projectUpdatedAt)),text('p',p.recordUpdatedAt?'記録の控えの更新日時：'+date(p.recordUpdatedAt):'記録の控えの更新日時：保存情報なし'));
          $('cloudCheckProjects').append(item);
        }
      }
      document.body.dataset.ready='true';document.body.dataset.busy=String(s.busy);document.body.dataset.status=s.errorCode?'error':s.checkedAt?'ready':'idle';
    }
    let controller;
    try{controller=create({onState:render});}catch{ $('cloudCheckStatus').textContent='認証機能を読み込めませんでした。ページを開き直してください。';return null;}
    const run=fn=>{Promise.resolve().then(fn).catch(()=>{});};
    $('cloudCheckLoginForm').addEventListener('submit',event=>{
      event.preventDefault();const email=$('cloudCheckEmail').value,password=$('cloudCheckPassword').value,remember=$('cloudCheckRemember').checked;$('cloudCheckPassword').value='';
      run(()=>controller.login(email,password,remember));
    });
    $('cloudCheckUseMain').onclick=()=>run(()=>controller.reuseMain());$('cloudCheckResume').onclick=()=>run(()=>controller.resume());
    $('cloudCheckRefresh').onclick=()=>run(()=>controller.refresh());$('cloudCheckMore').onclick=()=>run(()=>controller.more());
    $('cloudCheckCancel').onclick=()=>controller.cancel();$('cloudCheckEnd').onclick=()=>{$('cloudCheckPassword').value='';$('cloudCheckEmail').value='';controller.end();};
    root.addEventListener?.('focus',()=>controller.checkIdentity());
    root.addEventListener?.('pageshow',()=>controller.checkIdentity());
    root.addEventListener?.('pagehide',()=>controller.cancel());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)controller.checkIdentity();});
    return controller;
  }
  return {create,mount,allowedRequest,config:Object.freeze({baseUrl:BASE,ownSessionKey:OWN,sharedSessionKey:SHARED,pageSize:PAGE})};
});
