/* Sentlog visual 3-up photo ledger. Original A4 portrait spreadsheet cells,
 * borders, merged ranges, typography and print margins are preserved.
 * This is an export-only feature: no project, photo, drawing or sync writes.
 */
(function(root){
  'use strict';
  const TEMPLATE_PATH='./visual3-ledger-template.b64';
  const period=34,positions=[2,13,24];
  const NUMBERED_TEMPLATE_COUNT=400;
  const ns='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const enc=new TextEncoder(),dec=new TextDecoder();
  const xml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  const safe=s=>String(s??'').trim().slice(0,300);
  function defaults(entry,groupName){
    return {managementNo:safe(groupName),facility:safe(entry.member||groupName),
      structure:'',purpose:safe(entry.damage||'写真'),notes:safe(entry.description)};
  }
  function details(entry,groupName){
    const values=defaults(entry,groupName),extra=entry.visual3||{};
    for(const key of Object.keys(values))if(Object.prototype.hasOwnProperty.call(extra,key))values[key]=safe(extra[key]);
    return values;
  }
  function setCell(row,ref,value){
    const re=new RegExp('(<c\\s+r="'+ref+'"[^>]*)(?:\\/>|>[\\s\\S]*?<\\/c>)');
    if(!re.test(row))throw Error('目視3連の入力セルが見つかりません：'+ref);
    return row.replace(re,function(_,head){
      return head.replace(/\s+t="[^"]*"/g,'')+' t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
    });
  }
  function shiftRow(source,delta){
    return source.replace(/<row r="(\d+)"/,function(_,n){return '<row r="'+(Number(n)+delta)+'"';})
      .replace(/<c r="([A-Z]+)(\d+)"/g,function(_,col,n){return '<c r="'+col+(Number(n)+delta)+'"';});
  }
  function shiftRange(source,delta){
    return source.replace(/([A-Z]+)(\d+)/g,function(_,col,n){return col+(Number(n)+delta);});
  }
  function worksheetXml(original,photos,groupName,startNumber){
    const match=original.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
    const merges=original.match(/<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/);
    if(!match||!merges)throw Error('目視3連のExcelレイアウトを読み込めません。');
    const source=[...match[1].matchAll(/<row\s+r="(\d+)"[\s\S]*?<\/row>/g)];
    if(source.length!==period)throw Error('目視3連のテンプレート行数が違います。');
    const mergeRefs=[...merges[1].matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map(x=>x[1]);
    if(mergeRefs.length!==48)throw Error('目視3連の罫線定義が違います。');
    const pages=Math.ceil(photos.length/3);
    const rows=[],allMerges=[];
    for(let p=0;p<pages;p++){
      const delta=p*period,local=new Map(source.map(x=>[Number(x[1]),x[0]]));
      for(let s=0;s<3;s++){
        const first=positions[s],entry=photos[p*3+s];
        const value=entry?details(entry,groupName):{managementNo:'',facility:'',structure:'',purpose:'',notes:''};
        const info=[
          ['B',first,''],['AB',first,entry?String(startNumber+p*3+s):''],
          ['AD',first+1,value.managementNo],['AD',first+2,value.facility],
          ['AD',first+3,value.structure],['AD',first+5,value.purpose],['AD',first+6,value.notes]
        ];
        for(const [col,row,text] of info)local.set(row,setCell(local.get(row),col+row,text));
      }
      for(const row of source)rows.push(shiftRow(local.get(Number(row[1])),delta));
      for(const ref of mergeRefs)allMerges.push(shiftRange(ref,delta));
    }
    let out=original.replace(/<sheetData>[\s\S]*?<\/sheetData>/,'<sheetData>'+rows.join('')+'</sheetData>')
      .replace(/<mergeCells count="\d+">[\s\S]*?<\/mergeCells>/,
        '<mergeCells count="'+allMerges.length+'">'+allMerges.map(x=>'<mergeCell ref="'+x+'"/>').join('')+'</mergeCells>')
      .replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:BB'+(period*pages)+'"/>')
      .replace(/firstPageNumber="\d+"/,'firstPageNumber="1"');
    if(pages>1){
      const breaks=Array.from({length:pages-1},(_,i)=>'<brk id="'+(period*(i+1))+'" max="35" man="1"/>').join('');
      out=out.replace('</worksheet>','<rowBreaks count="'+(pages-1)+'" manualBreakCount="'+(pages-1)+'">'+breaks+'</rowBreaks></worksheet>');
    }
    return out.replace('</worksheet>','<drawing r:id="rId2"/></worksheet>');
  }
  function pictureAnchor(id,row,rid){
    // The source frame B:X spans 23 columns (2.625 Excel units each),
    // ten 27-point rows. Contain the 4:3 letterboxed JPEG without cropping.
    const widthPx=23*Math.floor(2.625*7+5),heightPx=10*27*4/3;
    const w=Math.min(widthPx-14,(heightPx-14)*4/3),h=w*3/4;
    const x=Math.round((widthPx-w)/2*9525),y=Math.round((heightPx-h)/2*9525);
    return '<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>'+x+
      '</xdr:colOff><xdr:row>'+(row-1)+'</xdr:row><xdr:rowOff>'+y+
      '</xdr:rowOff></xdr:from><xdr:ext cx="'+Math.round(w*9525)+'" cy="'+Math.round(h*9525)+'"/>'+
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="'+id+'" name="目視写真 '+id+'"/>'+
      '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'+
      '<xdr:blipFill><a:blip r:embed="rId'+rid+'"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'+
      '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></xdr:spPr>'+
      '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
  }
  function drawingData(photos,sheetIndex){
    const images=photos.map((entry,i)=>{
      if(!(entry.jpeg instanceof Uint8Array)||!entry.jpeg.length)throw Error('未取得の写真があります。');
      return {name:'xl/media/visual3-'+sheetIndex+'-'+(i+1)+'.jpeg',data:entry.jpeg};
    });
    const drawings=images.map((_,i)=>pictureAnchor(i+1,Math.floor(i/3)*period+positions[i%3],i+1)).join('');
    const drawing='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '+
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="'+ns+'">'+drawings+'</xdr:wsDr>';
    const rels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
      images.map((item,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+ns+'/image" Target="../media/'+item.name.split('/').pop()+'"/>').join('')+'</Relationships>';
    return {drawing,rels,images};
  }
  function workbookXml(original,names,groups){
    let out=original.replace(/<sheets>[\s\S]*?<\/sheets>/,'<sheets>'+
      names.map((name,i)=>'<sheet name="'+xml(name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets>');
    const areas=names.map((name,i)=>'<definedName name="_xlnm.Print_Area" localSheetId="'+i+'">'+
      xml("'"+name.replace(/'/g,"''")+"'!$A$1:$AJ$"+(Math.ceil(groups[i].photos.length/3)*period))+'</definedName>').join('');
    return out.replace(/<definedNames>[\s\S]*?<\/definedNames>/,'<definedNames>'+areas+'</definedNames>');
  }
  function appXml(original,names){
    return original.replace(/<HeadingPairs>[\s\S]*?<\/HeadingPairs>/,
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant><vt:variant><vt:i4>'+names.length+'</vt:i4></vt:variant></vt:vector></HeadingPairs>')
      .replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/,
        '<TitlesOfParts><vt:vector size="'+names.length+'" baseType="lpstr">'+
        names.map(n=>'<vt:lpstr>'+xml(n)+'</vt:lpstr>').join('')+'</vt:vector></TitlesOfParts>');
  }
  async function buildXlsx(projectName,groupName,groups,templateBytes){
    const active=groups.filter(g=>g.photos&&g.photos.length);
    if(!active.length)throw Error('目視3連で出力する写真がありません。');
    const base=root.SentlogPhotoLedger||(typeof require==='function'?require('./photo-ledger.js'):null);
    const damage=root.SentlogDamageLedger||(typeof require==='function'?require('./photo-ledger-damage.js'):null);
    if(!base?.zipStored||!base?.excelSheetNames||!damage?.unzip)throw Error('写真台帳の共通処理が読み込まれていません。');
    const photos=active.flatMap(g=>g.photos);
    if(photos.length>base.MAX_PHOTOS)throw Error('写真が600枚を超えています。図面No.を分けて出力してください。');
    if(photos.some(p=>!(p.jpeg instanceof Uint8Array)||!p.jpeg.length))throw Error('未取得の写真があります。');
    if(!templateBytes){
      if(typeof fetch!=='function')throw Error('目視3連のテンプレートを指定してください。');
      const response=await fetch(TEMPLATE_PATH,{cache:'force-cache'});
      if(!response.ok)throw Error('目視3連のExcel書式を読み込めません。アプリを更新してください。');
      const encoded=(await response.text()).replace(/\s+/g,'');
      if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length<5000)throw Error('目視3連の書式が破損しています。');
      const decoded=atob(encoded);
      templateBytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
    }
    const raw=await damage.unzip(templateBytes);
    const read=key=>{const v=raw.get(key);if(!v)throw Error('目視3連テンプレートの部品がありません：'+key);return dec.decode(v);};
    // Append ONE visible 134-page worksheet, numbered 1–400. All photo,
    // location and remark fields remain empty and editable in Excel.
    // Do not mix these placeholders into selected photos or the original data.
    const blankValues={managementNo:'',facility:'',structure:'',purpose:'',notes:''};
    const numberedOnly=Array.from({length:NUMBERED_TEMPLATE_COUNT},()=>({visual3:blankValues}));
    const outputGroups=[...active,{name:'連番ひな形（1～400）',photos:numberedOnly,blankOnly:true}];
    const names=base.excelSheetNames(outputGroups.map(g=>g.name)),files=[],add=(path,value)=>files.push([path,value]);
    for(const path of ['_rels/.rels','xl/theme/theme1.xml','xl/styles.xml','xl/sharedStrings.xml','docProps/core.xml'])add(path,raw.get(path)||enc.encode(''));
    add('docProps/app.xml',appXml(read('docProps/app.xml'),names));
    add('xl/workbook.xml',workbookXml(read('xl/workbook.xml'),names,outputGroups));
    const relStart='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    add('xl/_rels/workbook.xml.rels',relStart+names.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+ns+'/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+
      '<Relationship Id="rId'+(names.length+1)+'" Type="'+ns+'/styles" Target="styles.xml"/>'+
      '<Relationship Id="rId'+(names.length+2)+'" Type="'+ns+'/theme" Target="theme/theme1.xml"/>'+
      '<Relationship Id="rId'+(names.length+3)+'" Type="'+ns+'/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
    const original=read('xl/worksheets/sheet1.xml');
    const printer=raw.get('xl/printerSettings/printerSettings1.bin');
    let serial=1;
    for(let i=0;i<outputGroups.length;i++){
      const id=i+1,g=outputGroups[i],images=drawingData(g.blankOnly?[]:g.photos,id);
      add('xl/worksheets/sheet'+id+'.xml',worksheetXml(original,g.photos,groupName,g.blankOnly?1:serial));
      add('xl/drawings/drawing'+id+'.xml',images.drawing);
      add('xl/drawings/_rels/drawing'+id+'.xml.rels',images.rels);
      add('xl/worksheets/_rels/sheet'+id+'.xml.rels',relStart+
        '<Relationship Id="rId1" Type="'+ns+'/printerSettings" Target="../printerSettings/printerSettings'+id+'.bin"/>'+
        '<Relationship Id="rId2" Type="'+ns+'/drawing" Target="../drawings/drawing'+id+'.xml"/></Relationships>');
      if(printer)add('xl/printerSettings/printerSettings'+id+'.bin',printer);
      for(const item of images.images)add(item.name,item.data);
      if(!g.blankOnly)serial+=g.photos.length;
    }
    let types=read('[Content_Types].xml');
    types=types.replace(/<Override PartName="\/xl\/worksheets\/sheet1.xml"[^>]*\/>/,'');
    types=types.replace('</Types>','<Default Extension="jpeg" ContentType="image/jpeg"/>'+
      names.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
        '<Override PartName="/xl/drawings/drawing'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>').join('')+'</Types>');
    add('[Content_Types].xml',types);
    return base.zipStored(files);
  }
  const api={TEMPLATE_PATH,positions,period,NUMBERED_TEMPLATE_COUNT,defaults,details,worksheetXml,drawingData,workbookXml,buildXlsx};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.SentlogVisual3Ledger=api;
})(typeof globalThis!=='undefined'?globalThis:this);
