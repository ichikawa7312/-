# 差分同期の共有写真アダプター

## 実装の位置づけ

`sentlog/delta-sync-asset-transport.js` と `sentlog/delta-sync-asset-runtime.js` は、差分記録と既存の共有写真保存・会社PC再供給を接続する独立 factory である。ファイルを読み込むだけでは同期・認証・DB更新を開始しない。端末のカメラ原本を管理する `original-photo-store.js` はこの経路に含まない。

この実装単体では本番の差分同期切替は完了しない。アプリ全体の旧writer停止、metadata更新・PC保管との互換性、UIと差分replicaの接続を別途成立させる必要がある。`localFiles.assertExclusive()` を無条件に成功させてこの境界を省略してはいけない。

## 既存アプリとの対応

| 用途 | 既存の実装・保存先 | このアダプターの動作 |
| --- | --- | --- |
| 画面で表示する共有写真 | `surveyFieldNoteDB` / `files`、`photo:<drawingId>:<photoId>` | 欠損時だけ guarded write で配置し、実Blobを読み戻してSHA-256・サイズを照合 |
| 差分写真の保存証跡 | `sentlog-delta-assets-v1` / `assets` | Blob・reference・localReceipt・remoteReceiptを原子的に保存 |
| クラウドの登録 | `sentlog_assets` | owner/project/client_key/drawing/photo/hash/size/MIMEを確認。既存写真を更新・上書きしない |
| クラウドの一時本体 | `sentlog-temp` | 認証された同一案件のパスだけ取得。新規送信は内容に結びつく安定パスと `x-upsert:false` |
| 端末受領 | `sentlog_ack_photo` と `sentlog_asset_device_receipts` | RPC成功に加えて保存済みreceipt行のowner/device/asset/hash/sizeを再取得・照合 |
| 会社PCから再供給 | `sentlog_request_photo` → 既存 `photo-recovery.js` | PCが実ファイルとPC receiptを照合し claim/upload/finish する既存経路を利用 |
| カメラ原本 | `original-photo-store.js` の別DB | 対象外。共有写真のACKを原本配達の証明に使わない |
| 認証 | buildで接続される `SentlogSessionGuard` | `subscribe()` / `generation()` でrefresh、logout、再login、storageイベントを検知 |

旧写真送信・受信の本番コードは、単独の `cloud-sync.js` に加えて `scripts/build_sync_reliability.py`、`scripts/build_sync_traffic.py`、`scripts/build_collaboration_sync.py` が組み込む処理を含む。新factoryの接続時は生成後のコードも対象としてwriterを停止する。

## 保存と受領の順序

1. coreが返した `{snapshot, snapshotToken}` を、そのまま同じscopeのruntimeへ渡す。
2. `collectPhotos(snapshot)` が現在の写真と全collaboration写真履歴を集める。削除済みの写真・削除済み記録の履歴も保持する。同じ図面・写真IDでSHAやサイズが競合した場合は停止する。
3. 認証と登録端末・有効案件・ローカル案件キーをサーバーで確認し、写真一覧を最後の空ページまで取得する。各対象のreferenceはサーバーの実登録に結びつける。
4. 新規のローカル写真は、実BlobのSHA・サイズを確認して安定したobject pathへ送信する。同じpathが既にある場合は、その実bytesを読み戻して一致を確かめる。asset行も既存対象へ上書きしない。
5. 受信予定referenceを差分写真storeに保存する。旧filesに一致するBlobがあればそれを使い、なければクラウドから取得する。サイズとSHAが異なる旧filesは保持し、別の写真で置き換えない。
6. 差分storeへBlobとlocalReceiptを同じtransactionで保存し、commit後にBlobを読み戻して再照合する。
7. 同じwriter lockの下で旧filesを確認する。欠損時だけ `SentlogRecords.writeFile(key, blob, {onlyIfMissing:true, validate, signal})` を呼び、その返却Blobと実DBのBlobを読み戻して再照合する。
8. ここまで成立してから `sentlog_ack_photo` を呼ぶ。実際に保存されたdevice receipt行を確認し、旧filesをもう一度照合してから差分storeへremoteReceiptを保存する。
9. バッチの終了時に全対象を再確認する。現在のscope・auth generation・snapshotToken・writer fenceを満たす場合だけ写真完了を返す。

以前のreceiptがあっても、旧filesが消えたまま完了にはしない。差分storeに保持した実Blobから再配置して読み戻す。同じIDに異なるBlobや非Blob値が存在する場合はその値を残して停止する。写真の一件で容量不足・不一致が起きても、他の独立した写真を処理できる。

## Transport API

```js
const transport = SentlogDeltaAssetTransport.createTransport({
  url,                         // HTTPS origin only
  key,                         // publishable / legacy anon; secret/service_role禁止
  scope: { ownerId, projectId, deviceId },
  localProjectId,
  session: () => sessionGuard.read(),
  ensureSession: () => sessionGuard.ensure(),
  subscribeAuth: callback => sessionGuard.subscribe(callback),
  authGeneration: () => sessionGuard.generation(),
  currentScope,
  fetch,
  online,
  timeoutMs: 30000,
  maxBytes: 22 * 1024 * 1024,
  pageLimit: 400
});
```

公開メソッドは `getScope()`、`online()`、`listPhotos(options)`、`download(reference, options)`、`uploadPhoto(descriptor, blob, options)`、`acknowledge(reference, options)`、`requestPhoto(reference, options)`、`close()`。

`options` は任意の `signal` と同期 `validate()` を受け取る。`validate()` がfalse、Promise、例外を返す場合は継続しない。通信には期限とAbortControllerを使い、fetchがabortを無視した遅延結果も現在のcontextを通過できない。秘密値・Bearer token・サーバーの生エラー本文を診断結果に含めない。

共有写真referenceは次の全項目をimmutable identityとして扱う。

```js
{
  ownerId, projectId, assetId, drawingId, photoId,
  variant: 'shared', sha256, size, mimeType
}
```

`storage_deleted` またはobjectの404では `sentlog_request_photo` を使い、写真待ちを保持する。PC receiptや供給端末が存在しない場合は再供給できたと扱わない。写真をクラウドに送れたことと、受信端末へ保存できたことも別々に扱う。

## Runtime APIとwriterの条件

```js
const runtime = SentlogDeltaAssetRuntime.createRuntime({
  scope,
  transport,
  store: deltaAssetStore,
  localFiles: {
    read,                     // 欠損はundefined。nullへ変換しない
    write,                    // SentlogRecords.writeFileのoptionsをそのまま転送
    withLock,                 // 同じkeyへ書く全経路が参加するlock
    getCapabilities,          // {guarded:true, onlyIfMissing:true}
    assertExclusive           // keyの旧writer停止とpending retry無しを同期確認
  },
  currentScope,
  currentSnapshotToken,
  authGeneration: () => sessionGuard.generation(),
  subscribeAuth: callback => sessionGuard.subscribe(callback),
  onPhotoReceived
});

const result = await runtime.sync({ snapshot, snapshotToken, signal });
```

`assertExclusive(key)` はその時点で旧写真writer・旧retryが排除され、同じkeyへの未処理書込みがない場合にだけboolean `true` を返す。`SentlogRecords.uncommittedFiles()` に残る同じkeyの旧failedFilesも対象になる。guarded write対応だけでは、既に予約された旧writerの再実行は排除できない。全writerを止める実際のfenceが無い状態ではこの関数を成功させない。async guardは、rejectを消費した上で拒否する。

`currentSnapshotToken()` はcoreが生成した現在tokenを同期で返す。tokenはobject identityで比較し、JSON変換・clone・自作の代用品を使わない。recordが変わった場合は、古いtokenでの写真結果がUIへ入る前にgetterを更新する。`onPhotoReceived` にもscope・同じtoken・referenceを渡すため、呼出側は現在のcontextと一致する場合だけ表示へ反映できる。

通常の受領処理が使う `write(key, blob, options)` の返却値は `{written:boolean, value}`。`value` だけを信頼せず、`read(key)` でcommit済みのBlobを読み戻す。writeが失敗してもdelta storeのBlobを保持し、旧filesの無条件自動retryへ入れない。

runtimeの `close()` はそのruntimeの処理・購読を停止する。注入したtransport/storeの所有権は呼出側に残るため、不要になった所有者がそれぞれcloseする。

## 結果の扱い

結果はscope・snapshotToken・references・referenceSignature・total・pending・complete・sharedOnly・issuesを返す。`photoStatus` は同じ条件を通過したstatusであり、`queueStatus` は診断用の生の差分queue集計である。

写真が記録にあるのにasset登録や本体が見つからない場合、referencesが空でも `complete:false` になる。`queueStatus.complete` だけでアプリの完了表示を決めてはいけない。

記録とまとめて表示するときは `SentlogDeltaAssets.combinedStatus(recordStatus, result.photoStatus, context)` に現在のrecordSnapshotTokenとreferencesを渡す。runtime由来のphotoStatusにはsnapshotTokenがあるため、同じ写真一覧でも古いrecord tokenの結果は完了条件を満たさない。

## Auth generation

`sessionGuard.subscribe(callback)` は `(event, session, {generation, reauthRequired})` で通知し、unsubscribe関数を返す。`generation()` は同一タブで直接変更されたstorageも同期的に取り込む。

世代はアクセス/refresh token・owner・再認証状態が変わるたびに進む。logout後に同じownerと同じtokenへ戻っても別世代である。別タブでlogoutと再loginが続き、storageイベント受信時には同じserialized sessionへ戻っている場合もイベントの変更を根拠に失効させる。

refresh開始時の世代も保存し、結果を採用する直前にtoken比較と世代比較の両方を行う。古いrefreshの成功で新しいloginを上書きせず、古い失敗で新しいloginを消さない。

現実装は通常のtoken refreshでも写真処理を保守的に中止する。次回は保存済みのBlob・receiptから再開する。購読callbackの中ではRPCや再帰的なensureSessionを実行しない。stable-ownerだけを根拠に古い通信結果を採用しない。

## 検証

- `tests/delta_asset_runtime.test.cjs`：34ケース。Nodeではfake IndexedDBとsynthetic RESTを使い、実 `photo-recovery.js` のPC読み出し・claim/upload/finishと実 `record-store.js` のguarded mirrorを接続する。PC FileのMIMEが空の場合も、登録済みMIMEとbytes/hashで供給できることを確認する。
- `tests/delta_asset_runtime_cases.js`：同じcase関数をremote Chromium/WebKit CIへ読み込める。browser側のPC供給はsynthetic server応答であり、会社PCの実ディスク検証ではない。browser fixtureが渡すactualFiles adapterにより実 `record-store.js` の保存はbrowserでも検証できる。
- `tests/delta_assets.test.cjs`：既存39ケースが継続通過。Blob transaction、受領前ACK禁止、quota/abort/再開、改ざん、scope分離を含む。
- `tests/session_guard.test.cjs`：22ケース。既存13ケースにsame-token logout/relogin、遅延成功/失敗、世代、storage adoption、batched events、listener例外、unsubscribeを追加。

合成テストは本番APIに接続しない。アカウント・写真bytes・会社PCフォルダーはすべてfixtureであり、実際のユーザーデータへアクセスしない。browserの合否はCIの結果で判定し、Node成功だけを実browser成功と読み替えない。

本番へ接続する残条件は、旧writerの実停止・復帰制御、record snapshotTokenを保持するUI接続、案件/図面metadataの差分同期とPC保管の整合、生成後buildの組込み、remote browser結果、および実サービスの権限設定との統合確認である。PC側の供給元が起動していない／ファイルが存在しない場合は、端末を写真待ちとして保ち、転送完了を作らない。

## 参照した公式API資料

2026-11-20に [Supabase changelog](https://supabase.com/changelog.md)、[Storage Standard Uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads)、[onAuthStateChange](https://supabase.com/docs/reference/javascript/auth-onauthstatechange) を確認した。REST uploadの形式、重複objectの扱い、認証イベント購読を既存アプリのRPC/DB契約と照合した。標準uploadより大きな画像向けの転送方式を新たに採用した実装ではなく、既存共有写真経路の22 MiB上限と再試行を維持する。
