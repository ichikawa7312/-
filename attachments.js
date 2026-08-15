import{createClient}from'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/+esm';

const db=createClient(
  'https://dbupdbrjakandkppptix.supabase.co',
  'sb_publishable_c2f_qk0pmZy-0eaqqJh2FA_f8MU-iZ1'
);

const $=x=>document.getElementById(x);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[m]));

let attachments=[];
let editScheduleId=null;
let retained=[];
let staged=[];
let editorNonce=0;

function toast(t){
  const el=$('toast');
  if(!el)return;
  el.textContent=t;
  el.classList.remove('hide');
  setTimeout(()=>el.classList.add('hide'),2400);
}

function showModal(title,html){
  if(!$('mt')||!$('mb')||!$('shade')||!$('modal'))return;
  $('mt').textContent=title;
  $('mb').innerHTML=html;
  $('shade').classList.remove('hide');
  $('modal').classList.remove('hide');
}

function forSchedule(id){
  return attachments
    .filter(x=>x.schedule_id===id)
    .sort((a,b)=>(a.sort_order??0)-(b.sort_order??0)||String(a.created_at||'').localeCompare(String(b.created_at||'')));
}

async function loadAttachments(){
  const r=await db.from('schedule_attachments').select('*').order('sort_order');
  if(r.error){
    console.warn('instruction attachments load failed',r.error);
    return;
  }
  attachments=r.data||[];
  patchInstructionButtons();
}

function attachmentLabel(list){
  if(!list.length)return '指示書なし';
  if(list.length===1)return list[0].file_name||'指示書 1件';
  return `指示書 ${list.length}件`;
}

function patchInstructionButtons(){
  document.querySelectorAll('[id^="detail-"]').forEach(detail=>{
    const id=detail.id.slice('detail-'.length);
    const box=detail.querySelector('.pdf');
    if(!box)return;
    const list=forSchedule(id);
    const sig=list.map(x=>x.id).join('|')||'none';
    if(box.dataset.attachmentSig===sig)return;
    box.dataset.attachmentSig=sig;
    box.innerHTML=`<span>${esc(attachmentLabel(list))}</span><button class="smallbtn" ${list.length?`data-ins="${esc(id)}"`:'disabled'}>${list.length?'指示書を見る':'添付なし'}</button>`;
  });
}

function injectStyle(){
  if($('instructionStyle'))return;
  const s=document.createElement('style');
  s.id='instructionStyle';
  s.textContent=`
    .ins-tools{border:1px solid #dbe3ec;border-radius:12px;padding:10px;background:#f8fafc}
    .ins-title{font-weight:700;margin-bottom:7px}
    .ins-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
    .ins-action{border:1px solid #cbd5e1;background:white;border-radius:10px;padding:10px 6px;font-weight:700;font-size:12px}
    .ins-action:active{transform:scale(.98)}
    .ins-note{font-size:11px;color:#64748b;line-height:1.45;margin-top:7px}
    .ins-list{display:flex;flex-direction:column;gap:6px;margin-top:9px}
    .ins-row{display:flex;align-items:center;gap:8px;background:white;border:1px solid #e2e8f0;border-radius:9px;padding:8px}
    .ins-row-main{min-width:0;flex:1}
    .ins-row-main b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .ins-row-main small{color:#64748b;font-size:10px}
    .ins-remove{border:0;background:#fff1f2;color:#be123c;border-radius:8px;padding:7px 9px;font-size:11px;font-weight:700}
    .ins-view{display:flex;flex-direction:column;gap:12px}
    .ins-page{border:1px solid #e2e8f0;border-radius:12px;padding:10px;background:#fff}
    .ins-page-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;font-size:11px;color:#64748b}
    .ins-photo{display:block;width:100%;height:auto;border-radius:8px;background:#f1f5f9}
    .ins-open{width:100%;margin-top:8px}
    @media(max-width:480px){.ins-actions{grid-template-columns:1fr}.ins-action{padding:11px}}
  `;
  document.head.appendChild(s);
}

function typeText(mime){
  if(mime==='application/pdf')return 'PDF';
  if(String(mime).startsWith('image/'))return '写真';
  return 'ファイル';
}

function renderEditorList(){
  const el=$('instructionList');
  if(!el)return;
  const rows=[
    ...retained.map((a,i)=>({kind:'keep',i,name:a.file_name,mime:a.mime_type})),
    ...staged.map((x,i)=>({kind:'new',i,name:x.file.name,mime:x.file.type||guessMime(x.file.name)}))
  ];
  el.innerHTML=rows.length?rows.map(x=>`<div class="ins-row">
    <div class="ins-row-main"><b>${esc(x.name)}</b><small>${x.kind==='new'?'追加予定・':''}${esc(typeText(x.mime))}</small></div>
    <button type="button" class="ins-remove" data-ins-rm="${x.kind}" data-ins-index="${x.i}">削除</button>
  </div>`).join(''):'<div class="ins-note">指示書はまだ添付されていません。</div>';

  el.querySelectorAll('[data-ins-rm]').forEach(b=>b.onclick=()=>{
    const i=Number(b.dataset.insIndex);
    if(b.dataset.insRm==='keep')retained.splice(i,1);
    else staged.splice(i,1);
    renderEditorList();
  });
}

function guessMime(name){
  const n=String(name||'').toLowerCase();
  if(n.endsWith('.pdf'))return 'application/pdf';
  if(n.endsWith('.png'))return 'image/png';
  if(n.endsWith('.webp'))return 'image/webp';
  if(n.endsWith('.heic'))return 'image/heic';
  if(n.endsWith('.heif'))return 'image/heif';
  return 'image/jpeg';
}

function addStaged(files){
  for(const file of files){
    const mime=file.type||guessMime(file.name);
    if(!(mime==='application/pdf'||mime.startsWith('image/')))continue;
    staged.push({file});
  }
  renderEditorList();
}

async function setupInstructionEditor(){
  const form=$('sf');
  const old=$('fp');
  if(!form||!old||$('instructionTools'))return;

  const nonce=++editorNonce;
  staged=[];
  retained=[];
  const legacyLabel=old.closest('label');
  if(legacyLabel)legacyLabel.style.display='none';

  const wrap=document.createElement('div');
  wrap.id='instructionTools';
  wrap.className='ins-tools';
  wrap.innerHTML=`<div class="ins-title">指示書</div>
    <div class="ins-actions">
      <button type="button" id="takeInstructionPhoto" class="ins-action">📷 写真を撮る</button>
      <button type="button" id="pickInstructionPhoto" class="ins-action">🖼 写真を選ぶ</button>
      <button type="button" id="pickInstructionPdf" class="ins-action">📄 PDFを選ぶ</button>
    </div>
    <input id="instructionCamera" type="file" accept="image/*" capture="environment" hidden>
    <input id="instructionPhotos" type="file" accept="image/*" multiple hidden>
    <input id="instructionPdfs" type="file" accept="application/pdf,.pdf" multiple hidden>
    <div class="ins-note">紙の指示書は「写真を撮る」でそのまま撮影できます。写真は文字が読める画質を保ちながら自動で軽量化します。複数枚も追加できます。</div>
    <div id="instructionList" class="ins-list"><div class="ins-note">読み込み中…</div></div>`;
  if(legacyLabel)legacyLabel.insertAdjacentElement('afterend',wrap);
  else form.insertBefore(wrap,form.querySelector('.actions'));

  $('takeInstructionPhoto').onclick=()=>$('instructionCamera').click();
  $('pickInstructionPhoto').onclick=()=>$('instructionPhotos').click();
  $('pickInstructionPdf').onclick=()=>$('instructionPdfs').click();
  $('instructionCamera').onchange=e=>{addStaged([...e.target.files]);e.target.value=''};
  $('instructionPhotos').onchange=e=>{addStaged([...e.target.files]);e.target.value=''};
  $('instructionPdfs').onchange=e=>{addStaged([...e.target.files]);e.target.value=''};

  if(editScheduleId){
    let list=forSchedule(editScheduleId);
    if(!list.length){
      const r=await db.from('schedule_attachments').select('*').eq('schedule_id',editScheduleId).order('sort_order');
      if(!r.error)list=r.data||[];
    }
    if(nonce!==editorNonce||!$('instructionTools'))return;
    retained=list.map(x=>({...x}));
  }
  renderEditorList();
}

function loadImage(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>resolve({img,url});
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('image_decode_failed'))};
    img.src=url;
  });
}

async function prepareFile(file){
  const mime=file.type||guessMime(file.name);
  if(!mime.startsWith('image/'))return {file,mime:'application/pdf',name:file.name};

  try{
    const {img,url}=await loadImage(file);
    const maxSide=2200;
    const scale=Math.min(1,maxSide/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    const w=Math.max(1,Math.round((img.naturalWidth||img.width)*scale));
    const h=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
    const canvas=document.createElement('canvas');
    canvas.width=w; canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    ctx.drawImage(img,0,0,w,h);
    URL.revokeObjectURL(url);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.84));
    if(!blob)throw new Error('jpeg_encode_failed');
    const base=String(file.name||'instruction').replace(/\.[^.]+$/,'')||'instruction';
    const name=`${base}.jpg`;
    return {file:new File([blob],name,{type:'image/jpeg',lastModified:Date.now()}),mime:'image/jpeg',name};
  }catch(e){
    console.warn('image compression skipped',e);
    return {file,mime,name:file.name||`instruction.${mime.split('/')[1]||'jpg'}`};
  }
}

function extFor(mime){
  if(mime==='application/pdf')return 'pdf';
  if(mime==='image/png')return 'png';
  if(mime==='image/webp')return 'webp';
  if(mime==='image/heic')return 'heic';
  if(mime==='image/heif')return 'heif';
  return 'jpg';
}

async function uploadNewFiles(group){
  const out=[];
  for(let i=0;i<staged.length;i++){
    toast(`指示書を保存中… ${i+1}/${staged.length}`);
    const p=await prepareFile(staged[i].file);
    const path=`${group}/${Date.now()}_${crypto.randomUUID()}.${extFor(p.mime)}`;
    const r=await db.storage.from('instructions').upload(path,p.file,{contentType:p.mime,upsert:false});
    if(r.error)throw r.error;
    out.push({storage_path:path,file_name:p.name,mime_type:p.mime});
  }
  return out;
}

async function saveScheduleV2(form){
  const tbd=$('personnelTbd')?.value==='1';
  const picked=[...document.querySelectorAll('input[name="staff"]:checked')].map(x=>x.value);
  const memberIds=tbd?[]:picked;
  if(!tbd&&!memberIds.length)return toast('現場人員を選択してください');

  const dates=[...new Set([...document.querySelectorAll('input[name="workdate"]')].map(x=>x.value).filter(Boolean))];
  if(!dates.length)return toast('作業日を選択してください');

  const title=$('ft')?.value.trim();
  if(!title)return toast('現場名を入力してください');

  const saveButton=form.querySelector('button.btn.grow,button.btn[type="submit"],button.btn:not([type])');
  if(saveButton){saveButton.disabled=true;saveButton.textContent='保存中…'}

  try{
    const group=editScheduleId||crypto.randomUUID();
    const uploaded=await uploadNewFiles(group);
    const payload=[
      ...retained.map(x=>({storage_path:x.storage_path,file_name:x.file_name,mime_type:x.mime_type})),
      ...uploaded
    ];

    const r=await db.rpc('admin_save_schedule_bundle_v2',{
      p_schedule_id:editScheduleId||null,
      p_dates:dates,
      p_title:title,
      p_site_start_time:$('ftime')?.value||null,
      p_personnel_tbd:tbd,
      p_member_ids:memberIds,
      p_attachments:payload
    });
    if(r.error)throw r.error;

    sessionStorage.setItem('shinwaSavedMessage',r.data?.departures_reset?'保存しました（人員変更のため出発予定を削除）':'保存しました');
    location.reload();
  }catch(e){
    console.error('schedule v2 save failed',e);
    toast('予定を保存できませんでした');
    if(saveButton){saveButton.disabled=false;saveButton.textContent='保存'}
  }
}

async function signedItems(id){
  let list=forSchedule(id);
  if(!list.length){
    const q=await db.from('schedule_attachments').select('*').eq('schedule_id',id).order('sort_order');
    if(q.error)throw q.error;
    list=q.data||[];
  }
  const out=[];
  for(const a of list){
    const r=await db.storage.from('instructions').createSignedUrl(a.storage_path,600);
    if(!r.error)out.push({...a,url:r.data.signedUrl});
  }
  return out;
}

async function openInstructions(id){
  showModal('指示書','<div class="center" style="min-height:120px">読み込み中…</div>');
  try{
    const list=await signedItems(id);
    if(!list.length){
      $('mb').innerHTML='<div class="empty">指示書はありません</div>';
      return;
    }
    $('mb').innerHTML=`<div class="ins-view">${list.map((a,i)=>{
      const image=String(a.mime_type).startsWith('image/');
      return `<section class="ins-page">
        <div class="ins-page-head"><b>${i+1}/${list.length}</b><span>${esc(a.file_name)}</span></div>
        ${image
          ? `<img class="ins-photo" src="${esc(a.url)}" alt="${esc(a.file_name)}"><button type="button" class="sub ins-open" data-ins-url="${esc(a.url)}">画像を別画面で開く</button>`
          : `<div style="padding:18px 8px;text-align:center"><b>📄 ${esc(a.file_name)}</b></div><button type="button" class="btn ins-open" data-ins-url="${esc(a.url)}">PDFを開く</button>`}
      </section>`;
    }).join('')}</div>`;
  }catch(e){
    console.error(e);
    $('mb').innerHTML='<div class="empty">指示書を開けませんでした</div>';
  }
}

async function cleanupLater(){
  try{
    const sr=await db.auth.getSession();
    const token=sr.data.session?.access_token;
    if(!token)return;
    await fetch('https://dbupdbrjakandkppptix.supabase.co/functions/v1/admin-tools',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify({action:'cleanup-pdfs'})
    });
  }catch(e){console.warn('attachment cleanup deferred',e)}
}

document.addEventListener('click',e=>{
  const edit=e.target.closest?.('[data-e]');
  if(edit)editScheduleId=edit.dataset.e||null;
  if(e.target.closest?.('#new'))editScheduleId=null;

  const open=e.target.closest?.('[data-ins]');
  if(open){
    e.preventDefault();
    e.stopImmediatePropagation();
    openInstructions(open.dataset.ins);
    return;
  }
  const u=e.target.closest?.('[data-ins-url]');
  if(u){
    e.preventDefault();
    const w=window.open(u.dataset.insUrl,'_blank');
    if(!w)location.href=u.dataset.insUrl;
  }
},true);

document.addEventListener('submit',e=>{
  if(e.target?.id!=='sf'||!$('instructionTools'))return;
  e.preventDefault();
  e.stopImmediatePropagation();
  saveScheduleV2(e.target);
},true);

const observer=new MutationObserver(()=>{
  injectStyle();
  patchInstructionButtons();
  setupInstructionEditor().catch(console.error);
});
observer.observe(document.documentElement,{subtree:true,childList:true});

db.auth.onAuthStateChange((_event,s)=>{
  if(s)setTimeout(()=>loadAttachments().catch(console.error),0);
  else attachments=[];
});

(async()=>{
  injectStyle();
  const msg=sessionStorage.getItem('shinwaSavedMessage');
  if(msg){
    sessionStorage.removeItem('shinwaSavedMessage');
    setTimeout(()=>toast(msg),900);
    cleanupLater();
  }
  const sr=await db.auth.getSession();
  if(sr.data.session)await loadAttachments();
  patchInstructionButtons();
  setupInstructionEditor().catch(console.error);
})();
