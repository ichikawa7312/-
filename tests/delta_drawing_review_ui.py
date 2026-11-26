"""Native browser checks for the explicit missing-drawing review dialog.

Only a disposable synthetic origin is used. Prepare/confirm callbacks and the
PDF renderer are controlled UI fixtures; database integrity and real PDF-byte
verification belong to the separate drawing-review integration tests. The
dialog, controls, Blob URLs, canvas, focus, and viewport layout are native DOM.
"""
import argparse
import base64
import json
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://sentlog-drawing-review.test"
HTML = """<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px sans-serif;color:#111827;background:#f5f7fa}
main{margin:24px auto;padding:16px;max-width:820px;box-sizing:border-box}
button,input{font:inherit}h1{font-size:22px}</style>
<body><main><h1>セントログ同期・検証用画面</h1>
<section id="sentlogCloudDetails">元の案件・図面・写真を保持した検証用の記録です。</section>
</main></body></html>"""


def fixture_pdf():
    """Small valid PDF for exercising the native Blob fallback link."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"]
    for index in range(3):
        content = (f"BT /F1 18 Tf 50 780 Td (Synthetic drawing page {index + 1}) Tj ET").encode()
        objects.append((f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                        f"/Resources << /Font << /F1 9 0 R >> >> /Contents {4 + index * 2} 0 R >>").encode())
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend((f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
                   f"startxref\n{start}\n%%EOF\n").encode())
    return bytes(result)


HARNESS = r"""({config,pdfBytes})=>{
 const s=window.testState={prepareCalls:0,confirmCalls:0,cancelCalls:0,resumedCalls:0,writes:0,
   prepareMode:'ready',confirmMode:'ready',resumeMode:'ready',pdfMode:'none',auth:true,
   prepareError:'共有ファイルを取得できませんでした。',confirmError:'候補表示後に共有ファイルが変わりました。',
   fileName:'検証橋 一般図.pdf',projectName:'検証橋',
   issueMessage:'以前の図面と同じ内容か確認できないため、候補PDFを確認してください。',
   preparedIds:[],cancelledIds:[],confirmedIds:[],resumeProjects:[],duplicateReleases:[],
   createdUrls:[],revokedUrls:[],pdfOptions:[],pdfPages:[],pdfDestroyed:0,pdfCancelled:0,...config};
 const originalRecords=JSON.stringify({records:5,photoReferences:69,note:'未送信の現場メモ'});
 localStorage.setItem('ui-test-records',originalRecords);
 const prepareGates=[],confirmGates=[],tokens=new Map();
 const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
 URL.createObjectURL=blob=>{const url=createUrl(blob);s.createdUrls.push(url);return url;};
 URL.revokeObjectURL=url=>{s.revokedUrls.push(url);return revokeUrl(url);};
 const bytes=Uint8Array.from(atob(pdfBytes),x=>x.charCodeAt(0));
 const candidate=()=>{const value={id:'candidate-'+s.prepareCalls,key:'background:drawing',
   blob:new Blob([bytes],{type:'application/pdf'}),fileName:s.fileName,drawingName:'橋梁一般図',
   originalSnapshotRevision:1,selectedSnapshotRevision:8};tokens.set(value.id,true);s.preparedIds.push(value.id);return value;};
 const pdfApi={getDocument(options){
   s.pdfOptions.push({isEvalSupported:options.isEvalSupported,enableXfa:options.enableXfa,size:options.data.length});
   const document={numPages:3,async destroy(){s.pdfDestroyed++;},async getPage(number){
     if(s.pdfMode==='page-error'&&number===2)throw Error('Synthetic second page failed');
     s.pdfPages.push(number);return {getViewport:({scale})=>({width:595*scale,height:842*scale}),
       render({canvasContext,viewport}){canvasContext.fillStyle='white';canvasContext.fillRect(0,0,viewport.width,viewport.height);
         canvasContext.strokeStyle='#334155';canvasContext.strokeRect(30,30,viewport.width-60,viewport.height-60);
         canvasContext.fillStyle='#111827';canvasContext.font='30px sans-serif';
         canvasContext.fillText('Synthetic drawing page '+number,50,90);
         canvasContext.font='22px sans-serif';canvasContext.fillText('Read-only preview fixture',50,140);
         return {promise:Promise.resolve(),cancel(){s.pdfCancelled++;}};}};
   }};
   return {promise:s.pdfMode==='load-error'?Promise.reject(Error('Synthetic PDF load failed')):Promise.resolve(document),
     async destroy(){s.pdfDestroyed++;}};
 }};
 const detail=(overrides={})=>({localProjectId:'local-project',projectName:s.projectName,bindingId:'binding-1',
   issues:[{key:'background:drawing',recovery:{reviewable:true,reason:'SNAPSHOT_REVISION_MISMATCH',message:s.issueMessage}}],...overrides});
 const ui=window.reviewUi=SentlogDeltaDrawingReview.create({
   async prepare(entry){s.prepareCalls++;s.lastPrepareEntry=entry;
     if(s.prepareMode==='pending')await new Promise((resolve,reject)=>prepareGates.push({resolve,reject}));
     if(s.prepareMode==='error')throw Error(s.prepareError);return candidate();},
   async confirm(value){s.confirmCalls++;
     if(s.confirmMode==='pending')await new Promise((resolve,reject)=>confirmGates.push({resolve,reject}));
     if(!s.auth||tokens.get(value.id)!==true)throw Error('ログインまたは確認候補が変わりました。');
     if(s.confirmMode==='error')throw Error(s.confirmError);
     s.writes++;s.confirmedIds.push(value.id);localStorage.setItem('ui-test-records',originalRecords+'|confirmed');},
   cancel(value){s.cancelCalls++;s.cancelledIds.push(value.id);if(tokens.get(value.id)!==true)s.duplicateReleases.push(value.id);tokens.set(value.id,false);},
   async onResumed(entry){s.resumedCalls++;s.resumeProjects.push(entry.localProjectId);
     if(s.resumeMode==='error')throw Error('再同期の通信が切れました。');},
   pdf:()=>s.pdfMode==='none'?null:pdfApi
 });
 window.testHarness={detail,resolvePrepare:()=>prepareGates.shift().resolve(),resolveConfirm:()=>confirmGates.shift().resolve(),
   update:overrides=>ui.update(detail(overrides)),authClear:()=>{s.auth=false;ui.clear();},
   unchanged:()=>localStorage.getItem('ui-test-records')===originalRecords};
 ui.update(detail());
}"""

DIALOG = "#sentlogDrawingRecoveryDialog"
OPEN = "#sentlogDrawingRecoveryNotice button"
ACCEPT = "#sentlogDrawingRecoveryConfirm"
BACK = "#sentlogDrawingRecoveryCancel"
CHECK = "#sentlogDrawingRecoveryChecked"
STATUS = f"{DIALOG} [role=status]"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["chromium", "webkit"], default="chromium")
    parser.add_argument("--executable-path")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    output = args.output_dir or Path(tempfile.mkdtemp(prefix="sentlog-delta-app-drawing-review-"))
    output.mkdir(parents=True, exist_ok=True)
    script = (ROOT / "sentlog/delta-sync-drawing-review.js").read_text(encoding="utf-8")
    pdf_bytes = base64.b64encode(fixture_pdf()).decode()
    scenarios, screenshots, unexpected = [], [], []
    with sync_playwright() as playwright:
        launch = {"headless": True}
        if args.executable_path:
            launch["executable_path"] = args.executable_path
        if args.engine == "chromium":
            launch["args"] = ["--no-sandbox"]
        browser = getattr(playwright, args.engine).launch(**launch)
        context = browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route(request):
            if request.request.url.startswith(ORIGIN + "/"):
                request.fulfill(status=200, content_type="text/html", body=HTML)
            elif request.request.url.startswith("blob:" + ORIGIN + "/"):
                # WebKit exposes native Blob reads to interception; this is
                # the fixture's local PDF, not an external network request.
                request.continue_()
            else:
                unexpected.append(request.request.url)
                request.abort()

        context.route("**/*", route)

        def reset(**config):
            assert not errors, errors
            page.goto(ORIGIN + "/fixture", wait_until="domcontentloaded")
            page.add_script_tag(content=script)
            page.evaluate(HARNESS, {"config": config, "pdfBytes": pdf_bytes})
            expect(page.locator(OPEN)).to_have_count(1)
            expect(page.locator(OPEN)).to_be_enabled()

        def unchanged():
            assert page.evaluate("testState.writes") == 0
            assert page.evaluate("testHarness.unchanged()")

        def opened():
            page.locator(OPEN).click()
            expect(page.locator(DIALOG)).to_be_visible()
            expect(page.locator(CHECK)).to_be_visible()

        def passed(name):
            assert not errors, errors
            scenarios.append(name)
            print("PASS", name)

        try:
            reset(prepareMode="pending")
            page.locator(OPEN).click()
            expect(page.locator(DIALOG)).to_be_visible()
            expect(page.locator(STATUS)).to_contain_text("取得し")
            expect(page.locator(ACCEPT)).to_be_disabled()
            expect(page.locator(OPEN)).to_be_disabled()
            page.locator(OPEN).dispatch_event("click")
            assert page.evaluate("testState.prepareCalls") == 1
            assert page.evaluate("testState.confirmCalls") == 0
            unchanged()
            page.evaluate("testHarness.resolvePrepare()")
            expect(page.locator(CHECK)).to_be_visible()
            expect(page.locator(ACCEPT)).to_be_disabled()
            page.locator(ACCEPT).dispatch_event("click")
            assert page.evaluate("testState.confirmCalls") == 0
            page.locator(CHECK).check()
            expect(page.locator(ACCEPT)).to_be_enabled()
            page.locator(CHECK).uncheck()
            expect(page.locator(ACCEPT)).to_be_disabled()
            unchanged()
            page.locator(BACK).click()
            expect(page.locator(DIALOG)).not_to_be_visible()
            assert page.evaluate("testState.cancelCalls") == 1
            assert page.evaluate("testState.confirmCalls") == 0
            assert page.evaluate("testState.createdUrls.length===testState.revokedUrls.length")
            unchanged()
            passed("loading is read-only, duplicate opens are ignored, checkbox is required, cancel only releases")

            reset(confirmMode="pending")
            opened()
            page.locator(CHECK).check()
            page.locator(ACCEPT).click()
            expect(page.locator(ACCEPT)).to_be_disabled()
            expect(page.locator(BACK)).to_be_disabled()
            expect(page.locator(CHECK)).to_be_disabled()
            page.locator(ACCEPT).dispatch_event("click")
            page.locator(BACK).dispatch_event("click")
            page.keyboard.press("Escape")
            expect(page.locator(DIALOG)).to_be_visible()
            assert page.evaluate("testState.confirmCalls") == 1
            unchanged()
            page.evaluate("testHarness.resolveConfirm()")
            page.wait_for_function("testState.resumedCalls===1")
            expect(page.locator(DIALOG)).not_to_be_visible()
            expect(page.locator(OPEN)).to_have_count(0)
            assert page.evaluate("testState.writes") == 1
            assert page.evaluate("testState.confirmedIds") == ["candidate-1"]
            assert page.evaluate("testState.resumeProjects") == ["local-project"]
            assert page.evaluate("testState.duplicateReleases") == []
            passed("explicit accept confirms exactly once and resumes the correct project")

            for phase in ("preview", "loading", "committing"):
                reset(prepareMode="pending" if phase == "loading" else "ready",
                      confirmMode="pending" if phase == "committing" else "ready")
                page.locator(OPEN).click()
                expect(page.locator(DIALOG)).to_be_visible()
                if phase != "loading":
                    expect(page.locator(CHECK)).to_be_visible()
                if phase == "committing":
                    page.locator(CHECK).check()
                    page.locator(ACCEPT).click()
                page.evaluate("testHarness.authClear()")
                expect(page.locator(DIALOG)).not_to_be_visible()
                expect(page.locator("#sentlogDrawingRecoveryNotice")).not_to_be_visible()
                if phase == "loading":
                    page.evaluate("testHarness.resolvePrepare()")
                if phase == "committing":
                    page.evaluate("testHarness.resolveConfirm()")
                page.wait_for_function("testState.cancelCalls===1")
                assert page.evaluate("testState.resumedCalls") == 0
                assert page.evaluate("testState.confirmCalls") == (1 if phase == "committing" else 0)
                unchanged()
            passed("auth clear invalidates preview, late prepare, and pending confirmation without resuming")

            reset(prepareMode="pending")
            page.locator(OPEN).click()
            page.locator(BACK).click()
            page.evaluate("testHarness.resolvePrepare()")
            page.wait_for_function("testState.cancelCalls===1")
            expect(page.locator(DIALOG)).not_to_be_visible()
            assert page.evaluate("testState.confirmCalls") == 0
            unchanged()
            passed("cancel during loading releases a late candidate without opening or saving it")

            reset()
            opened()
            page.keyboard.press("Escape")
            expect(page.locator(DIALOG)).not_to_be_visible()
            assert page.evaluate("testState.cancelCalls") == 1
            assert page.evaluate("testState.confirmCalls") == 0
            unchanged()
            reset()
            opened()
            page.evaluate("reviewUi.clear('different-project')")
            expect(page.locator(DIALOG)).to_be_visible()
            assert page.evaluate("testState.cancelCalls") == 0
            page.evaluate("reviewUi.clear('local-project')")
            expect(page.locator(DIALOG)).not_to_be_visible()
            assert page.evaluate("testState.cancelCalls") == 1
            unchanged()
            passed("Escape cancels and clearing a resolved project releases only its own candidate")

            for phase in ("prepare", "confirm"):
                reset(prepareMode="error" if phase == "prepare" else "ready",
                      confirmMode="error" if phase == "confirm" else "ready")
                page.locator(OPEN).click()
                if phase == "confirm":
                    expect(page.locator(CHECK)).to_be_visible()
                    page.locator(CHECK).check()
                    page.locator(ACCEPT).click()
                expect(page.locator(STATUS)).to_have_text(page.evaluate(f"testState.{phase}Error"))
                expect(page.locator(ACCEPT)).to_be_disabled()
                expect(page.locator(BACK)).to_be_enabled()
                assert page.evaluate("testState.resumedCalls") == 0
                unchanged()
                page.locator(BACK).click()
                expect(page.locator(OPEN)).to_be_enabled()
                assert page.evaluate("testState.duplicateReleases") == []
            passed("remote prepare and confirmation failures remain visible and preserve retry controls")

            reset(resumeMode="error")
            opened()
            page.locator(CHECK).check()
            page.locator(ACCEPT).click()
            expect(page.locator("#sentlogDrawingRecoveryNotice")).to_contain_text("図面は保存済みです")
            expect(page.locator("#sentlogDrawingRecoveryNotice")).to_contain_text("再同期の通信が切れました")
            assert page.evaluate("testState.writes") == 1
            assert page.evaluate("testState.confirmCalls") == 1
            page.evaluate("reviewUi.clear('different-project')")
            expect(page.locator("#sentlogDrawingRecoveryNotice")).to_be_visible()
            page.evaluate("reviewUi.clear('local-project')")
            expect(page.locator("#sentlogDrawingRecoveryNotice")).not_to_be_visible()
            passed("a resume failure reports the already-saved drawing without confirming it again")

            hostile = '<img src=x onerror="window.reviewXss=1"><script>window.reviewXss=2</script>.pdf'
            reset(fileName=hostile, projectName="検証橋 <img src=x onerror=window.reviewXss=3>",
                  issueMessage="確認が必要 <img src=x onerror=window.reviewXss=4>")
            opened()
            expect(page.locator(DIALOG)).to_contain_text(hostile)
            assert page.locator(f"{DIALOG} img,{DIALOG} script,#sentlogDrawingRecoveryNotice img").count() == 0
            assert page.evaluate("window.reviewXss ?? null") is None
            link = page.get_by_role("link", name="PDFを別画面で開く")
            expect(link).to_have_attribute("target", "_blank")
            assert set(link.get_attribute("rel").split()) == {"noopener", "noreferrer"}
            blob_info = link.evaluate("""async link=>{const response=await fetch(link.href),blob=await response.blob();
                return {url:link.href,type:blob.type,size:blob.size,header:(await blob.text()).slice(0,8)};}""")
            assert blob_info["url"].startswith("blob:")
            assert blob_info["type"] == "application/pdf" and blob_info["header"] == "%PDF-1.4"
            assert blob_info["size"] == len(fixture_pdf())
            unchanged()
            passed("literal filenames and messages cannot execute HTML, and the fallback link serves the real Blob")

            for mode in ("load-error", "page-error"):
                reset(pdfMode=mode)
                opened()
                if mode == "page-error":
                    expect(page.locator(f"{DIALOG} canvas")).to_have_attribute("aria-label", "図面のプレビュー 1ページ")
                    page.get_by_role("button", name="次のページ", exact=True).click()
                expect(page.locator(DIALOG)).to_contain_text("プレビューを表示できませんでした")
                expect(page.get_by_role("link", name="PDFを別画面で開く")).to_be_visible()
                expect(page.locator(CHECK)).to_be_enabled()
                unchanged()
                page.locator(BACK).click()
                assert page.evaluate("testState.createdUrls.length===testState.revokedUrls.length")
            passed("PDF load or page-render failure retains the fallback link without unhandled errors")

            reset()
            page.evaluate("testHarness.update({issues:[{key:'background:drawing'}]})")
            expect(page.locator(OPEN)).to_have_count(1)
            page.evaluate("testHarness.update({issues:[{key:'background:drawing',recovery:{reason:'RECOVERY_BATCH_LIMIT',reviewable:false}}]})")
            expect(page.locator(OPEN)).to_have_count(1)
            page.evaluate("testHarness.update({issues:[{key:'background:drawing',recovery:{reason:'DRAWING_SOURCE_MISMATCH',reviewable:false}}]})")
            expect(page.locator(OPEN)).to_have_count(0)
            page.evaluate("testHarness.update({})")
            expect(page.locator(OPEN)).to_have_count(1)
            page.evaluate("testHarness.update({bindingId:'binding-2',issues:[{key:'background:drawing'}]})")
            expect(page.locator(OPEN)).to_have_count(0)
            page.evaluate("testHarness.update({})")
            page.evaluate("testHarness.update({issues:[]})")
            expect(page.locator(OPEN)).to_have_count(0)
            passed("bounded batches retain an eligible entry until resolved, disproved, or rebound")

            for name, width, height in (("desktop", 1280, 900), ("mobile", 390, 844),
                                        ("narrow-mobile", 320, 568), ("landscape", 844, 390)):
                page.set_viewport_size({"width": width, "height": height})
                reset(pdfMode="pages", fileName="検証橋_" + "LongUnbrokenDrawingName" * 16 + ".pdf")
                opened()
                expect(page.locator(f"{DIALOG} canvas")).to_have_attribute("aria-label", "図面のプレビュー 1ページ")
                bounds = page.locator(DIALOG).evaluate("""node=>{const r=node.getBoundingClientRect();return {
                  left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,
                  scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,
                  overflowY:getComputedStyle(node).overflowY,viewportWidth:innerWidth,viewportHeight:innerHeight};}""")
                screenshot = output / f"drawing-review-{args.engine}-{name}.png"
                page.screenshot(path=str(screenshot), full_page=True)
                screenshots.append(str(screenshot))
                assert bounds["left"] >= -1 and bounds["right"] <= width + 1, (name, bounds)
                assert bounds["top"] >= -1 and bounds["bottom"] <= height + 1, (name, bounds)
                assert bounds["scrollWidth"] <= bounds["clientWidth"] + 2, (name, bounds)
                assert bounds["overflowY"] in ("auto", "scroll") and bounds["scrollHeight"] > bounds["clientHeight"], (name, bounds)
                page.get_by_role("button", name="次のページ", exact=True).click()
                expect(page.locator(f"{DIALOG} canvas")).to_have_attribute("aria-label", "図面のプレビュー 2ページ")
                page.get_by_role("button", name="前のページ", exact=True).click()
                expect(page.locator(f"{DIALOG} canvas")).to_have_attribute("aria-label", "図面のプレビュー 1ページ")
                page.locator(ACCEPT).scroll_into_view_if_needed()
                controls = page.locator(ACCEPT).bounding_box()
                assert controls and controls["y"] >= 0 and controls["y"] + controls["height"] <= height + 1, (name, controls)
                expect(page.locator(ACCEPT)).to_be_disabled()
                unchanged()
                page.locator(BACK).click()
                assert page.evaluate("testState.pdfDestroyed") >= 1
                assert page.evaluate("testState.createdUrls.length===testState.revokedUrls.length")
            passed("desktop, mobile, narrow mobile and landscape fit, scroll, navigate and release their native preview")
            assert not errors, errors
            assert not unexpected, unexpected
            report = {"engine": args.engine, "result": "PASS", "scenarios": scenarios,
                      "screenshots": screenshots, "pageErrors": errors, "externalRequests": unexpected,
                      "scope": "Disposable native DOM UI; controlled callbacks and PDF renderer; no user/cloud data"}
            (output / f"drawing-review-{args.engine}-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False))
        except Exception:
            page.screenshot(path=str(output / f"drawing-review-{args.engine}-failure.png"), full_page=True)
            (output / f"drawing-review-{args.engine}-failure.json").write_text(
                json.dumps({"passed": scenarios, "pageErrors": errors, "externalRequests": unexpected},
                           ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print("UI failure artifacts:", output)
            raise
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
