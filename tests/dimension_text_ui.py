"""Mixed old/new dimensions must share readable typography without rewriting records."""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
import functools,threading,os,tempfile
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
engine=os.getenv('SENTLOG_TEST_BROWSER','chromium')
seed="""async()=>{
 await window.sentlogAppReady;
 workspace={projects:[{id:'font-p',name:'寸法文字検証',drawings:[{id:'font-d',name:'試験図',sourceType:'image',pageCount:1}]}]};
 activeProjectId='font-p';activeDrawingId='font-d';state=freshDrawingState('寸法文字検証');
 state.sourceType='image';state.width=1000;state.height=700;state.pageCount=1;state.currentPage=1;
 state.pageSettings['1']={paperSize:'custom',customW:1000,customH:700,scaleDenom:1,orientation:'auto'};
 state.shapes=[
  {id:'straight',kind:'line',type:'漏水',points:[{x:100,y:150},{x:300,y:150}],labelPos:{x:220,y:100},page:1,photos:[],lineLengthM:.2},
  {id:'curve',kind:'freehand-line',type:'ひび割れ',points:[{x:100,y:350},{x:160,y:430},{x:220,y:350}],labelPos:{x:220,y:280},page:1,photos:[],lineLengthM:.2,crackWidthMm:.2},
  {id:'rect',kind:'rect',type:'剥離',x:500,y:130,w:220,h:120,page:1,photos:[]},
  {id:'poly',kind:'polygon',type:'剥離',points:[{x:500,y:350},{x:760,y:350},{x:760,y:500}],page:1,photos:[]},
  ...[4,.25,null].map((unit,i)=>({id:'dim-'+i,kind:'dimension',recordKind:'dimension-line',memoType:'dimension',page:1,points:[{x:100+i*280,y:590},{x:280+i*280,y:590}],manualText:'0.180 m',...(unit==null?{}:{unit,fontSize:i?6:72})})),
  {id:'note',kind:'memo',recordKind:'drawing-memo',memoType:'text',page:1,points:[{x:60,y:650}],text:'NOTE',fontSize:28,unit:2}
 ];
 rebuildNumberingState();showEditor();setupStage(1000,700);empty.style.display='none';fit();render();
}"""
try:
 with tempfile.TemporaryDirectory(prefix='sentlog-font-ui-') as profile,sync_playwright() as pw:
  opts={'headless':True};executable=os.getenv('SENTLOG_CHROMIUM_EXECUTABLE','/usr/bin/chromium')
  if engine=='chromium' and os.path.exists(executable):opts.update(executable_path=executable,args=['--no-sandbox'])
  browser=None if engine=='webkit' else pw.chromium.launch(**opts)
  for width,height in [(390,844),(820,1000),(1280,900)]:
   args=dict(viewport={'width':width,'height':height},has_touch=width<1000,is_mobile=width<500,service_workers='block')
   ctx=browser.new_context(**args) if browser else pw.webkit.launch_persistent_context(str(Path(profile)/str(width)),headless=True,**args)
   unexpected=[]
   def route(rr):
    url=rr.request.url
    if url.startswith(origin+'/'):rr.continue_();return
    if url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
     rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("synthetic only")}};');return
    if 'supabase.co/' in url:rr.abort();return
    unexpected.append(url);rr.abort()
   ctx.route('**/*',route);page=ctx.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
   page.wait_for_function("window.SENTLOG_BUILD==='v1.83'&&!!window.SentlogDimensionText")
   page.evaluate(seed)
   before=page.evaluate('JSON.stringify(state.shapes)')
   for choice in ['small','normal','large']:
    for zoom in [.25,.5,1,2,8]:
     result=page.evaluate("""([choice,zoom])=>{
      state.labelSize=choice;scale=zoom;applyTransform();selectShape('curve');
      const nodes=[...svg.querySelectorAll('[data-line-length-id],[data-crack-width-id],.sentlog-shape-edge-dimension,[data-shape-summary-id],g[data-memo-id^="dim-"] text')];
      const sizes=nodes.map(t=>Number(t.getAttribute('font-size'))*scale);
      const line=svg.querySelector('[data-line-length-id="curve"]').getBBox(),width=svg.querySelector('[data-crack-width-id="curve"]').getBBox();
      const name=svg.querySelector('[data-damage-label-id="curve"][data-damage-label-role="name"]').getBBox();
      const hit=svg.querySelector('[data-line-length-hit="curve"]').getBBox();
      return {sizes,count:nodes.length,note:Number(svg.querySelector('g[data-memo-id="note"] text').getAttribute('font-size')),
        gap:(line.y-width.y-width.height)*scale,hitGap:(hit.y-name.y-name.height)*scale,
        halo:[...svg.querySelectorAll('g[data-memo-id^="dim-"] text')].map(t=>Number(t.getAttribute('stroke-width'))*scale)};
     }""",[choice,zoom])
     assert result['count']>=13,result
     assert max(result['sizes'])-min(result['sizes'])<.00001,(choice,zoom,result)
     assert 8.49<=min(result['sizes'])<=max(result['sizes'])<=14,(choice,zoom,result)
     assert result['note']==56,'explicit plain-text memo size must be preserved'
     assert result['gap']>=-1 and result['hitGap']>=0,result
     assert all(abs(h-3)<.00001 for h in result['halo']),result
     assert page.evaluate('JSON.stringify(state.shapes)')==before,'rendering must not rewrite measurements or geometry'
   # Draft and final dimensions have the same size; long-press targets stay large.
   result=page.evaluate("""()=>{
    state.labelSize='normal';scale=1;applyTransform();selected=null;tool='polygon';
    drawing={kind:'polygon',points:[{x:80,y:80},{x:400,y:80},{x:400,y:300}]};
    polygonDraftCursor={closing:false,valid:true,points:[{x:400,y:300},{x:600,y:300}]};renderPreview();
    const labels=[...svg.querySelectorAll('text')].filter(t=>/^\\d+(\\.\\d+)?m$/.test(t.textContent));
    const sizes=labels.map(t=>Number(t.getAttribute('font-size')));
    const targets=[...svg.querySelectorAll('[data-dimension-length-target]')].map(t=>Number(t.getAttribute('height')));
    return {sizes,targets,want:SentlogDimensionText.fontSize()};
   }""")
   assert len(result['sizes'])>=3 and all(abs(s-result['want'])<.00001 for s in result['sizes']),result
   assert result['targets'] and all(h>=38 for h in result['targets']),result
   result=page.evaluate("""()=>{
    tool='rect';drawing={kind:'rect',x:80,y:80,w:400,h:240};polygonDraftCursor=null;renderPreview();
    return [...svg.querySelectorAll('[data-shape-dimension-id="preview-rect"]')].map(t=>Number(t.getAttribute('font-size')));
   }""")
   assert len(result)==2 and all(abs(s-9.6)<.00001 for s in result),result
   page.evaluate("tool='pan';drawing=null;polygonDraftCursor=null;fit();render()")
   assert page.evaluate('JSON.stringify(state.shapes)')==before
   # The captured export receives the same dimension typography.
   exported=page.evaluate("""SentlogDrawingMemos.captureForExport(true,()=>[...svg.querySelectorAll('[data-line-length-id],.sentlog-shape-edge-dimension,g[data-memo-id^="dim-"] text')].map(t=>Number(t.getAttribute('font-size'))))""")
   assert len(exported)>=10 and max(exported)-min(exported)<.00001,exported
   (ROOT/'test-results').mkdir(exist_ok=True)
   page.screenshot(path=str(ROOT/f'test-results/dimension-text-{engine}-{width}.png'),full_page=True)
   assert not errors,errors;assert not unexpected,unexpected
   print(f'PASS {engine} {width}px: consistent mixed dimension sizes, creation zoom independence, presets, previews, hit targets, export and unchanged records',flush=True)
   ctx.close()
  if browser:browser.close()
finally:
 server.shutdown();server.server_close()
