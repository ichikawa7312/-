import { sha256 } from '@noble/hashes/sha2.js';

export const version = 1;
export const chunkBytes = 2 * 1024 * 1024;

// A repeated loader or two callers must share the same byte-read queue.
// Only a running job may own an ArrayBuffer; cancelled jobs retain their
// position until any already-started read has settled.
const queueKey = Symbol.for('sentlog.blob-sha256.queue.v1');
if (!globalThis[queueKey]) {
  Object.defineProperty(globalThis, queueKey, { value: { tail: Promise.resolve() } });
}
const queue = globalThis[queueKey];
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const failure = (code, message, name = 'Error') => Object.assign(new Error(message), { code, name });

export function digest(blob, options = {}) {
  const { crypto = globalThis.crypto, validate = () => {}, signal } = options;
  const size = blob?.size;
  if (!Number.isSafeInteger(size) || size < 0 || typeof blob?.arrayBuffer !== 'function' ||
    typeof blob?.slice !== 'function' || typeof validate !== 'function' ||
    signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    return Promise.reject(failure('BLOB_HASH_CONFIG', 'ファイル内容を照合する方法を確認できません'));
  }
  function check() {
    if (signal?.aborted) throw failure('BLOB_HASH_ABORTED', 'ファイル内容の照合を中止しました', 'AbortError');
    const result = validate();
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    if (result === false || result && typeof result.then === 'function') {
      throw failure('BLOB_HASH_CONTEXT', '内容照合中に対象が変わりました。元のファイルを保持しています');
    }
    if (blob.size !== size) throw failure('BLOB_HASH_CHANGED', '照合中にファイルの容量が変わりました');
  }
  try { check(); } catch (error) { return Promise.reject(error); }

  const before = queue.tail;
  let release;
  queue.tail = new Promise(resolve => { release = resolve; });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(failure('BLOB_HASH_ABORTED', 'ファイル内容の照合を中止しました', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    // Queue-tail rejection is contained so an interrupted job cannot prevent
    // a later independent file from being verified.
    Promise.resolve(before).catch(() => {}).then(async () => {
      let hasher;
      try {
        check();
        if (size <= chunkBytes) {
          if (typeof crypto?.subtle?.digest !== 'function') {
            throw failure('BLOB_HASH_UNAVAILABLE', 'ファイル内容の照合機能を利用できません');
          }
          let bytes = await blob.arrayBuffer();
          check();
          if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength !== size) {
            throw failure('BLOB_HASH_BYTES', 'ファイルの読取り容量が一致しません');
          }
          const result = await crypto.subtle.digest('SHA-256', bytes);
          bytes = null;
          check();
          finish(null, hex(new Uint8Array(result)));
          return;
        }
        hasher = sha256.create();
        for (let offset = 0; offset < size; offset += chunkBytes) {
          check();
          const end = Math.min(size, offset + chunkBytes);
          let part = blob.slice(offset, end);
          if (part?.size !== end - offset || typeof part.arrayBuffer !== 'function') {
            throw failure('BLOB_HASH_BYTES', '分割したファイルの読取り容量が一致しません');
          }
          let bytes = await part.arrayBuffer();
          check();
          if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength !== end - offset) {
            throw failure('BLOB_HASH_BYTES', '分割したファイルの読取り容量が一致しません');
          }
          hasher.update(new Uint8Array(bytes));
          bytes = null;
          part = null;
          // Yield a task, including after the last chunk, so UI/cancellation
          // can run before the digest is accepted. No whole-file buffer exists.
          await new Promise(resolveYield => setTimeout(resolveYield, 0));
          check();
        }
        const result = hasher.digest();
        check();
        finish(null, hex(result));
      } catch (error) {
        finish(error);
      } finally {
        hasher?.destroy();
        signal?.removeEventListener('abort', abort);
        release();
      }
    });
  });
}
