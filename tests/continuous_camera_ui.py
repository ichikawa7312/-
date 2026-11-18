"""Continuous-camera regression against the built app and synthetic records.

Only camera hardware is mocked. Original/shared image conversion, record
storage, photo journaling, incoming collaboration and the camera UI are real.
Linux WebKit uses the same Blob transport fixture as collaboration_photos_ui.
All external network requests are blocked; no user records are involved.
"""
import argparse
import base64
import functools
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from collaboration_photos_ui import HOLD_CONVERSION, WEBKIT_TRANSPORT, release, wait_photos
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]


CAMERA_MOCK = r"""encoded=>{
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const mock=window.cameraMock={calls:0,photos:0,canvasPhotos:0,stopped:0,deny:false,tracks:[],constraints:[]};
  const image=new Image();image.src='data:image/png;base64,'+encoded;mock.imageReady=image.decode();
  const active=new WeakMap();
  const originalSrc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{
    configurable:true,get(){return active.has(this)?active.get(this):originalSrc.get.call(this);},
    set(value){
      if(value?.sentlogCameraFixture){
        active.set(this,value);
        for(const [key,val] of [['videoWidth',1280],['videoHeight',960],['readyState',4]])
          Object.defineProperty(this,key,{configurable:true,get:()=>val});
        queueMicrotask(()=>{
          this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('canplay'));
        });
      }else{
        if(active.has(this)){
          active.delete(this);
          for(const key of ['videoWidth','videoHeight','readyState'])delete this[key];
        }
        originalSrc.set.call(this,value);
      }
    }
  });
  const play=HTMLMediaElement.prototype.play,pause=HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play=function(){
    if(active.has(this)){this.dispatchEvent(new Event('playing'));return Promise.resolve();}
    return play.apply(this,arguments);
  };
  HTMLMediaElement.prototype.pause=function(){if(!active.has(this))return pause.apply(this,arguments);};
  const drawImage=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
    if(active.has(source)){mock.canvasPhotos++;return drawImage.call(this,image,...args);}
    return drawImage.call(this,source,...args);
  };
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async constraints=>{
    mock.calls++;mock.constraints.push(structuredClone(constraints));
    if(mock.deny)throw new DOMException('Synthetic camera permission denied','NotAllowedError');
    if(mock.startGate)await mock.startGate;
    const track={kind:'video',label:'Synthetic back camera',readyState:'live',enabled:true,muted:false,
      getSettings:()=>({width:1280,height:960,facingMode:'environment',deviceId:'synthetic-back'}),
      getCapabilities:()=>({width:{min:320,max:1280},height:{min:240,max:960},facingMode:['environment']}),
      getConstraints:()=>structuredClone(constraints.video||{}),applyConstraints:async()=>{},
      addEventListener(){},removeEventListener(){},
      stop(){if(this.readyState==='live'){this.readyState='ended';mock.stopped++;}}};
    mock.tracks.push(track);
    return {sentlogCameraFixture:true,active:true,id:'synthetic-'+mock.calls,
      getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[],
      addEventListener(){},removeEventListener(){}};
  }});
  window.ImageCapture=class{
    constructor(track){this.track=track;}
    async getPhotoCapabilities(){return {imageWidth:{min:32,max:1280,step:1},imageHeight:{min:32,max:960,step:1}};}
    async takePhoto(){mock.photos++;return new Blob([bytes],{type:'image/png'});}
  };
}"""


def camera_count(page, count):
    page.wait_for_function("""n=>{
      const text=document.getElementById('slCameraCount')?.textContent||'';
      return new RegExp('保存\\s*'+n+'\\s*枚').test(text);
    }""", arg=count)


def open_camera(page):
    page.locator('#cameraBtn').click()
    expect(page.locator('#sentlogContinuousCamera')).to_be_visible()
    page.wait_for_function('SentlogContinuousCamera.isOpen()')


def shutter(page):
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    page.locator('#slCameraShutter').click()


def saved_photo_ids(page, drawing_id, record_id='survey-a'):
    return page.evaluate("""({drawingId,recordId})=>{
      const drawing=JSON.parse(SentlogRecords.getItem(drawingStorageKey(drawingId)));
      return drawing.shapes.find(record=>record.id===recordId).photos.map(photo=>photo.id);
    }""", {'drawingId': drawing_id, 'recordId': record_id})


def assert_controls_fit(page):
    bounds = page.evaluate("""()=>['slCameraNative','slCameraCount','slCameraShutter','slCameraDone'].map(id=>{
      const box=document.getElementById(id).getBoundingClientRect();
      return {id,x:box.x,y:box.y,right:box.right,bottom:box.bottom,
        fits:box.x>=-0.5&&box.y>=-0.5&&box.right<=innerWidth+0.5&&box.bottom<=innerHeight+0.5};
    })""")
    assert all(box['fits'] for box in bounds), bounds


def run(page, engine, screenshot_dir=None):
    def screenshot(name):
        if screenshot_dir:
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot_dir / (engine+'-'+name+'.png')), full_page=False)

    if engine == 'webkit':
        page.evaluate(WEBKIT_TRANSPORT)
    encoded = base64.b64encode(photo_png()).decode('ascii')
    page.evaluate(SETUP, encoded)
    page.evaluate(CAMERA_MOCK, encoded)
    page.evaluate('cameraMock.imageReady')

    # Three photographs keep one camera stream open and save one durable photo
    # per press. The normal view has only the count, with review opt-in.
    open_camera(page)
    camera_count(page, 0)
    expect(page.locator('#slCameraReview')).to_be_hidden()
    for count in range(1, 4):
        shutter(page)
        wait_photos(page, 'memo-plan-a', count)
        camera_count(page, count)
        expect(page.locator('#sentlogContinuousCamera')).to_be_visible()
        expect(page.locator('#slCameraReview')).to_be_hidden()
        assert page.locator('[data-camera-photo-id]:visible').count() == 0
    assert page.evaluate('cameraMock.calls') == 1
    assert page.evaluate('cameraMock.photos') == 3
    assert page.evaluate('cameraMock.canvasPhotos') == 0, 'supported ImageCapture should be preferred'
    assert len(set(saved_photo_ids(page, 'memo-plan-a'))) == 3
    assert_controls_fit(page)
    screenshot('three-photos-portrait')
    page.set_viewport_size({'width': 844, 'height': 390})
    assert_controls_fit(page)
    screenshot('three-photos-landscape')
    page.set_viewport_size({'width': 390, 'height': 844})

    # An incoming append is accepted during image conversion. A second shutter
    # press while saving cannot capture a duplicate or overwrite the peer photo.
    page.evaluate(HOLD_CONVERSION)
    shutter(page)
    page.wait_for_function('photoCaptureGate.entered')
    expect(page.locator('#slCameraShutter')).to_be_disabled()
    before = page.evaluate('cameraMock.photos')
    page.locator('#slCameraShutter').evaluate('button=>{button.click();button.click();}')
    assert page.evaluate('cameraMock.photos') == before
    assert not page.evaluate('SentlogCollaborationPhotos.isCommitting()')
    received = page.evaluate("""async()=>{
      const incoming=structuredClone(memoFixture.snapshot()),d=incoming.drawings.find(x=>x.meta.id==='memo-plan-a');
      incoming.project.collaborationVersion=1;
      const index=d.state.shapes.findIndex(s=>s.id==='survey-a'),M=SentlogRecordCollaboration;
      const actor={deviceId:'camera-peer-ipad',deviceName:'別のiPad'};
      let record=M.appendComment(d.state.shapes[index],'連続撮影中に届いた所見',
        {commentId:'camera-peer-comment',revisionId:'camera-peer-comment-v1',actor,at:200});
      record=M.addPhoto(record,{id:'camera-peer-photo',name:'peer.png',type:'image/png',size:memoFixture.photo.size},
        {revisionId:'camera-peer-photo-v1',actor,at:201});
      d.state.shapes[index]=record;
      memoFixture.files.set(photoDBKey('camera-peer-photo','memo-plan-a'),memoFixture.photo);
      return memoFixture.commit(incoming);
    }""")
    assert received['applied'], received
    release(page)
    wait_photos(page, 'memo-plan-a', 5)
    camera_count(page, 4)
    assert 'camera-peer-photo' in saved_photo_ids(page, 'memo-plan-a')
    assert page.evaluate("SentlogRecordCollaboration.view(memoFixture.record()).comments.some(c=>c.id==='camera-peer-comment')")

    # Review is opened from the count and closed without leaving the camera.
    page.locator('#slCameraCount').click()
    expect(page.locator('#slCameraReview')).to_be_visible()
    expect(page.locator('#slCameraReviewList [data-camera-photo-id]')).to_have_count(4)
    assert page.locator('[data-camera-photo-id="camera-peer-photo"]').count() == 0
    screenshot('review')
    page.locator('#slCameraReviewList .sl-camera-image-button').first.click()
    expect(page.locator('#slCameraLarge')).to_be_visible()
    page.locator('#slCameraLargeClose').click()
    expect(page.locator('#slCameraLarge')).to_be_hidden()
    page.locator('#slCameraReviewList [data-camera-remove]').first.click()
    dialog = page.locator('.sl-collab-dialog')
    expect(dialog).to_be_visible()
    assert page.evaluate("""()=>{
      const dialog=document.querySelector('.sl-collab-dialog'),camera=document.getElementById('sentlogContinuousCamera');
      const button=dialog.querySelector('button'),box=button.getBoundingClientRect();
      return Number(getComputedStyle(dialog).zIndex)>Number(getComputedStyle(camera).zIndex)&&
        dialog.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
    }"""), 'photo-removal confirmation must remain above the camera overlay'
    screenshot('photo-removal-confirmation')
    dialog.get_by_role('button', name='キャンセル', exact=True).click()
    expect(dialog).to_be_hidden()
    assert len(saved_photo_ids(page, 'memo-plan-a')) == 5
    page.locator('#slCameraReviewClose').click()
    expect(page.locator('#slCameraReview')).to_be_hidden()
    expect(page.locator('#sentlogContinuousCamera')).to_be_visible()
    assert page.locator('[data-camera-photo-id]:visible').count() == 0

    # Done while saving awaits durable attachment before releasing the camera.
    page.evaluate(HOLD_CONVERSION)
    shutter(page)
    page.wait_for_function('photoCaptureGate.entered')
    page.locator('#slCameraDone').click()
    assert page.evaluate('SentlogContinuousCamera.isOpen()'), 'pending save must not be abandoned'
    assert page.evaluate('cameraMock.tracks[0].readyState') == 'live'
    release(page)
    wait_photos(page, 'memo-plan-a', 6)
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    expect(page.locator('#sentlogContinuousCamera')).to_be_hidden()
    assert page.evaluate('cameraMock.tracks[0].readyState') == 'ended'

    # The destination is bound when the session opens, not when a later shot
    # finishes. Same-ID records on another drawing must never receive this shot.
    open_camera(page)
    camera_count(page, 0)
    page.evaluate("SentlogFieldRecords.selectRecord('survey-b')")
    page.evaluate(HOLD_CONVERSION)
    shutter(page)
    page.wait_for_function('photoCaptureGate.entered')
    page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-b');
      SentlogFieldRecords.selectRecord('survey-a');$('inspector').classList.add('open');
    }""")
    release(page)
    wait_photos(page, 'memo-plan-a', 7)
    camera_count(page, 1)
    assert saved_photo_ids(page, 'memo-plan-a', 'survey-b') == []
    assert saved_photo_ids(page, 'memo-plan-b') == []
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')

    # Permission denial leaves an explicit route to the existing native camera.
    page.evaluate('cameraMock.deny=true')
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_disabled()
    expect(page.locator('#slCameraNative')).to_be_visible()
    expect(page.locator('#slCameraStatus')).to_contain_text('許可')
    with page.expect_file_chooser() as chooser:
        page.locator('#slCameraNative').click()
    chooser.value.set_files({'name': 'native-fallback.png', 'mimeType': 'image/png', 'buffer': photo_png()})
    wait_photos(page, 'memo-plan-b', 1)
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    assert len(saved_photo_ids(page, 'memo-plan-a')) == 7

    # A device without ImageCapture still uses a video-frame capture, without
    # reopening the native picker or changing the intended drawing.
    page.evaluate('cameraMock.deny=false;window.ImageCapture=undefined')
    open_camera(page)
    shutter(page)
    wait_photos(page, 'memo-plan-b', 2)
    camera_count(page, 1)
    assert page.evaluate('cameraMock.canvasPhotos') == 1
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    assert all(row == 'ended' for row in page.evaluate('cameraMock.tracks.map(track=>track.readyState)'))

    # Ending the session before the permission/start request resolves must
    # stop a late-arriving stream instead of leaving camera hardware active.
    previous_tracks = page.evaluate('cameraMock.tracks.length')
    page.evaluate('cameraMock.startGate=new Promise(resolve=>{cameraMock.releaseStart=resolve;})')
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_disabled()
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    page.evaluate('cameraMock.releaseStart();cameraMock.startGate=null')
    page.wait_for_function('n=>cameraMock.tracks.length===n+1&&cameraMock.tracks.at(-1).readyState==="ended"', arg=previous_tracks)
    expect(page.locator('#sentlogContinuousCamera')).to_be_hidden()

    # Saved originals remain associated with the exact record; no queued
    # operation or half-saved photo is left behind by finishing a session.
    metas = page.evaluate("""async()=>({
      originals:(await SentlogOriginalPhotos.listMeta()).map(row=>({
        id:row.photoId,drawingId:row.drawingId,status:row.photoAssociation?.status,
        recordId:row.photoAssociation?.target?.recordId
      })),pending:await SentlogCollaborationPhotos.listPending()
    })""")
    assert metas['pending'] == [], metas
    assert len(metas['originals']) == 8, metas
    assert all(row['status'] == 'attached' and row['recordId'] == 'survey-a' for row in metas['originals']), metas
    print('PASS '+engine+': three continuous shots, durable per-shot saves, duplicate press guard, '
          'incoming photo/comment preservation, opt-in review, finish waits for save, '
          'fixed destination, permission/video-frame fallback, confirmation layering '
          'and late-start camera cleanup')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--screenshot-dir', type=Path)
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
            context = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                                          is_mobile=True, service_workers='block')

            def route(request):
                if request.request.url.startswith((origin+'/', 'blob:', 'data:')):
                    request.continue_()
                elif request.request.url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'):
                    request.fulfill(content_type='text/javascript', body='window.pdfjsLib={GlobalWorkerOptions:{}};')
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(origin+'/sentlog/', wait_until='domcontentloaded')
                page.wait_for_function('window.sentlogAppReady&&window.SentlogContinuousCamera&&window.SentlogCollaborationPhotos', timeout=45000)
                run(page, args.engine, args.screenshot_dir)
                assert not errors, errors
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
