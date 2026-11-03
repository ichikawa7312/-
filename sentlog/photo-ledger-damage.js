/* Sentlog damage ledger: render recorded shapes into the user's unmodified cell layout.
 * The only deliberate changes from the supplied blank Excel are cell data and inserted JPEGs.
 * The bundled template omits hidden author path and obsolete cell comments, not cell formats.
 */
(function(root){
  'use strict';
  const TEMPLATE_PATH='./damage-ledger-template.xlsx';
  const dec=new TextDecoder();
  const xml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  const PERIOD=57, SLOTS=[{head:2,where:3,photo:6},{head:21,where:22,photo:25},{head:40,where:41,photo:44}];
  const u16=(v,p)=>v.getUint16(p,true),u32=(v,p)=>v.getUint32(p,true);
  async function unzip(data){
    const bytes=data instanceof Uint8Array?data:new Uint8Array(data),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),parts=new Map();let p=0;
    while(p+30<=bytes.byteLength&&u32(v,p)===0x04034b50){
      const flags=u16(v,p+6),method=u16(v,p+8),size=u32(v,p+18),n=u16(v,p+26),x=u16(v,p+28);
      if(flags&8)throw Error('ExcelテンプレートのZIPデータ形式に対応していません。');
      const path=dec.decode(bytes.subarray(p+30,p+30+n)),start=p+30+n+x;
      if(start+size>bytes.byteLength)throw Error('Excelテンプレートが途中で切れています。');
      const packed=bytes.slice(start,start+size);let raw;
      if(method===0)raw=packed;
      else if(method===8){
        if(typeof DecompressionStream!=='function')throw Error('この端末では指定書式の解凍に対応していません。');
        raw=new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      }else throw Error('指定書式の圧縮形式に対応していません。');
      parts.set(path,raw);p=start+size;
    }
    for(const required of ['xl/workbook.xml','xl/worksheets/sheet1.xml','xl/styles.xml','xl/_rels/workbook.xml.rels'])
      if(!parts.has(required))throw Error('損傷用テンプレートに必要なデータがありません：'+required);
    return parts;
  }
  function valueOf(parts,key){const b=parts.get(key);if(!b)throw Error('指定書式の部品が見つかりません：'+key);return dec.decode(b);}
  function recordsFor(entries){
    const shapes=new Map();
    for(const e of entries){
      if(e.included===false)continue;
      const key=String(e.drawingId)+'\u0000'+String(e.shapeId);
      if(!shapes.has(key))shapes.set(key,{number:e.typeNo??e.damage,member:String(e.member??'').trim(),range:e.rangeText||'',description:e.description||'',photos:[]});
      shapes.get(key).photos.push(e);
    }
    return [...shapes.values()].flatMap(s=>Array.from({length:Math.ceil(s.photos.length/2)},(_,i)=>({...s,photos:s.photos.slice(i*2,i*2+2)})));
  }
  function cellUpdate(rowXml,ref,text){
    const target=ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp('(<c\\s+r="'+target+'"[^>]*)(?:>[^]*?<\\/c>|\\/>)');
    if(!re.test(rowXml))throw Error('指定書式の入力セルが見つかりません：'+ref);
    return rowXml.replace(re,(_,head)=>{
      const attrs=head.replace(/\s+t="[^"]*"/,'');
      return attrs+' t="inlineStr"><is><t xml:space="preserve">'+xml(text)+'</t></is></c>';
    });
  }
  function shiftRow(source,delta){
    return source.replace(/<row r="(\d+)"/,(_,n)=>`<row r="${Number(n)+delta}"`)
      .replace(/<c r="([A-Z]+)(\d+)"/g,(_,col,n)=>`<c r="${col}${Number(n)+delta}"`);
  }
  function shiftCells(s,delta){return s.replace(/([A-Z]+)(\d+)/g,(_,a,n)=>a+(Number(n)+delta));}
  function sheetXml(template,groupName,records,groupTitle=groupName){
    const pages=Math.ceil(records.length/3);if(!pages)throw Error('出力対象の変状がありません。');
    const dataMatch=template.match(/<sheetData>([^]*?)<\/sheetData>/),mergeMatch=template.match(/<mergeCells count="\d+">([^]*?)<\/mergeCells>/);
    if(!dataMatch||!mergeMatch)throw Error('指定書式のセル定義を読み取れません。');
    const rowSource=[...dataMatch[1].matchAll(/<row\s+r="(\d+)"[^]*?<\/row>/g)].filter(x=>+x[1]<=PERIOD);
    if(rowSource.length!==PERIOD)throw Error('指定書式の行構成が想定と異なります。');
    const merges=[...mergeMatch[1].matchAll(/<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"\/>/g)].map(x=>x[1]);
    const rows=[],allMerges=[];
    for(let page=0;page<pages;page++){
      const delta=page*PERIOD,local=new Map(rowSource.map(x=>[+x[1],x[0]]));
      local.set(1,cellUpdate(local.get(1),'B1',groupName));
      for(let slot=0;slot<3;slot++){
        const position=SLOTS[slot],record=records[page*3+slot],first=position.head;
        for(const [r,col,v] of [[first,'C',record?.number??''],[first,'E',record?.range??''],[first,'I',record?.description??''],[position.where,'C',record?.member??''],[position.photo,'B',''],[position.photo,'H','']])
          local.set(r,cellUpdate(local.get(r),col+r,v));
      }
      for(const r of rowSource)rows.push(shiftRow(local.get(+r[1]),delta));
      for(const m of merges)allMerges.push(shiftCells(m,delta));
    }
    // Preserve the template's unprinted, formatted trailing row after the final page.
    const tail=[...dataMatch[1].matchAll(/<row\s+r="(\d+)"[^]*?<\/row>/g)].find(x=>+x[1]===PERIOD+1);
    if(tail)rows.push(shiftRow(tail[0],(pages-1)*PERIOD));
    const brks=Array.from({length:pages},(_,i)=>`<brk id="${(i+1)*PERIOD}" max="11" man="1"/>`).join('');
    return template.replace(/<sheetData>[^]*?<\/sheetData>/,'<sheetData>'+rows.join('')+'</sheetData>')
      .replace(/<mergeCells count="\d+">[^]*?<\/mergeCells>/,`<mergeCells count="${allMerges.length}">${allMerges.map(m=>`<mergeCell ref="${m}"/>`).join('')}</mergeCells>`)
      .replace(/<dimension ref="[^"]+"\/>/,`<dimension ref="A1:Z${pages*PERIOD+1}"/>`)
      .replace(/<rowBreaks[^>]*>[^]*?<\/rowBreaks>/,`<rowBreaks count="${pages}" manualBreakCount="${pages}">${brks}</rowBreaks>`)
      .replace('西面　外壁　写真台帳',xml(groupTitle+'　写真台帳'));
  }
  function picture(id,rid,row,col){
    // Photos are pre-letterboxed to 4:3 by the original ledger converter.
    // Centre a 4:3 picture within the existing B:E / H:K photo frame.
    // No cells, fonts, borders or row sizes are touched.
    const from=`<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from>`;
    const to=`<xdr:to><xdr:col>${col+3}</xdr:col><xdr:colOff>695325</xdr:colOff><xdr:row>${row+10}</xdr:row><xdr:rowOff>76200</xdr:rowOff></xdr:to>`;
    const pic=`<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="損傷写真 ${id}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></xdr:spPr></xdr:pic>`;
    return `<xdr:twoCellAnchor editAs="oneCell">${from}${to}${pic}<xdr:clientData/></xdr:twoCellAnchor>`;
  }
  function drawingData(records,index){
    const anchors=[],images=[];let id=0;
    for(let j=0;j<records.length;j++)for(let side=0;side<2;side++){
      const photo=records[j].photos[side];if(!photo)continue;
      if(!(photo.jpeg instanceof Uint8Array)||!photo.jpeg.length)throw Error('未取得の写真があります。');
      const page=Math.floor(j/3),pos=SLOTS[j%3],name=`xl/media/damage-${index}-${j+1}-${side+1}.jpeg`;
      images.push({name,data:photo.jpeg});anchors.push(picture(++id,images.length,pos.photo+page*PERIOD,side?7:1));
    }
    const drawing='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+anchors.join('')+'</xdr:wsDr>';
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+images.map((img,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${img.name.split('/').pop()}"/>`).join('')+'</Relationships>';
    return {drawing,rels,images};
  }
  function appXml(original,names){
    return original.replace(/<HeadingPairs>[^]*?<\/HeadingPairs>/,`<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant><vt:variant><vt:i4>${names.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>`)
      .replace(/<TitlesOfParts>[^]*?<\/TitlesOfParts>/,`<TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${names.map(n=>`<vt:lpstr>${xml(n)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts>`);
  }
  async function buildXlsx(projectName,groupName,groups,templateBytes){
    const nonEmpty=groups.map(g=>({name:g.name,records:recordsFor(g.photos)})).filter(g=>g.records.length);
    if(!nonEmpty.length)throw Error('出力対象の写真がありません。');
    const photos=nonEmpty.flatMap(g=>g.records.flatMap(r=>r.photos));
    const base=root.SentlogPhotoLedger||(typeof require==='function'?require('./photo-ledger.js'):null);
    if(!base?.zipStored||!base?.excelSheetNames)throw Error('写真台帳の標準処理を読み込めません。');
    if(photos.length>base.MAX_PHOTOS)throw Error('写真が600枚を超えています。図面No.を分けて出力してください。');
    if(photos.some(p=>!(p.jpeg instanceof Uint8Array)||!p.jpeg.length))throw Error('未取得の写真があります。');
    if(!templateBytes){
      if(typeof fetch!=='function')throw Error('損傷用テンプレートを指定してください。');
      const result=await fetch(TEMPLATE_PATH,{cache:'force-cache'});
      if(!result.ok)throw Error('損傷用のExcel書式を読み込めません。オンラインで再読み込みしてください。');
      templateBytes=new Uint8Array(await result.arrayBuffer());
    }
    const raw=await unzip(templateBytes),names=base.excelSheetNames(nonEmpty.map(g=>g.name));
    const files=[],add=(p,v)=>files.push([p,v]);
    const keep=['_rels/.rels','xl/theme/theme1.xml','xl/styles.xml','xl/sharedStrings.xml','docProps/core.xml'];
    for(const p of keep)if(raw.has(p))add(p,raw.get(p));
    add('docProps/app.xml',appXml(valueOf(raw,'docProps/app.xml'),names));
    let book=valueOf(raw,'xl/workbook.xml');
    book=book.replace(/<sheets>[^]*?<\/sheets>/,`<sheets>${names.map((n,i)=>`<sheet name="${xml(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets>`);
    book=book.replace(/<definedNames>[^]*?<\/definedNames>/,`<definedNames>${names.map((n,i)=>`<definedName name="_xlnm.Print_Area" localSheetId="${i}">${xml("'"+n.replace(/'/g,"''")+"'!$A$1:$L$"+(Math.ceil(nonEmpty[i].records.length/3)*PERIOD))}</definedName>`).join('')}</definedNames>`);
    add('xl/workbook.xml',book);
    const relStart='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    const br='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    add('xl/_rels/workbook.xml.rels',relStart+names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${br}worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+
      `<Relationship Id="rId${names.length+1}" Type="${br}styles" Target="styles.xml"/><Relationship Id="rId${names.length+2}" Type="${br}theme" Target="theme/theme1.xml"/><Relationship Id="rId${names.length+3}" Type="${br}sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
    const sheetTemplate=valueOf(raw,'xl/worksheets/sheet1.xml'),printer=raw.get('xl/printerSettings/printerSettings1.bin');
    for(let i=0;i<nonEmpty.length;i++){
      const id=i+1,g=nonEmpty[i],p=sheetXml(sheetTemplate,g.name,g.records,groupName+'　'+g.name),drawing=drawingData(g.records,id);
      add(`xl/worksheets/sheet${id}.xml`,p);
      add(`xl/worksheets/_rels/sheet${id}.xml.rels`,relStart+`<Relationship Id="rId1" Type="${br}printerSettings" Target="../printerSettings/printerSettings${id}.bin"/><Relationship Id="rId2" Type="${br}drawing" Target="../drawings/drawing${id}.xml"/></Relationships>`);
      add(`xl/drawings/drawing${id}.xml`,drawing.drawing);
      add(`xl/drawings/_rels/drawing${id}.xml.rels`,drawing.rels);
      if(printer)add(`xl/printerSettings/printerSettings${id}.bin`,printer);
      for(const img of drawing.images)add(img.name,img.data);
    }
    let types=valueOf(raw,'[Content_Types].xml');
    types=types.replace('</Types>','<Default Extension="jpeg" ContentType="image/jpeg"/>'+names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')+'</Types>')
      .replace(/<Override PartName="\/xl\/worksheets\/sheet1.xml"[^>]*\/>/,'').replace(/<Override PartName="\/xl\/drawings\/drawing1.xml"[^>]*\/>/,'');
    add('[Content_Types].xml',types);
    return base.zipStored(files);
  }
  const api={recordsFor,unzip,sheetXml,drawingData,buildXlsx,TEMPLATE_PATH};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.SentlogDamageLedger=api;
})(typeof globalThis!=='undefined'?globalThis:this);