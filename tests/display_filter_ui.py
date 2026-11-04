"""Real-browser regression: filtered drawing PDF preserves source and records."""
import base64,functools,io,os,tempfile,threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from reportlab.pdfgen import canvas
from pypdf import PdfReader
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
f=io.BytesIO();c=canvas.Canvas(f,pagesize=(600,400))
for p in (1,2):
 c.drawString(45,360,'SOURCE-PAGE-'+str(p))
 c.line(10,10,590,390)
 c.showPage()
c.save();fixture=base64.b64encode(f.getvalue()).decode()

class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass

server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  for browser_name in os.getenv('SENTLOG_TEST_BROWSERS','chromium').split(','):
   with tempfile.TemporaryDirectory() as profile:
    opts=dict(headless=True,viewport={'width':1100,'height':850})
    if browser_name=='chromium':
     opts['args']=['--no-sandbox','--disable-dev-shm-usage']
     binary=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
     if Path(binary).exists():opts['executable_path']=binary
    context=getattr(p,browser_name).launch_persistent_context(profile,**opts)
    page=context.new_page();errors=[];external=[]
    def route(request):
     if request.request.url.startswith(origin) or request.request.url.startswith('blob:'):request.continue_()
     elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
      request.fulfill(content_type='text/javascript',body=(ROOT/'sentlog/vendor'/('export-'+request.request.url.rsplit('/',1)[-1])).read_bytes())
     else:external.append(request.request.url);request.abort()
    context.route('**/*',route)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(origin+'/sentlog/')
    page.wait_for_function("!!window.SentlogDisplayFilter && !!window.SentlogDrawingExport",timeout=30000)
    page.evaluate('sentlogAppReady')
    page.evaluate('''async encoded=>{
     const pdf=new File([Uint8Array.from(atob(encoded),x=>x.charCodeAt(0))],'source.pdf',{type:'application/pdf'});
     workspace={projects:[{id:'display-project',name:'表示フィルター試験',drawings:[{id:'display-drawing',name:'検査図面',fileName:'source.pdf',sourceType:'pdf',pageCount:2,updatedAt:1}],createdAt:1,updatedAt:1}]};
     const s=freshDrawingState('表示フィルター試験');
     Object.assign(s,{sourceType:'pdf',fileName:'source.pdf',pageCount:2,currentPage:1,width:1200,height:800,shapes:[
      {id:'crack1',page:1,kind:'line',type:'ひび割れ',autoLabel:'ひび割れ1',points:[{x:100,y:100},{x:500,y:300}],strokeWidth:2,photos:[]},
      {id:'crack2',page:1,kind:'line',type:'ひび割れ',autoLabel:'ひび割れ2',points:[{x:200,y:150},{x:700,y:350}],strokeWidth:2,photos:[]},
      {id:'corrosion',page:1,kind:'rect',type:'腐食',autoLabel:'腐食1',x:200,y:400,w:300,h:120,strokeWidth:2,photos:[]},
      {id:'photo1',page:2,kind:'field-record',recordKind:'field-record',recordType:'photo',type:'全景',point:{x:500,y:350},angle:.2,typeNo:1,photos:[]},
      {id:'memo1',page:1,recordKind:'drawing-memo',memoType:'text',kind:'memo',points:[{x:350,y:250}],text:'検証メモ',fontSize:24,color:'#111827',photos:[]}
     ]});
     SentlogRecords.setItem(drawingStorageKey('display-drawing'),JSON.stringify(s));
     await SentlogRecords.writeFile('background:display-drawing',pdf);
     saveWorkspace();await SentlogRecords.settled();showDrawings('display-project');
     await openDrawing('display-project','display-drawing');
     await SentlogRecords.settled();
    }''',fixture)
    assert page.locator('#slDisplayFilterBtn').is_visible()
    saved=page.evaluate("SentlogRecords.getItem(drawingStorageKey('display-drawing'))")
    page.locator('#slDisplayFilterBtn').click()
    assert page.locator('.sl-display-filter-dialog').is_visible()
    page.get_by_role('button',name='すべて非表示').click()
    page.locator('.sl-filter-types label',has_text='ひび割れ').locator('input').check()
    page.get_by_role('button',name='画面に反映').click()
    assert page.locator('#slDisplayFilterStatus').inner_text().startswith('表示を絞り込み中')
    assert page.evaluate("state.shapes.length")==5
    assert page.evaluate("svg.querySelectorAll('[data-id=\"crack1\"]').length")>=1
    assert page.evaluate("svg.querySelectorAll('[data-id=\"corrosion\"]').length")==0
    assert page.evaluate("SentlogRecords.getItem(drawingStorageKey('display-drawing'))")==saved
    page.locator('#slDisplayFilterBtn').click()
    # Leave only crack1, and export page one.
    page.locator('.sl-filter-group',has=page.locator('summary',has_text='ひび割れ')).locator('summary').click()
    page.locator('.sl-filter-group',has=page.locator('summary',has_text='ひび割れ')).locator('label').nth(1).locator('input').uncheck()
    page.get_by_role('button',name='選択内容でPDF作成').click()
    page.wait_for_function("!!document.querySelector('.sl-filter-save')",timeout=120000)
    with page.expect_download() as out:page.locator('.sl-filter-save').click()
    target=Path(profile)/'selected.pdf';out.value.save_as(target)
    pdf=PdfReader(target)
    assert len(pdf.pages)==1
    assert 'SOURCE-PAGE-1' in pdf.pages[0].extract_text()
    assert len(pdf.pages[0].images)>=1, 'Selected crack overlay missing'
    assert page.evaluate("SentlogRecords.getItem(drawingStorageKey('display-drawing'))")==saved
    assert page.evaluate("document.querySelectorAll('iframe').length")==0
    page.get_by_role('button',name='閉じる').click()
    page.locator('#slDisplayFilterBtn').click()
    page.get_by_role('button',name='全表示に戻す').click()
    assert page.evaluate("SentlogDisplayFilter.filter()===null")
    assert page.evaluate("svg.querySelectorAll('[data-id=\"corrosion\"]').length")>=1
    assert page.evaluate("SentlogRecords.getItem(drawingStorageKey('display-drawing'))")==saved
    # Full two-page document with only independent photo markers; damage and
    # notes must be absent from page one. Original PDF vector text remains.
    item=page.evaluate('''async()=>{
     const [item]=SentlogDrawingExport.inputSnapshot('display-project',['display-drawing'],true);
     item.filter={categories:['写真位置'],hiddenIds:[]};
     const result=await SentlogDrawingExport.createPdf(item,()=>{});
     return await new Promise((resolve,reject)=>{
      const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(result.blob);
     });
    }''')
    result=PdfReader(io.BytesIO(base64.b64decode(item)))
    assert len(result.pages)==2
    assert 'SOURCE-PAGE-1' in result.pages[0].extract_text()
    assert 'SOURCE-PAGE-2' in result.pages[1].extract_text()
    assert len(result.pages[0].images)==0,'Other annotations appeared on photo-only page'
    assert len(result.pages[1].images)>=1,'Selected independent photo marker missing'
    assert page.evaluate("SentlogRecords.getItem(drawingStorageKey('display-drawing'))")==saved
    assert not errors,errors
    assert not external,external
    print('PASS',browser_name,'UI filters and individual record selection, page PDF, photo-only PDF, unchanged stored records, no errors',flush=True)
    context.close()
finally:
 server.shutdown()
