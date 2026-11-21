"""Compare complete-app field-record SVG rendering before/after width batching.

The reference block is copied from production 7c6efd79321e6552d21034b4ea4d30e137279495
and includes the historical DXF ownership builder. Only this renderer block is
replaced before module initialization in the reference browser context. Records,
fonts, DOM layout, event wiring and the rest of the built app remain real.
"""
import argparse
import base64
import functools
import hashlib
import json
import statistics
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]

REFERENCE = r"""  function drawRecordLabel(s,selectedNow){
    const label=recordLabel(s),pos=recordLabelLayout(s,z());
    const t=drawText(label,pos.x,pos.y,selectedNow,pos.anchor),fontSize=Math.max(11,14/z());
    let textWidth=0;try{textWidth=t.getComputedTextLength?.()||0;}catch(_){}
    if(!(textWidth>0))textWidth=Math.max(fontSize,label.length*fontSize*.7);
    const left=pos.anchor==='end'?pos.x-textWidth:pos.anchor==='start'?pos.x:pos.x-textWidth/2;
    // A fine leader ends at the label edge instead of crossing its text.
    if(s.labelPos){
      const from=recordLeaderOrigin(s),pad=3/z();
      const x=Math.max(left-pad,Math.min(left+textWidth+pad,from.x));
      const y=Math.max(pos.y-fontSize*.62-pad,Math.min(pos.y+fontSize*.62+pad,from.y));
      const dx=x-from.x,dy=y-from.y,d=Math.hypot(dx,dy);
      if(d*z()>12){
        const radius=s.recordType==='photo'?PHOTO_CIRCLE_RADIUS:s.displayKind==='arrow'?1:SURVEY_POINT_RADIUS;
        const off=Math.min(radius/z(),d*.3);
        const line=svgEl('line',{x1:from.x+dx/d*off,y1:from.y+dy/d*off,
          x2:x,y2:y,stroke:selectedNow?'#2563eb':'#374151',
          'stroke-width':.8/z(),'stroke-linecap':'round','pointer-events':'none'});
        line.dataset.fieldRecordLeaderId=s.id;svg.insertBefore(line,t);
      }
    }
    if(tool==='pan'){
      const coarse=(typeof matchMedia==='function'&&matchMedia('(any-pointer:coarse)').matches)||navigator.maxTouchPoints>0;
      const w=Math.max(textWidth+12/z(),(coarse?44:26)/z()),h=Math.max(fontSize+12/z(),(coarse?44:26)/z());
      const hit=svgEl('rect',{x:left+textWidth/2-w/2,y:pos.y-h/2,width:w,height:h,
        rx:5/z(),ry:5/z(),fill:'rgba(0,0,0,.001)','pointer-events':'all'});
      bindRecordLabelHit(hit,s.id);svg.appendChild(hit);
    }
  }
  function drawPhotoRecord(s){
    const p=normPoint(s.point||s.points?.[0]),end=photoEnd(p,s.angle,z()),selectedNow=s.id===selected||recordMove?.id===s.id;
    const color=selectedNow?'#2563eb':'#111827',r=PHOTO_CIRCLE_RADIUS/z(),head=8/z(),wing=5/z();
    const ux=Math.cos(s.angle||0),uy=Math.sin(s.angle||0),px=-uy,py=ux;
    const start={x:p.x+ux*(r+2/z()),y:p.y+uy*(r+2/z())};
    const neck={x:end.x-ux*head,y:end.y-uy*head};
    const line=svgEl('line',{x1:start.x,y1:start.y,x2:neck.x,y2:neck.y,stroke:color,'stroke-width':1.7/z(),'stroke-linecap':'round'});
    const tri=svgEl('polygon',{points:`${end.x},${end.y} ${neck.x+px*wing},${neck.y+py*wing} ${neck.x-px*wing},${neck.y-py*wing}`,fill:color});
    const circle=svgEl('circle',{cx:p.x,cy:p.y,r,fill:'#fff',stroke:color,'stroke-width':1.8/z()});
    for(const e of [line,tri,circle]){e.style.pointerEvents='none';svg.appendChild(e);}
    if(tool==='pan'){
      const hit=svgEl('line',{x1:p.x,y1:p.y,x2:end.x,y2:end.y,stroke:'rgba(0,0,0,.001)','stroke-width':24/z(),'pointer-events':'stroke'});
      bindRecordHit(hit,s.id);svg.appendChild(hit);
      const dotHit=svgEl('circle',{cx:p.x,cy:p.y,r:14/z(),fill:'rgba(0,0,0,.001)','pointer-events':'all'});
      bindRecordHit(dotHit,s.id);svg.appendChild(dotHit);
    }
    // The text has its own event target. Keep that above the broader marker
    // hit zones so the user can grab the actual letters near a camera circle.
    drawRecordLabel(s,selectedNow);
  }
  function drawSurveyPoint(s){
    const p=surveyPointFrom(s),selectedNow=s.id===selected||recordMove?.id===s.id,color=selectedNow?'#2563eb':'#334155',r=SURVEY_POINT_RADIUS/z();
    const outer=svgEl('circle',{cx:p.x,cy:p.y,r,fill:'#fff',stroke:color,'stroke-width':2.2/z()});
    const inner=svgEl('circle',{cx:p.x,cy:p.y,r:r*.35,fill:color,stroke:'none'});outer.style.pointerEvents=inner.style.pointerEvents='none';svg.append(outer,inner);
    if(tool==='pan'){
      const hit=svgEl('circle',{cx:p.x,cy:p.y,r:16/z(),fill:'rgba(0,0,0,.001)','pointer-events':'all'});bindRecordHit(hit,s.id);svg.appendChild(hit);
    }
    drawRecordLabel(s,selectedNow);
  }
  function drawSurveyArrow(s){
    const tail=normPoint(s.points?.[0]),tip=normPoint(s.points?.[1]),poly=surveyArrowPolygon(tail,tip,z());if(!poly.length)return;
    const selectedNow=s.id===selected||recordMove?.id===s.id,color=selectedNow?'#2563eb':'#334155';
    const arrow=svgEl('polygon',{points:poly.map(p=>p.x+','+p.y).join(' '),fill:'#fff',stroke:color,'stroke-width':2.4/z(),'stroke-linejoin':'round'});
    arrow.style.pointerEvents='none';svg.appendChild(arrow);
    if(tool==='pan'){
      const hit=svgEl('line',{x1:tail.x,y1:tail.y,x2:tip.x,y2:tip.y,stroke:'rgba(0,0,0,.001)','stroke-width':30/z(),'pointer-events':'stroke'});bindRecordHit(hit,s.id);svg.appendChild(hit);
    }
    // On outlined arrows the name starts near the shaft. Give its text hit
    // target priority while leaving the rest of the arrow draggable by hold.
    drawRecordLabel(s,selectedNow);
  }
  function drawRecords(records){
    for(const s of records){
      if((s.page||1)!==state.currentPage)continue;
      const last=svg.lastElementChild;
      if(s.recordType==='photo')drawPhotoRecord(s);
      else if(s.displayKind==='arrow')drawSurveyArrow(s);
      else drawSurveyPoint(s);
      for(let e=last?last.nextElementSibling:svg.firstElementChild;e;e=e.nextElementSibling)e.dataset.dxfFieldRecordId=s.id;
    }
  }

"""

FIXTURES = r"""async config=>{
  const point=(id,n,x,y,extra={})=>({id,page:1,kind:'field-record',recordKind:'field-record',
    recordType:'survey',type:'調査',displayKind:'point',recordNo:n,typeNo:n,globalNo:n,
    autoLabel:'調査-'+n,point:{x,y},points:[{x,y},{x,y}],photos:[],memo:'合成描画検証',...extra});
  const photo=(id,n,x,y,angle,extra={})=>point(id,n,x,y,{recordType:'photo',type:'全景',angle,...extra});
  const arrow=(id,n,x,y,extra={})=>point(id,n,x,y,{displayKind:'arrow',points:[{x,y},{x:x+140,y:y+25}],...extra});
  const shapes=config.large?Array.from({length:2000},(_,i)=>point('large-'+i,i+1,50+(i%20)*50,50+Math.floor(i/20)*30)):
    [point('point',12,120,160),photo('photo-right',7,420,160,0),photo('photo-left',123456789012,720,160,Math.PI),
     photo('photo-up',55,100,430,-Math.PI/2),arrow('arrow',31,350,430),
     point('moved-point',9876543210,180,640,{labelPos:{x:310,y:590,anchor:'start'}}),
     photo('moved-photo',9876543210,650,430,Math.PI/4,{labelPos:{x:820,y:490,anchor:'end'}}),
     arrow('moved-arrow',999,620,640,{labelPos:{x:820,y:660,anchor:'middle'}}),
     point('other-page',404,30,30,{page:2})];
  state.shapes=shapes.map(shape=>SentlogRecordCollaboration.upgrade(shape));
  state.currentPage=1;selected=config.large?'large-0':config.selected;tool=config.tool||'pan';
  SentlogRecords.setItem(drawingStorageKey(activeDrawingId),JSON.stringify(state));
  await SentlogRecords.settled();
  scale=config.zoom;tx=25;ty=25;applyTransform();render();
  await document.fonts.ready;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return {visible:shapes.filter(s=>s.page===1).length,records:state.shapes.length,
    coarse:matchMedia('(any-pointer:coarse)').matches||navigator.maxTouchPoints>0};
}"""

PROBE = r"""()=>{
  if(window.fieldRenderProbe)throw Error('Render probe installed twice');
  const host=document.getElementById('svg'),observer=new MutationObserver(()=>{});
  observer.observe(host,{attributes:true,childList:true,subtree:true,characterData:true});
  let active=null,zeroText=null;
  const prototype=SVGTextContentElement.prototype,native=prototype.getComputedTextLength;
  prototype.getComputedTextLength=function(...args){
    if(!active||!host.contains(this))return native.apply(this,args);
    const writes=observer.takeRecords();if(active.calls&&writes.length)active.interleavedWriteBatches++;
    active.observedWrites+=writes.length;active.calls++;
    if(zeroText!==null&&this.textContent===zeroText){active.zeroFallbacks++;return 0;}
    const at=performance.now();
    try{return native.apply(this,args);}finally{active.nativeTextMs+=performance.now()-at;}
  };
  const normalize=value=>Number.isFinite(value)?Math.round(value*1e6)/1e6:value;
  const snapshot=()=>[...host.children].map(node=>{
    const attributes=Object.fromEntries([...node.attributes].map(a=>[a.name,a.value]).sort(([a],[b])=>a.localeCompare(b)));
    const box=node.getBBox?.();
    return {tag:node.localName,attributes,text:node.textContent,
      box:box?{x:normalize(box.x),y:normalize(box.y),width:normalize(box.width),height:normalize(box.height)}:null};
  });
  window.fieldRenderProbe={
    measure(fallbackText=null){
      zeroText=fallbackText;observer.takeRecords();
      active={calls:0,nativeTextMs:0,interleavedWriteBatches:0,observedWrites:0,zeroFallbacks:0};
      const at=performance.now();
      try{render();active.renderMs=performance.now()-at;return {...active};}
      finally{active=null;zeroText=null;}
    },
    snapshot,
    records:()=>JSON.stringify(state.shapes)
  };
}"""


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def drag_labels(page):
    """Use real hit testing/pointer capture and check label-only edits and undo."""
    snapshot = """()=>state.shapes.map(s=>({id:s.id,page:s.page,recordType:s.recordType,
      displayKind:s.displayKind,angle:s.angle??null,point:s.point??null,points:s.points??null,
      labelPos:s.labelPos??null,photos:s.photos,memo:s.memo}))"""
    observations = []
    for record_id in ('point', 'moved-photo', 'moved-arrow'):
        page.evaluate(FIXTURES, dict(zoom=.7, selected=record_id))
        page.evaluate("$('inspector').classList.remove('open');clearAllHistory()")
        before = page.evaluate(snapshot)
        origin = page.evaluate("id=>SentlogFieldRecords.recordLabelLayout(state.shapes.find(s=>s.id===id),scale)", record_id)
        hit = page.locator('[data-field-record-label-id="'+record_id+'"]')
        box = hit.bounding_box()
        assert box, ('Missing native label hit box', record_id)
        x, y = box['x']+box['width']/2, box['y']+box['height']/2
        assert page.evaluate("p=>document.elementFromPoint(p.x,p.y)?.dataset.fieldRecordLabelId", dict(x=x, y=y)) == record_id
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x+49, y+28, steps=5)
        page.mouse.up()
        page.evaluate('SentlogRecords.settled()')
        after = page.evaluate(snapshot)
        target = next(s for s in after if s['id'] == record_id)
        initial = next(s for s in before if s['id'] == record_id)
        assert target['labelPos'], ('Label drag did not commit', record_id)
        assert abs(target['labelPos']['x']-origin['x']-70) < 1, (record_id, origin, target)
        assert abs(target['labelPos']['y']-origin['y']-40) < 1, (record_id, origin, target)
        assert target['labelPos']['anchor'] == origin['anchor']
        assert {k:v for k,v in target.items() if k != 'labelPos'} == {k:v for k,v in initial.items() if k != 'labelPos'}
        assert [s for s in after if s['id'] != record_id] == [s for s in before if s['id'] != record_id]
        assert page.locator('[data-field-record-leader-id="'+record_id+'"]').count() == 1
        saved = page.evaluate("id=>JSON.parse(SentlogRecords.getItem(drawingStorageKey(activeDrawingId))).shapes.find(s=>s.id===id).labelPos", record_id)
        assert saved == target['labelPos'], ('Label edit was not persisted', record_id)
        assert page.evaluate('historyFor().undo.length') == 1, 'One drag must create one undo entry'
        page.evaluate('undo()')
        assert page.evaluate(snapshot) == before, ('Undo changed record geometry or order', record_id)
        observations.append(dict(record=record_id, labelPos=target['labelPos'], undoRestored=True))
    return observations


def compare(engine, root, report):
    candidate = (root/'sentlog/field-records.js').read_text(encoding='utf-8')
    start = candidate.index('  function drawRecordLabel(')
    end = candidate.index('  function renderRecordPreview()', start)
    assert 'const widths=labels.map(recordLabelWidth);' in candidate[start:end]
    assert 'dxfFieldRecordId=s.id' in candidate[start:end], 'Test requires the complete production DXF build'
    old_source = candidate[:start]+REFERENCE+candidate[end:]
    cases = [
        dict(name='zoom-'+str(zoom)+'-'+selected, zoom=zoom, selected=selected)
        for zoom in (.35, 1, 3) for selected in ('point', 'moved-photo')
    ] + [dict(name='drawing-tool', zoom=1, selected='arrow', tool='field-survey-point'),
         dict(name='measurement-fallback', zoom=1, selected='moved-arrow', fallback='調査-999')]
    results = {}
    errors = []
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, engine).launch(headless=True)
            try:
                for coarse in (False, True):
                    # Alternate order between pointer types to avoid always
                    # giving one implementation the first warmed layout run.
                    versions = ('reference', 'candidate') if not coarse else ('candidate', 'reference')
                    for version in versions:
                        context = browser.new_context(viewport={'width': 1200, 'height': 900}, has_touch=coarse,
                                                      is_mobile=coarse, service_workers='block')
                        try:
                            def route(request):
                                url = request.request.url
                                if urlparse(url).path.endswith('/field-records.js') and version == 'reference':
                                    request.fulfill(content_type='text/javascript', body=old_source)
                                elif url.startswith((origin+'/', 'blob:', 'data:')):
                                    request.continue_()
                                elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                                    request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                                else:
                                    request.abort()
                            context.route('**/*', route)
                            page = context.new_page()
                            page.on('pageerror', lambda error: errors.append(str(error)))
                            page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                            page.wait_for_function('window.sentlogAppReady&&window.SentlogFieldRecords&&window.SentlogRecordCollaboration', timeout=60000)
                            page.evaluate('window.sentlogAppReady')
                            page.evaluate(SETUP, base64.b64encode(photo_png()).decode('ascii'))
                            page.evaluate(PROBE)
                            observations = {}
                            for case in cases:
                                setup = page.evaluate(FIXTURES, case)
                                assert setup['coarse'] == coarse, (coarse, setup)
                                before = page.evaluate('fieldRenderProbe.records()')
                                timing = page.evaluate('text=>fieldRenderProbe.measure(text)', case.get('fallback'))
                                snapshot = page.evaluate('fieldRenderProbe.snapshot()')
                                assert page.evaluate('fieldRenderProbe.records()') == before, 'Rendering mutated records'
                                assert timing['calls'] == setup['visible'] == 8, timing
                                assert timing['zeroFallbacks'] == (1 if case.get('fallback') else 0), timing
                                if version == 'candidate':
                                    assert timing['interleavedWriteBatches'] == 0, timing
                                else:
                                    assert timing['interleavedWriteBatches'] == 7, timing
                                owned = [node for node in snapshot if node['attributes'].get('data-dxf-field-record-id')]
                                assert len(owned) == len(snapshot), ('Every rendered record node needs DXF ownership', snapshot)
                                labels = [node for node in snapshot if node['tag'] == 'text']
                                hits = [node for node in snapshot if node['attributes'].get('data-field-record-label-id')]
                                assert len(labels) == 8 and len(hits) == (8 if case.get('tool', 'pan') == 'pan' else 0)
                                for node in hits:
                                    owner = node['attributes']['data-field-record-label-id']
                                    assert node['attributes']['data-dxf-field-record-id'] == owner
                                    index = snapshot.index(node)
                                    assert snapshot[index-1]['tag'] == 'text', 'Label hit order changed'
                                    assert snapshot[index-1]['attributes']['data-dxf-field-record-id'] == owner
                                for node in snapshot:
                                    leader = node['attributes'].get('data-field-record-leader-id')
                                    if leader:
                                        assert node['attributes']['data-dxf-field-record-id'] == leader
                                        index = snapshot.index(node)
                                        assert snapshot[index+1]['tag'] == 'text', 'Leader order changed'
                                observations[case['name']] = dict(snapshot=snapshot, timing=timing)
                            setup = page.evaluate(FIXTURES, dict(large=True, zoom=1, selected='large-0'))
                            assert setup['visible'] == 2000
                            before = page.evaluate('fieldRenderProbe.records()')
                            timings = [page.evaluate('fieldRenderProbe.measure()') for _ in range(3)]
                            large = page.evaluate('fieldRenderProbe.snapshot()')
                            assert page.evaluate('fieldRenderProbe.records()') == before
                            assert sum(node['tag'] == 'text' for node in large) == 2000
                            assert sum(bool(node['attributes'].get('data-field-record-label-id')) for node in large) == 2000
                            assert all(t['calls'] == 2000 for t in timings), timings
                            assert all(t['interleavedWriteBatches'] == (0 if version == 'candidate' else 1999) for t in timings), timings
                            drags = drag_labels(page)
                            results[(coarse, version)] = dict(cases=observations, large=large, timings=timings, drags=drags)
                            print('FIELD_RENDER_PROGRESS '+json.dumps(dict(engine=engine, coarse=coarse, version=version,
                                records=2000, medianRenderMs=statistics.median(t['renderMs'] for t in timings),
                                medianNativeTextMs=statistics.median(t['nativeTextMs'] for t in timings))), flush=True)
                        finally:
                            context.close()
                comparisons = []
                for coarse in (False, True):
                    before = results[(coarse, 'reference')]
                    after = results[(coarse, 'candidate')]
                    for case in cases:
                        a, b = before['cases'][case['name']]['snapshot'], after['cases'][case['name']]['snapshot']
                        assert a == b, dict(case=case['name'], coarse=coarse,
                            firstDifference=next(((i,x,y) for i,(x,y) in enumerate(zip(a,b)) if x != y), None),
                            beforeCount=len(a), afterCount=len(b))
                    assert before['large'] == after['large'], '2000-record SVG output changed'
                    assert before['drags'] == after['drags'], 'Native label dragging changed'
                    comparison = dict(coarse=coarse, equivalentCases=len(cases), nodes=len(after['large']),
                        svgSha256=fingerprint(after['large']), records=2000,
                        reference=before['timings'], candidate=after['timings'], drags=after['drags'])
                    comparisons.append(comparison)
                assert not errors, errors
                report.update(passed=True, comparisons=comparisons)
            finally:
                browser.close()
    finally:
        server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), required=True)
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = dict(engine=args.engine, referenceCommit='7c6efd79321e6552d21034b4ea4d30e137279495',
                  scope='Same built application and browser; historical field-label loop vs native measurement batching. Full SVG attributes/order/text/world geometry compared. Timing is diagnostic; deterministic gate forbids writes between text-width reads.')
    try:
        compare(args.engine, args.built_root.resolve(), report)
    except Exception as error:
        report.update(passed=False, error=str(error))
        raise
    finally:
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS '+args.engine+': 16 pointer/zoom/selection/fallback cases and two 2000-record cases retain exact SVG, '
          'label/leader/hit geometry and DXF ownership; point/photo/arrow labels drag and undo correctly; '
          'native widths are read without intervening DOM writes', flush=True)


if __name__ == '__main__':
    main()
