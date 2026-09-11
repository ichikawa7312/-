const appUrl=new URL('./app.js?v=20260814-2145',location.href);
const response=await fetch(appUrl,{cache:'no-store'});
if(!response.ok)throw new Error(`app.jsの読み込みに失敗しました: ${response.status}`);
let source=await response.text();
const limited="const f=vs.filter(s=>s.work_date>D1).slice(0,20);";
const unlimited="const f=vs.filter(s=>s.work_date>D1);";
if(!source.includes(limited)){
  console.warn('予定20件制限の対象コードが見つかりませんでした。元のapp.jsをそのまま読み込みます。');
}else{
  source=source.replace(limited,unlimited);
}
const blobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
try{
  await import(blobUrl);
}finally{
  URL.revokeObjectURL(blobUrl);
}
await import('./attachments.js?v=20260815-1516');
await import('./past.js?v=20260822-1642');
await import('./refresh.js?v=20260824-1228');
