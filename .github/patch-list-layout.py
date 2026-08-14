from pathlib import Path

p = Path('app.js')
t = p.read_text(encoding='utf-8')

marker = "function visible(){return schedules.filter(s=>!onlyMine||assigned(s))}"
if marker not in t:
    raise SystemExit('visible marker not found')

helper = r'''function planDate(z){
  const [y,m,d]=z.split('-').map(Number);
  const w='日月火水木金土'[new Date(y,m-1,d).getDay()];
  return {md:`${m}/${d}`,w};
}

function planList(xs,editable=false){
  if(!xs.length)return '<div class="empty">予定はありません</div>';
  const head=`<div class="planhead ${editable?'manage':''}"><span>日付</span><span>現場</span><span>人員</span>${editable?'<span></span>':''}</div>`;
  const rows=xs.map(s=>{
    const d=planDate(s.work_date);
    const people=sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—';
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

'''

t = t.replace(marker, helper + marker, 1)

old = "  $('future').innerHTML=f.length?f.map(s=>`<div class=\"row\"><div><b>${esc(s.title)}</b><small>${s.work_date}　現地 ${(s.site_start_time||'').slice(0,5)||'未定'}</small></div></div>`).join(''):'<div class=\"empty\">この先の予定はありません</div>';"
new = "  $('future').innerHTML=f.length?planList(f,false):'<div class=\"empty\">この先の予定はありません</div>';"
if old not in t:
    raise SystemExit('future block not found')
t = t.replace(old, new, 1)

old = "  $('manageList').innerHTML=schedules.length?schedules.map(s=>`<div class=\"row\"><div><b>${esc(s.title)}</b><small>${s.work_date}　${sm(s).map(x=>st(x.staff_id)?.display_name).join('・')}</small></div><button class=\"smallbtn\" data-e=\"${s.id}\">編集</button></div>`).join(''):'<div class=\"empty\">予定なし</div>';"
new = "  $('manageList').innerHTML=schedules.length?planList(schedules,true):'<div class=\"empty\">予定なし</div>';"
if old not in t:
    raise SystemExit('manage block not found')
t = t.replace(old, new, 1)

p.write_text(t, encoding='utf-8')

css = Path('app.css')
c = css.read_text(encoding='utf-8')
extra = r'''
.planhead,.planrow{display:grid;grid-template-columns:64px minmax(0,1.15fr) minmax(92px,.85fr);gap:9px;align-items:center}.planhead{padding:8px 11px;background:#f8fafc;border-bottom:1px solid var(--line);font-size:10px;font-weight:800;color:var(--mut)}.planrow{padding:10px 11px;border-bottom:1px solid var(--line)}.planrow:last-child{border-bottom:0}.planhead.manage,.planrow.manage{grid-template-columns:64px minmax(0,1.15fr) minmax(82px,.85fr) 45px}.plandate{display:flex;flex-direction:column;line-height:1.1}.plandate b{font-size:13px}.plandate small{font-size:10px;color:var(--mut);margin-top:3px}.plansite{min-width:0}.plansite b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}.plansite small{display:block;color:var(--mut);font-size:10px;margin-top:3px}.planpeople{font-size:11px;line-height:1.45;overflow-wrap:anywhere}.planedit{justify-self:end}.list>.empty{border:0;border-radius:0}@media(max-width:430px){.planhead,.planrow{grid-template-columns:56px minmax(0,1.12fr) minmax(78px,.88fr);gap:6px;padding-left:8px;padding-right:8px}.planhead.manage,.planrow.manage{grid-template-columns:54px minmax(0,1.05fr) minmax(72px,.8fr) 42px}.plandate b{font-size:12px}.plansite b{font-size:12px}.planpeople{font-size:10px}.planedit{padding:6px 6px}}
'''
if '.planhead,.planrow{' not in c:
    c += extra
css.write_text(c, encoding='utf-8')

idx = Path('index.html')
i = idx.read_text(encoding='utf-8')
i = i.replace('20260812-1845','20260814-2006')
idx.write_text(i, encoding='utf-8')

sw = Path('sw.js')
s = sw.read_text(encoding='utf-8')
s = s.replace("shinwa-yotei-v7","shinwa-yotei-v8")
s = s.replace('20260812-1845','20260814-2006')
sw.write_text(s, encoding='utf-8')
