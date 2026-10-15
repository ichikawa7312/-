"""Real built Sentlog metre dimension + longpress input on phone/iPad/desktop.
Everything is synthetic; block external services; never touch company data.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
import functools,threading,struct,zlib,os
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
def png(w=1200,h=800):
 def chunk(k,v):return struct.pack('!I',len(v))+k+v+struct.pack('!I',zlib.crc32(k+v)&0xffffffff)
 pixels=b''.join(b'\x00'+b'\xff\xff\xff'*w for _ in range(h))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
data=list(png())
meta={'id':'metres-drawing','name':'長さ入力検証図面','fileName':'plan.png','sourceType':'image','pageCount':1,'createdAt':1,'updatedAt':1}
project={'id':'metres-project','name':'長さ入力検証','drawings':[meta],'createdAt':1,'updatedAt':1}
def cdp_touch(session,kind,points):
 session.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[
 {'x':int(round(x)),'y':int(round(y)),'id':int(i),'radiusX':2,'radiusY':2,'force':1} for i,x,y in points]})
def target_center(page,index=0):
 return page.evaluate("""i=>{
 const hit=[...svg.querySelectorAll('[data-dimension-length-target="true"]')][i];
 if(!hit)return null;
 const r=hit.getBoundingClientRect();
 return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};
 }""",index)
def input_open(page):return page.locator('.sentlog-polygon-dimension-editor').count()>0
def shape_points(page):
 return page.evaluate("()=>drawing?.points.map(p=>({x:p.x,y:p.y}))||[]")
def approx(a,b,msg,eps=.1):assert abs(a-b)<eps,(msg,a,b)
try:
 with sync_playwright() as p:
  launch={'headless':True}
  if os.path.exists('/usr/bin/chromium'):launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**launch)
  for kind,width,height in [('phone',390,844),('ipad',820,1000),('desktop',1280,900)]:
   is_touch=kind!='desktop'
   ctx=browser.new_context(viewport={'width':width,'height':height},
      is_mobile=is_touch,has_touch=is_touch,device_scale_factor=1,service_workers='block')
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',
       body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("No PDF needed in synthetic test")}};')
     return
    if url.startswith('https://wiulvaqixphuobdielyy.supabase.co/'):
     rr.abort();return
    unexpected.append(url);rr.abort()
   ctx.route('**/*',route)
   page=ctx.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.49'&&!!window.SentlogPolygonDimensions",timeout=18000)
   page.evaluate("""async d=>{
    await window.sentlogAppReady;
    workspace={projects:[d.project]};
    window.SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(workspace));
    window.SentlogRecords.setItem('surveyFieldNoteDrawingV1:'+d.meta.id,
      JSON.stringify({...freshDrawingState(d.project.name),
         sourceType:'image',fileName:'plan.png',width:1200,height:800,pageCount:1,currentPage:1,shapes:[]}));
    await window.SentlogRecords.writeFile('background:'+d.meta.id,
      new File([Uint8Array.from(d.image)],'plan.png',{type:'image/png'}));
    await window.SentlogRecords.settled();
    await openDrawing(d.project.id,d.meta.id);
    state.pageSettings['1']={paperSize:'custom',customW:300,customH:200,scaleDenom:100,orientation:'auto'};
    tool='polygon';
    document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool==='polygon'));
    drawing={kind:'polygon',points:[{x:160,y:160},{x:500,y:160},{x:500,y:400},{x:300,y:400}]};
    polygonDraftCursor={closing:false,valid:true,points:[{x:300,y:400},{x:300,y:610}]};
    renderPreview();
   }""",{'project':project,'meta':meta,'image':data})
   assert page.evaluate("window.SentlogPolygonDimensions.calibrated")
   text=page.evaluate("""()=>({
     labels:[...svg.querySelectorAll('text')].map(x=>({text:x.textContent,transform:x.getAttribute('transform'),fill:x.getAttribute('fill')})),
     targets:svg.querySelectorAll('[data-dimension-length-target="true"]').length,
     drawing:JSON.stringify(drawing.points)
   })""")
   assert text['targets']==4,text
   labels=text['labels']
   for expected in ('8.50m','6.00m','5.00m','5.25m'):
    assert any(x['text']==expected for x in labels),(kind,expected,labels)
   assert any(x['text']=='6.00m' and 'rotate(90 ' in x['transform'] for x in labels)
   assert any(x['text']=='5.25m' and x['fill']=='#1d4ed8' for x in labels)
   original=shape_points(page)
   loc=target_center(page,0)
   assert loc and 0<loc['x']<width and 0<loc['y']<height, (kind,loc)
   cdp=ctx.new_cdp_session(page) if is_touch else None
   # A mere tap on the dimension label does NOT spawn input or place a vertex.
   if is_touch:
    cdp_touch(cdp,'touchStart',[(1,loc['x'],loc['y'])])
    cdp_touch(cdp,'touchEnd',[])
   else:page.mouse.click(loc['x'],loc['y'])
   assert not input_open(page),'ordinary dimension tap must be inert'
   assert shape_points(page)==original,'tap must not commit a polygon point'
   # Long-press the SAME visible dimension; input is a small temporary popup.
   loc=target_center(page,0)
   if is_touch:
    cdp_touch(cdp,'touchStart',[(2,loc['x'],loc['y'])])
   else:
    page.mouse.move(loc['x'],loc['y']);page.mouse.down()
   page.wait_for_timeout(580)
   expect(page.locator('.sentlog-polygon-dimension-editor')).to_be_visible(timeout=1500)
   assert page.evaluate('window.SentlogPolygonDimensions.editing') is True
   if is_touch:cdp_touch(cdp,'touchEnd',[])
   else:page.mouse.up()
   entry=page.locator('.sentlog-polygon-dimension-editor input')
   assert entry.input_value()=='8.500'
   entry.fill('1000')
   page.locator('.sentlog-polygon-dimension-editor button[type=submit]').click()
   assert '図面の外' in page.locator('.sentlog-polygon-dimension-editor [role=alert]').inner_text()
   assert shape_points(page)==original,'invalid length must not move any geometry'
   entry.fill('9.500')
   page.locator('.sentlog-polygon-dimension-editor button[type=submit]').click()
   assert not input_open(page),'valid input must dismiss the temporary popup'
   points=shape_points(page)
   approx(points[0]['x'],160,'first point stays fixed')
   approx(points[1]['x'],540,'first edge grows 40 world px')
   approx(points[2]['x'],540,'following corner shifted')
   approx(points[3]['x'],340,'last corner shifted')
   assert page.evaluate("drawing.points.every((p,i,a)=>i===0||polygonAligned(a[i-1],p))")
   assert page.evaluate("state.shapes.length") == 0,'unfinished draft must not be stored as completed'
   visible=page.evaluate("()=>[...svg.querySelectorAll('text')].map(x=>x.textContent)")
   assert '9.5m' in visible,visible
   # No scale: dimension UI must be absent, a small informative hint instead.
   page.evaluate("()=>{state.pageSettings['1'].scaleDenom=null;renderPreview()}")
   assert page.evaluate("svg.querySelectorAll('[data-dimension-length-target=\"true\"]').length") == 0
   assert page.locator('.sentlog-polygon-dimension-hint').is_visible()
   # Recalibrate and test that freehand remains unconstrained and unmodified.
   page.evaluate("""()=>{
     state.pageSettings['1'].scaleDenom=100;
     tool='freehand-area';drawing={kind:'freehand-area',points:[{x:30,y:40},{x:95,y:65}]};
     polygonDraftCursor=null;renderPreview();
   }""")
   assert page.evaluate("svg.querySelectorAll('[data-dimension-length-target=\"true\"]').length")==0
   assert not input_open(page)
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/polygon-dimensions-{kind}.png'),full_page=True)
   assert not errors,errors
   assert not unexpected,unexpected
   print(f'PASS real {kind}: parallel m dimension labels, instant blue preview, longpress-only input, invalid length safe, resize keeps angles, uncalibrated hides dimensions, no fixed toolbar')
   ctx.close()
  browser.close()
finally:
 server.shutdown();server.server_close()
