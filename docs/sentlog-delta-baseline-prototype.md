# 既存サーバー記録の初期基準取込み（隔離検証用）

このコードは本番に適用しない。SQLファイルを読み込んでも案件は有効化されず、旧版保存を拒否するトリガーも作成されない。端末の未送信データを回収した証明、写真本体の受信証明、全編集経路の移行完了を代用するものではない。

## 保存済みデータから作る3段階

1. `sentlog_delta_prepare_baseline_v1(p_project_id, p_device_id, p_expected_revision)` は、ログイン所有者、有効端末、稼働中の案件、期待する版番号を照合し、サーバーの既存snapshotを保存する。呼出し元から記録本体を受け取らない。図面一覧の整合、記録IDの重複、記録の存在を点検し、図面・縮尺・回転・PDF参照などを含むsnapshot全体を残す。通常の記録と削除済み記録の両方を対象にする。
2. `sentlog_delta_import_baseline_batch_v1(p_project_id, p_device_id, p_baseline_id, p_limit)` は1～100件ずつ、既存のSQL入力検査と履歴グラフ検査を実行する。進捗と検査済み印を同じtransactionで保存する。失敗したbatchは全て戻り、それ以前に成功したbatchから再開できる。完了しても `verified` で止まり、差分同期は無効のまま。
3. privateの `activate_prepared_baseline` は、隔離DBの試験担当者だけが実行できる。一般利用者の `authenticated` / `anon` ロールに実行権限はなく、公開RPCもない。完全な旧保存拒否トリガーが有効であり、現在のsnapshotの版番号と内容が保存時と同じであり、全記録の検査が完了した場合に限って、サーバー記録履歴と有効化を一括確定する。

同じsnapshotの準備を再実行すると同じbaseline IDが返る。応答を受け取れずbatchや有効化を再実行しても、記録・変更イベントを二重作成しない。有効化後に加えた変更履歴を初期状態へ戻すこともしない。

旧版が準備後に保存した場合は古いbaselineからの有効化を拒否する。新しい版番号で準備し直せるが、以前のsnapshotと検査記録は残す。同じ版番号のまま内容が変わった場合も拒否する。

## receiptと内容照合

receiptの主な項目は `schema: 1`、`baselineId`、`ownerId`、`projectId`、`snapshotRevision`、`cursor: 0`、`recordCount`、`importedCount`、`snapshotSha256`、`manifestSha256`、`hashFormat: postgres-jsonb-text-sha256-v1`、`state`、`deltaEnabled`。

`deviceMigrationVerified` と `assetDeliveryVerified` は常にfalse。この処理だけでは端末移行や写真受信を確認できないためである。`cursor: 0` は初期基準より後の変更を最初から取得する位置であり、受信済みの変更番号を推測した値ではない。

`sentlog_delta_read_baseline_page_v1` は検査完了後の記録を最大100件、応答本文の記録部分が約900KB以下になる範囲で返す。ページごとに `nextOrdinal` を引き継ぐ。

- `recordJson` はその写真参照・コメント・削除履歴を含む記録の正確な文字列である。これをUTF-8にしてSHA-256を計算すると `sha256` と一致する。JSONを解析して再文字列化したものをハッシュしない。
- `manifestEntryJson` を `ordinal` の順に全件集め、`[` と `]` で囲み、`, `（カンマと半角スペース）で連結した文字列のUTF-8 SHA-256が `manifestSha256` になる。取得件数と連続したordinalも照合する。
- `snapshotSha256` はサーバーに保持したsnapshot全体の `jsonb::text` のUTF-8 SHA-256である。写真本体やPDF本体のハッシュとは異なる。

記録ページAPIは図面の全メタデータを新版アプリへ取り込む完成済みアダプターではない。元snapshotはサーバー内に保持しているが、実際のアプリの全編集経路・図面情報を扱う取込みとの結合は公開前に必要。

## ロックと未完了の条件

有効化ではsnapshotテーブルに `SHARE ROW EXCLUSIVE` ロックを取得してから、現在のsnapshotを比較する。旧保存が先に始まった場合はその保存後の内容を見て有効化を拒否し、有効化が先の場合は旧保存を待機させ、確定後のトリガーで拒否する。

このロックは案件単位ではなくsnapshotテーブル全体に及ぶ。他案件の保存や保管処理への影響、旧版・新版混在、ロック待ち時間・切戻し・実端末の未送信内容の完全な引継ぎは引き続き本番公開の条件になる。既存保管トリガー、実認証、private Realtimeと結合した本番相当の検証を済ませたことにはならない。

共同編集履歴のない旧snapshot、壊れた履歴、欠けた図面状態は自動変換しない。履歴の捏造や記録の省略をせず停止する。1記録のイベント表現が256KiBを超える場合も現在は停止する。大きな1記録の履歴を分割して引き継ぐ設計と検証は別途必要。

## 試験

- `tests/delta_baseline_pglite.cjs`：外部接続できない使い捨てPGliteで、権限、分割進捗、原子性、削除記録、写真参照、SHA-256、重複、旧履歴拒否、有効化・再実行後の変更保持を検証する。
- `tests/delta_baseline_races.sh`：ローカルCI用PostgreSQL限定。独立接続で旧保存先行・有効化先行・8本の並列batchを検証する。PGliteの順次実行を並列試験と数えない。

参考： [PostgreSQL 17 ロック](https://www.postgresql.org/docs/17/explicit-locking.html)、[バイナリ関数](https://www.postgresql.org/docs/17/functions-binarystring.html)、[Supabaseの関数と権限](https://supabase.com/docs/guides/database/functions)。
