'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const index=read('sentlog/index.html'),edit=read('sentlog/collaboration-editor.js'),
  worker=read('sentlog/sw.js'),phone=read('sentlog/phone-runtime.js'),pc=read('sentlog-pc/index.html');
const token='20261128-local-damage-decisions-221';
const count=(s,v)=>s.split(v).length-1;
assert.equal(count(index,'collaboration-editor.js?v='+token),2);
assert(index.includes("['collaboration-editor.js?v="+token+"','offlineDamageDecisionsVersion']"));
assert.equal(count(index,'phone-runtime.js?v=221'),2);
assert(index.includes("['phone-runtime.js?v=221','v2.21']"));
assert(edit.includes('offlineDamageDecisionsVersion:3'));
const recoveryToken='20261128-safe-original-recovery-221';
const recoveryModules={
  'original-photo-store':'async function getOriginalMeta(',
  'delta-sync-asset-runtime':'ASSET_ORIGINAL_RECOVERY_BATCH',
  'delta-sync-app-runtime':'recoverShared:recoverShared?',
  'cloud-sync':'async function sentlogDeltaRecoverSharedOriginal('
};
for(const [module,marker] of Object.entries(recoveryModules)){
  assert.equal(count(index,module+'.js?v='+recoveryToken),2,'stale iPhone asset: '+module);
  assert(read('sentlog/'+module+'.js').includes(marker),'missing safe-original recovery: '+module);
}

assert(edit.includes('async function confirmDecision({localOnly=!navigator.onLine}={})'));
assert(edit.includes('()=>confirmDecision({localOnly:localFirst})'));
assert(edit.includes('最新の共有記録を確認して変更'));

assert(edit.includes("if(!localOnly&&navigator.onLine)"));
assert(edit.includes("opts({expectedToken:d.token,...(localOnly?{revisionId:d.localRevisionId}:{})})"));
assert(edit.includes("function localDecisionApplied(d,target)"));
assert(edit.includes("if(!navigator.onLine)continue;"));
assert(edit.includes("d.kind==='photo-remove'?target.collab.photos?.[d.photoId]?.revisions:null"));
assert(edit.includes("saveDecisions(d,[d,...decisionQueue])"));
assert(edit.includes("store?.assertSafe?.()"));
assert.deepEqual(worker.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v263']);
assert(worker.includes("if(!ownStatic&&!pdfEngine)return"),
 'A new worker cannot cache or intercept cloud photo API traffic');
assert(phone.includes("window.SENTLOG_BUILD = 'v2.21'"));
assert(phone.includes('v2.21 · 損傷の変更を端末内に安全に保存'));
assert(pc.includes('v2.21 · 損傷の変更を端末内に安全に保存'));
console.log('PASS v2.21: updated iPhone editor script, cache identity and unchanged cloud/photo interception guard');
