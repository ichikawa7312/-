/* Schedule synchronization from saved shared edits, independently of polling. */
(function(root){
  'use strict';
  const WS='surveyFieldNoteWorkspaceV1',DRAW='surveyFieldNoteDrawingV1:';
  const sharedKey=key=>key===WS||String(key).startsWith(DRAW);
  const parse=text=>{try{return JSON.parse(text);}catch(_){return null;}};
  function canonical(value){
    if(Array.isArray(value))return value.map(canonical);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
    return value;
  }
  const text=value=>JSON.stringify(canonical(value));
  function projectText(project){
    if(!project)return null;
    const copy={...project};delete copy.updatedAt;
    if(Array.isArray(copy.drawings))copy.drawings=copy.drawings.map(d=>{const m={...d};delete m.updatedAt;return m;});
    return text(copy);
  }
  function drawingText(raw){
    const value=parse(raw);if(!value||typeof value!=='object')return raw;
    for(const key of ['currentPage','width','height','pdfPageInfo','labelSize'])delete value[key];
    const photo=p=>{if(!p||typeof p!=='object')return p;const copy={...p};delete copy.localBlob;delete copy.data;return copy;};
    for(const shape of Array.isArray(value.shapes)?value.shapes:[])if(Array.isArray(shape?.photos))shape.photos=shape.photos.map(photo);
    if(Array.isArray(value.autoTracePhotos))value.autoTracePhotos=value.autoTracePhotos.map(photo);
    return text(value);
  }
  function projects(raw){const list=parse(raw)?.projects;return new Map((Array.isArray(list)?list:[]).filter(p=>p?.id).map(p=>[p.id,p]));}
  function owners(...workspaces){
    const result=new Map();
    for(const raw of workspaces)for(const [id,p] of projects(raw))for(const d of Array.isArray(p.drawings)?p.drawings:[]){
      if(!d?.id)continue;if(!result.has(d.id))result.set(d.id,new Set());result.get(d.id).add(id);
    }
    return result;
  }

  function watchRecords(records,{onChange=()=>{}}={}){
    const wrapped=new Map(),orphans=new Set();let disposed=false;
    const read=key=>records.getItem(key);
    function before(entries){
      const keys=[...new Set(entries.map(([key])=>key).filter(sharedKey))];
      return {keys,workspace:read(WS),values:new Map(keys.map(key=>[key,read(key)]))};
    }
    function after(captured,options){
      if(disposed)return;
      const workspace=read(WS),mapping=owners(captured.workspace,workspace),ids=new Set();
      if(options?.origin!=='remote'&&options?.origin!=='device')for(const key of captured.keys){
        const previous=captured.values.get(key),next=read(key);if(previous===next)continue;
        if(key===WS){
          const oldProjects=projects(previous),newProjects=projects(next);
          for(const id of new Set([...oldProjects.keys(),...newProjects.keys()]))
            if(projectText(oldProjects.get(id))!==projectText(newProjects.get(id)))ids.add(id);
        }else if(drawingText(previous)!==drawingText(next)){
          const id=key.slice(DRAW.length),found=mapping.get(id);
          if(found)for(const projectId of found)ids.add(projectId);else orphans.add(id);
        }
      }
      // A new drawing may be saved before its workspace entry is installed.
      // Keep that local edit until a later write can identify its project.
      for(const id of orphans){const found=mapping.get(id);if(found){for(const projectId of found)ids.add(projectId);orphans.delete(id);}}
      if(ids.size)try{onChange([...ids]);}catch(error){console.warn('Edit sync notification',error);}
    }
    function track(entries,options,apply){
      if(!entries.some(([key])=>sharedKey(key)))return apply();
      const captured=before(entries),result=apply();
      // Observation must not turn a successful durable write into an error.
      const notify=()=>{try{after(captured,options);}catch(error){console.warn('Edit sync observation',error);}};
      if(result&&typeof result.then==='function')return result.then(value=>{notify();return value;});
      notify();return result;
    }
    function wrap(name,make){
      const original=records[name];if(typeof original!=='function')return;
      const replacement=make(original);wrapped.set(name,{original,replacement});records[name]=replacement;
    }
    wrap('setItem',original=>function(key,value,options){return track([[key,value]],options,()=>original.call(this,key,value,options));});
    wrap('removeItem',original=>function(key,options){return track([[key,null]],options,()=>original.call(this,key,options));});
    wrap('batch',original=>function(writes,options){const entries=[...writes];return track(entries,options,()=>original.call(this,entries,options));});
    wrap('archiveAtomic',original=>function(options={}){
      const writes=[...(options.writes||[])];
      return track(writes,options,()=>original.call(this,{...options,writes}));
    });
    wrap('replaceAll',original=>function(values,files,options){
      const entries=[...values],keys=new Set([...records.keys(),...entries.map(([key])=>key)]);
      return track([...keys].map(key=>[key,null]),options,()=>original.call(this,entries,files,options));
    });
    function dispose(){
      disposed=true;orphans.clear();
      for(const [name,{original,replacement}] of wrapped)if(records[name]===replacement)records[name]=original;
    }
    return {dispose,restore:dispose};
  }

  function createScheduler({run,canRun=()=>true,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),
    clearTimer=id=>clearTimeout(id),debounceMs=800,maxWaitMs=3000,minGapMs=1500,retryMs=30000}={}){
    if(typeof run!=='function')throw TypeError('Edit sync needs a run function');
    let pending=new Set(),firstAt=null,dueAt=Infinity,retryAt=0,blockedUntil=0,lastStartedAt=-Infinity;
    let timer=null,running=false,epoch=0,disposed=false;
    function add(target,ids){
      if(target.has('*'))return;
      for(const id of typeof ids==='string'?[ids]:ids||[]){
        if(typeof id!=='string'||!id)continue;
        if(id==='*'){target.clear();target.add('*');return;}target.add(id);
      }
    }
    function cancel(){if(timer!==null)clearTimer(timer);timer=null;}
    function schedule(){
      cancel();if(disposed||running||!pending.size)return;
      const at=Math.max(dueAt,retryAt,blockedUntil,lastStartedAt+minGapMs);
      timer=setTimer(()=>{timer=null;void drain();},Math.max(0,at-now()));
    }
    function request(ids,{delay=debounceMs}={}){
      if(disposed)return;const incoming=new Set();add(incoming,ids);if(!incoming.size)return;add(pending,incoming);
      const time=now();if(firstAt===null)firstAt=time;
      dueAt=Math.min(time+Math.max(0,Number(delay)||0),firstAt+maxWaitMs);schedule();
    }
    async function drain(){
      if(disposed||running||!pending.size)return;
      if(now()<Math.max(dueAt,retryAt,blockedUntil,lastStartedAt+minGapMs)){schedule();return;}
      let allowed=false;try{allowed=canRun();}catch(_){}
      if(!allowed){blockedUntil=now()+1000;schedule();return;}
      const ids=pending,first=firstAt,token=epoch,startedAt=now();
      pending=new Set();firstAt=null;dueAt=Infinity;blockedUntil=0;running=true;
      let result;
      try{result=await run([...ids]);}
      catch(_){result={started:true,retryAt:now()+retryMs};}
      finally{
        if(token===epoch&&!disposed){
          if(result?.started!==false)lastStartedAt=startedAt;
          const responseRetry=Number(result?.retryAt),hasRetry=Number.isFinite(responseRetry)&&result?.retryAt!=null;
          if(result?.started===false||hasRetry){
            add(pending,ids);firstAt=firstAt===null?first:Math.min(firstAt,first);
            dueAt=Math.min(dueAt,now());
            retryAt=Math.max(retryAt,hasRetry?responseRetry:0,now()+(result?.started===false?1000:1));
          }else retryAt=0;
        }
        running=false;schedule();
      }
    }
    function wake(){if(disposed||!pending.size)return;blockedUntil=0;dueAt=Math.min(dueAt,now());schedule();}
    function reset(){epoch++;cancel();pending.clear();firstAt=null;dueAt=Infinity;retryAt=0;blockedUntil=0;lastStartedAt=-Infinity;}
    function dispose(){reset();disposed=true;}
    return {request,wake,reset,dispose,get pending(){return [...pending];},get running(){return running;},get retryAt(){return retryAt;}};
  }
  const api={createScheduler,watchRecords};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SentlogEditSync=api;
})(typeof window==='object'?window:globalThis);
