function injectRefreshStyle(){
  if(document.getElementById('refreshStyle'))return;
  const s=document.createElement('style');
  s.id='refreshStyle';
  s.textContent=`
    .header-actions{display:flex;align-items:center;gap:7px;min-width:0}
    #refreshBtn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:999px;padding:8px 11px;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer}
    #refreshBtn:active{transform:scale(.97)}
    #refreshBtn:disabled{opacity:.65;cursor:default;transform:none}
    @media(max-width:390px){#refreshBtn{padding:8px 9px;font-size:11px}.header-actions{gap:5px}}
  `;
  document.head.appendChild(s);
}

function injectRefreshButton(){
  const header=document.querySelector('#app header');
  const acct=document.getElementById('acct');
  if(!header||!acct||document.getElementById('refreshBtn'))return;
  injectRefreshStyle();
  const group=document.createElement('div');
  group.className='header-actions';
  const btn=document.createElement('button');
  btn.id='refreshBtn';
  btn.type='button';
  btn.textContent='↻ 更新';
  acct.parentNode.insertBefore(group,acct);
  group.appendChild(btn);
  group.appendChild(acct);
  btn.addEventListener('click',refreshApp);
}

async function refreshApp(){
  const btn=document.getElementById('refreshBtn');
  if(!btn||btn.disabled)return;
  btn.disabled=true;
  btn.textContent='↻ 更新中…';
  try{
    // ネットワーク上の最新版が取得できることを先に確認する。
    await fetch(`./index.html?refresh=${Date.now()}`,{cache:'no-store'});
    if('serviceWorker' in navigator){
      const reg=await navigator.serviceWorker.getRegistration();
      if(reg)await reg.update();
    }
    const toast=document.getElementById('toast');
    if(toast){
      toast.textContent='最新版に更新しています…';
      toast.classList.remove('hide');
    }
    setTimeout(()=>location.reload(),350);
  }catch(e){
    console.error('manual refresh failed',e);
    btn.disabled=false;
    btn.textContent='↻ 更新';
    const toast=document.getElementById('toast');
    if(toast){
      toast.textContent='更新できません。通信状態を確認してください';
      toast.classList.remove('hide');
      setTimeout(()=>toast.classList.add('hide'),2600);
    }
  }
}

injectRefreshButton();
