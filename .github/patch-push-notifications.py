from pathlib import Path

p=Path('app.js')
t=p.read_text(encoding='utf-8')

marker='async function inviteStaff(){'
if marker not in t:
    raise SystemExit('inviteStaff marker not found')

helper=r'''function pushSupported(){
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
  modal('アカウント',`<div class="stack"><b>${esc(me.display_name)}</b><span>${esc(session.user.email)}</span><span>${admin()?'管理者':'メンバー'}</span>${notificationControls()}${admin()?'<button id="inviteStaff" class="sub">社員アカウントを招待</button>':''}<button id="logout" class="sub">ログアウト</button></div>`);
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

'''
if 'function pushSupported(){' not in t:
    t=t.replace(marker,helper+marker,1)

old="""$('acct').onclick=()=>modal('アカウント',`<div class=\"stack\"><b>${esc(me.display_name)}</b><span>${esc(session.user.email)}</span><span>${admin()?'管理者':'メンバー'}</span>${admin()?'<button id=\"inviteStaff\" class=\"sub\">社員アカウントを招待</button>':''}<button id=\"logout\" class=\"sub\">ログアウト</button></div>`);

document.addEventListener('click',e=>{
  if(e.target.id==='logout')db.auth.signOut().then(()=>location.reload());
  if(e.target.id==='inviteStaff')inviteStaff();
});"""
new="""$('acct').onclick=openAccount;

document.addEventListener('click',e=>{
  if(e.target.id==='logout')db.auth.signOut().then(()=>location.reload());
  if(e.target.id==='inviteStaff')inviteStaff();
  if(e.target.id==='enablePush')enableNotifications();
  if(e.target.id==='disablePush')disableNotifications();
  if(e.target.id==='testPush')testNotification();
});"""
if old not in t:
    raise SystemExit('account block not found')
t=t.replace(old,new,1)
p.write_text(t,encoding='utf-8')

idx=Path('index.html')
i=idx.read_text(encoding='utf-8').replace('20260814-2058','20260814-2115')
idx.write_text(i,encoding='utf-8')

sw=Path('sw.js')
s=sw.read_text(encoding='utf-8')
s=s.replace("shinwa-yotei-v13","shinwa-yotei-v14").replace('20260814-2058','20260814-2115')
extra="""\nself.addEventListener('push',e=>{\n  let d={};\n  try{d=e.data?e.data.json():{}}catch{d={body:e.data?e.data.text():''}}\n  e.waitUntil(self.registration.showNotification(d.title||'シンワ予定',{\n    body:d.body||'',icon:'./icon.svg',badge:'./icon.svg',tag:d.tag||undefined,\n    data:{url:self.registration.scope}\n  }));\n});\nself.addEventListener('notificationclick',e=>{\n  e.notification.close();\n  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{\n    const c=list.find(x=>x.url.startsWith(self.registration.scope));\n    if(c)return c.focus();\n    return clients.openWindow(self.registration.scope);\n  }));\n});\n"""
if "self.addEventListener('push'" not in s:
    s+=extra
sw.write_text(s,encoding='utf-8')
