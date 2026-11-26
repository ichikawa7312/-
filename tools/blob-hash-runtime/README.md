# Bounded Blob SHA-256 runtime

This directory builds the offline runtime at `sentlog/blob-sha256.js`.
The runtime uses `@noble/hashes` **2.0.1**, SHA-256 only, and esbuild
**0.25.0**. Both versions and registry integrity hashes are pinned in
`package-lock.json`. The generated browser file is committed; deployed clients
do not fetch packages or execute a package installer.

## Rebuild

```sh
cd tools/blob-hash-runtime
npm ci
npm run build
```

The build also copies the upstream MIT license into
`noble-hashes-LICENSE.txt`. esbuild is a build tool and is not included in the
deployed application. Package source and incremental API documentation:

- <https://github.com/paulmillr/noble-hashes/tree/2.0.1>
- <https://www.npmjs.com/package/@noble/hashes/v/2.0.1>
- <https://github.com/evanw/esbuild/tree/v0.25.0>

## Runtime contract

`SentlogBlobSha256.digest(blob, { crypto, validate, signal })` resolves to the
same lowercase, 64-character SHA-256 hex string as Web Crypto. CommonJS callers
may `require('./sentlog/blob-sha256.js')` to obtain the same API.

Blobs at most 2 MiB use Web Crypto. Larger Blobs are read through sequential
`slice(...).arrayBuffer()` calls of at most 2 MiB and fed into
`sha256.create().update(...)`. All Blob digest jobs in one JavaScript context
share one queue, including when the generated file is loaded again. Each large
chunk yields a task to the browser before continuing. A cancelled job never
authorizes a digest; any read already in flight must finish before the next job
can start. References to chunk buffers are released before yielding.

`validate` is a synchronous guard. Its thrown error is preserved, and returning
`false` or a Promise rejects the hash. It is checked before work, after every
read, and after every task yield. `AbortSignal` cancellation rejects promptly
while ensuring an outstanding read cannot overlap the next queued read.

Only byte hashing changes. JSON text hashing, file identity, expected hashes,
receipt validation, storage paths, and file-deletion permissions are not
implemented by this module.
