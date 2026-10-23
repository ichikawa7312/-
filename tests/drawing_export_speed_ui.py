"""Compare the fully built v1.90 baseline against v1.91; only synthetic data.
Checks actual PDFs in Chromium/WebKit, untouched records, crop/rotation, thin
lines/Japanese annotations, empty layers, zero PDF background paints, and timings.
"""
import base64, functools, io, json, os, statistics, threading, time
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import fitz
from PIL import Image, ImageChops, ImageStat
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE=Path(os.environ['SENTLOG_EXPORT_BASELINE_DIR'])
OUT=ROOT/'test-results/export-speed';OUT.mkdir(parents=True,exist_ok=True)
# Eight pages: dense engineering linework, fine source text, large paper,
# crop boxes, intrinsic plus user rotations, sparse/full/empty annotations.
sizes=[(842,595),(1191,842),(1684,1191),(842,595),(595,842),(842,595),(1191,842),(842,595)]
buf=io.BytesIO();c=canvas.Canvas(buf)
for i,(w,h) in enumerate(sizes):
 c.setPageSize((w,h));c.setStrokeColorRGB(.1,.1,.1);c.setLineWidth(.15)
 path=c.beginPath()
 for j in range(6500):
  x=25+(j*17 % int(w-65));y=25+(j*29 % int(h-70))
  path.moveTo(x,y);path.lineTo(x+7+(j%13),y+3+(j%5))
 c.drawPath(path)
 c.setFillColorRGB(0,0,0);c.setFont('Helvetica',5)
 c.drawString(35,h-28,'SOURCE-PAGE-'+str(i+1)+' MICROTEXT 0.05 mm 1:100 1.250 m')
 c.setLineWidth(.08);c.line(30,h-35,w-30,h-35);c.showPage()
c.save();writer=PdfWriter();reader=PdfReader(io.BytesIO(buf.getvalue()))
for p in reader.pages:writer.add_page(p)
writer.pages[1].cropbox.lower_left=(20,10);writer.pages[1].cropbox.upper_right=(1171,822);writer.pages[1].rotate(90)
writer.pages[3].rotate(270)
fixture=io.BytesIO();writer.write(fixture);fixture_b64=base64.b64encode(fixture.getvalue()).decode()

FIXTURE_JS='''async data=>{
 const pdf=new File([Uint8Array.from(atob(data),x=>x.charCodeAt(0))],'source.pdf',{type:'application/pdf'});
 workspace={projects:[{id:'speed-project',name:'合成図面・画質比較',drawings:[],createdAt:1,updatedAt:1}]};
 for(let i=0;i<2;i++){
  const id='speed-'+i,meta={id,name:'比較図面'+i,fileName:'source.pdf',sourceType:'pdf',pageCount:8,updatedAt:1};workspace.projects[0].drawings.push(meta);
  const s=freshDrawingState('合成図面');Object.assign(s,{sourceType:'pdf',fileName:'source.pdf',pageCount:8,currentPage:1,width:1800,height:1272,pageRotations:{'2':90,'4':90}});
  s.shapes=[
   {id:'damage-1',page:1,kind:'rect',type:'腐食',x:400,y:280,w:350,h:180,typeNo:1,strokeWidth:2,photos:[{id:'photo-a'}]},
   {id:'memo-1',page:1,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:400,y:530}],text:'魚道工 ひび割れ W=0.05mm',fontSize:24,unit:1,color:'#1d4ed8',white:true},
   {id:'dimension-1',page:1,kind:'dimension',recordKind:'dimension-line',points:[{x:400,y:680},{x:800,y:680}],manualText:'1.250m',fontSize:14,unit:1,color:'#111827'},
   {id:'photo-2',page:2,kind:'field-record',recordKind:'field-record',recordType:'photo',type:'全景',point:{x:500,y:350},angle:Math.PI/3,typeNo:1,photos:[]},
   {id:'memo-2',page:2,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:350,y:450}],text:'回転ページ 確認',fontSize:24,unit:1,color:'#1d4ed8',white:true},
   {id:'thin-3',page:3,kind:'line',type:'ひび割れ',points:[{x:300,y:300},{x:640,y:420}],typeNo:1,strokeWidth:.5,photos:[]},
   {id:'memo-4',page:4,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:10,y:40}],text:'端部の文字を切らない',fontSize:28,unit:1,color:'#1d4ed8'},
   {id:'wide-5',page:5,kind:'rect',type:'欠損',x:3,y:4,w:1300,h:1800,typeNo:1,strokeWidth:2,photos:[]},
   {id:'memo-only-6',page:6,kind:'memo',recordKind:'drawing-memo',memoType:'text',points:[{x:200,y:200}],text:'メモを含む場合のみ',fontSize:22,unit:1,color:'#1d4ed8'}
  ];
  SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(s));await SentlogRecords.writeFile('background:'+id,pdf);
 }
 saveWorkspace();await SentlogRecords.settled();showDrawings('speed-project');
}'''
INSTRUMENT='''
;(()=>{'use strict';const original=pdfjsLib.getDocument.bind(pdfjsLib);
 // PDF.js exposes getDocument as a getter. Replace the wrapper object rather
 // than silently assigning to a read-only export (as the app's quality shim does).
 window.pdfjsLib={...pdfjsLib,getDocument:(...args)=>{const task=original(...args);
  window.parent.__pdfDocuments=(window.parent.__pdfDocuments||0)+1;
  task.promise.then(doc=>{
   const get=doc.getPage.bind(doc);doc.getPage=async n=>{const page=await get(n);if(!page.__exportCounted){page.__exportCounted=true;
    const render=page.render.bind(page);page.render=(...a)=>{window.parent.__pdfPaints=(window.parent.__pdfPaints||0)+1;return render(...a);};}return page;};
  },()=>{});return task;}};
})();
'''
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass

def start_server(root):
 s=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(root)))
 threading.Thread(target=s.serve_forever,daemon=True).start();return s

servers=[start_server(BASE),start_server(ROOT)];all_results=[]
def compare_pdfs(before,after,label):
 old=fitz.open(before);new=fitz.open(after);assert len(old)==len(new)==8
 stats=[]
 for i,(a,b) in enumerate(zip(old,new)):
  assert list(a.rect)==list(b.rect),(label,i,a.rect,b.rect)
  assert a.get_text()==b.get_text(),(label,i,'original vector text changed')
  assert 'SOURCE-PAGE-'+str(i+1) in b.get_text()
  scale=min(2.5,2600/max(a.rect.width,a.rect.height))
  pa=a.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
  pb=b.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
  ia=Image.frombytes('RGB',(pa.width,pa.height),pa.samples);ib=Image.frombytes('RGB',(pb.width,pb.height),pb.samples)
  diff=ImageChops.difference(ia,ib);hist=diff.histogram();pixels=ia.width*ia.height
  mae=sum(ImageStat.Stat(diff).mean)/3
  changed=sum(sum(hist[ch*256+8:(ch+1)*256]) for ch in range(3))/(pixels*3)
  # Subpixel PDF matrix rounding can change edge antialiasing, not the content.
  assert mae<.08 and changed<.0015,(label,i,mae,changed)
  stats.append(dict(page=i+1,mean_channel_error=round(mae,6),fraction_over_7=round(changed,8),source_text_preserved=True))
  if i==0:
   ia.resize((1000,round(1000*ia.height/ia.width))).save(OUT/(label+'-before.png'))
   ib.resize((1000,round(1000*ib.height/ib.width))).save(OUT/(label+'-after.png'))
   # Fine Japanese lettering, dimensions and crack-width label at 400 dpi.
   clip=fitz.Rect(160,100,440,350)
   za=a.get_pixmap(matrix=fitz.Matrix(400/72,400/72),clip=clip,alpha=False)
   zb=b.get_pixmap(matrix=fitz.Matrix(400/72,400/72),clip=clip,alpha=False)
   xa=Image.frombytes('RGB',(za.width,za.height),za.samples);xb=Image.frombytes('RGB',(zb.width,zb.height),zb.samples)
   close_error=sum(ImageStat.Stat(ImageChops.difference(xa,xb)).mean)/3
   assert close_error<.2,(label,'400 dpi fine detail',close_error)
   xb.save(OUT/(label+'-detail.png'))
 # Empty pages keep original vectors, but no redundant transparent bitmap.
 old_r=PdfReader(str(before));new_r=PdfReader(str(after))
 assert len(new_r.pages[6].images)==0 and len(new_r.pages[7].images)==0
 assert len(old_r.pages[6].images)>=1
 old.close();new.close();return stats

try:
 with sync_playwright() as p:
  for engine in os.getenv('SENTLOG_TEST_BROWSERS','chromium,webkit').split(','):
   options=dict(headless=True)
   if engine=='chromium':options['args']=['--no-sandbox','--disable-dev-shm-usage']
   browser=getattr(p,engine).launch(**options)
   measurements={}
   for which,root,server in [('before',BASE,servers[0]),('after',ROOT,servers[1])]:
    origin=f'http://127.0.0.1:{server.server_port}'
    context=browser.new_context(viewport={'width':1100,'height':850});page=context.new_page();errors=[];external=[]
    def route(rr):
     url=rr.request.url
     if url.startswith(origin) and '/vendor/export-pdf.min.js' in url:
      rr.fulfill(content_type='text/javascript',body=(root/'sentlog/vendor/export-pdf.min.js').read_text()+INSTRUMENT)
     elif url.startswith(origin) or url.startswith('blob:'):rr.continue_()
     elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
      rr.fulfill(content_type='text/javascript',body=(root/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])).read_bytes())
     else:external.append(url);rr.abort()
    context.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(origin+'/sentlog/');page.wait_for_function('window.SentlogDrawingExport',timeout=30000);page.evaluate('sentlogAppReady')
    page.evaluate(FIXTURE_JS,fixture_b64)
    unchanged="JSON.stringify([workspace,...workspace.projects[0].drawings.map(d=>SentlogRecords.getItem(drawingStorageKey(d.id)))])"
    records=page.evaluate(unchanged);times=[]
    for run in range(2):
     include_memos=run==0
     result=page.evaluate('''async memos=>{
      window.__pdfPaints=0;window.__pdfDocuments=0;const item=SentlogDrawingExport.inputSnapshot('speed-project',['speed-0'],memos)[0];
      const start=performance.now(),result=await SentlogDrawingExport.createPdf(item,()=>{});
      const ms=performance.now()-start;
      const encoded=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]);r.onerror=rej;r.readAsDataURL(result.blob);});
      return {ms,pages:result.pages,bytes:result.blob.size,pdf:encoded,paints:window.__pdfPaints,documents:window.__pdfDocuments};
     }''',include_memos)
     path=OUT/f'{engine}-{which}-{run}.pdf';path.write_bytes(base64.b64decode(result.pop('pdf')))
     times.append(result);print('MEASUREMENT',engine,which,run,json.dumps(result),flush=True)
     assert result['pages']==8 and page.evaluate(unchanged)==records
     assert page.evaluate("document.querySelectorAll('iframe').length")==0
     assert result['documents']>=1,'PDF.js instrumentation must be active in both versions'
     if which=='after':assert result['paints']==0,result
     else:assert result['paints']>=8,result
    assert not errors,errors;assert not external,external
    measurements[which]=times;context.close()
   checks=[]
   for run in range(2):checks.append(compare_pdfs(OUT/f'{engine}-before-{run}.pdf',OUT/f'{engine}-after-{run}.pdf',f'{engine}-{run}'))
   old_ms=statistics.mean(x['ms'] for x in measurements['before']);new_ms=statistics.mean(x['ms'] for x in measurements['after'])
   record=dict(engine=engine,pages_per_run=8,runs=measurements,before_ms=round(old_ms),after_ms=round(new_ms),speedup=round(old_ms/new_ms,3),visual_checks=checks)
   all_results.append(record)
   # Avoid claiming a speed win based on code alone; require it on this fixture.
   assert new_ms<old_ms,(engine,'no measured improvement',old_ms,new_ms)
   print('COMPARISON',json.dumps({k:v for k,v in record.items() if k!='visual_checks'}),flush=True)
   browser.close()
 (OUT/'summary.json').write_text(json.dumps(all_results,ensure_ascii=False,indent=2))
 print('PASS: original vectors and fine detail preserved; blank pages skipped; zero PDF canvas paints; measured speed improvement',flush=True)
finally:
 for server in servers:server.shutdown()
