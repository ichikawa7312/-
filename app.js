import{createClient}from'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';

const db=createClient(
  'https://dbupdbrjakandkppptix.supabase.co',
  'sb_publishable_c2f_qk0pmZy-0eaqqJh2FA_f8MU-iZ1'
);

const $=x=>document.getElementById(x);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[m]));

let session,me,staff=[],schedules=[],members=[],confs=[],deps=[],dm=[],dayStatus=[];
let onlyMine=true,cur=new Date(),selected=iso(new Date());

function iso(d){
  const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);
  return x.toISOString().slice(0,10);
}
function add(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function nextIso(z){
  if(!z)return D1;
  const [y,m,d]=z.split('-').map(Number);
  return iso(add(new Date(y,m-1,d),1));
}
const D0=iso(new Date()),D1=iso(add(new Date(),1));

function toast(t){
  $('toast').textContent=t;
  $('toast').classList.remove('hide');
  setTimeout(()=>$('toast').classList.add('hide'),2200);
}
function modal(t,h){
  $('mt').textContent=t;
  $('mb').innerHTML=h;
  $('shade').classList.remove('hide');
  $('modal').classList.remove('hide');
}
function closeM(){
  $('shade').classList.add('hide');
  $('modal').classList.add('hide');
}
function admin(){return me?.role==='admin'}
function owner(){return me?.display_name==='市川健太郎'&&String(session?.user?.email||'').toLowerCase()==='kentaro.i@shinwa-kensa.co.jp'}
function st(id){return staff.find(x=>x.id===id)}
function sm(s){return members.filter(x=>x.schedule_id===s.id)}
function assigned(s){return sm(s).some(x=>x.staff_id===me?.id)}
function conf(s,id){return confs.find(x=>x.schedule_id===s.id&&x.staff_id===id)}
function state(s,id){
  const c=conf(s,id);
  return !c?['未確認','']:c.revision<s.revision?['再確認','stale']:['✓確認済み','done'];
}
function sdeps(s){
  return deps.filter(x=>x.schedule_id===s.id).sort((a,b)=>a.departure_time.localeCompare(b.departure_time));
}
function dpeople(d){
  return dm.filter(x=>x.departure_id===d.id).map(x=>st(x.staff_id)).filter(Boolean);
}

async function load(){
  const rs=await Promise.all([
    db.from('staff').select('id,display_name,role,active,auth_user_id').eq('active',true).order('display_name'),
    db.from('schedules').select('*').order('work_date').order('site_start_time'),
    db.from('schedule_members').select('*'),
    db.from('confirmations').select('*'),
    db.from('departures').select('*'),
    db.from('departure_members').select('*'),
    db.from('staff_day_status').select('*')
  ]);
  const bad=rs.find(r=>r.error);
  if(bad)throw bad.error;
  [staff,schedules,members,confs,deps,dm,dayStatus]=rs.map(r=>r.data||[]);
  me=staff.find(x=>x.auth_user_id===session.user.id);
  if(!me)throw Error('社員情報に紐づいていません');
  $('acct').textContent=me.display_name;
  $('manageNav').classList.toggle('hide',!admin());
}

function confHtml(s){
  if(s.personnel_tbd)return '';
  const ms=sm(s),done=ms.filter(x=>state(s,x.staff_id)[1]==='done').length;
  return `<div class="conf"><div class="confhead"><b>確認状況</b><span>${done}/${ms.length}名</span></div><div class="cgrid">${
    ms.map(x=>{
      const p=st(x.staff_id),q=state(s,x.staff_id),self=x.staff_id===me.id;
      return `<button class="cbtn ${q[1]}" ${self?`data-c="${s.id}"`:'disabled'}><b>${esc(p?.display_name)}</b><span>${q[0]}</span></button>`;
    }).join('')
  }</div></div>`;
}

function job(s){
  const ds=sdeps(s);
  return `<article class="job">
    <div class="top"><div class="title">${esc(s.title)}</div><span class="time">現地 ${(s.site_start_time||'').slice(0,5)||'未定'}</span></div>
    <div class="chips">${s.personnel_tbd?'<span class="tbdBadge">人員未定</span>':sm(s).map(x=>`<span class="chip">${esc(st(x.staff_id)?.display_name)}</span>`).join('')}</div>
    <div class="box">
      <div class="boxhead"><b>出発予定</b>${assigned(s)?`<button class="smallbtn" data-d="${s.id}">＋書く</button>`:''}</div>
      ${ds.length?ds.map(d=>`<div style="margin-top:7px;display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div><b>${d.departure_time.slice(0,5)}</b>　${esc(dpeople(d).map(x=>x.display_name).join('・'))}
        <div style="color:#6b7280;font-size:10px">入力：${esc(st(d.author_staff_id)?.display_name)}</div></div>
        ${(d.author_staff_id===me.id||admin())?`<button class="smallbtn" data-dd="${d.id}">削除</button>`:''}
      </div>`).join(''):'<div style="color:#6b7280;margin-top:5px">まだ書き込みなし</div>'}
    </div>
    <div class="pdf"><span>${esc(s.pdf_name||'指示書PDFなし')}</span><button class="smallbtn" ${s.pdf_path?`data-p="${s.id}"`:'disabled'}>${s.pdf_path?'指示書を見る':'PDFなし'}</button></div>
    ${confHtml(s)}
  </article>`;
}

function dayStatusHtml(date){
  const offIds=new Set(dayStatus.filter(x=>x.work_date===date&&x.status==='off').map(x=>x.staff_id));
  const tbdCount=schedules.filter(s=>s.work_date===date&&s.personnel_tbd).length;
  const scheduledIds=new Set();
  schedules.filter(s=>s.work_date===date&&!s.personnel_tbd).forEach(s=>sm(s).forEach(x=>scheduledIds.add(x.staff_id)));
  const overlap=staff.filter(p=>offIds.has(p.id)&&scheduledIds.has(p.id));
  const off=staff.filter(p=>offIds.has(p.id));
  const site=staff.filter(p=>scheduledIds.has(p.id)&&!offIds.has(p.id));
  const office=staff.filter(p=>!scheduledIds.has(p.id)&&!offIds.has(p.id));
  const names=xs=>xs.length?xs.map(x=>esc(x.display_name)).join('・'):'なし';
  return `<div class="box" style="margin-bottom:10px">
    <div class="boxhead"><b>勤務状況</b><span style="font-size:11px;color:#6b7280">全${staff.length}名</span></div>
    <div style="margin-top:7px"><b>現場 ${site.length}名</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(site)}</div></div>
    <div style="margin-top:7px"><b>事務所 ${office.length}名${tbdCount?'（暫定）':''}</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(office)}</div></div>
    <div style="margin-top:7px"><b>休み ${off.length}名</b><div style="font-size:12px;color:#4b5563;margin-top:2px">${names(off)}</div></div>
    ${tbdCount?`<div class="statuswarn"><b>⚠ 人員未定の現場 ${tbdCount}件</b><br>事務所表示の人が現場に入る可能性があります。</div>`:''}
    ${overlap.length?`<div style="margin-top:8px;padding:7px;border-radius:8px;background:#fff7ed;font-size:11px"><b>⚠ 休みと現場予定が重複：</b>${names(overlap)}</div>`:''}
  </div>`;
}

function planDate(z){
  const [y,m,d]=z.split('-').map(Number);
  const w='日月火水木金土'[new Date(y,m-1,d).getDay()];
  return {md:`${m}/${d}`,w};
}

function planList(xs,editable=false){
  if(!xs.length)return '<div class="empty">予定はありません</div>';
  const head=`<div class="planhead ${editable?'manage':''}"><span>日付</span><span>現場</span><span>人員</span>${editable?'<span></span>':''}</div>`;
  const rows=xs.map(s=>{
    const d=planDate(s.work_date);
    const people=s.personnel_tbd?'<span class="tbdBadge">人員未定</span>':(sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—');
    const time=(s.site_start_time||'').slice(0,5)||'未定';
    return `<div class="planrow ${editable?'manage':''}">
      <div class="plandate"><b>${d.md}</b><small>(${d.w})</small></div>
      <div class="plansite"><b>${esc(s.title)}</b><small>現地 ${time}</small></div>
      <div class="planpeople">${people}</div>
      ${editable?`<button class="smallbtn planedit" data-e="${s.id}">編集</button>`:''}
    </div>`;
  }).join('');
  return head+rows;
}

function futureGroupedList(xs){
  if(!xs.length)return '<div class="empty">この先の予定はありません</div>';
  const groups=new Map();
  xs.forEach(s=>{
    if(!groups.has(s.work_date))groups.set(s.work_date,[]);
    groups.get(s.work_date).push(s);
  });
  return [...groups.entries()].map(([date,items])=>{
    const d=planDate(date);
    const rows=items.map(s=>{
      const people=s.personnel_tbd?'<span class="tbdBadge">人員未定</span>':(sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—');
      const time=(s.site_start_time||'').slice(0,5)||'未定';
      return `<div class="futurejob">
        <div class="futuremain"><b>${esc(s.title)}</b><small>現地 ${time}</small></div>
        <div class="futurepeople">${people}</div>
      </div>`;
    }).join('');
    return `<section class="futuregroup">
      <div class="futureday"><b>${d.md}（${d.w}）</b><span>${items.length}現場</span></div>
      <div class="futurejobs">${rows}</div>
    </section>`;
  }).join('');
}

function dayPeople(date){
  const offIds=new Set(dayStatus.filter(x=>x.work_date===date&&x.status==='off').map(x=>x.staff_id));
  const tbdCount=schedules.filter(s=>s.work_date===date&&s.personnel_tbd).length;
  const scheduledIds=new Set();
  schedules.filter(s=>s.work_date===date&&!s.personnel_tbd).forEach(s=>sm(s).forEach(x=>scheduledIds.add(x.staff_id)));
  return {
    tbdCount,
    off:staff.filter(p=>offIds.has(p.id)),
    office:staff.filter(p=>!scheduledIds.has(p.id)&&!offIds.has(p.id)),
    overlap:staff.filter(p=>offIds.has(p.id)&&scheduledIds.has(p.id))
  };
}

function detailHtml(s){
  const ds=sdeps(s);
  const departure=s.personnel_tbd?'':`<div class="box detailbox">
    <div class="boxhead"><b>出発予定</b>${assigned(s)?`<button class="smallbtn" data-d="${s.id}">＋書く</button>`:''}</div>
    ${ds.length?ds.map(d=>`<div class="departurerow">
      <div><b>${d.departure_time.slice(0,5)}</b>　${esc(dpeople(d).map(x=>x.display_name).join('・'))}<div class="inputby">入力：${esc(st(d.author_staff_id)?.display_name)}</div></div>
      ${(d.author_staff_id===me.id||admin())?`<button class="smallbtn" data-dd="${d.id}">削除</button>`:''}
    </div>`).join(''):'<div class="detailmuted">まだ書き込みなし</div>'}
  </div>`;
  const waiting=s.personnel_tbd?'<div class="detailnote">人員が決まると、出発予定と確認状況が表示されます。</div>':'';
  return `${departure}<div class="pdf"><span>${esc(s.pdf_name||'指示書PDFなし')}</span><button class="smallbtn" ${s.pdf_path?`data-p="${s.id}"`:'disabled'}>${s.pdf_path?'指示書を見る':'PDFなし'}</button></div>${waiting}${confHtml(s)}`;
}

function dayOverview(date,xs){
  const d=planDate(date),info=dayPeople(date);
  const names=items=>items.length?items.map(x=>esc(x.display_name)).join('・'):'なし';
  const siteRows=xs.length?xs.map(s=>{
    const people=s.personnel_tbd?'<span class="tbdBadge">人員未定</span>':(sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—');
    const time=(s.site_start_time||'').slice(0,5)||'未定';
    return `<div class="unifiedsite">
      <div class="unifiedsitehead">
        <div class="unifiedmain"><b>${esc(s.title)}</b><small>現地 ${time}</small></div>
        <div class="unifiedpeople">${people}</div>
        <button class="detailtoggle" data-detail="${s.id}">詳細</button>
      </div>
      <div id="detail-${s.id}" class="sitedetail hide">${detailHtml(s)}</div>
    </div>`;
  }).join(''):'<div class="nosite">現場予定なし</div>';
  return `<section class="dayoverview">
    <div class="dayoverviewhead"><b>${d.md}（${d.w}）</b><span>${xs.length}現場</span></div>
    <div class="dayoverviewbody">
      <div class="sitearea"><div class="areahead"><b>現場</b></div>${siteRows}</div>
      <aside class="peoplearea">
        <div class="staffbucket"><div class="buckethead"><b>事務所 ${info.office.length}名${info.tbdCount?'（暫定）':''}</b></div><div class="bucketnames">${names(info.office)}</div></div>
        <div class="staffbucket offbucket"><div class="buckethead"><b>休み ${info.off.length}名</b></div><div class="bucketnames">${names(info.off)}</div></div>
        ${info.tbdCount?`<div class="statuswarn"><b>⚠ 人員未定 ${info.tbdCount}現場</b><br>事務所表示の人が現場に入る可能性があります。</div>`:''}
        ${info.overlap.length?`<div class="statuswarn"><b>⚠ 休みと現場が重複</b><br>${names(info.overlap)}</div>`:''}
      </aside>
    </div>
  </section>`;
}

function futureDayOverview(xs){
  if(!xs.length)return '<div class="empty">この先の予定はありません</div>';
  const groups=new Map();
  xs.forEach(s=>{
    if(!groups.has(s.work_date))groups.set(s.work_date,[]);
    groups.get(s.work_date).push(s);
  });
  return [...groups.entries()].map(([date,items])=>dayOverview(date,items)).join('');
}

function visible(){return schedules.filter(s=>!onlyMine||assigned(s)||s.personnel_tbd)}
function wire(){
  document.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>doConfirm(b.dataset.c));
  document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>openPdf(b.dataset.p));
  document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>departure(b.dataset.d));
  document.querySelectorAll('[data-dd]').forEach(b=>b.onclick=()=>deleteDeparture(b.dataset.dd));
  document.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>edit(b.dataset.e));
  document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>{
    const el=$(`detail-${b.dataset.detail}`);
    if(!el)return;
    const opening=el.classList.contains('hide');
    el.classList.toggle('hide');
    b.textContent=opening?'閉じる':'詳細';
  });
}

function render(){
  const vs=visible();
  const t=vs.filter(s=>s.work_date===D0);
  const tm=vs.filter(s=>s.work_date===D1);
  const un=schedules.filter(s=>s.work_date>=D0&&assigned(s)&&state(s,me.id)[1]!=='done');
  $('dateLabel').textContent=new Date().toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
  $('summary').textContent=`未確認 ${un.length}件`;
  $('today').innerHTML=dayOverview(D0,t);
  $('tomorrow').innerHTML=dayOverview(D1,tm);
  const f=vs.filter(s=>s.work_date>D1).slice(0,20);
  $('future').innerHTML=futureDayOverview(f);
  calendar();
  manageList();
  wire();
}

function weekStart(d){
  const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const diff=(x.getDay()+6)%7;
  return add(x,-diff);
}

function shortMd(d){return `${d.getMonth()+1}/${d.getDate()}`}

const FIELD_COUNT_EXCLUDED=new Set(['飯沼りえこ','井上博之','古田須賀徳']);

function fieldHeadcount(date){
  const eligible=staff.filter(p=>!FIELD_COUNT_EXCLUDED.has(p.display_name));
  const eligibleIds=new Set(eligible.map(p=>p.id));
  const siteIds=new Set();
  schedules.filter(s=>s.work_date===date&&!s.personnel_tbd).forEach(s=>{
    sm(s).forEach(x=>{if(eligibleIds.has(x.staff_id))siteIds.add(x.staff_id)});
  });
  return {site:siteIds.size,total:eligible.length};
}

function twoWeekCell(d){
  const z=iso(d);
  const xs=schedules.filter(s=>s.work_date===z);
  const today=z===D0;
  const hc=fieldHeadcount(z);
  const rows=xs.length?xs.map(s=>`<div class="twosite"><span>${esc(s.title)}</span>${s.personnel_tbd?'<b class="twotbd">未定</b>':''}</div>`).join(''):'<div class="twonone">予定なし</div>';
  return `<div class="twoday ${today?'today':''}">
    <div class="twodate"><div class="twodateleft"><b>${d.getDate()}</b><span>（${'日月火水木金土'[d.getDay()]}）</span></div><span class="twoload">現場 ${hc.site}/${hc.total}人</span></div>
    <div class="twosites">${rows}</div>
  </div>`;
}

function calendar(){
  const start=weekStart(cur),end=add(start,13),next=add(start,7);
  $('month').textContent=`${shortMd(start)} 〜 ${shortMd(end)}`;
  $('weekA').textContent=`${shortMd(start)}〜${shortMd(add(start,6))}`;
  $('weekB').textContent=`${shortMd(next)}〜${shortMd(end)}`;
  let h='';
  for(let i=0;i<7;i++)h+=twoWeekCell(add(start,i))+twoWeekCell(add(start,7+i));
  $('grid').innerHTML=h;
}

function manageList(){
  if(!admin())return;
  $('manageList').innerHTML=schedules.length?planList(schedules,true):'<div class="empty">予定なし</div>';
  wire();
}

async function refresh(){await load();render()}

async function doConfirm(id){
  const s=schedules.find(x=>x.id===id);
  const current=conf(s,me.id);
  const confirmed=current&&current.revision>=s.revision;

  if(confirmed){
    const r=await db.from('confirmations').delete().eq('schedule_id',id).eq('staff_id',me.id);
    if(r.error)return toast('確認を取り消せません');
    await refresh();
    return toast('確認を取り消しました');
  }

  const r=await db.from('confirmations').upsert(
    {schedule_id:id,staff_id:me.id,revision:s.revision,confirmed_at:new Date().toISOString()},
    {onConflict:'schedule_id,staff_id'}
  );
  if(r.error)return toast('保存できません');
  await refresh();
  toast('確認済みにしました');
}

async function openPdf(id){
  const s=schedules.find(x=>x.id===id);
  const w=window.open('about:blank','_blank');
  const r=await db.storage.from('instructions').createSignedUrl(s.pdf_path,300);
  if(r.error){w?.close();return toast('PDFを開けません')}
  if(w)w.location=r.data.signedUrl;else location.href=r.data.signedUrl;
}

function checks(sel=[]){
  return staff.map(p=>`<label class="ck"><input type="checkbox" name="staff" value="${p.id}" ${sel.includes(p.id)?'checked':''}><span>${esc(p.display_name)}</span></label>`).join('');
}

function dateRow(value='',removable=true){
  return `<div class="dateRow" style="display:flex;gap:8px;align-items:center;margin-top:7px">
    <input type="date" name="workdate" value="${esc(value)}" required style="flex:1">
    ${removable?'<button type="button" class="smallbtn removeDate">削除</button>':''}
  </div>`;
}

function wireDateRows(){
  document.querySelectorAll('.removeDate').forEach(b=>b.onclick=()=>{
    b.closest('.dateRow')?.remove();
  });
}

function addDateRow(value=''){
  $('dateList').insertAdjacentHTML('beforeend',dateRow(value,true));
  wireDateRows();
}

function offChecks(date){
  const ids=new Set(dayStatus.filter(x=>x.work_date===date&&x.status==='off').map(x=>x.staff_id));
  return staff.map(p=>`<label class="ck"><input type="checkbox" name="offstaff" value="${p.id}" ${ids.has(p.id)?'checked':''}><span>${esc(p.display_name)}</span></label>`).join('');
}

function editOff(date=D1){
  if(!admin())return;
  modal('休み設定',`<form id="offForm" class="form">
    <label>日付<input id="offDate" type="date" value="${date}" required></label>
    <label>休みの人 <small style="color:#6b7280">（複数選択可）</small><div id="offStaff" class="staff">${offChecks(date)}</div></label>
    <small style="color:#6b7280">現場予定にも休み設定にも入っていない人は、自動的に「事務所」になります。</small>
    <button class="btn">保存</button>
  </form>`);
  $('offDate').onchange=()=>{$('offStaff').innerHTML=offChecks($('offDate').value)};
  $('offForm').onsubmit=saveOff;
}

async function saveOff(e){
  e.preventDefault();
  const date=$('offDate').value;
  const ids=[...document.querySelectorAll('input[name="offstaff"]:checked')].map(x=>x.value);
  const r=await db.rpc('admin_set_off_day',{p_work_date:date,p_staff_ids:ids});
  if(r.error){console.error(r.error);return toast('休み設定を保存できません')}
  closeM();
  await refresh();
  toast(ids.length?`${ids.length}名を休みに設定しました`:'休み設定を解除しました');
}

function edit(id){
  if(!admin())return;
  const s=id?schedules.find(x=>x.id===id):null;
  const sel=s?sm(s).map(x=>x.staff_id):[];
  const baseDate=s?.work_date||D1;
  const dateHelp=s
    ? 'この予定の内容をそのまま使って、あとから作業日を追加できます。'
    : '続き現場は「＋翌日を追加」で日付を増やせます。';

  const dateBlock=`<label>作業日 <small style="color:#6b7280">（複数日登録できます）</small>
      <div id="dateList">${dateRow(baseDate,false)}</div>
     </label>
     <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:-4px">
       <button type="button" id="addNextDate" class="sub" style="flex:1">＋翌日を追加</button>
       <button type="button" id="addOtherDate" class="sub" style="flex:1">＋別日を追加</button>
     </div>
     <small style="color:#6b7280">${dateHelp}</small>`;

  modal(s?'予定編集':'予定追加',`<form id="sf" class="form">
    <label>現場名<input id="ft" value="${esc(s?.title||'')}" required></label>
    ${dateBlock}
    <label>現地開始時刻<input id="ftime" type="time" value="${(s?.site_start_time||'').slice(0,5)}"></label>
    <div class="formgroup"><div class="formlabel">現場人員</div>
      <input id="personnelTbd" type="hidden" value="${s?.personnel_tbd?'1':'0'}">
      <div class="personmode"><button type="button" id="modeSelect" class="modebtn">人員を選択</button><button type="button" id="modeTbd" class="modebtn">人員未定</button></div>
      <div id="staffBox" class="staff">${checks(sel)}</div>
      <small id="personHint" class="personhint"></small>
    </div>
    <label>指示書PDF<input id="fp" type="file" accept="application/pdf,.pdf"><small>${esc(s?.pdf_name||'PDF未添付')}</small></label>
    <div class="actions">${s?'<button type="button" id="del" class="danger">削除</button>':''}<button class="btn grow">保存</button></div>
  </form>`);

  const syncPersonnelMode=()=>{
    const tbd=$('personnelTbd').value==='1';
    $('modeSelect').classList.toggle('on',!tbd);
    $('modeTbd').classList.toggle('on',tbd);
    $('staffBox').classList.toggle('hide',tbd);
    $('personHint').textContent=tbd?'人員が決まったら、この予定を編集して担当者を選択してください。':'担当する人を選択してください。';
  };
  $('modeSelect').onclick=()=>{$('personnelTbd').value='0';syncPersonnelMode()};
  $('modeTbd').onclick=()=>{$('personnelTbd').value='1';syncPersonnelMode()};
  syncPersonnelMode();

  wireDateRows();

  $('addNextDate').onclick=()=>{
    const vals=[...document.querySelectorAll('input[name="workdate"]')].map(x=>x.value).filter(Boolean);
    addDateRow(nextIso(vals.at(-1)||baseDate));
  };
  $('addOtherDate').onclick=()=>addDateRow('');

  $('sf').onsubmit=e=>saveSchedule(e,s);
  if(s)$('del').onclick=()=>delSchedule(s);
}

async function saveSchedule(e,s){
  e.preventDefault();
  const personnelTbd=$('personnelTbd').value==='1';
  const picked=[...document.querySelectorAll('input[name="staff"]:checked')].map(x=>x.value);
  const sel=personnelTbd?[]:picked;
  if(!personnelTbd&&!sel.length)return toast('現場人員を選択してください');
  const dates=[...new Set([...document.querySelectorAll('input[name="workdate"]')].map(x=>x.value).filter(Boolean))];
  if(!dates.length)return toast('作業日を選択してください');

  const file=$('fp').files[0];
  let path=s?.pdf_path||null,pname=s?.pdf_name||null;
  if(file){
    const storageGroup=s?.id||crypto.randomUUID();
    path=`${storageGroup}/${Date.now()}_${crypto.randomUUID()}.pdf`;
    const up=await db.storage.from('instructions').upload(path,file,{contentType:'application/pdf'});
    if(up.error){console.error('PDF upload error',up.error);return toast(`PDF保存失敗: ${up.error.message||'アップロードエラー'}`)}
    pname=file.name;
  }

  const r=await db.rpc('admin_save_schedule_bundle',{
    p_schedule_id:s?.id||null,
    p_dates:dates,
    p_title:$('ft').value.trim(),
    p_site_start_time:$('ftime').value||null,
    p_pdf_path:path,
    p_pdf_name:pname,
    p_personnel_tbd:personnelTbd,
    p_member_ids:sel
  });
  if(r.error){
    console.error('schedule save rpc error',r.error);
    cleanupPdfs().catch(()=>{});
    return toast('予定を保存できません');
  }

  closeM();
  await refresh();
  cleanupPdfs().catch(()=>{});
  const created=Array.isArray(r.data?.created_ids)?r.data.created_ids.length:0;
  if(r.data?.departures_reset)return toast('保存しました（出発予定をリセット）');
  if(s&&created)return toast(`${created}日分を追加しました`);
  if(!s&&created>1)return toast(`${created}日分を登録しました`);
  toast('保存しました');
}

async function delSchedule(s){
  if(!confirm('この予定を削除しますか？'))return;
  const r=await db.rpc('admin_delete_schedule',{p_schedule_id:s.id});
  if(r.error){console.error(r.error);return toast('削除できません')}
  closeM();
  await refresh();
  cleanupPdfs().catch(()=>{});
  toast('削除しました');
}

function departure(id){
  const s=schedules.find(x=>x.id===id),ids=sm(s).map(x=>x.staff_id);
  modal('出発予定',`<form id="df" class="form">
    <label>出発時刻<input id="dt" type="time" required></label>
    <label>一緒に出発する人<div class="staff">${
      staff.filter(p=>ids.includes(p.id)).map(p=>`<label class="ck"><input type="checkbox" name="dp" value="${p.id}" ${p.id===me.id?'checked':''}><span>${esc(p.display_name)}</span></label>`).join('')
    }</div></label>
    <small>入力者：${esc(me.display_name)}</small>
    <button class="btn">登録</button>
  </form>`);
  $('df').onsubmit=async e=>{
    e.preventDefault();
    const ps=[...document.querySelectorAll('input[name="dp"]:checked')].map(x=>x.value);
    if(!ps.length)return toast('出発する人を選択');
    let r=await db.from('departures').insert({schedule_id:id,departure_time:$('dt').value,author_staff_id:me.id}).select().single();
    if(r.error)return toast('保存失敗');
    r=await db.from('departure_members').insert(ps.map(staff_id=>({departure_id:r.data.id,staff_id})));
    if(r.error)return toast('保存失敗');
    closeM();
    await refresh();
    toast('登録しました');
  };
}

async function deleteDeparture(id){
  if(!confirm('この出発予定を削除しますか？'))return;
  const r=await db.from('departures').delete().eq('id',id);
  if(r.error)return toast('削除できません');
  await refresh();
  toast('削除しました');
}

function pushSupported(){
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function vapidBytes(s){
  const pad='='.repeat((4-s.length%4)%4);
  const b64=(s+pad).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(b64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function pushRequest(action,extra={}){
  const sr=await db.auth.getSession();
  if(!sr.data.session)throw Error('login_required');
  session=sr.data.session;
  const r=await fetch('https://dbupdbrjakandkppptix.supabase.co/functions/v1/push-notifications',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
    body:JSON.stringify({action,...extra})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||'push_failed');
  return data;
}

function notificationControls(){
  if(!pushSupported())return '<div class="box"><b>通知</b><div style="margin-top:5px;color:#6b7280">この端末ではプッシュ通知を利用できません。</div></div>';
  if(Notification.permission==='granted')return `<div class="box"><div class="boxhead"><b>通知</b><span class="ok">ON</span></div><div style="margin-top:5px;color:#6b7280;line-height:1.5">予定追加・予定変更・前日19:00の未確認を通知します。</div><div class="actions" style="margin-top:8px"><button id="testPush" class="sub grow">通知テスト</button><button id="disablePush" class="sub grow">通知をOFF</button></div></div>`;
  if(Notification.permission==='denied')return '<div class="box"><b>通知</b><div style="margin-top:5px;color:#b45309;line-height:1.5">通知が端末側でブロックされています。端末の通知設定から「シンワ予定」を許可してください。</div></div>';
  return `<div class="box"><b>通知</b><div style="margin-top:5px;color:#6b7280;line-height:1.5">予定追加・予定変更・前日19:00の未確認を通知できます。</div><button id="enablePush" class="btn" style="width:100%;margin-top:8px">通知を有効にする</button></div>`;
}

function openAccount(){
  modal('アカウント',`<div class="stack"><b>${esc(me.display_name)}</b><span>${esc(session.user.email)}</span><span>${admin()?'管理者':'メンバー'}</span>${notificationControls()}${admin()?'<button id="inviteStaff" class="sub">社員アカウントを招待</button>':''}${owner()?'<button id="passwordResetAdmin" class="sub">社員パスワード再設定</button>':''}<button id="logout" class="sub">ログアウト</button></div>`);
}

async function enableNotifications(){
  if(!pushSupported())return toast('この端末では通知を利用できません');
  try{
    const permission=await Notification.requestPermission();
    if(permission!=='granted')return toast('通知が許可されませんでした');
    const reg=await navigator.serviceWorker.ready;
    const cfg=await pushRequest('config');
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidBytes(cfg.publicKey)});
    }
    const j=sub.toJSON();
    if(!j.keys?.p256dh||!j.keys?.auth)throw Error('subscription_keys_missing');
    await pushRequest('subscribe',{
      subscription:{endpoint:sub.endpoint,keys:{p256dh:j.keys.p256dh,auth:j.keys.auth}},
      userAgent:navigator.userAgent
    });
    toast('通知を有効にしました');
    openAccount();
  }catch(e){
    console.error(e);
    const isiPhone=/iPhone|iPad|iPod/i.test(navigator.userAgent);
    toast(isiPhone?'ホーム画面の「シンワ予定」から通知を有効にしてください':'通知を有効にできませんでした');
  }
}

async function disableNotifications(){
  if(!pushSupported())return;
  try{
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(sub){
      await pushRequest('unsubscribe',{endpoint:sub.endpoint}).catch(()=>{});
      await sub.unsubscribe();
    }
    toast('通知をOFFにしました');
    openAccount();
  }catch(e){
    console.error(e);
    toast('通知をOFFにできませんでした');
  }
}

async function testNotification(){
  try{
    const r=await pushRequest('test');
    toast(r.sent>0?'テスト通知を送信しました':'通知を再登録してください');
  }catch(e){
    console.error(e);
    toast('テスト通知を送れませんでした');
  }
}

async function adminToolsRequest(action,extra={},withAuth=true){
  const headers={'Content-Type':'application/json'};
  if(withAuth){
    const sr=await db.auth.getSession();
    if(!sr.data.session)throw Error('login_required');
    session=sr.data.session;
    headers.Authorization=`Bearer ${session.access_token}`;
  }
  const r=await fetch('https://dbupdbrjakandkppptix.supabase.co/functions/v1/admin-tools',{
    method:'POST',headers,body:JSON.stringify({action,...extra})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||'admin_tools_failed');
  return data;
}

async function cleanupPdfs(){
  if(!admin())return;
  try{await adminToolsRequest('cleanup-pdfs')}catch(e){console.warn('PDF cleanup deferred',e)}
}

function auditWhen(z){
  return new Date(z).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function sameAudit(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null)}
function auditDetail(a){
  const d=a.details||{};
  if(a.action==='create')return `${(d.members||[]).join('・')||'人員未定'}${d.pdf_name?` ／ PDF:${d.pdf_name}`:''}`;
  if(a.action==='delete')return `${(d.members||[]).join('・')||'人員未定'}${d.pdf_name?` ／ PDF:${d.pdf_name}`:''}`;
  if(a.action==='off_update')return `休み：${(d.new||[]).join('・')||'なし'}`;
  if(a.action==='password_reset_link')return `${st(a.target_staff_id)?.display_name||d.target_name||'社員'} の再設定リンク発行`;
  if(a.action==='pdf_cleanup')return `不要PDF ${d.deleted_count||0}件を削除`;
  if(a.action==='update'){
    const o=d.old||{},n=d.new||{},x=[];
    if(!sameAudit(o.title,n.title))x.push('現場名');
    if(!sameAudit(o.work_date,n.work_date))x.push('日付');
    if(!sameAudit(o.site_start_time,n.site_start_time))x.push('開始時刻');
    if(!sameAudit(o.pdf_name,n.pdf_name))x.push('PDF');
    if(!sameAudit(o.personnel_tbd,n.personnel_tbd)||!sameAudit(o.members,n.members))x.push('人員');
    if(d.departures_reset)x.push('出発予定削除');
    return x.length?x.join('・'):'内容変更';
  }
  return '';
}

async function showAudit(){
  if(!admin())return;
  modal('更新履歴','<div class="center" style="min-height:120px">読み込み中…</div>');
  const r=await db.from('schedule_audit_log').select('*').order('happened_at',{ascending:false}).limit(100);
  if(r.error)return $('mb').innerHTML='<div class="empty">履歴を読み込めません</div>';
  const labels={create:'予定登録',update:'予定変更',delete:'予定削除',off_update:'休み設定',password_reset_link:'PW再設定',pdf_cleanup:'PDF整理'};
  $('mb').innerHTML=r.data.length?`<div class="stack">${r.data.map(a=>`<div class="box">
    <div class="boxhead"><b>${esc(labels[a.action]||a.action)}</b><span style="font-size:11px;color:#6b7280">${esc(auditWhen(a.happened_at))}</span></div>
    <div style="margin-top:5px"><b>${esc(a.title||'')}</b>${a.work_date?` <span style="font-size:11px;color:#6b7280">${esc(a.work_date)}</span>`:''}</div>
    <div style="font-size:12px;margin-top:4px">${esc(auditDetail(a))}</div>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">操作：${esc(st(a.actor_staff_id)?.display_name||'システム')}</div>
  </div>`).join('')}</div>`:'<div class="empty">更新履歴はまだありません</div>';
}

async function passwordResetAdmin(){
  if(!owner())return;
  const targets=staff.filter(x=>x.auth_user_id);
  modal('社員パスワード再設定',`<form id="prf" class="form">
    <label>社員<select id="prs" style="width:100%;border:1px solid #cbd5e1;border-radius:11px;padding:12px;background:white">${targets.map(x=>`<option value="${x.id}">${esc(x.display_name)}</option>`).join('')}</select></label>
    <small style="color:#6b7280;line-height:1.5">本人用の1回限りの再設定リンクを作ります。有効期限は24時間です。市川さんが本人の新しいパスワードを見ることはありません。</small>
    <button class="btn">再設定リンクを作成</button>
  </form>`);
  $('prf').onsubmit=async e=>{
    e.preventDefault();
    try{
      const data=await adminToolsRequest('create-password-reset',{staff_id:$('prs').value});
      const u=new URL(location.href);u.search='';u.hash='';u.searchParams.set('reset',data.token);u.searchParams.set('email',data.email);
      modal('再設定リンク完成',`<div class="stack"><b>${esc(data.display_name)}</b><p>このURLを本人へ送ってください。24時間・1回限り有効です。</p><input id="resetUrl" value="${esc(u.toString())}" readonly><button id="copyReset" class="btn">URLをコピー</button></div>`);
      $('copyReset').onclick=async()=>{await navigator.clipboard.writeText($('resetUrl').value);toast('コピーしました')};
    }catch(e){console.error(e);toast('再設定リンクを作れませんでした')}
  };
}

async function inviteStaff(){
  if(!admin())return;
  const targets=staff.filter(x=>!x.auth_user_id);
  modal('社員アカウント招待',`<form id="ifm" class="form">
    <label>社員<select id="is" style="width:100%;border:1px solid #cbd5e1;border-radius:11px;padding:12px;background:white">${
      targets.map(x=>`<option value="${x.id}">${esc(x.display_name)}</option>`).join('')
    }</select></label>
    <label>本人のメールアドレス<input id="ie" type="email" required></label>
    <p style="font-size:12px;color:#6b7280">招待リンクは7日間・1回限り有効です。各社員が自分のパスワードを設定します。</p>
    <button class="btn">招待リンクを作成</button>
  </form>`);
  $('ifm').onsubmit=async e=>{
    e.preventDefault();
    const r=await fetch('https://dbupdbrjakandkppptix.supabase.co/functions/v1/create-staff-invite',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
      body:JSON.stringify({staff_id:$('is').value,email:$('ie').value.trim()})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)return toast(data.error==='already_active'?'すでに有効化済みです':'招待リンクを作れません');
    const u=new URL(location.href);
    u.search='';
    u.hash='';
    u.searchParams.set('activate',data.token);
    u.searchParams.set('email',data.email);
    modal('招待リンク完成',`<div class="stack"><b>${esc(data.display_name)}</b><p>このURLを本人へ送ってください。</p><input id="inviteUrl" value="${esc(u.toString())}" readonly><button id="copyInvite" class="btn">URLをコピー</button></div>`);
    $('copyInvite').onclick=async()=>{
      await navigator.clipboard.writeText($('inviteUrl').value);
      toast('コピーしました');
    };
  };
}

async function enter(){
  try{
    await load();
    $('boot').classList.add('hide');
    $('auth').classList.add('hide');
    $('app').classList.remove('hide');
    render();
  }catch(e){
    console.error(e);
    $('boot').textContent='読み込みエラー';
  }
}
function authView(){
  $('boot').classList.add('hide');
  $('app').classList.add('hide');
  $('auth').classList.remove('hide');
}

const qp=new URLSearchParams(location.search),prefill=qp.get('email')||'',activationToken=qp.get('activate')||'',managedResetToken=qp.get('reset')||'';
const ownerRecoveryRequested=qp.get('owner-recovery')==='1'||location.hash.includes('type=recovery');
$('le').value=prefill;
$('se').value=prefill;
$('mre').value=prefill;
function hideAuthForms(){['login','signup','managedReset','ownerReset'].forEach(id=>$(id).classList.add('hide'))}
function showManagedReset(){authView();hideAuthForms();$('managedReset').classList.remove('hide')}
function showOwnerRecovery(){authView();hideAuthForms();$('ownerReset').classList.remove('hide')}
if(activationToken&&!managedResetToken){
  $('login').classList.add('hide');
  $('signup').classList.remove('hide');
  $('se').readOnly=true;
}

$('login').onsubmit=async e=>{
  e.preventDefault();
  $('lm').textContent='';
  const r=await db.auth.signInWithPassword({email:$('le').value.trim(),password:$('lp').value});
  if(r.error)return $('lm').textContent='ログインできません。メールアドレスまたはパスワードを確認してください。';
  session=r.data.session;
  enter();
};

$('goSignup').onclick=()=>{
  if(!activationToken){
    $('lm').textContent='初回登録は、管理者から届く招待URLを開いて行います。';
    return;
  }
  $('login').classList.add('hide');
  $('signup').classList.remove('hide');
  $('se').value=$('le').value;
};

$('goLogin').onclick=()=>{
  $('signup').classList.add('hide');
  $('login').classList.remove('hide');
  $('le').value=$('se').value;
};

$('signup').onsubmit=async e=>{
  e.preventDefault();
  $('sm').innerHTML='';
  const p=$('sp').value;
  if(!activationToken)return $('sm').innerHTML='<span class="err">招待URLから開いてください。</span>';
  if(p!==$('sp2').value)return $('sm').innerHTML='<span class="err">パスワードが一致しません。</span>';
  const rr=await fetch('https://dbupdbrjakandkppptix.supabase.co/functions/v1/activate-staff',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:$('se').value.trim(),password:p,token:activationToken})
  });
  await rr.json().catch(()=>({}));
  if(!rr.ok)return $('sm').innerHTML='<span class="err">有効化できません。招待URLの期限・メールアドレスを確認してください。</span>';
  const r=await db.auth.signInWithPassword({email:$('se').value.trim(),password:p});
  if(r.error)return $('sm').innerHTML='<span class="ok">アカウントは有効化されました。ログイン画面からログインしてください。</span>';
  history.replaceState({},'',location.pathname);
  session=r.data.session;
  enter();
};

$('forgotPassword').onclick=async()=>{
  const email=$('le').value.trim().toLowerCase();
  $('lm').textContent='';
  if(email!=='kentaro.i@shinwa-kensa.co.jp')return $('lm').textContent='パスワード再設定は市川さんに依頼してください。';
  try{
    const redirect=`${location.origin}${location.pathname}?owner-recovery=1`;
    const r=await db.auth.resetPasswordForEmail(email,{redirectTo:redirect});
    if(r.error)throw r.error;
    $('lm').textContent='市川さんの登録メールへ再設定メールを送りました。';
  }catch(e){console.error(e);$('lm').textContent='再設定メールを送れませんでした。';}
};

$('managedReset').onsubmit=async e=>{
  e.preventDefault();
  $('mrm').textContent='';
  const p=$('mrp').value;
  if(p!==$('mrp2').value)return $('mrm').textContent='パスワードが一致しません。';
  try{
    await adminToolsRequest('complete-password-reset',{token:managedResetToken,email:$('mre').value.trim(),password:p},false);
    history.replaceState({},'',location.pathname);
    hideAuthForms();$('login').classList.remove('hide');$('le').value=$('mre').value;$('lm').textContent='パスワードを変更しました。新しいパスワードでログインしてください。';
  }catch(e){console.error(e);$('mrm').textContent='再設定リンクが無効か期限切れです。';}
};

$('ownerReset').onsubmit=async e=>{
  e.preventDefault();
  $('orm').textContent='';
  const p=$('orp').value;
  if(p!==$('orp2').value)return $('orm').textContent='パスワードが一致しません。';
  if(!session)return $('orm').textContent='再設定セッションを確認できません。';
  const r=await db.auth.updateUser({password:p});
  if(r.error)return $('orm').textContent='パスワードを変更できませんでした。';
  await db.auth.signOut();
  session=null;history.replaceState({},'',location.pathname);hideAuthForms();$('login').classList.remove('hide');$('le').value='kentaro.i@shinwa-kensa.co.jp';$('lm').textContent='パスワードを変更しました。新しいパスワードでログインしてください。';
};

db.auth.onAuthStateChange((event,newSession)=>{
  if(event==='PASSWORD_RECOVERY'){
    session=newSession;
    setTimeout(showOwnerRecovery,0);
  }
});

$('mine').onclick=()=>{
  onlyMine=true;
  $('mine').classList.add('on');
  $('all').classList.remove('on');
  render();
};
$('all').onclick=()=>{
  onlyMine=false;
  $('all').classList.add('on');
  $('mine').classList.remove('on');
  render();
};
$('prev').onclick=()=>{cur=add(weekStart(cur),-14);calendar()};
$('next').onclick=()=>{cur=add(weekStart(cur),14);calendar()};
$('new').onclick=()=>edit();
$('off').onclick=()=>editOff();
$('historyBtn').onclick=showAudit;
$('close').onclick=closeM;
$('shade').onclick=closeM;
$('acct').onclick=openAccount;

document.addEventListener('click',e=>{
  if(e.target.id==='logout')db.auth.signOut().then(()=>location.reload());
  if(e.target.id==='inviteStaff')inviteStaff();
  if(e.target.id==='passwordResetAdmin')passwordResetAdmin();
  if(e.target.id==='enablePush')enableNotifications();
  if(e.target.id==='disablePush')disableNotifications();
  if(e.target.id==='testPush')testNotification();
});

document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{
  if(b.id==='manageNav'&&!admin())return;
  document.querySelectorAll('.nav').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  document.querySelectorAll('.view').forEach(x=>x.classList.add('hide'));
  $(b.dataset.v).classList.remove('hide');
});

(async()=>{
  const r=await db.auth.getSession();
  session=r.data.session;
  if(managedResetToken)return showManagedReset();
  if(ownerRecoveryRequested&&session)return showOwnerRecovery();
  if(session)enter();else authView();
})();

if('serviceWorker'in navigator){
  addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}