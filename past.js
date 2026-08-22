import{createClient}from'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';

const db=createClient(
  'https://dbupdbrjakandkppptix.supabase.co',
  'sb_publishable_c2f_qk0pmZy-0eaqqJh2FA_f8MU-iZ1'
);
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[m]));
function iso(d){const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10)}
function add(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
const TODAY=iso(new Date());
const CUTOFF=iso(add(new Date(),-30));
let cache={schedules:[],staff:[],members:[],confs:[],deps:[],dm:[],attachments:[]};
let loaded=false;
let pastIds=new Set();

function injectStyle(){
  if($('pastStyle'))return;
  const s=document.createElement('style');
  s.id='pastStyle';
  s.textContent=`
    .pastintro{font-size:12px;color:#64748b;margin:2px 0 12px;line-height:1.5}
    .pastday{margin-bottom:12px;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;background:#fff}
    .pastdayhead{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:#f8fafc;border-bottom:1px solid #e2e8f0}
    .pastdayhead span{font-size:11px;color:#64748b}
    .pastsite{padding:10px 11px;border-bottom:1px solid #eef2f7}.pastsite:last-child{border-bottom:0}
    .pastsitehead{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center}
    .pastmain{min-width:0}.pastmain b{display:block}.pastmain small{display:block;color:#64748b;margin-top:2px}
    .pastpeople{font-size:11px;color:#475569;text-align:right;max-width:260px}
    .pastdetail{margin-top:9px;padding-top:9px;border-top:1px dashed #dbe3ec;font-size:12px;line-height:1.55}
    .pastline{margin-top:5px}.pastmuted{color:#64748b}
    .pastattach{display:flex;gap:7px;align-items:center;margin-top:8px}
    @media(max-width:620px){.pastsitehead{grid-template-columns:minmax(0,1fr) auto}.pastpeople{grid-column:1/-1;text-align:left;max-width:none}.pastsitehead .smallbtn{grid-column:2;grid-row:1}}
  `;
  document.head.appendChild(s);
}

function injectUI(){
  if($('past'))return;
  injectStyle();
  const main=document.querySelector('#app main');
  const nav=document.querySelector('#app nav');
  if(!main||!nav)return;
  const section=document.createElement('section');
  section.id='past';
  section.className='view hide';
  section.innerHTML=`<div class="bar"><div><h2 style="margin:0">過去の予定</h2><small style="display:block;color:#6b7280;margin-top:3px">昨日から30日前まで</small></div></div><div class="pastintro">終了した現場を確認できます。30日より前の予定は通常のアプリでは読み込みません。</div><div id="pastList"><div class="center" style="min-height:120px">読み込み中…</div></div>`;
  main.appendChild(section);

  const b=document.createElement('button');
  b.id='pastNav';b.className='nav';b.dataset.v='past';
  b.innerHTML='↶<small>過去</small>';
  const manage=$('manageNav');
  nav.insertBefore(b,manage||null);
  b.onclick=async()=>{
    document.querySelectorAll('.nav').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('.view').forEach(x=>x.classList.add('hide'));
    section.classList.remove('hide');
    await loadPast();
  };

  document.querySelectorAll('.nav:not(#pastNav)').forEach(x=>x.addEventListener('click',()=>section.classList.add('hide')));
  const ml=$('manageList');
  if(ml)new MutationObserver(hidePastFromManage).observe(ml,{childList:true,subtree:true});
  primePastIds().catch(()=>{});
}

function hidePastFromManage(){
  document.querySelectorAll('#manageList .planrow.manage').forEach(row=>{
    const id=row.querySelector('[data-e]')?.dataset.e||'';
    row.style.display=pastIds.has(id)?'none':'';
  });
}

async function primePastIds(){
  const sr=await db.auth.getSession();
  if(!sr.data.session)return;
  const q=await db.from('schedules').select('id').gte('work_date',CUTOFF).lt('work_date',TODAY);
  if(q.error)return;
  pastIds=new Set((q.data||[]).map(x=>x.id));
  hidePastFromManage();
}

async function loadPast(){
  if(loaded){renderPast();return}
  const sr=await db.auth.getSession();
  if(!sr.data.session){$('pastList').innerHTML='<div class="empty">ログインしてください</div>';return}
  $('pastList').innerHTML='<div class="center" style="min-height:120px">読み込み中…</div>';
  const [sq,stq]=await Promise.all([
    db.from('schedules').select('*').gte('work_date',CUTOFF).lt('work_date',TODAY).order('work_date',{ascending:false}).order('site_start_time'),
    db.from('staff').select('id,display_name,active').eq('active',true)
  ]);
  if(sq.error||stq.error){console.error(sq.error||stq.error);$('pastList').innerHTML='<div class="empty">過去の予定を読み込めません</div>';return}
  cache.schedules=sq.data||[];cache.staff=stq.data||[];
  const ids=cache.schedules.map(x=>x.id);
  pastIds=new Set(ids);hidePastFromManage();
  if(!ids.length){loaded=true;renderPast();return}
  const [mq,cq,dq,aq]=await Promise.all([
    db.from('schedule_members').select('*').in('schedule_id',ids),
    db.from('confirmations').select('*').in('schedule_id',ids),
    db.from('departures').select('*').in('schedule_id',ids),
    db.from('schedule_attachments').select('*').in('schedule_id',ids).order('sort_order')
  ]);
  const bad=[mq,cq,dq,aq].find(x=>x.error);
  if(bad){console.error(bad.error);$('pastList').innerHTML='<div class="empty">過去の予定を読み込めません</div>';return}
  cache.members=mq.data||[];cache.confs=cq.data||[];cache.deps=dq.data||[];cache.attachments=aq.data||[];
  const depIds=cache.deps.map(x=>x.id);
  if(depIds.length){const q=await db.from('departure_members').select('*').in('departure_id',depIds);if(!q.error)cache.dm=q.data||[]}
  loaded=true;renderPast();
}

function st(id){return cache.staff.find(x=>x.id===id)}
function members(s){return cache.members.filter(x=>x.schedule_id===s.id)}
function attachments(s){return cache.attachments.filter(x=>x.schedule_id===s.id)}
function deps(s){return cache.deps.filter(x=>x.schedule_id===s.id).sort((a,b)=>String(a.departure_time).localeCompare(String(b.departure_time)))}
function depPeople(d){return cache.dm.filter(x=>x.departure_id===d.id).map(x=>st(x.staff_id)?.display_name).filter(Boolean)}
function planDate(z){const [y,m,d]=z.split('-').map(Number);return `${m}/${d}（${'日月火水木金土'[new Date(y,m-1,d).getDay()]}）`}

function renderPast(){
  const root=$('pastList');if(!root)return;
  if(!cache.schedules.length){root.innerHTML='<div class="empty">過去30日間の予定はありません</div>';return}
  const groups=new Map();
  cache.schedules.forEach(s=>{if(!groups.has(s.work_date))groups.set(s.work_date,[]);groups.get(s.work_date).push(s)});
  root.innerHTML=[...groups.entries()].map(([date,items])=>`<section class="pastday"><div class="pastdayhead"><b>${esc(planDate(date))}</b><span>${items.length}現場</span></div>${items.map(s=>{
    const ms=members(s),people=s.personnel_tbd?'人員未定':ms.map(x=>st(x.staff_id)?.display_name).filter(Boolean).join('・')||'—';
    const done=ms.filter(x=>cache.confs.some(c=>c.schedule_id===s.id&&c.staff_id===x.staff_id&&c.revision>=s.revision)).length;
    const at=attachments(s),ds=deps(s);
    return `<div class="pastsite"><div class="pastsitehead"><div class="pastmain"><b>${esc(s.title)}</b><small>現地 ${(s.site_start_time||'').slice(0,5)||'未定'}</small></div><div class="pastpeople">${esc(people)}</div><button class="smallbtn" data-past-detail="${s.id}">詳細</button></div><div id="past-detail-${s.id}" class="pastdetail hide">${ds.length?`<div class="pastline"><b>出発：</b>${ds.map(d=>`${esc(String(d.departure_time||'').slice(0,5))} ${esc(depPeople(d).join('・'))}`).join(' ／ ')}</div>`:''}${!s.personnel_tbd?`<div class="pastline"><b>確認：</b>${done}/${ms.length}名</div>`:''}<div class="pastattach"><b>指示書：</b><span>${at.length?`${at.length}件`:'なし'}</span>${at.length?`<button class="smallbtn" data-past-ins="${s.id}">見る</button>`:''}</div></div></div>`;
  }).join('')}</section>`).join('');
  root.querySelectorAll('[data-past-detail]').forEach(b=>b.onclick=()=>{const el=$(`past-detail-${b.dataset.pastDetail}`);if(!el)return;const open=el.classList.contains('hide');el.classList.toggle('hide');b.textContent=open?'閉じる':'詳細'});
  root.querySelectorAll('[data-past-ins]').forEach(b=>b.onclick=()=>openInstructions(b.dataset.pastIns));
}

async function openInstructions(id){
  const list=cache.attachments.filter(x=>x.schedule_id===id).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
  if(!list.length)return;
  $('mt').textContent='指示書';
  $('mb').innerHTML='<div class="center" style="min-height:120px">読み込み中…</div>';
  $('shade').classList.remove('hide');$('modal').classList.remove('hide');
  const signed=[];
  for(const a of list){const r=await db.storage.from('instructions').createSignedUrl(a.storage_path,600);if(!r.error)signed.push({...a,url:r.data.signedUrl})}
  $('mb').innerHTML=signed.length?`<div class="stack">${signed.map((a,i)=>String(a.mime_type).startsWith('image/')?`<div class="box"><b>${i+1}/${signed.length} ${esc(a.file_name)}</b><img src="${esc(a.url)}" alt="指示書" style="display:block;width:100%;height:auto;margin-top:8px;border-radius:8px"></div>`:`<div class="box"><b>${i+1}/${signed.length} ${esc(a.file_name)}</b><button class="btn" style="width:100%;margin-top:8px" data-open-pdf="${esc(a.url)}">PDFを開く</button></div>`).join('')}</div>`:'<div class="empty">指示書を開けません</div>';
  $('mb').querySelectorAll('[data-open-pdf]').forEach(b=>b.onclick=()=>window.open(b.dataset.openPdf,'_blank'));
}

db.auth.onAuthStateChange((event)=>{if(event==='SIGNED_IN'){loaded=false;primePastIds().catch(()=>{})}});
injectUI();
