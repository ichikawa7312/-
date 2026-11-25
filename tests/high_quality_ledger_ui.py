"""Synthetic photos only. Compare the actual old/new ledger exporters in a browser.
The test page exposes private preparation functions without modifying deployed code.
No production account, API, source photo or record is used."""
import argparse,functools,hashlib,io,json,os,random,subprocess,tempfile,threading,time,zipfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image,ImageDraw
from playwright.sync_api import sync_playwright
import openpyxl
P=argparse.ArgumentParser()
P.add_argument('--engine',choices=['chromium','webkit'],required=True)
P.add_argument('--base',required=True)
P.add_argument('--phase',choices=['large','recovery'],default='large')
P.add_argument('--width',type=int,default=1280)
args=P.parse_args()
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'ledger-diagnostics';OUT.mkdir(exist_ok=True)
TOKEN='20261125-ledger-hq-1'
MODS=['photo-ledger.js','photo-ledger-damage.js','photo-ledger-tensile.js','photo-ledger-visual3.js']
old={n:subprocess.check_output(['git','show',args.base+':sentlog/'+n]).decode() for n in MODS}
def expose(s):
 anchor='root.SentlogPhotoLedger={...pure,open,enhance};'
 assert s.count(anchor)==1
 return s.replace(anchor,'root.SentlogPhotoLedger={...pure,open,enhance,preparePhotos};')
old['photo-ledger.js']=expose(old['photo-ledger.js'])
new=expose((ROOT/'sentlog/photo-ledger.js').read_text())
fixtures={}
for i in range(6):
 w,h=1600,1200
 im=Image.frombytes('RGB',(w,h),random.Random(112+i).randbytes(w*h*3))
 draw=ImageDraw.Draw(im);draw.rectangle((70,80,420,240),fill='#e8e5d9')
 draw.text((90,110),'SYNTHETIC TEST '+str(i),fill='black');draw.line([(720,10),(740,310),(755,800),(770,1190)],fill='black',width=2)
 buffer=io.BytesIO();im.save(buffer,format='JPEG',quality=78);fixtures['p'+str(i)]=buffer.getvalue()
for name,size,fmt,orientation in [('portrait',(1200,1600),'JPEG',None),('rotated',(1600,1200),'JPEG',6),('png',(1200,900),'PNG',None),('tiny',(96,72),'JPEG',None)]:
 im=Image.new('RGB',size,'white');d=ImageDraw.Draw(im);d.rectangle((0,0,size[0]//2,size[1]//2),fill='red');d.rectangle((size[0]//2,size[1]//2,size[0],size[1]),fill='blue');b=io.BytesIO()
 exif=Image.Exif()
 if orientation:exif[274]=orientation
 im.save(b,format=fmt,**({'exif':exif,'quality':90} if fmt=='JPEG' else {}));fixtures[name]=b.getvalue()
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  path=self.path.split('?')[0]
  if path.startswith('/fixture/'):
   key=path.split('/')[-1];data=fixtures[key];self.send_response(200);self.send_header('Content-Type','image/png' if key=='png' else 'image/jpeg');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  if path in ('/sentlog/test-old.html','/sentlog/test-new.html'):
   is_new='new' in path
   scripts=('<script src="photo-ledger-stream.js"></script>' if is_new else '')+''.join('<script src="'+('test-new-ledger.js' if is_new and n=='photo-ledger.js' else 'test-old-'+n if not is_new else n)+'"></script>' for n in MODS)
   html='<!doctype html><meta charset="utf-8"><body><script>window.SentlogRecords={ready:true};window.sentlogAppReady=Promise.resolve();</script>'+scripts+'<script>'+JS+'</script></body>'
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode());return
  if path.startswith('/sentlog/test-old-') or path=='/sentlog/test-new-ledger.js':
   src=new if path=='/sentlog/test-new-ledger.js' else old[path.split('test-old-',1)[1]]
   self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(src.encode());return
  super().do_GET()
JS=r"""
let sources=new Map(),reads=0,activeReads=0,peakReads=0,mode='normal',gate=null;
async function fixture(){
 for(const key of ['p0','p1','p2','p3','p4','p5','portrait','rotated','png','tiny']){
  const b=await fetch('/fixture/'+key).then(r=>r.blob());sources.set(key,b);
 }
}
function keyFor(id){return /^p\d+$/.test(id)?'p'+(+id.slice(1)%6):id;}
window.getDBFile=async key=>{
 const id=key.split(':').at(-1);reads++;activeReads++;peakReads=Math.max(peakReads,activeReads);
 try{if(mode==='delay')await new Promise(r=>setTimeout(r,60));if(mode==='missing'&&id==='p3')return null;if(mode==='corrupt'&&id==='p3')return new Blob(['broken'],{type:'image/jpeg'});return sources.get(keyFor(id))||null;}finally{activeReads--;}
};
function entries(count,types=null){return Array.from({length:count},(_,i)=>({key:'photo-'+i,drawingId:'d1',photoId:types?types[i]:'p'+i,shapeId:'s'+Math.floor(i/2),damage:'調査-'+(Math.floor(i/2)+1),type:'調査',typeNo:Math.floor(i/2)+1,member:'主桁',sheetName:'試験図面',page:1,description:'検証',included:true,groupName:'試験',visual3:{managementNo:'01',facility:'試験',structure:'RC',purpose:'調査',notes:'検証'}}));}
window.runLedger=async ({count,format='visual3',types=null,how='normal'})=>{
 mode=how;reads=peakReads=activeReads=0;const e=entries(count,types),start=performance.now();
 try{
  const prep=await SentlogPhotoLedger.preparePhotos(e);
  if(prep.missing.length)throw Error('missing '+prep.missing.length);
  let file;
  if(format==='standard')file=await SentlogPhotoLedger.buildXlsx('合成案件','試験',[{name:'調査',photos:e}]);
  else if(format==='damage')file=await SentlogDamageLedger.buildXlsx('合成案件','試験',[{name:'調査',photos:e}]);
  else if(format==='tensile')file=await SentlogTensileLedger.buildXlsx('合成案件','試験',e,{});
  else file=await SentlogVisual3Ledger.buildXlsx('合成案件','試験',[{name:'調査',photos:e}]);
  const ms=performance.now()-start;window.result=file;
  return {ok:true,ms,bytes:file.size,reads,peakReads};
 }catch(e){return {ok:false,error:String(e.message||e),code:e.code,ms:performance.now()-start,reads,peakReads};}
};
window.saveResult=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(window.result);a.download='test.xlsx';document.body.append(a);a.click();};
window.directZip=async (opts={})=>{
 const C=new AbortController(),S=SentlogLedgerStream;
 const files=[['[Content_Types].xml','<Types/>'],['xl/workbook.xml','<workbook/>'],...Array.from({length:30},(_,i)=>['xl/media/photo'+i+'.jpeg',S.photo(async()=>{await new Promise(r=>setTimeout(r,25));return sources.get('p'+(i%6));},'photo'+i,n=>{if(opts.cancel&&n===3)C.abort();})])];
 try{await S.zip(files,{signal:C.signal,confirmPrevious:()=>!!opts.ack});return {ok:true};}catch(e){return {ok:false,code:e.code,error:e.message};}
};
"""
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
report={'engine':args.engine,'phase':args.phase,'width':args.width,'fixture_bytes':[len(fixtures['p'+str(i)]) for i in range(6)],'results':[]}
def save(page,path):
 with page.expect_download(timeout=120000) as dl:page.evaluate('saveResult()')
 dl.value.save_as(path)
def inspect(path,count,exact=False,types=None):
 with zipfile.ZipFile(path) as z:
  assert z.testzip() is None,'ZIP CRC failure'
  media=[n for n in z.namelist() if n.startswith('xl/media/') and n.endswith('.jpeg')]
  assert len(media)==count,(len(media),count)
  hashes=set(hashlib.sha256(fixtures['p'+str(i)]).hexdigest() for i in range(6))
  if exact:
   for name in media:
    data=z.read(name);assert hashlib.sha256(data).hexdigest() in hashes,name
    with Image.open(io.BytesIO(data)) as im:assert im.size==(1600,1200)
  if types:
   images=[Image.open(io.BytesIO(z.read(n))).size for n in media]
   assert images==types,images
  xml={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if not n.startswith('xl/media/')}
 wb=openpyxl.load_workbook(path,read_only=False)
 assert len(wb.worksheets)>=1
 assert sum(len(w._images) for w in wb.worksheets)==count
 wb.close()
 return xml
try:
 with sync_playwright() as p,tempfile.TemporaryDirectory() as tmp:
  engine=getattr(p,args.engine);launch={'headless':True}
  if args.engine=='chromium':launch['args']=['--no-sandbox','--disable-dev-shm-usage']
  context=engine.launch_persistent_context(str(Path(tmp)/'profile'),**launch,viewport={'width':args.width,'height':900},accept_downloads=True,service_workers='block')
  def route(rr):
   if rr.request.url.startswith(origin+'/') or rr.request.url.startswith('blob:'):rr.continue_()
   else:rr.abort()
  context.route('**/*',route)
  page=context.new_page();page.set_default_timeout(180000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda d:d.accept() if d.message.startswith('前回のExcelは保存済みですか？') else d.dismiss())
  def visit(kind):
   page.goto(origin+'/sentlog/test-'+kind+'.html');page.evaluate('fixture()')
  if args.phase=='large':
   baseline={}
   visit('old')
   for n in [100,200,400,600]:
    result=page.evaluate('runLedger',{'count':n})
    print('BASELINE',n,result,flush=True);report['results'].append({'version':'old','count':n,**result})
    if result['ok']:
     dest=Path(tmp)/f'old-{n}.xlsx';save(page,dest);baseline[n]=inspect(dest,n);dest.unlink()
   visit('new')
   for n in [100,200,400,600]:
    result=page.evaluate('runLedger',{'count':n})
    print('CANDIDATE',n,result,flush=True);report['results'].append({'version':'new','count':n,**result})
    assert result['ok'],result;assert result['reads']==n and result['peakReads']==1,result
    dest=Path(tmp)/f'new-{n}.xlsx';save(page,dest);xml=inspect(dest,n,exact=True)
    if n in baseline:assert xml==baseline[n],'workbook styles/layout/XML changed'
    dest.unlink()
   assert report['results'][-1]['bytes']>320*1024*1024,'did not test above old internal cap'
  else:
   visit('new')
   for fmt in ['standard','damage','tensile','visual3']:
    result=page.evaluate('runLedger',{'count':6,'format':fmt});assert result['ok'],(fmt,result)
    dest=Path(tmp)/(fmt+'.xlsx');save(page,dest);inspect(dest,6,exact=True);dest.unlink();print('PASS',fmt,'exact JPEGs and valid XLSX',flush=True)
   result=page.evaluate('runLedger',{'count':4,'format':'standard','types':['portrait','rotated','png','tiny']})
   assert result['ok'],result;dest=Path(tmp)/'orientation.xlsx';save(page,dest);inspect(dest,4,types=[(2136,1602),(2136,1602),(1200,900),(96,72)])
   with zipfile.ZipFile(dest) as z:
    media=[n for n in z.namelist() if n.startswith('xl/media/') and n.endswith('.jpeg')]
    portrait=Image.open(io.BytesIO(z.read(media[0])));rotated=Image.open(io.BytesIO(z.read(media[1])))
    assert all(x>235 for x in portrait.getpixel((10,10))), 'portrait padding'
    assert all(x>235 for x in rotated.getpixel((10,10))), 'rotated padding'
    # EXIF orientation 6: red upper-left in the source rotates to upper-right.
    x,y=rotated.size;rgb=rotated.getpixel((x//2+300,y//4));assert rgb[0]>200 and rgb[1]<60,rgb
   print('PASS portrait, EXIF orientation, PNG conversion and no small-image enlargement',flush=True)
   for how in ['missing','corrupt']:
    result=page.evaluate('runLedger',{'count':6,'how':how});assert not result['ok'] and '写真を1枚取得・変換できません' in result['error'],result
   result=page.evaluate('directZip',{'ack':True,'cancel':True});assert not result['ok'] and result['code']=='LEDGER_CANCEL',result
   result=page.evaluate('runLedger',{'count':6});assert result['ok'],result
   result=page.evaluate('directZip',{'ack':False});assert not result['ok'] and result['code']=='LEDGER_PREVIOUS',result
   # Existing ready export is not removed on refusal; the prior file still downloads.
   dest=Path(tmp)/'retained.xlsx';save(page,dest);inspect(dest,6,exact=True)
   # Stop with work in progress, then a new page can recover after a worker abort.
   page.reload();page.evaluate('fixture()')
   result=page.evaluate('runLedger',{'count':6});assert result['ok'],result
   dest=Path(tmp)/'recovered.xlsx';save(page,dest);inspect(dest,6,exact=True)
   print('PASS missing/corrupt source fail closed, cancellation, retry, previous-save refusal, restart',flush=True)
  assert not errors,errors
  context.close()
finally:
 (OUT/('ledger-'+args.engine+'-'+args.phase+'-'+str(args.width)+'.json')).write_text(json.dumps(report,indent=2))
 server.shutdown()
