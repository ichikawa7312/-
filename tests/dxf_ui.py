"""DXF import/render/annotations/export/reopen; synthetic files, no account writes."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
import functools,threading,os,json,base64
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'test-results/dxf';OUT.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{server.server_port}'
try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']}
  if os.environ.get('SENTLOG_CHROMIUM'):launch['executable_path']=os.environ['SENTLOG_CHROMIUM']
  elif os.path.exists('/usr/bin/chromium'):launch['executable_path']='/usr/bin/chromium'
  browser=p.chromium.launch(**launch);ctx=browser.new_context(viewport={'width':1280,'height':900},service_workers='block',accept_downloads=True)
  unexpected=[]
  def route(rr):
   url=rr.request.url
   if url.startswith(origin+'/') or url.startswith('blob:'):rr.continue_();return
   if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
    rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("DXF test only")}};');return
   if 'supabase.co/' in url:rr.abort();return
   unexpected.append(url);rr.abort()
  ctx.route('**/*',route);page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.accept('DXF検証') if d.type=='prompt' else d.accept())
  page.goto(origin+'/sentlog/',wait_until='domcontentloaded');page.wait_for_function("window.SENTLOG_BUILD==='v1.78'&&!!window.SentlogDxf",timeout=25000)
  page.evaluate("async()=>{await sentlogAppReady;workspace={projects:[{id:'dxf-project',name:'DXF検証',drawings:[]}]};saveWorkspace();showDrawings('dxf-project');}")
  page.locator('#drawingAddInput').set_input_files(str(ROOT/'tests/fixtures/dxf-model.dxf'))
  expect(page.locator('.sl-dxf-card h2')).to_have_text('DXFを取り込む',timeout=60000)
  assert page.locator('#dxfUnits').input_value()=='4'
  page.locator('.sl-dxf-card button',has_text='取り込む').click()
  page.wait_for_function("state.sourceType==='dxf'&&document.getElementById('stageWrap').dataset.dxf==='ready'",timeout=20000)
  assert page.evaluate('state.shapes.length')==0
  assert page.evaluate("state.dxf.mmPerUnit===1&&getDrawingMeta().sourceType==='dxf'")
  frame=page.evaluate('JSON.parse(JSON.stringify(state.dxf.frame))')
  # A blank hatch area would have almost no non-white pixels. Read the actual
  # GL-rendered base canvas inside an interior CAD-coordinate rectangle.
  hatch_pixels=page.evaluate("""()=>{const f=state.dxf.frame,c=document.getElementById('bgCanvas'),ctx=c.getContext('2d'),sx=c.width/state.width,sy=c.height/state.height;
   const x=Math.floor((3400-f.xMin)/f.unitsPerPixel*sx),y=Math.floor((f.yMax-1600)/f.unitsPerPixel*sy),w=Math.floor(1600/f.unitsPerPixel*sx),h=Math.floor(1000/f.unitsPerPixel*sy);
   const a=ctx.getImageData(x,y,w,h).data;let n=0;for(let i=0;i<a.length;i+=4)if(Math.min(a[i],a[i+1],a[i+2])<220)n++;return n;}""")
  assert hatch_pixels>100,('hatch not drawn',hatch_pixels)
  page.evaluate("""()=>{const f=state.dxf.frame,P=(x,y)=>({x:(x-f.xMin)/f.unitsPerPixel,y:(f.yMax-y)/f.unitsPerPixel});
   addShape({kind:'polygon',points:[P(3200,2800),P(4600,2800),P(4600,3400),P(3200,3400)]});
   const defs=[['line',[P(500,4500),P(2000,4500)]],['freehand',[P(500,4000),P(800,4200),P(1200,4100)]],['rect',[P(5700,4200),P(6800,3200)]],['ellipse',[P(8000,4400),P(9300,3100)]],['text',[P(1000,3000)]],['dimension',[P(600,1000),P(2600,1000)]]];
   for(const [type,points] of defs)SentlogDrawingMemos.commitChange({id:'dxf-'+type,page:1,kind:type==='dimension'?'dimension':'memo',recordKind:type==='dimension'?'dimension-line':'drawing-memo',memoType:type,points,color:'#1d4ed8',unit:1,strokeWidth:1.5,text:type==='text'?'漏水確認\\n日本語メモ':'',fontSize:14,photos:[],manualText:type==='dimension'?'2.000 m':'',arrow:type==='line',dashed:type==='line'});
   clearSelection();persist();render();
  }""")
  saved=page.evaluate('JSON.stringify(state.shapes)')
  page.locator('#dxfExportBtn').click()
  with page.expect_download() as download:page.locator('.sl-dxf-card button',has_text='DXFを保存').click()
  download.value.save_as(OUT/'browser-records.dxf')
  assert page.evaluate('JSON.stringify(state.shapes)')==saved
  text=(OUT/'browser-records.dxf').read_text();assert '漏水確認' in text and 'SENTLOG_MEMO' in text and 'SENTLOG_DIMENSION' in text
  ids=page.evaluate('({project:activeProjectId,drawing:activeDrawingId})')
  page.evaluate('showProjects()');page.evaluate('(x)=>openDrawing(x.project,x.drawing)',ids)
  page.wait_for_function("document.getElementById('stageWrap').dataset.dxf==='ready'",timeout=60000)
  assert page.evaluate('JSON.stringify(state.shapes)')==saved;assert page.evaluate('JSON.parse(JSON.stringify(state.dxf.frame))')==frame
  for width in [390,820,1280]:
   page.set_viewport_size({'width':width,'height':900});page.evaluate('zoomCenter(2)');page.wait_for_timeout(100)
   assert page.evaluate('Number(document.getElementById("stageWrap").dataset.dxfPixels)<=1505000')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.evaluate('fit();render()');page.screenshot(path=OUT/'dxf-editor.png',full_page=True)
  # Import cancellation / malformed file do not erase the loaded records.
  before=page.evaluate('JSON.stringify(state)')
  page.locator('#fileInput').set_input_files(str(ROOT/'tests/fixtures/dxf-model.dxf'))
  expect(page.locator('.sl-dxf-card h2')).to_have_text('DXFを取り込む',timeout=60000)
  page.locator('.sl-dxf-card button',has_text='キャンセル').click()
  assert page.evaluate('JSON.stringify(state)')==before

  page.locator('#fileInput').set_input_files({'name':'broken.dxf','mimeType':'application/dxf','buffer':b'0\nSECTION\n2\n'})
  page.wait_for_timeout(100);assert page.evaluate('JSON.stringify(state)')==before
  # Exported annotations are themselves importable DXF; original-unit scale remains exact.
  page.locator('#drawingAddInput').set_input_files(str(OUT/'browser-records.dxf'))
  expect(page.locator('.sl-dxf-card h2')).to_have_text('DXFを取り込む',timeout=60000)
  page.locator('.sl-dxf-card button',has_text='取り込む').click()
  page.wait_for_function("state.sourceType==='dxf'&&!!state.dxf&&state.fileName==='browser-records.dxf'&&document.getElementById('stageWrap').dataset.dxf==='ready'",timeout=20000)
  assert page.evaluate('state.dxf.mmPerUnit')==1
  assert page.evaluate('state.dxf.warnings.every(s=>!s.includes("再現できません"))'),page.evaluate('state.dxf.warnings')
  page.locator('#dxfExportBtn').click()
  with page.expect_download() as download:page.locator('.sl-dxf-card button',has_text='DXFを保存').click()
  download.value.save_as(OUT/'browser-roundtrip.dxf')
  # Old Japanese codepage file imports and exports without converting originals.
  cp=base64.b64decode((ROOT/'tests/fixtures/dxf-cp932.b64').read_bytes())
  page.locator('#drawingAddInput').set_input_files({'name':'japanese.dxf','mimeType':'application/dxf','buffer':cp})
  expect(page.locator('.sl-dxf-card h2')).to_have_text('DXFを取り込む',timeout=60000)
  page.locator('.sl-dxf-card button',has_text='取り込む').click();page.wait_for_function("state.sourceType==='dxf'&&!!state.dxf&&state.fileName==='japanese.dxf'&&document.getElementById('stageWrap').dataset.dxf==='ready'",timeout=20000)
  page.evaluate("SentlogDrawingMemos.commitChange({id:'legacy-text',page:1,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:200,y:200}],text:'日本語の追記',fontSize:20,unit:1,color:'#1d4ed8'});render()")
  page.locator('#dxfExportBtn').click()
  with page.expect_download() as download:page.locator('.sl-dxf-card button',has_text='DXFを保存').click()
  download.value.save_as(OUT/'browser-cp932.dxf')
  # A remote DXF replacement cannot change the coordinate frame of an open drawing.
  result=page.evaluate('''async()=>{document.activeElement?.blur();clearSelection();const project=JSON.parse(JSON.stringify(getProject()));const incoming=JSON.parse(JSON.stringify(state));incoming.dxf.sourceHash='different-source';return await sentlogSyncView.commit({client_key:activeProjectId},{payload:{project,drawings:[{meta:getDrawingMeta(),state:incoming}]}},JSON.stringify(getProject()));}''')
  assert result=={'applied':False,'reason':'close-drawing'},result
  # Full backup includes original CP932 bytes and the DXF coordinate frame.
  with page.expect_download() as download:page.evaluate('exportSentlogBackup()')
  pack=json.loads(download.value.path().read_text())
  drawing_id=page.evaluate('activeDrawingId');entry=next(f for f in pack['files'] if f['key']=='background:'+drawing_id)
  assert base64.b64decode(entry['data'].split(',',1)[1])==cp
  assert pack['drawingStates'][drawing_id]['dxf']['frame']==page.evaluate('state.dxf.frame')
  assert not errors,errors;assert not unexpected,unexpected
  print('PASS DXF UI: hatches/Japanese/6 memos, real export, source units, stable reopen frame, responsive viewport, safe invalid-file rejection, CP932')
  ctx.close();browser.close()
finally:server.shutdown();server.server_close()
