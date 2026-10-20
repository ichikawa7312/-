/* v1.86: equivalent zero rotations and explicit, snapshot-bound record review. */
(function(root){
  'use strict';
  const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  function canonical(x){
    if(Array.isArray(x))return x.map(canonical);
    if(object(x))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));
    return x;
  }
  const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const omit=(value,keys)=>Object.fromEntries(Object.entries(value||{}).filter(([k])=>!keys.includes(k)));
  const numbered=['globalNo','typeNo','autoLabel','recordNo'];
  const shapeValue=s=>s===undefined?undefined:omit(s,numbered);
  const viewKeys=['currentPage','width','height','pdfPageInfo','nextGlobalNo','typeCounters'];
  const stateValue=s=>s===undefined?undefined:{...omit(s,viewKeys),shapes:(s.shapes||[]).map(shapeValue)};
  const metaValue=m=>m===undefined?undefined:omit(m,['updatedAt','shapeCount','photoCount']);
  const drawingValue=d=>d===undefined?undefined:{meta:metaValue(d.meta),state:stateValue(d.state)};
  function rotationValue(value){
    if(value==null)return {};
    if(!object(value))return value;
    return Object.fromEntries(Object.entries(value).flatMap(([page,angle])=>{
      if(typeof angle!=='number'||!Number.isFinite(angle))return [[page,angle]];
      const normalized=((angle%360)+360)%360;
      return normalized===0?[]:[[page,normalized]];
    }));
  }
  const recordChoiceKey=(drawingId,recordId)=>JSON.stringify([drawingId,recordId]);
  const recordName=s=>s?.recordKind==='drawing-memo'?'図面メモ（'+({rect:'四角',ellipse:'丸',line:'線',freehand:'フリーハンド',text:'文字',dimension:'寸法'}[s.memoType]||'記入')+'）':null;
  function merge(local,remote,options={}){
    const conflicts=[],preserve=options.preserve===true,base=options.base;
    const clash=(path,reason='内容が異なります')=>{conflicts.push({path,reason});return undefined;};
    function choose(l,r,b,path,clean=x=>x){
      if(equal(clean(l),clean(r)))return {done:true,value:copy(r)};
      if(base){
        if(equal(clean(l),clean(b)))return {done:true,value:copy(r)};
        if(equal(clean(r),clean(b)))return {done:true,value:copy(l)};
      }
      return {done:false};
    }
    function properties(l,r,b,path,excluded=[]){
      const out={},keys=new Set([...Object.keys(l||{}),...Object.keys(r||{}),...Object.keys(b||{})]);
      for(const k of keys){
        if(excluded.includes(k))continue;
        const picked=choose(l?.[k],r?.[k],b?.[k],path+' / '+k);
        let v;
        if(picked.done)v=picked.value;
        else if(preserve&&(l?.[k]===undefined||r?.[k]===undefined))v=copy(l?.[k]!==undefined?l[k]:r?.[k]);
        else {clash(path+' / '+k);continue;}
        if(v!==undefined)Object.defineProperty(out,k,{value:v,enumerable:true,writable:true,configurable:true});
      }
      return out;
    }
    function map(items,path){
      const out=new Map();
      if(!Array.isArray(items)){clash(path,'一覧の形式を確認できません');return out;}
      for(const x of items){
        if(!x||typeof x.id!=='string'||!x.id||out.has(x.id)){clash(path,'記録IDが不正または重複しています');continue;}
        out.set(x.id,x);
      }
      return out;
    }
    function entities(l,r,b,path,clean,combine){
      const lm=map(l,path),rm=map(r,path),bm=map(b||[],path),out=[];
      // Keep the shared order, then append this device's additions. Manual labels stay intact.
      for(const id of new Set([...rm.keys(),...lm.keys(),...bm.keys()])){
        const a=lm.get(id),z=rm.get(id),ancestor=bm.get(id),label=path+' / '+(a?.meta?.name||z?.meta?.name||a?.no||z?.no||a?.autoLabel||z?.autoLabel||recordName(a)||recordName(z)||id);
        const picked=choose(a,z,ancestor,label,clean);
        let value;
        // Manual preservation must recurse even for one-sided edits so that
        // annotations and photos deleted on only one side are still retained.
        if(preserve){
          if(a===undefined||z===undefined)value=copy(a||z);
          else if(equal(clean(a),clean(z)))value=copy(z);
          else value=combine(a,z,ancestor,label);
        }
        else if(picked.done)value=picked.value;
        else if(a===undefined||z===undefined){
          if(preserve||ancestor===undefined)value=copy(a||z);
          else {clash(label,'片方で削除され、もう片方で変更されています');continue;}
        }else value=combine(a,z,ancestor,label);
        if(value!==undefined)out.push(value);
      }
      return out;
    }
    function photo(l,r,b,path){return properties(l,r,b,path);}
    function shape(l,r,b,path,drawingId){
      const body=s=>s===undefined?undefined:omit(s,['photos',...numbered]);
      const picked=choose(body(l),body(r),body(b),path);
      const choice=preserve?options.recordChoices?.[recordChoiceKey(drawingId,l.id)]:null;
      if(!picked.done&&choice!=='local'&&choice!=='remote'){
        conflicts.push({path,reason:'同じ記録の位置・寸法・説明が変更されています',kind:'record',drawingId,recordId:l.id,local:copy(l),remote:copy(r)});return;
      }
      const out=picked.done?picked.value:copy(body(choice==='local'?l:r));
      out.photos=entities(l.photos||[],r.photos||[],b?.photos||[],path+' / 写真',x=>x,photo);
      for(const k of numbered)if(r[k]!==undefined)out[k]=copy(r[k]);
      return out;
    }
    function drawing(l,r,b,path){
      const meta=properties(l.meta,r.meta,b?.meta,path+' / 図面設定',['updatedAt','shapeCount','photoCount']);
      if(!l.state||!r.state){clash(path,'図面の記録を読み取れません');return;}
      const frameFields={sourceType:'図面の種類',fileName:'図面ファイル名',pageCount:'ページ数',pageRotations:'図面の回転',pageSettings:'用紙・縮尺',dxf:'CADの座標設定'};
      for(const [key,label] of Object.entries(frameFields)){
        if(!equal(l.state[key],r.state[key])){clash(path,label+'が異なります');return;}
      }
      const st=properties(l.state,r.state,b?.state,path+' / 用紙・縮尺',['shapes',...viewKeys]);
      st.shapes=entities(l.state.shapes||[],r.state.shapes||[],b?.state?.shapes||[],path,shapeValue,(a,z,ancestor,label)=>shape(a,z,ancestor,label,l.meta.id));
      for(const k of viewKeys)if(l.state[k]!==undefined)st[k]=copy(l.state[k]);
      meta.updatedAt=Math.max(Number(l.meta.updatedAt)||0,Number(r.meta.updatedAt)||0);
      return {id:l.id,meta,state:st};
    }
    function validate(p,label){
      if(!p?.project||!Array.isArray(p.project.drawings)||!Array.isArray(p.drawings)){clash(label,'案件の形式を確認できません');return [];}
      const metas=map(p.project.drawings,label),seen=new Set(),out=[];
      for(const d of p.drawings){
        const id=d?.meta?.id;
        if(!id||seen.has(id)||!metas.has(id)||!equal(d.meta,metas.get(id))||!d.state||!Array.isArray(d.state.shapes)){
          clash(label,'図面情報と記録が一致しません');continue;
        }
        seen.add(id);out.push({id,...copy(d)});
        map(d.state.shapes,label+' / '+(d.meta.name||id));
        for(const s of d.state.shapes)map(s.photos||[],label+' / 写真');
      }
      if(seen.size!==metas.size)clash(label,'不足した図面記録があります');
      return out;
    }
    const ls=validate(local,'この端末'),rs=validate(remote,'共有データ'),bs=base?validate(base,'前回同期'):[];
    if(!local?.project?.id||local.project.id!==remote?.project?.id||(base&&base.project?.id!==local.project.id))clash('案件','別の案件です');
    if(!preserve&&!base)clash('前回同期','共通の同期記録がありません。「両方の記録を残して同期」を選んでください');
    if(conflicts.length)return {ok:false,conflicts};
    // Missing entries and explicit 0 degrees render identically in the editor.
    // Never coerce malformed values or treat a genuine quarter-turn as equal.
    for(const d of [...ls,...rs,...bs])d.state.pageRotations=rotationValue(d.state.pageRotations);
    // Only the caller that has hashed the original PDF and read it with PDF.js
    // can provide this evidence. Never infer page count from a timestamp or max().
    for(const [id,count] of Object.entries(options.verifiedPdfPageCounts||{})){
      const l=ls.find(d=>d.id===id),r=rs.find(d=>d.id===id);
      if(!Number.isSafeInteger(count)||count<1||l?.state.sourceType!=='pdf'||r?.state.sourceType!=='pdf'){
        clash(l?.meta.name||id,'PDF原本のページ数を確認できません');continue;
      }
      for(const d of [l,r,bs.find(d=>d.id===id)].filter(Boolean)){
        // An ancestor may describe an older source; never rewrite that source.
        if(d.state.sourceType!=='pdf')continue;
        if(d.state.shapes.some(s=>!Number.isSafeInteger(s.page??1)||(s.page??1)<1||(s.page??1)>count)){
          clash(d.meta.name||id,'PDF原本に存在しないページの記録があります');continue;
        }
        d.meta.pageCount=count;d.state.pageCount=count;
      }
    }
    if(conflicts.length)return {ok:false,conflicts};
    const project=properties(local.project,remote.project,base?.project,'案件',['drawings','updatedAt']);
    const ds=entities(ls,rs,bs,local.project.name||'図面',drawingValue,drawing);
    if(conflicts.length)return {ok:false,conflicts};
    for(const d of ds){
      // Match the editor's derived numbering; manual "no" fields are never changed.
      const counters=Object.create(null);let number=0;
      for(const s of d.state.shapes){
        if(s.recordKind==='drawing-memo'||s.recordKind==='dimension-line'||s.kind==='dimension')continue;
        s.type=s.type||'腐食';s.globalNo=++number;s.typeNo=counters[s.type]=(counters[s.type]||0)+1;s.autoLabel=s.type+'-'+s.typeNo;
      }
      d.state.nextGlobalNo=number+1;d.state.typeCounters={...counters};
      d.meta.shapeCount=number;d.meta.photoCount=d.state.shapes.reduce((n,s)=>n+(s.photos?.length||0),0);
    }
    project.drawings=ds.map(d=>d.meta);
    project.updatedAt=Math.max(Number(local.project.updatedAt)||0,Number(remote.project.updatedAt)||0,Number(options.now)||Date.now())+1;
    return {ok:true,payload:{project,drawings:ds.map(({meta,state})=>({meta,state}))},conflicts:[]};
  }
  const api={merge,equal,canonical,recordChoiceKey};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.SentlogSyncMerge=api;
})(typeof window!=='undefined'?window:globalThis);
