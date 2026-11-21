/* One selected project's device-local originals, one ZIP, explicit save confirmation. */
(function(root){
  'use strict';
  if(!root.document||root.SentlogOriginalPhotoExport)return;
  const script=document.currentScript?.src||new URL('./original-photo-export.js',location.href).href;
  const workerURL=new URL('./original-photo-export-worker.js',script);workerURL.search=new URL(script).search;
  let active=null,view=null,launch=null,announcedBusy=null;
  const store=()=>root.SentlogOriginalPhotos;
  const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
  const button=(id,text,action)=>{const element=node('button',text);element.id=id;element.type='button';element.onclick=action;return element;};
  const size=bytes=>bytes<1024**2?(bytes/1024).toFixed(1)+' KB':bytes<1024**3?(bytes/1024**2).toFixed(1)+' MB':(bytes/1024**3).toFixed(2)+' GB';
  const aborted=()=>Object.assign(Error('ZIPの作成を中止しました。元写真は端末に残っています。'),{name:'AbortError'});
  const savePending=job=>!!job?.downloadStarted&&!job.saveAcknowledged&&!job.abandoned;
  const totalBytes=rows=>rows.reduce((sum,row)=>sum+Number(row.size||0),0);
  const identity=()=>root.crypto.randomUUID();
  function stamp(){const date=new Date(),pad=n=>String(n).padStart(2,'0');return store().localDateKey(date).replaceAll('-','')+'_'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds());}
  function archiveName(projectName){
    // Match the worker's normalization; 48 code points plus our short suffix
    // stay below its 240-byte component limit, even for four-byte characters.
    let base=String(projectName||'案件').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'_').trim().replace(/[. ]+$/g,'');
    if(!base||base==='.'||base==='..')base='案件';
    let name=Array.from(base).slice(0,48).join('')+'_元写真_'+stamp()+'.zip';
    if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
    return name;
  }
  function message(error){
    if(error?.name==='AbortError')return error.message;
    if(error?.code==='STORAGE_FULL'||error?.name==='QuotaExceededError')return 'ZIPを作るための空き容量が足りません。元写真は端末に残っています。不要なファイルを整理してから、もう一度お試しください。';
    if(error?.code==='OPFS_UNAVAILABLE')return 'このブラウザーではZIPを準備できません。最新版のブラウザーで開いてください。';
    if(error?.code==='ZIP_WRITE_INCOMPLETE')return 'ZIPを最後まで作成できませんでした。元写真は端末に残っています。もう一度お試しください。';
    if(error?.code==='PREVIOUS_EXPORT_PENDING')return '前回のZIPの保存が途中の可能性があります。保存が完了したか、保存を取りやめたことを確認してから続けてください。';
    const detail=error?.message||'ZIPを作成できませんでした。';
    return /元写真|原本/.test(detail)?detail:detail+' 元写真は端末に残っています。';
  }
  function controls(){
    const busy=!!active;if(launch)launch.disabled=busy;
    if(busy!==announcedBusy){announcedBusy=busy;void store()?.refreshUI?.();}
    if(!view)return;
    view.project.disabled=busy;view.start.disabled=busy||!view.project.value||!view.count||!!view.previousExports.length;
    view.cancel.hidden=!active||!['preparing','writing','finalizing','cancelling'].includes(active.phase);
    view.cancel.disabled=active?.phase==='cancelling';
    view.close.textContent=active&&['preparing','writing','finalizing','cancelling'].includes(active.phase)?'中止して閉じる':'閉じる';
    view.confirm.disabled=!active?.result||!active.downloadStarted||!!active.confirming||active.saveAcknowledged||active.cancelled;
    view.discard.hidden=!savePending(active);view.discard.disabled=!!active?.confirming;
    view.previousAck.disabled=busy||view.previousProject!==view.project.value;
  }
  function status(text){if(view)view.status.textContent=text;}
  async function preview(projectId){
    const current=view;if(!current)return;
    const version=++current.previewVersion;
    const rows=await store().listMeta();
    if(view!==current||version!==current.previewVersion||active)return;
    const selected=projectId??current.project.value,options=store().projectOptions(rows);
    current.project.replaceChildren(new Option('案件を選択してください',''));
    for(const project of options)current.project.append(new Option(project.name,project.id));
    if(selected&&options.some(project=>project.id===selected))current.project.value=selected;
    const chosen=rows.filter(row=>current.project.value&&row.projectId===current.project.value);
    current.count=chosen.length;
    current.summary.textContent=current.project.value?current.project.selectedOptions[0].textContent+'：この端末の元写真 '+chosen.length+'枚 / '+size(totalBytes(chosen)):'元写真を保存する案件を選んでください。';
    if(current.project.value&&!chosen.length)status('この案件の元写真は、この端末にはありません。写真を撮影・追加した端末で開いてください。');
    else if(!active)status('保存確認済みの写真も含めて、1つのZIPを作成します。');
    controls();
  }
  function clearResult(){
    if(!view)return;
    view.results.replaceChildren(view.confirm,view.discard);view.confirm.hidden=true;view.discard.hidden=true;view.save=null;
  }
  function clearPrevious(){
    if(!view)return;view.previousExports=[];view.previousProject=null;view.previous.hidden=true;view.previousList.replaceChildren();
  }
  function previousExports(error,projectId){
    clearPrevious();if(!view||error?.code!=='PREVIOUS_EXPORT_PENDING'||!Array.isArray(error.previousExports))return;
    view.previousExports=error.previousExports.filter(item=>item&&typeof item.id==='string'&&item.id&&typeof item.fileName==='string')
      .map(item=>({id:item.id,fileName:item.fileName,createdAt:item.createdAt,zipBytes:item.zipBytes}));
    if(!view.previousExports.length)return;
    view.previousProject=projectId;view.previous.hidden=false;
    for(const item of view.previousExports)view.previousList.append(node('li',item.fileName+'（'+size(Number(item.zipBytes)||0)+'）'));
    controls();
  }
  function progress(job,value){
    if(active!==job||job.cancelled)return;
    job.phase=value.phase||'writing';job.progress={doneFiles:Number(value.doneFiles)||0,totalFiles:job.session.rows.length,
      doneBytes:Number(value.doneBytes)||0,totalBytes:job.bytes};
    if(view){
      view.progress.hidden=false;view.progress.max=Math.max(1,job.bytes);
      view.progress.value=Math.min(job.bytes,job.progress.doneBytes);
      status(job.phase==='finalizing'?'ZIPの仕上げと写真の照合をしています…':
        'ZIPを作成中：'+job.progress.doneFiles+' / '+job.progress.totalFiles+'枚　'+size(job.progress.doneBytes)+' / '+size(job.bytes));
    }
    try{job.onProgress({...job.progress,phase:job.phase});}catch(_){}
    controls();
  }
  function ready(job,result){
    job.result=result;job.phase='ready';
    if(!view)return;
    clearResult();view.progress.value=view.progress.max;
    job.url=URL.createObjectURL(result.file);
    const save=node('a','ZIPを保存');save.id='slOriginalExportSave';save.className='sl-original-save';save.href=job.url;save.download=result.fileName;
    save.onclick=event=>{
      if(active!==job||!job.result||job.phase==='cancelling'||job.saveAcknowledged||job.downloadStarted){event.preventDefault();return;}
      job.downloadStarted=true;save.setAttribute('aria-disabled','true');save.tabIndex=-1;
      status('ZIPの保存中はこの画面を開いたままにしてください。「ファイル」などに保存できたことを確認してから「保存を確認」を押してください。');
      controls();
    };
    view.results.prepend(save);view.save=save;view.confirm.hidden=false;
    status('元写真 '+result.entryCount+'枚を1つのZIP（'+size(result.zipBytes)+'）にまとめました。「ZIPを保存」を押してください。');
    controls();
  }
  async function stop(job){
    if(job.stopping)return job.stopping;
    job.stopping=(async()=>{
      await job.setupDone;
      if(job.confirming)await job.confirming.catch(()=>{});
      if(job.worker&&!job.terminal){
        await new Promise(resolve=>{
          job.stopped=resolve;
          job.stopTimer=setTimeout(()=>{job.worker?.terminate();job.terminal=true;resolve();},15000);
          try{job.worker.postMessage({type:job.result?'release':'cancel',requestId:job.requestId});}
          catch(_){job.worker.terminate();job.terminal=true;resolve();}
        });
      }
      clearTimeout(job.stopTimer);job.worker?.terminate();job.worker=null;
      job.rejectReady?.(aborted());
      if(job.url){URL.revokeObjectURL(job.url);job.url=null;}
      if(job.session){store().releaseExportSession(job.session);job.session=null;}
    })();return job.stopping;
  }
  async function prepare(job){
    let response;
    try{
      job.session=await store().beginExportSession(job.projectId);
      if(job.cancelled)throw aborted();
      job.bytes=totalBytes(job.session.rows);
      const projectName=store().projectOptions(job.session.rows).find(project=>project.id===job.projectId)?.name||job.session.rows[0].projectName||'案件';
      job.fileName=archiveName(projectName);
      if(view){
        if(![...view.project.options].some(option=>option.value===job.projectId))view.project.append(new Option(projectName,job.projectId));
        view.project.value=job.projectId;view.count=job.session.rows.length;
        view.summary.textContent=projectName+'：作成開始時の元写真 '+view.count+'枚 / '+size(job.bytes);
      }
      if(typeof root.Worker!=='function'||typeof root.navigator?.storage?.getDirectory!=='function')throw Object.assign(Error('このブラウザーではZIPを準備できません。最新版のブラウザーで開いてください。'),{code:'OPFS_UNAVAILABLE'});
      job.worker=new Worker(workerURL.href,{name:'sentlog-original-photo-export'});
      response=new Promise((resolve,reject)=>{job.resolveReady=resolve;job.rejectReady=reject;});
      // Register rejection handling immediately, including an early worker
      // import failure or cancellation while setup is still finishing.
      response.catch(()=>{});
      const failed=error=>{
        job.terminal=true;job.worker?.terminate();job.stopped?.();job.rejectReady(error);
        if(job.result&&active===job){
          job.workerFailure=error;
          // A crashed worker releases its OPFS lock, but the source Web Lock
          // still prevents a later normal export from clearing this ready file
          // while the native save is pending. Keep the URL/session until the
          // user acknowledges saving or explicitly abandons it.
          if(savePending(job)||job.confirming){
            if(!job.confirming)status('作成済みのZIPをこの画面に保持しています。保存できたら「保存を確認」、保存をやめる場合は「保存を取りやめて閉じる」を押してください。');
            controls();return;
          }
          void stop(job).then(()=>{if(active===job){active=null;clearResult();status(message(error));controls();}});
        }
      };
      job.worker.onerror=event=>{event.preventDefault();failed(Error('ZIPの作成を開始できませんでした。画面を読み込み直して、もう一度お試しください。'));};
      job.worker.onmessageerror=()=>failed(Error('ZIPの作成結果を読み取れませんでした。元写真は端末に残っています。'));
      job.worker.onmessage=event=>{
        const data=event.data;if(!data||data.requestId!==job.requestId)return;
        if(data.type==='progress'){progress(job,data);return;}
        if(data.type==='ready'){
          if(job.cancelled){job.resolveReady(data);return;}
          if(!(data.file instanceof Blob)||data.file.size!==data.zipBytes||data.fileName!==job.fileName||
            data.entryCount!==job.session.rows.length||data.originalBytes!==job.bytes){failed(Error('ZIPの枚数・容量を確認できませんでした。元写真は端末に残っています。'));return;}
          job.resolveReady(data);return;
        }
        if(data.type==='cancelled'||data.type==='released'){job.terminal=true;job.stopped?.();if(!job.result)job.rejectReady(aborted());return;}
        if(data.type==='error')failed(Object.assign(Error(data.message||'ZIPを作成できませんでした。'),{code:data.code,previousExports:data.previousExports}));
      };
      job.worker.postMessage({type:'start',requestId:job.requestId,projectId:job.projectId,rows:job.session.rows,fileName:job.fileName,
        acknowledgedPreviousExports:job.acknowledgedPreviousExports});
    }finally{job.setupResolved();}
    return response;
  }
  async function start(projectId,{onProgress=()=>{},acknowledgedPreviousExports=[]}={}){
    if(active)throw Error('元写真の保存が進行中です。今の保存画面を閉じてから始めてください。');
    if(typeof projectId!=='string'||!projectId.trim())throw Error('元写真を保存する案件を選んでください。');
    if(!view)createDialog();view.previewVersion++;
    const job={projectId,requestId:identity(),phase:'preparing',onProgress,cancelled:false,downloadStarted:false,saveAcknowledged:false,confirmed:false,
      acknowledgedPreviousExports:[...new Set(Array.isArray(acknowledgedPreviousExports)?acknowledgedPreviousExports.filter(value=>typeof value==='string'):[])]};
    job.setupDone=new Promise(resolve=>{job.setupResolved=resolve;});active=job;
    clearResult();clearPrevious();status('元写真の枚数と容量を確認しています…');controls();
    try{
      const result=await prepare(job);if(job.cancelled)throw aborted();ready(job,result);return result;
    }catch(error){
      await stop(job);
      if(active===job){active=null;if(view){view.progress.hidden=true;clearResult();previousExports(error,projectId);status(message(error));controls();}}
      throw error;
    }
  }
  async function confirmSaved(){
    const job=active;if(!job?.result||!job.downloadStarted||job.saveAcknowledged||job.confirming||job.cancelled||job.abandoned)return;
    // The user's acknowledgment of the downloaded file is separate from the
    // conditional metadata write. A changed source can reject that write while
    // still allowing this acknowledged ZIP's staging resources to be released.
    job.saveAcknowledged=true;view?.save?.remove();
    status('保存確認を記録しています…');
    job.confirming=store().confirmExportSession(job.session,job.fileName);controls();
    try{const result=await job.confirming;job.confirmed=true;job.phase='confirmed';status(result.count+'枚の保存を確認しました。元写真はこの端末に残っています。もう一度保存する場合は、この画面を開き直してください。');}
    catch(error){status(message(error));}
    finally{job.confirming=null;controls();}
  }
  async function cancel(){
    const job=active;if(!job)return;
    if(job.confirming)await job.confirming.catch(()=>{});
    if(savePending(job)){
      status('ZIPの保存が終わったら「保存を確認」を押してください。保存をやめる場合は「保存を取りやめて閉じる」を押してください。');controls();return false;
    }
    job.cancelled=true;job.phase='cancelling';status('ZIPの作成を中止しています…');controls();
    await stop(job);
    if(active===job){active=null;if(view){view.progress.hidden=true;clearResult();status(aborted().message);controls();}}
    return true;
  }
  async function close(){
    const current=view;if(active&&await cancel()===false)return false;
    if(view===current&&current){current.dialog.close();current.dialog.remove();view=null;current.previousFocus?.focus?.();}
    controls();return true;
  }
  async function discard(){
    if(active?.confirming)await active.confirming.catch(()=>{});
    if(active)active.abandoned=true;
    return close();
  }
  function createDialog(){
    if(view)return;
    const dialog=node('dialog');dialog.id='slOriginalPhotoExportDialog';dialog.className='sl-original-export';
    const title=node('h2','元写真をまとめて保存');title.id='slOriginalExportTitle';dialog.setAttribute('aria-labelledby',title.id);
    const description=node('p','この端末にある、選択案件の元写真を1つのZIPにまとめます。保存確認済みの写真も含め、何度でも保存できます。');
    const label=node('label','保存する案件'),project=node('select');project.id='slOriginalExportProject';project.required=true;project.append(new Option('案件を選択してください',''));label.append(project);
    const summary=node('p','案件を選択してください。');summary.id='slOriginalExportSummary';summary.className='sl-original-summary';
    const detail=node('p','作成開始時の写真をまとめます。作成中に追加した写真は、次のZIPに含まれます。元写真は端末に残ります。');
    const capacity=node('p','ZIPの作成には、写真の合計と同じくらいの空き容量が必要です。');
    const statusNode=node('p');statusNode.id='slOriginalExportStatus';statusNode.setAttribute('role','status');statusNode.setAttribute('aria-live','polite');
    const progressNode=node('progress');progressNode.id='slOriginalExportProgress';progressNode.hidden=true;progressNode.setAttribute('aria-label','ZIPの作成状況');
    const previous=node('section');previous.id='slOriginalExportPrevious';previous.hidden=true;
    previous.append(node('p','前回のZIPを保存中の場合は、保存が終わるまでお待ちください。保存済み、または保存を取りやめたことを確認した場合だけ続けてください。'));
    const previousList=node('ul');
    const previousAck=button('slOriginalExportAcknowledgePrevious','前回の保存が完了・中止したことを確認して続ける',()=>{
      if(active||!view?.previousExports.length||view.previousProject!==view.project.value)return;
      const projectId=view.previousProject,ids=view.previousExports.map(item=>item.id);
      void start(projectId,{acknowledgedPreviousExports:ids}).catch(()=>{});
    });previous.append(previousList,previousAck);
    const actions=node('div');actions.className='sl-original-export-actions';
    const startButton=button('slOriginalExportStart','1つのZIPを作成',()=>{void start(project.value).catch(()=>{});});
    const cancelButton=button('slOriginalExportCancel','作成を中止',()=>{void cancel();});cancelButton.hidden=true;
    const closeButton=button('slOriginalExportClose','閉じる',()=>{void close();});
    const results=node('div');results.className='sl-original-export-actions';
    const confirm=button('slOriginalExportConfirm','保存を確認',()=>{void confirmSaved();});confirm.disabled=true;confirm.hidden=true;
    const discardButton=button('slOriginalExportDiscard','保存を取りやめて閉じる',()=>{void discard();});discardButton.hidden=true;results.append(confirm,discardButton);
    actions.append(startButton,cancelButton,closeButton);dialog.append(title,description,label,summary,detail,capacity,statusNode,progressNode,previous,actions,results);
    view={dialog,project,summary,status:statusNode,progress:progressNode,start:startButton,cancel:cancelButton,close:closeButton,confirm,discard:discardButton,results,
      previous,previousList,previousAck,previousExports:[],previousProject:null,count:0,previewVersion:0,previousFocus:document.activeElement};
    project.onchange=()=>{clearPrevious();void preview(project.value).catch(error=>status(message(error)));};
    dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
    document.body.append(dialog);dialog.showModal();controls();
  }
  async function open(projectId){
    if(active){view?.dialog.focus();return;}
    createDialog();
    const selected=projectId??(typeof activeProjectId!=='undefined'?activeProjectId:'');
    try{await preview(selected);}catch(error){status(message(error));}
  }
  function install(){
    if(document.getElementById('slOriginalPhotoExportBtn'))return;
    launch=button('slOriginalPhotoExportBtn','元写真をまとめて保存',()=>{
      const project=typeof getProject==='function'?getProject():null;
      void open(project?.id||'');
    });
    document.querySelector('#drawingsView .manager-actions')?.append(launch);
    if(!launch.isConnected)document.querySelector('#drawingsView .manager-shell')?.prepend(launch);
  }
  const css=node('style');css.textContent='.sl-original-export{box-sizing:border-box;width:min(560px,calc(100% - 24px));max-height:88dvh;overflow:auto;border:0;border-radius:14px;padding:20px;color:#111827;background:#fff}.sl-original-export::backdrop{background:#0007}.sl-original-export h2{font-size:19px;margin:0 0 12px}.sl-original-export p{font-size:13px;line-height:1.65;overflow-wrap:anywhere}.sl-original-export label{display:block;font-size:13px}.sl-original-export select{box-sizing:border-box;display:block;width:100%;min-height:44px;padding:8px;margin-top:6px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#111827;font-size:14px}.sl-original-summary{font-weight:600}.sl-original-export-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.sl-original-export button,.sl-original-save{box-sizing:border-box;min-height:44px;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;background:#f8fafc;color:#111827;touch-action:manipulation}.sl-original-save{display:inline-flex;align-items:center;text-decoration:none;background:#0f172a;color:#fff}.sl-original-export button:disabled,.sl-original-save[aria-disabled=true]{opacity:.5}.sl-original-export [hidden]{display:none!important}.sl-original-export progress{width:100%;height:16px}#slOriginalPhotoExportBtn{min-height:44px}';document.head.append(css);
  root.SentlogOriginalPhotoExport={open,start,cancel,close,discard,get busy(){return !!active;},get state(){return active?{phase:active.phase,projectId:active.projectId,requestId:active.requestId,count:active.session?.rows.length||0,bytes:active.bytes||0,downloadStarted:active.downloadStarted,saveAcknowledged:active.saveAcknowledged,confirmed:active.confirmed,progress:active.progress}: {phase:'idle'};}};
  install();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
})(typeof globalThis!=='undefined'?globalThis:this);
