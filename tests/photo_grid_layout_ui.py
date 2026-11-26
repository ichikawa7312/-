"""Native regression for known-photo row reservation, using synthetic data only.

The exact assembled renderer, photo-order helper, photo-panel markup and CSS
run in a small presentation harness. A SHA-pinned historical v2.05 renderer is
the baseline; both variants use the same unmodified assembled CSS. Delayed Blob
delivery is released between native mouse down/up. The baseline must expose
unreserved rows, but its actual click outcome is evidence, not a forced gate.
This is not a reproduction of the complete heavy-sync application's failure.
"""
import argparse
import base64
import hashlib
import json
import re
import struct
import sys
import tempfile
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
MARKER = 'sentlog-photo-grid-layout-v1'
HISTORICAL_SHA256 = 'd4d73469abf73358027c29a1f473dcc358644722e4f16f15755bd27e97278afe'
EXPECTED_TITLES = [f'photo-{index}.png' for index in range(7)]


def png(index):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    pixels = b''.join(b'\0' + bytes((30 + index * 13 % 200, 50, 140)) * 4 for _ in range(3))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 3, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def renderer(part):
    start = part.index('async function renderSelectedPhotos(){')
    end = part.index('\n\nfunction setManagerHeader', start)
    return part[start:end] + '\n'


FIXTURE_JS = r"""'use strict';
let photoRenderSeq=0,photoThumbUrls=[],selected=null;
const state={shapes:[]},$=id=>document.getElementById(id);
const data=__SYNTHETIC_PNG_DATA__;
const blobs=new Map(),blobIds=new WeakMap();
for(let n=0;n<data.length;n++){
  const blob=new Blob([Uint8Array.from(atob(data[n]),x=>x.charCodeAt(0))],{type:'image/png'});
  blobs.set('p'+n,blob);blobIds.set(blob,'p'+n);
}
function selectedShape(){return state.shapes.find(row=>row.id===selected)||null;}
const opened=[],removed=[],events=[],calls=[],created=[],revoked=[],liveURLs=new Set();
const nativeCreate=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=nativeCreate(blob);created.push({url,id:blobIds.get(blob)});liveURLs.add(url);return url;};
URL.revokeObjectURL=url=>{revoked.push(url);liveURLs.delete(url);nativeRevoke(url);};
function openPhotoViewer(id,name){opened.push({id,name});}
function removeSelectedPhoto(id){removed.push(id);}
let gate=null,flight=null,staleFlight=null,activeReads=0,maxActiveReads=0,clicks=0,original='';
function hold(id){let release;const promise=new Promise(resolve=>release=resolve);gate={id,promise,release,used:false};}
async function getPhotoBlob(id){
  calls.push(id);activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);
  const captured=gate;
  try{
    if(captured&&captured.id===id&&!captured.used){captured.used=true;await captured.promise;}
    if(!blobs.has(id))throw Error('Synthetic Blob missing');
    return blobs.get(id);
  }finally{activeReads--;}
}
function kind(target){
  const element=target?.nodeType===1?target:target?.parentElement;
  return element?.closest('#deleteBtn')?'delete':element?.closest('#photoGrid')?'photo':'other';
}
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click']){
  window.addEventListener(type,event=>{
    if(events.length<80)events.push({type,target:kind(event.target),trusted:event.isTrusted,
      point:[event.clientX,event.clientY].map(x=>Number.isFinite(x)?x:null)});
  },{capture:true,passive:true});
}
$('deleteBtn').disabled=false;
$('deleteBtn').onclick=()=>{clicks++;$('clickWitness').hidden=false;};
const metadata=[
  {id:'p6',name:'photo-6.png',createdAt:9000},
  {id:'p0',name:'photo-0.png'},
  {id:'p5',name:'photo-5.png',captureDisplayOrder:{at:1000,batch:'synthetic',index:2}},
  {id:'p2',name:'photo-2.png',createdAt:500},
  {id:'p4',name:'photo-4.png',captureDisplayOrder:{at:1000,batch:'synthetic',index:1}},
  {id:'p1',name:'photo-1.png'},
  {id:'p3',name:'photo-3.png',captureDisplayOrder:{at:1000,batch:'synthetic',index:0}}
];
function box(){const r=$('deleteBtn').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
function inspect(point){
  const grid=$('photoGrid'),thumb=grid.firstElementChild,style=thumb?getComputedStyle(thumb):null;
  return {slots:grid.children.length,declared:$('photoCount').textContent,rect:box(),
    titles:[...grid.children].map(el=>el.title),clicks,calls:calls.slice(),activeReads,maxActiveReads,
    renderSequence:photoRenderSeq,metadataUnchanged:JSON.stringify(state.shapes)===original,
    targetAtPoint:point?kind(document.elementFromPoint(point.x,point.y)):null,
    scroll:[scrollX,scrollY],events:events.slice(),liveURLs:liveURLs.size,
    gridDisplay:getComputedStyle(grid).display,columns:getComputedStyle(grid).gridTemplateColumns,
    aspectRatio:style?.aspectRatio||null};
}
async function digest(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function imageProof(){
  const result=[];
  for(const image of $('photoGrid').querySelectorAll('img')){
    const entry=created.find(row=>row.url===image.src);
    if(!entry)throw Error('Displayed image lacks an owned object URL');
    result.push({id:entry.id,sha256:await digest(blobs.get(entry.id)),loaded:image.complete&&image.naturalWidth===4&&image.naturalHeight===3});
  }
  return result;
}
window.photoGridProbe={
  start(){
    state.shapes=[{id:'layout-record',photos:structuredClone(metadata)}];selected='layout-record';
    original=JSON.stringify(state.shapes);hold('p0');flight=renderSelectedPhotos();
    flight.catch(()=>{});return inspect();
  },
  inspect,
  release(){gate?.release();},
  async finish(){await flight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},
  proof:imageProof,
  handlers(){return {opened:opened.slice(),removed:removed.slice(),metadataUnchanged:JSON.stringify(state.shapes)===original};},
  async staleStart(){
    state.shapes=[{id:'old-selection',photos:[{id:'p7',name:'old-7.png',createdAt:1},{id:'p8',name:'old-8.png',createdAt:2}]},
      {id:'new-selection',photos:[{id:'p10',name:'new-10.png',createdAt:20},{id:'p9',name:'new-9.png',createdAt:10}]}];
    original=JSON.stringify(state.shapes);calls.length=0;maxActiveReads=0;
    this.staleCreatedAt=created.length;hold('p7');selected='old-selection';
    staleFlight=renderSelectedPhotos();staleFlight.catch(()=>{});
    selected='new-selection';flight=renderSelectedPhotos();await flight;return inspect();
  },
  async staleFinish(){
    gate.release();await staleFlight;
    return {...inspect(),createdIds:created.slice(this.staleCreatedAt).map(row=>row.id)};
  },
  async clear(){
    selected=null;await renderSelectedPhotos();
    return {...inspect(),createdCount:created.length,revokedCount:revoked.length,
      everyURLRevoked:created.every(row=>revoked.includes(row.url))};
  }
};
"""


def assets(built_root):
    parts = [(built_root / 'sentlog' / f'part{index:02d}.txt').read_text() for index in range(1, 10)]
    joined, part = ''.join(parts), parts[5]
    index = (built_root / 'sentlog/index.html').read_text()
    assert part.count('// ' + MARKER + '\n') == 1, 'Assembled photo-grid correction missing'
    assert index.count("[5,'" + MARKER + "']") == 1, 'Loader must verify the modified part'
    historical = (ROOT / 'tests/fixtures/render_selected_photos_v205.js').read_bytes()
    assert hashlib.sha256(historical).hexdigest() == HISTORICAL_SHA256, 'Historical renderer changed'
    current = renderer(part).encode()
    assert current != historical, 'Current renderer equals the historical implementation'
    helper = re.search(r'^function revokePhotoThumbUrls\(\)\{[^\n]*\}\n', part, re.M)
    assert helper, 'Assembled object-URL cleanup helper missing'
    css = '\n'.join(re.findall(r'<style(?:\s[^>]*)?>(.*?)</style\s*>', joined, re.S | re.I)).encode()
    assert b'.photo-grid{' in css and b'aspect-ratio:4/3' in css, 'Actual photo-grid CSS missing'
    panel_start = joined.index('<div class="photo-panel">')
    delete_start = joined.index('<button id="deleteBtn"', panel_start)
    panel_end = joined.index('</button>', delete_start) + len('</button>')
    panel = joined[panel_start:panel_end]
    fixture = FIXTURE_JS.replace('__SYNTHETIC_PNG_DATA__', json.dumps([base64.b64encode(png(n)).decode() for n in range(11)]))
    resources = {
        '/app.css': ('text/css', css),
        '/photo-display-order.js': ('text/javascript', (built_root / 'sentlog/photo-display-order.js').read_bytes()),
        '/fixture.js': ('text/javascript', fixture.encode()),
    }
    for name, source in [('baseline', historical), ('current', current)]:
        resources['/render-' + name + '.js'] = ('text/javascript', helper.group().encode() + source)
        html = ('<!doctype html><html lang="ja"><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>Synthetic photo grid</title><link rel="stylesheet" href="/app.css">'
                '<body><main class="stack">' + panel + '</main>'
                '<div id="clickWitness" role="status" hidden>Native delete-button click received</div>'
                '<script src="/photo-display-order.js"></script><script src="/render-' + name + '.js"></script>'
                '<script src="/fixture.js"></script></body></html>')
        resources['/' + name + '.html'] = ('text/html', html.encode())
    return resources, {'historicalRendererSha256': HISTORICAL_SHA256,
                       'currentRendererSha256': hashlib.sha256(current).hexdigest(),
                       'assembledCssSha256': hashlib.sha256(css).hexdigest(),
                       'cssModifiedByFixture': False, 'historicalOriginHead': '994eba52a56d9eab7443757590701ef2dcf47c81'}


def serve(resources):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlparse(self.path).path
            if path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            if path not in resources:
                self.send_error(404)
                return
            content_type, body = resources[path]
            self.send_response(200)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob: data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def run_case(engine, origin, variant, folder, result):
    context = page = primary = None
    mouse_down = False
    errors, external = [], []
    with tempfile.TemporaryDirectory(prefix='sentlog-photo-grid-') as profile:
        try:
            result['operation'] = 'launch'
            context = engine.launch_persistent_context(profile, headless=True,
                viewport={'width': 820, 'height': 1000}, is_mobile=True, has_touch=True, service_workers='block')
            def route(request):
                parsed = urlparse(request.request.url)
                if parsed.scheme in ('blob', 'data') or request.request.url.startswith(origin + '/'):
                    request.continue_()
                else:
                    external.append(parsed.scheme + '://' + (parsed.hostname or ''))
                    request.abort()
            context.route('**/*', route)
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(10000)
            page.on('pageerror', lambda error: errors.append(str(error)[:240]))
            page.on('console', lambda message: errors.append(message.text[:240]) if message.type == 'error' else None)
            result['operation'] = 'load-real-renderer-and-css'
            page.goto(origin + '/' + variant + '.html', wait_until='load')
            result['operation'] = 'hold-first-blob'
            initial = page.evaluate('photoGridProbe.start()')
            result['initial'] = initial
            assert initial['declared'] == '7枚' and initial['calls'] == ['p0'], initial
            assert initial['gridDisplay'] == 'grid' and initial['aspectRatio'] == '4 / 3', initial
            assert len(initial['columns'].split()) == 3, initial
            assert initial['metadataUnchanged'], initial

            # No forced click, CSS alteration, scroll-anchor override or DOM
            # event dispatch. Use native input while one real render is held.
            page.locator('#deleteBtn').scroll_into_view_if_needed()
            box = page.locator('#deleteBtn').bounding_box()
            assert box and box['width'] > 0 and box['height'] > 0
            point = {'x': box['x'] + box['width'] / 2, 'y': box['y'] + box['height'] / 2}
            before = page.evaluate('point=>photoGridProbe.inspect(point)', point)
            assert before['targetAtPoint'] == 'delete', before
            result['operation'] = 'native-mouse-down'
            page.mouse.move(point['x'], point['y'])
            page.mouse.down()
            mouse_down = True
            down = page.evaluate('photoGridProbe.inspect()')
            assert any(e['type'] == 'mousedown' and e['target'] == 'delete' and e['trusted'] for e in down['events']), down
            result['operation'] = 'release-blob-between-down-and-up'
            page.evaluate('photoGridProbe.release()')
            page.evaluate('photoGridProbe.finish()')
            page.wait_for_function("[...document.querySelectorAll('#photoGrid img')].length===7&&[...document.querySelectorAll('#photoGrid img')].every(i=>i.complete&&i.naturalWidth===4&&i.naturalHeight===3)")
            after = page.evaluate('point=>photoGridProbe.inspect(point)', point)
            result['operation'] = 'native-mouse-up'
            page.mouse.up()
            mouse_down = False
            completed = page.evaluate('point=>photoGridProbe.inspect(point)', point)
            delta = max(abs(after['rect'][key] - before['rect'][key]) for key in before['rect'])
            result['gesture'] = {'point': point, 'before': before, 'after': after, 'completed': completed,
                                 'maximumRectDelta': delta, 'clickReceived': completed['clicks'] == 1,
                                 'reservedSlotInvariant': initial['slots'] == 7}
            assert completed['titles'] == EXPECTED_TITLES and completed['metadataUnchanged'], completed
            assert completed['calls'] == [f'p{n}' for n in range(7)] and completed['maxActiveReads'] == 1, completed
            proof = page.evaluate('photoGridProbe.proof()')
            assert [row['id'] for row in proof] == [f'p{n}' for n in range(7)]
            assert all(row['loaded'] and row['sha256'] == hashlib.sha256(png(n)).hexdigest() for n, row in enumerate(proof)), proof
            result['images'] = proof

            if variant == 'baseline':
                assert initial['slots'] == 1, 'Historical renderer must expose its one-slot first-await state'
                result['baselineInvariantFailureObserved'] = True
                # Browsers may preserve the click despite a moving layout.
                # Keep its actual rect/target/click result rather than force it.
            else:
                assert initial['slots'] == 7, 'Known photo rows were not reserved before the first Blob await'
                assert delta <= 0.5 and after['targetAtPoint'] == 'delete', result['gesture']
                assert completed['clicks'] == 1, result['gesture']
                result['operation'] = 'verify-existing-photo-handlers'
                page.locator('#photoGrid .photo-thumb').nth(1).click()
                page.locator('#photoGrid .photo-thumb').nth(2).locator('.photo-del').click()
                handlers = page.evaluate('photoGridProbe.handlers()')
                assert handlers == {'opened': [{'id': 'p1', 'name': 'photo-1.png'}], 'removed': ['p2'], 'metadataUnchanged': True}, handlers
                result['handlers'] = handlers
                result['operation'] = 'late-blob-after-selection-change'
                fresh = page.evaluate('photoGridProbe.staleStart()')
                assert fresh['titles'] == ['new-9.png', 'new-10.png'] and fresh['activeReads'] == 1, fresh
                late = page.evaluate('photoGridProbe.staleFinish()')
                assert late['titles'] == fresh['titles'] and late['metadataUnchanged'], late
                assert late['calls'] == ['p7', 'p9', 'p10'] and late['createdIds'] == ['p9', 'p10'], late
                assert late['liveURLs'] == 2 and late['activeReads'] == 0, late
                result['staleSelection'] = {'fresh': fresh, 'afterLateResponse': late}
            result['operation'] = 'object-url-cleanup'
            cleanup = page.evaluate('photoGridProbe.clear()')
            assert cleanup['slots'] == 0 and cleanup['liveURLs'] == 0 and cleanup['everyURLRevoked'], cleanup
            assert cleanup['createdCount'] == cleanup['revokedCount'] and cleanup['metadataUnchanged'], cleanup
            result['urlCleanup'] = {key: cleanup[key] for key in ('createdCount', 'revokedCount', 'everyURLRevoked')}
            assert not errors and not external, {'pageErrors': errors, 'externalRequests': external}
            result.update(status='passed', operation='complete', externalRequestCount=0, pageErrorCount=0)
        except Exception as error:
            primary = error
            result.update(status='BLOCKED' if result.get('operation') == 'launch' else 'failed',
                          errorType=type(error).__name__, error=(str(error).splitlines() or [''])[0][:350])
            if page:
                try:
                    result['failureState'] = page.evaluate('photoGridProbe.inspect()')
                except Exception as diagnostic:
                    result['diagnosticErrorType'] = type(diagnostic).__name__
        finally:
            if page:
                try:
                    page.evaluate('window.photoGridProbe?.release()')
                    if mouse_down:
                        page.mouse.up()
                except Exception as cleanup_error:
                    result.setdefault('cleanupErrors', []).append(type(cleanup_error).__name__)
                    if primary is None:
                        primary = cleanup_error
                        result.update(status='failed', operation='release-cleanup', errorType=type(cleanup_error).__name__)
            if context:
                try:
                    context.close()
                except Exception as cleanup_error:
                    result.setdefault('cleanupErrors', []).append(type(cleanup_error).__name__)
                    if primary is None:
                        primary = cleanup_error
                        result.update(status='failed', operation='context-close', errorType=type(cleanup_error).__name__)
        if primary:
            raise primary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'engine': args.engine, 'status': 'running', 'syntheticOnly': True,
              'scope': 'assembled-photo-renderer-and-CSS', 'heavySyncCauseProven': False, 'cases': []}
    server = thread = None
    exit_code = 0
    try:
        resources, sources = assets(args.built_root.resolve())
        report['sources'] = sources
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            report.update(status='BLOCKED', error='Native Playwright runtime unavailable')
            return 2
        server, thread = serve(resources)
        origin = f'http://127.0.0.1:{server.server_port}'
        with sync_playwright() as playwright:
            for variant in ('baseline', 'current'):
                result = {'variant': variant, 'status': 'running'}
                report['cases'].append(result)
                run_case(getattr(playwright, args.engine), origin, variant, args.report.parent, result)
        report['status'] = 'passed'
        print('PASS photo grid: historical unreserved rows observed; current native click, order and stale-selection protection verified')
    except Exception as error:
        blocked = bool(report['cases']) and report['cases'][-1].get('status') == 'BLOCKED'
        report.update(status='BLOCKED' if blocked else 'failed', errorType=type(error).__name__,
                      error=(str(error).splitlines() or [''])[0][:350])
        exit_code = 2 if blocked else 1
        print('PHOTO_GRID ' + report['status'] + ': ' + report['error'], file=sys.stderr)
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=5)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
