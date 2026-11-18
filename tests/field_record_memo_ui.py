"""Built-app regression: Japanese survey memo survives redraw, photos and sync.

All records are synthetic; external services are blocked. Chromium uses the real
camera input and photo storage. WebKit supplies Blob transport fixtures, while
both engines retain real IndexedDB records and the production merge/commit code.
"""
import argparse
import base64
import functools
import os
import struct
import threading
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def photo_png():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('!2I5B', 32, 32, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress((b'\0' + b'\x90\x90\x90' * 32) * 32)) +
            chunk(b'IEND', b''))


SETUP = r"""async encoded=>{
  await window.sentlogAppReady;
  const ids=['memo-plan-a','memo-plan-b'],pid='memo-project';
  const makeRecord=(id,memo,n)=>({id,page:1,kind:'field-record',recordKind:'field-record',
    recordType:'survey',type:'調査',displayKind:'point',recordNo:n,typeNo:n,globalNo:n,
    autoLabel:'調査-'+n,point:{x:200+n*90,y:250},points:[{x:200+n*90,y:250},{x:200+n*90,y:250}],
    surveyItems:['写真記録'],memo,photos:[]});
  const metas=ids.map((id,i)=>({id,name:'合成図面'+(i+1),sourceType:'image',fileName:'fixture.svg',pageCount:1}));
  const file=new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/></svg>'],'fixture.svg',{type:'image/svg+xml'});
  const photo=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'});
  const files=new Map(ids.map(id=>['background:'+id,file]));
  const originalRead=getDBFile;
  getDBFile=async function(key){return files.has(key)?files.get(key):originalRead.apply(this,arguments)};
  workspace={projects:[{id:pid,name:'合成メモ検証',drawings:metas}]};
  SentlogRecords.setItem(WORKSPACE_KEY,JSON.stringify(workspace));
  for(let i=0;i<ids.length;i++){
    const shapes=i?[makeRecord('survey-a','別図面に保存済み',1)]:
      [makeRecord('survey-a','保存済みの所見',1),makeRecord('survey-b','別記録の所見',2)];
    if(!i)shapes.push({id:'drawing-note',page:1,kind:'memo',recordKind:'drawing-memo',
      memoType:'line',points:[{x:100,y:100},{x:180,y:140}],color:'#2563eb',strokeWidth:1,unit:1});
    SentlogRecords.setItem(drawingStorageKey(ids[i]),JSON.stringify({...freshDrawingState('合成メモ検証'),
      sourceType:'image',fileName:'fixture.svg',width:1200,height:800,shapes}));
  }
  await SentlogRecords.settled();await openDrawing(pid,ids[0]);
  SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');
  persist();await SentlogRecords.settled();clearAllHistory();
  window.memoFixture={
    ids,pid,files,photo,
    record:(id='survey-a')=>state.shapes.find(s=>s.id===id),
    snapshot(){
      const project=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY)).projects.find(p=>p.id===pid);
      return {project,drawings:project.drawings.map(meta=>({meta,state:JSON.parse(SentlogRecords.getItem(drawingStorageKey(meta.id)))}))};
    },
    async commit(payload){
      const expected=JSON.stringify(JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY)).projects.find(p=>p.id===pid));
      return sentlogSyncView.commit({client_key:pid},{payload},expected);
    }
  };
  memoFixture.base=structuredClone(memoFixture.snapshot());
}"""


def saved_memo(page, text, record='survey-a'):
    value = page.evaluate("""async id=>{
      await SentlogRecords.settled();
      const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId)));
      const serialized=JSON.parse(sentlogSyncView.snapshotText(memoFixture.snapshot()));
      return {model:memoFixture.record(id)?.memo,saved:saved.shapes.find(s=>s.id===id)?.memo,
        snapshot:serialized.drawings.find(d=>d.meta.id===activeDrawingId).state.shapes.find(s=>s.id===id)?.memo,
        input:selected===id?$('frRecordMemo').value:null,view:currentView};
    }""", record)
    assert value['model'] == value['saved'] == value['snapshot'] == text, value
    assert value['input'] in (None, text) and value['view'] == 'editor', value


def run(page, engine, png):
    page.evaluate(SETUP, base64.b64encode(png).decode('ascii'))
    memo = page.locator('#frRecordMemo')
    memo.fill('中性化深さを確認')
    final = '中性化深さを確認。採取位置は上流側。\n写真と照合する。'
    memo.fill(final)
    page.evaluate("render();SentlogFieldRecords.selectRecord('survey-a');render()")
    assert page.evaluate("document.activeElement===$('frRecordMemo')"), 'test must not blur before redraw'
    assert not page.evaluate('SentlogFieldRecords.isMemoEditing()'), 'saved focus alone must not block sync'
    saved_memo(page, final)
    assert page.evaluate('historyFor().undo.length') == 1, 'typing session must be one undo'
    memo.evaluate('el=>el.blur()')
    page.evaluate('undo()')
    saved_memo(page, '保存済みの所見')
    page.evaluate("redo();SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open')")
    saved_memo(page, final)

    # Keep the memo focused while a photo is registered/received.
    final += '\n写真を追加して確認。'
    memo.fill(final)
    if engine == 'chromium':
        page.locator('#cameraInput').set_input_files({'name': 'synthetic.png', 'mimeType': 'image/png', 'buffer': png})
        page.wait_for_function("memoFixture.record().photos.length===1")
    else:
        received = page.evaluate("""async()=>{
          const incoming=structuredClone(memoFixture.snapshot()),d=incoming.drawings[0];
          d.state.shapes[0].photos.push({id:'phone-photo',name:'synthetic.png',type:'image/png',size:memoFixture.photo.size});
          d.meta.photoCount=1;
          memoFixture.files.set(photoDBKey('phone-photo',activeDrawingId),memoFixture.photo);
          return memoFixture.commit(incoming);
        }""")
        assert received['applied'], received
    saved_memo(page, final)
    assert page.evaluate("activeDrawingId==='memo-plan-a'&&selected==='survey-a'")
    assert page.evaluate('memoFixture.record().photos.length') == 1

    # Two devices share the same ancestor: iPad changes text, iPhone adds a photo.
    merged = page.evaluate("""async()=>{
      await SentlogRecords.settled();
      const local=memoFixture.snapshot(),remote=structuredClone(memoFixture.base);
      remote.drawings[0].state.shapes[0].photos.push({id:'second-phone-photo',name:'phone.png',type:'image/png',size:memoFixture.photo.size});
      const result=SentlogSyncMerge.merge(local,remote,{base:memoFixture.base});
      if(!result.ok)return result;
      memoFixture.files.set(photoDBKey('second-phone-photo',activeDrawingId),memoFixture.photo);
      const received=await memoFixture.commit(result.payload);
      return {ok:result.ok,received,memo:result.payload.drawings[0].state.shapes[0].memo,
        photos:result.payload.drawings[0].state.shapes[0].photos.map(p=>p.id)};
    }""")
    assert merged['ok'] and merged['received']['applied'], merged
    assert merged['memo'] == final and len(merged['photos']) == 2, merged
    saved_memo(page, final)

    # An intentional deletion is a real edit and is transmitted as an empty memo.
    memo.fill('')
    page.evaluate('render()')
    saved_memo(page, '')
    memo.evaluate('el=>el.blur()')

    # IME preedit must remain in the DOM; redraw must not reset selection/caret.
    composition = page.evaluate("""()=>{
      const el=$('frRecordMemo');el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
      el.value='ちょうさちゅう';
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:el.value,isComposing:true}));
      el.setSelectionRange(2,5);render();render();
      return {value:el.value,start:el.selectionStart,end:el.selectionEnd,memo:memoFixture.record().memo,
        editing:SentlogFieldRecords.isMemoEditing()};
    }""")
    assert composition == {'value': 'ちょうさちゅう', 'start': 2, 'end': 5, 'memo': '', 'editing': True}, composition
    blocked = page.evaluate("""async()=>{
      const incoming=structuredClone(memoFixture.snapshot());
      incoming.drawings[0].state.shapes[1].memo='他端末の新しい所見';
      return memoFixture.commit(incoming);
    }""")
    assert not blocked['applied'] and blocked['reason'] == 'editing', blocked
    assert memo.input_value() == 'ちょうさちゅう'
    committed = '調査中：中性化を確認'
    page.evaluate("""text=>{
      const el=$('frRecordMemo');el.value=text;
      el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:text}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text,isComposing:false}));
      el.setSelectionRange(3,6);render();SentlogFieldRecords.selectRecord('survey-a');
    }""", committed)
    saved_memo(page, committed)
    assert memo.evaluate('el=>[el.selectionStart,el.selectionEnd]') == [3, 6]
    assert not page.evaluate('SentlogFieldRecords.isMemoEditing()')

    # A delayed change from the old selection must not bind to the new record.
    page.evaluate("""()=>{
      SentlogFieldRecords.selectRecord('survey-b');
      const el=$('frRecordMemo');el.value='古い記録から遅れて届いた文字';
      el.dispatchEvent(new Event('change',{bubbles:true}));render();
    }""")
    saved_memo(page, '別記録の所見', 'survey-b')
    assert page.evaluate('memoFixture.record().memo') == committed
    memo.fill('別記録に入力した所見')
    saved_memo(page, '別記録に入力した所見', 'survey-b')
    page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-b');
      SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');
      const el=$('frRecordMemo');el.value='前の図面から遅れて届いた文字';
      el.dispatchEvent(new Event('change',{bubbles:true}));render();
    }""")
    saved_memo(page, '別図面に保存済み')
    assert page.evaluate("JSON.parse(SentlogRecords.getItem(drawingStorageKey('memo-plan-a'))).shapes[1].memo") == '別記録に入力した所見'

    # Drawing-memo rendering temporarily filters state.shapes around inner
    # renderers. Ending an IME edit there must not persist that filtered array.
    retained = page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-a');
      SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');
      const note=state.shapes.find(s=>s.id==='drawing-note');
      if(!note)throw Error('Drawing memo was lost before the composition regression');
      const before=JSON.stringify(note),text='モード切替中にも残すメモ',el=$('frRecordMemo');
      el.focus();el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
      el.value=text;
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:text,isComposing:true}));
      selected=null;render();
      await Promise.resolve();await SentlogRecords.settled();
      const saved=JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId)));
      return {before,modelNote:JSON.stringify(state.shapes.find(s=>s.id==='drawing-note')),
        savedNote:JSON.stringify(saved.shapes.find(s=>s.id==='drawing-note')),
        modelIds:state.shapes.map(s=>s.id).sort(),savedIds:saved.shapes.map(s=>s.id).sort(),
        modelMemo:memoFixture.record().memo,savedMemo:saved.shapes.find(s=>s.id==='survey-a').memo,
        input:el.value,pending:SentlogFieldRecords.isMemoEditing(),text};
    }""")
    assert retained['modelIds'] == retained['savedIds'] == ['drawing-note', 'survey-a', 'survey-b'], retained
    assert retained['before'] == retained['modelNote'] == retained['savedNote'], retained
    assert retained['modelMemo'] == retained['savedMemo'] == retained['text'], retained
    assert not retained['pending'], retained
    print('PASS '+engine+': field memo persists before blur; redraw/photos/snapshot/merge preserve text; IME/caret, deliberate deletion, record/drawing binding and grouped undo')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    args = parser.parse_args()

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, args.engine)
            options = {'headless': True}
            if args.engine == 'chromium' and not os.path.exists(browser_type.executable_path) and os.path.exists('/usr/bin/chromium'):
                options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            browser = browser_type.launch(**options)
            context = browser.new_context(viewport={'width': 820, 'height': 1000}, is_mobile=True, has_touch=True,
                                          device_scale_factor=2, service_workers='block')

            def route(request):
                if request.request.url.startswith((origin + '/', 'blob:', 'data:')):
                    request.continue_()
                elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(status=200, content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin + '/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function("window.sentlogAppReady&&window.sentlogSyncView&&typeof window.SentlogFieldRecords?.isMemoEditing==='function'", timeout=30000)
                run(page, args.engine, photo_png())
                assert not errors, errors
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
