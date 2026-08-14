from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

marker="function visible(){return schedules.filter(s=>!onlyMine||assigned(s)||s.personnel_tbd)}"
if marker not in t:
    raise SystemExit('visible marker not found')

helper=r'''function dayPeople(date){
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

'''
if 'function dayOverview(date,xs)' not in t:
    t=t.replace(marker,helper+marker,1)

old="""function wire(){
  document.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>doConfirm(b.dataset.c));
  document.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>openPdf(b.dataset.p));
  document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>departure(b.dataset.d));
  document.querySelectorAll('[data-dd]').forEach(b=>b.onclick=()=>deleteDeparture(b.dataset.dd));
  document.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>edit(b.dataset.e));
}"""
new="""function wire(){
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
}"""
if old not in t:
    raise SystemExit('wire block not found')
t=t.replace(old,new,1)

old="""  $('today').innerHTML=dayStatusHtml(D0)+(t.length?t.map(job).join(''):'<div class=\"empty\">今日の現場予定はありません</div>');
  $('tomorrow').innerHTML=dayStatusHtml(D1)+(tm.length?tm.map(job).join(''):'<div class=\"empty\">明日の現場予定はありません</div>');
  const f=vs.filter(s=>s.work_date>D1).slice(0,20);
  $('future').innerHTML=futureGroupedList(f);"""
new="""  $('today').innerHTML=dayOverview(D0,t);
  $('tomorrow').innerHTML=dayOverview(D1,tm);
  const f=vs.filter(s=>s.work_date>D1).slice(0,20);
  $('future').innerHTML=futureDayOverview(f);"""
if old not in t:
    raise SystemExit('home render block not found')
t=t.replace(old,new,1)

p.write_text(t,encoding='utf-8')

css=Path('app.css')
c=css.read_text(encoding='utf-8')
add='''.daylist{display:block}.dayoverview{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:12px}.dayoverviewhead{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#eef2f7;border-bottom:1px solid var(--line)}.dayoverviewhead b{font-size:14px}.dayoverviewhead span{font-size:10px;font-weight:800;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 8px}.dayoverviewbody{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(210px,.75fr)}.sitearea{min-width:0;border-right:1px solid var(--line)}.areahead,.buckethead{padding:8px 10px;font-size:11px;color:#475569;background:#f8fafc;border-bottom:1px solid var(--line)}.unifiedsite{border-bottom:1px solid var(--line)}.unifiedsite:last-child{border-bottom:0}.unifiedsitehead{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(95px,.85fr) auto;gap:8px;align-items:center;padding:10px}.unifiedmain{min-width:0}.unifiedmain b{display:block;font-size:13px;line-height:1.35;overflow-wrap:anywhere}.unifiedmain small{display:block;color:var(--mut);font-size:10px;margin-top:3px}.unifiedpeople{font-size:11px;line-height:1.45;overflow-wrap:anywhere}.detailtoggle{border:1px solid var(--line);background:#fff;color:#475569;border-radius:8px;padding:6px 8px;font-size:10px;font-weight:800}.sitedetail{padding:0 10px 10px;background:#fbfdff;border-top:1px dashed var(--line)}.detailbox{margin-top:9px}.departurerow{margin-top:7px;display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.inputby{color:var(--mut);font-size:10px}.detailmuted{color:var(--mut);margin-top:5px}.detailnote{margin-top:9px;padding:8px;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:10px;line-height:1.45}.peoplearea{background:#fbfcfe}.staffbucket{border-bottom:1px solid var(--line)}.bucketnames{padding:9px 10px;font-size:11px;line-height:1.55;color:#374151;overflow-wrap:anywhere}.offbucket .buckethead{background:#fff8f8}.nosite{padding:16px 10px;color:var(--mut);font-size:11px}.peoplearea>.statuswarn{margin:9px 10px}.futurelist .dayoverview{margin-bottom:12px}@media(max-width:620px){.dayoverviewbody{grid-template-columns:1fr}.sitearea{border-right:0;border-bottom:1px solid var(--line)}.peoplearea{display:grid;grid-template-columns:1fr 1fr}.staffbucket{border-bottom:0}.staffbucket:first-child{border-right:1px solid var(--line)}.peoplearea>.statuswarn{grid-column:1/-1}.unifiedsitehead{grid-template-columns:minmax(0,1.08fr) minmax(86px,.82fr) auto;gap:6px}.bucketnames{font-size:10px}}@media(max-width:380px){.unifiedsitehead{grid-template-columns:minmax(0,1fr) minmax(78px,.78fr) auto;padding:9px 8px}.detailtoggle{padding:6px}.dayoverviewhead{padding:9px}.peoplearea{grid-template-columns:1fr}.staffbucket:first-child{border-right:0;border-bottom:1px solid var(--line)}}'''
if '.dayoverview{' not in c:
    c+='\n'+add+'\n'
css.write_text(c,encoding='utf-8')

idx=Path('index.html')
i=idx.read_text(encoding='utf-8')
i=i.replace('<div id="today" class="cards"></div>','<div id="today" class="daylist"></div>')
i=i.replace('<div id="tomorrow" class="cards"></div>','<div id="tomorrow" class="daylist"></div>')
i=i.replace('20260814-2025','20260814-2036')
idx.write_text(i,encoding='utf-8')

sw=Path('sw.js')
s=sw.read_text(encoding='utf-8')
s=s.replace("shinwa-yotei-v10","shinwa-yotei-v11")
s=s.replace('20260814-2025','20260814-2036')
sw.write_text(s,encoding='utf-8')
