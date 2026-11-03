/* Sentlog tensile photo ledger: original A4 portrait four-picture template.
 * Read-only export. It never modifies project, shape, photos or sync records.
 * One anchor/shape per Excel worksheet; all checked photos are exported.
 * Blank load, pass/fail and post-test condition are NEVER inferred as pass/normal.
 */
(function(root){
  'use strict';
  const TEMPLATE_PATH='./tensile-ledger-template.b64';
  const ns='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const pictureRows=[1,12,23,34];
  const stages=['試験前状況','0点確認','引張試験結果','試験後 母材状況'];
  const enc=new TextEncoder(),dec=new TextDecoder();
  const xml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  const empty=()=>({place:'',anchorNo:'',detail:'',loadKn:'',judgement:'',after:''});
  const keyFor=e=>String(e.drawingId)+'\u0000'+String(e.shapeId);
  const safeText=(v,max=120)=>String(v??'').trim().slice(0,max);
  function recordsFor(entries,metadata={}){
    const byShape=new Map();
    for(const e of entries){
      if(e.included===false)continue;
      const key=keyFor(e);
      if(!byShape.has(key))byShape.set(key,{key,shapeName:safeText(e.damage||'変状'),sheetName:safeText(e.sheetName),member:safeText(e.member),photos:[]});
      byShape.get(key).photos.push(e);
    }
    const records=[];
    for(const group of byShape.values()){
      const m=metadata[group.key]||{},detail={...empty(),...m};
      if(!Object.prototype.hasOwnProperty.call(m,'place'))detail.place=group.member;
      const count=Math.ceil(group.photos.length/4);
      for(let i=0;i<count;i++)records.push({key:group.key,shapeName:group.shapeName,sheetName:group.sheetName,
        details:detail,photos:group.photos.slice(i*4,(i+1)*4),part:i+1,parts:count});
    }
    return records;
  }
  function validateDetails(record){
    const m=record.details||{};
    const judgement=safeText(m.judgement,16),after=safeText(m.after,16),raw=safeText(m.loadKn,24).replace('，','.').replace(',','.');
    if(judgement&&!['合格','不合格','判定保留'].includes(judgement))throw Error('引張試験の判定が不正です：'+record.shapeName);
    if(after&&!['異常なし','異常あり','要確認'].includes(after))throw Error('試験後の母材状況が不正です：'+record.shapeName);
    if(raw&&(!/^(?:\d{1,4})(?:\.\d{1,3})?$/.test(raw)||!(Number(raw)>0)||Number(raw)>9999.999))
      throw Error('引張荷重には0より大きい数値（kN）を入力してください：'+record.shapeName);
    if(judgement&&!raw)throw Error('合否を入力した場合は引張荷重（kN）も入力してください：'+record.shapeName);
    return {place:safeText(m.place,70),anchorNo:safeText(m.anchorNo,70),detail:safeText(m.detail,70),
      loadKn:raw?String(Number(raw)):'',judgement,after};
  }
  function resultLabels(detail){
    const load=detail.loadKn?detail.loadKn+'kN':'未入力';
    const judgement=detail.judgement||'未判定';
    return {test:'引張試験結果 '+load+' '+judgement,after:'試験後 母材状況 '+(detail.after||'未確認')};
  }
  // Insert values ONLY into existing cells, leaving style IDs, row heights,
  // merged ranges, borders, page margins, paper type and numbered ovals intact.
  function setCell(template,ref,value){
    const re=new RegExp('(<c\\s+r="'+ref+'"[^>]*)(?:\\/>|>[\\s\\S]*?<\\/c>)');
    if(!re.test(template))throw Error('引張試験用Excelの入力セルが見つかりません：'+ref);
    return template.replace(re,(_,head)=>head.replace(/\s+t="[^"]*"/g,'')+' t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>');
  }
  function worksheetXml(original,record){
    const m=validateDetails(record),labels=resultLabels(m);
    let sheet=original;
    for(let i=0;i<4;i++){
      const row=pictureRows[i];
      sheet=setCell(sheet,'C'+row,''); // clear the template's grey "余白" wording inside the photo frame
      sheet=setCell(sheet,'I'+(row+1),m.place);
      sheet=setCell(sheet,'I'+(row+2),m.anchorNo);
      sheet=setCell(sheet,'I'+(row+3),m.detail);
    }
    sheet=setCell(sheet,'I27',labels.test);
    sheet=setCell(sheet,'I38',labels.after);
    return sheet;
  }
  // Widths are those in the supplied C:G merged photo frame; the source photo
  // converter already letterboxes photos to 960 x 720, so the image anchor is 4:3.
  const photoWidthPx=[10.625,10.625,10.625,14.5,14.25].reduce((sum,w)=>sum+Math.floor(w*7+5),0);
  function pictureSize(slot){
    const rowHeights=slot===3?[27,27,27.75,27.75,27.75,27.75,27.75,27.75,27.75,27.75]:Array(10).fill(27);
    const maxHeight=rowHeights.reduce((sum,pt)=>sum+pt*4/3,0)-14;
    const maxWidth=photoWidthPx-14;
    const w=Math.min(maxWidth,maxHeight*4/3),h=w*3/4;
    return {x:Math.round((photoWidthPx-w)/2*9525),y:Math.round((maxHeight+14-h)/2*9525),
      w:Math.round(w*9525),h:Math.round(h*9525)};
  }
  function imageAnchor(picId,relId,index){
    const row=pictureRows[index]-1,p=pictureSize(index);
    return '<xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>'+p.x+'</xdr:colOff><xdr:row>'+row+'</xdr:row><xdr:rowOff>'+p.y+'</xdr:rowOff></xdr:from>'+
      '<xdr:ext cx="'+p.w+'" cy="'+p.h+'"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="'+picId+'" name="引張試験写真 '+(index+1)+'"/>'+
      '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId'+relId+'"/>'+
      '<a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'+
      '<a:ln><a:noFill/></a:ln></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
  }
  function pictureDrawing(original,record,index){
    let drawing=original,images=[];
    for(let i=0;i<record.photos.length;i++){
      const p=record.photos[i];
      if(!(p.jpeg instanceof Uint8Array)||!p.jpeg.length)throw Error('未取得の写真があります：'+record.shapeName);
      const name='xl/media/tensile-'+(index+1)+'-'+(i+1)+'.jpeg';
      images.push({name,data:p.jpeg});
      drawing=drawing.replace('</xdr:wsDr>',imageAnchor(10+i,i+1,i)+'</xdr:wsDr>');
    }
    if(images.length){drawing=drawing.replace('<xdr:wsDr ','<xdr:wsDr xmlns:r="'+ns+'" ');}
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      images.map((item,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+ns+'image" Target="../media/'+item.name.split('/').at(-1)+'"/>').join('')+'</Relationships>';
    return {drawing,rels,images};
  }
  function workbookXml(original,names){
    let book=original.replace(/<sheets>[\s\S]*?<\/sheets>/,
      '<sheets>'+names.map((name,i)=>'<sheet name="'+xml(name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets>');
    book=book.replace(/<definedNames>[\s\S]*?<\/definedNames>/,
      '<definedNames>'+names.map((name,i)=>'<definedName name="_xlnm.Print_Area" localSheetId="'+i+'">'+
      xml("'"+name.replace(/'/g,"''")+"'!$A$1:$J$43")+'</definedName>').join('')+'</definedNames>');
    return book;
  }
  function appXml(original,names){
    return original.replace(/<HeadingPairs>[\s\S]*?<\/HeadingPairs>/,
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant><vt:variant><vt:i4>'+names.length+'</vt:i4></vt:variant></vt:vector></HeadingPairs>')
      .replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/,
        '<TitlesOfParts><vt:vector size="'+names.length+'" baseType="lpstr">'+names.map(name=>'<vt:lpstr>'+xml(name)+'</vt:lpstr>').join('')+'</vt:vector></TitlesOfParts>');
  }
  function contentTypes(n){
    const prefix='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
    const defs=[['rels','application/vnd.openxmlformats-package.relationships+xml'],['xml','application/xml'],['bin','application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings'],['jpeg','image/jpeg']]
      .map(([extension,type])=>'<Default Extension="'+extension+'" ContentType="'+type+'"/>').join('');
    const overrides=[['/xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['/xl/styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
      ['/xl/theme/theme1.xml','application/vnd.openxmlformats-officedocument.theme+xml'],
      ['/xl/sharedStrings.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
      ['/docProps/core.xml','application/vnd.openxmlformats-package.core-properties+xml'],
      ['/docProps/app.xml','application/vnd.openxmlformats-officedocument.extended-properties+xml']];
    for(let i=1;i<=n;i++)overrides.push(['/xl/worksheets/sheet'+i+'.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],['/xl/drawings/drawing'+i+'.xml','application/vnd.openxmlformats-officedocument.drawing+xml']);
    return prefix+defs+overrides.map(([part,type])=>'<Override PartName="'+part+'" ContentType="'+type+'"/>').join('')+'</Types>';
  }
  async function buildXlsx(projectName,groupName,entries,metadata={},templateBytes){
    const records=recordsFor(entries,metadata);
    if(!records.length)throw Error('引張試験用に出力できる写真がありません。');
    const standard=root.SentlogPhotoLedger||(typeof require==='function'?require('./photo-ledger.js'):null);
    const damage=root.SentlogDamageLedger||(typeof require==='function'?require('./photo-ledger-damage.js'):null);
    if(!standard?.zipStored||!standard?.excelSheetNames||!damage?.unzip)throw Error('写真台帳の共通機能を読み込めません。');
    const photos=records.flatMap(r=>r.photos);
    if(photos.length>standard.MAX_PHOTOS)throw Error('写真が600枚を超えています。図面No.を分けて出力してください。');
    if(photos.some(p=>!(p.jpeg instanceof Uint8Array)||!p.jpeg.length))throw Error('未取得の写真があります。');
    // Validate all records before opening a ZIP or writing any output.
    for(const record of records)validateDetails(record);
    if(!templateBytes){
      if(typeof fetch!=='function')throw Error('引張試験用テンプレートを指定してください。');
      const response=await fetch(TEMPLATE_PATH,{cache:'force-cache'});
      if(!response.ok)throw Error('引張試験用のExcel書式を読み込めません。オンラインで再読み込みしてください。');
      const encoded=(await response.text()).trim();
      if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length<2000)
        throw Error('引張試験用のExcel書式が破損しています。');
      const bytes=atob(encoded);templateBytes=new Uint8Array(bytes.length);
      for(let i=0;i<bytes.length;i++)templateBytes[i]=bytes.charCodeAt(i);
    }
    const input=await damage.unzip(templateBytes),required=['xl/worksheets/sheet1.xml','xl/drawings/drawing1.xml','xl/styles.xml','xl/workbook.xml','xl/_rels/workbook.xml.rels'];
    for(const part of required)if(!input.has(part))throw Error('引張試験用のExcel書式が破損しています：'+part);
    const read=name=>{const bytes=input.get(name);if(!bytes)throw Error('テンプレートに必要なデータがありません：'+name);return dec.decode(bytes);};
    const getBytes=name=>{const bytes=input.get(name);if(!bytes)throw Error('テンプレートに必要なデータがありません：'+name);return bytes;};
    const baseNames=records.map((record,i)=>safeText(record.details.anchorNo,25)||'引張試験'+String(i+1).padStart(3,'0'));
    const names=standard.excelSheetNames(baseNames.map((name,i)=>records[i].part>1?name+'-続き'+records[i].part:name));
    const pairs=[];const add=(name,bytes)=>pairs.push([name,bytes]);
    for(const file of ['_rels/.rels','xl/theme/theme1.xml','xl/styles.xml','xl/sharedStrings.xml','docProps/core.xml'])add(file,getBytes(file));
    add('docProps/app.xml',appXml(read('docProps/app.xml'),names));
    add('xl/workbook.xml',workbookXml(read('xl/workbook.xml'),names));
    const relHead='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    add('xl/_rels/workbook.xml.rels',relHead+names.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+ns+'worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+
      '<Relationship Id="rId'+(names.length+1)+'" Type="'+ns+'styles" Target="styles.xml"/>'+
      '<Relationship Id="rId'+(names.length+2)+'" Type="'+ns+'theme" Target="theme/theme1.xml"/>'+
      '<Relationship Id="rId'+(names.length+3)+'" Type="'+ns+'sharedStrings" Target="sharedStrings.xml"/></Relationships>');
    const baseSheet=read('xl/worksheets/sheet1.xml'),baseDrawing=read('xl/drawings/drawing1.xml');
    for(let i=0;i<records.length;i++){
      const id=i+1,rec=records[i],drawing=pictureDrawing(baseDrawing,rec,i);
      add('xl/worksheets/sheet'+id+'.xml',worksheetXml(baseSheet,rec));
      add('xl/drawings/drawing'+id+'.xml',drawing.drawing);
      add('xl/drawings/_rels/drawing'+id+'.xml.rels',drawing.rels);
      add('xl/worksheets/_rels/sheet'+id+'.xml.rels',relHead+
        '<Relationship Id="rId1" Type="'+ns+'printerSettings" Target="../printerSettings/printerSettings'+id+'.bin"/>'+
        '<Relationship Id="rId2" Type="'+ns+'drawing" Target="../drawings/drawing'+id+'.xml"/></Relationships>');
      add('xl/printerSettings/printerSettings'+id+'.bin',getBytes('xl/printerSettings/printerSettings1.bin'));
      for(const image of drawing.images)add(image.name,image.data);
    }
    add('[Content_Types].xml',contentTypes(records.length));
    return standard.zipStored(pairs);
  }
  const api={TEMPLATE_PATH,stages,empty,keyFor,recordsFor,validateDetails,resultLabels,worksheetXml,pictureDrawing,workbookXml,buildXlsx};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.SentlogTensileLedger=api;
})(typeof globalThis!=='undefined'?globalThis:this);