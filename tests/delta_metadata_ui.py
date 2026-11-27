"""Compare v212 and the current metadata dialog in native browser DOM.

All records and API responses are synthetic. The unmodified dialog modules run
against controlled materialize/resolve callbacks; no database/cloud is used.
Native input is split at an explicitly awaited identical projection update.
This demonstrates a possible interruption, not the timing of a past CI failure.
"""
import argparse
import hashlib
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://sentlog-metadata-ui.test"
BASELINE_SHA256 = "52acebec90f25476133a6e3110b75063f9475753a3f12056272cac5ddfba9b03"
DIALOG = "#sentlogDeltaMetadataDialog"
NOTICE = "#sentlogDeltaMetadataNotice button"
MEMBERSHIP_CHOICE = "図面を残す（別端末の記録も保持）"
HTML = """<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px sans-serif}button{font:inherit}</style>
<body><main>合成データによる図面設定の操作検証</main></body></html>"""

HARNESS = r"""async ({membership})=>{
 const copy=value=>structuredClone(value);
 const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
   ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 const s=window.metadataProbeState={calls:[],writes:0,mode:'normal',events:[],mark:null,release:null};
 s.cp={id:'synthetic-cloud-project',client_key:'synthetic-project',name:'Synthetic project',status:'active'};
 s.projection={project:{id:'synthetic-project',name:'Synthetic fallback project'},
   drawings:[{meta:{id:'synthetic-drawing',name:'Synthetic drawing'},state:{shapes:[]}}],
   metadataRecords:{'synthetic-document':{id:'synthetic-document',
     collab:{version:1,fields:{scale:{revisions:[{id:'left-head',value:150},{id:'right-head',value:175}]}}},
     display:{state:{pageSettings:{'1':{scale:125}}}}}},
   metadataConflicts:[{kind:'metadata-field',recordId:'synthetic-document',drawingId:'synthetic-drawing',
     path:['state','pageSettings','1','scale'],headIds:['left-head','right-head'],
     expectedToken:'synthetic-token-1',recordTokens:{retained:'synthetic-record-token-1'},
     candidates:[{value:{type:'value',value:150},actor:{deviceName:'Synthetic A'}},
       {value:{type:'value',value:175},actor:{deviceName:'Synthetic B'}}]}]};
 if(membership){const c=s.projection.metadataConflicts[0];c.kind='metadata-membership';c.path=[];
   c.recordIds=['retained'];c.candidates=[];}
 const conflict=()=>s.projection.metadataConflicts[0];
 const document=()=>s.projection.metadataRecords[conflict().recordId];
 const guard=()=>{const c=conflict();return {kind:c.kind,recordId:c.recordId,path:copy(c.path),
   expectedHeads:copy(c.headIds),expectedDocument:copy(document().collab),
   expectedToken:c.expectedToken,expectedRecordTokens:copy(c.recordTokens)};};
 window.SentlogDeltaMetadata={materializeDocument:async value=>copy(value.display)};
 window.sentlogDeltaRuntime={resolveMetadata:async(cp,options)=>{
   const call={cp:copy(cp),options:copy(options),status:'started'};s.calls.push(call);
   if(s.mode==='pending')await new Promise(resolve=>{s.release=resolve;});
   const actualGuard=Object.fromEntries(Object.keys(guard()).map(key=>[key,options[key]]));
   call.guardMatches=canonical(actualGuard)===canonical(guard())&&canonical(cp)===canonical(s.cp);
   if(!call.guardMatches){call.status='rejected';throw Object.assign(Error('Synthetic stale metadata rejected'),{code:'DELTA_METADATA_STALE'});}
   s.writes++;call.status='saved';return {saved:true};
 }};
 const serials=new WeakMap();let nextSerial=0;
 const serial=node=>{if(!node)return null;if(!serials.has(node))serials.set(node,++nextSerial);return serials.get(node);};
 const describe=node=>node?{serial:serial(node),tag:node.tagName||null,id:node.id||null,
   text:(node.textContent||'').slice(0,160)}:null;
 const dialog=()=>window.document.querySelector('#sentlogDeltaMetadataDialog');
 const choices=()=>[...dialog().querySelector('div').querySelectorAll('button')];
 const choice=label=>choices().find(node=>node.textContent===label);
 const notice=()=>window.document.querySelector('#sentlogDeltaMetadataNotice button');
 const status=()=>dialog().querySelector('p[role=status]').textContent;
 for(const type of ['pointerdown','mousedown','pointerup','mouseup','click','focusin','focusout']){
   window.document.addEventListener(type,event=>s.events.push({type,trusted:event.isTrusted,
     target:describe(event.target),markedTarget:event.target===s.mark?.button}),true);
 }
 window.metadataProbe={
   mark(label){s.mark={button:choice(label),notice:notice(),label};s.events=[];return this.snapshot();},
   async update(kind='same'){
     s.cp=copy(s.cp);s.projection=copy(s.projection);
     const c=conflict(),d=document();
     if(kind==='unrelated')s.projection.drawings[0].state.shapes.push({id:'unrelated-record',memo:'new unrelated note'});
     else if(kind==='reordered-document')d.collab=Object.fromEntries(Object.entries(d.collab).reverse());
     else if(kind==='heads')c.headIds=[...c.headIds,'new-head'];
     else if(kind==='document')d.collab.fields.scale.revisions.push({id:'guard-only-head',value:150});
     else if(kind==='token')c.expectedToken='synthetic-token-2';
     else if(kind==='record-tokens')c.recordTokens.retained='synthetic-record-token-2';
     else if(kind==='candidate')c.candidates[0].value.value=160;
     else if(kind==='displayed')d.display.state.pageSettings['1'].scale=130;
     else if(kind==='displayed-null')d.display.state.pageSettings['1'].scale=null;
     else if(kind==='displayed-absent')delete d.display.state.pageSettings['1'].scale;
     else if(kind==='drawing-name')s.projection.drawings[0].meta.name='Changed synthetic drawing';
     else if(kind==='project-name')s.cp.name='Changed synthetic project';
     else if(kind==='project-target')s.cp.id='synthetic-cloud-project-2';
     else if(kind==='project-omitted')delete s.projection.project;
     else if(kind==='extra-conflict')s.projection.metadataConflicts.push({...copy(c),path:['state','pageRotations','1'],
       headIds:['rotation-left','rotation-right'],candidates:[{value:{type:'value',value:90}},{value:{type:'value',value:180}}]});
     else if(kind==='remove-extra-conflict')s.projection.metadataConflicts=s.projection.metadataConflicts.slice(0,1);
     else if(!['same','unrelated','reordered-document'].includes(kind))throw Error('Unknown fixture update '+kind);
     await SentlogDeltaMetadataUI.update(copy(s.cp),copy(s.projection));return this.snapshot();
   },
   makeRemoteStale(){document().collab.fields.scale.revisions.push({id:'unseen-head',value:175});},
   async addSecond(){s.second={cp:{...copy(s.cp),id:'synthetic-second-cloud',client_key:'synthetic-second-project',name:'Synthetic second project'},projection:copy(s.projection)};
     s.second.projection.project.id=s.second.cp.client_key;
     await SentlogDeltaMetadataUI.update(copy(s.second.cp),copy(s.second.projection));return this.snapshot();},
   async updateBoth(){await Promise.all([SentlogDeltaMetadataUI.update(copy(s.cp),copy(s.projection)),
     SentlogDeltaMetadataUI.update(copy(s.second.cp),copy(s.second.projection))]);return this.snapshot();},
   finish(){if(!s.release)throw Error('No pending save');s.release();s.release=null;},
   async clearAndUpdate(){SentlogDeltaMetadataUI.clear();await SentlogDeltaMetadataUI.update(copy(s.cp),copy(s.projection));},
   snapshot(){return {message:status(),dialogOpen:dialog().open,
     notice:describe(notice()),noticeSame:s.mark?notice()===s.mark.notice:null,
     markedConnected:s.mark?.button?.isConnected??null,
     markedStillChoice:s.mark?choice(s.mark.label)===s.mark.button:null,
     markedFocused:s.mark?window.document.activeElement===s.mark.button:null,
     activeElement:describe(window.document.activeElement),
     choices:choices().map(node=>({label:node.textContent,disabled:node.disabled,serial:serial(node)})),
     dialogText:dialog().textContent,calls:copy(s.calls),writes:s.writes,events:copy(s.events),
     expectedGuard:guard(),currentProject:copy(s.cp)};}
 };
 await SentlogDeltaMetadataUI.update(copy(s.cp),copy(s.projection));
}"""


def digest(path):
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def native_click(page, locator):
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    assert box, "Native input requires a visible button"
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.up()


def run_module(browser, source, label, expect_stable, report, save_report):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, service_workers="block")
    page = context.new_page()
    page.set_default_timeout(10000)
    errors, external = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def route(request):
        if request.request.url == ORIGIN + "/fixture":
            request.fulfill(status=200, content_type="text/html", body=HTML)
        else:
            external.append(request.request.url)
            request.abort()

    context.route("**/*", route)
    result = {"module": label, "status": "running", "scenarios": [], "pageErrors": errors,
              "externalRequests": external}
    report["modules"].append(result)
    save_report()

    def record(name, proof):
        result["scenarios"].append({"name": name, "proof": proof})
        save_report()

    def reset(membership=False):
        assert not errors, errors
        page.goto(ORIGIN + "/fixture", wait_until="domcontentloaded")
        page.add_script_tag(content=source)
        identity = page.evaluate("({version:SentlogDeltaMetadataUI.stableRenderVersion||null,alias:window.SentlogDeltaMetadataStableUI===SentlogDeltaMetadataUI})")
        assert identity == {"version": 1 if expect_stable else None, "alias": expect_stable}, identity
        page.evaluate(HARNESS, {"membership": membership})
        expect(page.locator(NOTICE)).to_have_count(1)
        page.locator(NOTICE).click()
        expect(page.locator(DIALOG)).to_be_visible()

    def button(text="150 を使う"):
        return page.locator(DIALOG).get_by_role("button", name=text, exact=True)

    def mark(text="150 を使う"):
        button(text).focus()
        proof = page.evaluate("label=>metadataProbe.mark(label)", text)
        assert proof["markedFocused"] and proof["markedConnected"], proof
        return proof

    def snapshot():
        return page.evaluate("metadataProbe.snapshot()")

    def saved_once(proof, *, value=None, keep=None):
        assert len(proof["calls"]) == 1 and proof["writes"] == 1, proof
        call = proof["calls"][0]
        assert call["status"] == "saved" and call["guardMatches"], proof
        for key, expected in proof["expectedGuard"].items():
            assert call["options"].get(key) == expected, (key, proof)
        assert call["cp"] == proof["currentProject"], proof
        if value is not None:
            assert call["options"].get("value") == value, proof
        if keep is not None:
            assert call["options"].get("keep") is keep, proof

    try:
        result["activeScenario"] = "normal-choice"
        reset()
        native_click(page, button())
        expect(page.locator(DIALOG)).to_contain_text("選んだ内容を保存しました")
        proof = snapshot()
        saved_once(proof, value=150)
        record("normal native choice", proof)

        result["activeScenario"] = "unchanged-focus"
        reset()
        states = []
        for kind in ("same", "same", "unrelated", "reordered-document"):
            mark()
            proof = page.evaluate("kind=>metadataProbe.update(kind)", kind)
            states.append({"update": kind, **proof})
            assert proof["markedConnected"] is expect_stable, proof
            assert proof["markedStillChoice"] is expect_stable, proof
            assert proof["markedFocused"] is expect_stable, proof
            assert proof["noticeSame"] is expect_stable, proof
            assert proof["calls"] == [] and proof["message"] == "", proof
        record("same review retains native button, focus and notice", states)

        result["activeScenario"] = "notice-count"
        reset()
        mark()
        increased = page.evaluate("metadataProbe.update('extra-conflict')")
        assert not increased["noticeSame"] and "2 件を確認" in increased["notice"]["text"], increased
        mark()
        unchanged = page.evaluate("metadataProbe.update('same')")
        assert unchanged["noticeSame"] is expect_stable, unchanged
        mark()
        decreased = page.evaluate("metadataProbe.update('remove-extra-conflict')")
        assert not decreased["noticeSame"] and "1 件を確認" in decreased["notice"]["text"], decreased
        record("notice count changes refresh while unchanged counts retain", {"increased": increased, "same": unchanged, "decreased": decreased})

        result["activeScenario"] = "concurrent-identical-projects"
        reset()
        page.evaluate("metadataProbe.addSecond()")
        first = page.locator(DIALOG).locator("section").first.get_by_role("button", name="150 を使う", exact=True)
        first.focus()
        before = page.evaluate("metadataProbe.mark('150 を使う')")
        assert before["markedFocused"], before
        proof = page.evaluate("metadataProbe.updateBoth()")
        assert proof["markedConnected"] is expect_stable, proof
        assert proof["markedFocused"] is expect_stable, proof
        assert proof["noticeSame"] is expect_stable, proof
        assert proof["calls"] == [] and proof["message"] == "", proof
        record("concurrent identical projects never expose a partial materialization", proof)

        result["activeScenario"] = "pointer-interruption"
        reset()
        mark()
        box = button().bounding_box()
        assert box
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        down = snapshot()
        assert any(e["type"] == "pointerdown" and e["markedTarget"] and e["trusted"] for e in down["events"]), down
        interrupted = page.evaluate("metadataProbe.update('same')")
        page.mouse.up()
        # The explicit pointer boundary replaces a timing-dependent sleep.
        # A rendering frame is only an event-delivery observation boundary.
        page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
        proof = snapshot()
        assert interrupted["markedConnected"] is expect_stable, interrupted
        assert any(e["type"] == "pointerup" and e["trusted"] for e in proof["events"]), proof
        if expect_stable:
            expect(page.locator(DIALOG)).to_contain_text("選んだ内容を保存しました")
            proof = snapshot()
            saved_once(proof, value=150)
            assert any(e["type"] == "click" and e["markedTarget"] and e["trusted"] for e in proof["events"]), proof
        else:
            assert proof["calls"] == [] and proof["writes"] == 0 and proof["message"] == "", proof
        record("native down, identical update, native up", {"down": down, "afterUpdate": interrupted, "afterUp": proof})

        result["activeScenario"] = "changed-review"
        changes = []
        for kind in ("candidate", "displayed", "drawing-name", "project-name", "project-target", "project-omitted",
                     "heads", "document", "token", "record-tokens"):
            reset()
            mark()
            changed = page.evaluate("kind=>metadataProbe.update(kind)", kind)
            assert changed["markedConnected"] is False, changed
            assert changed["noticeSame"] is expect_stable, changed
            assert changed["calls"] == [] and changed["message"] == "", changed
            choice = "160 を使う" if kind == "candidate" else "150 を使う"
            if kind == "displayed":
                assert "現在の表示：130" in changed["dialogText"], changed
            if kind == "drawing-name":
                assert "Changed synthetic drawing" in changed["dialogText"], changed
            if kind == "project-name":
                assert "Changed synthetic project" in changed["dialogText"], changed
            native_click(page, button(choice))
            expect(page.locator(DIALOG)).to_contain_text("選んだ内容を保存しました")
            proof = snapshot()
            saved_once(proof, value=160 if kind == "candidate" else 150)
            changes.append({"change": kind, "afterUpdate": changed, "afterChoice": proof})
        record("changed labels, candidates and every save precondition refresh", changes)

        result["activeScenario"] = "null-versus-absent"
        reset()
        page.evaluate("metadataProbe.update('displayed-null')")
        mark()
        null_proof = snapshot()
        assert "現在の表示：null" in null_proof["dialogText"], null_proof
        absent_proof = page.evaluate("metadataProbe.update('displayed-absent')")
        assert not absent_proof["markedConnected"] and "現在の表示：値なし" in absent_proof["dialogText"], absent_proof
        assert all(c["label"] != "現在の内容を残す" for c in absent_proof["choices"]), absent_proof
        record("undefined and null current values do not compare equal", {"null": null_proof, "absent": absent_proof})

        result["activeScenario"] = "membership-guards"
        reset(membership=True)
        mark(MEMBERSHIP_CHOICE)
        same = page.evaluate("metadataProbe.update('same')")
        assert same["markedConnected"] is expect_stable, same
        mark(MEMBERSHIP_CHOICE)
        changed = page.evaluate("metadataProbe.update('record-tokens')")
        assert not changed["markedConnected"], changed
        native_click(page, button(MEMBERSHIP_CHOICE))
        expect(page.locator(DIALOG)).to_contain_text("選んだ内容を保存しました")
        proof = snapshot()
        saved_once(proof, keep=True)
        record("membership record tokens refresh and reach the resolver", {"same": same, "changed": changed, "saved": proof})

        result["activeScenario"] = "busy"
        reset()
        page.evaluate("metadataProbeState.mode='pending'")
        mark()
        native_click(page, button())
        page.wait_for_function("metadataProbeState.calls.length===1&&metadataProbeState.release!==null")
        expect(page.locator(DIALOG)).to_contain_text("選んだ内容を端末に保存しています")
        before = snapshot()
        assert all(c["disabled"] for c in before["choices"]), before
        same = page.evaluate("metadataProbe.update('same')")
        assert all(c["disabled"] for c in same["choices"]), same
        assert same["markedConnected"] is expect_stable, same
        native_click(page, button())
        blocked = snapshot()
        assert len(blocked["calls"]) == 1 and blocked["writes"] == 0, blocked
        page.evaluate("metadataProbe.finish()")
        expect(page.locator(DIALOG)).to_contain_text("選んだ内容を保存しました")
        proof = snapshot()
        saved_once(proof, value=150)
        assert all(not c["disabled"] for c in proof["choices"]), proof
        assert proof["markedConnected"] is expect_stable, proof
        record("busy refresh prevents duplicate input and finally reenables", {"busy": before, "sameUpdate": same, "secondInput": blocked, "finished": proof})

        result["activeScenario"] = "stale-rejection"
        reset()
        mark()
        page.evaluate("metadataProbe.makeRemoteStale()")
        native_click(page, button())
        expect(page.locator(DIALOG)).to_contain_text("Synthetic stale metadata rejected")
        proof = snapshot()
        assert len(proof["calls"]) == 1 and proof["writes"] == 0, proof
        assert proof["calls"][0]["status"] == "rejected" and not proof["calls"][0]["guardMatches"], proof
        assert all(not c["disabled"] for c in proof["choices"]), proof
        assert {c["label"] for c in proof["choices"]} >= {"150 を使う", "175 を使う"}, proof
        record("resolver rejection retains candidates without a success claim", proof)

        result["activeScenario"] = "clear"
        reset()
        mark()
        page.evaluate("metadataProbe.clearAndUpdate()")
        assert not page.locator(DIALOG).is_visible()
        page.locator(NOTICE).click()
        proof = snapshot()
        assert not proof["markedConnected"] and not proof["noticeSame"], proof
        assert proof["calls"] == [] and proof["message"] == "", proof
        record("clear invalidates the retained review", proof)
        assert not errors, errors
        assert not external, external
        result["status"] = "passed"
        save_report()
    except Exception as error:
        result["status"] = "failed"
        result["error"] = {"type": type(error).__name__, "message": str(error)}
        try:
            result["failureSnapshot"] = snapshot()
        except Exception as snapshot_error:
            result["snapshotError"] = str(snapshot_error)
        save_report()
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["chromium", "webkit"], default="chromium")
    parser.add_argument("--executable-path")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "test-results/metadata-ui")
    args = parser.parse_args()
    baseline = ROOT / "tests/fixtures/delta_metadata_ui_v212.js"
    candidate = ROOT / "sentlog/delta-sync-metadata-ui.js"
    baseline_info, candidate_info = digest(baseline), digest(candidate)
    assert baseline_info["sha256"] == BASELINE_SHA256, baseline_info
    assert candidate_info["sha256"] != BASELINE_SHA256, "Candidate must include the reviewed fix"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.output_dir / f"metadata-ui-{args.engine}-report.json"
    report = {"format": "sentlog-metadata-native-control-stability-v1", "engine": args.engine,
              "status": "running", "syntheticOnly": True, "fixtureSource": digest(Path(__file__).resolve()),
              "baselineSource": baseline_info, "candidateSource": candidate_info, "modules": [],
              "scope": "Real module and native DOM/input; controlled materialize/resolve callbacks; no database/cloud/customer records",
              "limitations": ["Controlled projection interruption does not establish the cause of a past CI failure.",
                              "No physical iPad, database durability or production resolver claim."]}

    def save_report():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save_report()
    with sync_playwright() as playwright:
        launch = {"headless": True}
        if args.executable_path:
            launch["executable_path"] = args.executable_path
        if args.engine == "chromium":
            launch["args"] = ["--no-sandbox"]
        browser = getattr(playwright, args.engine).launch(**launch)
        report["browserVersion"] = browser.version
        try:
            for path, label, stable in [(baseline, "baseline-v212", False), (candidate, "candidate", True)]:
                run_module(browser, path.read_text(encoding="utf-8"), label, stable, report, save_report)
            report["status"] = "passed"
            save_report()
            print(f"PASS {args.engine}: v212/native comparison, identical projection focus and click, changed guards, busy and stale rejection", flush=True)
            print(json.dumps({"report": str(report_path), "baselineSHA256": baseline_info["sha256"],
                              "candidateSHA256": candidate_info["sha256"], "modules": len(report["modules"])}, ensure_ascii=False))
        except Exception:
            report["status"] = "failed"
            save_report()
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
