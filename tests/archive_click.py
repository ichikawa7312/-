"""Regression checks for the archive click/wait/error paths; only synthetic data."""
import os
from playwright.sync_api import sync_playwright, expect
from archive_ui_fixture import make_page, ROOT

def request_count(page, action):
    return page.evaluate('(action)=>calls.filter(x=>x.body?.p_action===action).length', action)

def click_start(page):
    page.get_by_role('button', name='保管へ移す', exact=True).first.click()
    expect(page.locator('#slArchiveDialog')).to_be_visible()

with sync_playwright() as p:
    opts={'headless':True}
    if os.path.exists('/usr/bin/chromium'):
        opts.update(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    browser=p.chromium.launch(**opts)
    checks=[]
    # Real click handlers and native dialog at phone, tablet and desktop widths.
    for width in [320,390,768,1280]:
        page=make_page(browser,width)
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        before=page.evaluate('JSON.stringify(workspace)')
        click_start(page)
        expect(page.locator('#slArchiveJobBody')).to_contain_text('会社PC')
        expect(page.locator('#slArchiveFinalize')).to_be_disabled()
        expect(page.locator('#slArchiveCancel')).to_be_enabled()
        assert request_count(page,'begin')==1 and request_count(page,'finalize')==0
        assert page.evaluate('syncCalls')==0
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        # Errors stay visible INSIDE the modal, not behind it on the list.
        page.evaluate("window.failAction='cancel'")
        page.locator('#slArchiveCancel').click()
        expect(page.locator('#slArchiveDialogMsg')).to_contain_text('通信エラー')
        expect(page.locator('#slArchiveCancel')).to_be_enabled()
        page.evaluate('window.failAction=null')
        page.locator('#slArchiveCancel').click()
        expect(page.locator('#slArchiveDialog')).not_to_be_visible()
        assert page.evaluate('JSON.stringify(workspace)')==before and not errors
        page.close();checks.append(f'click/dialog/error/cancel {width}px')

    page=make_page(browser,390,init='window.sentlogCloudIdle=()=>new Promise(resolve=>{window.releaseIdle=resolve});')
    page.clock.install()
    click_start(page)
    expect(page.locator('#slArchiveJobBody')).to_contain_text('現在の同期')
    assert request_count(page,'begin')==0
    expect(page.locator('#slArchiveRetry')).to_be_disabled()
    (ROOT/'test-results').mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT/'test-results/archive-wait-390.png'),full_page=True)
    page.clock.run_for(15010)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('同期処理が続いているため')
    expect(page.locator('#slArchiveRetry')).to_be_enabled()
    # A late completion must not continue into begin after timeout.
    page.evaluate('()=>{window.releaseIdle()}');page.wait_for_timeout(100)
    assert request_count(page,'begin')==0
    page.evaluate('()=>{window.sentlogCloudIdle=async()=>{}}')
    page.locator('#slArchiveRetry').click()
    expect(page.locator('#slArchiveCancel')).to_be_enabled()
    assert request_count(page,'begin')==1
    page.close();checks.append('immediate progress, timeout, late completion, retry')

    page=make_page(browser,init='window.sentlogArchiveSync=()=>{window.syncCalls++;return new Promise(()=>{})};')
    click_start(page)
    expect(page.locator('#slArchiveCancel')).to_be_enabled()
    assert page.evaluate('syncCalls')==0
    page.close();checks.append('archive click no longer launches/waits for full-project sync')

    page=make_page(browser,init="workspace.projects[0].name='未同期の編集';")
    click_start(page)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('未同期の記録')
    expect(page.locator('#slArchiveRetry')).to_be_enabled()
    assert request_count(page,'begin')==0
    page.close();checks.append('unsynced changes visible and blocked')

    page=make_page(browser,init="Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true});")
    click_start(page)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('オンライン')
    assert request_count(page,'begin')==0
    page.close();checks.append('offline reason visible')

    page=make_page(browser)
    page.evaluate("localStorage.removeItem('sentlogCloudSessionV1')")
    click_start(page)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('ログイン')
    assert request_count(page,'begin')==0
    page.close();checks.append('signed-out reason visible')

    page=make_page(browser,init="window.failAction='begin';")
    click_start(page)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('通信エラー')
    expect(page.locator('#slArchiveRetry')).to_be_enabled()
    assert request_count(page,'finalize')==0
    page.close();checks.append('server rejection visible; no finalization')

    page=make_page(browser)
    page.evaluate('''()=>{
        const original=fetch;
        window.fetch=(url,options)=>{
          if(!String(url).includes('sentlog_project_snapshots?'))return original(url,options);
          window.snapshotFetchStarted=true;
          return new Promise((resolve,reject)=>{
            const abort=()=>reject(new DOMException('Aborted','AbortError'));
            if(options.signal.aborted)abort();
            else options.signal.addEventListener('abort',abort,{once:true});
          });
        };
    }''')
    page.clock.install();click_start(page)
    # The dialog opens before asynchronous preflight. Start the fake 20-second
    # network wait only AFTER the request has actually installed its abort timer.
    page.wait_for_function('window.snapshotFetchStarted===true')
    page.clock.run_for(20500)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('通信の応答を確認できませんでした')
    expect(page.locator('#slArchiveRetry')).to_be_enabled()
    assert request_count(page,'begin')==0
    page.close();checks.append('network abort explained, retry enabled')

    page=make_page(browser)
    # A response can be lost after the server begins a check. Retrying must inspect
    # the existing job rather than create or finalize another one.
    page.evaluate('''()=>{const original=fetch;let lost=false;
      window.fetch=async(url,opts)=>{const r=await original(url,opts);
        if(!lost&&opts.body&&JSON.parse(opts.body).p_action==='begin'){lost=true;throw Error('試験用：応答未受信');}
        return r;};}''')
    click_start(page)
    expect(page.locator('#slArchiveDialogMsg')).to_contain_text('応答未受信')
    page.locator('#slArchiveRetry').click()
    expect(page.locator('#slArchiveCancel')).to_be_enabled()
    assert request_count(page,'begin')==1 and request_count(page,'finalize')==0
    page.close();checks.append('lost begin response can safely resume the existing check')

    page=make_page(browser)
    page.get_by_role('button',name='保管へ移す',exact=True).first.focus()
    page.keyboard.press('Enter')
    expect(page.locator('#slArchiveDialog')).to_be_visible()
    expect(page.locator('#slArchiveCancel')).to_be_enabled()
    assert request_count(page,'finalize')==0
    page.close();checks.append('keyboard activation')

    browser.close()
    for check in checks:print('PASS',check)
    print(f'Archive click regression scenarios passed: {len(checks)}')
