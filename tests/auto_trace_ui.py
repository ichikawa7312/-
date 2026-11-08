"""Real generated Sentlog page: photo auto-trace becomes ordinary field damage records."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as pw:
        args={'headless':True}
        if os.path.exists('/usr/bin/chromium'):
            args.update(executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        browser=pw.chromium.launch(**args)
        page=browser.new_page(viewport={'width':390,'height':844},service_workers='block',accept_downloads=True)
        errors=[]
        logs=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:logs.append(m.type+': '+m.text))
        def route(request):
            url=request.request.url
            if url.startswith(origin) or url.startswith('blob:'):
                request.continue_()
            elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
                lib=ROOT/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])
                if lib.is_file():request.fulfill(content_type='text/javascript',body=lib.read_bytes())
                else:request.abort()
            else:request.abort()
        page.route('**/*',route)
        page.goto(origin+'/sentlog/')
        try:
            page.wait_for_function("!!window.SentlogAutoTrace && !!window.sentlogAppReady",timeout=18000)
        except Exception:
            print('AUTO_TRACE_BOOT_DIAGNOSTIC',page.evaluate("""()=>({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,1400),ready:!!window.sentlogAppReady,autoTrace:!!window.SentlogAutoTrace,core:!!window.SentlogAutoTraceCore,loader:document.querySelectorAll('script[src*=auto-trace]').length,style:!!document.getElementById('slAutoTraceStyle'),button:!!document.getElementById('slAutoTraceButton'),photoInput:!!document.getElementById('slAutoTraceCamera'),hasToolbar:!!document.querySelector('#editorView .toolbar'),scripts:[...document.querySelectorAll('script[src]')].slice(-14).map(x=>x.src)})"""),flush=True)
            print('AUTO_TRACE_BOOT_ERRORS',errors,flush=True)
            print('AUTO_TRACE_BOOT_CONSOLE',logs[-30:],flush=True)
            raise
        page.evaluate("async()=>{await window.sentlogAppReady}")
        page.evaluate("""()=>{
          const p={id:'trace-project',name:'自動描写テスト',drawings:[{
            id:'trace-drawing',name:'壁面図',sourceType:'image',fileName:'壁面図.png',pageCount:1,createdAt:1,updatedAt:1
          }]};
          workspace={projects:[p]};activeProjectId=p.id;activeDrawingId='trace-drawing';
          state=freshDrawingState(p.name);state.sourceType='image';state.fileName='壁面図.png';
          currentView='editor';showEditor();setupStage(900,600);
          document.getElementById('damageType').value='ひび割れ';render();
        }""")
        assert page.locator('#slAutoTraceButton').count()==1
        def photo_file():
            page.evaluate("""async()=>{
              const c=document.createElement('canvas');c.width=270;c.height=175;
              const g=c.getContext('2d');g.fillStyle='#696969';g.fillRect(0,0,c.width,c.height);
              g.strokeStyle='#faf9f7';g.lineWidth=5;g.lineJoin='round';g.lineCap='round';
              g.beginPath();g.moveTo(25,10);
              for(let y=10;y<=157;y+=3)g.lineTo(25+7*Math.sin(y/16),y);
              g.stroke();
              g.beginPath();g.rect(119,28,101,115);g.stroke();
              g.beginPath();g.moveTo(135,119);g.lineTo(197,53);g.stroke();
              const blob=await new Promise(ok=>c.toBlob(ok,'image/png'));
              const data=new DataTransfer();data.items.add(new File([blob],'white-chalk.png',{type:'image/png'}));
              const target=document.getElementById('slAutoTraceCamera');target.files=data.files;
              target.dispatchEvent(new Event('change',{bubbles:true}));
            }""")
        photo_file()
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=15000)
        assert page.locator('.sl-trace-row').count()>=2
        # The candidate cards are available, but start collapsed to leave room for the photograph.
        assert page.locator('.sl-trace-candidates-panel').count()==1
        assert page.locator('.sl-trace-candidates-panel').get_attribute('open') is None
        assert not page.locator('.sl-trace-row').first.is_visible()
        assert page.locator('.sl-trace-scroll').bounding_box()['height'] >= 120

        page.locator('.sl-trace-settings summary').click()
        page.locator('.sl-trace-detect select').select_option('strict')
        page.locator('.sl-trace-detect').get_by_role('button',name='再認識').click()
        assert '厳しめ' in page.locator('.sl-trace-status').inner_text()
        # Draw a detection window around the chalk curve, excluding the distant hatched area.
        page.locator('.sl-trace-detect').get_by_role('button',name='範囲指定').click()
        picture=page.locator('.sl-trace-canvas')
        picture.scroll_into_view_if_needed()
        bb=picture.bounding_box()
        assert bb and bb['height']>50,bb
        page.mouse.move(bb['x']+bb['width']*.025,bb['y']+bb['height']*.04)
        page.mouse.down()
        page.mouse.move(bb['x']+bb['width']*.40,bb['y']+bb['height']*.95,steps=9)
        page.mouse.up()
        try:
            page.wait_for_function("document.querySelectorAll('.sl-trace-row').length===1",timeout=6000)
        except Exception:
            print('REGION_TEST_DIAGNOSTIC',page.evaluate("""()=>({
              status:document.querySelector('.sl-trace-status')?.innerText,
              count:document.querySelectorAll('.sl-trace-row').length,
              rows:[...document.querySelectorAll('.sl-trace-row')].map(x=>x.textContent.slice(0,50)),
              active:[...document.querySelectorAll('[data-mode].active')].map(x=>x.dataset.mode),
              photo:(()=>{const e=document.querySelector('.sl-trace-canvas');const r=e?.getBoundingClientRect();return {width:e?.width,height:e?.height,rect:r&&{x:r.x,y:r.y,w:r.width,h:r.height}}})(),
              preview:document.querySelector('.sl-trace-settings')?.open,
              canvasOver:document.elementFromPoint(20,260)?.className
            })"""),flush=True)
            print('REGION_CONSOLE',logs[-20:],flush=True)
            raise
        assert 'ひび割れ線' in page.locator('.sl-trace-row').first.inner_text()
        assert page.evaluate('state.shapes.length')==0
        page.locator('.sl-trace-settings summary').click()
        page.locator('.sl-trace-detect').get_by_role('button',name='全体に戻す').click()
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=15000)
        # The user can leave at any time without writing the draft to the drawing.
        page.get_by_role('button',name='閉じる').click()
        assert page.evaluate('state.shapes.length')==0
        photo_file()
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=15000)
        assert page.locator('.sl-trace-candidates-panel').get_attribute('open') is None
        page.locator('.sl-trace-candidates-panel summary').click()
        assert page.locator('.sl-trace-row').first.is_visible()
        page.locator('.sl-trace-row').first.locator('select').select_option('剥離')
        line_row=page.locator('.sl-trace-row').filter(has_text='ひび割れ線').first
        assert line_row.count()==1
        line_row.click()
        page.get_by_role('button',name='選択線を基準').click()
        photo_length=page.locator('.sl-trace-set input[type=number]')
        photo_length.fill('1.200')
        photo_length.dispatch_event('change')
        assert '基準設定済み' in page.locator('.sl-trace-set').inner_text()
        page.get_by_role('button',name='図面に仮配置').click()
        assert page.locator('.sl-trace-placepanel').is_visible()
        assert page.evaluate('state.shapes.length')==0,'Nothing is stored before placement confirmation.'
        page.get_by_role('button',name='確定して変状登録').click()
        page.wait_for_function("state.shapes.length>=2",timeout=15000)
        result=page.evaluate("""()=>state.shapes.map(s=>({
          kind:s.kind,type:s.type,points:s.points.length,len:s.lineLengthM||null,
          id:s.id,page:s.page,hasRecordKind:!!s.recordKind,photos:s.photos.length
        }))""")
        assert any(s['kind']=='freehand-line' and s['len']>0 for s in result),result
        assert any(s['kind']=='freehand-area' and s['type']=='剥離' for s in result),result
        assert all(not s['hasRecordKind'] and s['page']==1 and s['id'] for s in result),result
        page.wait_for_function("state.shapes.every(s=>s.photos.length===1)",timeout=20000)
        assert page.evaluate("new Set(state.shapes.map(s=>s.photos[0].id)).size===1"),'One photo must not be physically duplicated for each crack.'
        assert page.evaluate("""()=>{
          const raw=window.SentlogRecords.getItem(drawingStorageKey('trace-drawing'));
          return JSON.parse(raw).shapes.length===state.shapes.length;
        }""")
        page.evaluate('undo()')
        assert page.evaluate('state.shapes.length')==0,'One undo should revert all auto-traced shapes.'
        assert not errors,errors
        browser.close()
        print('PASS generated Sentlog page: collapsed candidates, sensitivity + range reanalysis, normal damage, photo and undo')
finally:
    server.shutdown()
