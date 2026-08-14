from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

old="""function calendar(){
  const y=cur.getFullYear(),m=cur.getMonth(),fst=new Date(y,m,1),start=add(fst,-fst.getDay());
  $('month').textContent=`${y}年 ${m+1}月`;
  let h='';
  for(let i=0;i<42;i++){
    const d=add(start,i),z=iso(d),n=visible().filter(s=>s.work_date===z).length;
    h+=`<button class=\"day ${d.getMonth()===m?'':'out'} ${z===selected?'sel':''}\" data-day=\"${z}\">${d.getDate()}<div>${Array.from({length:Math.min(n,4)},()=>'<i class=\"dot\"></i>').join('')}</div></button>`;
  }
  $('grid').innerHTML=h;
  document.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{selected=b.dataset.day;calendar()});
  const xs=visible().filter(s=>s.work_date===selected);
  $('dayList').innerHTML=`<h2>${selected}</h2><div class=\"cards\">${dayStatusHtml(selected)}${xs.length?xs.map(job).join(''):'<div class=\"empty\">現場予定なし</div>'}</div>`;
  wire();
}"""

new="""function weekStart(d){
  const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const diff=(x.getDay()+6)%7;
  return add(x,-diff);
}

function shortMd(d){return `${d.getMonth()+1}/${d.getDate()}`}

function twoWeekCell(d){
  const z=iso(d);
  const xs=schedules.filter(s=>s.work_date===z);
  const today=z===D0;
  const rows=xs.length?xs.map(s=>`<div class=\"twosite\"><span>${esc(s.title)}</span>${s.personnel_tbd?'<b class=\"twotbd\">未定</b>':''}</div>`).join(''):'<div class=\"twonone\">予定なし</div>';
  return `<div class=\"twoday ${today?'today':''}\">
    <div class=\"twodate\"><b>${d.getDate()}</b><span>（${'日月火水木金土'[d.getDay()]}）</span></div>
    <div class=\"twosites\">${rows}</div>
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
}"""

if old not in t:
    raise SystemExit('calendar block not found')
t=t.replace(old,new,1)

t=t.replace("$('prev').onclick=()=>{cur=new Date(cur.getFullYear(),cur.getMonth()-1,1);calendar()};","$('prev').onclick=()=>{cur=add(weekStart(cur),-14);calendar()};")
t=t.replace("$('next').onclick=()=>{cur=new Date(cur.getFullYear(),cur.getMonth()+1,1);calendar()};","$('next').onclick=()=>{cur=add(weekStart(cur),14);calendar()};")
p.write_text(t,encoding='utf-8')

idx=Path('index.html')
i=idx.read_text(encoding='utf-8')
oldsec='<section id="cal" class="view hide"><div class="bar"><button id="prev" class="mini">‹</button><h2 id="month" style="margin:0"></h2><button id="next" class="mini">›</button></div><div class="week"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div><div id="grid" class="grid"></div><div id="dayList"></div></section>'
newsec='<section id="cal" class="view hide"><div class="twotop"><button id="prev" class="mini">‹ 前の2週間</button><div class="twotitle"><h2 id="month"></h2><small>営業所全体の現場</small></div><button id="next" class="mini">次の2週間 ›</button></div><div class="twohead"><span id="weekA"></span><span id="weekB"></span></div><div id="grid" class="twogrid"></div></section>'
if oldsec not in i:
    raise SystemExit('calendar html section not found')
i=i.replace(oldsec,newsec,1)
i=i.replace('<button class="nav" data-v="cal">▦<small>カレンダー</small></button>','<button class="nav" data-v="cal">▦<small>2週間</small></button>',1)
i=i.replace('20260814-2036','20260814-2052')
idx.write_text(i,encoding='utf-8')

css=Path('app.css')
c=css.read_text(encoding='utf-8')
add='''.twotop{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;margin-bottom:10px}.twotitle{text-align:center;min-width:0}.twotitle h2{margin:0;font-size:17px}.twotitle small{display:block;margin-top:2px;color:var(--mut);font-size:9px}.twohead{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}.twohead span{text-align:center;font-size:11px;font-weight:900;color:#475569;background:#eef2f7;border-radius:9px;padding:7px}.twogrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.twoday{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;min-height:92px}.twoday.today{border:2px solid var(--ink)}.twodate{display:flex;align-items:baseline;gap:2px;padding:7px 9px;background:#f8fafc;border-bottom:1px solid var(--line)}.twoday.today .twodate{background:#eef2ff}.twodate b{font-size:15px}.twodate span{font-size:10px;color:var(--mut)}.twosites{padding:5px 7px}.twosite{display:flex;align-items:flex-start;justify-content:space-between;gap:5px;padding:5px 2px;border-bottom:1px solid #f1f5f9;font-size:11px;line-height:1.35;font-weight:750}.twosite:last-child{border-bottom:0}.twosite span{min-width:0;overflow-wrap:anywhere}.twotbd{flex:none;border:1px solid #fed7aa;background:#fff7ed;color:#b45309;border-radius:999px;padding:2px 5px;font-size:8px;line-height:1.2}.twonone{padding:8px 2px;color:#a1a1aa;font-size:10px}.twotop .mini{white-space:nowrap}@media(max-width:430px){.twotop{grid-template-columns:auto 1fr auto;gap:5px}.twotop .mini{padding:7px 7px;font-size:10px}.twotitle h2{font-size:14px}.twogrid{gap:6px}.twohead{gap:6px}.twoday{min-height:86px}.twodate{padding:6px 7px}.twosites{padding:4px 6px}.twosite{font-size:10px;padding:4px 1px}}'''
if '.twogrid{' not in c:
    c+='\n'+add+'\n'
css.write_text(c,encoding='utf-8')

sw=Path('sw.js')
s=sw.read_text(encoding='utf-8').replace("shinwa-yotei-v11","shinwa-yotei-v12").replace('20260814-2036','20260814-2052')
sw.write_text(s,encoding='utf-8')
