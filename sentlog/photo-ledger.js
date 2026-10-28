/* Sentlog photo ledger v1.0. Read-only drawing records -> standalone A4 portrait XLSX.
 * No workspace, shape, photo, sync, or original-image writes occur in this module.
 */
(function(root){
  'use strict';
  const DATA_PREFIX='surveyFieldNoteDrawingV1:';
  const DRAFT_PREFIX='sentlogPhotoLedgerDraftV1:';
  const OTHER='全景・その他';
  const MAX_PHOTOS=600;
  const MAX_XLSX_BYTES=320*1024*1024;
  const enc=new TextEncoder();
  const xml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  const safeName=s=>String(s||'写真台帳').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,110)||'写真台帳';
  const number=s=>{const n=Number(s);return Number.isSafeInteger(n)&&n>0?n:null;};
  const category=s=>s?.type==='全景'||(s?.recordKind==='field-record'&&s?.recordType==='photo')?OTHER:String(s?.type||'').trim()||OTHER;
  function damageLabel(s){
    const t=String(s?.type||'変状'),n=number(s?.typeNo)||number(s?.recordNo);
    return n?t+'-'+n:String(s?.autoLabel||s?.no||t);
  }
  function collect(group,states){
    const entries=[],errors=[],seen=new Set();
    if(!group||!Array.isArray(group.sheets))throw Error('図面No.の情報を取得できません。');
    for(let sheetOrder=0;sheetOrder<group.sheets.length;sheetOrder++){
      const sheet=group.sheets[sheetOrder],raw=states[sheet.id];
      if(raw==null){errors.push((sheet.sheetName||sheet.name||sheet.id)+'：変状データが見つかりません。未記録のシートも含め、図面No.内の全シートを確認してください');continue;}
      if(!raw||!Array.isArray(raw.shapes)){errors.push((sheet.sheetName||sheet.name||sheet.id)+'：変状データが不正です');continue;}
      for(let shapeOrder=0;shapeOrder<raw.shapes.length;shapeOrder++){
        const s=raw.shapes[shapeOrder];
        if(!Array.isArray(s?.photos)){if(s?.photos)errors.push('写真の登録形式が不正です：'+(sheet.sheetName||sheet.name));continue;}
        for(let photoOrder=0;photoOrder<s.photos.length;photoOrder++){
          const photo=s.photos[photoOrder];
          if(!photo?.id||!s?.id){errors.push('写真または変状のIDがありません：'+(sheet.sheetName||sheet.name));continue;}
          const key=[sheet.id,s.id,photo.id].join(':');
          if(seen.has(key))continue;seen.add(key);
          const type=category(s);
          entries.push({key,drawingId:sheet.id,shapeId:s.id,photoId:photo.id,
            type,damage:damageLabel(s),typeNo:number(s.typeNo)||number(s.recordNo),
            sheetName:String(sheet.sheetName||sheet.name||sheet.fileName||'図面'),sheetOrder,
            page:Math.max(1,Number(s.page)||1),shapeOrder,photoOrder,
            member:String(s.member||''),photoName:String(photo.name||''),
            description:String(s.memo||''),included:true});
        }
      }
    }
    entries.sort((a,b)=>((a.type===OTHER&&b.type===OTHER)?0:a.type===OTHER?-1:b.type===OTHER?1:a.type.localeCompare(b.type,'ja'))||
      ((a.typeNo??Infinity)-(b.typeNo??Infinity))||(a.sheetOrder-b.sheetOrder)||
      (a.shapeOrder-b.shapeOrder)||(a.photoOrder-b.photoOrder));
    return {entries,errors};
  }
  function groupsFor(entries,preferred){
    const map=new Map();for(const e of entries)if(e.included){if(!map.has(e.type))map.set(e.type,[]);map.get(e.type).push(e);}
    const orig=[...map.keys()],order=(preferred||[]).filter(x=>map.has(x));for(const x of orig)if(!order.includes(x))order.push(x);
    return order.map(name=>({name,photos:map.get(name)}));
  }
  function excelSheetNames(categories){
    const used=new Set();return categories.map(s=>{
      let base=String(s||'未分類').replace(/[\[\]\\/:*?]/g,'_').replace(/^'+|'+$/g,'').trim()||'未分類';
      base=Array.from(base).slice(0,31).join('');let name=base,i=2;
      while(used.has(name.toLowerCase())){const ext=' ('+(i++)+')';name=Array.from(base).slice(0,31-ext.length).join('')+ext;}
      used.add(name.toLowerCase());return name;
    });
  }
  function crcTable(){const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;}
  const CRC=crcTable();
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
  const u16=(view,pos,v)=>view.setUint16(pos,v,true),u32=(view,pos,v)=>view.setUint32(pos,v>>>0,true);
  async function zipStored(files){
    const output=[],central=[];let offset=0,count=0,bytes=0;
    for(const [name,payload] of files){
      const nameBytes=enc.encode(name),data=payload instanceof Uint8Array?payload:
        typeof payload==='string'?enc.encode(payload):new Uint8Array(await payload.arrayBuffer());
      bytes+=data.byteLength;if(bytes>MAX_XLSX_BYTES)throw Error('台帳の容量が大きすぎます。写真を分割して出力してください。');
      const sum=crc32(data),local=new Uint8Array(30+nameBytes.length),lv=new DataView(local.buffer);
      u32(lv,0,0x04034b50);u16(lv,4,20);u16(lv,8,0);u32(lv,14,sum);u32(lv,18,data.length);u32(lv,22,data.length);u16(lv,26,nameBytes.length);local.set(nameBytes,30);
      output.push(local,data);
      const record=new Uint8Array(46+nameBytes.length),cv=new DataView(record.buffer);
      u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u32(cv,16,sum);u32(cv,20,data.length);u32(cv,24,data.length);u16(cv,28,nameBytes.length);u32(cv,42,offset);record.set(nameBytes,46);central.push(record);
      offset+=local.length+data.length;count++;
    }
    if(count>65535||offset>0xffffffff)throw Error('ExcelのZIP形式の容量制限を超えました。');
    const directorySize=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),dv=new DataView(end.buffer);
    u32(dv,0,0x06054b50);u16(dv,8,count);u16(dv,10,count);u32(dv,12,directorySize);u32(dv,16,offset);
    return new Blob([...output,...central,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  function workbookXml(names){
    const sheets=names.map((name,i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('');
    const areas=names.map((name,i)=>{const ref="'"+name.replace(/'/g,"''")+"'";return `<definedName name="_xlnm.Print_Area" localSheetId="${i}">${xml(ref)}!$A$1:$H$${this.pages[i]*30}</definedName>`;}).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets}</sheets><definedNames>${areas}</definedNames></workbook>`;
  }
  const STYLES=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="ＭＳ ゴシック"/></font><font><b/><sz val="14"/><name val="ＭＳ ゴシック"/></font><font><b/><sz val="10"/><name val="ＭＳ ゴシック"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const cell=(ref,text,style=0)=>`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  function pictureAnchor(imageId,row,rel){
    const from=`<xdr:from><xdr:col>0</xdr:col><xdr:colOff>28575</xdr:colOff><xdr:row>${row-1}</xdr:row><xdr:rowOff>28575</xdr:rowOff></xdr:from>`;
    const to=`<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row+8}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
    const pic=`<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${imageId}" name="Photo ${imageId}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${rel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
    return `<xdr:twoCellAnchor editAs="oneCell">${from}${to}${pic}<xdr:clientData/></xdr:twoCellAnchor>`;
  }
  function makeSheet(projectName,groupName,items,startNumber,imageStart){
    const pages=Math.ceil(items.length/3),rows=[],merges=[],anchors=[],images=[];
    for(let page=0;page<pages;page++){
      const base=page*30,head=base+1,meta=base+2;
      rows.push(`<row r="${head}" ht="24" customHeight="1">${cell('A'+head,groupName+'　写真台帳',1)}</row>`);
      rows.push(`<row r="${meta}" ht="20" customHeight="1">${cell('A'+meta,'案件：'+projectName+'　図面No.：'+groupName,2)}</row>`);
      merges.push(`A${head}:H${head}`,`A${meta}:H${meta}`);
      for(let slot=0;slot<3;slot++){
        const idx=page*3+slot,entry=items[idx],first=base+3+slot*9;
        for(let offset=0;offset<9;offset++){
          const r=first+offset,cells=[];
          for(const c of ['A','B','C','D'])cells.push(`<c r="${c}${r}" s="3"/>`);
          if(entry){
            const value=offset===0?'写真番号：'+String(entry.serial).padStart(3,'0'):
              offset===1?'変状：'+entry.damage:
              offset===2?'部位：'+(entry.member||'—'):
              offset===3?'図面：'+entry.sheetName+' / '+entry.page+'頁':
              offset===4?'写真名：'+entry.photoName:
              offset===5?'備考：'+entry.description:null;
            if(value!==null)cells.push(cell('E'+r,value,offset===0?4:offset===5?4:2));
          }
          rows.push(`<row r="${r}" ht="20" customHeight="1">${cells.join('')}</row>`);
        }
        if(entry){
          for(let off=0;off<5;off++)merges.push(`E${first+off}:H${first+off}`);
          merges.push(`E${first+5}:H${first+8}`);
          const mediaId=imageStart+idx;images.push({id:mediaId,data:entry.jpeg});anchors.push(pictureAnchor(mediaId,first,idx+1));
        }
      }
      const foot=base+30;rows.push(`<row r="${foot}" ht="18" customHeight="1">${cell('A'+foot,`${page+1} / ${pages} ページ`,2)}</row>`);merges.push(`A${foot}:H${foot}`);
    }
    const breaks=pages>1?`<rowBreaks count="${pages-1}" manualBreakCount="${pages-1}">${Array.from({length:pages-1},(_,i)=>`<brk id="${(i+1)*30}" min="0" max="16383" man="1"/>`).join('')}</rowBreaks>`:'';
    const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:H${pages*30}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols><col min="1" max="4" width="10.5" customWidth="1"/><col min="5" max="8" width="11.5" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData><mergeCells count="${merges.length}">${merges.map(x=>`<mergeCell ref="${x}"/>`).join('')}</mergeCells><printOptions horizontalCentered="1"/><pageMargins left="0.30" right="0.30" top="0.40" bottom="0.40" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>${breaks}<drawing r:id="rId1"/></worksheet>`;
    const drawing=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>`;
    return {sheet,drawing,images,pages};
  }
  async function buildXlsx(projectName,groupName,groups){
    const nonEmpty=groups.filter(g=>g.photos.length);
    if(!nonEmpty.length)throw Error('出力対象の写真がありません。');
    const all=nonEmpty.flatMap(g=>g.photos);
    if(all.length>MAX_PHOTOS)throw Error(`写真が${MAX_PHOTOS}枚を超えています。図面No.を分けて出力してください。`);
    if(all.some(p=>!(p.jpeg instanceof Uint8Array)||!p.jpeg.length))throw Error('未取得の写真があります。Excel出力を中止しました。');
    let serial=1;for(const e of all)e.serial=serial++;
    const names=excelSheetNames(nonEmpty.map(g=>g.name)),pages=nonEmpty.map(g=>Math.ceil(g.photos.length/3));
    const files=[],filesPush=(name,data)=>files.push([name,data]);
    filesPush('_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    const bookXml=workbookXml.call({pages},names);
    filesPush('xl/workbook.xml',bookXml);
    filesPush('xl/styles.xml',STYLES);
    filesPush('xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${names.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    let imageIndex=1;
    for(let i=0;i<nonEmpty.length;i++){
      const s=makeSheet(projectName,groupName,nonEmpty[i].photos,1,imageIndex);
      filesPush(`xl/worksheets/sheet${i+1}.xml`,s.sheet);
      filesPush(`xl/worksheets/_rels/sheet${i+1}.xml.rels`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i+1}.xml"/></Relationships>`);
      filesPush(`xl/drawings/drawing${i+1}.xml`,s.drawing);
      filesPush(`xl/drawings/_rels/drawing${i+1}.xml.rels`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${s.images.map((m,j)=>`<Relationship Id="rId${j+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${m.id}.jpeg"/>`).join('')}</Relationships>`);
      for(const img of s.images)filesPush(`xl/media/image${img.id}.jpeg`,img.data);
      imageIndex+=s.images.length;
    }
    filesPush('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')}</Types>`);
    return zipStored(files);
  }
  const pure={OTHER,MAX_PHOTOS,safeName,category,damageLabel,collect,groupsFor,excelSheetNames,zipStored,buildXlsx};
  if(typeof module!=='undefined'&&module.exports){module.exports=pure;return;}
  if(!root.document||root.SentlogPhotoLedger)return;

  const S=root.SentlogRecords;
  let modal=null,current=null,previewUrls=[];
  function element(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
  function button(text,fn,cls=''){const b=element('button',cls,text);b.type='button';b.onclick=fn;return b;}
  function cleanPreview(){for(const u of previewUrls)URL.revokeObjectURL(u);previewUrls=[];}
  function close(){if(!modal)return;if(current?.exporting){status('Excel出力中は画面を閉じられません。');return;}if(current?.changed&&!confirm('保存していない台帳の編集内容があります。閉じますか？'))return;cleanPreview();if(current?.downloadUrl)URL.revokeObjectURL(current.downloadUrl);modal.remove();modal=null;current=null;}
  function status(msg,bad=false){const el=modal?.querySelector('[data-ledger=status]');if(el){el.textContent=msg;el.style.color=bad?'#b91c1c':'#374151';}}
  async function loadShared(drawingId,photoId){
    // Reads the shared IndexedDB copy; no writes and no sync commands.
    let data=null;try{data=await getDBFile('photo:'+drawingId+':'+photoId);}catch(e){console.warn('Photo ledger shared copy',e);}
    if(!(data instanceof Blob)||!data.size){data=await root.SentlogOriginalPhotos?.getOriginal?.(drawingId,photoId);}
    return data instanceof Blob&&data.size?data:null;
  }
  function draftKey(c){return DRAFT_PREFIX+c.project.id+':'+c.group.id;}
  function loadDraft(c){
    let saved=null;try{saved=JSON.parse(localStorage.getItem(draftKey(c))||'null');}catch(_){return;}
    if(saved?.version!==1)return;
    const byKey=new Map((saved.photos||[]).map((x,i)=>[x.key,{...x,sort:i}]));
    for(const e of c.entries){const x=byKey.get(e.key);if(!x)continue;e.included=x.included!==false;e.description=String(x.description??e.description);}
    c.entries.sort((a,b)=>{const x=byKey.get(a.key),y=byKey.get(b.key);return x&&y?x.sort-y.sort:x?-1:y?1:0;});
    if(Array.isArray(saved.groupOrder)){c.groupOrder=saved.groupOrder.filter(x=>typeof x==='string');}
  }
  function saveDraft(){
    if(!current)return;
    try{
      localStorage.setItem(draftKey(current),JSON.stringify({version:1,at:Date.now(),groupOrder:current.groupOrder,photos:current.entries.map(e=>({key:e.key,included:e.included,description:e.description}))}));
      current.changed=false;status('この端末に下書きを保存しました。写真・図面・同期データには変更していません。');
    }catch(e){status('下書きを保存できませんでした：'+(e?.message||e),true);}
  }
  function groupOrder(c){const categories=[...new Set(c.entries.map(e=>e.type))];const known=c.groupOrder.filter(n=>categories.includes(n));for(const n of categories)if(!known.includes(n))known.push(n);return known;}
  function moveGroup(name,dir){const a=groupOrder(current),i=a.indexOf(name),j=i+dir;if(j<0||j>=a.length)return;[a[i],a[j]]=[a[j],a[i]];current.groupOrder=a;current.changed=true;renderEntries();}
  function movePhoto(entry,dir){const same=current.entries.filter(x=>x.type===entry.type),i=same.indexOf(entry),other=same[i+dir];if(!other)return;const a=current.entries.indexOf(entry),b=current.entries.indexOf(other);[current.entries[a],current.entries[b]]=[current.entries[b],current.entries[a]];current.changed=true;renderEntries();}
  async function thumb(img,e){
    if(!modal)return;
    try{const blob=await loadShared(e.drawingId,e.photoId);if(!modal||!img.isConnected)return;
      if(!blob){img.alt='写真データ未取得';img.replaceWith(element('div','ledger-missing','画像未取得'));return;}
      const u=URL.createObjectURL(blob);previewUrls.push(u);img.src=u;
    }catch(_){if(img.isConnected)img.replaceWith(element('div','ledger-missing','読込エラー'));}
  }
  function renderEntries(){
    if(!modal||!current)return;cleanPreview();const host=modal.querySelector('[data-ledger=list]');host.replaceChildren();
    const types=groupOrder(current);for(const type of types){const items=current.entries.filter(e=>e.type===type),active=items.filter(e=>e.included);
      const section=element('section','ledger-section'),header=element('div','ledger-section-head'),title=element('strong','',type+'　'+active.length+'/'+items.length+'枚');
      header.append(title,button('↑',()=>moveGroup(type,-1),'ledger-small'),button('↓',()=>moveGroup(type,1),'ledger-small'));section.append(header);
      for(const e of items){const row=element('div','ledger-item');const cb=element('input');cb.type='checkbox';cb.checked=e.included;cb.setAttribute('aria-label','台帳に含める');cb.onchange=()=>{e.included=cb.checked;current.changed=true;renderEntries();};
        const img=element('img','ledger-thumb');img.alt=e.photoName||e.damage;img.loading='lazy';const detail=element('div','ledger-detail');
        detail.append(element('b','',e.damage),element('small','',e.sheetName+' / '+e.page+'頁　'+(e.member||'部位未入力')));
        const desc=element('textarea');desc.rows=2;desc.value=e.description;desc.placeholder='備考・説明（台帳専用）';desc.setAttribute('aria-label',e.damage+'の台帳備考');desc.oninput=()=>{e.description=desc.value;current.changed=true;};detail.append(desc);
        const actions=element('div','ledger-order');actions.append(button('↑',()=>movePhoto(e,-1)),button('↓',()=>movePhoto(e,1)));row.append(cb,img,detail,actions);section.append(row);
        // Thumbnails are opt-in for visible items; avoids loading every image on a large job.
        if(typeof IntersectionObserver==='function'){
          const obs=new IntersectionObserver(entries=>{if(entries.some(x=>x.isIntersecting)){obs.disconnect();thumb(img,e);}},{root:modal.querySelector('.ledger-scroll'),rootMargin:'250px'});obs.observe(img);
        }else thumb(img,e);
      }host.append(section);
    }
    const chosen=current.entries.filter(x=>x.included).length;
    const pages=groupOrder(current).reduce((n,t)=>n+Math.ceil(current.entries.filter(e=>e.included&&e.type===t).length/3),0);
    modal.querySelector('[data-ledger=count]').textContent=`${chosen}枚 / ${pages}ページ / ${types.filter(t=>current.entries.some(e=>e.included&&e.type===t)).length}シート（A4縦・3枚/ページ）`;
  }
  async function preparePhotos(entries){
    // Keep no collection of full-size Blobs: on iPhone/iPad that could exhaust
    // memory long before the XLSX is ready. Process exactly one image at a time.
    const missing=[];let total=0;
    for(let i=0;i<entries.length;i++){
      const entry=entries[i];
      status('Excel用写真を確認・変換しています… '+(i+1)+' / '+entries.length);
      try{
        const blob=await loadShared(entry.drawingId,entry.photoId);
        if(!blob){missing.push(entry);continue;}
        entry.jpeg=await jpegOf(blob);
        total+=entry.jpeg.byteLength;
        if(total>MAX_XLSX_BYTES/2)throw Error('画像が多いため端末のメモリ上限を超えるおそれがあります。出力対象を分けてください。');
      }catch(e){
        if(/画像が多いため/.test(e?.message||''))throw e;
        console.warn('Photo ledger source unavailable',entry.key,e);
        missing.push(entry);
      }
    }
    return {missing};
  }
  async function jpegOf(blob){
    const url=URL.createObjectURL(blob);
    try{
      const img=new Image();await new Promise((ok,fail)=>{img.onload=ok;img.onerror=()=>fail(Error('写真の画像形式を読み込めません'));img.src=url;});
      const cv=document.createElement('canvas'),w=960,h=720;cv.width=w;cv.height=h;
      const ctx=cv.getContext('2d');if(!ctx)throw Error('画像の変換機能を利用できません');
      ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
      const k=Math.min(w/img.naturalWidth,h/img.naturalHeight);
      if(!Number.isFinite(k)||k<=0)throw Error('写真の寸法が不正です');
      const iw=img.naturalWidth*k,ih=img.naturalHeight*k;ctx.drawImage(img,(w-iw)/2,(h-ih)/2,iw,ih);
      const out=await new Promise((resolve,reject)=>cv.toBlob(x=>x?resolve(x):reject(Error('画像のJPEG変換に失敗しました')),'image/jpeg',.78));
      return new Uint8Array(await out.arrayBuffer());
    }finally{URL.revokeObjectURL(url);}
  }
  function download(blob,filename){
    // Some Safari/WebKit builds reject a synthetic click after asynchronous
    // image conversion. Keep an explicit, user-clickable download link as a
    // fallback. Hold the Blob URL until this dialog closes or is regenerated.
    if(current?.downloadUrl)URL.revokeObjectURL(current.downloadUrl);
    const previous=modal?.querySelector('.ledger-download-ready');previous?.remove();
    const u=URL.createObjectURL(blob),a=element('a','ledger-download-ready','Excelを保存');
    a.href=u;a.download=filename;
    modal?.querySelector('.ledger-controls')?.append(a);
    if(current)current.downloadUrl=u;
    a.click();
    return a;
  }
  async function exportLedger(){
    if(!current||current.exporting)return;
    const entries=current.entries.filter(x=>x.included);
    if(!entries.length){status('出力対象の写真を1枚以上選んでください。',true);return;}
    if(entries.length>MAX_PHOTOS){status('上限は'+MAX_PHOTOS+'枚です。出力対象を分けてください。',true);return;}
    current.exporting=true;const btn=modal.querySelector('[data-ledger=export]');btn.disabled=true;
    try{
      await S.settled();S.assertSafe();
      const {missing}=await preparePhotos(entries);
      if(missing.length){status('写真を'+missing.length+'枚取得・変換できません。Excel出力を停止しました：'+missing.slice(0,5).map(x=>x.damage+' / '+x.sheetName).join('、')+(missing.length>5?' ほか':''),true);return;}
      const categories=groupsFor(current.entries,current.groupOrder);
      // No source records, images or sync metadata are modified; jpeg exists only in memory.
      const file=await buildXlsx(current.project.name,current.group.name,categories);
      download(file,safeName(current.project.name)+'_'+safeName(current.group.name)+'_写真台帳.xlsx');
      status('Excelを出力しました（'+entries.length+'枚）。元の記録は変更していません。');
    }catch(e){console.error('Photo ledger export',e);status('出力できませんでした：'+(e?.message||e),true);}
    finally{for(const e of entries)delete e.jpeg;current.exporting=false;btn.disabled=false;}
  }
  function showModal(c){
    cleanPreview();modal=element('div','ledger-overlay');const panel=element('div','ledger-panel');
    const bar=element('div','ledger-head'),heading=element('div');heading.append(element('h2','','写真台帳を作成'),element('small','',c.project.name+' / '+c.group.name+'（図面No.内の全PDF）'));
    bar.append(heading,button('閉じる',close,'ledger-close'));const count=element('div','ledger-summary');count.dataset.ledger='count';
    const note=element('p','ledger-note','変状名称ごとにExcelシートを分けます。元の写真・変状・同期情報は変更しません。');
    const scroll=element('div','ledger-scroll'),list=element('div');list.dataset.ledger='list';scroll.append(list);
    const footer=element('div','ledger-footer'),stat=element('div','ledger-status');stat.dataset.ledger='status';
    const controls=element('div','ledger-controls');controls.append(button('下書き保存',saveDraft,'ledger-save'),button('Excel出力',exportLedger,'ledger-export'));controls.lastChild.dataset.ledger='export';
    footer.append(stat,controls);panel.append(bar,count,note,scroll,footer);modal.append(panel);document.body.append(modal);
    current=c;renderEntries();status('写真は全件選択されています。不要な写真を外してから出力できます。');
  }
  async function open(projectId,groupId){
    if(modal)return;
    if(!S?.ready){alert('保存先が準備できていません。再度開いてください。');return;}
    try{
      await S.settled();S.assertSafe();
      const project=workspace.projects.find(p=>p.id===projectId);if(!project)throw Error('案件が見つかりません');
      const group=root.SentlogDrawingGroups?.groupsForProject(project).find(g=>g.id===groupId);
      if(!group)throw Error('図面No.が見つかりません');
      const states={};for(const sheet of group.sheets){const raw=S.getItem(DATA_PREFIX+sheet.id);if(raw!=null){try{states[sheet.id]=JSON.parse(raw);}catch(_){throw Error('変状データを読み取れません：'+(sheet.sheetName||sheet.name));}}}
      const {entries,errors}=collect(group,states);
      if(errors.length)throw Error('写真台帳を作れません：'+errors.join(' / '));
      if(!entries.length)throw Error('この図面No.には登録写真がありません。');
      const c={project,group,entries,groupOrder:[...new Set(entries.map(x=>x.type))],changed:false,exporting:false};
      for(const e of entries)e.groupName=group.name;
      loadDraft(c);showModal(c);
    }catch(e){alert(e?.message||String(e));}
  }
  function installStyles(){if(document.getElementById('sentlogPhotoLedgerStyle'))return;const style=element('style');style.id='sentlogPhotoLedgerStyle';style.textContent=`
    .ledger-overlay{position:fixed;inset:0;background:#111827ad;z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .ledger-panel{width:min(900px,100%);height:min(94vh,970px);display:flex;flex-direction:column;background:white;border-radius:14px;box-shadow:0 10px 45px #0004;color:#111827;overflow:hidden}
    .ledger-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid #d1d5db}.ledger-head h2{margin:0 0 4px;font-size:18px}.ledger-head small{font-size:12px;color:#6b7280}
    .ledger-summary{padding:11px 16px;background:#eff6ff;font-weight:700;font-size:13px}.ledger-note{padding:0 16px;margin:10px 0;color:#4b5563;font-size:12px}
    .ledger-scroll{flex:1;overflow:auto;padding:0 16px 14px}.ledger-section{margin-bottom:16px;border:1px solid #d1d5db;border-radius:10px;overflow:hidden}
    .ledger-section-head{display:flex;align-items:center;gap:6px;background:#f3f4f6;padding:8px}.ledger-section-head strong{flex:1;font-size:14px}
    .ledger-item{display:flex;align-items:center;gap:10px;padding:9px;border-top:1px solid #e5e7eb}.ledger-item input[type=checkbox]{width:20px;height:20px;flex:none}.ledger-thumb,.ledger-missing{width:100px;height:75px;flex:none;object-fit:contain;background:#f1f5f9;border-radius:5px}.ledger-missing{display:grid;place-items:center;font-size:11px;color:#b91c1c}
    .ledger-detail{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.ledger-detail b{font-size:13px}.ledger-detail small{font-size:11px;color:#4b5563}.ledger-detail textarea{width:100%;min-height:45px;resize:vertical;border:1px solid #d1d5db;border-radius:5px;padding:5px;font-size:12px}
    .ledger-order{display:flex;flex-direction:column;gap:3px}.ledger-order button,.ledger-small{padding:4px 8px;font-size:12px}
    .ledger-footer{border-top:1px solid #d1d5db;padding:10px 16px}.ledger-status{min-height:22px;font-size:12px;word-break:break-word}.ledger-controls{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}.ledger-export{background:#176a43;color:white;border-color:#176a43}.ledger-download-ready{display:inline-flex;align-items:center;justify-content:center;border:1px solid #176a43;background:#eaf7ef;color:#155d3b;text-decoration:none;border-radius:7px;padding:9px 12px;font-size:12px;font-weight:700;min-height:40px}
    @media(max-width:600px){.ledger-overlay{padding:0}.ledger-panel{height:100dvh;border-radius:0}.ledger-thumb,.ledger-missing{width:65px;height:56px}.ledger-item{gap:6px;padding:6px}.ledger-scroll{padding:0 8px 12px}.ledger-head{padding:10px}.ledger-section-head strong{font-size:12px}.ledger-footer{padding:8px}.ledger-detail small{font-size:10px}}`;
    document.head.append(style);
  }
  function enhance(){
    installStyles();const project=typeof getProject==='function'?getProject():null;if(!project)return;
    document.querySelectorAll('#drawingsGrid .manager-card[data-drawing-group-id]').forEach(card=>{
      if(card.querySelector('[data-ledger-button]'))return;
      const actions=card.querySelector('.drawing-group-actions');if(!actions)return;
      const id=card.dataset.drawingGroupId;
      const btn=button('写真台帳（Excel）',e=>{e?.stopPropagation?.();open(project.id,id);},'ledger-open');btn.dataset.ledgerButton='1';
      btn.onpointerdown=e=>e.stopPropagation();btn.onkeydown=e=>e.stopPropagation();btn.addEventListener('click',e=>e.stopPropagation());actions.prepend(btn);
    });
  }
  const oldRender=typeof renderDrawings==='function'?renderDrawings:null;
  if(oldRender)renderDrawings=function(){const result=oldRender.apply(this,arguments);enhance();return result;};
  Promise.resolve(root.sentlogAppReady).then(()=>{if(typeof currentView!=='undefined'&&currentView==='drawings')enhance();}).catch(e=>console.warn('Photo ledger mount',e));
  root.SentlogPhotoLedger={...pure,open,enhance};
})(typeof globalThis!=='undefined'?globalThis:this);