"""Run real built Sentlog in Chromium, test long press->cross-handle->group move.
Cloud routes are synthetic and no user's account or production storage is used.
Tests mouse (desktop) and touch (iPad-like) and validates IndexedDB writes.
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import functools,threading,os,struct,zlib,base64,json,math
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
srv=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=srv.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{srv.server_port}'
def png(width=1000,height=800):
 def chunk(t,data):return struct.pack('!I',len(data))+t+data+struct.pack('!I',zlib.crc32(t+data)&0xffffffff)
 raw=b''.join(b'\x00'+b'\xff\xff\xff'*width for _ in range(height))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
data=list(png())
drawing='test-drawing-1'
shape={'id':'damage-1','page':1,'kind':'line','type':'ひび割れ','autoLabel':'ひび割れ①','typeNo':1,'globalNo':1,
 'strokeWidth':0.8,'points':[{'x':200,'y':300},{'x':340,'y':330}],'labelPos':{'x':470,'y':240},
 'photos':[{'id':'photo-fixture','name':'photo.jpg'}],'memo':'測定記録'}
project={'id':'test-project-1','name':'移動機能テスト','drawings':[{'id':drawing,'name':'図面A',
 'fileName':'plan.png','sourceType':'image','pageCount':1,'shapeCount':1,'createdAt':1,'updatedAt':1}],
 'createdAt':1,'updatedAt':1}
state={'project':'移動機能テスト','sourceType':'image','fileName':'plan.png','width':1000,'height':800,
 'pageCount':1,'currentPage':1,'shapes':[shape]}
def approx(a,b,eps=.75):assert abs(a-b)<=eps,(a,b)
def pagepoint(page,x,y):
 return page.evaluate("""p=>{const r=document.getElementById('stageWrap').getBoundingClientRect();
 return {x:r.left+tx+p.x*scale,y:r.top+ty+p.y*scale,zoom:scale};}""",{'x':x,'y':y})
def getshape(page):return page.evaluate("()=>structuredClone(state.shapes.find(s=>s.id==='damage-1'))")
def cursor(page):
 return page.evaluate("""()=>{
 const h=document.querySelector('[data-shape-move-handle="true"]');
 if(!h)return null;
 const r=h.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,size:r.width};
 }""")
def cdp_touch(session,kind,points):
 session.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':[
  {'x':int(round(x)),'y':int(round(y)),'id':int(i),'radiusX':2,'radiusY':2,'force':1} for i,x,y in points]})
try:
 with sync_playwright() as p:
  opts={'headless':True}
  if os.path.exists('/usr/bin/chromium'):opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  browser=p.chromium.launch(**opts)
  for kind,width,height in [('desktop',1280,900),('ipad',820,1000)]:
   use_touch=kind=='ipad'
   ctx=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1,
    has_touch=use_touch,is_mobile=use_touch,service_workers='block')
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',
       body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("Unexpected PDF use in image fixture")}};')
     return
    # Test offline/local behavior, not Supabase.
    unexpected.append(url)
    rr.abort()
   ctx.route('**/*',route)
   page=ctx.new_page()
   errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.44' && !!window.SentlogShapeMove",timeout=18000)
   page.evaluate("""async d=>{
    await window.sentlogAppReady;
    workspace={projects:[d.project]};
    window.SentlogRecords.setItem('surveyFieldNoteWorkspaceV1',JSON.stringify(workspace));
    window.SentlogRecords.setItem('surveyFieldNoteDrawingV1:'+d.drawing,JSON.stringify(d.state));
    await window.SentlogRecords.writeFile('background:'+d.drawing,
      new File([Uint8Array.from(d.image)],'plan.png',{type:'image/png'}));
    await window.SentlogRecords.settled();
    await openDrawing(d.project.id,d.drawing);
   }""",{'project':project,'drawing':drawing,'state':state,'image':data})
   page.wait_for_function("currentView==='editor'&&state.sourceType==='image'&&!!window.SentlogShapeMove",timeout=18000)
   saved=getshape(page)
   pt=pagepoint(page,270,315)
   if use_touch:
    s=ctx.new_cdp_session(page)
    cdp_touch(s,'touchStart',[(1,pt['x'],pt['y'])])
   else:
    page.mouse.move(pt['x'],pt['y']);page.mouse.down()
   # Short press may select a damage, but must not move it or reveal a cursor.
   page.wait_for_timeout(150)
   assert cursor(page) is None,'cross must require a hold'
   page.wait_for_timeout(490)
   page.wait_for_function("window.SentlogShapeMove.active",timeout=2000)
   if use_touch:cdp_touch(s,'touchEnd',[])
   else:page.mouse.up()
   h=cursor(page)
   assert h is not None,'cross-handle missing after hold'
   assert 43<=h['size']<=54,h
   pt2={'x':h['x']+32,'y':h['y']+24}
   if use_touch:
    cdp_touch(s,'touchStart',[(2,h['x'],h['y'])])
    for n in range(1,6):
     cdp_touch(s,'touchMove',[(2,h['x']+32*n/5,h['y']+24*n/5)])
     page.wait_for_timeout(28)
    cdp_touch(s,'touchEnd',[])
   else:
    page.mouse.move(h['x'],h['y']);page.mouse.down()
    page.mouse.move(pt2['x'],pt2['y'],steps=7);page.mouse.up()
   page.wait_for_function("!window.SentlogShapeMove.dragging",timeout=3000)
   changed=getshape(page)
   approx(changed['points'][0]['x']-saved['points'][0]['x'],32/pt['zoom'],eps=4)
   approx(changed['points'][0]['y']-saved['points'][0]['y'],24/pt['zoom'],eps=4)
   approx(changed['labelPos']['x']-saved['labelPos']['x'],32/pt['zoom'],eps=4)
   approx(changed['labelPos']['y']-saved['labelPos']['y'],24/pt['zoom'],eps=4)
   assert changed['photos']==saved['photos'],'photo ids must remain attached'
   assert changed['id']==saved['id'] and changed['globalNo']==saved['globalNo']
   assert page.evaluate("historyFor().undo.length")==1,'group move should create one undo'
   page.evaluate("async()=>{await window.SentlogRecords.settled()}")
   # Atomic undo of shape and title, including metadata.
   page.locator('#undoBtn').click()
   undone=getshape(page)
   assert undone==saved,(undone,saved)
   assert cursor(page) is None
   # Direct label dragging still works without modifying damage geometry.
   page.evaluate("selectShape('damage-1')")
   lp=pagepoint(page,saved['labelPos']['x'],saved['labelPos']['y'])
   if use_touch:
    cdp_touch(s,'touchStart',[(3,lp['x'],lp['y'])])
    cdp_touch(s,'touchMove',[(3,lp['x']+27,lp['y']+13)])
    cdp_touch(s,'touchEnd',[])
   else:
    page.mouse.move(lp['x'],lp['y']);page.mouse.down()
    page.mouse.move(lp['x']+27,lp['y']+13,steps=4);page.mouse.up()
   labelonly=getshape(page)
   assert labelonly['points']==saved['points'],'label-only must not move damage geometry'
   assert labelonly['labelPos']!=saved['labelPos'],'label drag must still move title'
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/shape-move-{kind}.png'),full_page=True)
   # External requests can be aborted when logged out; never touch live account.
   assert not errors,errors
   print(f'PASS real built app {kind}: 500ms hold, touch/mouse cross drag, group move with photo retained, undo, label-only drag')
   ctx.close()
  browser.close()
finally:
 srv.shutdown();srv.server_close()
