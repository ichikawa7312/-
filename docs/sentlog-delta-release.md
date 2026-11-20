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

Local file removal deliberately retains exact file preimages. Compacted
file-retention entries, the protected migration cutoff, migration staging, and
the immutable shared-photo store can therefore still hold bytes after the
visible file mirror has been removed. Native camera originals are protected
separately. PC archive and restoration work with this retention, but the amount
of physical browser space reclaimed can be smaller than the removed mirror's
file sizes. The current implementation does not claim complete byte reclamation.

A separate release operation is needed to reclaim these duplicate bytes. It
must bind every candidate to the exact archived job and immutable certificate,
verified PC package/readback provenance, manifest key, SHA-256, size, owner, and
project. The relevant local file generations and pending intents must be
rechecked in the deletion transaction. Protected migration copies also require
the matching durable migration/readback receipt. Release only copies covered
by that evidence, leaving current or pending bytes, unassigned intents,
immutable record history, and other projects' references intact. A generic
`verified: true` flag is insufficient. Camera originals need their own verified
original-backup policy; a shared-photo receipt cannot authorize their deletion.
