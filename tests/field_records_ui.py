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
const svg=$('svg');let tool='pan',drawing=null,polygonDraftCursor=null,polygonTouch=null,gestureLock=false,scale=1,selected=null,currentView='editor',activeDrawingId='d1';
let historyCount=0,persistCount=0,cameraClicks=0;const histories={1:{undo:[],redo:[]}};
let state={sourceType:'image',currentPage:1,shapes:[{id:'d1',page:1,kind:'line',type:'ひび割れ',typeNo:1,autoLabel:'ひび割れ-1',points:[{x:20,y:20},{x:80,y:80}],photos:[]}]};
function point(e){const r=$('stageWrap').getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
function pushHistory(){historyCount++}function persist(){persistCount++}function historyFor(){return histories[1]}function snapshotPage(){return JSON.parse(JSON.stringify(state.shapes))}function updateHistoryButtons(){}
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

    assert page.locator('[data-field-record-tool="record"]').count()==1

    page.locator('[data-field-record-tool="record"]').click()
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

    # Exit record-creation mode. Pressing the survey arrow must not open details immediately;
    # a 500ms hold followed by drag moves the whole record.
    page.locator('[data-field-record-tool="record"]').click()
    assert page.evaluate("tool")=='pan'
    page.evaluate("selectShape('d1');document.getElementById('inspector').classList.remove('open')")
    assert page.locator('#fieldRecordPanel').is_hidden()
    survey_before=page.evaluate("state.shapes.find(x=>x.recordType==='survey').points.map(p=>({...p}))")
    sx=(survey_before[0]['x']+survey_before[1]['x'])/2
    sy=(survey_before[0]['y']+survey_before[1]['y'])/2
    page.mouse.move(box['x']+sx,box['y']+sy)
    page.mouse.down()
    page.wait_for_timeout(220)
    assert page.locator('#fieldRecordPanel').is_hidden(),'details opened on pointer-down instead of tap'
    assert page.evaluate("selected")=='d1'
    page.wait_for_timeout(340)
    page.mouse.move(box['x']+sx+24,box['y']+sy+18,steps=4)
    page.mouse.up()
    survey_moved=page.evaluate("state.shapes.find(x=>x.recordType==='survey').points")
    assert abs(survey_moved[0]['x']-survey_before[0]['x']-24)<1.5 and abs(survey_moved[0]['y']-survey_before[0]['y']-18)<1.5,(survey_before,survey_moved)
    assert abs(survey_moved[1]['x']-survey_before[1]['x']-24)<1.5 and abs(survey_moved[1]['y']-survey_before[1]['y']-18)<1.5,(survey_before,survey_moved)
    assert page.locator('#fieldRecordPanel').is_hidden(),'long-press move should not raise details'
    assert page.evaluate("histories[1].undo.length")>=1

    # A quick completed tap, by contrast, opens the record details.
    sx2=(survey_moved[0]['x']+survey_moved[1]['x'])/2
    sy2=(survey_moved[0]['y']+survey_moved[1]['y'])/2
    page.mouse.click(box['x']+sx2,box['y']+sy2)
    assert page.evaluate("selected")==survey['id']
    assert page.locator('#fieldRecordPanel').is_visible()
    assert 'open' in (page.locator('#inspector').get_attribute('class') or '')

    page.locator('#frSurveyDisplay').select_option('point')
    survey2=page.evaluate("state.shapes.find(x=>x.recordType==='survey')")
    assert survey2['displayKind']=='point',survey2
    assert page.locator('#svg circle').count()>=2

    # We are back in pan mode, so one press opens the record chooser.
    page.locator('[data-field-record-tool="record"]').click()
    assert page.locator('#fieldRecordModeModal').evaluate("e=>e.classList.contains('open')")
    page.locator('#fieldRecordModeModal [data-mode="photo"]').click()
    page.mouse.move(box['x']+360,box['y']+240)
    page.mouse.down()
    page.mouse.move(box['x']+470,box['y']+190,steps=4)
    page.mouse.up()
    photo=page.evaluate("state.shapes.find(x=>x.recordType==='photo')")
    assert photo and photo['autoLabel']=='全景-1',photo
    assert page.evaluate("cameraClicks")==1
    assert page.locator('#frRecordTitle').inner_text()=='全景-1'
    assert '○が撮影位置' in page.locator('#frPhotoHelp').inner_text()
    label=page.evaluate("""()=>{
      const e=[...document.querySelectorAll('#svg text')].find(x=>x.textContent==='全景-1');
      return e?{x:Number(e.getAttribute('x')),y:Number(e.getAttribute('y'))}:null;
    }""")
    assert label and label['x']<photo['point']['x'] and label['y']>photo['point']['y'],(photo,label)
    assert ((label['x']-photo['point']['x'])**2+(label['y']-photo['point']['y'])**2)**0.5 < 15,(photo,label)

    # The overview-photo marker uses the same tap-vs-hold behavior and moves as one unit.
    page.locator('[data-field-record-tool="record"]').click()
    assert page.evaluate("tool")=='pan'
    page.evaluate("selectShape('d1');document.getElementById('inspector').classList.remove('open')")
    photo_before=page.evaluate("({...state.shapes.find(x=>x.recordType==='photo').point})")
    page.mouse.move(box['x']+photo_before['x'],box['y']+photo_before['y'])
    page.mouse.down()
    page.wait_for_timeout(220)
    assert page.locator('#fieldRecordPanel').is_hidden()
    page.wait_for_timeout(340)
    page.mouse.move(box['x']+photo_before['x']+36,box['y']+photo_before['y']+22,steps=4)
    page.mouse.up()
    photo_after=page.evaluate("state.shapes.find(x=>x.recordType==='photo')")
    assert abs(photo_after['point']['x']-photo_before['x']-36)<1.5 and abs(photo_after['point']['y']-photo_before['y']-22)<1.5,(photo_before,photo_after)
    assert page.locator('#fieldRecordPanel').is_hidden()

    # Quick tap after moving opens details at the new location.
    page.mouse.click(box['x']+photo_after['point']['x'],box['y']+photo_after['point']['y'])
    assert page.evaluate("selected")==photo_after['id']
    assert page.locator('#fieldRecordPanel').is_visible()

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
    print('PASS field-record UI: tap opens details only on release; 500ms hold-drag moves survey/photo records; photo label stays close and opposite')
