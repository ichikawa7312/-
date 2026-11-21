/* Sequential, uncompressed ZIP writer. Photo bytes are never collected in RAM. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.SentlogOriginalPhotoZip=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const CHUNK_BYTES=256*1024,MAX32=0xffffffffn,MAX16=0xffff,MAX64=0xffffffffffffffffn;
  const encoder=new TextEncoder();
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
  function error(code,message){const e=new Error(message);e.code=code;return e;}
  function u16(value){return Uint8Array.of(value&255,(value>>>8)&255);}
  function u32(value){const n=Number(value);return Uint8Array.of(n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255);}
  function u64(value){let n=BigInt(value);if(n<0n||n>MAX64)throw error('ZIP_LIMIT','ZIP64の上限を超えています');const bytes=new Uint8Array(8);for(let i=0;i<8;i++){bytes[i]=Number(n&255n);n>>=8n;}return bytes;}
  function join(parts){const size=parts.reduce((n,p)=>n+p.length,0),bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;}
  function crc32(bytes,previous){let crc=previous;for(let i=0;i<bytes.length;i++)crc=table[(crc^bytes[i])&255]^(crc>>>8);return crc>>>0;}
  function utf8Prefix(value,limit){let result='',bytes=0;for(const ch of value){const n=encoder.encode(ch).length;if(bytes+n>limit)break;result+=ch;bytes+=n;}return result;}
  function safeSegment(value,fallback='_'){
    let name=String(value??fallback).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'_').trim().replace(/[. ]+$/g,'');
    if(!name||name==='.'||name==='..')name=fallback;
    if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
    if(encoder.encode(name).length>240){const dot=name.lastIndexOf('.'),ext=dot>0&&encoder.encode(name.slice(dot)).length<=32?name.slice(dot):'';name=utf8Prefix(ext?name.slice(0,dot):name,240-encoder.encode(ext).length)+ext;}
    return name;
  }
  function safePath(value){
    const segments=Array.isArray(value)?value:String(value??'').split(/[\\/]+/).filter(Boolean);
    if(!segments.length)throw error('ZIP_PATH','写真の書き出し先名がありません');
    const path=segments.map(v=>safeSegment(v)).join('/');
    if(encoder.encode(path).length>0xffff)throw error('ZIP_PATH','写真の書き出し先名が長すぎます');
    return path;
  }
  function pathForOriginal(meta){
    const date=new Date(meta.createdAt),year=Number.isNaN(+date)?'_年未設定':String(date.getFullYear());
    return safePath([year,meta.projectName||'_案件未設定','写真',meta.drawingName||'_図面未設定',meta.shapeLabel||'_変状未設定',meta.exportName||meta.originalName||'photo']);
  }
  function suffixName(name,index){
    const dot=name.lastIndexOf('.'),ext=dot>0&&encoder.encode(name.slice(dot)).length<=32?name.slice(dot):'',stem=ext?name.slice(0,dot):name,suffix=` (${index})`;
    return utf8Prefix(stem,240-encoder.encode(ext+suffix).length)+suffix+ext;
  }
  function pathRegistry(){
    const files=new Set(),directories=new Set(),nextSuffix=new Map(),fold=value=>value.normalize('NFC').toLowerCase();
    return function reserve(value){
      const segments=safePath(value).split('/');
      // Also avoid file/directory collisions for callers using different depths.
      for(let i=0;i<segments.length-1;i++){
        const base=segments[i];let number=1;
        while(files.has(fold(segments.slice(0,i+1).join('/'))))segments[i]=suffixName(base,++number);
      }
      const last=segments.length-1,base=segments[last];let path=segments.join('/');const baseKey=fold(path);let number=nextSuffix.get(baseKey)||2;
      while(files.has(fold(path))||directories.has(fold(path))){segments[last]=suffixName(base,number++);path=segments.join('/');}
      nextSuffix.set(baseKey,number);
      files.add(fold(path));for(let i=1;i<segments.length;i++)directories.add(fold(segments.slice(0,i).join('/')));
      return path;
    };
  }
  function dosDate(value){
    let d=new Date(value??Date.now());if(Number.isNaN(+d))d=new Date(1980,0,1);
    if(d.getFullYear()<1980)d=new Date(1980,0,1);if(d.getFullYear()>2107)d=new Date(2107,11,31,23,59,58);
    return {time:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|(Math.floor(d.getSeconds()/2)&31),date:((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate()};
  }
  function localHeader(entry){
    const large=entry.size>=MAX32,extra=large?join([u16(1),u16(16),u64(entry.size),u64(entry.size)]):new Uint8Array(0);
    return join([u32(0x04034b50),u16(large?45:20),u16(0x0808),u16(0),u16(entry.time),u16(entry.date),u32(0),u32(large?MAX32:0),u32(large?MAX32:0),u16(entry.name.length),u16(extra.length),entry.name,extra]);
  }
  function descriptor(entry){return join([u32(0x08074b50),u32(entry.crc),...(entry.size>=MAX32?[u64(entry.size),u64(entry.size)]:[u32(entry.size),u32(entry.size)])]);}
  function centralHeader(entry){
    const largeSize=entry.size>=MAX32,largeOffset=entry.offset>=MAX32,payload=[];
    if(largeSize)payload.push(u64(entry.size),u64(entry.size));if(largeOffset)payload.push(u64(entry.offset));
    const data=join(payload),extra=data.length?join([u16(1),u16(data.length),data]):new Uint8Array(0),version=extra.length?45:20;
    return join([u32(0x02014b50),u16(version),u16(version),u16(0x0808),u16(0),u16(entry.time),u16(entry.date),u32(entry.crc),u32(largeSize?MAX32:entry.size),u32(largeSize?MAX32:entry.size),u16(entry.name.length),u16(extra.length),u16(0),u16(0),u16(0),u32(0),u32(largeOffset?MAX32:entry.offset),entry.name,extra]);
  }
  function createWriter(options){
    if(!options||typeof options.write!=='function')throw error('ZIP_SINK','ZIPの保存先がありません');
    const initial=BigInt(options.initialOffset??0);if(initial<0n||initial>MAX64)throw error('ZIP_LIMIT','ZIPの開始位置が不正です');
    const entries=[],reserve=pathRegistry();let offset=initial,originalBytes=0n,state='open',lastYield=Date.now();
    function check(){if(options.signal?.aborted){const reason=options.signal.reason;if(typeof reason?.code==='string'&&reason.code!=='ABORT_ERR')throw reason;const e=error('EXPORT_CANCELLED','書き出しをキャンセルしました');e.name='AbortError';throw e;}}
    async function yieldIfNeeded(){check();if(Date.now()-lastYield>=24){await new Promise(resolve=>setTimeout(resolve,0));lastYield=Date.now();check();}}
    async function emit(bytes){
      check();if(offset+BigInt(bytes.length)>MAX64)throw error('ZIP_LIMIT','ZIP64の上限を超えています');
      const written=await options.write(bytes);if(typeof written==='number'&&written!==bytes.length)throw error('ZIP_WRITE_INCOMPLETE','ZIPを最後まで保存できませんでした');
      offset+=BigInt(bytes.length);await yieldIfNeeded();
    }
    function requireOpen(){if(state!=='open')throw error('ZIP_STATE','ZIPの書き出し状態が不正です');}
    return {
      async add(input){
        requireOpen();state='adding';
        try{
          check();const blob=input?.blob;
          if(!blob||!Number.isSafeInteger(blob.size)||blob.size<0||typeof blob.slice!=='function')throw error('ZIP_SOURCE','原本写真を読み取れません');
          const path=reserve(input.path),entry={path,name:encoder.encode(path),size:BigInt(blob.size),offset,...dosDate(input.modifiedAt)};
          await emit(localHeader(entry));let crc=0xffffffff,read=0;
          while(read<blob.size){
            check();const length=Math.min(CHUNK_BYTES,blob.size-read),buffer=await blob.slice(read,read+length).arrayBuffer(),chunk=new Uint8Array(buffer);
            if(chunk.length!==length)throw error('SOURCE_CHANGED','原本写真のサイズが変わりました');
            check();crc=crc32(chunk,crc);await emit(chunk);read+=length;originalBytes+=BigInt(length);
            options.onProgress?.({entryBytes:read,entrySize:blob.size,doneFiles:entries.length,originalBytes,zipBytes:offset-initial});
          }
          entry.crc=(crc^0xffffffff)>>>0;await emit(descriptor(entry));entries.push(entry);state='open';
          return {path,crc32:entry.crc,size:blob.size};
        }catch(e){state='failed';throw e;}
      },
      async close(){
        requireOpen();state='closing';
        try{
          check();const centralStart=offset;
          for(const entry of entries)await emit(centralHeader(entry));
          const centralSize=offset-centralStart,count=BigInt(entries.length),zip64=entries.length>=MAX16||centralStart>=MAX32||centralSize>=MAX32;
          if(zip64){
            const endOffset=offset;
            await emit(join([u32(0x06064b50),u64(44),u16(45),u16(45),u32(0),u32(0),u64(count),u64(count),u64(centralSize),u64(centralStart)]));
            await emit(join([u32(0x07064b50),u32(0),u64(endOffset),u32(1)]));
          }
          await emit(join([u32(0x06054b50),u16(0),u16(0),u16(zip64?MAX16:entries.length),u16(zip64?MAX16:entries.length),u32(zip64?MAX32:centralSize),u32(zip64?MAX32:centralStart),u16(0)]));
          state='closed';return {entryCount:entries.length,originalBytes,byteLength:offset-initial,zip64};
        }catch(e){state='failed';throw e;}
      }
    };
  }
  return {CHUNK_BYTES,safeSegment,safePath,pathForOriginal,createWriter};
});
