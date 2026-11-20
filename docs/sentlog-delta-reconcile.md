# 差分同期の初期データ照合

`sentlog/delta-sync-reconcile.js` は、サーバーで検証済みの baseline と、旧端末の保存内容を保護した `sentlog-legacy-source` を照合する純粋な planner である。旧ストア、IndexedDB、新 replica、クラウドへ書き込まない。実行する I/O は呼び出し側が渡す読み取り専用のページ取得関数だけである。

## 入力と出力

```js
const baseline = await SentlogDeltaReconcile.readBaseline({
  scope, // {ownerId, projectId: cloudProjectId, deviceId}
  receipt,
  readPage: (after, limit) => transport.readBaselinePage(
    receipt.baselineId, after, limit, {signal}),
  readMetadataPage: (after, limit) => transport.readBaselineMetadataPage(
    receipt.baselineId, after, limit, {signal}),
  currentScope,
  signal
});
const plan = await SentlogDeltaReconcile.plan({
  scope, baseline, localSnapshot, currentScope, signal,
  groupTransport: transport // ready() が確認した atomicGroups capability
});
await SentlogDeltaReconcile.verifyPlan(plan, {scope, currentScope, signal});
```

`readBaseline` は `version:1, kind:'sentlog-delta-baseline'` として receipt、記録行、図面情報行を返す。各行にはサーバーが返した正確な JSON 文字列、SHA-256、manifest 項目の正確な文字列を保持する。解析した記録は `row.record`、解析した図面情報は `row.value` に置く。`verifyBaseline` はこれらの文字列・解析値を再検証し、控えを返す。`verified:true` というフラグだけを信用しない。

`plan` の主な返却値は次の通り。

| フィールド | 内容 |
| --- | --- |
| `state` | core v2 の `{version:2, scope, cursor:0, records, outbox, blockedOutbox:[]}` |
| `baselineReceipt` | ページ取得中に変化していないことを確認した receipt |
| `sourceFingerprint` / `localProjectId` | 保護元の控えとローカル案件の識別情報 |
| `reviewItems` | 内容を保持した個別の確認項目。`blocking` で初期保存を止める必要があるか示す |
| `metadata.header` / `metadata.drawings` | サーバーが返した記録以外の案件・図面情報 |
| `metadata.localView` | 端末固有の表示情報・再計算可能なカウンター。JSON-safe な値のみ |
| `preservedLocal` | 正確な `rawEntries`、保存元情報、原本台帳、撮影 intent、ファイル descriptor と manifest |
| `summary` | 元の記録数、照合後の記録数、未送信 unit 数 `pending`、member event 数 `pendingEvents`、停止項目数、同時編集候補数 |
| `planSha256` | state・対象 scope・receipt・保護元情報・確認項目・readiness を結び付ける検証値 |
| `readyForInstall` | この planner が扱う内容に、初期保存を妨げる確認項目がないこと |
| `readyForActivation` / `readyForCloudSync` | 常に `false`。この処理ではクラウドへの切替や写真の配送を保証しない |

`files` の Blob 本体は `preservedLocal` に再複製しない。Blob と rawEntries の完全な保護コピーは、既存の legacy source と migration shadow の責務である。planner はファイル内容を読み出していないため、この出力を写真原本の保護証明にしてはならない。

## 正確なサーバー JSON とページの検証

hash format は `postgres-jsonb-text-sha256-v1` に固定する。JavaScript の再シリアライズでは PostgreSQL jsonb の空白・キー順序・数値表現を再現できないため、SHA-256 は必ず受信した `recordJson` / `metadataJson` の UTF-8 バイト列から計算する。

各 manifest 項目は解析した ordinal、図面 ID と記録 ID、または metadata kind と key、および内容 SHA と厳密に対応する。完全な manifest は、受信した `manifestEntryJson` を ordinal 順に `, ` で連結し `[` と `]` で囲んだ文字列の SHA-256 で検証する。行単位の一致だけで完了扱いにしない。

以下の条件が必要である。

- receipt の owner、クラウド案件、ローカル案件、baseline ID、正の snapshot revision、cursor 0、件数、hash format、状態が妥当である。
- receipt は `verified` または `active` であり、`importedCount === recordCount`。`deltaEnabled` は `active` と一致する。
- `drawingIds` に重複がなく、metadata は header 1 件と図面ごとの 1 件を持つ。記録が 0 件の図面もここで確認する。
- ordinal は欠落も重複もなく、`nextOrdinal`、`hasMore`、ページ長、最終件数が一致する。記録が 0 件のときも認証済みの空ページを一度読む。
- 全ページの receipt が等しい。取得途中で baseline、revision、activation state が変わった場合は再取得する。
- metadata header の `project.id` と `project.drawings` は receipt の識別情報と一致する。各図面 metadata の `meta.id` が一致し、state に記録配列が紛れ込んでいない。
- currentScope と AbortSignal を各非同期境界で確認する。対象の切替・中止後の応答を採用しない。

デフォルトは 1 ページ 100 行、全体 20,000 記録、記録 JSON と manifest と metadata の合計 64 MiB までとする。metadata 件数にも同等の境界を設ける。上限に達した場合、途中までを完成した基準として返さない。限度は `pageLimit`、`maxRecords`、`maxBytes` で明示できる。

SQL は `project.drawings` と drawing envelope の順序・詳細 metadata が完全一致することまでは要求しない。この場合も読み取ったバイト列は検証できるため reader は全内容を返し、planner が相違を保護した `RECONCILE_BASELINE_DRAWING_METADATA` として初期保存を止める。どちらか片方を黙って採用しない。

## 記録の照合

記録のキーは core と同じ `JSON.stringify([drawingId, recordId])`。同じ記録 ID が別図面にあっても混ぜない。

初期 state は baseline の全記録から始める。端末に存在しない記録を削除とは扱わず、サーバー側だけにある記録を残す。端末側だけにある記録は、baseline に存在する図面へ属することを確認して create 差分にする。既存記録の両履歴は `record-collaboration.js` の immutable history merger で統合し、サーバーにない revision だけを patch にする。

コメントは revision / comment ID で区別し、文章が同じという理由で統合しない。写真も ID と不変の履歴で照合する。同時に変更されたフィールドや削除と追記の競合は、共同編集モデルが表現できる全候補を保持し、非停止の確認項目として残す。時計の新しさで片方を勝者にしない。

各 outbox event ID は `migration:` に内容の SHA-256 を付ける。hash の対象は owner と event ID 以外の差分内容であり、project、drawing、record、device も含む。同じ内容を同じ端末で再計画すれば ID は同じになる。再撮影時刻や控えの fingerprint が変わるだけで新しい event ID にしない。

queue へ入れる前に、core の payload 検証、PostgreSQL jsonb の空白・指数表記展開を含む 256 KiB 上限、および `combine(baselineRecord, event)` による再構築結果を検証する。1 つの大きすぎる記録や壊れた履歴は元の内容を review に残し、他の有効な記録の計画は続ける。ただし停止項目が残る計画全体は初期保存できない。

旧版の未送信移動は「元の記録の削除」と「移動先の新規作成」を一つの送信単位にする。新規の `transferOrigin.operation:'move'`、同じ記録 ID の図面間移動、対応が不明な新規作成と新規削除履歴の組合せを検出し、`groupTransport.pushGroup` と確認済み `getCapabilities().atomicGroups` がある場合にのみ、候補 outbox 全体を `kind:'atomic-group'` にまとめる。`groupId` は scope と順序付き events の canonical SHA-256 から作るため、同じ元入力の再計画・seed 再試行で変化しない。hash の非同期計算後にも scope と capability を再確認する。

group は core の 1〜500 events、各 event 256 KiB、全体 4 MiB の PostgreSQL JSONB text 上限を検証する。一括送信に非対応なら `RECONCILE_ATOMIC_GROUP_REQUIRED`、容量上限ならその理由を保持し、初期保存を止める。元の candidate events を自動で solo 送信へ戻さない。source が存在しない、または source の削除済み／削除競合履歴がない destination-only move は、group 対応済みでも `RECONCILE_MOVE_INCOMPLETE` として止める。baseline 側で source の tombstone が既に確定している場合は、新規 destination だけの 1 member group で補完できる。

候補 state と outbox と元の raw は診断・再計画用に保持する。`verifyPlan()` は core の group を含む state 検証を行うが、確認項目を自動承認しない。baseline へ既に取り込まれた移動済み記録への通常の追記や、元の記録を残すコピーはこの理由では止めない。通常 solo outbox との互換は維持する。

以下は自動採用せず、サーバーの記録とすべての端末候補を review に保存する。

- 同じ ID の revision の内容・コメント順序が書き換わっている。
- 共同編集履歴がない、親履歴が不足する、削除の observed が不明な変更を参照する。
- 履歴から復元した内容と raw の memo・フィールド・写真が異なり、入力がまだ履歴化されていない。
- 同じ図面で記録 ID が重複する、削除済み配列と削除履歴が一致しない。
- baseline にない図面へ記録がある、図面 ID・案件対応を一意に決められない。
- merger が引き継げない未知の collab / entry / projection metadata がある。
- 再構築できない差分、送信上限超過、送信形式にできないデータがある。

raw の `photos[].localBlob` と `photos[].data` は既存の snapshot exporter と同じく通信用レコードから除く。元の rawEntries とファイル控えは保持する。未知の写真 bytes を履歴へ混ぜて送信することはしない。`globalNo`、`typeNo`、`autoLabel`、`recordNo`、`labelPosEditedAt` は共同編集モデルの派生値として扱い、元の端末値は保護した rawEntries に残る。bridge は画面に実際に残る記録から採番とカウンターを再計算し、図面メモ・寸法を採番から除外する。`labelPosEditedAt` は元の端末 view から保持する。

## 案件・図面設定と端末表示情報

旧入力は実ストアの `surveyFieldNoteWorkspaceV1`、`surveyFieldNoteDrawingV1:<drawingId>` から解析する。任意の架空 snapshot 形式へ置き換えて比較しない。案件名、図面一覧と順序、図面の名前・ファイル参照、縮尺・回転・用紙設定などに差があれば、双方を保護した review にする。未対応の header 情報も初期保存を止める。

既存の snapshot merger と同じく、案件の `updatedAt`、図面 metadata の `updatedAt` / `shapeCount` / `photoCount`、state の `currentPage` / `width` / `height` / `pdfPageInfo` / `nextGlobalNo` / `typeCounters` を意味のある共有設定差から除く。snapshot exporter が送らない `labelSize` も端末表示情報として扱う。これらは `metadata.localView` に別途保持する。JSON に表現できない値を新しい metadata に作らない。

## 保存・認証・切替との境界

検証値は改変検知であり、認証署名ではない。receipt の実際の認証済み取得は transport とサーバー RPC の責務である。reader に呼び出し側が作った偽 receipt を渡せば、それを本物と証明する能力はない。呼び出し側は実セッションに結び付いた transport を用いる。

planner は source fingerprint 自体を再計算しない。保護した source の内容一致と、保存直前まで旧 source が変化していないことは `source.recheck` と migration の検証で確認する。通常 replica を初期保存する coordinator は少なくとも次を満たす必要がある。

1. source の rawEntries と必要な Blob を migration shadow に保護し、完全性を検証する。
2. 認証済み baseline を読み、planner と `verifyPlan` に通す。
3. `readyForInstall === true` を明示して確認する。`verifyPlan` 単体は停止項目を含む有効な計画にも成功する。
4. normal replica の保存には `baselineReceipt.state === 'active'` と `deltaEnabled === true` を要求する。`verified` baseline の計画は保護・比較段階までである。
5. 旧保存と旧送信が競合しない実際の fence を保持し、最終 `source.recheck` と scope / abort 再確認を行う。
6. state、baseline receipt、source provenance、plan hash、metadata を原子的に新規 seed する。既存 replica の未送信変更を上書きしない。同じ seed の再試行は現在の状態を保持して再開する。

写真の他端末配送、原本の完全性、旧端末からの snapshot 保存遮断、本番切替の許可は別の検証である。この module は `readyForActivation` や `readyForCloudSync` を true にしない。

## 検証

`node tests/delta_reconcile.test.cjs` は合成 source・ページを用い、保持・停止・履歴競合・hash・欠落ページ・scope・上限・元データ不変性を検証する。shared cases は Node とブラウザー fixture の両方から呼べる。

group 対応では、確認済み transport の陽性経路、同じ入力の group ID 再現性、hash 中の capability 失効、片側 move の停止、baseline に確定済みの削除との補完を検証する。`delta_app_bridge.test.cjs` は実 transfer・採番・旧 record-store batch の控えをこの planner に通す。`delta_bootstrap.test.cjs` は grouped state の原子的 seed と再起動後の再読込まで検証する。これらは metadata 差分や最終 production controller まで完成したことを示さない。

`tests/delta_baseline_assertions.sql` には metadata の exact hash、manifest、ページ、空図面、案件 binding、権限、機器失効、上限の確認を追加した。

`tests/delta_reconcile_sql_contract.cjs --pglite` は使い捨ての SQL engine 上で実 RPC のページを取得し、JS reader / planner を通した outbox を SQL payload / history validator へ戻して同じ履歴になることを確認する。外部 DB の接続 URL を受け取らない。

PostgreSQL の CI では、既存の使い捨て DB に prototype SQL と baseline fixture を準備したあと、次を実行する。fixture の変更は rollback される。

```sh
psql -XqAt -v ON_ERROR_STOP=1 -f tests/delta_reconcile_sql_fixture.sql \
  | node tests/delta_reconcile_sql_contract.cjs --stdin --sql \
  | psql -X -v ON_ERROR_STOP=1
```

これはローカル・CI の契約検証であり、実アカウントの認証、実ネットワーク、IndexedDB 原子的保存、ブラウザーの再起動、端末間写真配送を単独では証明しない。
