"""Browser check for Sentlog v1.64 field photo/survey records. Synthetic drawing only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
BASE='''<!doctype html><html lang="ja"><meta charset="UTF-8"><style>
body{font:14px system-ui;margin:0}.toolbar{display:flex;gap:5px;padding:8px}.toolbar button.active{outline:2px solid #2563eb}
#stageWrap{position:relative;width:600px;height:360px;border:1px solid #bbb;margin:8px;touch-action:none}#svg{width:600px;height:360px}
#inspector{width:340px;padding:8px}.stack>div{margin:6px 0}.row{display:flex;gap:5px}.photo-panel{border-top:1px solid #ddd;padding-top:8px}
</style><body>
<div class="toolbar"><button data-tool="line">線</button><button id="undoBtn">戻す</button><button id="redoBtn">進む</button></div>
<div id="stageWrap"><svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
<aside id="inspector"><div class="section-title">選択中の変状</div><div class="stack">
  <div id="damageHost"><label>材料</label><select id="damageMaterial"><option value="concrete">コンクリート</option></select><select id="damageType"><option>ひび割れ</option></select></div>
  <div class="row"><input id="globalNo"><input id="typeNo"></div>
  <div><input id="member"></div><div><select id="lineWidth"><option value="1.2">細</option></select></div>
  <div><div id="measureResult"></div></div><div><textarea id="memo"></textarea></div>
  <div class="photo-panel"><span id="photoCount">0枚</span><button id="cameraBtn">写真を撮る</button><button id="photoAddBtn">追加</button><input id="cameraInput" type="file" hidden><input id="photoInput" type="file" hidden><div id="photoGrid"></div><div id="photoEmpty"></div><div id="photoStatus"></div></div>
  <button id="applyBtn">反映</button><button id="deleteBtn">選択変状を削除</button>
</div></aside>
<script>
const $=id=>document.getElementById(id);
const svg=$('svg');let tool='pan',drawing=null,polygonDraftCursor=null,polygonTouch=null,gestureLock=false,scale=1,selected=null,currentView='editor';
let historyCount=0,persistCount=0,cameraClicks=0;
let state={sourceType:'image',currentPage:1,shapes:[{id:'d1',page:1,kind:'line',type:'ひび割れ',typeNo:1,autoLabel:'ひび割れ-1',points:[{x:20,y:20},{x:80,y:80}],photos:[]}]};
function point(e){const r=$('stageWrap').getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function pushHistory(){historyCount++}function persist(){persistCount++}
function rebuildNumberingState(){const seen={};for(const s of state.shapes){seen[s.type]=(seen[s.type]||0)+1;s.typeNo=seen[s.type];s.autoLabel=s.type+'-'+s.typeNo}}
function currentShapes(){return state.shapes.filter(s=>(s.page||1)===state.currentPage)}
function render(){svg.innerHTML='';for(const s of currentShapes()){if(s.kind==='line'){const l=document.createElementNS('http://www.w3.org/2000/svg','line');l.setAttribute('x1',s.points[0].x);l.setAttribute('y1',s.points[0].y);l.setAttribute('x2',s.points[1].x);l.setAttribute('y2',s.points[1].y);l.setAttribute('stroke','#b91c1c');svg.appendChild(l)}}}
function renderSelectedPhotos(){const s=state.shapes.find(x=>x.id===selected);$('cameraBtn').disabled=!s;$('photoAddBtn').disabled=!s}
function updateMeasureResult(){}
function selectShape(id){selected=id;render();renderSelectedPhotos()}
$('deleteBtn').onclick=()=>{if(!selected)return;state.shapes=state.shapes.filter(x=>x.id!==selected);selected=null;rebuildNumberingState();render();renderSelectedPhotos();persist()}
$('cameraInput').click=()=>{cameraClicks++};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{tool=b.dataset.tool;document.querySelectorAll('[data-tool]').forEach(x=>x.classList.remove('active'));b.classList.add('active');render()});
render();
</script></body></html>'''

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    page=browser.new_page(viewport={'width':760,'height':900})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.on('dialog',lambda d: d.dismiss())
    page.route('https://sentlog.test/',lambda route: route.fulfill(status=200,content_type='text/html',body=BASE))
    page.goto('https://sentlog.test/')
    page.add_script_tag(content=(ROOT/'sentlog/field-records.js').read_text(encoding='utf-8'))

    assert page.locator('[data-field-record-tool="photo"]').count()==1
    assert page.locator('[data-field-record-tool="survey"]').count()==1

    page.locator('[data-field-record-tool="survey"]').click()
    assert page.locator('#fieldRecordModeModal').evaluate("e=>e.classList.contains('open')")
    page.locator('#fieldRecordModeModal [data-mode="arrow"]').click()
    assert page.evaluate("tool")=='field-survey-arrow'

    box=page.locator('#stageWrap').bounding_box()
    page.mouse.move(box['x']+120,box['y']+140)
    page.mouse.down()
    page.mouse.move(box['x']+280,box['y']+170,steps=5)
    page.mouse.up()
    survey=page.evaluate("state.shapes.find(x=>x.recordType==='survey')")
    assert survey and survey['displayKind']=='arrow',survey
    assert survey['autoLabel']=='調査-1',survey
    assert page.locator('#fieldRecordPanel').is_visible()
    assert page.locator('#frRecordTitle').inner_text()=='調査-1'
    arrow=page.locator('#svg polygon[fill="#fff"]').first
    assert arrow.count()==1
    assert arrow.get_attribute('stroke') in ('#334155','#2563eb')

    page.locator('#frSurveyChecks label',has_text='鉄筋探査').locator('input').check()
    page.locator('#frSurveyChecks label',has_text='中性化').locator('input').check()
    chosen=page.evaluate("state.shapes.find(x=>x.recordType==='survey').surveyItems")
    assert chosen==['鉄筋探査','中性化'],chosen

    page.locator('#frSurveyDisplay').select_option('point')
    survey2=page.evaluate("state.shapes.find(x=>x.recordType==='survey')")
    assert survey2['displayKind']=='point',survey2
    assert page.locator('#svg circle').count()>=2

    page.locator('[data-field-record-tool="photo"]').click()
    page.mouse.move(box['x']+360,box['y']+240)
    page.mouse.down()
    page.mouse.move(box['x']+470,box['y']+190,steps=4)
    page.mouse.up()
    photo=page.evaluate("state.shapes.find(x=>x.recordType==='photo')")
    assert photo and photo['autoLabel']=='全景-1',photo
    assert page.evaluate("cameraClicks")==1
    assert page.locator('#frRecordTitle').inner_text()=='全景-1'
    assert '○が撮影位置' in page.locator('#frPhotoHelp').inner_text()

    # Normal damage selection restores the normal inspector.
    page.evaluate("selectShape('d1')")
    assert page.locator('#fieldRecordPanel').is_hidden()
    assert page.locator('#damageHost').is_visible()

    result=page.evaluate("()=>({historyCount,persistCount,records:state.shapes.filter(x=>x.recordKind==='field-record').length})")
    assert result['records']==2 and result['historyCount']>=5 and result['persistCount']>=4,result
    assert not errors,errors
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/field-records-ui.png'),full_page=True)
    browser.close()
    print('PASS field-record UI: grouped survey arrow/point, multi-content selection, fixed-direction overview photo and camera handoff')
