"""A failed existing project cannot block a new local project or its photo.

Runs the production app and controls against synthetic REST/Storage only.
Reuses the two-device suite's byte verification and WebKit Blob probe policy.
"""
import argparse
import base64
import copy
import functools
import hashlib
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright
import collaboration_ui as collaboration

base = collaboration.base
ROOT = Path(__file__).resolve().parents[1]
NEW_PROJECT = 'new-local-project'
NEW_DRAWING = 'new-local-drawing'
NEW_CLOUD = '77777777-7777-4777-8777-777777777777'
NEW_PHOTO = 'new-project-photo'
OLD_NAME = '合成既存案件A'
NEW_NAME = '合成新規案件B'


class Cloud(collaboration.Cloud):
    def __init__(self, origin, built_root, engine):
        super().__init__(origin, built_root, engine)
        self.fail_existing = False
        self.failed_attempts = 0
        self.registrations = []
        self.file_reads = []
        self.projects[0]['name'] = OLD_NAME

    def route(self, route, device):
        request, url = route.request, urlparse(route.request.url)
        if url.netloc == 'wiulvaqixphuobdielyy.supabase.co' and request.method != 'OPTIONS':
            query = parse_qs(url.query)
            if url.path.endswith('/sentlog_projects') and request.method == 'POST':
                body = json.loads(request.post_data)
                assert body['client_key'] == NEW_PROJECT and body['owner_id'] == collaboration.OWNER
                assert not any(p['client_key'] == NEW_PROJECT for p in self.projects), 'new project was registered twice'
                project = dict(body, id=NEW_CLOUD, checking=False)
                self.projects.append(project)
                self.registrations.append(copy.deepcopy(project))
                self.respond(route, [project], 201)
                return
            if url.path.endswith('/sentlog_project_snapshots') and request.method in ('POST', 'PATCH'):
                body = json.loads(request.post_data)
                project_id = query.get('project_id', [''])[0].removeprefix('eq.') or body.get('project_id')
                if self.fail_existing and project_id == base.CLOUD_PROJECT:
                    self.failed_attempts += 1
                    self.respond(route, {'code': '57014', 'message': 'canceling statement due to statement timeout'}, 500)
                    return
            if url.path.endswith('/sentlog_assets') and request.method == 'GET':
                self.file_reads.append(query.get('project_id', [''])[0].removeprefix('eq.'))
        return super().route(route, device)


def run(browser, cloud, engine):
    context, page, errors = collaboration.make_page(browser, cloud, collaboration.A, 390)
    try:
        packs = [base.payload(base.PROJECT, base.DRAWING), base.payload(base.QUIET, 'unrelated-plan')]
        packs[0]['project']['name'] = OLD_NAME
        for pack in packs:
            for drawing in pack['drawings']:
                for record in drawing['state']['shapes']:
                    record['photos'] = []
        encoded = base64.b64encode(base.photo_png()).decode('ascii')
        baseline = page.evaluate(base.SETUP, dict(packs=packs, encoded=encoded))
        if engine == 'webkit':
            probe = page.evaluate(collaboration.WEBKIT_BLOB_PROBE, encoded)
            if not probe['ok']:
                assert probe['name'] in ('UnknownError', 'DataCloneError', 'NotSupportedError'), probe
                page.evaluate(collaboration.WEBKIT_BLOB_TRANSPORT)
                print('WebKit isolated photo transport enabled after raw Blob probe failure:', probe['name'], flush=True)
        cloud.seed(baseline)
        page.evaluate('async()=>{sentlogImporting=false;await sentlogArchiveSync();await sentlogCloudIdle();}')
        collaboration.wait(cloud, page, lambda: cloud.snapshots[base.CLOUD_PROJECT]['payload']['project'].get('collaborationVersion') == 1,
                           'initial baseline did not synchronize')
        page.evaluate('async()=>{sentlogImporting=true;await sentlogCloudIdle();showProjects();await SentlogRecords.settled();}')
        saved_existing = copy.deepcopy(cloud.snapshots[base.CLOUD_PROJECT])
        new_pack = base.payload(NEW_PROJECT, NEW_DRAWING)
        new_pack['project']['name'] = NEW_NAME
        new_pack['project']['updatedAt'] = 99
        for record in new_pack['drawings'][0]['state']['shapes']:
            record['photos'] = []
        new_pack['drawings'][0]['state']['shapes'][0]['photos'] = [
            dict(id=NEW_PHOTO, name='synthetic-new.png', type='image/png', size=len(base.photo_png()), createdAt=1)]
        staged_record = page.evaluate("""async ({pack,encoded,photoId})=>{
          const ws=JSON.parse(SentlogRecords.getItem(WORKSPACE_KEY));
          const existing=JSON.parse(SentlogRecords.getItem(drawingStorageKey('edit-plan')));
          const index=existing.shapes.findIndex(s=>s.id==='survey-a');
          // Use the same immutable comment operation as the production editor.
          // The memo is a projection of both comments, not a replacement string.
          const edited=SentlogRecordCollaboration.appendComment(existing.shapes[index],'端末に残す未送信の記録',{
            actor:SentlogCollaboration.actor(),at:99,
            commentId:'unsent-local-comment',revisionId:'unsent-local-revision'});
          existing.shapes[index]=edited;
          ws.projects.push(pack.project);workspace=ws;
          const photo=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'});
          await SentlogRecords.writeFile('photo:'+pack.drawings[0].meta.id+':'+photoId,photo);
          SentlogRecords.batch([[WORKSPACE_KEY,JSON.stringify(ws)],
            [drawingStorageKey('edit-plan'),JSON.stringify(existing)],
            [drawingStorageKey(pack.drawings[0].meta.id),JSON.stringify(pack.drawings[0].state)]]);
          await SentlogRecords.settled();SentlogRecords.assertSafe();renderProjects();
          return edited;
        }""", dict(pack=new_pack, encoded=encoded, photoId=NEW_PHOTO))
        expected_memo = '保存済みの所見\n\n端末に残す未送信の記録'
        assert staged_record['memo'] == expected_memo, staged_record
        original_record = next(r for r in saved_existing['payload']['drawings'][0]['state']['shapes'] if r['id'] == 'survey-a')
        original_comments = original_record['collab']['comments']
        staged_comments = staged_record['collab']['comments']
        assert set(staged_comments) == set(original_comments) | {'unsent-local-comment'}, staged_comments
        for comment_id, history in original_comments.items():
            assert staged_comments[comment_id] == history, staged_comments
        new_revisions = staged_comments['unsent-local-comment']['revisions']
        assert len(new_revisions) == 1 and new_revisions[0]['text'] == '端末に残す未送信の記録', new_revisions
        assert new_revisions[0]['actor']['deviceId'] == collaboration.A, new_revisions
        cloud.fail_existing = True

        # A local-only project must be selectable before any cloud registration.
        page.locator('#sentlogCloudStatus').click()
        select = page.locator('#sentlogSyncProjectSelect')
        assert select.locator('option[value="'+NEW_PROJECT+'"]').inner_text() == NEW_NAME
        select.select_option(NEW_PROJECT)
        assert page.locator('#sentlogSyncProjectNow').is_enabled()
        assert not cloud.registrations
        page.locator('#sentlogCloudClose').click()

        page.evaluate('()=>{sentlogImporting=false;window.projectIsolationRound=sentlogArchiveSync();}')
        photo_key = 'photo:'+NEW_DRAWING+':'+NEW_PHOTO
        collaboration.wait(cloud, page, lambda: cloud.failed_attempts > 0 and NEW_CLOUD in cloud.snapshots and
                           any(a['client_key'] == photo_key for a in cloud.assets.values()),
                           'existing project failure blocked the new project or its photo', timeout=18)
        page.evaluate('async()=>{await window.projectIsolationRound;}')
        assert len(cloud.registrations) == 1
        assert NEW_CLOUD in cloud.file_reads
        asset = next(a for a in cloud.assets.values() if a['client_key'] == photo_key)
        assert asset['project_id'] == NEW_CLOUD
        assert hashlib.sha256(cloud.blobs[asset['storage_path']]).hexdigest() == asset['sha256']
        assert cloud.snapshots[base.CLOUD_PROJECT] == saved_existing, 'failed save changed the shared record'
        local_record = page.evaluate("JSON.parse(SentlogRecords.getItem(drawingStorageKey('edit-plan'))).shapes.find(s=>s.id==='survey-a')")
        assert local_record['memo'] == expected_memo, local_record
        assert local_record['collab'] == staged_record['collab'], dict(expected=staged_record, actual=local_record)

        # A successful scoped retry must not clear the other project's error.
        page.locator('#sentlogCloudStatus').click()
        select.select_option(NEW_PROJECT)
        attempts = cloud.failed_attempts
        page.locator('#sentlogSyncProjectNow').click()
        collaboration.wait(cloud, page, lambda: page.locator('#sentlogSyncProjectNow').is_enabled(),
                           'the selected-project control did not settle')
        detail = page.locator('#sentlogCloudDetails [data-level="error"]')
        assert detail.count() == 1 and OLD_NAME in detail.inner_text(), page.locator('#sentlogCloudDetails').inner_text()
        assert '保存' in detail.inner_text(), detail.inner_text()
        assert cloud.failed_attempts == attempts, 'scoped sync retried the unrelated failed project'
        assert len(cloud.registrations) == 1, 'scoped sync duplicated the new project'
        assert len([a for a in cloud.assets.values() if a['client_key'] == photo_key]) == 1
        assert not errors, errors
        assert not cloud.unexpected, cloud.unexpected
        print(f'PASS {engine}: timeout isolated; unsent local project selectable; new registration, record and verified photo sent; scoped retry retains named error and local records', flush=True)
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=('chromium', 'webkit'), default='chromium')
    parser.add_argument('--built-root', type=Path, default=ROOT)
    args = parser.parse_args()
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.built_root.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cloud = Cloud(f'http://127.0.0.1:{server.server_port}', args.built_root.resolve(), args.engine)
    try:
        with sync_playwright() as playwright:
            browser = getattr(playwright, args.engine).launch(headless=True)
            try:
                run(browser, cloud, args.engine)
            except Exception:
                print('Recent synthetic requests:', json.dumps(cloud.requests[-12:], ensure_ascii=False), flush=True)
                print('Failed attempts:', cloud.failed_attempts, 'new registrations:', len(cloud.registrations), flush=True)
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
