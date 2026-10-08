# Archive database protocol

`archive_v1.sql` is the additive stage-1 protocol installed by the `sentlog_archive_stage_one` migration. It does not archive or delete existing business projects/files. The migration includes a self-test which creates random synthetic fixtures inside a subtransaction, exercises 16 behavioral conditions, and rolls those fixtures back before commit. Additional checks confirm no fixture rows remain, anonymous execution is denied, and authenticated clients cannot directly insert private checkpoints. A separate authenticated-role read test confirmed the public RPC can return owned projects.

Checks include missing snapshots, missing files, unconfirmed/dirty/stale peers, absent or mismatched PC backup, disallowed direct status changes, frozen/archived writes, successful finalization, reopening, stale snapshot revisions, and cross-owner rejection. These are database protocol tests, not tests on the user's physical PC/iPad/iPhone.

The private checkpoint table intentionally has RLS enabled with no client policies or table privileges. It is accessible only through a fixed-search-path private security-definer gateway which verifies auth.uid() and project/device ownership. The exposed public RPC is security invoker and denies anonymous execution. Existing unrelated advisory findings are not asserted to be resolved by this migration.

All active registered non-PC devices are conservatively required. No historical device registration is retired automatically. A missing/offline/obsolete registration can block archive finalization until its data and registration have been reviewed. Current stage does not implement local file eviction or PC-package restoration.
