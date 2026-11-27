# Synthetic restore → nine-value receive comparison

This fixture uses the built production `blob-sha256.js`, `backup-format.js`,
`startup-backup-recovery.js`, and `record-store.js` unchanged. It tests the
storage sequence, **not authentication, actual network sync, or the full cloud
scheduler**. `source-manifest.json` identifies the bytes that actually run.

The two conditions are Unicode and ASCII with identical UTF-8 byte budgets.
Unicode also matches the measured UTF-16 code-unit counts. These lengths are
not estimates of V8 serialization, native compression, physical disk use, or
the browser's enforced quota. Content and binary bytes are newly generated;
compression is only approximated with a deterministic repeat/entropy mix.
The checked-in profile contains ordinal counts, lengths and generic MIME types,
without customer identifiers, text, names, coordinates, hashes or binary data.

The primary sequence is:

1. Require a new empty IndexedDB origin, create the fixture's empty schema and
   migration marker, then run the production startup recovery and readback.
2. Restore 6 projects, 217 drawing states, 1,558 shapes and 224 managed strings
   containing 10,698,470 UTF-8 bytes. The 35 attachments contain 31,441,939 bytes
   and preserve the input representation mix of 8 native Files and 27 Blobs.
3. Fetch and cache the built service worker's same-origin static FILES, with
   exact body hashes. External PDF CDN resources are omitted. No service worker
   is registered and no arbitrary cache ballast is added.
4. Begin real production staging for a synthetic project with seven files.
   This matches the observed cutoff-file count; the actual binding identity
   was not captured, so the selected synthetic project is a reconstruction.
5. Receive seven drawing states, the workspace, and one sync metadata value
   through one production batch: 9 strings / 4,098,583 UTF-8 bytes. The sync
   envelope is inferred from the measured total, not a captured server reply.
6. Compare every managed string and all live/cutoff binary body hashes and
   metadata. Close the native browser process, relaunch its own profile, and
   compare all three store digests, records, Files/Blobs and static cache again.

The optional existing-project baseline prefill is **off** in both CI conditions.
Its success before the actual nine-value failure was not established. The
manual checkbox is labeled as an additional assumption and recorded in the
report; it is not an extra CI condition.

Native request observers retain the original transaction and request objects
and handlers. They record request successes and commit/abort separately. After
the first failure the run stops and performs readonly diagnostics. A missing
database is never recreated by an observer; an unexpected upgrade is aborted.
There is no clear/delete/retry/quota override/internal-browser-info access.
Foreign databases cause a stop, preserving the production recovery guard.

## Running

First assemble the canonical production `sentlog/` directory, then run:

```sh
python tests/record_storage_real_sequence_ui.py --engine chromium --out /tmp/sentlog-real-sequence-chromium
python tests/record_storage_real_sequence_ui.py --engine webkit --out /tmp/sentlog-real-sequence-webkit
```

Each command runs the two conditions in separate disposable persistent
profiles. Output directories contain JSON reports only. Profiles and packaged
assets use separate temporary directories and are never uploaded as artifacts.
A missing browser, fixture failure or mismatched data exits nonzero. Native
profiles are not the user's browser or browser profile.

For a manual ordinary HTTPS preview, prepare a new output directory:

```sh
python scripts/prepare_record_restore_sequence.py --built-root /path/to/assembled/repo --out /path/to/new/package/sequence
```

Serve the whole `sequence/` directory unchanged. The buttons run the same
JavaScript as CI. A successful manual page reload only establishes page-reload
readback; it does not establish a browser process restart. A distinct page-load
nonce is required before the verification button can succeed. An origin with
an existing diagnostic database cannot run production recovery and must be
reported as untested; do not clear it or bypass the guard.
