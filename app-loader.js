const appUrl=new URL('./app.js?v=20260814-2145',location.href);
const response=await fetch(appUrl,{cache:'no-store'});
if(!response.ok)throw new Error(`app.jsの読み込みに失敗しました: ${response.status}`);
let source=await response.text();

function replaceOrWarn(find,replacement,label){
  if(!source.includes(find)){
    console.warn(`${label}の対象コードが見つかりませんでした。`);
    return;
  }
  source=source.replace(find,replacement);
}

replaceOrWarn(
  "const f=vs.filter(s=>s.work_date>D1).slice(0,20);",
  "const f=vs.filter(s=>s.work_date>D1);",
  '予定20件制限解除'
);

const editAnchor="  const syncPersonnelMode=()=>{";
const availabilityHelper=`  const originalStaffSelection=new Set(sel);
  const refreshStaffAvailability=()=>{
    const dates=[...document.querySelectorAll('input[name="workdate"]')].map(x=>x.value).filter(Boolean);
    let existingConflictCount=0;
    document.querySelectorAll('#staffBox input[name="staff"]').forEach(cb=>{
      const p=staff.find(x=>x.id===cb.value);
      const offDates=dates.filter(date=>dayStatus.some(x=>x.work_date===date&&x.staff_id===cb.value&&x.status==='off'));
      const existingConflict=!!(s&&originalStaffSelection.has(cb.value)&&dates.length===1&&dates[0]===s.work_date&&offDates.includes(s.work_date));
      const blocked=offDates.length>0&&!existingConflict;
      if(blocked)cb.checked=false;
      cb.disabled=blocked;
      const label=cb.closest('.ck');
      if(!label)return;
      label.classList.toggle('is-off',offDates.length>0);
      label.classList.toggle('existing-off',existingConflict);
      const span=label.querySelector('span');
      if(span){
        const offText=offDates.map(date=>{const parts=date.split('-');return Number(parts[1])+'/'+Number(parts[2]);}).join('・');
        span.innerHTML=esc(p?.display_name||'')+(offDates.length?'<small class="staffofftag">'+offText+' 休み'+(existingConflict?'・予定重複':'')+'</small>':'');
      }
      if(existingConflict)existingConflictCount++;
    });
    const hint=$('personHint');
    if(hint&&$('personnelTbd').value!=='1'){
      hint.innerHTML=existingConflictCount
        ? '<span class="staffoffwarning">⚠ 休み設定と既存予定が重複しています。必要に応じて担当者を変更してください。</span>'
        : '休みの人はグレー表示され、選択できません。';
    }
  };

`;
replaceOrWarn(editAnchor,availabilityHelper+editAnchor,'休み人員表示');

replaceOrWarn(
  "  $('modeSelect').onclick=()=>{$('personnelTbd').value='0';syncPersonnelMode()};\n  $('modeTbd').onclick=()=>{$('personnelTbd').value='1';syncPersonnelMode()};\n  syncPersonnelMode();\n\n  wireDateRows();",
  "  $('modeSelect').onclick=()=>{$('personnelTbd').value='0';syncPersonnelMode();refreshStaffAvailability()};\n  $('modeTbd').onclick=()=>{$('personnelTbd').value='1';syncPersonnelMode();refreshStaffAvailability()};\n  syncPersonnelMode();\n\n  wireDateRows();\n  $('dateList')?.addEventListener('change',refreshStaffAvailability);\n  if($('dateList'))new MutationObserver(()=>refreshStaffAvailability()).observe($('dateList'),{childList:true,subtree:true});\n  refreshStaffAvailability();",
  '休み人員の日付連動'
);

replaceOrWarn(
  "  if(!dates.length)return toast('作業日を選択してください');",
  `  if(!dates.length)return toast('作業日を選択してください');
  if(!personnelTbd){
    const existingIds=new Set(s?sm(s).map(x=>x.staff_id):[]);
    const invalid=sel.filter(id=>dates.some(date=>{
      const isOff=dayStatus.some(x=>x.work_date===date&&x.staff_id===id&&x.status==='off');
      const legacy=!!(s&&dates.length===1&&date===s.work_date&&existingIds.has(id));
      return isOff&&!legacy;
    }));
    if(invalid.length)return toast('休みの人は現場人員に選択できません');
  }`,
  '休み人員の保存チェック'
);

const style=document.createElement('style');
style.textContent=`
  .ck.is-off span{background:#f3f4f6!important;color:#9ca3af!important;border-color:#e5e7eb!important;cursor:not-allowed;position:relative}
  .ck.is-off span .staffofftag{display:block;margin-top:3px;font-size:9px;font-weight:900;color:#b45309}
  .ck.existing-off span{background:#fff7ed!important;color:#9a3412!important;border-color:#fdba74!important;cursor:pointer}
  .ck.existing-off input:checked+span{background:#fff7ed!important;color:#9a3412!important;border-color:#f97316!important;box-shadow:inset 0 0 0 1px #f97316}
  .staffoffwarning{display:block;color:#b45309;font-weight:800;line-height:1.45}
`;
document.head.appendChild(style);

const blobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
try{
  await import(blobUrl);
}finally{
  URL.revokeObjectURL(blobUrl);
}
await import('./attachments.js?v=20260815-1516');
await import('./past.js?v=20260822-1642');
await import('./refresh.js?v=20260824-1228');
