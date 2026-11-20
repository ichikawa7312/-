/* Durable editor replay. The legacy canvas and the replica are NOT dual-written:
 * the canvas transaction first records an immutable WAL intent in its own DB;
 * this controller retries that intent using stable revision/event IDs, checks
 * the actual replica store, and only then acknowledges it. */
(function(root){
  'use strict';
  const B=root.SentlogDeltaAppBridge||(typeof module==='object'&&module.exports?require('./delta-sync-app-bridge.js'):null);
  const D=root.SentlogDeltaSyncCore||(typeof module==='object'&&module.exports?require('./delta-sync-core.js'):null);
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:',SCOPE=['ownerId','projectId','deviceId'];
  const copy=value=>root.structuredClone(value),sameScope=(a,b)=>a&&b&&SCOPE.every(k=>a[k]===b[k]);
  function problem(code,message){return Object.assign(Error(message),{code});}
  function insist(ok,code,message){if(!ok)throw problem(code,message);}
  function createController({records,scope:inputScope,localProjectId,replica,replicaStore,bridge,metadata,
    currentScope,onStatus=()=>{},applyProjection,afterReplicaCommit}={}){
    const scope=Object.freeze(Object.fromEntries(SCOPE.map(k=>[k,inputScope?.[k]]))),journal=records?.deltaJournal;
    insist(B&&D&&scope.projectId&&journal?.version===1&&typeof journal.claim==='function'&&
      typeof replicaStore?.read==='function'&&typeof replica?.snapshotWithStatus==='function'&&typeof replica?.isSnapshotCurrent==='function'&&
      typeof currentScope==='function'&&typeof localProjectId==='string',
      'JOURNAL_CONFIG','変更履歴を再開する保存先と共有先を確認できません');
    const ownBridge=!bridge;bridge=bridge||B.createBridge({replica,scope,localProjectId,currentScope,metadata});
    let closed=false,flight=null,projectFlight=null,lastClaim=null,acknowledged=0;
    let view={phase:'idle',pendingIntents:0,acknowledged:0,lastError:null,deferred:false};
    function active(){insist(!closed,'JOURNAL_CLOSED','この案件の保存接続は終了しています');
      insist(sameScope(scope,currentScope()),'JOURNAL_SCOPE','利用者・案件・端末が切り替わりました');
      journal.assertFence({scope,localProjectId});}
    function status(change){if(change){view={...view,...change};try{onStatus(copy({...view,scope,localProjectId}));}catch{}}
      return copy({...view,scope,localProjectId});}
    function observedSnapshot(){
      try{return B.captureProject({records,localProjectId});}
      catch(error){const binding=journal.bindingFor(localProjectId),fallback=binding?.replayBaseline?.after||binding?.cutoff?.snapshot;
        if(!fallback)throw error;return copy(fallback);}
    }
    async function project(){
      active();if(projectFlight)return projectFlight;
      if(journal.bindingFor(localProjectId)?.phase==='detached'){status({deferred:true,phase:'detached'});return {applied:false,deferred:true,detached:true};}
      projectFlight=(async()=>{
        await records.settled();active();const template=observedSnapshot();
        const keys=new Set([WS,...template.project.drawings.map(d=>DRAW+d.id)]),expectedRecords=[...keys].map(k=>[k,records.getItem(k)]);
        const before=await replica.snapshotWithStatus();active();
        const projection=await bridge.project(template);active();
        if(!replica.isSnapshotCurrent(before.snapshotToken)){status({deferred:true});return {applied:false,deferred:true};}
        for(const drawing of projection.project.drawings)if(!keys.has(DRAW+drawing.id))expectedRecords.push([DRAW+drawing.id,records.getItem(DRAW+drawing.id)]);
        const metadataRecords=copy(projection.metadataRecords||{}),validate=()=>!closed&&sameScope(scope,currentScope())&&replica.isSnapshotCurrent(before.snapshotToken)&&
          !records.pending&&expectedRecords.every(([key,value])=>records.getItem(key)===value);
        if(!validate()){status({deferred:true});return {applied:false,deferred:true};}
        const context={scope:copy(scope),localProjectId,expectedRecords,metadataRecords,validate,
          throughSeq:journal.bindingFor(localProjectId)?.ackedSeq||0};
        let result;
        if(applyProjection)result=await applyProjection(copy(projection),context);
        else{
          const workspace=JSON.parse(records.getItem(WS)||'{"projects":[]}'),index=workspace.projects.findIndex(p=>p.id===localProjectId);
          if(index<0)workspace.projects.push(copy(projection.project));else workspace.projects[index]=copy(projection.project);
          const writes=[[WS,JSON.stringify(workspace)],...projection.drawings.map(d=>[DRAW+d.meta.id,JSON.stringify(d.state)])];
          result=await journal.applyProjection({...context,writes});
        }
        active();status({deferred:result?.applied!==true});return result||{applied:false,deferred:true};
      })();
      try{return await projectFlight;}finally{projectFlight=null;}
    }
    async function replay(claim){
      let receipt,plan;
      // A received event can invalidate the replica CAS while a plan is being
      // prepared. Retry the same immutable intent; never manufacture new IDs.
      for(let attempt=0;attempt<8;attempt++){
        active();let ordinal=0;
        plan=await bridge.prepare({before:claim.before,after:claim.after,operation:claim.operation,
          actor:claim.actor,at:claim.at,operationId:claim.id,groupId:claim.id+':group',
          idFactory:()=>claim.id+':'+(++ordinal),replay:true,replayBaseline:claim.replayBaseline,
          beforeRecords:claim.metadataRecords,metadataRecords:claim.metadataRecords});
        active();
        insist(plan.ready,'JOURNAL_REVIEW',(plan.issues||[]).map(x=>x.message).join(' / ')||'保存した入力の履歴を照合できません');
        try{receipt=await bridge.commit(plan);active();break;}
        catch(error){if(error.code!=='DELTA_STALE'||attempt===7)throw error;}
      }
      if(afterReplicaCommit)await afterReplicaCommit({claim:copy(claim),plan:copy(plan),receipt:copy(receipt)});
      active();const requiredRecords={};for(const change of plan.changes||[])requiredRecords[D.keyOf(change.drawingId,change.after.id)]=copy(change.after);
      const proof=await journal.verifyReplay({scope,claimId:claim.id,replica,replicaStore,requiredRecords,projection:receipt.projection,normalizedAfter:receipt.normalizedAfter});
      active();await journal.acknowledge({scope,localProjectId,claimId:claim.id,proof});
      acknowledged++;lastClaim=claim;status({acknowledged,lastError:null});
    }
    function drain(){
      active();if(flight)return flight;
      flight=(async()=>{
        status({phase:'replaying',lastError:null});
        try{
          for(;;){active();const claim=await journal.claim({scope,localProjectId});active();
            if(!claim)break;status({pendingIntents:claim.rowIds.length});await replay(claim);}
          await journal.compact();active();
          status({phase:'projecting',pendingIntents:0});const projection=await project();
          status({phase:projection?.detached?'detached':'idle',lastError:null});return {acknowledged,projection,lastClaimId:lastClaim?.id||null};
        }catch(error){status({phase:'retained',lastError:{code:error.code||error.name||'ERROR',message:error.message}});throw error;}
      })();
      flight=flight.finally(()=>{flight=null;});return flight;
    }
    return {drain,project,status,getScope:()=>copy(scope),close(){closed=true;if(ownBridge)bridge.close();status({phase:'closed'});}};
  }
  const api={version:1,createController};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SentlogDeltaAppJournal=api;
})(typeof window!=='undefined'?window:globalThis);
