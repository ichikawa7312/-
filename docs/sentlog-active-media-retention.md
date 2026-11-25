# Active shared media retention and cost controls (draft)
 
Goal: active projects must be available from any authorized online device without the office PC acting as a required relay. Existing local records, original camera images, hash checks, revision and archive safeguards remain authoritative.
 
## Release sequence
 
1. Validate the existing recovery-throttle work and retain-only Edge Function with old and new PC clients. Never remove the active shared media copy after PC verification. PC backup verification remains independent.
2. Deploy the compact read-only PC inventory protocol first, then switch the PC client to it after browser and database regression tests. Do not deploy a UI requiring an unavailable RPC. Retained files are counted on the server; only pending rows are returned.
3. Restore missing active files in a separate, explicitly started, bounded PC migration. Do not fabricate receiving-device requests or receipts. Read the real existing PC source, verify SHA-256 and size, upload to an immutable new path under the existing private bucket, verify remote bytes, publish only against the same asset ID/hash/version and an exclusive lease, and persist completion. Retry a failed transfer without losing the original or duplicating successful work. Include PDF, image drawings, DXF and shared photos. Do not silently use a different version or recompress.
4. For archived projects, retain all existing shared files as well while capacity permits. The legacy delete endpoint is now read-only for active and archived data. Separate cleanup requires a future certified archive/reopen protocol and explicit approval. Reopening must restore all missing shared assets before cloud availability is shown as complete.
5. Test concurrent editing, offline restart, cancelled/retried migration, a changed drawing while copying, disk/permission failure, revoked devices, multiple accounts, partial deliveries, archive/reopen, exact-byte integrity, browser durability and large workloads. Require backup verification and approval before production rollout.
 
Cost: active shared data only, no new compute tier or paid service without approval; keep camera originals on their existing local/export path, no unnecessary original upload. Monitor organization-wide monthly storage/egress/realtime/compute, warn before limits, never auto-delete records or stop essential saving to meet a budget. New-client download is unavoidable once; repeated identical downloads should be avoided. Current active missing-media audit and object sizes belong in the private operational record, not in this public repository.
 
Status: server retention guard and PC retention changes are candidates; compact inventory SQL is a draft. Bulk restoration, atomic archived cleanup, full production integration, backup and real-device verification are release gates. No production mutation is performed by this branch.

PC backups: historical files with the exact registered hash are reused. New or conflicting files get immutable, asset/version-specific names; different nonempty existing files are never overwritten. Validate cloud bytes before creating a file, then re-read and verify before recording the PC receipt. A historical receipt is not proof that the original still exists. Recover conflicting/missing originals from any verified surviving copy; never declare all assets restored until checked.
