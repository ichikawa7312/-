from pathlib import Path
import re

p=Path('app.js')
t=p.read_text(encoding='utf-8')

# owner helper
needle="function admin(){return me?.role==='admin'}\n"
if needle not in t: raise SystemExit('admin helper not found')
t=t.replace(needle,needle+"function owner(){return me?.display_name==='市川健太郎'&&String(session?.user?.email||'').toLowerCase()==='kentaro.i@shinwa-kensa.co.jp'}\n",1)

# atomic off save
pat=r"async function saveOff\(e\)\{.*?\n\}\n\nfunction edit\(id\)\{"
new=r'''async function saveOff(e){
  e.preventDefault();
  const date=$('offDate').value;
  const ids=[...document.querySelectorAll('input[name="offstaff"]:checked')].map(x=>x.value);
  const r=await db.rpc('admin_set_off_day',{p_work_date:date,p_staff_ids:ids});
  if(r.error){console.error(r.error);return toast('休み設定を保存できません')}
  closeM();
  await refresh();
  toast(ids.length?`${ids.length}名を休みに設定しました`:'休み設定を解除しました');
}

function edit(id){'''
t,n=re.subn(pat,new,t,count=1,flags=re.S)
if n!=1: raise SystemExit('saveOff block not found')

# atomic schedule save/delete
pat=r"async function saveSchedule\(e,s\)\{.*?\n\}\n\nasync function delSchedule\(s\)\{.*?\n\}\n\nfunction departure\(id\)\{"
new=r'''async function saveSchedule(e,s){
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

function departure(id){'''
t,n=re.subn(pat,new,t,count=1,flags=re.S)
if n!=1: raise SystemExit('schedule save/delete block not found')

# account/admin tools/audit/password helpers before invite
marker='async function inviteStaff(){'
if marker not in t: raise SystemExit('invite marker not found')
helper=r'''async function adminToolsRequest(action,extra={},withAuth=true){
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

'''
if 'async function adminToolsRequest(' not in t:
    t=t.replace(marker,helper+marker,1)

# owner account button
old='''function openAccount(){
  modal('アカウント',`<div class="stack"><b>${esc(me.display_name)}</b><span>${esc(session.user.email)}</span><span>${admin()?'管理者':'メンバー'}</span>${notificationControls()}${admin()?'<button id="inviteStaff" class="sub">社員アカウントを招待</button>':''}<button id="logout" class="sub">ログアウト</button></div>`);
}'''
new='''function openAccount(){
  modal('アカウント',`<div class="stack"><b>${esc(me.display_name)}</b><span>${esc(session.user.email)}</span><span>${admin()?'管理者':'メンバー'}</span>${notificationControls()}${admin()?'<button id="inviteStaff" class="sub">社員アカウントを招待</button>':''}${owner()?'<button id="passwordResetAdmin" class="sub">社員パスワード再設定</button>':''}<button id="logout" class="sub">ログアウト</button></div>`);
}'''
if old not in t: raise SystemExit('openAccount block not found')
t=t.replace(old,new,1)

# query params and reset views
old="const qp=new URLSearchParams(location.search),prefill=qp.get('email')||'',activationToken=qp.get('activate')||'';\n$('le').value=prefill;\n$('se').value=prefill;\nif(activationToken){\n  $('login').classList.add('hide');\n  $('signup').classList.remove('hide');\n  $('se').readOnly=true;\n}\n"
new="""const qp=new URLSearchParams(location.search),prefill=qp.get('email')||'',activationToken=qp.get('activate')||'',managedResetToken=qp.get('reset')||'';
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
"""
if old not in t: raise SystemExit('qp block not found')
t=t.replace(old,new,1)

# forgot/reset handlers before mine click
marker="$('mine').onclick=()=>{"
if marker not in t: raise SystemExit('mine marker not found')
handlers=r'''$('forgotPassword').onclick=async()=>{
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

'''
t=t.replace(marker,handlers+marker,1)

# static button handlers
old="$('new').onclick=()=>edit();\n$('off').onclick=()=>editOff();\n"
new="$('new').onclick=()=>edit();\n$('off').onclick=()=>editOff();\n$('historyBtn').onclick=showAudit;\n"
if old not in t: raise SystemExit('manage button block not found')
t=t.replace(old,new,1)

old="  if(e.target.id==='inviteStaff')inviteStaff();\n  if(e.target.id==='enablePush')enableNotifications();"
new="  if(e.target.id==='inviteStaff')inviteStaff();\n  if(e.target.id==='passwordResetAdmin')passwordResetAdmin();\n  if(e.target.id==='enablePush')enableNotifications();"
if old not in t: raise SystemExit('click handler block not found')
t=t.replace(old,new,1)

# startup respects reset flows
old="""(async()=>{
  const r=await db.auth.getSession();
  session=r.data.session;
  if(session)enter();else authView();
})();"""
new="""(async()=>{
  const r=await db.auth.getSession();
  session=r.data.session;
  if(managedResetToken)return showManagedReset();
  if(ownerRecoveryRequested&&session)return showOwnerRecovery();
  if(session)enter();else authView();
})();"""
if old not in t: raise SystemExit('startup block not found')
t=t.replace(old,new,1)

p.write_text(t,encoding='utf-8')

# index changes
idx=Path('index.html')
i=idx.read_text(encoding='utf-8')
i=i.replace('<button type="button" id="goSignup" class="sub">初めて使う方はこちら</button><div id="lm" class="err"></div>', '<button type="button" id="goSignup" class="sub">初めて使う方はこちら</button><button type="button" id="forgotPassword" class="sub">パスワードを忘れた場合</button><div id="lm" class="err"></div>')
insert='''
<form id="managedReset" class="stack hide"><p><b>パスワード再設定</b><br>新しいパスワードを本人が設定します。</p><label>メールアドレス<input id="mre" type="email" readonly></label><label>新しいパスワード<input id="mrp" type="password" minlength="8" autocomplete="new-password" required></label><label>パスワード確認<input id="mrp2" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn">新しいパスワードを設定</button><div id="mrm" class="err"></div></form>
<form id="ownerReset" class="stack hide"><p><b>市川さんのパスワード再設定</b><br>登録メールから開いた本人用の画面です。</p><label>新しいパスワード<input id="orp" type="password" minlength="8" autocomplete="new-password" required></label><label>パスワード確認<input id="orp2" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn">新しいパスワードを設定</button><div id="orm" class="err"></div></form>
'''
needle='</form>\n</div></section>'
pos=i.find(needle,i.find('id="signup"'))
if pos<0: raise SystemExit('auth insert point not found')
i=i[:pos+7]+insert+i[pos+7:]
i=i.replace('<div style="display:flex;gap:6px"><button id="off" class="sub">休み設定</button><button id="new" class="btn">＋予定追加</button></div>', '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button id="historyBtn" class="sub">更新履歴</button><button id="off" class="sub">休み設定</button><button id="new" class="btn">＋予定追加</button></div>')
i=i.replace('20260814-2115','20260814-2145')
idx.write_text(i,encoding='utf-8')

# service worker cache bump
sw=Path('sw.js')
s=sw.read_text(encoding='utf-8').replace("shinwa-yotei-v14","shinwa-yotei-v15").replace('20260814-2115','20260814-2145')
sw.write_text(s,encoding='utf-8')
