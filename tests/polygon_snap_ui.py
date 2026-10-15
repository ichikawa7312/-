"""End-to-end built Sentlog tests for snapping in mouse and touch drawing.
All projects and PNGs are synthetic; external requests blocked.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import functools,threading,os,struct,zlib,json
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
def png(w=1200,h=800):
 def chunk(t,v):return struct.pack('!I',len(v))+t+v+struct.pack('!I',zlib.crc32(t+v)&0xffffffff)
 pixels=b''.join(b'\x00'+b'\xff\xff\xff'*w for _ in range(h))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
def client_point(page,x,y):
 return page.evaluate("""({x,y})=>{
   const r=document.getElementById('stageWrap').getBoundingClientRect();
   return {x:r.left+tx+x*scale,y:r.top+ty+y*scale};
 }""",{'x':x,'y':y})
def touch(session,kind,points):
 session.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[
  {'x':int(round(x)),'y':int(round(y)),'id':int(i),'radiusX':2,'radiusY':2,'force':1}
  for i,x,y in points]})
def path_points(path):
 return [tuple(float(v) for v in text.split(',')) for text in path.strip().split(' ')]
def approx(actual,expected):assert abs(actual-expected)<1.5,(actual,expected)
def hover_path(page,color):
 return page.evaluate("""color=>{
  const p=[...svg.querySelectorAll('polyline')].find(x=>x.getAttribute('stroke')===color);
  return p?.getAttribute('points')||null;
 }""",color)
data=list(png())
meta={'id':'polygon-test-drawing','name':'損傷図','fileName':'plan.png','sourceType':'image','pageCount':1,'createdAt':1,'updatedAt':1}
project={'id':'polygon-test-project','name':'角度テスト','drawings':[meta],'createdAt':1,'updatedAt':1}
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for device,width,height in [('desktop',1280,900),('ipad',820,1000)]:
   is_touch=device=='ipad'
   ctx=browser.new_context(viewport={'width':width,'height':height},has_touch=is_touch,
    is_mobile=is_touch,service_workers='block')
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',
       body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF used in synthetic polygon test")}};')
     return
    rr.abort()
   ctx.route('**/*',route)
   page=ctx.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.48'&&!!window.SentlogShapeMove",timeout=18000)
   page.evaluate("""async d=>{
     await window.sentlogAppReady;
     workspace={projects:[d.project]};
     window.SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(workspace));
     window.SentlogRecords.setItem('surveyFieldNoteDrawingV1:'+d.meta.id,
       JSON.stringify({...freshDrawingState(d.project.name),sourceType:'image',
         fileName:'plan.png',width:1200,height:800,pageCount:1,currentPage:1,shapes:[]}));
     await window.SentlogRecords.writeFile('background:'+d.meta.id,
       new File([Uint8Array.from(d.image)],'plan.png',{type:'image/png'}));
     await window.SentlogRecords.settled();
     await openDrawing(d.project.id,d.meta.id);
   }""",{'project':project,'meta':meta,'image':data})
   page.wait_for_function("currentView==='editor'&&state.sourceType==='image'",timeout=15000)
   page.locator('[data-tool="polygon"]').click()
   assert page.evaluate("tool==='polygon'")
   assert page.locator('[data-tool="polygon"]').inner_text()=='多角形（45°/90°）'
   pts=[(200,180),(360,215),(385,360),(245,350),(202,185)]
   cdp=ctx.new_cdp_session(page) if is_touch else None
   for index,(x,y) in enumerate(pts):
    at=client_point(page,x,y)
    if is_touch:
     touch(cdp,'touchStart',[(index+1,at['x']-8,at['y']-5)])
     if index>=1:
      # Nothing is committed until lifting; moving the finger shows a guide.
      before=page.evaluate('drawing.points.length')
      touch(cdp,'touchMove',[(index+1,at['x'],at['y'])])
      assert page.evaluate('drawing.points.length')==before,'touch-move only previews'
      guide=hover_path(page,'#16a34a' if index==4 else '#2563eb')
      assert guide,'touch slide must show snapped line or closing route before release'
     else:
      touch(cdp,'touchMove',[(index+1,at['x'],at['y'])])
     touch(cdp,'touchEnd',[])
    else:
     page.mouse.move(at['x'],at['y'])
     if index==1:
      ghost=hover_path(page,'#2563eb')
      assert ghost,'desktop hover shows snapped line'
      end=path_points(ghost)[-1]
      approx(end[0],360);approx(end[1],180)
     if index==4:
      closed=hover_path(page,'#16a34a')
      assert closed,'near-first hover previews 45/90 closing route'
     page.mouse.click(at['x'],at['y'])
    if index<4:
     assert page.evaluate("state.shapes.length")==0,'unfinished polygon is not saved'
     assert page.evaluate("drawing?.points.length")==index+1,'a tap adds exactly one snapped point'
   shape=page.evaluate("()=>structuredClone(state.shapes[0])")
   assert shape['kind']=='polygon',shape
   assert len(shape['points'])==5,'non-aligned last-to-first should add exactly one corner'
   assert page.evaluate("state.shapes.length")==1
   assert page.evaluate("state.shapes[0].points.every((p,i,a)=>polygonAligned(p,a[(i+1)%a.length]))")
   assert page.evaluate("polygonSimple(state.shapes[0].points)")
   assert page.evaluate("historyFor().undo.length")==1,'one polygon = one undo'
   page.evaluate("async()=>await window.SentlogRecords.settled()")
   assert page.evaluate("JSON.parse(window.SentlogRecords.getItem('surveyFieldNoteDrawingV1:polygon-test-drawing')).shapes.length")==1
   page.locator('#undoBtn').click();assert page.evaluate('state.shapes.length')==0
   page.locator('#redoBtn').click();assert page.evaluate('state.shapes.length')==1
   # Freehand remains unconstrained; draw an intentionally non-octilinear path.
   page.locator('[data-tool="freehand-area"]').click()
   starts=[(600,260),(660,287),(720,380),(630,430),(580,340)]
   start=client_point(page,*starts[0])
   if is_touch:
    touch(cdp,'touchStart',[(20,start['x'],start['y'])])
    for x,y in starts[1:]:
     move=client_point(page,x,y);touch(cdp,'touchMove',[(20,move['x'],move['y'])])
    touch(cdp,'touchEnd',[])
   else:
    page.mouse.move(start['x'],start['y']);page.mouse.down()
    for x,y in starts[1:]:
     move=client_point(page,x,y);page.mouse.move(move['x'],move['y'],steps=3)
    page.mouse.up()
   page.wait_for_function("state.shapes.length===2",timeout=3000)
   assert page.evaluate("state.shapes[1].kind==='freehand-area'")
   assert page.evaluate("""()=>{
     const p=state.shapes[1].points;
     return p.some((q,i)=>i>0&&!polygonAligned(q,p[i-1]));
   }"""),'freehand retains unconstrained curves/angles'
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/polygon-angles-{device}.png'),full_page=True)
   assert not errors,errors
   print(f'PASS {device} real app: 45/90 snap, live hover/finger preview, one-bend closure, single undo/save, original freehand still unrestricted')
   ctx.close()
  browser.close()
finally:
 server.shutdown();server.server_close()
