# Delta application release

The release assembler combines the reviewed SQL fragments into one transaction.
Installing this SQL does not enable owner rollout, activate a project, alter an
existing snapshot, archive a project, or delete business records or file data.
Existing owner rollout settings and activated projects survive reapplication.

## Assemble and verify

Run from the repository root:

```sh
python3 scripts/assemble_delta_sync.py --check
python3 scripts/assemble_delta_sync.py --output /tmp/sentlog-delta-release.sql
python3 scripts/assemble_delta_sync.py --manifest > /tmp/sentlog-delta-release-manifest.json
node tests/delta_release_pglite.cjs
```

The test requires the repository's `@electric-sql/pglite` dependency. When using
the shared test installation, set `NODE_PATH` to its `node_modules` directory.
The assembler has no database connection, credentials, deployment, rollout, or
activation capability. Its manifest identifies every selected source and hashes
the exact generated SQL. Generate the file again if any input source changes.

`tests/delta_release_pglite.cjs` loads the complete archive, management, device
registration, capacity, resilience/audit, collaboration, photo redelivery, and
device photo redelivery protocols from `db/` into a disposable database. It
creates synthetic active, archived, retired, and foreign-owner projects before
applying the release. It verifies:

- A disabled collaboration guard prevents installation before any new objects
  are created. A deliberate failure after the last component rolls back the
  entire migration, including functions, triggers, privileges, and columns.
- Existing business rows, public wrappers, legacy guards, grants, and realtime
  policies survive unchanged. A prior PC backup and management retirement flag
  remain available.
- All existing projects continue using legacy saving by default. Actual legacy
  snapshot saves and revision checks still work.
- Application clients cannot enable rollout themselves, access the private
  event log directly, or manufacture checkpoint write authority.
- Explicit test rollout and application activation produce a certified
  snapshot. Accepted edits can proceed through the real archive report, PC
  completion, finalization, and capacity verification protocols.
- Reapplication preserves accepted histories, certificates, receipts, and
  saving modes. Schema reload notifications occur only on a successful commit.

These are database and application integration tests with synthetic data. They
do not assert that a particular user's physical PC folder has been read back.

## Release contents

The assembler orders the schema, semantic validation, baseline, transport,
atomic groups, archive compatibility, projection, metadata, checkpoint, and
application lifecycle fragments. It also extracts only these replacements
from the legacy protocol files:

| Source | Selected function | Reason |
| --- | --- | --- |
| `db/archive_v1.sql` | `sentlog_archive_private.gateway` | Retain the exact per-device delta proof with the existing report. |
| `db/collaboration_v1.sql` | `sentlog_collaboration_private.guard_snapshot` | Accept only a matching private, transaction-scoped checkpoint authority. |
| `db/capacity_v1.sql` | `sentlog_archive_private.capacity_gateway` | Return the archived certificate to both phone inspection and PC jobs. |

Do not reinstall the whole legacy files as a substitute for these replacements:
the original archive file would replace the management dispatcher, and other
legacy files recreate already installed policies or triggers. The narrow
`CREATE OR REPLACE FUNCTION` statements preserve existing function identities
and grants. The checkpoint fragment preserves the existing archive catalog
under its versioned legacy helper and adds the certified projection wrapper.

The outer transaction uses a five-second lock timeout and a five-minute
statement timeout. It ends with privilege/guard readiness checks and
`NOTIFY pgrst, 'reload schema'`. PostgreSQL delivers the notification on commit;
a failed installation leaves no partial release. The notification follows
[Supabase's schema refresh guidance](https://supabase.com/kb/troubleshooting/refresh-postgrest-schema).

## Deployment order and preconditions

1. Confirm that the target has the actual installed legacy protocols and the
   active, unconditional collaboration snapshot guard. The release preflight
   checks the required tables and functions; it does not create substitute
   legacy tables or bypass a missing guard.
2. Apply the exact reviewed generated SQL as one transaction through the
   project's normal migration mechanism. The executing database role must be
   able to install the private functions, tables, triggers, and grants. Record
   the assembly manifest with that migration. The supplied utility does not
   execute this step.
3. Deploy the application build containing the version-2 records database,
   durable journal/controller, migration installer, shared metadata, guarded
   photo receiver, and certified archive/capacity integration. Verify that the
   deployed RPCs are visible through PostgREST and the deployed app's ordinary
   saves, offline recovery, restoration, and PC flow pass the release checks.
4. Enable rollout only for the intended owner after that deployed build is
   verified. Rollout makes projects eligible; actual project activation still
   requires a protected local migration, server baseline validation, metadata
   seeding, and checkpoint publication. Merely installing the SQL or loading
   the app does not grant rollout.

Turning owner rollout off prevents new activation. It does not return an
already activated project to snapshot-only saving. Activated projects retain
their delta ownership across restarts and local detachment; repair and recovery
must preserve that ownership and the recorded history.

## Local retention and capacity reclamation

The journal's record snapshots are compacted after a real durable replica
acknowledgement covers every affected project. Compaction is bounded, preserves
unassigned drawing intents, and does not equate a missing outbox with a durable
acknowledgement. Per-project cutoffs copy only that project's related shared
files, including retained drawings; unrelated project bytes remain in their
original store.

Replay claims store file references to their protected WAL row IDs instead of
duplicating native Blob/File objects in the control store. A failed optional
compaction keeps the original WAL rows and exact bytes, reports deferred
maintenance, and does not block an already verified record or its photo
delivery. Ordinary record-only rows still use the bounded compaction path.

Protected migration cutoff files live in immutable `cutoff-file` rows in the
existing version-2 control store. The mutable binding contains file references,
so an ACK, activation, or projection does not serialize every saved Blob/File
again. The public cutoff API still supplies the original file values. Source
capture and recheck refresh the referenced durable rows, including releases
performed by another tab.

An older embedded cutoff is converted one file at a time: fresh bytes are
hashed, added to a deterministic staging row, and checked again if an interrupted
conversion resumes. The old binding remains intact until a final metadata CAS
replaces the embedded values with references; that swap writes no Blob. A
missing or foreign reference is rejected. Certified cleanup includes each
selected cutoff row's scope, identity, revision, and release state in the same
transaction as the final archive operation. It replaces only matching copies
with a null value and receipt; unmatched historical bytes are not rewritten.

Certified delta capacity cleanup also releases redundant copies from the
acknowledged file-retention rows, the project's protected migration cutoff,
sealed migration staging, and the shared-photo store. Each candidate must
match the complete archived catalog by file key, asset identity where stored,
SHA-256, size, owner, project, and device. The operation also requires the
current archive certificate, a fresh completed PC package verification, and a
clean local replica/journal. Every selected Blob is hashed before release;
changing its source revision, file generation, account, or relevant saved
record stops the final removal.

The application pauses photo transfers before taking its final proof. It
releases redundant copies in the independent migration and photo databases
while the ordinary local files remain available. If that work is interrupted,
the operation can retry against the retained release receipts. The records
database then prunes its matching cutoff and journal copies in the same guarded
transaction that removes the visible files and records the local clearance
marker. This transaction does not create another deletion-preimage Blob.
Pending journal entries, active replay claims, an expired verification, or a
changed generation prevent that commit.

Record histories, metadata, archive receipts, unassigned intents, other
projects' copies, and historical files with different content remain intact.
Native camera originals and original-photo variants are excluded. Migration
sessions with released shared bytes are marked `archived-copy`; reading one
as a complete activation source raises an explicit error. Photo-store entries
retain their identity and receipts with an `archived` state instead of claiming
that their bytes are still present. The local clearance marker prevents
automatic photo download after cleanup and after restart. Explicit restoration
can rehydrate those entries only through the normal verified file and receipt
path.

Whole-project restoration writes missing verified files while keeping the
project detached. Those writes retain their scoped restoration provenance and
remain unacknowledged in the journal. An opaque proof of the complete catalog,
archive certificate, exact destination snapshot, and unchanged file generations
authorizes the final records transaction; unrelated orphan files and normal
edits cannot use that proof. After commit, cache hydration is acknowledged only
when the restored record and metadata histories exactly match the existing
durable replica at the certified cursor with no pending outbox. It creates no
new edit history, so an archived project can remain archived. A later editor
change is replayed separately, and ordinary user backup restores keep their
existing explicit-edit semantics.

The released byte count measures the Blob payloads removed from these stores.
It is not a promise of an equal immediate reduction in physical disk usage:
the browser controls storage deduplication and reclamation, and the retained
originals and different historical bytes still occupy space. The capacity UI
continues to show the browser's storage estimate separately.

`tests/delta_capacity_gc.test.cjs` exercises the actual records transaction,
real migration/photo stores, interruption and retry, generation races,
pending-work rejection, and explicit restoration after release.
`tests/delta_capacity_copies.test.cjs` verifies the individual stores' hashes,
compare-and-swap checks, preserved originals, and guarded photo rehydration.
