/* Sentlog drawing-list command bar, display-only integration.
 * Retains the original export launcher, file-picker label and sort toolbar.
 * None of the save, sync, DXF/PDF or sorting handlers are reimplemented.
 */
(function(root){
'use strict';
if(!root.document||root.SentlogDrawingListHeader)return;
const doc=root.document,$=id=>doc.getElementById(id);
const html=doc.documentElement;
let center=null,counts=null,viewObserver=null,toolbarObserver=null,installed=false,renderWrapped=false;
function onDrawingList(){return !!$('drawingsView') && !$('drawingsView').classList.contains('hidden');}
function installStyle(){
 if($('slDrawingListHeaderStyle'))return;
 const style=doc.createElement('style');style.id='slDrawingListHeaderStyle';
 style.textContent=[
 'html.sl-home-layout.sl-drawings-view header{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;align-items:center!important;align-content:center!important;justify-content:space-between!important;gap:6px!important;min-width:0}',
 'html.sl-home-layout.sl-drawings-view header .brand-mark{display:block!important;order:0!important;width:34px!important;height:34px!important;flex:0 0 34px!important}',
 'html.sl-home-layout.sl-drawings-view header #headerTitle{display:block!important;order:1!important;max-width:min(24vw,260px)!important;min-width:0!important;flex:0 1 auto!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
 'html.sl-home-layout.sl-drawings-view header #slHomeHeaderTools{order:2!important;display:flex!important;flex:1 1 0!important;min-width:0!important;width:auto!important;max-width:none!important;flex-wrap:nowrap!important;overflow:hidden!important;gap:0!important}',
 'html.sl-home-layout.sl-drawings-view header #slHomeHeaderLeft,html.sl-home-layout.sl-drawings-view header #slHomeHeaderRight{display:none!important}',
 'html.sl-home-layout.sl-drawings-view header #navBackBtn{order:99!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:70px!important;min-height:44px!important;height:44px!important;flex:0 0 auto!important;font-size:12px!important;white-space:nowrap!important;padding:6px 9px!important;border-radius:9px!important}',
 'html.sl-home-layout.sl-drawings-view header .pill,html.sl-home-layout.sl-drawings-view header .status,html.sl-home-layout.sl-drawings-view header #sentlogRecordRescueBtn,html.sl-home-layout.sl-drawings-view header #mobileSidebarBtn{display:none!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderMiddle{display:flex;align-items:center;gap:7px;flex:1 1 0;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:#64748b transparent;white-space:nowrap;touch-action:pan-x;padding:2px 1px 5px;color:#e2e8f0}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderMiddle::-webkit-scrollbar{height:3px}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderMiddle::-webkit-scrollbar-thumb{background:#64748b;border-radius:10px}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderMiddle>*{flex:0 0 auto;min-width:0}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderCounts{display:inline-flex;align-items:center;min-height:44px;padding:0 5px;color:#cbd5e1;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}',
 'html.sl-home-layout.sl-drawings-view #slDrawingExportBtn,html.sl-home-layout.sl-drawings-view #slDrawingHeaderAdd{display:inline-flex!important;align-items:center;justify-content:center;box-sizing:border-box;min-height:44px!important;height:44px!important;width:auto!important;min-width:90px!important;max-width:none!important;flex:0 0 auto!important;margin:0!important;padding:6px 12px!important;border:1px solid #475569!important;border-radius:9px!important;color:#111827!important;background:#f8fafc!important;font-size:12px!important;font-weight:700!important;cursor:pointer!important;white-space:nowrap!important;text-align:center}',
 'html.sl-home-layout.sl-drawings-view #slDrawingHeaderAdd{background:#e0f2fe!important;color:#075985!important;border-color:#7dd3fc!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar{display:flex!important;align-items:center;flex:0 0 auto!important;flex-wrap:nowrap!important;gap:6px!important;min-height:44px;margin:0!important;padding:0!important;border:none!important;border-radius:0!important;background:transparent!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar[hidden],html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar [hidden]{display:none!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar button{display:inline-flex;align-items:center;justify-content:center;min-width:92px!important;min-height:44px!important;height:44px!important;margin:0!important;padding:6px 11px!important;border-radius:9px!important;background:#f8fafc!important;border:1px solid #cbd5e1!important;color:#111827!important;font-size:12px!important;white-space:nowrap!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar button.sl-order-toggle{background:#334155!important;border-color:#64748b!important;color:#fff!important}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar [data-role=status]{position:fixed!important;z-index:20;top:var(--sl-home-header-height);left:auto;right:15px;max-width:min(430px,calc(100vw - 30px));width:auto;box-sizing:border-box;min-height:0!important;flex:0 0 auto!important;padding:7px 10px;white-space:normal;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 2px 8px #0002;color:#334155;font-size:11px;line-height:1.5;pointer-events:none}',
 'html.sl-home-layout.sl-drawings-view #slDrawingOrderToolbar [data-role=status]:empty{display:none!important}',
 'html.sl-home-layout.sl-drawings-view #drawingsView .manager-head p,html.sl-home-layout.sl-drawings-view #drawingsView .manager-subbar{display:none!important}',
 'html.sl-home-layout.sl-drawings-view #drawingsView .manager-head{margin-bottom:14px}',
 'html.sl-home-layout.sl-drawings-view #drawingsView #slDrawingOrderToolbar{display:none!important}',
 'html.sl-home-layout.sl-drawings-view header button:focus-visible,html.sl-home-layout.sl-drawings-view header label:focus-visible{outline:3px solid #38bdf8!important;outline-offset:2px!important}',
 'html.sl-home-layout:not(.sl-drawings-view) #slDrawingHeaderMiddle{display:none!important}',
 '@media(max-width:700px){html.sl-home-layout.sl-drawings-view header{gap:5px!important}html.sl-home-layout.sl-drawings-view header .brand-mark{width:30px!important;height:30px!important;flex-basis:30px!important}html.sl-home-layout.sl-drawings-view header #headerTitle{flex:0 1 auto!important;max-width:100px!important;font-size:12px!important}html.sl-home-layout.sl-drawings-view header #navBackBtn{min-width:60px!important;font-size:11px!important}html.sl-home-layout.sl-drawings-view header #slHomeHeaderTools{flex:1 1 0!important;max-width:none!important}html.sl-home-layout.sl-drawings-view #slDrawingHeaderMiddle{gap:5px}}',
 '@media(max-width:360px){html.sl-home-layout.sl-drawings-view header #headerTitle{max-width:78px!important}html.sl-home-layout.sl-drawings-view header #navBackBtn{min-width:58px!important;padding:5px!important}html.sl-home-layout.sl-drawings-view header .brand-mark{width:28px!important;height:28px!important;flex-basis:28px!important}}'
 ].join('');
 doc.head.appendChild(style);
}
function groupCounts(){
 const project=typeof getProject==='function'?getProject():null;
 const sheets=project?.drawings||[];
 const groups=root.SentlogDrawingGroups?.groupsForProject?.(project)?.length ??
   new Set(sheets.map(d=>String(d.groupId||d.id))).size;
 return {groups,sheets:sheets.length};
}
function updateCounts(){
 if(!counts)return;
 const {groups,sheets}=groupCounts();
 counts.textContent='図面'+groups+'件 / シート'+sheets+'枚';
 counts.setAttribute('aria-label','図面No. '+groups+'件、登録シート '+sheets+'枚');
 counts.title='図面No. '+groups+'件 / シート'+sheets+'枚';
}
function ensureCenter(){
 const tools=$('slHomeHeaderTools');if(!tools)return false;
 if(!center){
   center=doc.createElement('div');center.id='slDrawingHeaderMiddle';
   center.setAttribute('role','group');
   center.setAttribute('aria-label','図面一覧の操作。狭い画面では左右にスワイプして操作できます');
   counts=doc.createElement('span');counts.id='slDrawingHeaderCounts';
   center.append(counts);
 }
 if(center.parentElement!==tools)tools.insertBefore(center,$('slHomeHeaderRight'));
 return true;
}
function moveExistingControls(){
 if(!ensureCenter())return;
 const cloud=$('sentlogCloudStatus');
 if(cloud&&cloud.parentElement!==center)center.append(cloud);
 const exportBtn=$('slDrawingExportBtn');
 if(exportBtn){
   exportBtn.textContent='図面一括出力';
   exportBtn.title='この案件の記録図面をまとめてPDFで出力';
   if(exportBtn.parentElement!==center)center.append(exportBtn);
 }
 const add=doc.querySelector('label[for="drawingAddInput"]');
 if(add){
   add.textContent='図面の追加';
   add.id='slDrawingHeaderAdd';
   add.title='この案件に新しい図面No.を作成してPDFや画像を読み込む';
   add.setAttribute('aria-label','図面の追加');
   if(!add.hasAttribute('tabindex'))add.tabIndex=0;
   if(!add.dataset.slHeaderKeyboard){
     add.dataset.slHeaderKeyboard='1';
     add.addEventListener('keydown',event=>{
       if(event.key!=='Enter'&&event.key!==' ')return;
       event.preventDefault();event.stopPropagation();
       const picker=$('drawingAddInput');if(picker)picker.click();
     });
   }
   if(add.parentElement!==center)center.append(add);
 }
 const sort=$('slDrawingOrderToolbar');
 if(sort&&sort.parentElement!==center)center.append(sort);
 updateCounts();
}
function refresh(){
 const showing=onDrawingList();
 html.classList.toggle('sl-drawings-view',showing);
 if(showing){
   moveExistingControls();
 }else if(root.SentlogHomeLayout?.moveControls){
   // The cloud-sync button must go back to the original home bar.
   root.SentlogHomeLayout.moveControls();
 }
 root.SentlogHomeLayout?.measureHeader?.();
}
function install(){
 if(installed)return;
 installed=true;installStyle();ensureCenter();
 const drawings=$('drawingsView');
 if(drawings){
   viewObserver=new MutationObserver(refresh);
   viewObserver.observe(drawings,{attributes:true,attributeFilter:['class']});
 }
 if(typeof renderDrawings==='function'&&!renderWrapped){
   const previous=renderDrawings;
   renderDrawings=function(){const out=previous.apply(this,arguments);if(onDrawingList())moveExistingControls();return out;};
   renderWrapped=true;
 }
 refresh();
 // Earlier modules may mount the export / order controls in app-ready callbacks.
 root.setTimeout(refresh,1200);
}
root.SentlogDrawingListHeader={install,refresh,updateCounts,moveExistingControls,getCounts:groupCounts};
Promise.resolve(root.sentlogAppReady).then(install).catch(e=>console.warn('Drawing list header unavailable',e));
})(typeof window==='object'?window:globalThis);
