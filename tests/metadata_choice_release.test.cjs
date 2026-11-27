'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const moduleName='delta-sync-metadata-ui',token='20261127-metadata-choice-213',marker='SentlogDeltaMetadataStableUI';
const url=moduleName+'.js?v='+token,label='v2.13 · 同期中の設定選択を改善';
const index=fs.readFileSync('sentlog/index.html','utf8'),pc=fs.readFileSync('sentlog-pc/index.html','utf8');
const phone=fs.readFileSync('sentlog/phone-runtime.js','utf8'),worker=fs.readFileSync('sentlog/sw.js','utf8');
const source=fs.readFileSync('sentlog/'+moduleName+'.js','utf8');
const urls=page=>page.match(/(?<![A-Za-z0-9_.-])delta-sync-metadata-ui\.js\?v=[A-Za-z0-9._-]+/g)||[];
assert.deepEqual(urls(index),[url,url]);
assert(index.includes("['"+url+"','"+marker+"']"));
assert(index.includes('src="./'+url+'"'));
assert.deepEqual(urls(pc),[]);
assert.deepEqual(urls(fs.readFileSync('sentlog/drawing-export-view.html','utf8')),[]);
assert(source.includes(marker));
const context={window:{structuredClone}};
vm.createContext(context);vm.runInContext(source,context,{filename:moduleName+'.js'});
const api=context.window.SentlogDeltaMetadataUI;
assert(api);assert.equal(api.stableRenderVersion,1);
assert.equal(context.window.SentlogDeltaMetadataStableUI,api);
assert.equal(typeof api.update,'function');assert.equal(typeof api.clear,'function');
assert.equal(index.split('phone-runtime.js?v=213').length-1,2);
assert(index.includes("['phone-runtime.js?v=213','v2.13']"));
assert(phone.includes("window.SENTLOG_BUILD = 'v2.13'"));
assert.equal(phone.split('v2.13').length-1,4);
for(const text of [phone,pc])assert(text.includes(label));
assert.deepEqual(worker.match(/sentlog-pwa-v\d+/g),['sentlog-pwa-v255']);
assert.equal(worker.split("'delta-sync-metadata-ui.js'").length-1,1);

// This UI release must not advance or remove the executed-writer safeguards
// or the independently versioned save/recovery modules.
for(const [name,version,identity]of [
  ['record-store','20261127-cutoff-resume-212','sentlog-cutoff-resume-v212'],
  ['photo-recovery','20261127-photo-save-failure-gate-212','sentlog-photo-save-failure-gate-v212'],
  ['delta-sync-app-runtime','20261127-delta-save-failure-gate-212','sentlog-delta-save-failure-gate-v212'],
  ['cloud-sync','20261127-cloud-asset-save-failure-gate-212','sentlog-cloud-asset-save-failure-gate-v212'],
  ['pdf-recovery','20261127-pdf-save-failure-gate-211','sentlog-pdf-save-failure-gate-v211']
]){
  const dependency=name+'.js?v='+version;
  assert.equal(index.split(dependency).length-1,2);
  assert(index.includes("['"+dependency+"','"+identity+"']"));
  assert(fs.readFileSync('sentlog/'+name+'.js','utf8').startsWith('// '+identity+'\n'));
}
assert(index.includes('if(window.SentlogRecords?.cutoffResumeVersion!==1||window.SentlogRecords?.storageLifecycleVersion!==1||window.SentlogRecords?.startupProtectionVersion!==1||window.SentlogRecords?.getFileWriteCapabilities?.()?.fileWriteDedupVersion!==1)'));
const releaseTests=['storage_recovery_release','startup_protection_release','file_journal_wake_release',
  'startup_backup_recovery_release','cloud_normalization_release','storage_lifecycle_release',
  'pdf_save_failure_release','recovery_retry_release'];
const flow=fs.readFileSync('.github/workflows/pages.yml','utf8');
const build='          python3 scripts/build_metadata_choice_release.py';
assert.equal(flow.split(build).length-1,1);
const tail=[build,...releaseTests.map(name=>'          node tests/'+name+'.test.cjs'),
  '          node tests/metadata_choice_release.test.cjs'].join('\n');
assert(flow.includes(tail+'\n'));
assert(flow.indexOf('          node tests/recovery_retry_release.test.cjs')<flow.indexOf(build));
console.log('PASS v2.13 metadata choice release: fixed UI API, main/PC identities, unchanged save/recovery safeguards and late release gates');
