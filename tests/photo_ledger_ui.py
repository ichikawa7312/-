"""End-to-end photo-ledger test against the assembled Sentlog app.
Synthetic records/images only; no account, real project, or external API writes.
"""
import functools
import os
import threading
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results' / 'photo-ledger'
OUT.mkdir(parents=True, exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'

fixture = r"""async()=>{
 await window.sentlogAppReady;
 const project={id:'ledger-project',name:'合成試験 案件',drawings:[
  {id:'ledger-sheet-1',name:'上流面',sheetName:'上流面',groupId:'ledger-group',groupName:'調査①',sheetOrder:1,sourceType:'pdf',pageCount:1,photoCount:3,shapeCount:2,createdAt:1,updatedAt:1},
  {id:'ledger-sheet-2',name:'下流面',sheetName:'下流面',groupId:'ledger-group',groupName:'調査①',sheetOrder:2,sourceType:'pdf',pageCount:1,photoCount:6,shapeCount:2,createdAt:2,updatedAt:2}
 ],createdAt:1,updatedAt:2};
 const states={
  'ledger-sheet-1':[
   {id:'shape-51',kind:'rect',page:1,type:'ひび割れ',typeNo:51,member:'主桁 G1',memo:'既存の所見',photos:[{id:'p1',name:'A.jpg'},{id:'p2',name:'B.jpg'}]},
   {id:'overview',recordKind:'field-record',recordType:'photo',type:'全景',typeNo:1,page:1,photos:[{id:'p3',name:'C.jpg'}]}
  ],
  'ledger-sheet-2':[
   {id:'shape-2',kind:'rect',page:1,type:'ひび割れ',typeNo:2,member:'床版',photos:[{id:'p4'},{id:'p5'},{id:'p6'},{id:'p7'},{id:'p8'}]},
   {id:'leak',kind:'rect',type:'漏水',typeNo:1,page:1,photos:[{id:'p9'}]}
  ]
 };
 workspace={projects:[project]};
 for(const [id,shapes] of Object.entries(states)){
  const st=freshDrawingState(project.name);
  st.shapes=shapes;st.sourceType='pdf';st.fileName=id+'.pdf';
  SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(st));
 }
 saveWorkspace();
 const canvas=document.createElement('canvas');canvas.width=96;canvas.height=72;
 const g=canvas.getContext('2d');g.fillStyle='#edf4fa';g.fillRect(0,0,96,72);g.fillStyle='#2069a0';g.fillRect(12,15,58,36);
 const jpeg=await new Promise((ok,fail)=>canvas.toBlob(x=>x?ok(x):fail(Error('JPEG fixture failed')),'image/jpeg',.86));
 const bytes=await jpeg.arrayBuffer();
 window.__ledgerJpeg=new Blob([bytes],{type:'image/jpeg'});
 if(window.__ledgerSyntheticBlobBackend){
   // The Playwright WebKit Linux runner may reject ALL IndexedDB Blob writes.
   // Use an explicitly test-only photo map to verify UI/XLSX behavior, never
   // misrepresent this as a real iPhone/iPad IndexedDB persistence test.
   const sourceGetDBFile=getDBFile;
   window.__ledgerSyntheticBlobs=new Map();
   getDBFile=async key=>key.startsWith('photo:ledger-')?(window.__ledgerSyntheticBlobs.get(key)||null):sourceGetDBFile(key);
 }
 for(let n=1;n<=8;n++){
  const id=n<=3?'ledger-sheet-1':'ledger-sheet-2',key='photo:'+id+':p'+n;
  const image=new Blob([bytes.slice(0)],{type:'image/jpeg'});
  if(window.__ledgerSyntheticBlobBackend)window.__ledgerSyntheticBlobs.set(key,image);
  else await SentlogRecords.writeFile(key,image);
 }
 await SentlogRecords.settled();
 showDrawings('ledger-project');
}"""

def source_snapshot(page):
    return page.evaluate("""()=>{
      const ids=['ledger-sheet-1','ledger-sheet-2'];
      return JSON.stringify(ids.map(id=>SentlogRecords.getItem(drawingStorageKey(id))));
    }""")

try:
    with sync_playwright() as p:
        engine=os.getenv('SENTLOG_TEST_BROWSER','chromium')
        width=int(os.getenv('SENTLOG_TEST_WIDTH','390'))
        if engine not in ('chromium','webkit') or width not in (390,820,1280):
            raise ValueError('Unexpected test browser/viewport')
        launch={'headless':True}
        if engine=='chromium':
            launch['args']=['--no-sandbox','--disable-dev-shm-usage']
            if os.path.exists('/usr/bin/chromium'):
                launch['executable_path']='/usr/bin/chromium'
        viewport={'width':width,'height':1000 if width==820 else 844 if width==390 else 900}
        profile=tempfile.TemporaryDirectory() if engine=='webkit' else None
        if profile:
            browser=None
            context=p.webkit.launch_persistent_context(profile.name,headless=True,viewport=viewport,service_workers='block',accept_downloads=True)
        else:
            browser=p.chromium.launch(**launch)
            context=browser.new_context(viewport=viewport,service_workers='block',accept_downloads=True)
        external=[]
        def route(rr):
            url=rr.request.url
            if url.startswith(origin+'/') or url.startswith('blob:'):
                rr.continue_()
            elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                rr.fulfill(status=200,content_type='text/javascript',body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw Error("photo ledger fixture")}};')
            elif 'supabase.co/' in url:
                rr.abort()
            else:
                external.append(url)
                rr.abort()
        context.route('**/*',route)
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+'/sentlog/',wait_until='domcontentloaded')
        page.wait_for_function("window.SentlogPhotoLedger&&window.SentlogDrawingGroups&&window.SentlogRecords?.ready",timeout=30000)
        if engine=='webkit':
            page.evaluate("window.__ledgerSyntheticBlobBackend=true")
            print('WEBKIT BROWSER TEST: in-memory JPEG fixtures; native WebKit IndexedDB Blob storage requires real-device verification',flush=True)
        page.evaluate(fixture)
        baseline=source_snapshot(page)
        assert page.locator('#drawingsGrid .manager-card[data-drawing-group-id="ledger-group"]').count()==1
        button=page.locator('[data-drawing-group-id="ledger-group"] [data-ledger-button]')
        expect(button).to_have_count(1)
        button.click()
        expect(page.locator('.ledger-summary')).to_contain_text('9枚 / 5ページ / 3シート')
        assert page.locator('.ledger-section-head strong').all_text_contents()[0].startswith('全景・その他')
        assert page.locator('.ledger-item').count()==9
        assert page.locator('.ledger-item',has_text='ひび割れ-51').count()==2

        changed=page.locator('.ledger-item',has_text='ひび割れ-51').first.locator('textarea')
        changed.fill('写真台帳だけの説明')
        page.locator('.ledger-save').click()
        expect(page.locator('.ledger-status')).to_contain_text('下書きを保存しました')
        page.locator('.ledger-close').click()
        button.click()
        assert page.locator('.ledger-item',has_text='ひび割れ-51').first.locator('textarea').input_value()=='写真台帳だけの説明'

        # One photo exists in the saved record but its Blob is missing. Fail closed.
        downloads=[]
        page.on('download',lambda d: downloads.append(d.suggested_filename))
        page.locator('.ledger-export').click()
        expect(page.locator('.ledger-status')).to_contain_text('写真を1枚取得・変換できません',timeout=30000)
        assert downloads==[],downloads
        assert source_snapshot(page)==baseline,'Failed export changed source records'

        # Restore only the synthetic JPEG and export without any network.
        page.evaluate("""async()=>{
          if(window.__ledgerSyntheticBlobBackend){
            window.__ledgerSyntheticBlobs.set('photo:ledger-sheet-2:p9',window.__ledgerJpeg);
          }else{
            await SentlogRecords.writeFile('photo:ledger-sheet-2:p9',window.__ledgerJpeg);
            await SentlogRecords.settled();
          }
        }""")
        # Chromium verifies the real browser offline flag. Headless Linux
        # WebKit rejects locally generated Blob/data URLs when Playwright's
        # offline flag is enabled; this runner can only verify network-denied
        # WebKit UI and Excel download. Real iOS offline remains a release gate.
        if engine=='chromium':
            context.set_offline(True)
        else:
            assert not external,'WebKit runner unexpectedly requested external assets'
            print('WEBKIT NETWORK-DENIED UI CHECK (not real offline mode)',flush=True)
        if engine=='webkit':
            # The finished link is a real user gesture, supported when WebKit
            # blocks the original asynchronous automatic download.
            page.locator('.ledger-export').click()
            try:
                page.wait_for_function("""()=>{
                  const s=document.querySelector('.ledger-status')?.textContent||'';
                  return s.includes('Excelを出力しました')||s.includes('出力できませんでした');
                }""",timeout=35000)
            except PlaywrightTimeout:
                print('WEBKIT STATUS WHEN STALLED:',page.locator('.ledger-status').inner_text(),flush=True)
                raise
            result=page.locator('.ledger-status').inner_text()
            assert 'Excelを出力しました' in result,('WebKit Excel generation failed',result)
            with page.expect_download(timeout=20000) as event:
                page.locator('.ledger-download-ready').click()
        else:
            with page.expect_download(timeout=45000) as event:
                page.locator('.ledger-export').click()
        dest=OUT/f'photo-ledger-{engine}-{width}.xlsx'
        event.value.save_as(dest)
        expect(page.locator('.ledger-status')).to_contain_text('Excelを出力しました')
        expect(page.locator('.ledger-download-ready')).to_have_count(1)
        assert source_snapshot(page)==baseline,'Successful export changed source records'
        with zipfile.ZipFile(dest,'r') as z:
            assert z.testzip() is None,'Corrupt ZIP/XLSX payload'
            names=z.namelist()
            assert len([n for n in names if n.startswith('xl/media/image')])==9
            book=ET.fromstring(z.read('xl/workbook.xml'))
            ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            worksheets=book.findall('s:sheets/s:sheet',ns)
            assert [s.attrib['name'] for s in worksheets]==['全景・その他','ひび割れ','漏水'],worksheets
            xml=ET.fromstring(z.read('xl/worksheets/sheet2.xml'))
            setup=xml.find('s:pageSetup',ns)
            assert setup is not None and setup.attrib['paperSize']=='9' and setup.attrib['orientation']=='portrait'
            breaks=xml.find('s:rowBreaks',ns)
            assert breaks is not None and [int(x.attrib['id']) for x in breaks.findall('s:brk',ns)]==[30,60]
            assert 'ひび割れ-51' in z.read('xl/worksheets/sheet2.xml').decode()
            assert '写真台帳だけの説明' in z.read('xl/worksheets/sheet2.xml').decode()
        assert not errors,errors
        assert not external,external
        print(f'PASS photo-ledger {engine} {width}px: two-PDF grouping, exact -51 labels, draft, missing-photo block, '+('real offline' if engine=='chromium' else 'network-denied WebKit')+' XLSX, 3-up page breaks, unchanged records',flush=True)
        context.close()
        if browser:
            browser.close()
        if profile:
            profile.cleanup()
finally:
    server.shutdown()
    server.server_close()
