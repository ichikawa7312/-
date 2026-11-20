# Delta checkpoints and the existing PC archive protocol

The server now produces a complete compatibility snapshot from its accepted
revision graphs. An enabled delta project can use the existing phone → PC →
archive → reopen workflow when that snapshot is certified at the current delta
head. A stale snapshot cannot be used as a substitute for an up-to-date delta
replica.

This document describes the implementation and disposable verification. These
files do not enable a production project. Application rollout defaults to off.

## Installation and activation

Install the existing archive and collaboration protocols before the supplements:

1. Delta schema and semantic record validation.
2. Baseline import and authenticated transport.
3. Atomic operation groups and archive compatibility guards.
4. `sentlog-delta-projection-prototype.sql`.
5. `sentlog-delta-metadata-prototype.sql`.
6. `sentlog-delta-checkpoint-prototype.sql`.
7. `sentlog-delta-app-lifecycle.sql`.

The current `db/collaboration_v1.sql` includes the narrow certified-write
predicate, and `db/archive_v1.sql` preserves delta device proofs in reports.
The checkpoint migration replaces only snapshot triggers bound to the old
`reject_legacy_snapshot()` function, after installing a complete replacement in
the same transaction. The archive and collaboration guards remain installed.

`sentlog_delta_activate_baseline_v1` requires an owned active project, a current
registered device, an enabled owner rollout and a fully verified baseline. It
copies ordinary revision graphs, seeds and validates metadata graphs, publishes
the initial checkpoint and records the device handover in one transaction. A
failure at any step rolls all of those changes back. A retry of an already
active baseline returns its original receipt even after later checkpoints have
advanced the snapshot revision.

`sentlog_delta_inspect_v1` also returns the current `snapshotRevision`, so a
protected local handover can restart preparation against the latest legacy
snapshot without assuming that its first source revision is still current.

## Checkpoint RPC

```text
sentlog_delta_publish_checkpoint_v1(
  p_project_id uuid,
  p_device_id uuid,
  p_expected_head bigint,
  p_request_id text
)
```

The response contains `schema: 1`, `projectId`, `deviceId`, `requestId`,
`checkpointId`, `headSeq`, `revision`, `payloadSha256` and `payload`.

There is no caller-supplied snapshot argument. The server materializes comments,
fields, geometry, photographs and deletion decisions from the full accepted
graphs, then reconstructs project and drawing metadata from the reserved
metadata documents. It requires every ordinary record to have its drawing
document, includes both live records and tombstones, and recomputes display
numbering. Unknown shared metadata survives. A supplied raw record memo, field
or cached projection cannot override its revision history.

Scalar conflicts use their agreed maximal common ancestor, matching
`record-collaboration.js`. If maximal common ancestors disagree, no field value
is selected. Comments retain all distinct visible alternatives. Deletion only
hides a record when every current deletion decision observes every live field,
comment and photo head. A concurrent unobserved edit keeps the record visible.
Head, revision-row, comment and photo presentation uses explicit Unicode
code-point order in JavaScript and UTF-8 `COLLATE "C"` in PostgreSQL. Existing
revision payloads, including their parent/observed array order, are preserved
verbatim. New ordinary record revisions retain the original UTF-16 ordering of
those payload arrays, and legacy canonical object-key hashing is unchanged.

The publisher takes the existing snapshot table gate before project and head
locks. This prevents an old direct snapshot update from locking its row and
then inverting the publisher's project/row lock order. Ordinary delta edits do
not take that table gate. The exact head check happens after the project/head
locks are acquired.

The generated payload and certificate commit together. The snapshot trigger
accepts this one write only when a private row matches the current transaction,
owner, device, project, head, revision, complete payload and payload digest.
The publisher consumes that row before returning. A client-controlled custom
GUC or header cannot create this authority. Retrying a request at the same head
returns the existing checkpoint; different request IDs at that same head also
share the single published revision. An old expected head is rejected after a
new event has committed.

## Retained history and PC bundles

The reserved `project.deltaMetadata` envelope contains:

```text
{
  version: 1,
  namespace: "@sentlog:metadata:v1",
  records: { syntheticRecordId: completeCollaborationRecord, ... },
  retainedDrawings: [ { meta, state }, ... ]
}
```

An explicitly deleted drawing is hidden only after its ordinary records are
also deleted. Its full metadata and record histories remain in
`retainedDrawings`. A concurrent live record retains the drawing and a
membership conflict. Metadata capture excludes the reserved envelope to avoid
feeding checkpoint history back into ordinary settings.

The certified archive catalog includes drawing backgrounds and photographs
referenced by live records, deleted records, photo histories and retained
drawings. Each physical file identity occurs once. Known history hashes and
sizes must match the asset registry, and distinct logical photos cannot alias
one storage key. The archive-job trigger independently checks the complete
catalog and its hash before certifying the job; replacing the catalog wrapper
with an older visible-photo implementation therefore fails the job instead of
silently losing historical files.

The existing PC `backupPack` retains the metadata envelope inside the project.
Certified bundles additionally retain `delta_checkpoint` and unknown top-level
snapshot fields in `snapshotExtras`. `validatePack` compares these against the
job and checks the exact drawing list as well as the original file checks.
Legacy bundles without a delta checkpoint retain their existing format and
workflow.

## Phone confirmation and archive lifecycle

Archive jobs expose an immutable `delta_checkpoint`:

```text
{ schema: 1, projectId, checkpointId, headSeq, revision, payloadSha256 }
```

A phone claiming clean must include:

```text
{ schema: 1, headSeq, cursor: headSeq, pending: 0, revision, payloadSha256 }
```

A phone with no local copy may instead explicitly attest absence with
`absent: true` and `cursor: null`, while preserving the same head, revision,
digest and zero-pending claim. It must check that it has no local project,
drawing data, binding or pending journal both before and after the local check.
This does not invent a receive cursor for a device that never had a replica.

The server validates the declared version against its certificate. The browser
must independently verify its guarded local token and pending queue; a server
cannot inspect unsent browser data. Reports without the exact proof shape are
rejected. Existing freshness requirements for every phone report and the PC
receipt still apply.

Once archive checking starts, delta append and grouped edits are frozen. The
existing real archive gateway performs phone report, PC completion and
finalization. Its job and project guards require the certified current head,
snapshot revision, full payload and catalog. Reopening makes the project active
again. The first later accepted edit invalidates the previous certificate and
requires a new checkpoint before another archive begins.

Owned archived projects remain readable through inspect, capabilities,
baseline data/metadata pages and bounded delta/group reads, using a separate
read-only authorization helper. Revoked or foreign devices remain denied.
Prepare, import, activate, publish and append still require an active project.
Reading an archived project never reopens it.

## Verification

Use the pinned PGlite dependency already used by the delta prototype suites:

```sh
node tests/delta_projection_pglite.cjs
node tests/delta_metadata_pglite.cjs
node tests/delta_checkpoint_pglite.cjs
node tests/delta_app_backend.test.cjs
```

The record projection corpus compares independent SQL output with the actual
JavaScript collaboration implementation, including Unicode, concurrent values,
common ancestors, criss-cross graphs, photos, deletion and forged display
fields. The checkpoint integration uses the actual archive and collaboration
SQL, public activation RPC, actual PC pack helper and metadata restore path.
It covers positive completion, rollback, ownership, retries, stale heads,
history retention, corrupted manifests, clean/absence proofs, archived reads,
reopen and resumed edits.

`tests/delta_app_backend.cjs` is a JSON-lines PGlite subprocess for built-browser
tests. It exposes only a fixed RPC/table adapter, uses the actual database
functions and triggers, and has fixture-only seed/state/admin operations. It
accepts neither a remote database URL nor arbitrary SQL. Browser tests can
therefore exercise the real activation, append, read and publish behavior
without replacing the delta protocol with a fake in-memory service.

`tests/delta_checkpoint_races.sh` runs only against the disposable loopback
`sentlog_delta_test` PostgreSQL database, after the existing archive race suite.
It uses separate connections to check both publisher/edit lock orders, both
archive/edit orders, whole grouped operations, eight concurrent first-publish
retries and actual PostgreSQL archive finalization/reopen. PGlite verifies SQL
semantics; it is not used as evidence for separate-connection lock races.
