/* Experimental handover coordinator. NOT loaded by the production app.
 * Copies and verifies legacy data, reconciles a server-owned baseline and
 * installs one atomic local seed. It never activates a server baseline,
 * replaces the application's writer, deletes old data or certifies files.
 * install() requires the application to supply a persistent legacy-writer
 * fence. A one-time recheck or a held in-memory boolean is not that fence.
 */
(function(root){
  'use strict';
  const R=root.SentlogDeltaReconcile||(typeof module==='object'&&module.exports?require('./delta-sync-reconcile.js'):null);
  const fields=['ownerId','projectId','deviceId'],copy=x=>root.structuredClone(x);
  const valid=x=>typeof x==='string'&&x.length>0&&x.length<=512;
  const same=(a,b)=>a&&b&&fields.every(k=>a[k]===b[k]);
  function error(code,message){return Object.assign(Error(message),{code});}
  function insist(ok,code,message){if(!ok)throw error(code,message);}
  function createCoordinator({source,migration,replicaStore,transport,localProjectId,currentScope,onProgress=()=>{},timeoutMs=30000}={}){
    insist(R&&source?.recheck&&migration?.stage&&migration?.readCopy&&replicaStore?.installBaseline&&
      replicaStore?.getScope&&transport?.readBaselinePage&&transport?.readBaselineMetadataPage&&
      valid(localProjectId)&&typeof currentScope==='function'&&Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,
      'BOOTSTRAP_CONFIG','引き継ぎ元・保存先・照合方法を確認できません');
    const scope=copy(replicaStore.getScope());
    insist(fields.every(k=>valid(scope[k])),'BOOTSTRAP_SCOPE','引き継ぐ利用者・案件・端末が不正です');
    let closed=false,flight=null;
    function check(signal,fence){
      insist(!closed,'BOOTSTRAP_CLOSED','引き継ぎ処理を終了しました');
      insist(!signal?.aborted,'BOOTSTRAP_ABORTED','引き継ぎ処理を中止しました');
      insist(same(scope,currentScope())&&same(scope,replicaStore.getScope()),'BOOTSTRAP_SCOPE',
        '処理中に利用者・案件・端末が変わりました。記録の上書きを止めました');
      if(fence){
        const result=fence({scope:copy(scope),localProjectId});
        insist(result!==false&&!(result&&typeof result.then==='function'),'BOOTSTRAP_FENCE',
          '旧版からの書き込みが停止していることを確認できません');
      }
    }
    function progress(status,detail={}){
      try{onProgress({status,...detail,readyForActivation:false,readyForCloudSync:false});}catch{/* UI cannot undo a saved copy. */}
    }
    function run(task,externalSignal){
      check(externalSignal);insist(!flight,'BOOTSTRAP_BUSY','この画面では既に引き継ぎを進めています');
      const controller=new AbortController(),externalAbort=()=>controller.abort();
      externalSignal?.addEventListener('abort',externalAbort,{once:true});
      const token={controller};flight=token;
      const signal=controller.signal;
      function wait(promise,fence){
        return new Promise((resolve,reject)=>{
          let done=false,timer;
          const finish=(reason,value)=>{
            if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
            if(reason){reject(reason);return;}
            try{check(signal,fence);resolve(value);}catch(e){reject(e);}
          };
          const abort=()=>finish(error(closed?'BOOTSTRAP_CLOSED':'BOOTSTRAP_ABORTED','引き継ぎ処理を中止しました'));
          signal.addEventListener('abort',abort,{once:true});
          timer=setTimeout(()=>{finish(error('BOOTSTRAP_TIMEOUT','引き継ぎの応答を確認できません。元の記録と控えを保持しています'));controller.abort();},timeoutMs);
          Promise.resolve(promise).then(v=>finish(null,v),e=>finish(e));
          if(signal.aborted)abort();
        });
      }
      return Promise.resolve().then(()=>{check(signal);return task({signal,wait});}).finally(()=>{
        externalSignal?.removeEventListener('abort',externalAbort);if(flight===token)flight=null;
      });
    }
    async function baseline(receipt,ctx,fence){
      check(ctx.signal,fence);
      insist(receipt?.clientProjectId===localProjectId,'BOOTSTRAP_BINDING','端末とサーバーの案件の対応が一致しません');
      const options={signal:ctx.signal};
      return ctx.wait(R.readBaseline({receipt,scope,currentScope,signal:ctx.signal,
        readPage:(after,limit)=>transport.readBaselinePage(receipt.baselineId,after,limit,options),
        readMetadataPage:(after,limit)=>transport.readBaselineMetadataPage(receipt.baselineId,after,limit,options)}),fence);
    }
    function prepare({migrationId,receipt,signal}={}){
      insist(valid(migrationId),'BOOTSTRAP_ID','移行番号が必要です');const captured=copy(receipt);
      return run(async ctx=>{
        progress('copying');const copied=await ctx.wait(migration.stage(migrationId));
        insist(copied?.localProjectId===localProjectId&&same(copied.scope,scope),'BOOTSTRAP_SCOPE','別の案件の移行控えは使用できません');
        const local=await ctx.wait(migration.readCopy(migrationId));
        const initial=await baseline(captured,ctx);
        progress('reconciling');const plan=await ctx.wait(R.plan({scope,baseline:initial,localSnapshot:local.snapshot,currentScope,signal:ctx.signal}));
        const fresh=await ctx.wait(source.recheck(local.snapshot));
        const sourceUnchanged=fresh?.unchanged===true&&fresh.expectedFingerprint===plan.sourceFingerprint&&fresh.actualFingerprint===plan.sourceFingerprint;
        const ready=copied.status==='verified-copy'&&local.status==='verified-copy'&&sourceUnchanged&&plan.readyForInstall;
        const status=ready?'prepared':'needs-review';progress(status,{pending:plan.state.outbox.length,sourceUnchanged});
        return {version:1,status,migrationId,plan,sourceUnchanged,readyForInstall:ready,
          readyForActivation:false,readyForCloudSync:false};
      },signal);
    }
    function install({migrationId,plan,assertLegacyWritesBlocked,signal}={}){
      insist(valid(migrationId),'BOOTSTRAP_ID','移行番号が必要です');
      insist(typeof assertLegacyWritesBlocked==='function','BOOTSTRAP_FENCE',
        '旧版の全保存経路を継続して停止する仕組みが必要です');
      const candidate=copy(plan),fence=assertLegacyWritesBlocked;
      return run(async ctx=>{
        const verify=()=>check(ctx.signal,fence);verify();
        await ctx.wait(R.verifyPlan(candidate,{scope,currentScope,signal:ctx.signal}),fence);
        insist(candidate.readyForInstall===true,'BOOTSTRAP_REVIEW','確認待ちの内容を保護しています。引き継ぎはまだ確定できません');
        insist(candidate.localProjectId===localProjectId,'BOOTSTRAP_BINDING','別の端末案件の保存予定です');
        insist(candidate.baselineReceipt.state==='active'&&candidate.baselineReceipt.deltaEnabled===true,
          'BOOTSTRAP_BASELINE_INACTIVE','サーバーの初期基準はまだ切り替わっていません。旧保存と控えを保持しています');
        const local=await ctx.wait(migration.readCopy(migrationId),fence);
        insist(local.status==='verified-copy'&&local.snapshot.fingerprint===candidate.sourceFingerprint,
          'BOOTSTRAP_SOURCE_CHANGED','引き継ぐ控えと照合した旧保存が一致しません');
        // Re-read authoritative bytes and recompute the plan. A saved plan hash
        // alone is not permission to install an edited or obsolete candidate.
        const initial=await baseline(candidate.baselineReceipt,ctx,fence);
        const rebuilt=await ctx.wait(R.plan({scope,baseline:initial,localSnapshot:local.snapshot,currentScope,signal:ctx.signal}),fence);
        insist(rebuilt.planSha256===candidate.planSha256&&rebuilt.readyForInstall,'BOOTSTRAP_PLAN_CHANGED',
          '引き継ぐ内容が照合時から変わっています。上書きを止めました');
        const fresh=await ctx.wait(source.recheck(local.snapshot),fence);
        insist(fresh?.unchanged===true&&fresh.expectedFingerprint===candidate.sourceFingerprint&&fresh.actualFingerprint===candidate.sourceFingerprint,
          'BOOTSTRAP_SOURCE_CHANGED','旧保存が更新されました。最新の内容を残して引き継ぎを中断しました');verify();
        progress('installing');
        const installed=await ctx.wait(replicaStore.installBaseline({state:candidate.state,baseline:candidate.baselineReceipt,
          source:{migrationId,localProjectId,fingerprint:candidate.sourceFingerprint},planSha256:candidate.planSha256,
          metadata:candidate.metadata,validate:verify,signal:ctx.signal}),fence);
        progress('installed',{idempotent:installed.idempotent,pending:installed.state.outbox.length});
        return {version:1,status:'installed',migrationId,...installed,localSeedVerified:true,
          readyForActivation:false,readyForCloudSync:false,assetDeliveryVerified:false};
      },signal);
    }
    return {prepare,install,getScope:()=>copy(scope),close(){if(closed)return;closed=true;flight?.controller.abort();}};
  }
  const api={version:1,createCoordinator};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaBootstrap=api;
})(typeof window!=='undefined'?window:globalThis);
