# 写真本体の受信と完了判定（検証版）

`sentlog/delta-sync-assets.js` は本番HTMLへ接続していない隔離モジュールです。
実会社PCの保管ファイル、実Supabase、物理iPhone/iPadでの確認結果ではありません。

## 保持する情報

写真参照には `ownerId`, `projectId`, `assetId`, `drawingId`, `photoId`,
`variant`, `sha256`, `size`, `mimeType` を必須とします。
`variant` は `shared`（共有用）または `original`（原本）です。
原本と共有用画像を同じ写真本体として扱いません。通常のキューは共有用だけを転送し、
原本は `allowOriginals: true` が明示された処理以外では転送しません。

保存先は専用の `sentlog-delta-assets-v1` で、利用者・案件・端末・asset IDで分離します。
旧保存先 `surveyFieldNoteDB`、撮影原本の保存先、会社PCのフォルダには書き込みません。
削除・掃除のAPIを設けていません。

1件の行には写真参照、写真本体、端末受信記録、サーバー受領確認、配送状態を保持します。
この行を同じIndexedDB transactionで保存するため、容量不足やtransaction中断時に、
写真本体なしで受信済み記録だけが確定することを防ぎます。

## 配送状態

| 状態 | 意味 |
| --- | --- |
| 未登録 | 現在の記録に写真参照はあるが、配送キューにまだ登録されていない。完了ではない。 |
| `waiting` | 受信待ち。写真本体は未保存。 |
| `received` | サイズとSHA-256が一致する写真本体・端末受信記録を一括保存済み。サーバー受領確認待ち。 |
| `acknowledged` | この利用者・案件・端末・写真・種類・内容に一致するサーバー受領確認まで保存済み。 |

通信失敗時は状態を戻したり原本を削除したりせず、その位置から再開します。
`received` からの再開では保存済み本体を読み直して再照合し、受領確認だけを再送します。
何度送っても同じ写真の受領になる、冪等なサーバーAPIが必要です。

ログイン・対象案件・端末登録または現在の写真参照一覧が通信中に変わった場合、
古い応答で保存・完了判定を進めません。保存と受領確認のtransaction直前にも再検査します。

## API契約

```javascript
const store = SentlogDeltaAssets.createIndexedDBStore({ownerId, projectId, deviceId});
const queue = SentlogDeltaAssets.createQueue({
  scope: {ownerId, projectId, deviceId}, store, transport,
  currentScope: () => currentAuthenticatedScope()
});
await queue.ensure(currentPhotoReferences);
const photoStatus = await queue.sync(currentPhotoReferences);
const current = await recordReplica.snapshotWithStatus();
const combined = SentlogDeltaAssets.combinedStatus(latestRecordStatus, photoStatus, {
  scope: current.snapshot.scope,
  recordSnapshotToken: current.snapshotToken,
  references: photoReferencesFromSnapshot(current.snapshot)
});
```

`currentPhotoReferences` は現在の記録snapshotに存在する全写真参照です。
一部の写真だけを渡して全体の完了と扱ってはいけません。
`combinedStatus` は記録・写真両方について同じscope・全参照一覧との一致を必須にし、
古い写真statusを新しい記録の完了へ流用しません。
記録のstatusはcoreが出力する `scope` と `snapshotToken` を保持した最新のものを使います。
保存確定のたびにtokenが変わるため、古い「完了」表示で新しいローカル編集を完了扱いにできません。
`snapshotToken` はruntime内だけの不透明なobjectです。永続化・JSON化・別タブへの移送をせず、
写真確認の非同期処理が終わってから最新の `snapshotWithStatus()` を取得し、直ちに集約します。
現在のsnapshotから取得したrecord status/reference setでのみ集約し、過去のUI表示を再利用しません。

`transport` は以下の契約を満たす、認証付きの実装が必要です。

- `online()` は接続状態を返す。
- `download(reference, {scope, signal})` はサーバーで権限確認したasset IDに対応するBlobを返す。
  任意の利用者指定URLをそのまま取得しない。
- `acknowledge(reference, {scope, receipt, signal})` はサーバー保存を検証した受領結果を返す。
  結果は写真参照の全必須項目に加え、対象 `deviceId` と `durable: true` が完全一致する必要がある。
  既存の応答なしRPCが成功しただけで、この確認情報をクライアント側で捏造してはいけない。

通常転送の1件上限は既存再送処理に合わせて22 MiBです。超過した写真はキューに保持し、
対応する大容量経路が実装・検証されるまでは完了にしません。

## 検証と残る統合

`tests/delta_assets_cases.js` はNode/fake-indexeddbと実Chromium/WebKitで共用する37ケースです。
内容不一致、旧応答、scope変更、参照変更、ack不一致/喪失、403、タイムアウト、
容量不足、transaction中断、再起動、重複、原本分離、1,002件の未受信参照を含みます。

Node用依存は固定版 `fake-indexeddb@6.2.8` です。ブラウザー試験は既存CIと同じPlaywright版で実行します。

本番への接続には、認証付き実transport、PC保管済み共有用画像の再供給、実受領API、
全写真参照を取り出すアプリ側処理、および実機試験が必要です。
毎回のstatusでは保存本体を再ハッシュして検査しているため、数千枚の実画像による時間・メモリ負荷も測定が必要です。
写真0枚または合成の小さいBlobの試験結果を、大量の実画像の性能合格として扱いません。
