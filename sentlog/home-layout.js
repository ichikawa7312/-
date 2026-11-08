/* Sentlog home header redesign.
 * Presentation only. Move the ORIGINAL rescue / cloud / photo-status / settings
 * controls so listeners, file inputs, live status and saved records are untouched.
 * Run after the established archive, photo, and settings installers.
 */
(function(root){
'use strict';
if(!root.document||root.SentlogHomeLayout)return;
const doc=root.document;
const $=id=>doc.getElementById(id);
let installed=false,rawObserved=null,headerObserver=null,shellObserver=null,modeObserver=null,archiveObserver=null,photoObserver=null,heightObserver=null;
let actions,left,right,photoBadge,photoValue,version;
const rootEl=doc.documentElement;

function style(){
 if($('slHomeLayoutStyle'))return;
 const node=doc.createElement('style');node.id='slHomeLayoutStyle';
 node.textContent=[
 'html.sl-home-layout{--sl-home-header-height:58px}',
 'html.sl-home-layout header{box-sizing:border-box!important;display:flex!important;flex-wrap:wrap!important;align-content:center!important;align-items:center!important;gap:7px!important;width:100%;height:auto!important;min-height:58px!important;padding:7px max(12px,env(safe-area-inset-right,0px)) 7px max(12px,env(safe-area-inset-left,0px))!important}',
 'html.sl-home-layout.sl-home-view header .brand-mark,html.sl-home-layout.sl-home-view header .header-title{display:none!important}',
 'html.sl-home-layout header .pill{display:none!important}',
 'html.sl-home-layout header .status{display:none!important}',
 'html.sl-home-layout #slHomeHeaderTools{display:flex;align-items:center;gap:9px;flex:1 1 auto;min-width:0;max-width:100%;color:#f8fafc}',
 'html.sl-home-layout #slHomeHeaderLeft,html.sl-home-layout #slHomeHeaderRight{display:flex;align-items:center;gap:7px;min-width:0}',
 'html.sl-home-layout #slHomeHeaderLeft{flex:1 1 auto;flex-wrap:wrap}',
 'html.sl-home-layout #slHomeHeaderRight{flex:0 0 auto;margin-left:auto}',
 'html.sl-home-layout header #sentlogRecordRescueBtn{font-size:12px!important;min-width:78px!important;width:auto!important;height:44px!important;min-height:44px!important;padding:5px 9px!important;border-radius:8px!important;flex:0 0 auto;white-space:nowrap!important}',
 'html.sl-home-layout header #sentlogRecordRescueBtn::after{content:none!important}',
 'html.sl-home-layout header #sentlogCloudStatus{display:inline-flex!important;align-items:center;justify-content:center;min-width:0!important;width:auto!important;max-width:100%;height:44px!important;min-height:44px!important;padding:6px 9px!important;margin:0!important;font-size:11px!important;border-radius:8px!important;flex:0 1 auto;white-space:nowrap}',
 'html.sl-home-layout #slHomePhotoBadge[hidden],html.sl-home-layout #slHomeHeaderVersion[hidden]{display:none!important}',
 'html.sl-home-layout #slHomePhotoBadge{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-height:36px;white-space:nowrap;font-size:11px;font-weight:700;letter-spacing:0;font-variant-numeric:tabular-nums;color:#e2e8f0}',
 'html.sl-home-layout #slHomePhotoBadge[data-state=ok]{color:#86efac}',
 'html.sl-home-layout #slHomePhotoBadge[data-state=warn]{color:#fde68a}',
 'html.sl-home-layout #slHomePhotoBadge[data-state=error]{color:#fca5a5}',
 'html.sl-home-layout #slHomeHeaderVersion{display:inline-flex;align-items:center;justify-content:center;min-height:36px;white-space:nowrap;color:#cbd5e1;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}',
 'html.sl-home-layout header #sentlogSettingsBtn{display:inline-flex!important;align-items:center;justify-content:center;min-width:44px!important;width:44px!important;min-height:44px!important;height:44px!important;padding:0!important;margin:0!important;background:#253246!important;border:1px solid #475569!important;color:#f8fafc!important;border-radius:9px!important;font-size:23px!important;font-weight:500!important;line-height:1!important;flex:0 0 44px;touch-action:manipulation}',
 'html.sl-home-layout header #sentlogSettingsBtn:hover{background:#334155!important}',
 'html.sl-home-layout header button:focus-visible{outline:3px solid #38bdf8!important;outline-offset:2px}',
 'html.sl-home-layout #slPhotoRedeliveryStatus.sl-home-photo-original{position:absolute!important;clip:rect(0,0,0,0)!important;clip-path:inset(50%)!important;width:1px!important;height:1px!important;overflow:hidden!important;white-space:nowrap!important;padding:0!important;margin:0!important;border:0!important}',
 'html.sl-home-layout #sentlogSettingsFooter:empty{display:none!important}',
 'html.sl-home-layout #projectsView .manager-brand-sub,html.sl-home-layout #projectsView .manager-head p{display:none!important}',
 'html.sl-home-layout #projectsView .manager-brand{margin-bottom:14px}',
 'html.sl-home-layout #projectsView .manager-head{margin-bottom:12px}',
 'html.sl-home-layout #projectsView #slArchiveListTitle{display:none!important}',
 'html.sl-home-layout #projectsView #slArchiveMessage:empty{display:none!important}',
 'html.sl-home-layout #projectsView #slPeerPhotosList{display:none!important}',
 'html.sl-home-layout #projectsView .sentlog-build,html.sl-home-layout #drawingsView .sentlog-build{display:none!important}',
 'html.sl-home-layout .manager-screen,html.sl-home-layout .workspace,html.sl-home-layout .app{height:calc(100vh - var(--sl-home-header-height))!important;height:calc(100dvh - var(--sl-home-header-height))!important}',
 'html.sl-home-layout .sidebar{top:var(--sl-home-header-height)!important}',
 '@media(max-width:700px){html.sl-home-layout header{padding-inline:10px!important}html.sl-home-layout #slHomeHeaderTools{flex:1 1 100%;flex-wrap:wrap;row-gap:2px}html.sl-home-layout #slHomeHeaderLeft{flex:1 1 100%;gap:5px}html.sl-home-layout #slHomeHeaderRight{width:100%;justify-content:flex-end;gap:9px}html.sl-home-layout header #sentlogRecordRescueBtn{min-width:54px!important;width:54px!important;font-size:11px!important;padding:4px 5px!important}html.sl-home-layout #slHomePhotoBadge{font-size:10px}html.sl-home-layout .manager-screen{padding-top:12px!important}}',
 '@media(max-width:700px) and (pointer:coarse){html.sl-home-layout header{padding-top:calc(7px + max(24px,env(safe-area-inset-top,0px)))!important}}',
 'html.sl-home-layout.sentlog-phone header{padding-top:calc(7px + max(54px,env(safe-area-inset-top,0px)))!important}',
 '@media(min-width:701px) and (pointer:coarse){html.sl-home-layout header{padding-top:calc(7px + max(20px,env(safe-area-inset-top,0px)))!important}}',
 '@media(max-width:400px){html.sl-home-layout #slHomeHeaderLeft{gap:4px}html.sl-home-layout header #sentlogCloudStatus{font-size:10px!important;padding:5px 6px!important}html.sl-home-layout #slHomePhotoBadge{font-size:10px;letter-spacing:-.025em}html.sl-home-layout #slHomeHeaderRight{gap:7px}}',
 'html.sl-home-layout:not(.sl-home-view) #slHomePhotoBadge,html.sl-home-layout:not(.sl-home-view) #slHomeHeaderRight{display:none!important}',
 'html.sl-home-layout:not(.sl-home-view) header #sentlogRecordRescueBtn{display:none!important}',
 'html.sl-home-layout:not(.sl-home-view) header .header-title{max-width:min(55vw,600px);flex:1 1 auto}',
 '@media(max-width:700px){html.sl-home-layout:not(.sl-home-view) header .header-title{max-width:none!important;flex:1 1 50%;font-size:13px}html.sl-home-layout:not(.sl-home-view) #slHomeHeaderTools{flex-basis:100%}html.sl-home-layout:not(.sl-home-view) #slHomeHeaderLeft{justify-content:flex-end}}'
 ].join('');
 doc.head.appendChild(node);
}
function box(tag,id){
 const el=doc.createElement(tag);el.id=id;return el;
}
function buildBar(){
 const header=doc.querySelector('body > header');
 if(!header)return false;
 actions=$('slHomeHeaderTools');
 if(!actions){
   actions=box('div','slHomeHeaderTools');left=box('div','slHomeHeaderLeft');right=box('div','slHomeHeaderRight');
   photoBadge=box('span','slHomePhotoBadge');photoValue=box('span','slHomePhotoValue');
   photoBadge.setAttribute('role','group');photoBadge.setAttribute('aria-label','写真の確認状況');
   photoBadge.append(photoValue);
   photoBadge.hidden=true;
   version=box('span','slHomeHeaderVersion');version.title='セントログのバージョン';
   left.append(photoBadge);right.append(version);actions.append(left,right);
   header.append(actions);
 }else{
   left=$('slHomeHeaderLeft');right=$('slHomeHeaderRight');photoBadge=$('slHomePhotoBadge');
   photoValue=$('slHomePhotoValue');version=$('slHomeHeaderVersion');
 }
 return !!(left&&right&&photoBadge&&version);
}
function updateVersion(){
 const text=String(root.SENTLOG_BUILD||'').trim();
 const original=doc.querySelector('body > header .pill')?.textContent||'';
 const fromOriginal=original.match(/\bv\d+(?:\.\d+)+\b/);
 const value=/^v\d+(?:\.\d+)+$/.test(text)?text:fromOriginal?.[0]||'';
 if(version){version.textContent=value;version.hidden=!value;}
}
function updatePhoto(){
 if(!photoBadge||!photoValue)return;
 const source=$('slPhotoRedeliveryStatus'),full=source?.textContent?.trim()||'';
 const ratio=full.match(/写真\s*(\d+)\s*\/\s*(\d+)\s*件/)||full.match(/確認済み\s*(\d+)\s*\/\s*(\d+)\s*件/);
 const error=/要確認|確認が必要|確認できません|未保存|不足|失敗|エラー|一致しません|取得不可/.test(full);
 const waiting=/再取得待ち|未受信|待機|処理中/.test(full);
 photoBadge.hidden=!ratio&&!error&&!waiting;
 if(photoBadge.hidden)return;
 const state=error?'error':waiting?'warn':'ok';
 photoBadge.dataset.state=state;
 photoValue.textContent='📷 '+(ratio?ratio[1]+'/'+ratio[2]:(error?'要確認':'確認中'))+' '+(state==='ok'?'✓':state==='warn'?'…':'!');
 photoBadge.title=full;
 photoBadge.setAttribute('aria-label',full||'写真の確認状況');
}
function moveControls(){
 if(!buildBar())return;
 const rescue=$('sentlogRecordRescueBtn');
 if(rescue&&rescue.parentElement!==left)left.prepend(rescue);
 const cloud=$('sentlogCloudStatus');
 if(cloud&&cloud.parentElement!==left)left.insertBefore(cloud,photoBadge);
 const settings=$('sentlogSettingsBtn');
 if(settings){
   settings.textContent='⚙';
   settings.setAttribute('aria-label','設定を開く');
   settings.title='設定';
   if(settings.parentElement!==right)right.append(settings);
 }
 const photo=$('slPhotoRedeliveryStatus');
 if(photo){
   if(photo.parentElement!==photoBadge)photoBadge.append(photo);
   photo.classList.add('sl-home-photo-original');
   if(rawObserved!==photo){
     if(photoObserver)photoObserver.disconnect();
     photoObserver=new MutationObserver(updatePhoto);
     photoObserver.observe(photo,{childList:true,characterData:true,subtree:true});
     rawObserved=photo;
   }
 }
 updateVersion();updatePhoto();
}
function updateArchiveHeading(){
 const heading=doc.querySelector('#projectsView .manager-head h1');
 if(!heading)return;
 const back=$('slArchiveBack'),archived=!!back&&!back.hidden;
 heading.textContent=archived?'保管':'案件一覧';
 const tools=$('slArchiveListTitle')?.closest('.sl-archive-tools');
 if(tools)tools.style.display=archived?'flex':'none';
}
function refreshView(){
 const projects=$('projectsView');
 const home=!!projects&&!projects.classList.contains('hidden');
 rootEl.classList.toggle('sl-home-view',home);
 if(home)updateArchiveHeading();
}
function measureHeader(){
 const h=doc.querySelector('body > header');
 if(!h)return;
 const px=Math.max(1,Math.ceil(h.getBoundingClientRect().height));
 const next=px+'px';
 if(rootEl.style.getPropertyValue('--sl-home-header-height')!==next)
   rootEl.style.setProperty('--sl-home-header-height',next);
}
function install(){
 if(installed)return;
 installed=true;style();
 rootEl.classList.add('sl-home-layout');
 moveControls();refreshView();measureHeader();
 const header=doc.querySelector('body > header');
 if(header){
   headerObserver=new MutationObserver(()=>{moveControls();measureHeader();});
   headerObserver.observe(header,{childList:true,subtree:false});
   if(root.ResizeObserver){
     heightObserver=new ResizeObserver(measureHeader);heightObserver.observe(header);
   }
 }
 const project=$('projectsView');
 if(project){
   modeObserver=new MutationObserver(refreshView);
   modeObserver.observe(project,{attributes:true,attributeFilter:['class']});
   const shell=project.querySelector('.manager-shell');
   if(shell){
     shellObserver=new MutationObserver(()=>moveControls());
     shellObserver.observe(shell,{childList:true});
   }
 }
 const archive=$('slArchiveBack');
 if(archive){
   archiveObserver=new MutationObserver(updateArchiveHeading);
   archiveObserver.observe(archive,{attributes:true,attributeFilter:['hidden']});
 }
 // Recheck installers which run after the app-ready promise, without
 // repeating navigation, syncing or any write to workspace/IndexedDB.
 root.setTimeout(()=>{moveControls();refreshView();measureHeader();},1100);
}
root.SentlogHomeLayout={install,refreshView,moveControls,updatePhoto,updateVersion,measureHeader};
Promise.resolve(root.sentlogAppReady).then(install).catch(e=>console.error('Sentlog home layout setup',e));
})(typeof window==='object'?window:globalThis);
