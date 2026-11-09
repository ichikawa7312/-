"""Real generated Sentlog page: photo auto-trace becomes ordinary field damage records."""
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
        args={'headless':True}
        if os.path.exists('/usr/bin/chromium'):
            args.update(executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        browser=pw.chromium.launch(**args)
        page=browser.new_page(viewport={'width':390,'height':844},service_workers='block',accept_downloads=True)
        errors=[]
        logs=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:logs.append(m.type+': '+m.text))
        def route(request):
            url=request.request.url
            if url.startswith(origin) or url.startswith('blob:'):
                request.continue_()
            elif url.startswith('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'):
                lib=ROOT/'sentlog/vendor'/('export-'+url.rsplit('/',1)[-1])
                if lib.is_file():request.fulfill(content_type='text/javascript',body=lib.read_bytes())
                else:request.abort()
            else:request.abort()
        page.route('**/*',route)
        page.goto(origin+'/sentlog/')
        try:
            page.wait_for_function("!!window.SentlogAutoTrace && !!window.sentlogAppReady",timeout=18000)
        except Exception:
            print('AUTO_TRACE_BOOT_DIAGNOSTIC',page.evaluate("""()=>({url:location.href,title:document.title,body:document.body?.innerText?.slice(0,1400),ready:!!window.sentlogAppReady,autoTrace:!!window.SentlogAutoTrace,core:!!window.SentlogAutoTraceCore,loader:document.querySelectorAll('script[src*=auto-trace]').length,style:!!document.getElementById('slAutoTraceStyle'),button:!!document.getElementById('slAutoTraceButton'),photoInput:!!document.getElementById('slAutoTraceCamera'),hasToolbar:!!document.querySelector('#editorView .toolbar'),scripts:[...document.querySelectorAll('script[src]')].slice(-14).map(x=>x.src)})"""),flush=True)
            print('AUTO_TRACE_BOOT_ERRORS',errors,flush=True)
            print('AUTO_TRACE_BOOT_CONSOLE',logs[-30:],flush=True)
            raise
        page.evaluate("async()=>{await window.sentlogAppReady}")
        page.evaluate("""()=>{
          const p={id:'trace-project',name:'自動描写テスト',drawings:[{
            id:'trace-drawing',name:'壁面図',sourceType:'image',fileName:'壁面図.png',pageCount:1,createdAt:1,updatedAt:1
          }]};
          workspace={projects:[p]};activeProjectId=p.id;activeDrawingId='trace-drawing';
          state=freshDrawingState(p.name);state.sourceType='image';state.fileName='壁面図.png';
          currentView='editor';showEditor();setupStage(900,600);
          document.getElementById('damageType').value='ひび割れ';render();
        }""")
        assert page.locator('#slAutoTraceButton').count()==1
        def photo_file():
            page.evaluate("""async()=>{
              const c=document.createElement('canvas');c.width=270;c.height=175;
              const g=c.getContext('2d');g.fillStyle='#696969';g.fillRect(0,0,c.width,c.height);
              g.strokeStyle='#faf9f7';g.lineWidth=5;g.lineJoin='round';g.lineCap='round';
              g.beginPath();g.moveTo(25,10);
              for(let y=10;y<=157;y+=3)g.lineTo(25+7*Math.sin(y/16),y);
              g.stroke();
              g.beginPath();g.rect(119,28,101,115);g.stroke();
              g.beginPath();g.moveTo(135,119);g.lineTo(197,53);g.stroke();
              const blob=await new Promise(ok=>c.toBlob(ok,'image/png'));
              const data=new DataTransfer();data.items.add(new File([blob],'white-chalk.png',{type:'image/png'}));
              const target=document.getElementById('slAutoTraceCamera');target.files=data.files;
              target.dispatchEvent(new Event('change',{bubbles:true}));
            }""")
        def tap_chalk(x,y):
            picture=page.locator('.sl-trace-canvas')
            picture.scroll_into_view_if_needed()
            bb=picture.bounding_box()
            assert bb and bb['width']>20 and bb['height']>20,bb
            page.mouse.click(bb['x']+bb['width']*x/270,bb['y']+bb['height']*y/175)
        photo_file()
        page.wait_for_function("document.querySelector('.sl-trace-status')?.textContent.includes('白チョークの線を1か所タップ')",timeout=15000)
        assert page.locator('.sl-trace-row').count()==0,'No whole-photo detection before an explicit chalk tap.'
        assert page.locator('.sl-trace-seed-info').inner_text().startswith('0か所指定済み')
        assert page.locator('.sl-trace-seedbar button').count()==2
        assert page.locator('.sl-trace-seedbar button').first.get_attribute('aria-pressed')=='true'
        tap_chalk(77,80)
        assert page.locator('.sl-trace-row').count()==0,'Tapping blank image must not find distant lines.'
        assert '確認できませんでした' in page.locator('.sl-trace-status').inner_text()
        tap_chalk(20,65)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=1",timeout=10000)
        assert all('ひび割れ線' in x for x in page.locator('.sl-trace-row').all_text_contents()),'Only the clicked crack is recognized.'
        first_count=page.locator('.sl-trace-row').count()
        tap_chalk(20,65)
        assert page.locator('.sl-trace-row').count()==first_count,'Tapping the same stroke twice must not duplicate it.'
        tap_chalk(168,28)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=10000)
        assert any('囲い' in x for x in page.locator('.sl-trace-row').all_text_contents())
        assert page.locator('.sl-trace-footer > .sl-trace-actions input[type=checkbox]').count()==0,'Source photos must never auto-attach to all shapes.'
        assert page.evaluate('state.autoTracePhotos.length')==1,'Source image must already be saved before confirmation.'
        original=page.evaluate("""async()=>{
          const id=state.autoTracePhotos[0].id;
          const saved=JSON.parse(window.SentlogRecords.getItem(drawingStorageKey('trace-drawing')));
          const [shared,original]=await Promise.all([
            getPhotoBlob(id,'trace-drawing'),
            window.SentlogOriginalPhotos.getOriginal('trace-drawing',id)
          ]);
          return {indexed:saved.autoTracePhotos?.length||0,shared:shared?.size||0,original:original?.size||0};
        }""")
        assert original['indexed']==1 and original['shared']>0 and original['original']>0,original
        # The candidate cards are available, but start collapsed to leave room for the photograph.
        assert page.locator('.sl-trace-candidates-panel').count()==1
        assert page.locator('.sl-trace-candidates-panel').get_attribute('open') is None
        assert not page.locator('.sl-trace-row').first.is_visible()
        assert page.locator('.sl-trace-scroll').bounding_box()['height'] >= 120
        # No redundant title, no zoom/undo footer row: all four controls share one safe header.
        assert page.locator('.sl-trace-header h2').count()==0
        assert page.locator('.sl-trace-header button').all_text_contents()==['− 縮小','＋ 拡大','↶ 取消','← 戻る']
        assert page.locator('.sl-trace-footer .sl-trace-zoom').count()==0
        assert page.locator('.sl-trace-header .sl-trace-zoom').count()==1
        assert page.locator('.sl-trace-canvas').evaluate("e=>e.style.width")=='100%'
        page.get_by_role('button',name='写真を拡大').click()
        assert page.locator('.sl-trace-canvas').evaluate("e=>e.style.width")=='150%'
        page.get_by_role('button',name='写真を縮小').click()
        assert page.locator('.sl-trace-canvas').evaluate("e=>e.style.width")=='100%'
        assert page.get_by_role('button',name='直前の編集を取り消す').is_enabled(),'Undo now also supports explicit chalk seeds.'
        assert page.locator('.sl-trace-seedbar').is_visible()
        assert page.locator('.sl-trace-seed-info').inner_text().startswith('2か所指定済み')
        # The original seven editing modes are retained alongside the seed tool.
        # All seven photo-edit commands must remain in one row on smaller phones.
        buttons=page.locator('.sl-trace-modes [data-mode]')
        assert buttons.count()==7
        assert buttons.all_text_contents()==['修正','消去','＋線','＋囲い','基準','範囲','移動']
        for width in (320,360,390,768):
            page.set_viewport_size({'width':width,'height':844})
            layout=page.evaluate("""()=>{
              const menu=document.querySelector('.sl-trace-modes'),r=menu.getBoundingClientRect();
              return [...menu.querySelectorAll('button')].map(b=>{
                const x=b.getBoundingClientRect();
                return {top:x.top,bottom:x.bottom,left:x.left,right:x.right,
                        text:b.innerText,scroll:b.scrollWidth,client:b.clientWidth,
                        visible:x.width>25&&x.height>=39,containerLeft:r.left,containerRight:r.right};
              });
            }""")
            assert len(layout)==7,(width,layout)
            assert len({round(b['top']) for b in layout})==1,(width,layout)
            assert all(b['visible'] and b['left']>=b['containerLeft']-1 and b['right']<=b['containerRight']+1 for b in layout),(width,layout)
            assert all(b['scroll']<=b['client']+2 for b in layout),(width,layout)
            back=page.locator('.sl-trace-header .sl-trace-back').bounding_box()
            assert back and back['height']>=48 and back['width']>=82,(width,back)
            if width<=520: assert back['y']>=56,(width,back)
            header=page.locator('.sl-trace-header')
            hb=header.locator('button')
            assert hb.count()==4,(width,hb.count())
            head=header.bounding_box()
            rects=[b.bounding_box() for b in hb.all()]
            assert all(r and r['height']>=44 and r['width']>=44 for r in rects),(width,rects)
            assert len({round(r['y']) for r in rects})==1,(width,rects)
            assert all(r['x']>=head['x']-1 and r['x']+r['width']<=head['x']+head['width']+1 for r in rects),(width,rects,head)
            assert all(hb.nth(i).evaluate("e=>e.scrollWidth<=e.clientWidth+2") for i in range(4)),(width,rects)
        page.set_viewport_size({'width':390,'height':844})
        for mode in ('erase','add-line','add-area','ref','region','pan','edit'):
            item=page.locator('.sl-trace-modes [data-mode="'+mode+'"]')
            assert item.get_attribute('title')
            item.click()
            assert item.get_attribute('aria-pressed')=='true',mode

        page.locator('.sl-trace-settings summary').click()
        page.locator('.sl-trace-detect select').select_option('strict')
        page.locator('.sl-trace-detect').get_by_role('button',name='再認識').click()
        assert '厳しめ' in page.locator('.sl-trace-status').inner_text()
        # Draw a detection window around the chalk curve, excluding the distant hatched area.
        page.locator('.sl-trace-detect').get_by_role('button',name='範囲指定').click()
        picture=page.locator('.sl-trace-canvas')
        picture.scroll_into_view_if_needed()
        bb=picture.bounding_box()
        assert bb and bb['height']>50,bb
        page.mouse.move(bb['x']+bb['width']*.025,bb['y']+bb['height']*.04)
        page.mouse.down()
        page.mouse.move(bb['x']+bb['width']*.40,bb['y']+bb['height']*.95,steps=9)
        page.mouse.up()
        page.wait_for_function("document.querySelector('.sl-trace-status')?.textContent.includes('指定範囲のみ') && document.querySelectorAll('.sl-trace-row').length>=1",timeout=10000)
        # Branches in a single hand-drawn crack may become separate short line segments;
        # the selected region must exclude the distant outlined and hatched area.
        assert page.locator('.sl-trace-row').count()<=5
        assert all('ひび割れ線' in text for text in page.locator('.sl-trace-row').all_text_contents())
        assert page.evaluate('state.shapes.length')==0
        page.locator('.sl-trace-settings summary').click()
        page.locator('.sl-trace-detect').get_by_role('button',name='全体に戻す').click()
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=15000)
        # Reproduce an iPhone PWA status bar / Dynamic Island obscuring the top.
        # The exit button must be below the occlusion, visible and finger-sized.
        page.evaluate("""()=>{
          document.documentElement.style.setProperty('--sl-trace-safe-top','64px');
          const occluder=document.createElement('div');occluder.id='slStatusBarFixture';
          occluder.style.cssText='position:fixed;top:0;left:0;right:0;height:64px;z-index:2000;background:#111;pointer-events:auto;';
          document.body.appendChild(occluder);
        }""")
        back=page.locator('.sl-trace-header .sl-trace-back')
        bounds=back.bounding_box()
        assert bounds and bounds['y']>=69 and bounds['height']>=48,bounds
        assert back.get_attribute('title')=='図面に戻る（未確定の候補は破棄）'
        back.click(timeout=5000)
        page.evaluate("""()=>{
          document.getElementById('slStatusBarFixture')?.remove();
          document.documentElement.style.removeProperty('--sl-trace-safe-top');
        }""")
        assert page.locator('.sl-trace-modal').count()==0
        assert page.evaluate('state.shapes.length')==0
        assert page.evaluate('state.autoTracePhotos.length')==1,'Closing an unconfirmed trace must preserve its photo.'
        photo_file()
        page.wait_for_function("document.querySelector('.sl-trace-status')?.textContent.includes('白チョークの線を1か所タップ')",timeout=15000)
        assert page.locator('.sl-trace-row').count()==0,'Second image also starts with zero guesses.'
        tap_chalk(20,65)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=1",timeout=10000)
        tap_chalk(168,28)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=10000)
        # Reset drops the unconfirmed recognition but does not discard the saved photo.
        page.locator('.sl-trace-seedbar').get_by_role('button',name='指定を消去').click()
        assert page.locator('.sl-trace-row').count()==0
        assert page.locator('.sl-trace-seed-info').inner_text().startswith('0か所指定済み')
        assert page.evaluate('state.autoTracePhotos.length')==2
        tap_chalk(20,65)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=1",timeout=10000)
        tap_chalk(168,28)
        page.wait_for_function("document.querySelectorAll('.sl-trace-row').length>=2",timeout=10000)
        assert page.evaluate('state.autoTracePhotos.length')==2,'Second capture stays as another source photo.'
        assert page.locator('.sl-trace-candidates-panel').get_attribute('open') is None
        page.locator('.sl-trace-candidates-panel summary').click()
        assert page.locator('.sl-trace-row').first.is_visible()
        page.locator('.sl-trace-row').filter(has_text='囲い').first.locator('select').select_option('剥離')
        line_row=page.locator('.sl-trace-row').filter(has_text='ひび割れ線').first
        assert line_row.count()==1
        line_row.click()
        page.get_by_role('button',name='選択線を基準').click()
        photo_length=page.locator('.sl-trace-set input[type=number]')
        photo_length.fill('1.200')
        photo_length.dispatch_event('change')
        assert '基準設定済み' in page.locator('.sl-trace-set').inner_text()
        page.get_by_role('button',name='図面に仮配置').click()
        assert page.locator('.sl-trace-placepanel').is_visible()
        assert page.evaluate('state.shapes.length')==0,'Nothing is stored before placement confirmation.'
        page.get_by_role('button',name='確定して変状登録').click()
        page.wait_for_function("state.shapes.length>=2",timeout=15000)
        result=page.evaluate("""()=>state.shapes.map(s=>({
          kind:s.kind,type:s.type,points:s.points.length,len:s.lineLengthM||null,
          id:s.id,page:s.page,hasRecordKind:!!s.recordKind,photos:s.photos.length,
          sourceAutoTracePhotoId:s.sourceAutoTracePhotoId
        }))""")
        assert any(s['kind']=='freehand-line' and s['len']>0 for s in result),result
        assert any(s['kind']=='freehand-area' and s['type']=='剥離' for s in result),result
        assert all(not s['hasRecordKind'] and s['page']==1 and s['id'] for s in result),result
        assert all(s['photos']==0 for s in result),'Auto trace source photos must not enter the ledger.'
        assert all(s['sourceAutoTracePhotoId'] for s in result),'Origin must remain traceable without attaching photos.'
        assert len({s['sourceAutoTracePhotoId'] for s in result})==1
        assert page.evaluate("""()=>{
          const raw=window.SentlogRecords.getItem(drawingStorageKey('trace-drawing'));
          const saved=JSON.parse(raw);
          return saved.shapes.length===state.shapes.length &&
                 saved.autoTracePhotos?.length===2 &&
                 saved.shapes.every(s=>s.photos.length===0);
        }""")
        # Explicitly select a single photo for a single damage, rather than auto-adding it to all.
        assert page.locator('#slAutoAlbumPick').count()==1
        page.evaluate("document.getElementById('slAutoAlbumPick').click()")
        page.wait_for_function("document.querySelectorAll('.sl-album-photo').length===2",timeout=10000)
        assert page.locator('.sl-album-photo').count()==2
        assert '壁面図' in page.locator('.sl-album-group summary').first.inner_text()
        page.locator('.sl-album-photo').first.get_by_role('button',name='選択中の変状に添付').click()
        page.wait_for_function("state.shapes.filter(s=>s.photos.length===1).length===1",timeout=10000)
        assert page.evaluate("state.shapes.filter(s=>s.photos.length===1).length") == 1
        assert page.evaluate("state.shapes.filter(s=>s.photos.length===0).length") == len(result)-1
        page.locator('.sl-album-modal').get_by_role('button',name='閉じる').click()
        page.evaluate('undo()')
        assert page.evaluate("state.shapes.every(s=>s.photos.length===0)"),'Undo removes only the explicit attachment.'
        page.evaluate('undo()')
        assert page.evaluate('state.shapes.length')==0,'Next undo reverts all traced shapes.'
        assert page.evaluate('state.autoTracePhotos.length')==2,'Editing undo must not delete independently stored photos.'

        # Album is a button next to ledger/rename/delete within EVERY drawing No.,
        # not a project-sized folder card. Sheets sharing 01 belong to the same album.
        page.evaluate("""async()=>{
          const p=getProject('trace-project'),first=p.drawings[0];
          const groupId=first.groupId||first.id,groupName=first.groupName||first.name;
          const shared=await getPhotoBlob(state.autoTracePhotos[0].id,first.id);
          const additions=[
            {id:'trace-other-sheet',name:'裏面図',sheetName:'裏面図',groupId,groupName,sheetOrder:2,
             fileName:'reverse.png',sourceType:'image',pageCount:1,shapeCount:0,photoCount:0},
            {id:'trace-group-02-sheet',name:'02_立面',sheetName:'立面',groupId:'trace-group-02',groupName:'02',sheetOrder:1,
             fileName:'elevation.png',sourceType:'image',pageCount:1,shapeCount:0,photoCount:0}
          ];
          for(const d of additions){
            const photoId='album-'+d.id,photo={id:photoId,name:d.name+'.jpg',createdAt:Date.now(),type:shared.type,size:shared.size,page:1};
            await savePhotoBlob(photoId,shared,d.id);
            const st={...freshDrawingState(p.name),sourceType:'image',fileName:d.fileName,autoTracePhotos:[photo]};
            window.SentlogRecords.setItem(drawingStorageKey(d.id),JSON.stringify(st));
            p.drawings.push({...d,createdAt:Date.now(),updatedAt:Date.now()});
          }
          saveWorkspace();
        }""")
        page.evaluate("showDrawings('trace-project')")
        assert page.locator('[data-sl-auto-album]').count()==0,'No standalone album card at the same level as drawing No.'
        cards=page.locator('#drawingsGrid .manager-card[data-drawing-group-id]')
        assert cards.count()==2,'01 (two sheets) and 02 (one sheet) should be the only group cards.'
        # Identify cards by stable group ID, not text matching: updated time or photo
        # labels can legitimately contain '02' and match both cards.
        group01=page.locator('#drawingsGrid [data-drawing-group-id="trace-drawing"]')
        group02=page.locator('#drawingsGrid [data-drawing-group-id="trace-group-02"]')
        assert group01.count()==1 and group02.count()==1
        assert group01.locator('.drawing-group-actions [data-sl-auto-album-button]').count()==1
        assert group02.locator('.drawing-group-actions [data-sl-auto-album-button]').count()==1
        assert '3枚' in group01.locator('[data-sl-auto-album-button]').inner_text()
        assert '1枚' in group02.locator('[data-sl-auto-album-button]').inner_text()
        for card in (group01,group02):
            actions=card.locator('.drawing-group-actions')
            assert actions.get_by_role('button',name='写真台帳（Excel）').count()==1
            assert actions.get_by_role('button',name='名前変更').count()==1
            assert actions.get_by_role('button',name='削除').count()==1
            assert actions.locator('[data-sl-auto-album-button]').is_visible()
            assert actions.locator('[data-sl-auto-album-button]').bounding_box()['height']>=40

        # Card action buttons must be an even 2×2 grid across PC / iPad / phone.
        # In particular, no lone ledger button or a lone Delete button on the right.
        for width in (320,390,760,1024,1280):
            page.set_viewport_size({'width':width,'height':844})
            layout=page.evaluate("""()=>{
              const parent=document.querySelector('#drawingsGrid [data-drawing-group-id] .sl-album-actions');
              const names=['[data-ledger-button]','[data-sl-auto-album-button]','.rename','.delete'];
              const outer=parent.getBoundingClientRect();
              const children=names.map(selector=>{
                const element=parent.querySelector(selector),r=element.getBoundingClientRect();
                return {text:element.textContent,x:r.x,y:r.y,w:r.width,h:r.height,
                        right:r.right,bottom:r.bottom,scroll:element.scrollWidth,client:element.clientWidth};
              });
              return {display:getComputedStyle(parent).display,columns:getComputedStyle(parent).gridTemplateColumns,
                      outer:{x:outer.x,right:outer.right},children};
            }""")
            buttons2=layout['children']
            assert layout['display']=='grid',(width,layout)
            assert len(layout['columns'].split())==2,(width,layout)
            assert len(buttons2)==4,(width,layout)
            assert abs(buttons2[0]['y']-buttons2[1]['y'])<2,(width,layout)
            assert abs(buttons2[2]['y']-buttons2[3]['y'])<2,(width,layout)
            assert buttons2[2]['y']>=buttons2[0]['bottom']+5,(width,layout)
            assert abs(buttons2[0]['x']-buttons2[2]['x'])<2,(width,layout)
            assert abs(buttons2[1]['x']-buttons2[3]['x'])<2,(width,layout)
            assert all(b['h']>=43.5 and b['w']>=70 for b in buttons2),(width,layout)
            assert all(b['x']>=layout['outer']['x']-1 and b['right']<=layout['outer']['right']+1 for b in buttons2),(width,layout)
            assert all(b['scroll']<=b['client']+2 for b in buttons2),(width,layout)
        page.set_viewport_size({'width':390,'height':844})

        # Reordering hides card actions, preserving dedicated drag/up/down UI.
        page.locator('#slDrawingOrderToolbar [data-role=toggle]').click()
        assert page.locator('#drawingsGrid.sl-order-edit').count()==1
        assert not group01.locator('.drawing-group-actions').is_visible()
        page.locator('#slDrawingOrderToolbar [data-role=toggle]').click()
        assert group01.locator('.drawing-group-actions').is_visible()

        group01.locator('[data-sl-auto-album-button]').click()
        page.wait_for_function("document.querySelectorAll('.sl-album-photo').length===3",timeout=10000)
        assert page.locator('.sl-album-group').count()==1
        assert '壁面図' in page.locator('.sl-album-group summary').inner_text()
        assert page.locator('.sl-album-sheet').count()==2,'Both 01 sheets must be visible.'
        assert page.evaluate('currentView')=='drawings','Album action must not open the drawing editor.'
        assert page.locator('.sl-album-photo button').count()==0,'No automatic photo attachment when browsing project albums.'
        page.locator('.sl-album-modal').get_by_role('button',name='閉じる').click()

        group02.locator('[data-sl-auto-album-button]').click()
        page.wait_for_function("document.querySelectorAll('.sl-album-photo').length===1",timeout=10000)
        assert page.locator('.sl-album-group').count()==1
        assert '02' in page.locator('.sl-album-group summary').inner_text()
        assert '立面' in page.locator('.sl-album-sheet').inner_text()
        assert page.evaluate('currentView')=='drawings'
        page.locator('.sl-album-modal').get_by_role('button',name='閉じる').click()
        page.evaluate('renderDrawings()')
        assert page.locator('[data-sl-auto-album-button]').count()==2,'Rerender must not duplicate album buttons.'
        assert page.locator('[data-sl-auto-album]').count()==0
        assert not errors,errors
        browser.close()
        print('PASS generated Sentlog page: 2x2 desktop/mobile action grid, sorting visibility, group-specific photo album, preservation and undo')
finally:
    server.shutdown()
