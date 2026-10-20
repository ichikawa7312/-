"""Actual built app export; synthetic records, real PDF/IDB and native downloads."""
import base64,functools,io,json,os,tempfile,threading,zipfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from reportlab.pdfgen import canvas
from pypdf import PdfReader,PdfWriter
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'test-results/drawing-export';OUT.mkdir(parents=True,exist_ok=True)
buf=io.BytesIO();c=canvas.Canvas(buf,pagesize=(600,400))
for i in range(1,3):
 c.setStrokeColorRGB(0,.5,0);c.setLineWidth(2);c.rect(25,25,550,350);c.setFillColorRGB(0,0,0);c.drawString(45,345,'SOURCE-PAGE-'+str(i));c.setFillColorRGB(0,.6,0);c.rect(40,40,70,40,fill=1);c.showPage()
c.save();writer=PdfWriter();reader=PdfReader(io.BytesIO(buf.getvalue()))
for page in reader.pages:writer.add_page(page)
writer.pages[1].cropbox.lower_left=(20,10);writer.pages[1].cropbox.upper_right=(580,390);writer.pages[1].rotate(90)
fixture=io.BytesIO();writer.write(fixture)
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  for name in os.getenv('SENTLOG_TEST_BROWSERS','chromium').split(','):
   with tempfile.TemporaryDirectory() as profile:
    options=dict(headless=True,viewport={'width':1100,'height':850})
    exe=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
    if name=='chromium':
     options['args']=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']
     if os.path.exists(exe):options['executable_path']=exe
    context=getattr(p,name).launch_persistent_context(profile,**options);page=context.new_page();errors=[];external=[]
    def route(rr):
     if rr.request.url.startswith(origin) or rr.request.url.startswith('blob:'):rr.continue_()
     elif rr.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
      f='export-'+rr.request.url.rsplit('/',1)[-1];rr.fulfill(content_type='text/javascript',body=(ROOT/'sentlog/vendor'/f).read_bytes())
     else:external.append(rr.request.url);rr.abort()
    context.route('**/*',route);page.on('pageerror',lambda e:(errors.append(str(e)),print('PAGE ERROR',str(e),flush=True)))
    page.goto(origin+'/sentlog/');page.wait_for_function("window.SentlogDrawingExport && window.SENTLOG_BUILD==='v1.88'",timeout=30000);print(name,'app loaded',flush=True);page.evaluate('sentlogAppReady');print(name,'app ready',flush=True)
    page.evaluate('''async data=>{
     const pdf=new File([Uint8Array.from(atob(data),x=>x.charCodeAt(0))],'source.pdf',{type:'application/pdf'});
     workspace={projects:[{id:'export-project',name:'出力検証',drawings:[],createdAt:1,updatedAt:1}]};
     for(let i=0;i<2;i++){
      const id='pdf-'+i,meta={id,name:'11_魚道工',fileName:'source.pdf',sourceType:'pdf',pageCount:2,updatedAt:1};workspace.projects[0].drawings.push(meta);
      const s=freshDrawingState('出力検証');Object.assign(s,{sourceType:'pdf',fileName:'source.pdf',pageCount:2,currentPage:2,width:1232,height:836,pageRotations:{'2':90}});
      s.shapes=[{id:'damage-1',page:1,kind:'rect',type:'腐食',x:400,y:280,w:350,h:180,typeNo:1,strokeWidth:2,photos:[{id:'photo-a'}]},
       {id:'memo-1',page:1,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:400,y:530}],text:'魚道工 確認記録',fontSize:30,unit:1,color:'#1d4ed8',white:true},
       {id:'photo-1',page:2,kind:'field-record',recordKind:'field-record',recordType:'photo',type:'全景',point:{x:500,y:350},angle:0,typeNo:1,photos:[]},
       {id:'memo-2',page:2,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:350,y:450}],text:'回転した２ページ目',fontSize:24,unit:1,color:'#1d4ed8',white:true},
       {id:'dimension-1',page:1,kind:'dimension',recordKind:'dimension-line',points:[{x:400,y:680},{x:800,y:680}],manualText:'1.25m',fontSize:14,unit:1,color:'#111827'}];
      SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(s));await SentlogRecords.writeFile('background:'+id,pdf);
     }
     saveWorkspace();await SentlogRecords.settled();showDrawings('export-project');
    }''',base64.b64encode(fixture.getvalue()).decode())
    print(name,'fixture saved',flush=True)
    before=page.evaluate("JSON.stringify([workspace,...workspace.projects[0].drawings.map(d=>SentlogRecords.getItem(drawingStorageKey(d.id)))])")
    page.locator('#slDrawingExportBtn').click();page.locator('#slDrawingExportZip').click()
    page.wait_for_function("!document.querySelector('#slDrawingExportZip').disabled",timeout=120000)
    assert page.locator('.sl-export-save').count(),page.locator('.sl-export-status').inner_text()
    with page.expect_download() as download:page.locator('.sl-export-save').click()
    target=OUT/(name+'.zip');download.value.save_as(target)
    with zipfile.ZipFile(target) as z:
     assert not z.testzip();pdfs=[n for n in z.namelist() if n.endswith('.pdf')];assert len(pdfs)==2 and len(set(pdfs))==2,pdfs
     for i,f in enumerate(pdfs):
      content=z.read(f);(OUT/(name+'-'+str(i)+'.pdf')).write_bytes(content);r=PdfReader(io.BytesIO(content));assert len(r.pages)==2
      assert 'SOURCE-PAGE-1' in r.pages[0].extract_text() and 'SOURCE-PAGE-2' in r.pages[1].extract_text()
      assert abs(float(r.pages[0].mediabox.width)-600)<.1 and abs(float(r.pages[0].mediabox.height)-400)<.1
      assert abs(float(r.pages[1].mediabox.width)-560)<.1 and abs(float(r.pages[1].mediabox.height)-380)<.1
      assert all(len(x.images)>=1 for x in r.pages)
    assert page.evaluate("JSON.stringify([workspace,...workspace.projects[0].drawings.map(d=>SentlogRecords.getItem(drawingStorageKey(d.id)))])")==before
    assert page.evaluate("document.querySelectorAll('iframe').length")==0
    page.locator('.sl-export-actions button',has_text='閉じる').click()
    # Verify folder bytes after writes, and reject corrupt read-back.
    folder=page.evaluate('''async()=>{
     const saved=new Map();let corrupt=false;
     const directory={name:'company-folder',async getDirectoryHandle(name,opts){if(!opts?.create)throw new DOMException('missing','NotFoundError');return {...directory,name};},async getFileHandle(name){return {async getFile(){return new File([corrupt?'corrupt':saved.get(name)||''],name);},async createWritable(){let content;return {async write(v){content=await v.arrayBuffer();},async close(){saved.set(name,content);},async abort(){}};}};}};
     const result=await SentlogDrawingExport.runExport('export-project',['pdf-0'],{folder:directory});
     const sizes=[...saved].map(([name,b])=>[name,b.byteLength]);corrupt=true;
     let failed=false;try{await SentlogDrawingExport.runExport('export-project',['pdf-0'],{folder:directory});}catch(e){failed=e.message.includes('照合に失敗');}
     let cancelled=false;try{await SentlogDrawingExport.runExport('export-project',['pdf-0'],{onProgress:()=>SentlogDrawingExport.cancel()});}catch(e){cancelled=e.message.includes('中止');}
     return {count:result.count,sizes,failed,cancelled,busy:SentlogDrawingExport.busy,frames:document.querySelectorAll('iframe').length};
    }''')
    assert folder['count']==1 and len(folder['sizes'])==2 and folder['failed'] and folder['cancelled'] and not folder['busy'] and folder['frames']==0,folder
    # Raster and DXF source drawings use the same complete-record export path.
    page.evaluate('''async dxf=>{
     const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,1200,800);x.fillStyle='#16a34a';x.fillRect(40,40,100,100);
     const png=await new Promise(resolve=>c.toBlob(resolve));
     for(const [id,type,file] of [['image','image',new File([png],'source.png',{type:'image/png'})],['dxf','dxf',new File([dxf],'source.dxf',{type:'application/dxf'})]]){
      const meta={id,name:id,fileName:file.name,sourceType:type,pageCount:1};workspace.projects[0].drawings.push(meta);
      const s=freshDrawingState('出力検証');Object.assign(s,{sourceType:type,fileName:file.name,width:1200,height:800});s.shapes=[{id:'memo-'+id,page:1,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:200,y:300}],text:'日本語の出力',fontSize:26,unit:1,color:'#1d4ed8'}];SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(s));await SentlogRecords.writeFile('background:'+id,file);
     }
     saveWorkspace();await SentlogRecords.settled();renderDrawings();
    }''',(ROOT/'tests/fixtures/dxf-model.dxf').read_text())
    with page.expect_download() as extra:
     page.evaluate('''async()=>{const r=await SentlogDrawingExport.runExport('export-project',['image','dxf']);const a=document.createElement('a');a.href=URL.createObjectURL(r.blob);a.download='other.zip';a.click();}''')
    extra.value.save_as(OUT/(name+'-other.zip'))
    with zipfile.ZipFile(OUT/(name+'-other.zip')) as z:
     for f in z.namelist():
      if f.endswith('.pdf'):
       content=z.read(f);assert len(PdfReader(io.BytesIO(content)).pages)==1;(OUT/(name+'-'+f)).write_bytes(content)
    # Missing files are a visible failure, never a successful partial ZIP.
    page.evaluate("getBackgroundFile=async()=>null")
    page.set_viewport_size({'width':390,'height':844});page.locator('#slDrawingExportBtn').click()
    assert page.evaluate("document.querySelector('.sl-drawing-export').getBoundingClientRect().width<=innerWidth")
    page.screenshot(path=OUT/(name+'-mobile.png'))
    page.locator('#slDrawingExportZip').click();page.wait_for_function("document.querySelector('.sl-export-status').textContent.includes('元図がこの端末にありません')")
    assert page.locator('.sl-export-save').count()==0
    assert not errors,errors;assert not external,external
    print('PASS',name,'multi-drawing ZIP, all pages, crop/rotation, vector source, isolated records, missing-file failure',flush=True)
    context.close()
finally:server.shutdown()
