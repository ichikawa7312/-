from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

old="""function twoWeekCell(d){
  const z=iso(d);
  const xs=schedules.filter(s=>s.work_date===z);
  const today=z===D0;
  const rows=xs.length?xs.map(s=>`<div class=\"twosite\"><span>${esc(s.title)}</span>${s.personnel_tbd?'<b class=\"twotbd\">未定</b>':''}</div>`).join(''):'<div class=\"twonone\">予定なし</div>';
  return `<div class=\"twoday ${today?'today':''}\">
    <div class=\"twodate\"><b>${d.getDate()}</b><span>（${'日月火水木金土'[d.getDay()]}）</span></div>
    <div class=\"twosites\">${rows}</div>
  </div>`;
}"""

new="""const FIELD_COUNT_EXCLUDED=new Set(['飯沼りえこ','井上博之','古田須賀徳']);

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
  const rows=xs.length?xs.map(s=>`<div class=\"twosite\"><span>${esc(s.title)}</span>${s.personnel_tbd?'<b class=\"twotbd\">未定</b>':''}</div>`).join(''):'<div class=\"twonone\">予定なし</div>';
  return `<div class=\"twoday ${today?'today':''}\">
    <div class=\"twodate\"><div class=\"twodateleft\"><b>${d.getDate()}</b><span>（${'日月火水木金土'[d.getDay()]}）</span></div><span class=\"twoload\">現場 ${hc.site}/${hc.total}人</span></div>
    <div class=\"twosites\">${rows}</div>
  </div>`;
}"""

if old not in t:
    raise SystemExit('twoWeekCell block not found')
t=t.replace(old,new,1)
p.write_text(t,encoding='utf-8')

css=Path('app.css')
c=css.read_text(encoding='utf-8')
add='''.twodate{justify-content:space-between}.twodateleft{display:flex;align-items:baseline;gap:2px;min-width:0}.twoload{flex:none!important;font-size:9px!important;font-weight:900!important;color:#334155!important;background:#eef2f7;border:1px solid #dbe2ea;border-radius:999px;padding:3px 6px;white-space:nowrap;line-height:1.2}.twoday.today .twoload{background:#fff;border-color:#c7d2fe}@media(max-width:430px){.twoload{font-size:8px!important;padding:3px 5px}.twodateleft b{font-size:14px}.twodateleft span{font-size:9px}}'''
if '.twoload{' not in c:
    c+='\n'+add+'\n'
css.write_text(c,encoding='utf-8')

idx=Path('index.html')
i=idx.read_text(encoding='utf-8').replace('20260814-2052','20260814-2058')
idx.write_text(i,encoding='utf-8')

sw=Path('sw.js')
s=sw.read_text(encoding='utf-8').replace("shinwa-yotei-v12","shinwa-yotei-v13").replace('20260814-2052','20260814-2058')
sw.write_text(s,encoding='utf-8')
