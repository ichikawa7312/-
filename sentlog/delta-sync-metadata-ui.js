/* Settings conflicts are preserved in immutable history until a person picks
 * the intended value. All labels and values are inserted as text, never HTML. */
(function(root){
  'use strict';
  const projects=new Map(),updates=new Map();let notice,dialog,body,message,busy=false,noticeCount=null,renderedReview=null;
  const labels={project:'案件',meta:'図面',state:'図面設定',order:'並び順',name:'名前',scale:'縮尺',rotation:'回転',
    pageCount:'ページ数',pages:'ページ',pageSettings:'ページ設定',sourceType:'図面の種類',fileName:'ファイル名',
    groupId:'グループ',groupName:'グループ名',groups:'グループ',unit:'単位'};
  const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const clone=x=>root.structuredClone(x);
  // Compare the review and its save preconditions, not a serialized label.
  // In particular, an absent current value must not compare equal to null.
  function sameReview(a,b){
    if(Object.is(a,b))return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    if(Array.isArray(a)){if(a.length!==b.length)return false;}
    else if(Object.prototype.toString.call(a)!=='[object Object]'||Object.prototype.toString.call(b)!=='[object Object]')return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&sameReview(a[key],b[key]));
  }
  function displayedValue(entry,conflict){
    let value=entry.materialized[conflict.recordId];
    for(const key of conflict.path||[])value=value?.[key];
    return value;
  }
  function reviewSnapshot(){
    return [...projects.values()].filter(entry=>entry.conflicts.length).map(entry=>({
      cp:entry.cp,projectName:entry.projection.project?.name,
      conflicts:entry.conflicts.map(conflict=>({conflict,
        drawingName:entry.projection.drawings.find(d=>d.meta.id===conflict.drawingId)?.meta?.name,
        expectedDocument:entry.documents[conflict.recordId]?.collab,
        displayed:displayedValue(entry,conflict)}))
    }));
  }
  function renderBusy(){for(const b of body.querySelectorAll('button'))b.disabled=busy;}
  function button(text,action){const b=el('button',text);b.type='button';b.style.cssText='min-height:44px;padding:8px 12px;margin:4px;white-space:normal';b.onclick=action;return b;}
  function valueText(value){if(value===undefined)return '値なし';if(typeof value==='string')return value||'空欄';return JSON.stringify(value);}
  function setup(){
    if(notice)return;
    notice=el('div');notice.id='sentlogDeltaMetadataNotice';notice.hidden=true;
    notice.style.cssText='position:fixed;right:12px;bottom:12px;z-index:8500;max-width:calc(100vw - 24px);padding:8px;background:#fff8e5;border:1px solid #b7791f;border-radius:8px;box-shadow:0 2px 8px #0002';
    notice.setAttribute('role','status');document.body.append(notice);
    dialog=el('dialog');dialog.id='sentlogDeltaMetadataDialog';dialog.style.cssText='max-width:680px;width:calc(100vw - 32px);max-height:85vh;padding:20px;border:1px solid #888;border-radius:10px;overflow:auto';
    dialog.append(el('h2','図面設定の変更を確認'));
    dialog.append(el('p','同じ設定に異なる変更が届いています。使う内容を選んでください。選ぶ前の変更履歴も残ります。'));
    message=el('p');message.setAttribute('role','status');body=el('div');
    dialog.append(message,body,button('閉じる',()=>dialog.close()));document.body.append(dialog);
  }
  function count(){return [...projects.values()].reduce((n,p)=>n+p.conflicts.length,0);}
  function renderNotice(){setup();const n=count();notice.hidden=!n;
    if(n===noticeCount)return;noticeCount=n;notice.replaceChildren();
    if(n)notice.append(button('図面設定 '+n+' 件を確認',()=>{render();if(!dialog.open)dialog.showModal();}));}
  async function save(entry,conflict,choice){
    if(busy)return;busy=true;message.textContent='選んだ内容を端末に保存しています…';
    for(const b of body.querySelectorAll('button'))b.disabled=true;
    try{
      await root.sentlogDeltaRuntime.resolveMetadata(entry.cp,{kind:conflict.kind,recordId:conflict.recordId,
        path:clone(conflict.path),expectedHeads:clone(conflict.headIds),expectedDocument:clone(entry.documents[conflict.recordId].collab),
        expectedToken:conflict.expectedToken,expectedRecordTokens:clone(conflict.recordTokens),...choice});
      message.textContent='選んだ内容を保存しました。変更履歴を共有します。';
    }catch(error){message.textContent=error.message||'保存を完了できませんでした。候補はそのまま残しています。';}
    finally{busy=false;render();}
  }
  function render(){
    setup();const review=reviewSnapshot();
    // A repeated projection must not detach the focused/pressed native button.
    // Busy state can change independently when save() reaches its finally block.
    if(sameReview(review,renderedReview)){renderBusy();return;}
    body.replaceChildren();
    for(const entry of projects.values())for(const conflict of entry.conflicts){
      const section=el('section');section.style.cssText='border-top:1px solid #ddd;margin-top:16px;padding-top:12px';
      const drawing=entry.projection.drawings.find(d=>d.meta.id===conflict.drawingId);
      section.append(el('h3',[entry.cp.name||entry.projection.project.name||'案件',drawing?.meta?.name,
        conflict.kind==='metadata-membership'?'図面の削除':conflict.path.map(k=>labels[k]||k).join(' / ')].filter(Boolean).join('：')));
      if(conflict.kind==='metadata-membership'){
        section.append(el('p','図面の削除と、別端末での編集が重なっています。現在は図面と記録を残しています。'));
        section.append(button('図面を残す（別端末の記録も保持）',()=>save(entry,conflict,{keep:true})),
          button('確認した記録を含めて図面を削除',()=>save(entry,conflict,{keep:false})));
      }else{
        const displayed=displayedValue(entry,conflict);
        section.append(el('p','現在の表示：'+valueText(displayed)));
        if(displayed!==undefined)section.append(button('現在の内容を残す',()=>save(entry,conflict,{value:clone(displayed)})));
        const seen=new Set();
        for(const candidate of conflict.candidates||[]){
          const node=candidate.value,signature=JSON.stringify(node);if(seen.has(signature))continue;seen.add(signature);
          if(node?.type==='object')continue;
          const value=node?.value,remove=node?.type==='absent',label=remove?'この設定を削除する':valueText(value)+' を使う';
          section.append(button(label,()=>save(entry,conflict,remove?{absent:true}:{value:clone(value)})));
          const by=candidate.actor?.deviceName||candidate.deviceName;
          if(by)section.append(el('small','変更した端末：'+by));
        }
      }
      body.append(section);
    }
    if(!count())body.append(el('p','確認が必要な図面設定はありません。'));
    renderedReview=clone(review);renderBusy();
  }
  async function update(cp,projection){
    const entry={cp:clone(cp),projection:clone(projection),conflicts:clone(projection.metadataConflicts||[]),
      documents:clone(projection.metadataRecords||projection.project?.deltaMetadata?.records||{}),materialized:{}};
    updates.set(cp.client_key,entry);
    try{
      for(const id of new Set(entry.conflicts.map(x=>x.recordId)))entry.materialized[id]=await root.SentlogDeltaMetadata.materializeDocument(entry.documents[id]);
      if(updates.get(cp.client_key)!==entry)return;
      // Keep other projects' last complete review visible while they materialize.
      projects.set(cp.client_key,entry);renderNotice();if(dialog?.open)render();
    }catch(error){if(message)message.textContent=error.message;}
  }
  root.SentlogDeltaMetadataUI={stableRenderVersion:1,update,clear(){projects.clear();updates.clear();noticeCount=null;renderedReview=null;if(notice)notice.hidden=true;if(dialog?.open)dialog.close();}};
  root.SentlogDeltaMetadataStableUI=root.SentlogDeltaMetadataUI;
})(typeof window!=='undefined'?window:globalThis);
