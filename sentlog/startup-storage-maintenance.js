/* Standalone entry: loading this module only wires controls. The explicit
 * prepare action opens an existing database through the maintenance writer. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogStartupStorageMaintenance)return;
  const doc=root.document,start=doc.getElementById('startupMaintenancePrepare'),host=doc.getElementById('startupMaintenanceHost'),
    status=doc.getElementById('startupMaintenanceStatus');
  if(!start||!host||!status)return;
  const links=['startupMaintenanceOpenApp','startupMaintenanceDiagnostics','startupMaintenanceRescue'].map(id=>doc.getElementById(id)).filter(Boolean);
  let preparing=false,prepared=false;
  const busy=()=>preparing||root.SentlogStorageMaintenanceUI?.busy===true;
  function updateLinks(){
    const blocked=busy();
    for(const link of links){
      if(blocked){link.setAttribute('aria-disabled','true');link.setAttribute('tabindex','-1');}
      else{link.removeAttribute('aria-disabled');link.removeAttribute('tabindex');}
    }
  }
  for(const link of links)link.addEventListener('click',event=>{
    if(!busy())return;
    event.preventDefault();event.stopPropagation();
    status.textContent='処理中です。確認・整理を中止するか、完了するまでこの画面でお待ちください。';
  });
  async function prepare(){
    if(preparing||prepared||busy())return;
    preparing=true;start.disabled=true;updateLinks();
    status.textContent='既存の保存領域を開いています。図面表示・同期は開始しません。';
    try{
      const records=root.SentlogRecords,ui=root.SentlogStorageMaintenanceUI;
      if(records?.maintenanceInitVersion!==1||records?.journalReadBudgetVersion!==1||records?.storageMaintenanceVersion!==1||
        typeof records.initForMaintenance!=='function'||ui?.version!==1||typeof ui.install!=='function')
        throw Error('軽い整理画面の最新版を読み込めませんでした。保存データは変更していません。');
      await records.initForMaintenance();
      if(!records.ready)throw Error('保存領域の準備を確認できませんでした。');
      records.assertSafe();
      if(!ui.install())throw Error('整理の操作画面を表示できませんでした。');
      prepared=true;host.inert=false;host.hidden=false;start.hidden=true;
      status.textContent='準備できました。下の「容量を整理」欄から進めてください。';
    }catch(error){
      host.hidden=true;host.inert=true;start.disabled=false;
      status.textContent='準備できませんでした：'+(error?.message||String(error));
    }finally{preparing=false;updateLinks();}
  }
  start.onclick=prepare;start.disabled=false;
  if(root.MutationObserver)new root.MutationObserver(updateLinks).observe(host,{attributes:true,subtree:true,attributeFilter:['aria-busy']});
  updateLinks();
  root.SentlogStartupStorageMaintenance={version:1,prepare,get busy(){return busy();},get ready(){return prepared;}};
})(typeof globalThis==='undefined'?window:globalThis);
