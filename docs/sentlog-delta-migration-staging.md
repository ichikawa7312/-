# 旧版データの保護・分割コピー（2026-11-20）

> 2026-11-20更新: この文書は部品開発時の設計・検証記録です。実アプリのwriter、共有metadata、写真、PC保管への接続は、その後のapp runtimeと最終builderで実装しました。本文の「未接続」「未実装」は当時の状態を示します。現在の検証結果と公開判断は[本番反映判断](sentlog-delta-production-readiness.md)と[リリース手順](sentlog-delta-release.md)を参照してください。

## この変更でできること

旧版の保存場所を読み取り、新方式への切替えに先立つ検証用の控えを、専用のIndexedDBへ作る。本番HTMLには接続しない。控えの検証成功は、本番移行・クラウド同期・全端末の引継ぎの成功を意味しない。

- `delta-sync-legacy-source.js` は `SentlogRecords.getItem()` のメモリ控えを使わず、旧DBの確定済み記録・保存版・共有写真・背景を同一の読み取りtransactionで取得する。
- 撮影原本は別DBから、撮影操作の控えはlocalStorageから取得する。記録にまだ添付されていない写真、原本の添付待ち、図面差替えの控え、同期時のcheckpointも対象に含める。
- 原本のない古い写真・別端末撮影の写真は「この端末では原本の完全性不明」とする。存在するはずの原本が欠けている場合や、未完了の撮影がある場合は確認待ちにする。
- `delta-sync-migration.js` は旧raw文字列、原本metadata、未送信状態の控え、Blobを専用DBへコピーする。旧記録・写真の削除や書換えは行わない。通常の差分replicaやoutboxにも書き込まない。
- 写真本体とコピー位置を同一transactionで保存する。標準は最大16項目・約8 MiBずつ。大きい単一ファイルは1項目で扱う。
- 再開時には同じ移行ID・元データfingerprint・全コピー内容のhashが一致した場合だけ続きを使う。同じ移行IDの元データが変わっていたら以前の控えを残して停止する。
- コピー先を読み直し、すべてのサイズ・SHA-256とmetadataを照合する。さらに元データを再取得して比較する。
- 保存途中で閉じた場合は、transactionのabortを要求すると同時に呼出元へ中断を返す。abort通知を待ち続けて操作が終了しなくなることを防ぐ。ネイティブtransactionの後始末は別に扱い、確定または中断の通知を受けるまで物理的なDB切断を重ねない。遅れて届いた完了通知で中断を成功に変えない。
- `verified-copy` は「取得した控えの内容が一致した」の意味。元データが後から変更されることを防ぐロックではない。`readyForActivation` と `readyForCloudSync` は常にfalse。

## 検証対象

共通の29ケースをNodeのfake-indexeddbと、CIのChromium/WebKitで実行する。5ケースは実際の旧DBと同じ構造を作り、source captureからコピー先再読込まで通す。会社の実データではなく、合成したデータを使用する。

- コピー途中・保存完了直後の終了、再開、同じ処理の再実行。
- 2接続による同時コピー、容量不足、transaction中断、コピー位置だけの先行防止。
- コピー項目の追加直後とcheckpoint保存直後のclose、abort通知を故意に失わせた場合の中断応答、遅延完了通知を検証する。拒否応答・保存先の再open・内容確認・再開を個別の期限内で確認し、コピー位置や孤立した項目だけが残っていないことを調べる。
- 利用者・案件・端末の分離と、処理中のアカウント変更。
- 同じ移行IDへの別内容、同じfingerprintへの別内容、保存先の同サイズ破損。
- 記録版を変えない写真単体の変更、未添付の撮影待ち、共有画像欠損と原本保持。
- 既存新版の未送信queueを保持し、旧本番DBをコピー先に指定できないこと。
- 151件の合成写真を分割して取り込み、順序・内容を保持すること。
- 任意metadataのundefinedや負のゼロを可逆形式で保持し、控えを再読込した後も元データとの照合が通ること。

旧DB source adapterには別の境界試験がある。以前の13ケースのメモリpreflightとは別に、永続DBの読み取り・他接続の更新・原本・撮影待ちを確認する。

## まだ有効化しない理由と残る接続

旧記録DB・原本DB・localStorage・新版DBの間に共通のtransactionはない。現在の旧画面には、記録保存だけでなく直接ファイル保存、容量整理、復元、図面差替え、同期受信の経路がある。既に動いている旧版は新しいmigration markerを認識しない。

したがって、次の条件がそろうまで控えを通常のreplicaに変換・有効化しない。

1. 旧writer全経路と古い端末を含む切替えの制御を実装し、途中終了と復帰を確認する。
2. 端末のローカル案件IDとサーバー案件IDの対応を認証付きで確認する。
3. サーバーの確定した初期基準と端末の未送信内容を比較する。全旧記録を新規createとして送り直さない。古いコメント・写真・削除済み履歴を勝手に破棄しない。
4. 図面、縮尺、回転、メモ、写真の参照と配送queueをアプリの全編集経路へ接続する。
5. 新版で追加した内容も保持する切戻し、実会社PCの再送、物理iPhone/iPad、実画像数千枚での時間と容量を確認する。

原本は端末だけに保管する現在の運用を維持する。写真配送の試作は共有用画像と原本を別に識別し、原本を通常のクラウド送信へ自動追加しない。

## 実行

Node試験には固定版 `fake-indexeddb@6.2.8` を使用する。CIで一時ディレクトリへインストールし、`NODE_PATH` をそのnode_modulesへ指定する。

```sh
node tests/delta_legacy_source.test.cjs
node tests/delta_migration.test.cjs
node tests/delta_assets.test.cjs
```

ブラウザー試験は専用CIで、使い捨てprofileとlocalhostの合成fixtureだけを使用する。旧DBは読取りtransaction、新DBはコピー項目とcheckpointを同じ書込みtransactionに入れる。実機のOS終了時に必ず最後の操作が保存されるという保証ではなく、確定していない操作を完了扱いしない設計である。IndexedDBのtransactionと終了時の制約は[公式開発資料](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#warning_about_browser_shutdown)を参照。
