/* Authenticated delta RPC transport. Experimental; activation is server-owned.
 * Broadcasts only wake catch-up. No record is applied from a notification.
 * Both the existing REST/session app and a supplied Supabase JS client can use it.
 */
(function(root){
  'use strict';
  const CORE=root.SentlogDeltaSyncCore||(typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
  const SCOPE=['ownerId','projectId','deviceId'];
  const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
  const id=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const count=x=>Number.isSafeInteger(x)&&x>=0;
  const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const sameScope=(a,b)=>object(a)&&object(b)&&SCOPE.every(k=>a[k]===b[k]);
  function problem(code,message,status=0,retryable=false){const e=Error(message);e.code=code;e.retryable=retryable;e.deltaTransport=true;if(status)e.status=status;return e;}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  function normalize(error,status=0){
    if(error?.deltaTransport)return error;
    const sql=String(error?.code||''),http=Number(status||error?.status||error?.statusCode)||0;
    const application=String(error?.message||'').match(/\bDELTA_[A-Z0-9_]+\b/)?.[0];
    let code=application||sql||'DELTA_NETWORK',s=http;
    if(['PGRST202','PGRST205','42883','42P01'].includes(sql)){code='DELTA_UPGRADE_REQUIRED';s=409;}
    else if(['28000','PGRST301','PGRST302'].includes(sql)||http===401){code=application||'DELTA_LOGIN_REQUIRED';s=401;}
    else if(sql==='42501'||http===403){code=application||'DELTA_FORBIDDEN';s=403;}
    else if(sql==='40001'||sql==='23505'){s=409;}
    else if(['22023','22003','54000','55000'].includes(sql)){s=sql==='55000'?409:400;}
    const retryable=[408,425,429].includes(s)||(s>=500&&s<600)||(!s&&!sql);
    const message=s===401?'ログインを確認して同期を再開してください':s===403?'この案件・端末では同期を利用できません':
      code==='DELTA_UPGRADE_REQUIRED'?'差分同期のサーバー準備が完了していません':
      retryable?'通信が完了していません。未送信の内容は端末に残しています':'同期先の応答を確認できません。内容を保持して停止しました';
    const result=problem(code,message,s,retryable);if(sql)result.sqlState=sql;return result;
  }

  // One SDK channel per client/account. Closing one project's transport must
  // not remove another project's listener from the same owner-wide topic.
  const sdkHubs=new WeakMap();
  function sdkSubscribe(client,member){
    let hub=sdkHubs.get(client);
    if(!hub){hub={members:new Set(),channel:null,owner:null,token:null,ready:false,epoch:0,chain:Promise.resolve()};sdkHubs.set(client,hub);}
    let stopped=false;
    const active=m=>{try{return !m.stopped&&m.active();}catch{return false;}};
    const send=(m,type,value)=>{if(active(m))try{m[type]?.(value);}catch{}};
    const drop=()=>{const old=hub.channel;hub.channel=null;hub.ready=false;hub.epoch++;if(old)try{Promise.resolve(client.removeChannel(old)).catch(()=>{});}catch{}};
    const entry={...member,stopped:false};hub.members.add(entry);
    hub.chain=hub.chain.catch(()=>{}).then(async()=>{
      if(!active(entry))return;
      if(hub.channel&&hub.owner===entry.ownerId&&hub.token===entry.accessToken){if(hub.ready)send(entry,'onReady');return;}
      drop();const epoch=hub.epoch;
      await client.realtime.setAuth(entry.accessToken);
      if(epoch!==hub.epoch||!active(entry))return;
      hub.owner=entry.ownerId;hub.token=entry.accessToken;
      const channel=client.channel('sentlog-delta:'+entry.ownerId,{config:{private:true,broadcast:{ack:false,self:false},presence:{enabled:false}}});
      hub.channel=channel;
      channel.on('broadcast',{event:'delta'},message=>{
        if(epoch!==hub.epoch||channel!==hub.channel||message?.event!=='delta')return;
        const v=message.payload;if(!object(v)||!uuid(v.project_id)||!Number.isSafeInteger(v.seq)||v.seq<1)return;
        for(const m of [...hub.members])if(m.ownerId===hub.owner&&m.projectId===v.project_id)
          send(m,'onNotice',{projectId:v.project_id,seq:v.seq});
      }).subscribe(status=>{
        if(epoch!==hub.epoch||channel!==hub.channel)return;
        if(status==='SUBSCRIBED'){hub.ready=true;for(const m of [...hub.members])if(m.ownerId===hub.owner)send(m,'onReady');}
        else if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)){
          const members=[...hub.members];drop();for(const m of members)send(m,'onState',status);
        }
      });
    }).catch(error=>send(entry,'onState',normalize(error)));
    return ()=>{if(stopped)return;stopped=true;entry.stopped=true;hub.members.delete(entry);
      if(![...hub.members].some(m=>active(m)&&m.ownerId===hub.owner))drop();};
  }
  function createSupabaseProvider(client){
    insist(client&&typeof client.rpc==='function'&&client.auth&&
      ['getSession','getUser','onAuthStateChange'].every(k=>typeof client.auth[k]==='function'),
      'DELTA_TRANSPORT_CONFIG','認証付き通信クライアントが必要です');
    return {
      async getSession(){const r=await client.auth.getSession();if(r?.error)throw normalize(r.error);return r?.data?.session||null;},
      async getUser(token){const r=await client.auth.getUser(token);if(r?.error)throw normalize(r.error);return r?.data?.user||null;},
      subscribeAuth(fn){const r=client.auth.onAuthStateChange(fn);return ()=>r?.data?.subscription?.unsubscribe();},
      rpc(name,args,{signal}){let query=client.rpc(name,args);if(typeof query?.abortSignal==='function')query=query.abortSignal(signal);return Promise.resolve(query);},
      subscribe:typeof client.channel==='function'&&typeof client.removeChannel==='function'&&typeof client.realtime?.setAuth==='function'?
        options=>sdkSubscribe(client,options):undefined
    };
  }

  function createRestProvider({url,key,session,refreshSession,subscribeAuth,channelFactory,
    fetch:fetcher=root.fetch,Socket=root.WebSocket,now=()=>Date.now()}={}){
    let origin;try{const parsed=new URL(url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&['','/'].includes(parsed.pathname))origin=parsed.origin;}catch{}
    insist(origin&&typeof key==='string'&&key.length>0&&!/^sb_secret_/.test(key)&&typeof session==='function'&&typeof fetcher==='function',
      'DELTA_TRANSPORT_CONFIG','公開APIキーと正しい同期先が必要です');
    // A legacy service-role JWT is also a server secret, never a browser key.
    try{const parts=key.split('.');if(parts.length===3){const raw=parts[1].replace(/-/g,'+').replace(/_/g,'/');
      const claims=JSON.parse(typeof root.atob==='function'?root.atob(raw):Buffer.from(raw,'base64').toString());
      insist(claims.role!=='service_role','DELTA_TRANSPORT_CONFIG','管理用の秘密キーは端末に渡せません');}}
    catch(e){if(e?.deltaTransport)throw e;}
    let refreshing=null;
    async function current(){
      let s=session();
      if(s?.access_token&&Number.isFinite(s.expires_at)&&s.expires_at<=now()/1000+60){
        if(typeof refreshSession!=='function')throw problem('DELTA_LOGIN_REQUIRED','ログインの有効期限を確認してください',401);
        if(!refreshing)refreshing=Promise.resolve().then(()=>refreshSession()).finally(()=>{refreshing=null;});
        await refreshing;s=session();
      }
      return s;
    }
    async function json(path,{method='GET',token,signal,body}={}){
      const r=await fetcher(origin+path,{method,redirect:'error',credentials:'omit',cache:'no-store',signal,
        headers:{apikey:key,Authorization:'Bearer '+token,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const raw=await r.text();let data=null;
      try{data=raw?JSON.parse(raw):null;}catch{if(r.ok)throw problem('DELTA_SERVER','同期先の応答形式が不正です');}
      return r.ok?{data,error:null,status:r.status}:{data:null,error:object(data)?data:{code:'HTTP_'+r.status},status:r.status};
    }
    const makeChannel=channelFactory||root.SentlogCollaborationChannel?.create||
      (typeof module==='object'&&module.exports?require('./collaboration-channel.js').create:null);
    return {
      getSession:current,peekSession:session,
      async getUser(token,{signal}={}){const r=await json('/auth/v1/user',{token,signal});if(r.error)throw normalize(r.error,r.status);return r.data;},
      ...(typeof subscribeAuth==='function'?{subscribeAuth}:{}),
      rpc(name,args,{accessToken,signal}){
        insist(/^sentlog_delta_[a-z_]+_v1$/.test(name),'DELTA_TRANSPORT_CONFIG','同期APIが不正です');
        return json('/rest/v1/rpc/'+name,{method:'POST',token:accessToken,signal,body:args});
      },
      ...(typeof makeChannel==='function'&&Socket?{subscribe(options){
        const c=makeChannel({url:origin,key,session,enabled:options.active,Socket,topicPrefix:'sentlog-delta',
          onReady:options.onReady,onState:options.onState,
          onChange:notice=>{if(notice?.kind==='delta'&&notice.projectId===options.projectId)options.onNotice(notice);}});
        c.wake();return ()=>c.stop();
      }}:{})
    };
  }

  function createTransport({provider,client,scope:inputScope,currentScope,online:network=()=>root.navigator?.onLine!==false,
    onStatus=()=>{},requestTimeoutMs=15000,retryMs=1000,timers={setTimeout:(f,n)=>setTimeout(f,n),clearTimeout:t=>clearTimeout(t)}}={}){
    const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,inputScope?.[k]])));
    provider=provider||(client?createSupabaseProvider(client):null);
    insist(CORE&&SCOPE.every(k=>uuid(scope[k]))&&typeof currentScope==='function'&&typeof network==='function'&&provider&&
      ['getSession','getUser','rpc'].every(k=>typeof provider[k]==='function')&&
      (typeof provider.peekSession==='function'||typeof provider.subscribeAuth==='function'),
      'DELTA_TRANSPORT_CONFIG','利用者・案件・登録端末と認証方法が必要です');
    insist(Number.isSafeInteger(requestTimeoutMs)&&requestTimeoutMs>0&&Number.isSafeInteger(retryMs)&&retryMs>0,
      'DELTA_TRANSPORT_CONFIG','通信の待機時間が不正です');
    let closed=false,generation=0,observed=null,verified=null,serverCapabilities=null,live=null,liveToken=null,realtimeConnected=false,
      wakeTimer=null,connecting=false,failures=0;
    const listeners=new Set(),pending=new Set();
    const emit=value=>{if(!closed)try{onStatus({...value,scope:copy(scope)});}catch{}};
    const notice=value=>{if(!closed)for(const fn of [...listeners])try{fn({...value,projectId:scope.projectId});}catch{}};
    const scopeOkay=()=>{try{return sameScope(scope,currentScope());}catch{return false;}};
    function active(){insist(!closed,'DELTA_CLOSED','この通信処理は終了しています');
      if(!scopeOkay()){serverCapabilities=null;throw problem('DELTA_SCOPE','利用者・案件・端末が変わりました。内容は元の保存先に残しています');}}
    const sessionIdentity=s=>s?.access_token&&s?.user?.id?{token:s.access_token,owner:s.user.id}:null;
    const sameAuth=(a,b)=>a?.token===b?.token&&a?.owner===b?.owner;
    function stopLive(){const old=live;live=null;liveToken=null;realtimeConnected=false;if(old)try{old();}catch{}}
    function observe(s){
      const value=sessionIdentity(s);if(sameAuth(observed,value))return;
      if(observed?.owner!==value?.owner)serverCapabilities=null;
      observed=value;verified=null;generation++;stopLive();
      for(const p of [...pending])if(p.phase!=='session')p.cancel(problem('DELTA_AUTH_CHANGED','ログイン状態が変わりました。未送信の内容は保持しています',401));
    }
    function fresh(auth){
      active();
      if(typeof provider.peekSession==='function')observe(provider.peekSession());
      insist(auth&&auth.generation===generation&&sameAuth(auth,observed),'DELTA_AUTH_CHANGED','ログイン状態が変わりました。内容は保持しています');
    }
    async function authenticate(signal,ticket){
      active();if(signal.aborted)throw problem('DELTA_ABORTED','通信を中止しました');
      const before=generation,s=await provider.getSession();active();
      if(signal.aborted)throw problem('DELTA_ABORTED','通信を中止しました');
      const value=sessionIdentity(s);
      if(before!==generation&&!sameAuth(value,observed))throw problem('DELTA_AUTH_CHANGED','ログイン状態が変わりました。内容は保持しています',401);
      if(!(value&&typeof value.token==='string'&&value.token.length>0))throw problem('DELTA_LOGIN_REQUIRED','ログインが必要です',401);
      insist(value.owner===scope.ownerId,'DELTA_SCOPE','別の利用者の認証では同期できません');observe(s);
      if(verified){fresh(verified);return verified;}
      if(ticket)ticket.phase='verify';
      const auth={...value,generation};
      const user=await provider.getUser(auth.token,{signal});fresh(auth);
      if(signal.aborted)throw problem('DELTA_ABORTED','通信を中止しました');
      insist(user?.id===scope.ownerId,'DELTA_SCOPE','認証された利用者と案件の所有者が一致しません');
      verified=auth;failures=0;return auth;
    }
    function request(action,{signal}={}){
      let controller,timer,abortExternal,ticket;
      try{active();if(signal?.aborted)throw problem('DELTA_ABORTED','通信を中止しました');controller=new AbortController();}
      catch(error){return Promise.reject(error);}
      const cancelled=new Promise((resolve,reject)=>{
        ticket={phase:'session',cancel(error){controller.abort();reject(error);}};pending.add(ticket);
        abortExternal=()=>ticket.cancel(problem('DELTA_ABORTED','通信を中止しました'));signal?.addEventListener('abort',abortExternal,{once:true});
        timer=timers.setTimeout(()=>ticket.cancel(problem('DELTA_TIMEOUT','通信が時間内に完了しませんでした。内容は保持しています',408,true)),requestTimeoutMs);
      });
      const work=Promise.resolve().then(()=>action(controller.signal,ticket));
      return Promise.race([work,cancelled]).catch(error=>{throw normalize(error);}).finally(()=>{
        timers.clearTimeout(timer);signal?.removeEventListener('abort',abortExternal);pending.delete(ticket);
      });
    }
    async function rpc(name,args,validate,options){
      const saved=copy(args);
      return request(async(signal,ticket)=>{
        const auth=await authenticate(signal,ticket);fresh(auth);ticket.phase='rpc';
        const r=await provider.rpc(name,saved,{accessToken:auth.token,signal});fresh(auth);
        if(signal.aborted)throw problem('DELTA_ABORTED','通信を中止しました');
        if(r?.error)throw normalize(r.error,r.status);
        insist(object(r)&&Object.prototype.hasOwnProperty.call(r,'data'),'DELTA_SERVER','同期先の応答を確認できません');
        const result=copy(r.data);validate(result);return result;
      },options);
    }
    function connect(){
      if(closed||connecting||!listeners.size||!scopeOkay()||!network())return;
      connecting=true;
      request((signal,ticket)=>authenticate(signal,ticket)).then(auth=>{
        fresh(auth);if(!listeners.size)return;
        if(live&&liveToken===auth.token)return;
        stopLive();liveToken=auth.token;
        const valid=()=>{try{fresh(auth);return !!verified&&listeners.size>0;}catch{return false;}};
        if(typeof provider.subscribe==='function')live=provider.subscribe({ownerId:scope.ownerId,projectId:scope.projectId,accessToken:auth.token,active:valid,
          onReady(){if(!valid())return;realtimeConnected=true;failures=0;notice({reason:'connected'});emit({level:'ready',realtime:true});},
          onNotice(value){if(valid()&&value?.projectId===scope.projectId&&Number.isSafeInteger(value.seq)&&value.seq>0)notice({seq:value.seq});},
          onState(){if(!valid())return;stopLive();emit({level:'polling',realtime:false});scheduleConnect();}});
        notice({reason:'authenticated'});emit({level:'ready',realtime:realtimeConnected});
      }).catch(error=>{
        if(closed)return;emit({level:'warning',code:error.code,message:error.message,realtime:false});
        if(error.retryable||error.code==='DELTA_AUTH_CHANGED')scheduleConnect();
      }).finally(()=>{connecting=false;});
    }
    function scheduleConnect(){
      if(closed||wakeTimer!==null||!listeners.size||!scopeOkay()||!network())return;
      const delay=Math.min(30000,retryMs*2**Math.min(failures++,5));
      wakeTimer=timers.setTimeout(()=>{wakeTimer=null;connect();},delay);wakeTimer?.unref?.();
    }
    const unsubscribeAuth=typeof provider.subscribeAuth==='function'?provider.subscribeAuth((event,s)=>{
      // No awaited SDK call while its auth-state callback holds the auth lock.
      if(closed)return;observe(s);emit({level:s?.user?.id===scope.ownerId?'auth-changing':'signed-out',realtime:false});
      if(s?.user?.id===scope.ownerId)scheduleConnect();
    }):null;
    function receipt(r,expectedId){
      insist(object(r)&&r.schema===1&&r.ownerId===scope.ownerId&&r.projectId===scope.projectId&&uuid(r.baselineId)&&
        (!expectedId||r.baselineId===expectedId)&&Number.isSafeInteger(r.snapshotRevision)&&r.snapshotRevision>=1&&r.cursor===0&&
        count(r.recordCount)&&count(r.importedCount)&&r.importedCount<=r.recordCount&&digest(r.snapshotSha256)&&digest(r.manifestSha256)&&
        r.hashFormat==='postgres-jsonb-text-sha256-v1'&&['prepared','importing','verified','active'].includes(r.state)&&
        typeof r.deltaEnabled==='boolean'&&r.deviceMigrationVerified===false&&r.assetDeliveryVerified===false,
        'DELTA_SERVER','初期データの受領情報が一致しません');
      if(['verified','active'].includes(r.state))insist(r.importedCount===r.recordCount,'DELTA_SERVER','初期データの検査が完了していません');
    }
    function baselineId(value){insist(uuid(value),'DELTA_BASELINE_ID','初期データの識別情報が不正です');}
    function page(after,limit,max=100){insist(count(after)&&Number.isSafeInteger(limit)&&limit>=1&&limit<=max,'DELTA_PAGE','取得する範囲が不正です');}
    const base=()=>({p_project_id:scope.projectId,p_device_id:scope.deviceId});
    function getCapabilities(){
      try{
        if(closed||!scopeOkay()){serverCapabilities=null;return {atomicGroups:false};}
        if(typeof provider.peekSession==='function')observe(provider.peekSession());
        if(observed?.owner!==scope.ownerId||!serverCapabilities||typeof CORE.validateGroup!=='function')return {atomicGroups:false};
        return copy(serverCapabilities);
      }catch{return {atomicGroups:false};}
    }
    function baselinePage(kind,baseline,after,limit,options){
      baselineId(baseline);page(after,limit);
      return rpc(kind==='records'?'sentlog_delta_read_baseline_page_v1':'sentlog_delta_read_baseline_metadata_page_v1',
        {...base(),p_baseline_id:baseline,p_after:after,p_limit:limit},r=>{
          insist(object(r),'DELTA_SERVER','初期データのページが不正です');receipt(r.receipt,baseline);
          const total=kind==='records'?r.receipt.recordCount:r.receipt.metadataCount;
          insist(count(total)&&Array.isArray(r[kind])&&r[kind].length<=limit&&count(r.nextOrdinal)&&
            r.nextOrdinal===after+r[kind].length&&r.nextOrdinal<=total&&typeof r.hasMore==='boolean'&&r.hasMore===(r.nextOrdinal<total)&&
            (r[kind].length>0||!r.hasMore),'DELTA_SERVER','初期データの順序または終端が一致しません');
          r[kind].forEach((entry,i)=>{
            insist(object(entry)&&entry.ordinal===after+i+1&&digest(entry.sha256)&&typeof entry.manifestEntryJson==='string',
              'DELTA_SERVER','初期データの順序または照合情報が不正です');
            if(kind==='records')insist(id(entry.drawingId)&&id(entry.recordId)&&typeof entry.recordJson==='string','DELTA_SERVER','記録のページが不正です');
            else insist(id(entry.kind)&&id(entry.key)&&typeof entry.metadataJson==='string','DELTA_SERVER','図面情報のページが不正です');
          });
        },options);
    }
    return {
      getScope:()=>copy(scope),
      getCapabilities,
      inspect(options){
        return rpc('sentlog_delta_inspect_v1',base(),r=>{
          insist(object(r)&&r.schema===1&&SCOPE.every(k=>r[k]===scope[k])&&typeof r.enabled==='boolean'&&
            typeof r.canActivate==='boolean'&&count(r.headSeq)&&typeof r.checking==='boolean'&&
            (r.snapshotRevision===undefined||r.snapshotRevision===null||Number.isSafeInteger(r.snapshotRevision)&&r.snapshotRevision>=1),
            'DELTA_SERVER','案件の保存方式を確認できません');
          if(r.enabled){receipt(r.baseline);insist(r.baseline.state==='active','DELTA_SERVER','初期基準の切替状態が一致しません');}
          else insist(r.baseline===null||object(r.baseline),'DELTA_SERVER','初期基準の情報が不正です');
        },options);
      },
      activateBaseline(baseline,proof,options){
        baselineId(baseline);
        insist(object(proof)&&id(proof.migrationId)&&/^[a-f0-9]{64}$/.test(proof.sourceFingerprint||'')&&
          /^[a-f0-9]{64}$/.test(proof.planSha256||'')&&proof.writerVersion===2,
          'DELTA_MIGRATION_REQUIRED','旧保存の控えと新しい保存処理の確認が必要です');
        return rpc('sentlog_delta_activate_baseline_v1',{...base(),p_baseline_id:baseline,p_proof:copy(proof)},r=>{
          receipt(r,baseline);insist(r.state==='active'&&r.deltaEnabled===true,'DELTA_SERVER','案件の切替結果を確認できません');
        },options);
      },
      publishCheckpoint(expectedHead,requestId,options){
        insist(count(expectedHead)&&id(requestId),'DELTA_CHECKPOINT','保管用の版と確認番号が不正です');
        return rpc('sentlog_delta_publish_checkpoint_v1',{...base(),p_expected_head:expectedHead,p_request_id:requestId},r=>{
          insist(object(r)&&r.schema===1&&r.projectId===scope.projectId&&r.headSeq===expectedHead&&
            Number.isSafeInteger(r.revision)&&r.revision>=1&&/^[a-f0-9]{64}$/.test(r.payloadSha256||'')&&
            object(r.payload?.project)&&Array.isArray(r.payload?.drawings),
            'DELTA_CHECKPOINT','PC保管用の記録を確認できません');
        },options);
      },
      async ready(options){
        try{
          await rpc('sentlog_delta_capabilities_v1',base(),r=>{
            insist(object(r)&&r.schema===2&&SCOPE.every(k=>r[k]===scope[k])&&r.atomicGroups===true&&
              r.groupMaxEvents===500&&r.groupMaxBytes===4194304&&r.pageTargetBytes===900000,
              'DELTA_UPGRADE_REQUIRED','一括変更に対応した同期先を確認できません');
            serverCapabilities={atomicGroups:true,groupMaxEvents:r.groupMaxEvents,groupMaxBytes:r.groupMaxBytes,pageTargetBytes:r.pageTargetBytes,
              ...(r.sharedMetadata===true?{sharedMetadata:true}:{}),...(r.certifiedArchive===true?{certifiedArchive:true}:{}),
              ...(r.writerJournal===2?{writerJournal:2}:{})};
          },options);
          fresh(verified);return {authenticated:true,scope:copy(scope)};
        }catch(error){
          // A temporary outage leaves an already confirmed offline feature
          // available. An explicit denial or incompatible server revokes it.
          if(!error.retryable&&!['DELTA_ABORTED','DELTA_AUTH_CHANGED'].includes(error.code))serverCapabilities=null;
          throw error;
        }
      },
      online(){if(closed||!scopeOkay()||!network())return false;try{if(verified){fresh(verified);return true;}}catch{}
        scheduleConnect();return false;},
      push(event,options){
        // Validate before JSON cloning so File/Blob, functions and non-JSON
        // properties cannot disappear silently during serialization.
        CORE.validateEvent(event);const e=copy(event);
        insist(e.projectId===scope.projectId&&e.deviceId===scope.deviceId,'DELTA_SCOPE','別案件・端末の変更は送信できません');
        return rpc('sentlog_delta_append_v1',{...base(),p_event_id:e.eventId,p_drawing_id:e.drawingId,p_record_id:e.recordId,p_envelope:e},r=>{
          insist(object(r)&&Number.isSafeInteger(r.seq)&&r.seq>=1&&typeof r.duplicate==='boolean'&&
            ['projectId','eventId','deviceId','drawingId','recordId'].every(k=>r[k]===e[k]),'DELTA_NOT_DURABLE','この変更のサーバー保存を確認できません');
        },options);
      },
      pushGroup(group,options){
        insist(getCapabilities().atomicGroups,'DELTA_UPGRADE_REQUIRED','一括変更に対応した同期先の確認が必要です');
        CORE.validateGroup(group);const g=copy(group);
        insist(g.projectId===scope.projectId&&g.deviceId===scope.deviceId,'DELTA_SCOPE','別案件・端末の一括変更は送信できません');
        return rpc('sentlog_delta_append_group_v1',{...base(),p_group:g},r=>{
          insist(object(r)&&r.schema===1&&r.groupId===g.groupId&&r.projectId===g.projectId&&r.deviceId===g.deviceId&&
            Number.isSafeInteger(r.startSeq)&&r.startSeq>=1&&Number.isSafeInteger(r.endSeq)&&r.endSeq===r.startSeq+g.events.length-1&&
            typeof r.duplicate==='boolean'&&Array.isArray(r.events)&&r.events.length===g.events.length&&r.events.every((row,i)=>
              object(row)&&row.seq===r.startSeq+i&&['projectId','eventId','deviceId','drawingId','recordId'].every(k=>row[k]===g.events[i][k])),
            'DELTA_NOT_DURABLE','一括変更全体のサーバー保存を確認できません');
        },options);
      },
      async list(projectId,after,limit,options){
        insist(projectId===scope.projectId,'DELTA_SCOPE','別案件の変更は取得できません');page(after,limit,500);
        const r=await rpc('sentlog_delta_list_groups_v1',{...base(),p_after:after,p_limit:limit},value=>{
          insist(object(value)&&value.schema===2&&SCOPE.every(k=>value[k]===scope[k])&&value.after===after&&count(value.headSeq)&&value.headSeq>=after&&
            Array.isArray(value.events)&&value.events.length<=limit&&typeof value.hasMore==='boolean',
            'DELTA_SERVER','差分の受領情報が一致しません');
          let last=after;
          value.events.forEach(row=>{
            insist(object(row)&&row.seq===last+1&&row.seq<=value.headSeq,'DELTA_SEQUENCE_GAP','未受信の変更があります。同期位置は進めません');
            if(Object.prototype.hasOwnProperty.call(row,'group')){
              insist(typeof CORE.validateGroup==='function','DELTA_UPGRADE_REQUIRED','一括変更を受け取るためにアプリの更新が必要です');
              CORE.validateGroup(row.group);
              insist(!Object.prototype.hasOwnProperty.call(row,'event')&&row.group.projectId===scope.projectId&&uuid(row.group.deviceId)&&
                Number.isSafeInteger(row.endSeq)&&row.endSeq===row.seq+row.group.events.length-1&&row.endSeq<=value.headSeq,
                'DELTA_SEQUENCE_GAP','一括変更の範囲が一致しません。同期位置は進めません');
              last=row.endSeq;
            }else{
              insist(!Object.prototype.hasOwnProperty.call(row,'endSeq')&&row.event?.projectId===scope.projectId,
                'DELTA_SEQUENCE_GAP','差分の範囲または案件が一致しません');CORE.validateEvent(row.event);last=row.seq;
            }
          });
          insist(value.hasMore===(last<value.headSeq)&&(value.events.length>0||!value.hasMore),'DELTA_SERVER','差分の終端が一致しません');
        },options);
        const rows=r.events;Object.defineProperties(rows,{hasMore:{value:r.hasMore},headSeq:{value:r.headSeq}});return rows;
      },
      prepareBaseline(expectedRevision,options){
        insist(Number.isSafeInteger(expectedRevision)&&expectedRevision>=1,'DELTA_BASELINE_REVISION','サーバーの版が不正です');
        return rpc('sentlog_delta_prepare_baseline_v1',{...base(),p_expected_revision:expectedRevision},r=>{
          receipt(r);insist(r.snapshotRevision===expectedRevision,'DELTA_SERVER','初期データの版が一致しません');
        },options);
      },
      importBaselineBatch(baseline,limit=100,options){baselineId(baseline);page(0,limit);return rpc('sentlog_delta_import_baseline_batch_v1',
        {...base(),p_baseline_id:baseline,p_limit:limit},r=>receipt(r,baseline),options);},
      readBaselinePage:(baseline,after=0,limit=100,options)=>baselinePage('records',baseline,after,limit,options),
      readBaselineMetadataPage:(baseline,after=0,limit=100,options)=>baselinePage('metadata',baseline,after,limit,options),
      subscribe(projectId,fn){active();insist(projectId===scope.projectId&&typeof fn==='function','DELTA_SCOPE','通知する案件が一致しません');
        listeners.add(fn);connect();return ()=>{listeners.delete(fn);if(!listeners.size)stopLive();};},
      wake(){active();if(typeof provider.peekSession==='function')observe(provider.peekSession());
        if(wakeTimer!==null){timers.clearTimeout(wakeTimer);wakeTimer=null;}connect();},
      getStatus(){let authenticated=false;try{if(verified){fresh(verified);authenticated=true;}}catch{}
        return {closed,authenticated,realtimeConnected:authenticated&&realtimeConnected,scope:copy(scope)};},
      close(){if(closed)return;closed=true;generation++;verified=null;serverCapabilities=null;stopLive();listeners.clear();
        if(wakeTimer!==null)timers.clearTimeout(wakeTimer);wakeTimer=null;
        try{unsubscribeAuth?.();}catch{}
        for(const p of [...pending])p.cancel(problem('DELTA_CLOSED','この通信処理は終了しています'));
      }
    };
  }
  const api={version:1,createTransport,createRestProvider,createSupabaseProvider};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaTransport=api;
})(typeof window!=='undefined'?window:globalThis);
