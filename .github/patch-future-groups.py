from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

marker="function visible(){return schedules.filter(s=>!onlyMine||assigned(s))}"
if marker not in t:
    raise SystemExit('visible marker not found')

helper=r'''function futureGroupedList(xs){
  if(!xs.length)return '<div class="empty">この先の予定はありません</div>';
  const groups=new Map();
  xs.forEach(s=>{
    if(!groups.has(s.work_date))groups.set(s.work_date,[]);
    groups.get(s.work_date).push(s);
  });
  return [...groups.entries()].map(([date,items])=>{
    const d=planDate(date);
    const rows=items.map(s=>{
      const people=sm(s).map(x=>st(x.staff_id)?.display_name).filter(Boolean).map(esc).join('・')||'—';
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

'''
if 'function futureGroupedList(xs)' not in t:
    t=t.replace(marker,helper+marker,1)

old="  $('future').innerHTML=f.length?planList(f,false):'<div class=\"empty\">この先の予定はありません</div>';"
new="  $('future').innerHTML=futureGroupedList(f);"
if old not in t:
    raise SystemExit('future render line not found')
t=t.replace(old,new,1)
p.write_text(t,encoding='utf-8')

css=Path('app.css')
c=css.read_text(encoding='utf-8')
add='''.futurelist{background:transparent;border:0;overflow:visible}.futuregroup{background:#fff;border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-bottom:12px}.futureday{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:#eef2f7;border-bottom:1px solid var(--line)}.futureday b{font-size:13px}.futureday span{font-size:10px;font-weight:800;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 7px}.futurejob{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(95px,.85fr);gap:10px;align-items:center;padding:10px 11px;border-bottom:1px solid var(--line)}.futurejob:last-child{border-bottom:0}.futuremain{min-width:0}.futuremain b{display:block;font-size:13px;line-height:1.35;overflow-wrap:anywhere}.futuremain small{display:block;color:var(--mut);font-size:10px;margin-top:3px}.futurepeople{font-size:11px;line-height:1.45;overflow-wrap:anywhere}@media(max-width:430px){.futurejob{grid-template-columns:minmax(0,1.1fr) minmax(88px,.9fr);gap:7px;padding:9px}.futureday{padding:8px 9px}.futuremain b{font-size:12px}.futurepeople{font-size:10px}}'''
if '.futuregroup{' not in c:
    c+='\n'+add+'\n'
css.write_text(c,encoding='utf-8')

idx=Path('index.html')
i=idx.read_text(encoding='utf-8')
i=i.replace('<div id="future" class="list"></div>','<div id="future" class="futurelist"></div>')
i=i.replace('20260814-2006','20260814-2017')
idx.write_text(i,encoding='utf-8')

sw=Path('sw.js')
s=sw.read_text(encoding='utf-8')
s=s.replace("shinwa-yotei-v8","shinwa-yotei-v9")
s=s.replace('20260814-2006','20260814-2017')
sw.write_text(s,encoding='utf-8')
