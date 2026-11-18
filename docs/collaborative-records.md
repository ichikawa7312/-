# Shared record collaboration

## Acceptance story

A creates or moves a record and takes a photograph while B appends a comment to
that same record. Both devices receive both contributions. A confirmed change to
one existing value must not erase an unseen change. A pending decision never
blocks unrelated comments or photo additions in that project.

## Implementation boundaries

- Immutable per-record revision IDs retain comments, field changes, photo
  associations and explicit deletion history. Timestamps are display metadata,
  not the rule for choosing a winning value.
- The existing revision-checked project snapshot remains the authoritative
  transport. Upgraded projects reject writers without the new protocol and
  reject removal or modification of existing collaboration revision history.
- Private server notifications carry only project IDs and update numbers.
  Reconnect always rechecks persistent state; notifications are not persistence.
- Record metadata has its own serialized worker, independent of image transfer.
- Camera targets are fixed before opening the chooser. Photo bytes and pending
  association metadata remain recoverable across interrupted processing.
- Comments use durable local drafts and explicit append/edit operations.
- Report text is the current comment body projection. Device labels and old
  revisions are separate metadata. Existing report drafts retain deliberate edits.

## Required evidence before release

1. Convergent append, edit conflict, scalar confirmation, delete versus edit,
   retry, old-client protocol and immutable history tests.
2. Two full browser contexts with a shared simulated CAS server; Chromium and
   WebKit; incoming updates during Japanese input and camera processing.
3. Photo/comment delivery while image upload is stalled, notification loss and
   offline reconnection, no duplicate or cross-point photo association.
4. Undo never removes a remote contribution; long comments and stale ledger
   drafts are explicit; all four Excel formats remain available.
5. Database checks use rolled-back synthetic fixtures and owner isolation.
6. Build the exact Pages artifact and verify deployed resource hashes.

Physical iPhone/iPad camera timing and real-world network latency require device
confirmation; browser emulation does not prove those outcomes.
