# Shared metadata and local archive consistency

This document describes the implemented metadata protocol in `sentlog/delta-sync-metadata.js`, its SQL projection in `docs/sentlog-delta-metadata-prototype.sql`, and the application bridge. Installing these modules alone does not activate a project. Activation belongs to the authenticated lifecycle transaction and the durable application journal.

## Documents and identities

Metadata uses the ordinary immutable record protocol, including ordinary create/patch events and atomic groups. Its reserved drawing namespace is `@sentlog:metadata:v1`.

| Document | Record ID | Immutable `metaIdentity` |
| --- | --- | --- |
| Project | `project` | `{version:1,kind:'project',localProjectId}` |
| Drawing | `drawing:` followed by SHA-256 of the UTF-8 drawing ID | `{version:1,kind:'drawing',localProjectId,drawingId}` |

Each document has empty geometry, comments and photos. Every identity revision must contain the same identity. The server validates the identity against the owning project's `client_key`, rejects project deletion through this protocol, and rejects malformed metadata before accepting its event.

Each shared JSON object becomes a tree of independent field registers. Empty objects have their own node; arrays remain atomic values. The field key is `m:` followed by SHA-256 of the encoded path. A path segment is encoded as its UTF-8 byte length, a colon, then the original string, with all segments concatenated. For example, `['日本','😀']` becomes `6:日本4:😀`. Both implementations verify the field hash and all revision paths.

Node revision values are:

```javascript
{path:['state','pageSettings','1'], type:'object'}
{path:['state','pageSettings','1','scale'], type:'value', value:100}
{path:['state','pageSettings','1'], type:'absent', observed:[/* descendant revision IDs */]}
```

A scalar or array replacing an object also carries the descendant revision IDs it observed. A removal or replacement suppresses descendants only when all current descendant heads were observed. If another device changed an unseen descendant, the object remains visible and a structural conflict retains both alternatives.

Project fields live beneath `['project']`. Drawing header fields live beneath `['meta']`, drawing state beneath `['state']`, and each drawing's order beneath `['order']`. Metadata excludes identity, derived counts, update timestamps, the internal envelope, and the device view fields `currentPage`, `width`, `height`, `pdfPageInfo`, `labelSize`, `nextGlobalNo`, and `typeCounters`. `collaborationVersion:1` is protocol data, excluded from editable metadata and reinserted by projection. All other JSON properties, including unknown future settings, are retained.

Seed revision IDs are `metadata:seed:` plus SHA-256 of the encoded `[recordId,fieldKey]` path. The alive deletion seed uses `@alive` as the field key. New absent field roots use `metadata:absent:` with the same hash. These IDs bind immutable seed payloads: a different payload under the same ID is a collision, never a replacement.

## Editing, conflicts and replay

`seed(snapshot)` returns a map keyed with the delta core's `keyOf(namespace,recordId)`. When the snapshot already has a metadata envelope, it validates and preserves that history instead of reseeding it. It also verifies that the displayed shared metadata agrees with the envelope.

`edit({before,after,currentRecords,beforeRecords,operationId,actor,at,operation})` returns ordinary bridge `changes`, a metadata record map, and conflicts. Exact displayed histories are preferred. The WAL replay path can infer parents by finding immutable revisions matching the captured before value; it never adopts a different unseen peer head simply because that head is now current. Operation, document and path determine stable revision and event IDs. Replaying the same committed operation emits no duplicate mutation. Reusing that identity with another value fails.

Conflicting scalar/array values display their agreed common ancestor when one exists. With no shared ancestor the property has no selected value and both candidates remain available. Unrelated fields remain editable. Editing an already displayed conflict requires explicit resolution.

Legacy migration has no reliable per-setting ancestry. A differing existing local value is therefore retained as an independent concurrent candidate. Missing local drawings and properties cannot prove deletion and are preserved. New local drawings/settings can be created. A no-common drawing order conflict uses deterministic order `0` with raw drawing ID as its tie breaker until resolution; the original order candidates remain in history.

`resolve({records,recordId,path,expectedHeads,value,absent,operationId,actor,at})` creates an explicit resolution revision. Selecting an object uses the complete selected object and explicitly removes omitted children. Removing or replacing a subtree observes its current descendant heads. A stale candidate list is rejected.

Drawing membership uses the document's deletion register. A drawing removal is grouped with tombstones for its known ordinary records. A concurrent live or pending-delete ordinary record keeps that drawing visible, even if its metadata deletion itself was complete. The projection exposes a `metadata-membership` conflict containing the metadata `expectedToken` and live `recordTokens`.

`resolveMembership({records,recordId,keep,expectedToken,expectedRecordTokens,operationId,actor,at})` restores the drawing or deletes the exact confirmed live records along with its metadata. A removal checks both the metadata token and the complete live-record token map. The caller commits those changes as one atomic group using the replica snapshot token.

## Projection and backup retention

`project({records,template,localProjectId})` returns an application project snapshot, `metadataRecords`, and `metadataConflicts`. Internal documents do not appear as ordinary shapes. Visible drawings come from document membership and deterministic order. Deleted drawings retain their complete records and metadata in the one reserved envelope:

```javascript
project.deltaMetadata = {
  version:1,
  namespace:'@sentlog:metadata:v1',
  records:{ /* synthetic record ID -> full immutable C record */ },
  retainedDrawings:[{meta,state}]
};
```

The envelope is excluded from ordinary metadata capture, preventing recursive histories. It travels with the project through backup packing. Retained drawings include ordinary tombstones and their immutable comments, photos and fields. Reconciliation imports those histories even though the drawings are absent from the visible drawing list. Unknown, incompatible envelope versions are retained as errors rather than overwritten.

The bridge uses `projectReplica` for metadata-backed replicas and retains its original synchronous projection API for legacy callers. Drawing creation/removal, settings and ordinary record edits become a single group whenever their effects must be published together. A WAL receipt additionally returns `normalizedAfter`, the canonical local draft before peer merge. The next claim uses that branch, avoiding an accidental reinterpretation of a displayed common ancestor as the author's previous intent.

## Server validation

The SQL module exposes private helpers only:

| Function | Result/purpose |
| --- | --- |
| `seed_metadata_document(kind,local_project_id,drawing_id,metadata)` | A deterministic ordinary C record, identical to the JavaScript seed |
| `materialize_metadata_document(record_id,collab)` | Identity, kind, deletion state, shared project/meta/state/order and conflict candidates |
| `validate_metadata_snapshot(snapshot,documents)` | Validates raw shared settings, visible/retained membership and ordering against immutable metadata |
| `seed_metadata_baseline(project_id,device_id,baseline_id)` | Seeds metadata and retained record histories inside activation; returns count and idempotency status |

A `BEFORE INSERT/UPDATE` trigger validates each metadata result and its owner/client binding. A deferred constraint trigger prevents ordinary records from committing without their drawing document once project metadata exists. Deferral permits an atomic new-drawing operation to insert the ordinary record before its metadata document. The authenticated client has no direct access to these helpers or private tables.

The JavaScript and SQL projections use code-point ordering for heads and visible candidates. Existing revision `parents` and `observed` arrays retain their exact bytes. New generic collaboration revisions retain the legacy UTF-16 array encoding for old-client compatibility. These persisted arrays are immutable payloads, not display sorting instructions. A narrow `matchesProjection` compatibility check accepts a recomputable old locale-based comment/photo display order while still rejecting unexplained raw edits and fabricated memo caches.

## Device capacity cleanup and restoration

`SentlogDeltaCapacity.createProof` accepts the archive job, cloud project, record store, runtime archive-proof callback and account/device scope. A delta job uses its certified replica head and drained journal proof; local viewport differences do not invalidate the checkpoint. Legacy jobs retain their original shared snapshot comparison.

The proof captures exact workspace, visible/retained drawing and local archive-state rows. Restore additionally captures absent destination rows. It rejects any drawing ID owned by another project. It also captures per-file durable sequence numbers before file hashing.

After hashing, `validate()` rechecks the runtime proof, account/device, raw rows and durable file sequences. The actual `archiveAtomic` call receives `expectedRecords`, `expectedFileStates`, and the synchronous `validateSync` guard. Its transaction repeats those comparisons, including durable file sequences, before deleting files or installing restored records. This closes drawing-only edit races and same-size file replacements in another tab. Restore rehashes all received files under a fresh proof before its final record transaction.

## Verification

The targeted executable suites are:

- `tests/delta_metadata.test.cjs`: independent settings, structural changes, conflicts, retries, restore, identity and path validation.
- `tests/delta_metadata_bridge.test.cjs`: real replica/bridge saving, grouped membership operations and explicit membership resolution.
- `tests/delta_metadata_pglite.cjs`: independently implemented SQL/JavaScript parity, baseline seeding and database triggers.
- `tests/delta_reconcile.test.cjs`: old protected baseline behavior plus metadata migration and legacy Unicode display compatibility.
- `tests/delta_legacy_unicode_pglite.cjs`: unchanged legacy revision payloads, duplicate replay and subsequent SQL/client edits.
- `tests/delta_capacity.test.cjs`: certified capacity proof, exact row/file guards, restore destinations and generated capacity integration.

Full browser flows, authentication, remote file delivery and the release lifecycle are verified separately by the application integration suites. These component results do not themselves enable production synchronization.
