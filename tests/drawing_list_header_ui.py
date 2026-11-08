"""Real generated Sentlog drawing list header: one row, group counts, original actions and iOS touch targets."""
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
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
    def route(rr):
      url=rr.request.url
      if url.startswith(origin) or url.startswith('blob:'):
        rr.continue_()
      elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
        lib=ROOT/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])
        if lib.exists():rr.fulfill(content_type='text/javascript',body=lib.read_bytes())
        else:rr.abort()
      else:rr.abort()
    def boot(context):
      page=context.new_page()
      errors=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      page.route('**/*',route)
      page.goto(origin+'/sentlog/')
      page.wait_for_function("window.SentlogDrawingListHeader && window.SentlogDrawingOrder && window.SentlogDrawingExport && window.SentlogHomeLayout && window.sentlogAppReady",timeout=25000)
      page.evaluate("async()=>await sentlogAppReady")
      page.evaluate("""async()=>{
        const mk=(id,groupId,groupName,sheetOrder)=>({
          id,name:'シート'+id,groupId,groupName,sheetName:'シート'+id,sheetOrder,
          fileName:'wall-'+id+'.png',sourceType:'image',pageCount:1,shapeCount:0,
          photoCount:0,createdAt:1,updatedAt:1
        });
        workspace={projects:[{
          id:'header-draw-project',name:'上田農水頭首工',
          drawings:[mk('01a','g01','01_施設平面図',1),mk('01b','g01','01_施設平面図',2),
                    mk('02','g02','02_施設側面図',1)],
          createdAt:1,updatedAt:1
        }]};
        saveWorkspace();
        await SentlogRecords.settled();
        showDrawings('header-draw-project');
      }""")
      page.wait_for_function("""()=>{
        const h=document.documentElement;
        return h.classList.contains('sl-drawings-view') &&
          !!document.querySelector('#slDrawingHeaderMiddle #slDrawingExportBtn') &&
          !!document.querySelector('#slDrawingHeaderMiddle #slDrawingHeaderAdd') &&
          !!document.querySelector('#slDrawingHeaderMiddle #slDrawingOrderToolbar') &&
          !!document.querySelector('#slDrawingHeaderMiddle #sentlogCloudStatus');
      }""",timeout=12000)
      assert page.locator('#slDrawingHeaderCounts').inner_text()=='図面2件 / シート3枚'
      assert page.locator('#slDrawingExportBtn').inner_text()=='図面一括出力'
      assert page.locator('#slDrawingHeaderAdd').inner_text()=='図面の追加'
      assert page.locator('#slDrawingOrderToolbar [data-role=toggle]').inner_text()=='⇅ 並び替え'
      assert not page.locator('#drawingsView .manager-head p').is_visible()
      assert not page.locator('#drawingsView .manager-subbar').is_visible()
      assert page.locator('#drawingsView .manager-head label[for="drawingAddInput"]').count()==0
      assert page.locator('#drawingAddInput').count()==1
      assert page.locator('#drawingsGrid [data-drawing-group-id]').count()==2
      assert page.locator('#headerTitle').inner_text()=='上田農水頭首工'
      assert page.locator('body > header .brand-mark').is_visible()
      assert page.locator('#navBackBtn').is_visible()
      assert page.locator('#slDrawingHeaderMiddle #sentlogCloudStatus').is_visible()
      assert page.locator('#slDrawingHeaderMiddle #slDrawingOrderToolbar').is_visible()
      # Open original multi-drawing PDF/ZIP export; do not replace the callback.
      page.locator('#slDrawingExportBtn').click()
      assert page.locator('.sl-drawing-export').is_visible()
      page.locator('.sl-drawing-export').get_by_role('button',name='閉じる／出力を中止').click()
      assert not page.locator('.sl-drawing-export').count()
      # Existing file input, still associated with the relocated 'add drawing' label.
      with page.expect_file_chooser() as event:
        page.locator('#slDrawingHeaderAdd').click()
      chooser=event.value
      assert chooser.element.get_attribute('id')=='drawingAddInput','Must open the original drawing file picker.'
      assert page.evaluate("document.getElementById('slDrawingHeaderAdd').control===document.getElementById('drawingAddInput')")
      # Existing reorder edit and numeric sort remain reachable from moved buttons.
      page.locator('#slDrawingOrderToolbar [data-role=toggle]').click()
      assert page.locator('#drawingsGrid.sl-order-edit').count()==1
      assert page.locator('#slDrawingOrderToolbar [data-role=numeric]').is_visible()
      assert page.locator('#drawingsGrid .sl-order-card-actions').count()==2
      page.locator('#slDrawingOrderToolbar [data-role=numeric]').click()
      page.wait_for_function("document.querySelector('#slDrawingOrderToolbar [data-role=toggle]')?.textContent.includes('完了')",timeout=10000)
      page.locator('#slDrawingOrderToolbar [data-role=toggle]').click()
      assert page.locator('#drawingsGrid.sl-order-edit').count()==0
      before=page.evaluate("SentlogRecords.getItem('surveyFieldNoteDrawingV1:01a')")
      page.evaluate('renderDrawings()')
      assert page.locator('#slDrawingHeaderMiddle #slDrawingOrderToolbar').count()==1
      assert page.locator('#slDrawingHeaderMiddle #slDrawingExportBtn').count()==1
      assert page.locator('#slDrawingHeaderMiddle #slDrawingHeaderAdd').count()==1
      assert page.evaluate("SentlogRecords.getItem('surveyFieldNoteDrawingV1:01a')")==before
      return page,errors
    desktop=browser.new_context(viewport={'width':1280,'height':800},service_workers='block')
    page,errors=boot(desktop)
    assert page.locator('body > header').bounding_box()['height']<100
    logo=page.locator('body > header .brand-mark').bounding_box()
    back=page.locator('body > header #navBackBtn').bounding_box()
    assert logo['x']<back['x'] and back['x']+back['width']>=1100
    page.evaluate("showProjects()")
    page.wait_for_function("document.documentElement.classList.contains('sl-home-view') && !document.documentElement.classList.contains('sl-drawings-view')")
    page.wait_for_function("document.querySelector('#slHomeHeaderLeft #sentlogCloudStatus')")
    assert not page.locator('#slDrawingHeaderMiddle').is_visible()
    assert page.locator('header #sentlogSettingsBtn').is_visible()
    page.evaluate("showDrawings('header-draw-project')")
    page.wait_for_function("document.documentElement.classList.contains('sl-drawings-view')")
    assert page.locator('#slDrawingHeaderMiddle #sentlogCloudStatus').count()==1
    assert not errors,errors
    desktop.close()

    def mobile(name,width,height,ua):
      context=browser.new_context(
        viewport={'width':width,'height':height},device_scale_factor=2,
        is_mobile=True,has_touch=True,user_agent=ua,service_workers='block')
      page,errors=boot(context)
      for width2 in ((320,360,390) if name=='iphone' else (768,820)):
        page.set_viewport_size({'width':width2,'height':height})
        page.evaluate("window.SentlogHomeLayout.measureHeader()")
        sizes=page.evaluate("""()=>{
          const r=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,right:b.right,bottom:b.bottom}};
          const h=document.querySelector('body > header').getBoundingClientRect();
          const sc=document.getElementById('slDrawingHeaderMiddle');
          return {header:{x:h.x,y:h.y,w:h.width,height:h.height,bottom:h.bottom},
           logo:r('headerTitle'),logoIcon:(()=>{const b=document.querySelector('header .brand-mark').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})(),
           back:r('navBackBtn'),center:r('slDrawingHeaderMiddle'),
           scrollWidth:sc.scrollWidth,clientWidth:sc.clientWidth,
           controls:['sentlogCloudStatus','slDrawingExportBtn','slDrawingHeaderAdd','slDrawingOrderToolbar'].map(r),
           listTop:document.getElementById('drawingsView').getBoundingClientRect().top};
        }""")
        assert sizes['center']['h']>=44,(name,width2,sizes)
        assert sizes['center']['y']>=20,(name,width2,sizes)
        assert sizes['logoIcon']['x']<sizes['logo']['x']<sizes['center']['x']<sizes['back']['x'],(name,width2,sizes)
        assert sizes['back']['h']>=44,(name,width2,sizes)
        assert sizes['back']['right']<=width2+1,(name,width2,sizes)
        assert sizes['listTop']>=sizes['header']['bottom']-1,(name,width2,sizes)
        assert sizes['back']['bottom']<=sizes['header']['bottom']+1,(name,width2,sizes)
        if name=='iphone':
          assert sizes['logo']['y']>=55 and sizes['back']['y']>=55,(name,width2,sizes)
          assert sizes['scrollWidth']>sizes['clientWidth'],(name,width2,sizes)
        assert page.locator('#slDrawingOrderToolbar [data-role=toggle]').is_visible()
        # Keep scrolling in the centre, never move the fixed logo or Back button.
        before_back=page.locator('#navBackBtn').bounding_box()['x']
        page.evaluate("document.getElementById('slDrawingHeaderMiddle').scrollLeft=300")
        assert abs(page.locator('#navBackBtn').bounding_box()['x']-before_back)<1,(name,width2)
      assert not errors,errors
      context.close()
    mobile('iphone',390,844,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1')
    mobile('ipad',768,1024,
      'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1')
    browser.close()
    print('PASS drawing list header: real export/add/sort, dynamic counts, fixed logo and Back, scrollable centre, iPhone/iPad safe-area')
finally:
  server.shutdown()
