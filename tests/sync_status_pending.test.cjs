'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const raw=fs.readFileSync('sentlog/sync-status.js','utf8').replace('export function createSyncStatusView','function createSyncStatusView');
function node(){
  return {textContent:'',style:{},attrs:{},classList:{contains:()=>false},
    setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k]||null;},
    replaceChildren(...children){this.children=children;},
    querySelector(sel){return sel==='.sl-sync-label'?(this.children||[]).find(x=>x.className==='sl-sync-label'):null;}};
}
const button=node(),details=node();
const document={documentElement:{classList:{contains:x=>x==='sentlog-phone'}},head:{appendChild(){}},
  getElementById:id=>id==='sentlogCloudModal'?{style:{display:'flex'}}:null,createElement:()=>node()};
const context={document,setTimeout,clearTimeout,Date,console};
vm.createContext(context);vm.runInContext(raw+'\nthis.make=createSyncStatusView;',context);
const status=context.make(document);
status.mount(button,details);status.setAccount('owner');
const first=status.begin();status.finish(first,{level:'pending',message:'未完了の確認があります。'});
assert.equal(button.children[1].textContent,'反映待ち','real unfinished work must remain visible');
const next=status.begin();
assert.equal(button.children[1].textContent,'確認中','a new active verification must not display the stale pending outcome');
status.finish(next,{level:'ok',message:'共有記録に新しい変更はありません。'});
assert.equal(button.children[1].textContent,'同期ON','clean completion returns to normal');
const again=status.begin();status.finish(again,{level:'pending',message:'入力中の内容を保護しています。'});
assert.equal(button.children[1].textContent,'反映待ち','genuinely deferred work must not be hidden');
console.log('PASS sync status: active check, actual deferred state, and clean completion remain distinct');
