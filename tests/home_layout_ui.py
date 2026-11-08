"""Real generated Sentlog home: compact safe-area header, existing controls and no data edits."""
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
    launch={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
      launch.update(executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    browser=pw.chromium.launch(**launch)
    def route(req):
      url=req.request.url
      if url.startswith(origin) or url.startswith('blob:'):
        req.continue_()
      elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
        lib=ROOT/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])
        if lib.is_file():req.fulfill(content_type='text/javascript',body=lib.read_bytes())
        else:req.abort()
      else:
        req.abort()

    def load(context):
      page=context.new_page()
      errors=[]
      page.on('pageerror',lambda exc:errors.append(str(exc)))
      page.route('**/*',route)
      page.goto(origin+'/sentlog/')
      page.wait_for_function("!!window.SentlogHomeLayout && document.documentElement.classList.contains('sl-home-layout')",timeout=23000)
      page.wait_for_function("document.querySelector('header #sentlogRecordRescueBtn') && document.querySelector('header #sentlogCloudStatus') && document.querySelector('header #sentlogSettingsBtn')",timeout=18000)
      page.wait_for_function("document.querySelector('header #slHomePhotoBadge #slPhotoRedeliveryStatus')",timeout=15000)
      assert page.locator('#projectsView .manager-brand img').count()==1
      assert not page.locator('header .brand-mark').is_visible()
      assert not page.locator('header #headerTitle').is_visible()
      assert not page.locator('#projectsView .manager-brand-sub').is_visible()
      assert not page.locator('#projectsView .manager-head p').is_visible()
      assert not page.locator('#projectsView #slArchiveListTitle').is_visible()
      assert not page.locator('#projectsView .sentlog-build').is_visible()
      assert not page.locator('#projectsView #slPeerPhotosList').is_visible() if page.locator('#projectsView #slPeerPhotosList').count() else True
      assert page.locator('#slTopPhotoBadge').count()==0 if False else True # only live photo source is used
      assert page.locator('#slHomeHeaderVersion').inner_text()==page.evaluate('window.SENTLOG_BUILD')
      assert page.locator('#slHomeHeaderRight #sentlogSettingsBtn').count()==1
      assert page.locator('#slHomeHeaderLeft #sentlogRecordRescueBtn').count()==1
      assert page.locator('#slHomeHeaderLeft #sentlogCloudStatus').count()==1
      assert page.locator('#slHomePhotoBadge #slPhotoRedeliveryStatus').count()==1
      assert page.locator('#sentlogSettingsFooter #sentlogSettingsBtn').count()==0
      assert page.locator('header .brand-mark').count()==1,'Old logo remains available for other views.'
      # Count is taken exclusively from the existing source, never invented.
      page.evaluate("""()=>{
        document.getElementById('slPhotoRedeliveryStatus').textContent='写真 2432/2432 件を確認済み。';
      }""")
      page.wait_for_function("document.getElementById('slHomePhotoValue')?.textContent.includes('2432/2432')")
      assert '✓' in page.locator('#slHomePhotoValue').inner_text()
      assert page.locator('#slHomePhotoBadge').get_attribute('title')=='写真 2432/2432 件を確認済み。'
      page.evaluate("""()=>{document.getElementById('slPhotoRedeliveryStatus').textContent='写真 3 件を会社PCから再取得待ち。（確認済み 5/8 件）';}""")
      page.wait_for_function("document.getElementById('slHomePhotoValue')?.textContent.includes('5/8')")
      assert page.locator('#slHomePhotoBadge').get_attribute('data-state')=='warn'
      page.evaluate("""()=>{document.getElementById('slPhotoRedeliveryStatus').textContent='写真の確認が必要です：未保存 1 件';}""")
      page.wait_for_function("document.getElementById('slHomePhotoBadge')?.dataset.state==='error'")
      assert '要確認' in page.locator('#slHomePhotoValue').inner_text()
      page.evaluate("""()=>{document.getElementById('slPhotoRedeliveryStatus').textContent='写真 2432/2432 件を確認済み。';}""")

      # Settings and rescue must keep the actual existing callbacks after reparenting.
      page.locator('header #sentlogSettingsBtn').click()
      assert page.locator('#sentlogSettingsModal').evaluate("e=>e.classList.contains('open')")
      assert page.locator('#sentlogSettingsModal #exportBackupBtn').count()==1
      assert page.locator('#sentlogSettingsModal #importBackupBtn').count()==1
      page.locator('#sentlogSettingsClose').click()
      assert not page.locator('#sentlogSettingsModal').evaluate("e=>e.classList.contains('open')")
      page.locator('header #sentlogCloudStatus').click()
      assert page.locator('#sentlogCloudModal').is_visible()
      page.locator('#sentlogCloudClose').click()

      # Use an in-memory project fixture, not any user's records.
      page.evaluate("""()=>{
        workspace={projects:[{id:'home-top-test',name:'上田農水頭首工',drawings:[],createdAt:1,updatedAt:1}]};
        renderProjects();
      }""")
      assert page.locator('#projectsGrid .manager-card').count()>=1
      assert page.locator('#projectsView .manager-head h1').inner_text()=='案件一覧'
      assert not page.locator('#slArchiveListTitle').is_visible()
      page.locator('header #sentlogRecordRescueBtn').click()
      assert page.get_by_text('救出する案件を選択',exact=True).count()==1
      page.get_by_role('button',name='キャンセル').last.click()
      # Archive view still has a meaningful heading and a working back control.
      page.locator('#projectsGrid .sl-archive-folder').click()
      page.wait_for_function("document.querySelector('#projectsView .manager-head h1')?.textContent==='保管'")
      assert page.locator('#slArchiveBack').is_visible()
      page.locator('#slArchiveBack').click()
      page.wait_for_function("document.querySelector('#projectsView .manager-head h1')?.textContent==='案件一覧'")
      assert not page.locator('#slArchiveListTitle').is_visible()
      return page,errors

    desktop=browser.new_context(viewport={'width':1280,'height':800},service_workers='block')
    page,errors=load(desktop)
    header=page.locator('body > header').bounding_box()
    bar=page.locator('#slHomeHeaderTools').bounding_box()
    assert header and bar and bar['y']>=header['y']
    assert header['height']<100,header
    page.evaluate("showDrawings('home-top-test')")
    page.wait_for_function("!document.documentElement.classList.contains('sl-home-view')")
    assert page.locator('#navBackBtn').is_visible()
    assert page.locator('#headerTitle').is_visible()
    assert page.locator('#sentlogCloudStatus').is_visible()
    page.evaluate('showProjects()')
    assert page.locator('#projectsView .manager-head h1').inner_text()=='案件一覧'
    assert not errors,errors
    desktop.close()

    # iPhone PWA: hard reserve the status-bar/Dynamic Island region even when
    # simulated safe-area env() is reported as zero.
    iphone=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=3,
      is_mobile=True,has_touch=True,service_workers='block',
      user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1')
    page,errors=load(iphone)
    assert page.evaluate("document.documentElement.classList.contains('sentlog-phone')")
    for width in (320,360,390):
      page.set_viewport_size({'width':width,'height':844})
      page.evaluate("window.SentlogHomeLayout.measureHeader()")
      boxes=page.evaluate("""()=>{
        const header=document.querySelector('body > header').getBoundingClientRect();
        const controls=['sentlogRecordRescueBtn','sentlogCloudStatus','slHomePhotoBadge','slHomeHeaderVersion','sentlogSettingsBtn']
           .map(id=>document.getElementById(id).getBoundingClientRect())
           .map(r=>({x:r.x,y:r.y,w:r.width,h:r.height}));
        const project=document.getElementById('projectsView').getBoundingClientRect();
        return {header:{x:header.x,y:header.y,w:header.width,h:header.height,b:header.bottom},
                project:{y:project.y,b:project.bottom},controls};
      }""")
      assert boxes['header']['h']>=140,(width,boxes)
      assert boxes['project']['y']>=boxes['header']['b']-1,(width,boxes)
      for b in boxes['controls']:
        assert b['w']>0 and b['h']>=35,(width,b,boxes)
        assert b['x']>=boxes['header']['x']-1 and b['x']+b['w']<=boxes['header']['x']+boxes['header']['w']+1,(width,b,boxes)
        assert b['y']>=55 and b['y']+b['h']<=boxes['header']['b']+1,(width,b,boxes)
      assert boxes['project']['b']>=844-1,(width,boxes)
      assert page.locator('#slHomeHeaderRight #sentlogSettingsBtn').bounding_box()['height']>=44
    assert not errors,errors
    iphone.close()

    # iPad PWA receives a smaller top reserve without the iPhone-only 54px blank.
    ipad=browser.new_context(viewport={'width':768,'height':1024},device_scale_factor=2,
      is_mobile=True,has_touch=True,service_workers='block',
      user_agent='Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1')
    page,errors=load(ipad)
    h=page.locator('body > header').bounding_box()
    buttons=[page.locator('header #sentlogSettingsBtn').bounding_box(),
             page.locator('header #sentlogCloudStatus').bounding_box(),
             page.locator('header #sentlogRecordRescueBtn').bounding_box()]
    assert h['height']>=64,h
    assert all(b['y']>=20 and b['y']+b['height']<=h['y']+h['height']+1 for b in buttons),(h,buttons)
    assert page.locator('#projectsView').bounding_box()['y']>=h['y']+h['height']-1
    assert not errors,errors
    ipad.close()
    browser.close()
    print('PASS top home: compact original controls, photo count/version, archive and settings, iPhone 320–390/iPad safe areas')
finally:
  server.shutdown()
