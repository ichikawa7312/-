/* Continuous still capture. Every shutter uses the existing durable photo path. */
(function(root){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const message=e=>e?.message||String(e);

  // No network await belongs in this controller. One in-flight photo bounds
  // memory and makes Done wait for local persistence, never for cloud delivery.
  function createSession(options){
    const target=copy(options.target),entries=[];
    let flight=null,closing=false,closed=false,failed=null,lastError='';
    const notify=()=>options.onChange?.(snapshot());
    function snapshot(){return {target:copy(target),entries:entries.map(e=>({...e,file:undefined,intent:undefined})),
      busy:!!flight,closing,closed,error:lastError,
      saved:entries.filter(e=>e.status==='attached'&&!e.removed).length,
      pending:entries.filter(e=>e.status!=='attached').length,
      unsaved:!!failed&&!failed.originalSaved&&!failed.exported,
      canRetry:!!failed};}
    function remember(result,work){
      const entry={...result,intent:work.intent,file:result.originalSaved?null:work.file};
      const index=entries.findIndex(e=>e.photoId===entry.photoId);
      if(index<0)entries.push(entry);else entries[index]={...entries[index],...entry};
      failed=result.status==='attached'?null:entry;
      lastError=result.status==='attached'?'':result.error||'写真は保存待ちです。';
      return entry;
    }
    function run(task){
      if(flight||closed||closing)return Promise.resolve({status:'busy'});
      // Set flight before any asynchronous camera or storage callback runs.
      flight=Promise.resolve().then(task).catch(e=>{lastError=message(e);return {status:'failed',error:lastError};})
        .finally(()=>{flight=null;notify();});
      notify();return flight;
    }
    function capture(){
      if(failed&&!failed.originalSaved)return Promise.resolve({status:'unsaved'});
      return run(async()=>{
        let intent,file;
        try{
          intent=options.photos.prepareCapture(target);
          file=await options.takePhoto();
          if(!file||!file.size)throw Error('写真を取得できませんでした。もう一度撮影してください。');
          const work={intent,file,originalSaved:false};failed=work;
          const results=await options.photos.register([file],intent);
          if(!results?.[0])throw Error('写真の保存結果を確認できません。再試行してください。');
          return remember(results[0],work);
        }catch(e){
          if(!file&&intent)options.photos.cancelCapture(intent);
          if(file)failed={intent,file,originalSaved:false};
          throw e;
        }
      });
    }
    function retry(){return run(async()=>{
      if(!failed)return {status:'empty'};
      const work=failed;
      const results=work.photoId?await options.photos.retryPending(work.photoId):await options.photos.register([work.file],work.intent);
      if(!results?.[0])throw Error('保存待ちの写真を確認できません。');
      return remember(results[0],work);
    });}
    async function close(){
      if(closed)return true;
      closing=true;notify();if(flight)await flight;
      if(failed&&!failed.originalSaved&&!failed.exported){closing=false;notify();return false;}
      closed=true;closing=false;notify();return true;
    }
    return {capture,retry,close,snapshot,
      markRemoved(photoId,removed){const e=entries.find(e=>e.photoId===photoId);if(e&&e.removed!==removed){e.removed=removed;notify();}},
      unsavedFile:()=>failed&&!failed.originalSaved?failed.file:null,
      confirmExport(){if(failed)failed.exported=true;notify();}};
  }

  async function captureStill(video,track,ImageCaptureClass,document){
    if(!track||track.readyState==='ended')throw Error('カメラが停止しています。「カメラを再開」を押してください。');
    if(track.muted)throw Error('カメラの映像が一時停止しています。再開してから撮影してください。');
    if(ImageCaptureClass){
      try{
        const capture=new ImageCaptureClass(track);
        if(typeof capture.takePhoto==='function'){
          const blob=await capture.takePhoto();
          if(blob?.size)return blob;
        }
      }catch(e){if(track.readyState==='ended')throw e;}
    }
    if(track.readyState==='ended'||track.muted)throw Error('カメラの映像が一時停止しています。再開してから撮影してください。');
    // Use the actual full stream dimensions, never the on-screen preview size.
    const width=video.videoWidth,height=video.videoHeight;
    if(!width||!height||video.readyState<2)throw Error('カメラの準備中です。映像が出てから撮影してください。');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    try{
      const context=canvas.getContext('2d');if(!context)throw Error('写真の画像を作成できません');
      context.drawImage(video,0,0,width,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.95));
      if(!blob?.size)throw Error('写真の画像を作成できません');return blob;
    }finally{canvas.width=1;canvas.height=1;}
  }

  const pure={createSession,captureStill};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogContinuousCamera)return;
  const document=root.document;
  let ui,session,stream=null,track=null,generation=0,starting=false,paused=false,wakeLock=null;
  let priorFocus=null,priorOverflow='',reviewGeneration=0,unsubscribe=null,exportConfirmed=false;
  const urls=new Set();
  const photos=()=>root.SentlogCollaborationPhotos;
  const isOpen=()=>!!ui&&!ui.modal.hidden;
  const activeTrack=()=>stream?.getVideoTracks?.()[0]||null;
  function status(text){if(ui)ui.status.textContent=text;}
  function stopStream(){
    generation++;starting=false;
    for(const t of stream?.getTracks?.()||[])t.stop();stream=null;track=null;
    if(ui){ui.video.pause();ui.video.srcObject=null;}
    if(wakeLock){void wakeLock.release().catch(()=>{});wakeLock=null;}
  }
  function clearReview(){reviewGeneration++;for(const url of urls)URL.revokeObjectURL(url);urls.clear();
    if(ui){ui.list.replaceChildren();ui.large.hidden=true;ui.largeImage.removeAttribute('src');}}
  function showError(e){render();status(message(e));}
  function render(){
    if(!ui||!session)return;const s=session.snapshot();
    ui.count.textContent=`保存${s.saved}枚`;ui.count.disabled=!s.entries.length||s.busy||s.closing;
    ui.shutter.disabled=s.busy||s.closing||s.unsaved||!track||track.muted||paused||starting||!ui.review.hidden;
    ui.shutter.setAttribute('aria-label',s.busy?'写真を保存中':'写真を撮影');
    ui.done.disabled=s.closing;ui.done.textContent=s.closing?'保存を待機中…':'完了';
    ui.native.disabled=s.busy||s.unsaved||s.closing;
    ui.retry.hidden=!s.canRetry;ui.retry.disabled=s.busy||s.closing;
    ui.export.hidden=!s.unsaved;ui.export.disabled=s.busy;
    ui.exportDone.hidden=!s.unsaved||!exportConfirmed;
    ui.resume.hidden=(!!track&&!paused)||starting;ui.resume.disabled=s.busy||starting;
    if(s.closing)status('この端末への保存が終わってから閉じます…');
    else if(s.busy)status('この端末に保存中…');
    else if(s.error)status(s.error+(s.unsaved?' まだ保存できていません。再試行するか写真を書き出してください。':''));
    else if(s.pending)status(`${s.pending}枚は保存待ちです。原本はこの端末に残しています。`);
    else if(track&&!paused)status(s.saved?'この端末に保存しました。そのまま次を撮影できます。':'続けて撮影できます。写真は1枚ずつ端末に保存します。');
  }
  function install(){
    if(ui)return;
    const style=document.createElement('style');style.textContent=`
#sentlogContinuousCamera[hidden],#sentlogContinuousCamera [hidden]{display:none!important}
#sentlogContinuousCamera{position:fixed;inset:0;z-index:2300;background:#080b10;color:#fff;display:flex;flex-direction:column;height:100dvh;max-height:100dvh;box-sizing:border-box;overscroll-behavior:contain;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#sentlogContinuousCamera *{box-sizing:border-box}#sentlogContinuousCamera button{font:inherit;color:inherit;touch-action:manipulation;cursor:pointer;min-height:44px;width:auto;margin:0;border:1px solid #536171;border-radius:10px;background:#202a36;padding:8px 12px}#sentlogContinuousCamera button:disabled{opacity:.45;cursor:default}
#sentlogContinuousCamera .sl-camera-top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(8px + env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));flex-shrink:0}
#slCameraTarget{font-size:15px;line-height:1.4;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}#slCameraNative{font-size:13px!important;flex-shrink:0}
#sentlogContinuousCamera .sl-camera-stage{position:relative;flex:1;min-height:0;display:flex;justify-content:center;align-items:center;overflow:hidden;background:#000}
#slCameraVideo{width:100%;height:100%;object-fit:contain;background:#000}#slCameraResume{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#263647!important}
#slCameraFlash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}#slCameraFlash.flash{animation:sl-camera-flash .2s ease-out}@keyframes sl-camera-flash{from{opacity:.4}to{opacity:0}}
#sentlogContinuousCamera .sl-camera-bottom{flex-shrink:0;padding:6px max(12px,env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:#101720}
#slCameraStatus{font-size:13px;text-align:center;min-height:2.6em;margin:0 0 5px;color:#d9e4ed;overflow-wrap:anywhere}
#sentlogContinuousCamera .sl-camera-controls{display:grid;grid-template-columns:1fr 88px 1fr;align-items:center;gap:12px}#slCameraCount{justify-self:start;font-size:15px!important}#slCameraDone{justify-self:end}#slCameraShutter{justify-self:center;width:70px!important;height:70px;min-height:70px!important;border:4px solid #fff!important;border-radius:50%!important;background:#fff!important;box-shadow:inset 0 0 0 4px #121b26;padding:0!important}#slCameraShutter:active{background:#b3c9d8!important}
#sentlogContinuousCamera .sl-camera-errors{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}#sentlogContinuousCamera .sl-camera-errors button{font-size:13px;margin-top:7px}
#slCameraReview{position:absolute;inset:0;background:#101720;display:flex;flex-direction:column;padding:env(safe-area-inset-top) max(12px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(12px,env(safe-area-inset-left));z-index:2}
#slCameraReview header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0}#slCameraReview h2{margin:0;font-size:18px;color:#fff}#slCameraReview p{font-size:13px;color:#d9e4ed;margin:4px 0 12px}
#slCameraReviewList{overflow:auto;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding-bottom:12px;align-content:start;flex:1}#slCameraReviewList article{min-width:0;background:#202b38;border-radius:12px;padding:8px}#slCameraReviewList img{display:block;width:100%;height:150px;object-fit:contain;background:#000;border-radius:6px}#slCameraReviewList .sl-camera-image-button{display:block;width:100%;padding:0;border:0;background:none}#slCameraReviewList .sl-camera-photo-name{overflow-wrap:anywhere;font-size:13px;margin:7px 0}#slCameraReviewList [data-camera-remove]{font-size:13px;width:100%}
#slCameraLarge{position:absolute;inset:0;background:#080b10;z-index:3;display:flex;flex-direction:column;padding:calc(10px + env(safe-area-inset-top)) 12px calc(10px + env(safe-area-inset-bottom))}#slCameraLarge button{align-self:flex-end;flex-shrink:0}#slCameraLarge img{flex:1;min-height:0;width:100%;object-fit:contain;touch-action:pinch-zoom}
@media(min-width:700px){#slCameraReviewList{grid-template-columns:repeat(3,minmax(0,1fr))}#slCameraReviewList img{height:220px}.sl-camera-controls{max-width:520px;margin:auto}}
@media(orientation:landscape) and (max-height:550px){#sentlogContinuousCamera .sl-camera-top{padding-top:max(4px,env(safe-area-inset-top));padding-bottom:4px}#sentlogContinuousCamera .sl-camera-bottom{padding-top:4px;padding-bottom:max(5px,env(safe-area-inset-bottom))}#slCameraStatus{min-height:0;margin:0;font-size:12px}#slCameraShutter{width:54px!important;height:54px;min-height:54px!important}}
`;document.head.append(style);
    const modal=document.createElement('section');modal.id='sentlogContinuousCamera';modal.hidden=true;
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','連続撮影');
    modal.innerHTML=`<header class="sl-camera-top"><strong id="slCameraTarget"></strong><button id="slCameraNative" type="button">標準カメラ</button></header>
<div class="sl-camera-stage"><video id="slCameraVideo" autoplay muted playsinline></video><button id="slCameraResume" type="button" hidden>カメラを再開</button><div id="slCameraFlash"></div></div>
<footer class="sl-camera-bottom"><p id="slCameraStatus" role="status" aria-live="polite"></p><div class="sl-camera-controls"><button id="slCameraCount" type="button" disabled>保存0枚</button><button id="slCameraShutter" type="button" aria-label="写真を撮影" disabled></button><button id="slCameraDone" type="button">完了</button></div><div class="sl-camera-errors"><button id="slCameraRetry" type="button" hidden>保存を再試行</button><button id="slCameraExport" type="button" hidden>未保存の写真を書き出す</button><button id="slCameraExportDone" type="button" hidden>書き出しを確認して終了</button></div></footer>
<section id="slCameraReview" hidden aria-label="今回撮った写真"><header><h2>今回撮った写真</h2><button id="slCameraReviewClose" type="button">撮影に戻る</button></header><p>端末に保存した写真です。共有の進み具合は同期表示で確認できます。</p><div id="slCameraReviewList"></div></section>
<section id="slCameraLarge" hidden aria-label="写真を拡大"><button id="slCameraLargeClose" type="button">一覧に戻る</button><img id="slCameraLargeImage" alt="今回撮った写真"></section>`;
    document.body.append(modal);
    const get=id=>document.getElementById(id);
    ui={modal,target:get('slCameraTarget'),video:get('slCameraVideo'),resume:get('slCameraResume'),flash:get('slCameraFlash'),
      shutter:get('slCameraShutter'),count:get('slCameraCount'),done:get('slCameraDone'),status:get('slCameraStatus'),native:get('slCameraNative'),
      retry:get('slCameraRetry'),export:get('slCameraExport'),exportDone:get('slCameraExportDone'),review:get('slCameraReview'),
      reviewClose:get('slCameraReviewClose'),list:get('slCameraReviewList'),large:get('slCameraLarge'),largeImage:get('slCameraLargeImage')};
    ui.shutter.onclick=()=>void session?.capture();
    ui.done.onclick=()=>void close();ui.resume.onclick=()=>void startCamera();
    ui.retry.onclick=()=>void session?.retry().then(()=>{if(!ui.review.hidden)void showReview();});
    ui.count.onclick=()=>void showReview();ui.reviewClose.onclick=()=>{clearReview();ui.review.hidden=true;render();ui.shutter.focus();};
    get('slCameraLargeClose').onclick=()=>{ui.large.hidden=true;ui.largeImage.removeAttribute('src');};
    ui.native.onclick=()=>{
      if(!session||session.snapshot().busy||session.snapshot().unsaved)return;
      const fixed=session.snapshot().target;
      // The legacy chooser captures today's selected record. Only open it if
      // that is still exactly the destination displayed in this camera.
      try{const current=photos().captureTarget();if(!current||['projectId','drawingId','recordId','ownerId'].some(k=>current[k]!==fixed[k]))throw Error('追加先が変わりました。撮影を完了し、元の記録を開いてください。');}
      catch(e){showError(e);return;}
      // Keep chooser activation in this actual click, without an async gap.
      finishClose();document.getElementById('cameraInput')?.click();
    };
    ui.export.onclick=()=>{
      const file=session?.unsavedFile();if(!file)return;
      const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name||'写真.jpg';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      exportConfirmed=true;render();status('写真を書き出しました。「ファイル」等に保存できたことを確認してください。');
    };
    ui.exportDone.onclick=()=>{if(root.confirm('書き出した写真を「ファイル」等に保存できたことを確認しましたか？')){session.confirmExport();void close();}};
    modal.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();if(!ui.large.hidden){ui.large.hidden=true;ui.largeImage.removeAttribute('src');}else if(!ui.review.hidden)ui.reviewClose.click();else void close();}
      if(event.key==='Tab'){
        const scope=!ui.large.hidden?ui.large:!ui.review.hidden?ui.review:modal;
        const buttons=[...scope.querySelectorAll('button:not([disabled])')].filter(b=>b.offsetParent!==null);
        const first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    });
  }
  async function startCamera(){
    if(!isOpen()||starting)return;stopStream();const token=generation;starting=true;paused=false;render();status('カメラを準備しています…');
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('この環境では連続撮影を開けません。「標準カメラ」を使ってください。');
      const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:3840},height:{ideal:2880}}});
      if(token!==generation||!isOpen()){next.getTracks().forEach(t=>t.stop());return;}
      stream=next;track=activeTrack();if(!track)throw Error('カメラを利用できません。「標準カメラ」を使ってください。');
      const current=track;current.addEventListener?.('ended',()=>{if(track===current&&isOpen()){paused=true;stopStream();status('カメラが停止しました。「カメラを再開」を押してください。');render();}});
      current.addEventListener?.('mute',()=>{if(track===current&&isOpen()){paused=true;render();status('カメラの映像を一時停止しています。「カメラを再開」を押してください。');}});
      current.addEventListener?.('unmute',()=>{if(track===current&&isOpen()){paused=false;render();}});
      ui.video.muted=true;ui.video.playsInline=true;ui.video.srcObject=next;await ui.video.play();
      if(token!==generation||!isOpen())return;
      if(navigator.wakeLock?.request)void navigator.wakeLock.request('screen').then(lock=>{if(token===generation&&isOpen())wakeLock=lock;else void lock.release();}).catch(()=>{});
      starting=false;render();
    }catch(e){
      if(token!==generation||!isOpen())return;
      stopStream();paused=true;render();status(e.name==='NotAllowedError'?'カメラの利用が許可されていません。許可して再開するか「標準カメラ」を使ってください。':message(e));
    }
  }
  async function takePhoto(){
    const blob=await captureStill(ui.video,track,root.ImageCapture,document);
    const ext=/png/i.test(blob.type)?'png':/heic/i.test(blob.type)?'heic':'jpg';
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+$/,'').replace('T','_');
    ui.flash.classList.remove('flash');void ui.flash.offsetWidth;ui.flash.classList.add('flash');
    return new File([blob],`写真_${stamp}.${ext}`,{type:blob.type||'image/jpeg',lastModified:Date.now()});
  }
  function currentPhoto(entry){
    try{
      const s=session.snapshot(),raw=root.SentlogRecords.getItem('surveyFieldNoteDrawingV1:'+s.target.drawingId),drawing=JSON.parse(raw||'null');
      const record=drawing?.shapes?.find(r=>r.id===s.target.recordId);
      return record?.photos?.find(p=>p.id===entry.photoId)||null;
    }catch(_){return null;}
  }
  async function showReview(){
    if(!session||session.snapshot().busy)return;clearReview();ui.review.hidden=false;render();ui.reviewClose.focus();
    const token=reviewGeneration,s=session.snapshot();
    for(const entry of s.entries){
      if(token!==reviewGeneration||!isOpen())return;
      const live=currentPhoto(entry),removed=entry.status==='attached'&&!live;session.markRemoved(entry.photoId,removed);
      const item=document.createElement('article');item.dataset.cameraPhotoId=entry.photoId;
      const imageButton=document.createElement('button');imageButton.type='button';imageButton.className='sl-camera-image-button';imageButton.setAttribute('aria-label','写真を拡大');
      const img=document.createElement('img');img.alt='今回撮った写真';img.loading='lazy';img.decoding='async';imageButton.append(img);
      const name=document.createElement('p');name.className='sl-camera-photo-name';name.textContent=removed?'記録から外した写真':entry.status==='attached'?'保存済み':entry.originalSaved?'原本保存済み・関連付け待ち':'未保存';
      item.append(imageButton,name);ui.list.append(item);
      try{
        let blob=typeof getPhotoBlob==='function'?await getPhotoBlob(entry.photoId,s.target.drawingId):null;
        if(!blob)blob=await root.SentlogOriginalPhotos?.getOriginal(s.target.drawingId,entry.photoId);
        if(token!==reviewGeneration||!isOpen())return;
        if(blob?.size){const url=URL.createObjectURL(blob);urls.add(url);img.src=url;imageButton.onclick=()=>{ui.largeImage.src=url;ui.large.hidden=false;};}
        else{imageButton.disabled=true;img.alt='写真は保存待ちです';}
      }catch(_){imageButton.disabled=true;img.alt='写真を読み込めません';}
      if(entry.status==='attached'&&!removed&&root.SentlogCollaboration?.requestPhotoRemoval){
        const remove=document.createElement('button');remove.type='button';remove.dataset.cameraRemove=entry.photoId;remove.textContent='写真を外す';
        remove.onclick=()=>{try{root.SentlogCollaboration.requestPhotoRemoval(s.target,entry.photoId);document.querySelector('.sl-collab-dialog:not([hidden]) button')?.focus();}catch(e){name.textContent=message(e);}};item.append(remove);
      }
    }
  }
  async function open(){
    if(isOpen())return;install();
    try{
      if(!photos()?.prepareCapture)throw Error('写真の保存機能を準備できません。アプリを更新してください。');
      const target=photos().captureTarget();if(!target)throw Error('写真を追加する記録を選んでください。');
      priorFocus=document.activeElement;priorOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
      exportConfirmed=false;session=createSession({target,photos:photos(),takePhoto,onChange:render});
      ui.target.textContent=target.recordLabel||'選択中の記録';ui.target.title=[target.drawingName,target.recordLabel].filter(Boolean).join(' / ');
      ui.modal.hidden=false;ui.review.hidden=true;ui.large.hidden=true;ui.done.focus();render();
      unsubscribe=root.SentlogRecords?.subscribe?.(()=>{
        if(!isOpen()||!session)return;
        for(const entry of session.snapshot().entries)if(entry.status==='attached')session.markRemoved(entry.photoId,!currentPhoto(entry));
      });
      await startCamera();
    }catch(e){const target=document.getElementById('photoStatus');if(target)target.textContent=message(e);if(isOpen())showError(e);}
  }
  function finishClose(){
    stopStream();clearReview();unsubscribe?.();unsubscribe=null;
    if(ui){ui.modal.hidden=true;ui.review.hidden=true;}document.body.style.overflow=priorOverflow;
    priorFocus?.focus?.();
  }
  async function close(){
    if(!isOpen())return true;
    if(session&&!await session.close()){status('まだ保存できていない写真があります。再試行するか、写真を書き出してから終了してください。');return false;}
    finishClose();return true;
  }
  document.addEventListener('visibilitychange',()=>{
    if(!isOpen())return;
    if(document.hidden){paused=true;stopStream();render();}
    else{paused=true;render();status('カメラを一時停止しました。「カメラを再開」を押してください。');}
  });
  root.addEventListener('pagehide',()=>{if(isOpen()){paused=true;stopStream();}});
  root.addEventListener('beforeunload',event=>{if(isOpen()&&(session?.snapshot().busy||session?.snapshot().unsaved)){event.preventDefault();event.returnValue='';}});
  // Capture phase avoids invoking the existing native file picker as well.
  root.addEventListener('click',event=>{
    const button=event.target?.closest?.('#cameraBtn');if(!button||button.disabled)return;
    event.preventDefault();event.stopImmediatePropagation();void open();
  },true);
  root.SentlogContinuousCamera={...pure,open,close,isOpen};
})(typeof window==='undefined'?globalThis:window);
