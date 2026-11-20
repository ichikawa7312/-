# 差分同期と実アプリ保存経路の接続

> 2026-11-20更新: この文書は部品開発時の設計・検証記録です。実アプリのwriter、共有metadata、写真、PC保管への接続は、その後のapp runtimeと最終builderで実装しました。本文の「未接続」「未実装」は当時の状態を示します。現在の検証結果と公開判断は[本番反映判断](sentlog-delta-production-readiness.md)と[リリース手順](sentlog-delta-release.md)を参照してください。

## 現在できることと切替条件

`sentlog/delta-sync-app-bridge.js` は、実アプリの案件・図面状態を、既存の共同編集履歴を保った記録差分に変換する専用モジュールである。`SentlogRecords` のメモリ控えから編集前後を取得し、差分 replica に存在する全記録の系譜を照合してから、複数記録を **1 回の端末保存**に渡す。通常編集には `core.changeBatch()`、移動には認証済み transport が対応を確認した `core.changeGroup()` を使う。受信済みの追記や別記録も含め、保存後の replica から画面用の状態を再構成する。

本番 HTML、service worker、既存 builder には読み込ませていない。旧 `SentlogRecords` への書込み、案件の切替、Supabase への接続、写真本体の転送は行わない。公開する編集計画と結果の `readyForActivation` は常に `false` である。

記録の内容だけを扱える現在の差分 protocol に合わせ、縮尺・回転・図面追加・保管などの metadata 変更は `metadataChanges` と元の入力全体に保持する。その編集計画は一部だけ保存せず、全体を保存対象外とする。これは metadata を扱う protocol と全 writer の切替を実装するまでの保護であり、実アプリ接続の完成を意味しない。

core / transport / SQL に、図面間移動の元記録の tombstone と移動先の新規記録を、端末保存・サーバー transaction・受信側の反映まで一つの group として扱う経路を実装した。bridge は `transport.ready()` が確認した `atomicGroups:true` を replica 経由で確認し、完全な移動を group として保存する。未対応サーバー、権限失効、片側しか捕捉していない入力では計画全体を保持する。これは記録単位の一括同期の実装であり、以下に記載する本番全 writer・共有 metadata・ファイルの接続完了を意味しない。

## 調査した実 writer の境界

以下はソースと builder による最終変換を合わせた経路である。元の `record-store.js` と最終配布物の API は同一ではない。特に `archiveAtomic` は `scripts/build_capacity.py` が追加し、受信経路は後段 builder が変更する。

| 操作 | 現在の入口・保存単位 | 差分接続で必要な処理 |
| --- | --- | --- |
| 通常の記録、図面メモ、寸法、形状、ラベル、コメント | `part05.txt` の `persist()` → drawing の `setItem()` → `updateActiveMeta()` → workspace の `setItem()`。同一 turn の更新が `record-store.js` の lexical `batch()` と microtask によって 1 transaction にまとまる | drawing と workspace を一つの編集として捕捉する。別々に delta 保存して成功扱いにしない |
| 共同編集コメント・値・削除・復元・undo | `collaboration-editor.js` が immutable revision を作成後、既存 `persist()` を使用。入力途中のコメント・判断は別の localStorage 草稿にも保持 | 草稿の保持を継続し、commit で確定した投影を再表示する。raw textarea の空欄を削除に変換しない |
| 写真追加と関連付け | `collaboration-photos.js`、`photo-capture-intent.js`、`original-photo-store.js` と `writeFile()`、最後に記録保存 | 記録 metadata と本体の配送状態を分離する。記録保存の成功を写真本体の検証完了にしない |
| 図面間・ページ間コピー／移動 | `record-transfer.js` の executor が写真コピーと採番を行い、移動先・移動元・workspace を `batch()` で更新、`flush()` を待つ | 操作種別を明示して捕捉。move は source / destination を `changeGroup()` で一括保存し、写真本体の配送は別途検証。対応確認なしに個別 event へ分解しない |
| 縮尺・用紙・回転 | `part08.txt` / `part09.txt` が `pageSettings` / `pageRotations` を変更し `persist()` | record revision には入らない drawing metadata の差分として扱う |
| ページ非表示・復旧 | `page-management.js` が `pageStates`、復旧用控えなどを更新 | metadata と復旧用ファイルの存在を保持し、図面内記録の削除と混同しない |
| PDF／図面差替えと復元 | `page-replacement.js` が background・復旧用 metadata / Blob を `writeFile()`、`pageReplacements` 等を更新して `persist()` | ファイル hash と対応 metadata を世代に結び付け、古い書込の遅着で新背景を置換しない |
| 図面名・グループ・シート順・ゴミ箱 | `drawing-list-actions.js`、`drawing-groups.js`、`drawing-order.js` が主に `archiveAtomic()` で workspace を更新 | `groupId` / `groupName` / `sheetName` / `groupOrder` / `sheetOrder` / `deletedAt` を含む metadata を保存 |
| 図面の完全削除 | `drawing-list-actions.js` の workspace / drawing key 削除と selected Blob 削除を `archiveAtomic()` で一括実行 | 単に配列から消えた記録を暗黙削除しない。図面削除、record tombstone、asset 回収条件の protocol が必要 |
| 保管・端末容量整理・PC から復旧 | `archive.js` のサーバー操作、および `archive-capacity.js` の `archiveAtomic()` / `writeFile()` | サーバーの案件 status と、この端末だけの `sentlogArchiveLocalV1` を分ける。端末から外す操作を共有削除に変換しない |
| バックアップ全復元 | `part05.txt` → `SentlogRecords.replaceAll()`。drain 後に旧 `files` store 全体を `clear()` し、record・Blob・revision を同一 transaction で戻す | delta 利用案件を含む全復元は別契約が必要。旧バックアップで現 replica / outbox / 未送信入力を初期化しない |
| 同期受信 | `sync-view.js` → 後段 `build_collaboration_editor.py` により expected raw records を同期比較して `batch(writes,{origin:'remote'})`。editor 草稿を捕捉・復元 | delta 受信を旧 snapshot writer に戻さず、replica から投影する。入力中、選択、IME、写真処理等の保護を引き継ぐ |
| device 正規化 | `collaborationNormalizeStored()` → `batch(...,{origin:'device'})` | server 由来／端末用の再構成を新しいユーザー編集として再送しない |
| 低層ファイルの全消去 | `part05.txt` の `clearDBFiles()` が `files` store を直接 cursor 走査し、Blob を削除。`SentlogRecords` を通らない | API の export を wrap しただけでは制御できない。新しい本体保存先の隔離と旧 writer の扱いを確認する |

`edit-sync.js` の `watchRecords()` は、`setItem` / `removeItem` / `batch` / `archiveAtomic` / `replaceAll` の実行後に変更を通知する。`remote` / `device` origin の除外や、workspace へまだ所属していない drawing の通知繰延べを行うが、保存を原子的に delta outbox へ移す仕組みではない。

また `record-store.js` の `setItem` / `removeItem` は **lexical `batch` を呼ぶ**。export された `records.batch` だけを後から置き換えても、これらの経路は捕捉できない。

## サーバー snapshot に入る metadata の正確な範囲

最終 cloud module は `scripts/build_collaboration_sync.py` により、`projectSnapshot()` を `collaboration-sync-runtime.txt` の `collaborationProjectSnapshot()` に差し替える。その実関数を Node fixture で評価し、以下を検証している。

### 保存 payload

| 部分 | 実際の構築・除外ルール |
| --- | --- |
| `payload.project` | `{...localProject, collaborationVersion:1}`。project の任意属性、`drawings` 配列、並び順、drawing meta、`updatedAt` を保持 |
| `payload.drawings[].meta` | 対応する drawing meta を全体として使用。件数、ファイル名、sourceType、pageCount、group / sheet 属性、`deletedAt`、任意属性を保持 |
| `payload.drawings[].state` | drawing state を複製し、`labelSize` のみ state 直下から除外。`currentPage` / `width` / `height` / `pdfPageInfo` は payload 自体には残る |
| `state.shapes` と `state.collabDeletedRecords` | 全記録を collab 正規化。各 record の `photos[].localBlob` / `photos[].data` を除外。既存履歴なしは baseline 付き upgrade、既存履歴ありは明示された履歴と raw 編集を整合させる |
| 削除済み record の raw 編集 | tombstone の投影と raw 内容が異なる場合は保持して失敗とする。黙って raw 内容を捨てない |
| 記録配列以外の drawing state | 既知フィールドだけを選び直さない。`pageSettings` / `pageRotations` / `pageStates` / `pageReplacements` / `dxf` / `leaderMarker` / `nextGlobalNo` / `typeCounters` / `autoTracePhotos` と未知属性を保持 |
| drawing state が読み取れない場合 | 旧 snapshot builder は `{meta, state:null}` を返す。新 bridge は実編集の開始に使える完全な drawing state を要求し、欠損を拒否 |

写真 cache 除外は record 内に対する明示的な処理である。`autoTracePhotos` 等を含む任意の state 属性を、この関数が再帰的にすべて無害化しているとは扱わない。bridge はそれらを metadata として保全し、現 protocol へ送信しない。

### 比較用 fingerprint と payload の違い

`sync-view.js` の `snapshotText()` は project と drawing meta の `updatedAt`、drawing state の `currentPage` / `width` / `height` / `pdfPageInfo` を比較から外す。`scripts/build_group_sync_migration.py` により、その前に `drawing-groups.js` の `normalizeSnapshotPayload()` を適用する。旧一枚図面に対して `groupId` / `groupName` / `sheetName` / `sheetOrder` などの既定値を補うためである。

`scripts/build_device_label_size.py` は `labelSize` の送信と端末上の dirty 判定を変更するが、**過去の snapshot fingerprint の計算を変更しない**。旧 baseline 内の `labelSize` まで一律に除外する比較器へ置き換えてはいけない。`sync-merge.js` では `nextGlobalNo` / `typeCounters` も view 欄として扱い、merge 後に採番を再構成するが、旧 snapshot payload にその値が存在しないという意味ではない。

新 bridge の `metadataOf()` は **編集分類のための比較値**であり、サーバー baseline hash の代わりではない。

- project `updatedAt` と drawing meta の `updatedAt` / `shapeCount` / `photoCount` を除外する。件数は replica 投影から再計算する。
- drawing state から記録配列と端末 view 7 項目（`currentPage` / `width` / `height` / `pdfPageInfo` / `labelSize` / `nextGlobalNo` / `typeCounters`）を除外する。
- drawing metadata の順序は drawing ID で安定化するが、project の `drawings` 配列の順序は保持して変更検出する。
- `nextGlobalNo` / `typeCounters` は実 `rebuildNumberingState()`、既存の snapshot merger と reconcile が採番の派生値として扱う。bridge も保存後の実記録から再計算する。旧値を受信後の画面へ上書きしない。通常記録の追加・種別変更・移動・コピーが採番だけを理由に停止することはない。
- 元の `before`、正規化後の `after`、正規化前の `submittedAfter` を計画に保持する。除外した比較属性を元データから削除する操作は行わない。

ローカルの `sentlogArchiveLocalV1`、cloud 同期 checkpoint の `sentlogCloudProjectSyncV2:*`、編集草稿、原本写真 DB、`files` store の Blob / 復旧用控えは、この project snapshot の外側に存在する。別々の writer として接続する必要がある。

## Bridge API と保存契約

```javascript
const bridge = SentlogDeltaAppBridge.createBridge({
  replica, // changeBatch / snapshotWithStatus、move には changeGroup / getCapabilities
  scope: {ownerId, projectId: cloudProjectId, deviceId},
  localProjectId,
  currentScope: () => ({ownerId, projectId: cloudProjectId, deviceId})
});

const before = SentlogDeltaAppBridge.captureProject({records, localProjectId});
// 記録した編集前状態と、UI が作った編集後状態を渡す。
// この例は shadow fixture の境界を表す。本番の persist を二重実行しない。
const plan = await bridge.prepare({before, after, operation:'edit', actor, at, idFactory});
const receipt = await bridge.commit(plan);
// receipt.projection を表示する。旧 records.setItem / batch へ書き戻さない。
```

`captureProject()` は `SentlogRecords.ready === true` を要求し、workspace から一意な local project を取得する。drawing ID が他案件と共有されていないこと、meta と state の揃い、読み取り中の raw 変化を確認する。未確定の UI 編集を含む **メモリ控え**であり、durable source の migration 証明には使用しない。

`prepare()` は、通常 record、`recordKind:'drawing-memo'`、`recordKind:'dimension-line'` を同じ immutable record model で処理する。既存の copy / move が作った新 ID の完全なコメント履歴を seed し直さない。写真やコメントが単に raw 配列・textarea から消えた場合、削除 revision がない限り保存しない。

`operation` は `edit` / `create` / `delete` / `restore` / `copy` / `move` の明示を必須にする。操作の片側だけを捕捉した場合、snapshot だけでは移動であることを必ずしも推測できないためである。実 controller はクリック・移動 executor の開始時点で種別を確定し、後から普通の edit に言い換えない。未指定／未知の操作は計画を保持して拒否する。

`move` の明示に加え、新規記録の `transferOrigin.operation:'move'`、同じ record ID の図面移動、新規作成と削除意図／消失の組合せを検出する。source link がない組合せも保守的に `atomicGroupRequired:true` とし、同一図面内のページ移動にも適用する。pure `prepare()` は `BRIDGE_ATOMIC_GROUP_REQUIRED` を残し、bound bridge だけが replica の確認済み機能に基づいて一括送信可能にする。呼出元の boolean で解除しない。`move` の明示には作成と削除の両方、`transferOrigin` には対応する source の削除を要求する。片側しかない場合の `BRIDGE_MOVE_INCOMPLETE` は capability があっても解除しない。既に移行済みの move 記録への通常追記と、source を残す copy は区別する。

group ID は `prepare({groupId})` で安定した操作 ID を渡すか、bridge が UUID を発行する。rebased events の件数・scope・容量を計画段階で検証し、private plan に group ID と全 member を保持する。保存直前にも core が capability と snapshot token を再確認する。group 対応が失効した計画を旧個別送信へ自動変換しない。

`createBridge().prepare()` は変更した記録だけでなく、編集開始時点の全記録が replica に存在し、全 ancestor revision を含むことを確認する。未変更記録の移行漏れが保存後の投影で消えるのを防ぐ。先に届いた peer 変更とは履歴を union し、scalar の同時変更は比較可能な候補として残す。未知の drawing に属する受信記録は metadata 照合が必要なため停止する。

`commit()` は、この bridge が発行した計画の private copy と snapshot token を用いる。呼出元が計画を書き換えても保存対象は変わらない。複数記録は core の 1 durable write に渡し、容量不足や stale token なら部分保存しない。同じ計画の同時 commit をまとめ、完了後の再実行にも同じ結果を返す。空の編集計画は現在の token を確認して書込みなしで再投影する。

scope 変更／終了は各非同期境界で確認する。保存中にログインが変わった場合、元 scope に保存された outbox は残し、新画面へ古い投影を返さない。receipt は端末保存の結果であり、同期完了、ファイル配送完了、activation の証明ではない。core の runtime snapshot token も JSON receipt に複製しない。

transport も `currentScope` を要求して遅着 RPC の適用を拒否するが、既存 app が渡す `refreshSession()` 自体の session 更新は app の責務である。logout／利用者切替後の遅い refresh 応答で旧 session を復活させない世代確認を controller に設ける。

`project()` は replica の記録を完全に反映し、削除済みは tombstone 配列へ分ける。既存の表示順と端末 view は template から保持し、peer だけが追加した記録は安定した順で末尾に追加する。通常記録の `globalNo` / `typeNo` / `autoLabel` と field record の `recordNo`、drawing の `nextGlobalNo` / `typeCounters` / `shapeCount` を投影した記録から再計算する。図面メモ・寸法は採番から除外し、手入力の `no` や共有フィールドは書き換えない。写真 cache は現在の metadata と一致するものだけ復元する。選択・入力草稿・履歴を復元する既存 editor hooks への接続は、実アプリ controller 側で行う。

## 一括同期の保存・送受信契約

outbox は既存の solo event と次の envelope を混在できる。既存 solo の識別情報・再送動作は維持する。

```javascript
{
  schema: 1,
  kind: 'atomic-group',
  groupId,
  projectId,
  deviceId,
  events: [sourceTombstoneEvent, destinationCreateEvent]
}
```

group は 1〜500 event、各 event は PostgreSQL JSONB text の UTF-8 256 KiB まで、group 全体は同じ表現で 4 MiB まで。許可キーは上記 6 個だけであり、members の event ID、project、device を検証する。大きい移動を自動的に個別 event へ分割しない。

- `changeGroup()` は全 member を clone 上で検証し、記録と group 全体を 1 回の durable write で保存する。後段の stale・不正履歴・容量不足なら前段も保存しない。
- `pushGroup()` は group ID と完全な envelope による冪等送信を行う。ACK の group・scope・連続 seq 範囲・順序付き member ID をすべて照合するまで outbox を削除しない。timeout、ACK 消失、ACK 保存失敗では同じ group を再送する。
- `list()` は `{seq,event}` または `{seq:startSeq,endSeq,group}` を返す。ページ件数は group を含む unit 数であり、途中で分割しない。受信 core は全 member を検証してから、記録と `cursor=endSeq` を 1 回で確定する。member ごとの中間画面や group 内部 cursor は公開しない。
- group が明示的な履歴不整合等で拒否された場合、group 全体と、その記録に依存する後続 group / solo を確認待ちに保護する。依存しない記録は同期を続ける。認証・通信・未対応サーバーの失敗を記録不良として隔離しない。
- 古い list RPC は未読 group を検出すると upgrade-required を返す。旧 receiver に source 側だけを読み出させない。実環境へのこの SQL 導入と旧クライアント遮断は本番切替の必須条件である。

`changeBatch()` は従来どおり端末保存だけをまとめる API であり、outbox は solo のままである。移動の controller は必ず bridge の `atomicGroupRequired` に従い `changeGroup()` を使う。

## 最小で安全な実接続の次工程

1. **metadata を扱う保存契約を作る。** project / drawing metadata の baseline、差分、変更前条件、削除／復元、未知属性を保持する形式を定義する。縮尺や背景世代は関連する record edit / asset 参照と同じ操作に結び付ける。記録だけ成功させて metadata を残す分割処理にはしない。
2. **一括同期を本番の操作経路へ接続する。** 上記 core / transport / SQL の group 経路を、実 transfer executor、migration bootstrap、受信投影から使用する。`changeBatch` を移動に流用しない。実認証セッションと本番 SQL で capability を確認し、公開前に実ブラウザーの中断・再起動・旧新クライアント混在を検証する。
3. **旧 writer の transaction 内に切替確認を置く。** `commitBatch()` の META 読取後、`archiveAtomic()` の最終 commit 前、`replaceAll()` の `clear()` 前、および `writeFile()` と直接 Blob writer を対象にする。公開関数の開始時にフラグを見るだけでは、await 中／既に queue に入った保存を防げない。対象外案件の旧保存は継続できるようにする。
4. **有効案件の編集だけを新 controller へ渡す。** 同期 `persist()` の複数 setItem を、保持済み草稿と一括 async commit に変換する。mirror と outbox を別 DB に順番に書く二重保存は使わない。成功後は replica の投影を採用し、旧 snapshot worker をその案件の writer として再起動しない。新 drawing が workspace に加わる前の単独保存も一つの操作にまとめる。
5. **古いタブと旧ファイル保存先を扱う。** 既存の Web Lock だけに頼らず、activation 時点の drain と durable revision 照合、旧タブが持つ revision の失効、必要な client 世代チェックを行う。`writeFile` と `clearDBFiles` は旧 record revision に従わない。新しい正本・ファイル控えを旧 `files` store の clear に巻き込ませず、source は照合済み控えとして保持する。新 replica は `sentlog-delta-v1`、migration 控えは別 DB なので、旧 `replaceAll` の store clear が直接それらを消すことはないが、それだけでは旧入力の救出や全ファイル経路の安全を保証しない。
6. **受信と全復元を接続する。** `origin:'remote'` は delta の受信投影へ、端末用の view / archive 状態は端末保存へ分ける。全 workspace 復元で複数案件を巻き込む場合、未切替案件・別 owner・未送信 outbox を保った復元契約を作る。切替済み案件を含む旧 restore を無条件で通さない。

サーバー側の旧 snapshot writer 拒否も必要である。画面の停止表示、loader URL の変更、service worker の更新、API の export wrapper のみでは、既に開いている旧画面からの保存を制御したことにはならない。現在の SQL prototype が切替を許す条件と、ここで列挙した writer coverage の証跡を一緒に確認する。

## 検証

`tests/delta_app_bridge.test.cjs` は `fake-indexeddb` の独立した DB で実 `record-store.js` を実行し、`part05.txt` から抽出した実 `persist()` と exported `batch()` を使用する。cloud metadata の検証も `collaboration-sync-runtime.txt` の実関数を評価する。test 内で旧保存を行うのは編集の shadow fixture を作るためであり、bridge が本番旧 writer を切替済みであることを示すものではない。

検証範囲は、通常編集、図面メモ・寸法、コピー元の完全な履歴、実 transfer と採番関数を通る図面間移動の group commit、migration group の再現性、capability 失効、片側 move の拒否、peer 追記・追加後の再採番、同時 scalar、record / photo / comment の明示削除、復元、raw 削除の拒否、全 baseline 記録の存在と系譜、metadata の保持、実 snapshot の除外規則、写真 cache と表示順、計画の改変耐性、二重 commit、stale token と再計画、容量不足と再保存、利用者／案件／端末の切替、終了後の遅着を含む。

```sh
NODE_PATH=/path/to/test-runtime/node_modules node tests/delta_app_bridge.test.cjs
node tests/delta_batch_paging.test.cjs
NODE_PATH=/path/to/test-runtime/node_modules node tests/delta_group_sync.test.cjs
node --check sentlog/delta-sync-app-bridge.js
```

`delta_batch_paging.test.cjs` は旧 `change()` の戻り値互換、複数／同一記録の順次 batch、後段不正時の全取消、冪等再実行、snapshot token、入力の捕捉時点、容量不足、blocked dependency、`hasMore` 付き短ページ、明示終端、旧 plain array のページング、途中受信失敗からの再開を検証する。空なのに `hasMore:true` の応答と、不正な `hasMore` 型は同期完了とせず拒否する。

batch suite は、移動を旧 solo events に分割した場合の片側成功も再現する。これは互換 API を誤って移動へ使用しないための反例である。group suite は正しい一括経路で、後段の server 拒否・ACK 消失・保存失敗・timeout・close・再起動・不正な後段 member・短いページ・複数端末の同時移動・移動と追記の競合・実 IndexedDB 再読込を検証する。SQL group suite と容量境界結合テストは別途、実 SQL transaction と JSONB byte 上限を検証する。

**公開判断:** 記録の一括移動、採番を伴う新規追加・種別変更、通常編集の module contract は検証済みである。共有 metadata の差分 protocol がない現在、縮尺・用紙・回転、ページの非表示／復旧、図面の追加・改名・並替え・グループ化・削除、背景差替え、案件の保管／復元は、この bridge では入力を保持して停止する。これらを通常操作として利用できるという条件での本番全面切替は承認できない。各経路の実装と、writer fence・草稿・写真／背景・全復元を含む最終 build の統合結果を併せて判断する。

ローカル browser の起動、本番 Supabase の変更、production build の書換え、deploy はこの検証に含まれない。実 browser での reload / offline / 旧タブと新タブの同居、カメラ、実 quota、service worker cache、最終 build の全 writer 接続は、別の実装・検証として残る。
