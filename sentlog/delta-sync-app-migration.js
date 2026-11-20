/* Durable application handover. The server baseline is immutable; all local
 * records and photo bytes are copied and verified before activating a writer.
 */
(function(root){
  'use strict';
  const req=n=>typeof module==='object'&&module.exports?require('./'+n+'.js'):null;
  const L=root.SentlogDeltaLegacySource||req('delta-sync-legacy-source');
  const M=root.SentlogDeltaMigration||req('delta-sync-migration');
  const B=root.SentlogDeltaBootstrap||req('delta-sync-bootstrap');
  const D=root.SentlogDeltaSyncCore||req('delta-sync-core');
  const META=root.SentlogDeltaMetadata||req('delta-sync-metadata');
  const SCOPE=['ownerId','projectId','deviceId'];
  const same=(a,b)=>a&&b&&SCOPE.every(k=>a[k]===b[k]);
  const fail=(code,message)=>Object.assign(Error(message),{code});
  function insist(ok,code,message){if(!ok)throw fail(code,message);}
  function createInstaller({records,onProgress=()=>{},factories={}}={}){
    insist(records?.deltaJournal,'DELTA_MIGRATION_WRITER','変更を保護する保存処理が必要です');
    const make={source:L.createSource,migrationStore:M.createStore,migration:M.createCoordinator,bootstrap:B.createCoordinator,...factories};
    return async function install({scope,localProjectId,transport,store,mode,revision,currentScope,actor}={}){
      const validate=()=>insist(same(scope,currentScope()),'DELTA_MIGRATION_SCOPE','引継ぎ中にログインまたは案件が変わりました');
      validate();await records.settled();records.assertSafe();validate();
      const staged=await records.deltaJournal.begin({scope,localProjectId,actor,
        serverRevision:revision??mode.snapshotRevision??mode.baseline?.snapshotRevision});validate();
      const existing=await store.readProvenance();validate();
      if(existing){
        insist(existing.baseline?.projectId===scope.projectId&&existing.baseline?.clientProjectId===localProjectId,
          'DELTA_MIGRATION_BINDING','保存済みの引継ぎ先が一致しません');
        const state=await store.read();validate();D.validateState(state,scope);
        const projection=await META.project({records:state.records,template:staged.snapshot,localProjectId});validate();
        await records.deltaJournal.activate({scope,localProjectId,baselineId:existing.baseline.baselineId,
          metadataRecords:projection.metadataRecords,baselineSnapshot:projection,proof:existing.source});validate();return {resumed:true};
      }
      const migrationId='app:'+root.crypto.randomUUID();
      const rawSource=make.source({journal:records.deltaJournal});
      const source={capture:projectId=>rawSource.capture(projectId,{recordCutoff:staged}),
        recheck:snapshot=>rawSource.recheck(snapshot),close:()=>rawSource.close()};
      const migrationStore=make.migrationStore(scope);
      const migration=make.migration({source,store:migrationStore,localProjectId,currentScope,onProgress});
      const bootstrap=make.bootstrap({source,migration,replicaStore:store,transport,localProjectId,currentScope,onProgress,timeoutMs:300000});
      try{
        let receipt=mode.baseline||await transport.prepareBaseline(mode.snapshotRevision??revision??staged.serverRevision);validate();
        while(receipt.state==='prepared'||receipt.importedCount<receipt.recordCount){
          const before=receipt.importedCount;
          receipt=await transport.importBaselineBatch(receipt.baselineId,100);validate();
          insist(receipt.importedCount>before||receipt.state==='verified'||receipt.state==='active',
            'DELTA_MIGRATION_PROGRESS','初期記録の検証が進んでいません。保存済みの内容を保持しています');
        }
        let prepared=await bootstrap.prepare({migrationId,receipt});validate();
        insist(prepared.readyForInstall,'DELTA_MIGRATION_REVIEW',prepared.plan?.reviewItems?.filter(x=>x.blocking).map(x=>x.message).join(' / ')||
          'コピー中に入力が更新されました。元の記録を保持し、最新の内容で引継ぎを再試行します');
        const assertFence=()=>{validate();return records.deltaJournal.assertFence({scope,localProjectId});};
        assertFence();
        if(!mode.enabled){
          receipt=await transport.activateBaseline(receipt.baselineId,{migrationId,sourceFingerprint:prepared.plan.sourceFingerprint,
            planSha256:prepared.plan.planSha256,writerVersion:2});validate();
          prepared=await bootstrap.prepare({migrationId,receipt});validate();
          insist(prepared.readyForInstall,'DELTA_MIGRATION_RETRY','切替中の入力を保持しています。最新の内容を再照合します');
        }
        const installed=await bootstrap.install({migrationId,plan:prepared.plan,assertLegacyWritesBlocked:assertFence});validate();
        const projection=await META.project({records:installed.state.records,template:staged.snapshot,localProjectId});validate();
        await records.deltaJournal.activate({scope,localProjectId,baselineId:receipt.baselineId,
          metadataRecords:projection.metadataRecords,baselineSnapshot:projection,
          proof:{migrationId,sourceFingerprint:prepared.plan.sourceFingerprint,planSha256:prepared.plan.planSha256}});validate();
        return {installed:true,baselineId:receipt.baselineId,pending:installed.state.outbox.length};
      }finally{bootstrap.close();migration.close();source.close();}
    };
  }
  const api={version:1,createInstaller};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaAppMigration=api;
})(typeof window!=='undefined'?window:globalThis);
