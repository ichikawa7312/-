# Sentlog v1.33 — archive stage 1

The project list shows active projects and one Archive folder. Moving a project does not delete IndexedDB records, photographs, PDFs, legacy archives, or files on the company PC.

Archive confirmation is explicit and server-authoritative: a snapshot revision is frozen; each active registered app device must prove matching project content and files; the PC must create and reread a versioned project package. Any unconfirmed device, different file, expired checkpoint, unavailable folder, or failed backup blocks finalization. Old device registrations are intentionally not silently retired. Cancelling or waiting ten minutes leaves the project active and retains local data.

All devices share active/archived classification. Archived content is excluded from normal upload, download, and PDF recovery. Stage 1 supports read-only archived inspection and a one-project manual receive/check. Resume active use to edit. Full project restoration from PC and local capacity cleanup are intentionally deferred and have no buttons in this release. A missing original file is not magically restored by this change.

PC packages: `selected root/復旧用/<project UUID>/<check UUID>/manifest.sentlog.json` plus `files/<asset UUID>`. The manifest preserves project data, drawing states, photo relationships, and content hashes. Previous generations and original files are retained. These packages are NOT the old whole-workspace import format; do not feed them into that importer.

## Build

`python3 scripts/build_archive.py` integrates the additions into the original v1.32 static files during CI and Pages deployment. The builder verifies source blob hashes and exact integration points and fails on unexpected baseline edits. Generated files are deployment output, not repository input. Update the build integration deliberately when modifying the underlying synchronizers. The archive SQL must be applied before publishing the frontend. It adds private checkpoint storage and a checked RPC, plus server guards against archive-time and stale writes.

## Checks

`node tests/core.test.cjs`, `node tests/pc.test.cjs`, and `python tests/ui.py` use isolated synthetic data and mock storage/network. After building, `node tests/integration.test.cjs` executes the actual cloud synchronization loops with mock transports. This is not an iPhone/iPad or live-PC end-to-end test. No capacity-release function is enabled.
