"""Continuous-camera regression against the built app and synthetic records.

Only camera hardware is mocked. Original/shared image conversion, record
storage, photo journaling, incoming collaboration and the camera UI are real.
Linux WebKit uses the same Blob transport fixture as collaboration_photos_ui.
All external network requests are blocked; no user records are involved.
"""
import argparse
import base64
import functools
import hashlib
import io
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from PIL import Image, ImageDraw

from collaboration_photos_ui import HOLD_CONVERSION, WEBKIT_TRANSPORT, release, wait_photos
from field_record_memo_ui import SETUP, photo_png

ROOT = Path(__file__).resolve().parents[1]

ORIENTATION_COLORS = [(220, 30, 30), (30, 190, 60), (40, 80, 220), (230, 190, 20)]


def orientation_photo(width, height, *, exif=None, turn=None):
    """Four distinct corners detect every quarter-turn and mirror operation.

    EXIF fixtures encode the inverse pixel transform, so all eight tags must
    decode to the same upright image. Native still fixtures may deliberately
    disagree with the live preview to model the iOS capture-path discrepancy.
    """
    image = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(image)
    for box, color in zip(((0, 0, width//2, height//2),
                           (width//2, 0, width, height//2),
                           (width//2, height//2, width, height),
                           (0, height//2, width//2, height)), ORIENTATION_COLORS):
        draw.rectangle(box, fill=color)
    inverse_exif = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
                    4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
                    6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE,
                    8: Image.Transpose.ROTATE_270}
    if exif in inverse_exif:
        image = image.transpose(inverse_exif[exif])
    if turn is not None:
        image = image.transpose({90: Image.Transpose.ROTATE_90,
                                 270: Image.Transpose.ROTATE_270}[turn])
    buffer = io.BytesIO()
    if exif is None:
        image.save(buffer, format='PNG')
    else:
        tags = Image.Exif()
        tags[274] = exif
        image.save(buffer, format='JPEG', quality=95, subsampling=0, exif=tags)
    return buffer.getvalue()


IMAGE_PIXELS = r"""async (image,{decoded=false}={})=>{
  if(!decoded)await image.decode();
  const width=image.naturalWidth,height=image.naturalHeight;
  if(!width||!height)throw Error('Orientation fixture did not decode');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  try{
    const context=canvas.getContext('2d');context.drawImage(image,0,0,width,height);
    const rgba=[[.25,.25],[.75,.25],[.75,.75],[.25,.75]].map(([x,y])=>
      [...context.getImageData(Math.floor(x*width),Math.floor(y*height),1,1).data]);
    return {width,height,corners:rgba.map(pixel=>pixel.slice(0,3)),rgba};
  }finally{canvas.width=1;canvas.height=1;}
}"""

SAVED_IMAGE_PIXELS = r"""async ({photoId,drawingId,original})=>{
  const blob=original?await SentlogOriginalPhotos.getOriginal(drawingId,photoId):await getPhotoBlob(photoId,drawingId);
  if(!blob?.size)throw Error('Saved orientation fixture missing');
  const url=URL.createObjectURL(blob),image=new Image();image.src=url;
  try{
    const pixels=await (""" + IMAGE_PIXELS + r""")(image);
    const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return {...pixels,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('')};
  }finally{URL.revokeObjectURL(url);image.src='';}
}"""


def assert_orientation(pixels, width, height, label):
    assert (pixels['width'], pixels['height']) == (width, height), (label, pixels)
    for index, (actual, expected) in enumerate(zip(pixels['corners'], ORIENTATION_COLORS)):
        assert all(abs(a-e) <= 35 for a, e in zip(actual, expected)), (label, index, pixels)


CAMERA_MOCK = r"""encoded=>{
  let bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const mock=window.cameraMock={calls:0,photos:0,canvasPhotos:0,stopped:0,deny:false,tracks:[],constraints:[],
    width:1280,height:960,stillMime:'image/png',videos:new Set()};
  let image=new Image();image.src='data:image/png;base64,'+encoded;mock.imageReady=image.decode();
  mock.setFrame=async fixture=>{
    const next=new Image();next.src='data:image/png;base64,'+fixture.encoded;await next.decode();
    image=next;mock.width=fixture.width;mock.height=fixture.height;
    bytes=Uint8Array.from(atob(fixture.stillEncoded||fixture.encoded),c=>c.charCodeAt(0));
    mock.stillMime=fixture.stillMime||'image/png';
    for(const video of mock.videos)video.dispatchEvent(new Event('resize'));
  };
  const active=new WeakMap();
  // WebKit may expose media members on HTMLVideoElement itself. Override the
  // concrete prototype so an own native member cannot shadow the fixture.
  let mediaPrototype=HTMLVideoElement.prototype,originalSrc;
  while(mediaPrototype&&!originalSrc){
    originalSrc=Object.getOwnPropertyDescriptor(mediaPrototype,'srcObject');
    mediaPrototype=Object.getPrototypeOf(mediaPrototype);
  }
  Object.defineProperty(HTMLVideoElement.prototype,'srcObject',{
    configurable:true,get(){return active.has(this)?active.get(this):originalSrc.get.call(this);},
    set(value){
      if(value?.sentlogCameraFixture){
        active.set(this,value);mock.videos.add(this);
        for(const [key,get] of [['videoWidth',()=>mock.width],['videoHeight',()=>mock.height],['readyState',()=>4]])
          Object.defineProperty(this,key,{configurable:true,get});
        queueMicrotask(()=>{
          this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('canplay'));
        });
      }else{
        if(active.has(this)){
          active.delete(this);mock.videos.delete(this);
          for(const key of ['videoWidth','videoHeight','readyState'])delete this[key];
        }
        originalSrc.set.call(this,value);
      }
    }
  });
  const play=HTMLVideoElement.prototype.play,pause=HTMLVideoElement.prototype.pause;
  HTMLVideoElement.prototype.play=function(){
    if(active.has(this)){this.dispatchEvent(new Event('playing'));return Promise.resolve();}
    return play.apply(this,arguments);
  };
  HTMLVideoElement.prototype.pause=function(){if(!active.has(this))return pause.apply(this,arguments);};
  const drawImage=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
    if(active.has(source)){mock.canvasPhotos++;return drawImage.call(this,image,...args);}
    return drawImage.call(this,source,...args);
  };
  // Keep a stable wrapper across separate evaluations in WebKit; attaching an
  // expando to a temporary native mediaDevices wrapper can lose the mock.
  const mediaDevices=navigator.mediaDevices;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:mediaDevices});
  Object.defineProperty(mediaDevices,'getUserMedia',{configurable:true,value:async constraints=>{
    mock.calls++;mock.constraints.push(structuredClone(constraints));
    if(mock.deny)throw new DOMException('Synthetic camera permission denied','NotAllowedError');
    if(mock.startGate)await mock.startGate;
    const track={kind:'video',label:'Synthetic back camera',readyState:'live',enabled:true,muted:false,
      getSettings:()=>({width:mock.width,height:mock.height,facingMode:'environment',deviceId:'synthetic-back'}),
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
    async takePhoto(){mock.photos++;return new Blob([bytes],{type:mock.stillMime});}
  };
  mock.ImageCaptureClass=window.ImageCapture;
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


def set_safe_area(page, insets=None):
    page.evaluate("""insets=>{
      const style=document.getElementById('sentlogContinuousCamera').style;
      for(const side of ['top','right','bottom','left']){
        const property='--sl-camera-safe-'+side;
        if(insets)style.setProperty(property,(insets[side]||0)+'px');else style.removeProperty(property);
      }
    }""", insets)


def assert_controls_fit(page, safe_area=None):
    bounds = page.evaluate("""()=>[
      'slCameraNative','slCameraCount','slCameraShutter','slCameraDone',
      'slCameraResume','slCameraRetry','slCameraExport','slCameraExportDone'
    ].flatMap(id=>{
      const button=document.getElementById(id);
      if(!button.getClientRects().length)return [];
      const box=button.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
      return [{id,x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height,
        fits:box.x>=-0.5&&box.y>=-0.5&&box.right<=innerWidth+0.5&&box.bottom<=innerHeight+0.5,
        exposed:!!hit&&(hit===button||button.contains(hit))}];
    })""")
    assert all(box['fits'] and box['exposed'] and box['width'] >= 44 and box['height'] >= 44
               for box in bounds), bounds
    if safe_area:
        viewport = page.evaluate('({width:innerWidth,height:innerHeight})')
        assert all(box['x'] >= safe_area.get('left', 0)-.5 and box['y'] >= safe_area.get('top', 0)-.5
                   and box['right'] <= viewport['width']-safe_area.get('right', 0)+.5
                   and box['bottom'] <= viewport['height']-safe_area.get('bottom', 0)+.5
                   for box in bounds), (safe_area, bounds)


def assert_camera_layout(page, *, landscape, safe_area=None):
    """Check usable preview/frame and thumb reach, not particular CSS rules."""
    page.wait_for_function("landscape=>matchMedia('(orientation:landscape)').matches===landscape", arg=landscape)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    assert_controls_fit(page, safe_area)
    layout = page.evaluate("""()=>{
      const video=document.getElementById('slCameraVideo'),rect=element=>{
        const r=element.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
      },frame=rect(video),fit=getComputedStyle(video).objectFit;
      const scale=Math.min(frame.width/video.videoWidth,frame.height/video.videoHeight);
      return {viewport:{width:innerWidth,height:innerHeight},stage:rect(video.parentElement),
        shutter:rect(document.getElementById('slCameraShutter')),fit,
        frame:{width:video.videoWidth*scale,height:video.videoHeight*scale}};
    }""")
    width, height = layout['viewport']['width'], layout['viewport']['height']
    shutter_box = layout['shutter']
    center_x = shutter_box['x']+shutter_box['width']/2
    center_y = shutter_box['y']+shutter_box['height']/2
    assert shutter_box['width'] >= 70 and shutter_box['height'] >= 70, layout
    assert layout['fit'] == 'contain', ('Preview must show the full photograph without cropping', layout)
    if landscape:
        assert center_x >= width*.80, ('Landscape shutter must stay on the visual right', layout)
        assert abs(center_y-height/2) <= height*.20, ('Landscape shutter must be within thumb reach', layout)
        assert layout['stage']['height'] >= height*.80, ('Landscape preview must use most of the screen height', layout)
        assert layout['frame']['height'] >= height*.75, ('Actual contained frame must be larger than the old stacked layout', layout)
    else:
        assert abs(center_x-width/2) <= max(4, width*.04), ('Portrait shutter must remain centered', layout)
        assert center_y >= height*.70, ('Portrait shutter must remain near the bottom', layout)
    return layout


def run(page, engine, screenshot_dir=None):
    def screenshot(name):
        if screenshot_dir:
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot_dir / ('sentlog-continuous-camera-'+engine+'-'+name+'.png')), full_page=False)

    if engine == 'webkit':
        page.evaluate(WEBKIT_TRANSPORT)
    encoded = base64.b64encode(photo_png()).decode('ascii')
    page.evaluate(SETUP, encoded)
    page.evaluate(CAMERA_MOCK, encoded)
    page.evaluate('cameraMock.imageReady')
    assert page.evaluate("""()=>{
      window.cameraRefreshProbe={native:0,superseded:0,latest:0,closedAtFlush:[]};
      return SentlogContinuousCamera.deferEditorRefresh(()=>{cameraRefreshProbe.superseded++;});
    }""") is False, 'a closed camera must leave editor repaint to the caller'

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
    assert_camera_layout(page, landscape=False)
    screenshot('three-photos-portrait')
    page.evaluate("""()=>{
      cameraMock.originalFit=fit;cameraMock.hiddenFit=0;
      cameraMock.openView={view:currentView,projectId:activeProjectId,drawingId:activeDrawingId,recordId:selected};
      fit=function(){if(SentlogContinuousCamera.isOpen())cameraMock.hiddenFit++;return cameraMock.originalFit.apply(this,arguments);};
    }""")
    for width, height, name in [(844, 390, 'three-photos-landscape'), (568, 320, 'landscape-small')]:
        page.set_viewport_size({'width': width, 'height': height})
        page.evaluate("""async()=>{
          window.dispatchEvent(new Event('orientationchange'));
          await new Promise(resolve=>setTimeout(resolve,350));
        }""")
        assert_camera_layout(page, landscape=True)
        screenshot(name)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.evaluate("""async()=>{
      window.dispatchEvent(new Event('orientationchange'));
      await new Promise(resolve=>setTimeout(resolve,350));
    }""")
    assert_camera_layout(page, landscape=False)
    assert page.evaluate('cameraMock.hiddenFit') == 0, 'rotation must not refit and redraw the covered drawing behind a live camera'
    assert page.evaluate("""()=>({view:currentView,projectId:activeProjectId,drawingId:activeDrawingId,recordId:selected})""") == page.evaluate('cameraMock.openView')
    assert page.evaluate('cameraMock.calls') == 1, 'rotation must preserve the already permitted stream'
    page.evaluate('fit=cameraMock.originalFit')

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

    # Done while saving awaits durable attachment before disabling the camera.
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
    assert page.evaluate('cameraMock.tracks[0].readyState') == 'live'
    assert page.evaluate('cameraMock.tracks[0].enabled') is False
    assert page.evaluate('document.getElementById("slCameraVideo").srcObject') is None

    # The destination is bound when the session opens, not when a later shot
    # finishes. Same-ID records on another drawing must never receive this shot.
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    assert page.evaluate('cameraMock.calls') == 1, 'returning to this drawing should reuse its disabled stream without another permission request'
    assert page.evaluate('cameraMock.tracks[0].enabled') is True
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
    assert page.evaluate('cameraMock.tracks[0].readyState') == 'ended', 'the old drawing stream must not be retained after navigation'

    # Permission denial leaves an explicit route to the existing native camera.
    page.evaluate('cameraMock.deny=true')
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_disabled()
    expect(page.locator('#slCameraNative')).to_be_visible()
    expect(page.locator('#slCameraStatus')).to_contain_text('許可')
    assert page.evaluate("""()=>SentlogContinuousCamera.deferEditorRefresh(()=>{
      cameraRefreshProbe.native++;
      cameraRefreshProbe.closedAtFlush.push(!SentlogContinuousCamera.isOpen());
      throw Error('Synthetic editor repaint failure');
    })"""), 'the open camera should own one pending editor refresh'
    with page.expect_file_chooser() as chooser:
        page.locator('#slCameraNative').click()
    assert page.evaluate('cameraRefreshProbe.native') == 1
    assert page.evaluate('cameraRefreshProbe.closedAtFlush') == [True]
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
    page.locator('#slCameraCount').click()
    expect(page.locator('#slCameraReview')).to_be_visible()
    row = page.locator('#slCameraReviewList [data-camera-photo-id]').first
    removed_photo_id = row.get_attribute('data-camera-photo-id')
    page.evaluate("""()=>{
      cameraMock.originalRefresh=window.sentlogCollabRefresh;
      window.sentlogCollabRefresh=async()=>({fresh:true});
    }""")
    try:
        row.locator('[data-camera-remove]').click()
        dialog = page.locator('.sl-collab-dialog')
        expect(dialog).to_be_visible()
        dialog.get_by_role('button', name='写真を外す', exact=True).click()
        expect(dialog).to_be_hidden()
        wait_photos(page, 'memo-plan-b', 1)
        camera_count(page, 0)
        expect(row.locator('.sl-camera-photo-name')).to_have_text('記録から外した写真')
        expect(row.locator('[data-camera-remove]')).to_be_hidden()
        assert removed_photo_id not in saved_photo_ids(page, 'memo-plan-b')
        assert page.evaluate("""async id=>!!(await SentlogOriginalPhotos.getOriginal('memo-plan-b',id))""", removed_photo_id)
        screenshot('photo-removed-original-retained')
    finally:
        page.evaluate('()=>{window.sentlogCollabRefresh=cameraMock.originalRefresh;}')
    page.locator('#slCameraReviewClose').click()
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    assert page.evaluate('cameraMock.tracks.every(track=>track.readyState==="ended"||!track.enabled)'), 'closing must disable every retained camera track'
    assert page.evaluate('document.getElementById("slCameraVideo").srcObject') is None

    # Leaving the drawing releases a parked grant immediately. Backgrounding
    # the app must release it even while the camera dialog is already closed.
    page.evaluate("showDrawings(memoFixture.pid)")
    assert all(row == 'ended' for row in page.evaluate('cameraMock.tracks.map(track=>track.readyState)'))
    page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-b');SentlogFieldRecords.selectRecord('survey-a');
      $('inspector').classList.add('open');
    }""")
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_enabled()
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    assert page.evaluate('cameraMock.tracks.at(-1).enabled') is False
    page.evaluate("""()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    assert all(row == 'ended' for row in page.evaluate('cameraMock.tracks.map(track=>track.readyState)'))

    # Ending the session before the permission/start request resolves must
    # stop a late-arriving stream instead of leaving camera hardware active.
    previous_tracks = page.evaluate('cameraMock.tracks.length')
    page.evaluate('()=>{cameraMock.startGate=new Promise(resolve=>{cameraMock.releaseStart=resolve;});}')
    open_camera(page)
    expect(page.locator('#slCameraShutter')).to_be_disabled()
    assert page.evaluate("""()=>{
      const first=SentlogContinuousCamera.deferEditorRefresh(()=>{cameraRefreshProbe.superseded++;});
      const latest=SentlogContinuousCamera.deferEditorRefresh(()=>{
        cameraRefreshProbe.latest++;
        cameraRefreshProbe.closedAtFlush.push(!SentlogContinuousCamera.isOpen());
      });
      return first&&latest;
    }"""), 'successive refresh requests must be coalesced while the camera is open'
    page.locator('#slCameraDone').click()
    page.wait_for_function('!SentlogContinuousCamera.isOpen()')
    assert page.evaluate('cameraRefreshProbe') == {
        'native': 1, 'superseded': 0, 'latest': 1, 'closedAtFlush': [True, True]
    }
    assert page.evaluate('SentlogContinuousCamera.close()') is True
    assert page.evaluate('cameraRefreshProbe.latest') == 1, 'closing again must not replay the cleared callback'
    assert page.evaluate('SentlogContinuousCamera.deferEditorRefresh(()=>{cameraRefreshProbe.latest++;})') is False
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
          'disabled same-drawing stream reuse, navigation/background release and late-start camera cleanup')


def run_orientation(page, engine, screenshot_dir=None):
    drawing_id = 'memo-plan-b'
    page.evaluate("""async()=>{
      await openDrawing(memoFixture.pid,'memo-plan-b');SentlogFieldRecords.selectRecord('survey-a');
      $('inspector').classList.add('open');window.ImageCapture=cameraMock.ImageCaptureClass;
    }""")
    platform = page.evaluate("""()=>({userAgent:navigator.userAgent,platform:navigator.platform,
      maxTouchPoints:navigator.maxTouchPoints})""")

    def set_platform(values):
        page.evaluate("""values=>{
          for(const [key,value] of Object.entries(values))Object.defineProperty(navigator,key,{configurable:true,value});
        }""", values)

    def saved_pixels(photo_id, original=False):
        return page.evaluate(SAVED_IMAGE_PIXELS, {'photoId': photo_id, 'drawingId': drawing_id, 'original': original})

    def shared_size(width, height):
        ratio = min(1, 1600/max(width, height))
        return round(width*ratio), round(height*ratio)

    def review_pixels(photo_id):
        # Keep the actual review node throughout loading and painting. A
        # locator that resolves again could silently select a replacement.
        image = page.locator(f'#slCameraReviewList [data-camera-photo-id="{photo_id}"] img').element_handle()
        assert image is not None, ('Missing review image', photo_id)
        image.scroll_into_view_if_needed()
        page.wait_for_function("""({image,photoId})=>{
          if(!image.isConnected||image.closest('[data-camera-photo-id]')?.dataset.cameraPhotoId!==photoId)
            throw Error('Review image changed while loading');
          return !!image.currentSrc&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0;
        }""", arg={'image': image, 'photoId': photo_id}, timeout=5000)
        return image.evaluate(r"""async (image,photoId)=>{
          const source=image.currentSrc;
          const current=()=>image.isConnected&&image.currentSrc===source&&image.complete&&
            image.closest('[data-camera-photo-id]')?.dataset.cameraPhotoId===photoId;
          if(!source||!current())throw Error('Review image is no longer current');
          await image.decode();
          // The review uses lazy, asynchronous image decoding. Give the
          // visible image a paint opportunity before sampling it in canvas;
          // never retry a failed pixel/color assertion.
          let deadline;
          try{
            await Promise.race([
              new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),
              new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Review paint did not finish')),5000);})
            ]);
          }finally{clearTimeout(deadline);}
          if(!current())throw Error('Review image changed before pixel verification');
          const pixels=await (""" + IMAGE_PIXELS + r""")(image,{decoded:true});
          if(!current())throw Error('Review image changed during pixel verification');
          return {...pixels,ready:{connected:image.isConnected,complete:image.complete,
            source,loading:image.loading,decoding:image.decoding,viewport:[innerWidth,innerHeight]}};
        }""", photo_id)

    def grid_pixels(photo_id):
        # Observe the automatic close/attachment refresh. Forcing another
        # redraw here revokes every thumbnail URL while that real refresh may
        # still be loading, and can sample a discarded image in WebKit.
        photos = page.evaluate("""id=>JSON.parse(SentlogRecords.getItem(drawingStorageKey(id)))
          .shapes.find(record=>record.id==='survey-a').photos.map(photo=>({id:photo.id,name:photo.name||'変状写真'}))""", drawing_id)
        # Canonical collaboration order is deliberately independent of the
        # chronological grid. Identify this image by its unique saved name;
        # the capture-order regression separately verifies the presentation.
        name = next(photo['name'] for photo in photos if photo['id'] == photo_id)
        page.wait_for_function("""names=>{
          const items=[...document.querySelectorAll('#photoGrid .photo-thumb')];
          return items.length===names.length&&names.every(name=>{
            const matches=items.filter(item=>item.title===name),image=matches[0]?.querySelector('img');
            return matches.length===1&&image?.src&&image.complete&&image.naturalWidth>0;
          });
        }""", arg=[photo['name'] for photo in photos])
        image = page.locator('#photoGrid').get_by_alt_text(name, exact=True)
        image.scroll_into_view_if_needed()
        return image.evaluate(r"""async image=>{
          const source=image.currentSrc||image.src;
          if(!image.isConnected||!source)throw Error('Photo-list image is no longer current');
          const pixels=await (""" + IMAGE_PIXELS + r""")(image);
          if(!image.isConnected||(image.currentSrc||image.src)!==source)
            throw Error('Photo list changed during pixel verification');
          return pixels;
        }""")

    devices = [
        ('iPhone', {'userAgent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1',
                    'platform': 'iPhone', 'maxTouchPoints': 5},
         [('portrait', 1200, 1600, 90), ('landscape-left', 1600, 1200, 90),
          ('landscape-right', 1600, 1200, 270), ('portrait-again', 1200, 1600, 270)]),
        ('iPad-desktop', {'userAgent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.4 Safari/605.1.15',
                         'platform': 'MacIntel', 'maxTouchPoints': 5},
         [('portrait', 1920, 2560, 90), ('landscape', 2560, 1920, 270)])
    ]
    current_orientation = 'not started'
    try:
        for device, navigator, cases in devices:
            set_platform(navigator)
            # Each platform fixture starts a fresh hardware lifetime. Rotation
            # within it must keep the same stream for every shot.
            page.evaluate('window.dispatchEvent(new Event("pagehide"))')
            native_before = page.evaluate('cameraMock.photos')
            frames_before = page.evaluate('cameraMock.canvasPhotos')
            streams_before = page.evaluate('cameraMock.calls')
            checked = []
            layouts = []
            for shot, (direction, width, height, turn) in enumerate(cases, 1):
                current_orientation = device+' '+direction
                portrait = height > width
                if device == 'iPad-desktop':
                    viewport = {'width': 768, 'height': 1024} if portrait else {'width': 1024, 'height': 768}
                else:
                    viewport = {'width': 390, 'height': 844} if portrait else {'width': 844, 'height': 390}
                page.set_viewport_size(viewport)
                preview = orientation_photo(width, height)
                wrong_still = orientation_photo(width, height, turn=turn)
                page.evaluate('fixture=>cameraMock.setFrame(fixture)', {
                    'encoded': base64.b64encode(preview).decode('ascii'), 'width': width, 'height': height,
                    'stillEncoded': base64.b64encode(wrong_still).decode('ascii')})
                if shot == 1:
                    open_camera(page)
                # Exercise both notch sides in the same stream. These inputs
                # represent the browser's safe-area values, not layout rules.
                safe_area = None
                if device == 'iPhone' and not portrait:
                    safe_area = {'left': 44 if direction == 'landscape-left' else 0,
                                 'right': 44 if direction == 'landscape-right' else 0, 'bottom': 21}
                set_safe_area(page, safe_area)
                layout = assert_camera_layout(page, landscape=not portrait, safe_area=safe_area)
                layouts.append({'direction': direction, 'viewport': layout['viewport'],
                                'frame': layout['frame'], 'shutter': layout['shutter']})
                if screenshot_dir and not portrait:
                    screenshot_dir.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(screenshot_dir / f'sentlog-continuous-camera-{engine}-{device}-{direction}-layout.png'))
                before = set(saved_photo_ids(page, drawing_id))
                shutter(page)
                wait_photos(page, drawing_id, len(before)+1)
                camera_count(page, shot)
                added = set(saved_photo_ids(page, drawing_id))-before
                assert len(added) == 1, (device, direction, added)
                photo_id = added.pop()
                original = saved_pixels(photo_id, original=True)
                assert_orientation(original, width, height, device+' '+direction+' original')
                shared_width, shared_height = shared_size(width, height)
                assert_orientation(saved_pixels(photo_id), shared_width, shared_height, device+' '+direction+' shared')
                assert page.evaluate('cameraMock.photos') == native_before, 'iOS must not use the differently oriented native still'
                assert page.evaluate('cameraMock.canvasPhotos') == frames_before+shot

                page.locator('#slCameraCount').click()
                assert_orientation(review_pixels(photo_id), shared_width, shared_height, device+' '+direction+' review')
                if screenshot_dir and shot == 1:
                    screenshot_dir.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(screenshot_dir / f'sentlog-continuous-camera-{engine}-{device}-orientation.png'))
                page.locator('#slCameraReviewClose').click()
                checked.append((photo_id, width, height, original['sha256']))
            assert page.evaluate('cameraMock.calls') == streams_before+1, 'rotating the device must not require a new camera stream'
            page.locator('#slCameraDone').click()
            page.wait_for_function('!SentlogContinuousCamera.isOpen()')
            page.evaluate('SentlogRecords.settled()')
            for photo_id, width, height, digest in checked:
                assert_orientation(grid_pixels(photo_id), *shared_size(width, height), device+' photo list')
                assert saved_pixels(photo_id, original=True)['sha256'] == digest, 'display must not rewrite the retained original'
            print('PASS '+engine+': '+device+' preview pixels and full stream dimensions survive capture, shared conversion, review and photo list')
            print('PASS '+engine+': '+device+' right-side landscape shutter, full-frame preview, safe touch areas and portrait return', layouts)
    except Exception:
        # Capture the failing orientation before finally restores portrait.
        # The outer failure screenshot alone cannot establish the earlier
        # landscape paint state because that cleanup triggers another resize.
        try:
            print('Camera orientation before cleanup:', current_orientation, page.evaluate("""()=>({
              viewport:[innerWidth,innerHeight],reviewHidden:document.getElementById('slCameraReview')?.hidden,
              images:[...document.querySelectorAll('#slCameraReviewList [data-camera-photo-id] img')].map(image=>({
                photoId:image.closest('[data-camera-photo-id]').dataset.cameraPhotoId,
                source:image.currentSrc,connected:image.isConnected,complete:image.complete,
                size:[image.naturalWidth,image.naturalHeight],loading:image.loading,decoding:image.decoding
              }))
            })"""))
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(screenshot_dir / f'sentlog-continuous-camera-{engine}-orientation-failure.png'))
        except Exception as diagnostic_error:
            print('Camera orientation diagnostic failed:', diagnostic_error)
        raise
    finally:
        set_platform(platform)
        set_safe_area(page)
        page.set_viewport_size({'width': 390, 'height': 844})

    # Native-camera/gallery JPEGs retain their EXIF-bearing originals. The
    # shared JPEG and the actual photo-list image must apply orientation once.
    for orientation in range(1, 9):
        photo = orientation_photo(120, 160, exif=orientation)
        before = set(saved_photo_ids(page, drawing_id))
        with page.expect_file_chooser() as chooser:
            page.locator('#photoAddBtn').click()
        chooser.value.set_files({'name': f'orientation-{orientation}.jpg', 'mimeType': 'image/jpeg', 'buffer': photo})
        wait_photos(page, drawing_id, len(before)+1)
        added = set(saved_photo_ids(page, drawing_id))-before
        assert len(added) == 1, (orientation, added)
        photo_id = added.pop()
        original = saved_pixels(photo_id, original=True)
        assert original['sha256'] == hashlib.sha256(photo).hexdigest(), ('EXIF original changed', orientation)
        assert_orientation(original, 120, 160, f'EXIF {orientation} original decode')
        assert_orientation(saved_pixels(photo_id), 120, 160, f'EXIF {orientation} shared')
        assert_orientation(grid_pixels(photo_id), 120, 160, f'EXIF {orientation} photo list')
    assert page.evaluate('SentlogCollaborationPhotos.listPending()') == []
    ids = saved_photo_ids(page, drawing_id)
    assert len(ids) == len(set(ids)), 'orientation handling must not duplicate photo IDs'
    print('PASS '+engine+': EXIF orientations 1–8 decode once in shared photos/list and retain byte-identical originals')


def run_landscape_recovery(page, engine, screenshot_dir=None):
    """Recovery actions must remain usable on a short landscape screen."""
    drawing_id = 'memo-plan-b'
    fixture = orientation_photo(1600, 1200)
    page.evaluate('fixture=>cameraMock.setFrame(fixture)', {
        'encoded': base64.b64encode(fixture).decode('ascii'), 'width': 1600, 'height': 1200})
    before = set(saved_photo_ids(page, drawing_id))
    page.set_viewport_size({'width': 568, 'height': 320})
    open_camera(page)
    safe_area = {'left': 44, 'bottom': 21}
    set_safe_area(page, safe_area)
    assert_camera_layout(page, landscape=True, safe_area=safe_area)
    page.evaluate("""()=>{
      cameraMock.registerBeforeLayoutCheck=SentlogCollaborationPhotos.register;
      SentlogCollaborationPhotos.register=async()=>{
        throw Error('この端末の空き容量を確認してください。写真の保存が完了していません。');
      };
    }""")
    try:
        shutter(page)
        expect(page.locator('#slCameraRetry')).to_be_visible()
        expect(page.locator('#slCameraExport')).to_be_visible()
        expect(page.locator('#slCameraShutter')).to_be_disabled()
        expect(page.locator('#slCameraStatus')).to_contain_text('空き容量')
        assert_controls_fit(page, safe_area)
        assert set(saved_photo_ids(page, drawing_id)) == before

        # An actual export exposes the third recovery button. A failed Done
        # then explains how to retain the unsaved photograph, exercising the
        # feedback panel with all recovery actions visible.
        with page.expect_download() as download_info:
            page.locator('#slCameraExport').click()
        download = download_info.value
        assert download.failure() is None
        assert hashlib.sha256(Path(download.path()).read_bytes()).hexdigest() == hashlib.sha256(fixture).hexdigest()
        download.delete()
        expect(page.locator('#slCameraExportDone')).to_be_visible()
        page.locator('#slCameraDone').click()
        expect(page.locator('#slCameraDone')).to_be_enabled()
        expect(page.locator('#slCameraStatus')).to_have_text(
            'まだ保存できていない写真があります。再試行するか、写真を書き出してから終了してください。')
        assert page.evaluate('SentlogContinuousCamera.isOpen()'), 'Done must not discard the retained photograph'
        assert_controls_fit(page, safe_area)
        if screenshot_dir:
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot_dir / f'sentlog-continuous-camera-{engine}-landscape-recovery.png'))

        page.evaluate('SentlogCollaborationPhotos.register=cameraMock.registerBeforeLayoutCheck')
        page.locator('#slCameraRetry').click()
        wait_photos(page, drawing_id, len(before)+1)
        camera_count(page, 1)
        added = set(saved_photo_ids(page, drawing_id))-before
        assert len(added) == 1, added
        original = page.evaluate(SAVED_IMAGE_PIXELS, {
            'photoId': added.pop(), 'drawingId': drawing_id, 'original': True})
        assert original['sha256'] == hashlib.sha256(fixture).hexdigest(), 'Retry must preserve the exported original'
        expect(page.locator('#slCameraRetry')).to_be_hidden()
        expect(page.locator('#slCameraExportDone')).to_be_hidden()
        assert_camera_layout(page, landscape=True, safe_area=safe_area)
        page.locator('#slCameraDone').click()
        page.wait_for_function('!SentlogContinuousCamera.isOpen()')
        assert page.evaluate('SentlogCollaborationPhotos.listPending()') == []
    finally:
        page.evaluate('SentlogCollaborationPhotos.register=cameraMock.registerBeforeLayoutCheck')
        set_safe_area(page)
        page.set_viewport_size({'width': 390, 'height': 844})
    print('PASS '+engine+': small landscape failure message, export, protected Done and retry remain reachable and preserve exact original bytes')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    parser.add_argument('--screenshot-dir', type=Path)
    args = parser.parse_args()
    if args.screenshot_dir is None and os.environ.get('CI', '').lower() == 'true':
        args.screenshot_dir = Path('/tmp')

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
                run_orientation(page, args.engine, args.screenshot_dir)
                run_landscape_recovery(page, args.engine, args.screenshot_dir)
                assert not errors, errors
            except Exception:
                if args.screenshot_dir:
                    args.screenshot_dir.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(args.screenshot_dir / ('sentlog-continuous-camera-'+args.engine+'-failure.png')))
                print('Camera UI at failure:', page.evaluate("""()=>({
                  open:window.SentlogContinuousCamera?.isOpen(),
                  status:document.getElementById('slCameraStatus')?.textContent,
                  count:document.getElementById('slCameraCount')?.textContent,
                  mock:window.cameraMock?{calls:cameraMock.calls,photos:cameraMock.photos,
                    canvasPhotos:cameraMock.canvasPhotos,tracks:cameraMock.tracks.map(t=>t.readyState)}:null
                })"""))
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
