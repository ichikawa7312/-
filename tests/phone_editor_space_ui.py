"""Compact phone editor in the complete production build.

PDF.js, controls, dialogs and native IndexedDB/File storage are real. Every
record and image is synthetic, in a disposable persistent profile, with all
external services blocked. Browser viewport/touch emulation is not a physical
iPhone, Safari chrome, safe-area sensor or software-keyboard verification.
"""
import argparse
import base64
import functools
import hashlib
import json
import os
import re
import struct
import tempfile
import threading
import time
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROJECT, PDF_ID, IMAGE_ID = 'phone-space-project', 'phone-space-pdf', 'phone-space-image'
IPHONE = ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) '
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1')
IPAD = IPHONE.replace('iPhone; CPU iPhone OS', 'iPad; CPU OS')
PORTRAITS = [(320, 568), (390, 844)]
MOVED = ['memoVisibilityBtn', 'memoEditBtn', 'memoPdfBtn', 'slAutoTraceButton',
         'slDisplayFilterBtn', 'sentlogPageManagementActions']
DXF_TOOLS = ['dxfExportBtn', 'dxfInfoBtn', 'dxfRasterBtn']
TOOLS = ['[data-tool="polygon"]', '[data-tool="freehand-line"]',
         '[data-tool="freehand-area"]', '[data-tool="rect"]',
         '[data-tool="line"]', '[data-field-record-tool="record"]']
TOP = ['#damageModeBtn', '#memoModeBtn', '#undoBtn', '#redoBtn', '#sentlogPhoneMoreBtn']


def pdf_bytes():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>']
    for number in range(3):
        stream = f'q 0.{number+2} 0.4 0.6 RG 3 w 40 40 520 320 re S Q'.encode()
        objects.extend([
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> /Contents {4+2*number} 0 R >>'.encode(),
            f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream'])
    data, offsets = bytearray(b'%PDF-1.4\n'), [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{number} 0 obj\n'.encode()+body+b'\nendobj\n')
    start = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'.encode())
    return bytes(data)


def png_bytes():
    def chunk(kind, value):
        return struct.pack('!I', len(value))+kind+value+struct.pack('!I', zlib.crc32(kind+value) & 0xffffffff)
    rows = b''.join(b'\x00'+bytes((210, 230, 250))*80 for _ in range(60))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', 80, 60, 8, 2, 0, 0, 0))+
            chunk(b'IDAT', zlib.compress(rows))+chunk(b'IEND', b''))


def dxf_bytes():
    """Small real CAD source with one external raster reference (not a GL test)."""
    groups = [(0, 'SECTION'), (2, 'HEADER'), (9, '$ACADVER'), (1, 'AC1032'),
              (9, '$INSUNITS'), (70, 4), (0, 'ENDSEC'), (0, 'SECTION'), (2, 'OBJECTS'),
              (0, 'IMAGEDEF'), (5, 'A1'), (100, 'AcDbRasterImageDef'), (1, 'reference.png'),
              (10, 80), (20, 60), (0, 'ENDSEC'), (0, 'SECTION'), (2, 'ENTITIES'),
              (0, 'LINE'), (5, 'C1'), (10, 0), (20, 0), (11, 600), (21, 400),
              (0, 'IMAGE'), (5, 'B1'), (100, 'AcDbRasterImage'), (340, 'A1'),
              (10, 100), (20, 100), (11, 1), (21, 0), (12, 0), (22, 1),
              (13, 80), (23, 60), (70, 1), (0, 'ENDSEC'), (0, 'EOF')]
    return ''.join(f'{code}\n{value}\n' for code, value in groups).encode()


def evaluate(page, source, arg=None):
    return page.evaluate("""async ({source,arg})=>{
      let timer;try{return await Promise.race([eval('('+source+')')(arg),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Phone layout step timed out: '+
          JSON.stringify({view:typeof currentView==='undefined'?null:currentView,
            pending:window.SentlogRecords?.pending}))),20000);})]);}
      finally{clearTimeout(timer);}
    }""", {'source': source, 'arg': arg})


def ready(page):
    page.wait_for_function('window.sentlogAppReady&&window.SentlogCameraReturn&&window.SentlogOriginalPhotos&&window.SentlogDrawingMemos&&window.SentlogPageReplacement', timeout=60000)
    evaluate(page, 'async()=>{await sentlogAppReady;await SentlogCameraReturn.ready;}')
    page.evaluate("pdfjsLib.GlobalWorkerOptions.workerSrc='./vendor/export-pdf.worker.min.js'")


def seed(page):
    evaluate(page, """async ({pdf,png})=>{
      const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
      const project={id:'phone-space-project',name:'合成レイアウト検証',createdAt:1,updatedAt:1,drawings:[]};
      for(const [id,name,sourceType,bytes] of [
        ['phone-space-pdf','three-pages.pdf','pdf',pdf],['phone-space-image','image.png','image',png]]){
        const meta={id,name,fileName:name,sourceType,pageCount:sourceType==='pdf'?3:1,createdAt:1,updatedAt:1};
        project.drawings.push(meta);
        const state={...freshDrawingState(project.name),sourceType,fileName:name,
          pageCount:meta.pageCount,currentPage:1,width:600,height:400,
          shapes:sourceType==='pdf'?Array.from({length:3},(_,i)=>({
            id:'phone-record-'+(i+1),kind:'rect',page:i+1,type:'腐食',typeNo:i+1,globalNo:i+1,
            x:80+i*30,y:90,w:140,h:60,strokeWidth:.8,member:'合成部材',memo:'保持する所見 '+(i+1),
            photos:i?[]:[{id:'phone-retained-photo',name:'source.png',createdAt:1,type:'image/png'}]})):[]};
        SentlogRecords.setItem(drawingStorageKey(id),JSON.stringify(state));
        await SentlogRecords.writeFile('background:'+id,new File([decode(bytes)],name,
          {type:sourceType==='pdf'?'application/pdf':'image/png'}));
      }
      workspace={projects:[project]};saveWorkspace();
      const photo=new File([decode(png)],'source.png',{type:'image/png',lastModified:1});
      await savePhotoBlob('phone-retained-photo',photo,'phone-space-pdf');
      await SentlogOriginalPhotos.saveOriginal('phone-space-pdf','phone-retained-photo',photo,{
        projectId:project.id,projectName:project.name,drawingName:'three-pages.pdf',
        shapeId:'phone-record-1',shapeLabel:'腐食-1',exportName:'source.png',createdAt:1});
      await SentlogRecords.settled();await openDrawing(project.id,'phone-space-pdf');
      clearSelection();$('inspector').classList.remove('open');clearAllHistory();
      persist();await SentlogRecords.settled();
    }""", {'pdf': base64.b64encode(pdf_bytes()).decode(), 'png': base64.b64encode(png_bytes()).decode()})
    expect(page.locator('#editorView')).to_be_visible()
    page.wait_for_function("state.sourceType==='pdf'&&state.currentPage===1&&pdfDoc?.numPages===3&&$('loading').style.display!=='grid'")


PROOF = """async()=>{
  await SentlogRecords.settled();SentlogRecords.assertSafe();
  const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('phone-space-pdf')));
  const fields=['id','kind','page','type','no','typeNo','globalNo','autoLabel','x','y','w','h',
    'points','labelPos','strokeWidth','member','memo','photos'];
  const digest=async blob=>{if(!(blob instanceof Blob)||!blob.size)throw Error('Retained file missing');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))]
      .map(n=>n.toString(16).padStart(2,'0')).join('');};
  return {records:saved.shapes.map(s=>Object.fromEntries(fields.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))),
    background:await digest(await getDBFile('background:phone-space-pdf')),
    shared:await digest(await getPhotoBlob('phone-retained-photo','phone-space-pdf')),
    original:await digest(await SentlogOriginalPhotos.getOriginal('phone-space-pdf','phone-retained-photo')),
    originalMeta:await SentlogOriginalPhotos.listMeta('phone-space-pdf')};
}"""

MEASURE = """()=>{
  const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
  return {viewport:{width:innerWidth,height:innerHeight},header:rect(document.querySelector('body > header')),
    toolbar:rect($('sentlogDrawingToolbar')),stage:rect($('stageWrap')),pager:rect($('pageControls')),
    handle:rect($('mobileHandle')),transform:{scale,tx,ty},page:state.currentPage,
    documentWidth:document.documentElement.scrollWidth};
}"""


def settle(page):
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def resize(page, width, height, orientation=False):
    page.set_viewport_size({'width': width, 'height': height})
    if orientation:
        page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        page.wait_for_timeout(350)
    settle(page)


def assert_same_view(before, after):
    for group in ('stage', 'transform'):
        for key, value in before[group].items():
            assert abs(value-after[group][key]) < .6, (group, key, before, after)


def target(page, selector, minimum=44):
    node = page.locator(selector)
    expect(node).to_be_visible()
    result = node.evaluate("""e=>{
      const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,
        hit:hit===e||e.contains(hit),name:e.getAttribute('aria-label')||e.textContent.trim()};
    }""")
    size = page.viewport_size
    assert result['width'] >= minimum-.6 and result['height'] >= minimum-.6, (selector, result)
    assert result['x'] >= -.6 and result['right'] <= size['width']+.6, (selector, result)
    assert result['y'] >= -.6 and result['bottom'] <= size['height']+.6, (selector, result)
    assert result['hit'] and result['name'], (selector, result)
    return result


def more(page):
    button = page.locator('#sentlogPhoneMoreBtn')
    if button.get_attribute('aria-expanded') != 'true':
        button.click()
    expect(page.locator('#sentlogPhoneMorePanel')).to_be_visible()
    expect(button).to_have_attribute('aria-expanded', 'true')
    assert page.locator('#sentlogPhoneMorePanel').evaluate("e=>e.tagName==='DIALOG'&&e.open")
    expect(page.locator('#sentlogPhoneMorePanel')).to_have_attribute('aria-modal', 'true')


def closed(page):
    expect(page.locator('#sentlogPhoneMorePanel')).not_to_be_visible()
    expect(page.locator('#sentlogPhoneMoreBtn')).to_have_attribute('aria-expanded', 'false')


def phone_layout(page, name):
    closed(page)
    measurement = page.evaluate(MEASURE)
    width, height = page.viewport_size['width'], page.viewport_size['height']
    assert measurement['documentWidth'] <= width+1, measurement
    assert measurement['toolbar']['height'] <= 112, measurement
    assert measurement['stage']['height'] >= (90 if width > height else 190), measurement
    assert measurement['stage']['bottom'] <= measurement['pager']['y']+1, measurement
    assert measurement['pager']['bottom'] <= measurement['handle']['y']+1, measurement
    header_buttons = [target(page, selector) for selector in
                      ('#navBackBtn', '#mobileSidebarBtn', '#sentlogCloudStatus')]
    assert max(b['y'] for b in header_buttons)-min(b['y'] for b in header_buttons) <= 2, header_buttons
    assert min(b['y'] for b in header_buttons) >= 54, header_buttons
    boxes = [target(page, selector) for selector in TOP+TOOLS]
    if width < height:
        first, second = boxes[:len(TOP)], boxes[len(TOP):]
        assert max(b['y'] for b in first)-min(b['y'] for b in first) <= 3, boxes
        assert max(b['y'] for b in second)-min(b['y'] for b in second) <= 3, boxes
        assert min(b['y'] for b in second) >= max(b['bottom'] for b in first)-1, boxes
    for selector in ('#prevPageBtn', '#nextPageBtn', '#mobileHandle'):
        target(page, selector)
    assert page.locator('#pageControls button').count() == 2
    assert page.locator('#sentlogPhoneMorePanel #sentlogPageManagementActions').count() == 1
    for identifier in MOVED:
        assert page.locator('#'+identifier).count() == 1, identifier
        assert page.locator('#sentlogPhoneMorePanel #'+identifier).count() == 1, identifier
    page.locator('#sentlogPhoneMoreBtn').click()
    more(page)
    assert_same_view(measurement, page.evaluate(MEASURE))
    panel = page.locator('#sentlogPhoneMorePanel').bounding_box()
    assert panel['x'] >= 0 and panel['x']+panel['width'] <= width+1, panel
    assert panel['y'] >= 0 and panel['y']+panel['height'] <= height+1, panel
    page.keyboard.press('Escape')
    closed(page)
    expect(page.locator('#sentlogPhoneMoreBtn')).to_be_focused()
    assert_same_view(measurement, page.evaluate(MEASURE))
    return {'name': name, **measurement}


def screenshot(page, report_path, suffix):
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(report_path.with_suffix('.'+suffix+'.png')))


def dxf_controller_actions(page, report, report_path):
    # Use real DXF parsing, native file/reference loading and production UI
    # controllers. Deliberately omit the WebGL viewer and output generation.
    evaluate(page, """async ({dxf,png})=>{
      const bytes=Uint8Array.from(atob(dxf),c=>c.charCodeAt(0)),id='phone-space-dxf';
      const info=SentlogDxfCore.inspect(bytes),frame=SentlogDxfCore.makeFrame({minX:0,minY:0,maxX:600,maxY:400});
      const sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const project=workspace.projects.find(p=>p.id==='phone-space-project');
      project.drawings.push({id,name:'DXF controller fixture',fileName:'controller.dxf',sourceType:'dxf',pageCount:1});
      await SentlogRecords.writeFile('background:'+id,new File([bytes],'controller.dxf',{type:'application/dxf'}));
      await SentlogRecords.writeFile('dxf-raster:'+id+':A1',new File([
        Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'reference.png',{type:'image/png'}));
      activeDrawingId=id;pdfDoc=null;selected=null;drawing=null;
      state={...freshDrawingState(project.name),sourceType:'dxf',fileName:'controller.dxf',
        currentPage:1,pageCount:1,width:frame.width,height:frame.height,
        dxf:{sourceHash,version:info.version,units:info.units,mmPerUnit:info.mmPerUnit,frame,warnings:info.warnings}};
      saveWorkspace();showEditor();setupStage(frame.width,frame.height);
      await SentlogDxfRaster.opened({drawingId:id,bytes,frame});
      updatePageUI();render();persist();await SentlogRecords.settled();
    }""", {'dxf': base64.b64encode(dxf_bytes()).decode(), 'png': base64.b64encode(png_bytes()).decode()})
    assert page.evaluate("SentlogDxfRaster.references.length===1&&SentlogDxfRaster.references[0].ready")
    resize(page, 320, 568)
    geometry = page.evaluate(MEASURE)
    assert geometry['documentWidth'] <= 321 and geometry['toolbar']['height'] <= 112, geometry
    for selector in TOP+TOOLS:
        target(page, selector)
    expect(page.locator('#pageControls')).not_to_be_visible()
    for identifier, modal, heading in (
        ('dxfExportBtn', '.sl-dxf-modal', 'DXFを出力'),
        ('dxfInfoBtn', '.sl-dxf-modal', 'DXF図面の情報'),
        ('dxfRasterBtn', '.sl-dxf-raster-modal', 'DXF参照画像')):
        more(page)
        assert page.locator('#sentlogPhoneMorePanel #'+identifier).count() == 1
        control = page.locator('#'+identifier)
        control.scroll_into_view_if_needed()
        target(page, '#'+identifier)
        if identifier == 'dxfRasterBtn':
            screenshot(page, report_path, 'phone-dxf-more-320')
        control.click()
        closed(page)
        expect(page.locator(modal+' h2')).to_have_text(heading)
        page.locator(modal).get_by_role('button', name='閉じる', exact=True).click()
    hashes = evaluate(page, """async()=>{
      const digest=async key=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
        await (await getDBFile(key)).arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
      return {source:await digest('background:phone-space-dxf'),reference:await digest('dxf-raster:phone-space-dxf:A1')};
    }""")
    assert hashes == {'source': hashlib.sha256(dxf_bytes()).hexdigest(), 'reference': hashlib.sha256(png_bytes()).hexdigest()}
    report['dxf'] = {'scope': 'Controller/layout regression with real DXF parsing and native reference files; no WebGL import/render/export-output claim.',
                     'geometry': geometry, 'preservedHashes': hashes}
    evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-pdf');}")
    more(page)
    for identifier in DXF_TOOLS:
        expect(page.locator('#'+identifier)).not_to_be_visible()
    page.keyboard.press('Escape')
    resize(page, 390, 844)


def phone_actions(page, report, report_path=None):
    before = evaluate(page, PROOF)
    assert before['background'] == hashlib.sha256(pdf_bytes()).hexdigest()
    assert before['original'] == hashlib.sha256(png_bytes()).hexdigest()
    assert before['shared'] == before['original']
    report['measurements'] = []
    for width, height in PORTRAITS:
        resize(page, width, height)
        # Each portrait is an independent initial-open view. The application's
        # ordinary resize intentionally retains pan/zoom (tested separately
        # below), so reopen through the real file path before visual evidence.
        evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-pdf');}")
        settle(page)
        report['measurements'].append(phone_layout(page, f'{width}x{height}'))
        screenshot(page, report_path, f'phone-{width}x{height}')
    resize(page, 844, 390, orientation=True)
    report['measurements'].append(phone_layout(page, '844x390-landscape'))
    screenshot(page, report_path, 'phone-844x390-landscape')
    resize(page, 390, 844, orientation=True)

    # A backdrop click must dismiss only: no vertex, pan or navigation underneath.
    page.locator(TOOLS[0]).click()
    more(page)
    screenshot(page, report_path, 'phone-more')
    point = page.evaluate("""()=>{
      const s=$('stageWrap').getBoundingClientRect(),d=$('sentlogPhoneMorePanel').getBoundingClientRect();
      const points=[[s.left+8,s.bottom-8],[s.right-8,s.bottom-8],[s.left+8,s.top+8]];
      return points.find(([x,y])=>x<d.left||x>d.right||y<d.top||y>d.bottom)||null;
    }""")
    assert point, 'No stage point remains outside the phone dialog for backdrop verification'
    viewport_before = page.evaluate(MEASURE)
    page.mouse.click(*point)
    closed(page)
    assert page.evaluate("currentView==='editor'&&tool==='polygon'&&drawing===null")
    assert_same_view(viewport_before, page.evaluate(MEASURE))
    page.locator(TOOLS[0]).click()

    # These are the real moved handlers, including native file-picker activation.
    more(page)
    visible = page.evaluate('SentlogDrawingMemos.visible')
    page.locator('#memoVisibilityBtn').click()
    closed(page)
    assert page.evaluate('SentlogDrawingMemos.visible') != visible
    more(page)
    page.locator('#memoVisibilityBtn').click()
    assert page.evaluate('SentlogDrawingMemos.visible') == visible
    more(page)
    page.locator('#memoPdfBtn').click()
    closed(page)
    expect(page.locator('.sl-memo-panel')).to_be_visible()
    page.get_by_role('button', name='PDF保存を閉じる', exact=True).click()
    more(page)
    with page.expect_file_chooser() as chooser:
        page.locator('#slAutoTraceButton').click()
    chooser.value.set_files([])
    closed(page)
    more(page)
    with page.expect_file_chooser() as chooser:
        page.locator('#sentlogPageReplaceBtn').click()
    chooser.value.set_files([])
    closed(page)
    more(page)
    expect(page.locator('#sentlogPageReplaceUndoBtn')).to_be_disabled()
    page.locator('#sentlogPageManageBtn').click()
    closed(page)
    expect(page.locator('.sentlog-page-modal')).to_be_visible()
    assert page.locator('.sentlog-page-modal .sentlog-page-row').count() == 3
    page.locator('.sentlog-page-modal').get_by_role('button', name='閉じる', exact=True).click()

    # Page movement and reversible rotation exercise handlers after reparenting.
    expect(page.locator('#prevPageBtn')).to_be_disabled()
    for number in (2, 3):
        page.locator('#nextPageBtn').click()
        page.wait_for_function('n=>state.currentPage===n&&$("loading").style.display!=="grid"', arg=number)
        assert page.locator('#pageIndicator').inner_text().strip() == f'{number} / 3'
    expect(page.locator('#nextPageBtn')).to_be_disabled()
    page.locator('#prevPageBtn').click()
    page.wait_for_function('state.currentPage===2&&$("loading").style.display!=="grid"')
    more(page)
    page.locator('#rotateRightBtn').click()
    closed(page)
    page.wait_for_function('getPageRotation()===90&&$("loading").style.display!=="grid"')
    more(page)
    page.locator('#rotateLeftBtn').click()
    page.wait_for_function('getPageRotation()===0&&$("loading").style.display!=="grid"')
    page.locator('#prevPageBtn').click()
    page.wait_for_function('state.currentPage===1&&$("loading").style.display!=="grid"')

    # Hide a middle sheet via the actual manager, then restore it. Original PDF
    # page numbers and attached records must survive the visible-page ordering.
    more(page)
    page.locator('#sentlogPageManageBtn').click()
    row = page.locator('.sentlog-page-row').filter(has_text='元PDF 2ページ目')
    page.once('dialog', lambda dialog: dialog.accept())
    row.locator('.sentlog-page-hide').click()
    page.wait_for_function("state.pageStates['2']?.hidden===true")
    page.locator('.sentlog-page-modal').get_by_role('button', name='閉じる', exact=True).click()
    page.locator('#nextPageBtn').click()
    page.wait_for_function('state.currentPage===3&&$("loading").style.display!=="grid"')
    assert page.locator('#pageIndicator').inner_text().strip() == '2 / 2'
    page.locator('#prevPageBtn').click()
    page.wait_for_function('state.currentPage===1&&$("loading").style.display!=="grid"')
    more(page)
    page.locator('#sentlogPageManageBtn').click()
    page.locator('.sentlog-page-row').filter(has_text='元PDF 2ページ目').locator('.sentlog-page-restore').click()
    page.wait_for_function("state.pageStates['2']?.hidden===false")
    page.locator('.sentlog-page-modal').get_by_role('button', name='閉じる', exact=True).click()

    # Temporary display filtering stays visible to the user after its control moves.
    more(page)
    page.locator('#slDisplayFilterBtn').click()
    closed(page)
    filter_dialog = page.locator('.sl-display-filter-dialog')
    expect(filter_dialog).to_be_visible()
    filter_dialog.get_by_role('button', name='すべて非表示', exact=True).click()
    filter_dialog.get_by_role('button', name='画面に反映', exact=True).click()
    page.wait_for_function("$('sentlogPhoneMoreBtn').getAttribute('aria-label')?.includes('絞り込')")
    assert '絞込' in page.locator('#sentlogPhoneMoreBtn').inner_text()
    more(page)
    page.locator('#slDisplayFilterBtn').click()
    page.locator('.sl-display-filter-dialog').get_by_role('button', name='全表示に戻す', exact=True).click()

    page.locator('#memoModeBtn').click()
    assert page.evaluate("SentlogDrawingMemos.mode==='memo'")
    expect(page.locator('[data-field-record-tool="record"]')).not_to_be_visible()
    memo_tools = page.locator('[data-memo-tool]')
    for index in range(memo_tools.count()):
        control = memo_tools.nth(index)
        control.scroll_into_view_if_needed()
        target(page, '[data-memo-tool="'+control.get_attribute('data-memo-tool')+'"]', minimum=40)
        control.click()
        assert page.evaluate('tool') == 'memo-'+control.get_attribute('data-memo-tool')
        control.click()
        assert page.evaluate('tool') == 'pan'
    more(page)
    page.locator('#memoEditBtn').click()
    closed(page)
    expect(page.locator('.sl-memo-panel')).to_be_visible()
    page.locator('.sl-memo-panel').get_by_role('button', name='編集を閉じる', exact=True).click()
    page.locator('#damageModeBtn').click()
    target(page, '[data-field-record-tool="record"]')
    for selector in TOOLS[:5]:
        page.locator(selector).click()
        assert page.evaluate('tool') == page.locator(selector).get_attribute('data-tool')
        page.locator(selector).click()
        assert page.evaluate('tool') == 'pan'

    # The production editor appends immutable comments. Use its actual input
    # and Save control; a raw memo assignment is also imported as an append,
    # so expecting the original comment to be replaced would be incorrect.
    page.evaluate("clearAllHistory();selectShape('phone-record-1');$('inspector').classList.add('open')")
    original_memo = page.evaluate("state.shapes.find(s=>s.id==='phone-record-1').memo")
    appended_memo = original_memo+'\n\n一時的な検証追記'
    page.locator('#slCollabDraft').fill('一時的な検証追記')
    page.locator('#slCollabComments [data-actions]').get_by_role('button', name='保存', exact=True).click()

    def committed_memo(expected):
        page.wait_for_function("expected=>state.shapes.find(s=>s.id==='phone-record-1').memo===expected", arg=expected)
        result = evaluate(page, """async()=>{
          await SentlogRecords.settled();SentlogRecords.assertSafe();
          const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey('phone-space-pdf')));
          const record=saved.shapes.find(s=>s.id==='phone-record-1');
          return {memo:record.memo,photos:record.photos.map(p=>p.id)};
        }""")
        assert result == {'memo': expected, 'photos': ['phone-retained-photo']}, result

    committed_memo(appended_memo)
    page.locator('#mobileHandle').click()
    page.locator('#undoBtn').click()
    committed_memo(original_memo)
    page.locator('#redoBtn').click()
    committed_memo(appended_memo)
    page.locator('#undoBtn').click()
    committed_memo(original_memo)
    report['history'] = {'realCommentInputAndSave': True, 'undoRedoUndo': True, 'photoLinkPreserved': True}

    # Browser height changes model the resize path, not a real iOS keyboard.
    page.evaluate("selectShape('phone-record-1');$('inspector').classList.add('open')")
    page.locator('#slCollabDraft').focus()
    transform = page.evaluate('({scale,tx,ty})')
    resize(page, 390, 480)
    assert page.evaluate('({scale,tx,ty})') == transform
    page.locator('#slCollabDraft').scroll_into_view_if_needed()
    expect(page.locator('#slCollabDraft')).to_be_focused()
    resize(page, 390, 844)
    assert page.evaluate('({scale,tx,ty})') == transform
    page.locator('#mobileHandle').click()
    expect(page.locator('#inspector')).not_to_have_class(re.compile(r'.*\bopen\b.*'))

    # Editor exit closes the dialog; opening an image hides PDF-only actions.
    more(page)
    evaluate(page, "async()=>{showDrawings('phone-space-project');await SentlogRecords.settled();}")
    closed(page)
    evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-image');}")
    closed(page)
    expect(page.locator('#pageControls')).not_to_be_visible()
    more(page)
    expect(page.locator('#sentlogPageManagementActions')).not_to_be_visible()
    page.keyboard.press('Escape')
    evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-pdf');}")
    assert evaluate(page, PROOF) == before, 'Layout/actions changed retained record, photo or background content'
    page.reload(wait_until='domcontentloaded')
    ready(page)
    evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-pdf');}")
    closed(page)
    assert evaluate(page, PROOF) == before, 'Native reload did not retain original records and file bytes'
    assert page.locator('#sentlogPhoneMoreBtn').count() == 1
    assert page.locator('#sentlogPhoneMorePanel').count() == 1
    dxf_controller_actions(page, report, report_path)
    assert evaluate(page, PROOF) == before, 'DXF controller layout changed the retained PDF or photos'
    report['preservation'] = {'records': 3, 'photoOriginalAndShared': 1, 'nativeReload': True,
                              'backgroundSha256': before['background'], 'originalSha256': before['original']}


class Server:
    def __init__(self, root):
        self.root = root.resolve()
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *unused):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(self.root)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def route(self, request):
        url = request.request.url
        if url.startswith((self.origin+'/', 'blob:', 'data:')):
            request.continue_()
        elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
            name = 'export-pdf.worker.min.js' if 'worker' in url else 'export-pdf.min.js'
            request.fulfill(content_type='text/javascript', body=(self.root/'sentlog/vendor'/name).read_bytes())
        else:
            request.abort()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def context_for(engine, profile, server, kind):
    dimensions = {'phone': (390, 844), 'ipad': (768, 1024), 'desktop': (1280, 900)}
    width, height = dimensions[kind]
    options = dict(headless=True, viewport={'width': width, 'height': height},
                   has_touch=kind != 'desktop', is_mobile=kind != 'desktop',
                   device_scale_factor=2 if kind != 'desktop' else 1, service_workers='block')
    if engine.name == 'chromium' and not os.path.exists(engine.executable_path) and os.path.exists('/usr/bin/chromium'):
        options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    if kind != 'desktop':
        options['user_agent'] = IPHONE if kind == 'phone' else IPAD
    context = engine.launch_persistent_context(profile, **options)
    context.route('**/*', server.route)
    page = context.pages[0] if context.pages else context.new_page()
    page.set_default_timeout(15000)
    return context, page


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--baseline-root', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = {'engine': args.engine, 'passed': False, 'phase': 'starting',
              'scope': 'Real production PDF.js/dialogs/native persistent IndexedDB. Synthetic records only; external services blocked. Emulated viewport/input, not physical iPhone or software keyboard.'}
    started = time.monotonic()
    def phase(label):
        report['phase'] = label
        print('PHONE_EDITOR_SPACE_PROGRESS '+json.dumps({'engine': args.engine, 'phase': label}), flush=True)
    try:
        with sync_playwright() as playwright:
            engine = getattr(playwright, args.engine)
            if args.baseline_root:
                phase('baseline production geometry')
                server = Server(args.baseline_root)
                try:
                    with tempfile.TemporaryDirectory(prefix='sentlog-phone-baseline-') as profile:
                        context, page = context_for(engine, profile, server, 'phone')
                        try:
                            page.goto(server.origin+'/sentlog/', wait_until='domcontentloaded')
                            ready(page)
                            seed(page)
                            report['baseline'] = {'version': page.evaluate('window.SENTLOG_BUILD'), 'measurements': []}
                            for width, height in PORTRAITS+[(844, 390)]:
                                resize(page, width, height, orientation=width > height)
                                if width < height:
                                    evaluate(page, "async()=>{await openDrawing('phone-space-project','phone-space-pdf');}")
                                    settle(page)
                                report['baseline']['measurements'].append(page.evaluate(MEASURE))
                        finally:
                            context.close()
                finally:
                    server.close()
            server = Server(args.built_root)
            try:
                for kind in ('phone', 'ipad', 'desktop'):
                    phase(kind+' native fixture')
                    with tempfile.TemporaryDirectory(prefix='sentlog-phone-space-'+kind+'-') as profile:
                        context, page = context_for(engine, profile, server, kind)
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        try:
                            page.goto(server.origin+'/sentlog/', wait_until='domcontentloaded')
                            ready(page)
                            seed(page)
                            report['version'] = page.evaluate('window.SENTLOG_BUILD')
                            if kind == 'phone':
                                page.wait_for_function("window.SentlogPhoneEditorSpace?.version==='v1.99'")
                                expect(page.locator('#sentlogPhoneMoreBtn')).to_have_attribute('aria-controls', 'sentlogPhoneMorePanel')
                                phase('phone geometry and moved controls')
                                phone_actions(page, report, args.report)
                            else:
                                assert not page.evaluate("document.documentElement.classList.contains('sentlog-phone')")
                                assert page.locator('#sentlogPhoneMoreBtn').count() == 0 or not page.locator('#sentlogPhoneMoreBtn').is_visible()
                                assert page.locator('#sidebar #pageControls').count() == 1
                                assert page.locator('#sidebar #sentlogPageManagementActions').count() == 1
                                assert page.locator('#sentlogDrawingToolbar #memoPdfBtn').count() == 1
                                assert page.locator('#sentlogDrawingToolbar #slAutoTraceButton').count() == 1
                                page.locator(TOOLS[0]).click()
                                assert page.evaluate("tool==='polygon'")
                                page.locator(TOOLS[0]).click()
                                assert page.evaluate("tool==='pan'")
                                report[kind] = page.evaluate(MEASURE)
                            assert not errors, errors
                            if args.report:
                                args.report.parent.mkdir(parents=True, exist_ok=True)
                                page.screenshot(path=str(args.report.with_suffix('.'+kind+'.png')))
                        except Exception as error:
                            report.update(error=str(error), pageErrors=errors, device=kind)
                            try:
                                report['lastMeasurement'] = page.evaluate(MEASURE)
                                if args.report:
                                    args.report.parent.mkdir(parents=True, exist_ok=True)
                                    page.screenshot(path=str(args.report.with_suffix('.failure.png')))
                            except Exception as inspection_error:
                                report['inspectionError'] = str(inspection_error)
                            raise
                        finally:
                            context.close()
            finally:
                server.close()
            if 'baseline' in report:
                report['gains'] = []
                for old, new in zip(report['baseline']['measurements'], report['measurements']):
                    gain = new['stage']['height']-old['stage']['height']
                    report['gains'].append({'viewport': new['viewport'], 'before': old['stage']['height'],
                                            'after': new['stage']['height'], 'gainPx': gain})
                    assert gain >= 80, ('Phone drawing area did not meaningfully increase', report['gains'])
            report['passed'] = True
            phase('complete')
    finally:
        report['elapsedSeconds'] = round(time.monotonic()-started, 2)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': phone drawing space, dialogs, moved controls, native PDF/photo preservation and PC/iPad layout', flush=True)


if __name__ == '__main__':
    main()
