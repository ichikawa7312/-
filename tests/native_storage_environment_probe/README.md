# Isolated native storage probe

This manual diagnostic is independent of Sentlog. It helps distinguish a browser
environment's storage behavior from the application's writer and sync code.
Serve this directory on an isolated test origin, open `index.html`, and press the
explicit start button. Do not install it into a production origin.

The runner creates a fresh UUID-named database with three stores. It attempts up
to 24 strict transactions, each containing one random 4 MiB Blob and one small
control value. It records the Blob request result separately from transaction
completion, and compares SHA-256 on every completed value immediately and after
the run. It retains native transaction errors and unexpected connection-close
events. It does not delete, clear, or close the database itself.

`inspect.html` uses only `navigator.storage.estimate()` and
`indexedDB.databases()` to inspect the test origin. It does not open a database.
Both pages export the displayed report using their download buttons. No customer
content, Sentlog module, network service, Service Worker, or CacheStorage is used.

The probe is diagnostic; a failed run is preserved as evidence. The reported
quota is an estimate, and the observed last successful write does not establish
an exact fixed quota. A successful request does not establish a committed
transaction. The probe also does not establish the storage behavior of a
physical iPhone or iPad.

`small.html` repeats the same implementation with one 4 MiB write as a bounded
retention control. Its result must be kept separate from the large-write run.
