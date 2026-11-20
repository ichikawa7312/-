# 差分同期の初期引き継ぎとアプリ接続

> 2026-11-20更新: この文書は部品開発時の設計・検証記録です。実アプリのwriter、共有metadata、写真、PC保管への接続は、その後のapp runtimeと最終builderで実装しました。本文の「未接続」「未実装」は当時の状態を示します。現在の検証結果と公開判断は[本番反映判断](sentlog-delta-production-readiness.md)と[リリース手順](sentlog-delta-release.md)を参照してください。

この実装は検証用で、公開中の HTML には読み込んでいない。本番のデータベースへの SQL 適用、旧保存経路の停止、新同期への切り替えは行っていない。

## 今回つながった経路

`delta-sync-bootstrap.js` は、旧 IndexedDB の検証済み控え、サーバーが確定した初期基準、端末で残っている未送信の変更を照合する。安全に取り込める記録は、写真やコメントの履歴を合わせた初期状態と送信待ちへ変換する。案件名・図面設定など、まだ差分へ変換できない変更は確認待ちとして原文を残す。

サーバー基準の読み取りでは、記録だけでなく、案件情報、空の図面、図面設定も取得する。それぞれの正確な JSON の SHA-256 と一覧の SHA-256 を確認する。ローカルの案件 ID とサーバーの案件 ID の対応も、サーバーが返す `clientProjectId` で照合する。

`delta-sync-indexeddb.js` の `installBaseline()` は次を同じ `replicas` 行、同じ IndexedDB トランザクションで確定する。

| 保存内容 | 目的 |
| --- | --- |
| 記録と不変な変更履歴 | サーバー側・端末側の内容を両方保持する |
| 未送信の差分 | オフラインの編集を後から送信する |
| 受信カーソル 0 | 初期基準の後に発生した変更を先頭から受信する |
| 案件・図面設定と端末の表示情報 | 記録以外の情報を引き継ぎで落とさない |
| 基準の受領情報、控えの ID、元データのハッシュ、計画のハッシュ | 別の控えや古い計画で上書きしない |
| 初期状態と設定のハッシュ | 再試行の同一性と設定の保存内容を確認する |

写真・原本・背景の Blob 本体は、検証済みの移行控えに残す。初期状態の取り込みを写真転送の完了として扱わない。

## 二段階の API

`createCoordinator({source, migration, replicaStore, transport, localProjectId, currentScope})` を使う。

### prepare

`prepare({migrationId, receipt, signal})` は、旧データの控えを作成・再読込し、記録と設定の基準ページを検証し、照合計画を返す。最後に旧データを読み直し、コピー中の変更を検出する。

同じ移行番号の控えは同じ元データだけに使用できる。コピー後に旧データが変わった場合は、その控えを上書きせず、新しい控えと計画を作る。`needs-review` には未対応の設定変更、履歴の書き換え、欠けたファイルなどの理由が残る。

この段階では通常の差分用保存先に何も書き込まない。サーバー基準が `verified` でも照合はできるが、次の install はできない。

### install

`install({migrationId, plan, assertLegacyWritesBlocked, signal})` は次の条件をすべて満たす必要がある。

1. 計画の内容とハッシュが一致し、確認待ちの阻害項目がない。
2. サーバー基準は `active`、`deltaEnabled` は true。クライアントから基準を有効化しない。
3. `assertLegacyWritesBlocked()` が同期的に成功する。アプリ側で旧保存の全経路を継続して停止する責任がある。
4. 控えの内容を再読込し、サーバー基準を再取得して計画を再計算しても、同じ計画になる。
5. 直前の旧データ読み直しでも、元の fingerprint が一致する。
6. 利用者・案件・端末と書き込み停止の確認が、各非同期処理後と保存トランザクション内でも成功する。

通常の保存先に別の記録がある場合、空の記録であっても無断で置き換えない。失敗時は元データと控えを維持する。通信応答が来ない場合や中止した場合も、待機を終了し、遅い応答を後から適用しない。

`assertLegacyWritesBlocked` は切り替えの完成を示すフラグではなく、接続側が満たす必要のある契約である。単に `() => true` を渡す、コピー前後で一度ずつハッシュを確認する、メモリ上だけで編集を止める、といった処理では本番の契約を満たさない。既存 record-store、ファイル保存、原本保存、撮影中の控え、復元・アーカイブ、旧同期受信などへの継続した停止と、再起動時の経路選択は未接続である。

戻り値の `localSeedVerified: true` は初期状態の保存を示す。`readyForActivation`、`readyForCloudSync`、`assetDeliveryVerified` は false のままとする。アプリ側の切り替えと写真の実転送を証明したことにはならない。

## 再試行と別画面の更新

同じ基準・控え・計画・初期状態・設定で再試行した場合、既存の保存内容を返し、初期状態で書き戻さない。取り込み後に増えたコメント、受信カーソル、送信済みの状態も維持する。

ただし、既に旧 revision を読んだ同じストアが、別画面による更新の後に再試行した場合は `DELTA_STORE_STALE` とする。受領情報の読み直しだけで CAS の基準 revision を進めると、古いメモリ状態からの次の保存が新しい編集を消すためである。明示的に最新の state を読み直すか、保存先を開き直してから再開する。

`readProvenance()` は設定のハッシュを照合するが、CAS の基準 revision は更新しない。通常の state 保存も取り込みの証跡を保持する。設定や証跡が不正な場合は、初期化せず停止する。

## 保存中断

保存先を閉じる場合は、呼び出し元への拒否を直ちに返し、IndexedDB の rollback と接続の解放は別に追跡する。ブラウザーが `abort` イベントを遅延させても呼び出しが待機し続けない。後から `complete` が届いても成功へ戻さない。

トランザクションが既に確定した直後の中止では、呼び出し側が結果を受け取れないことがある。その場合も、開き直した保存先への同じ install により、既存の記録を上書きせず結果を回収できる。

## 通常編集への橋渡し

`delta-sync-app-bridge.js` は、実際の record-store の workspace/drawing 保存形式を読む。record-collaboration で記録ごとの不変な差分を作り、`changeBatch` に一度で渡す。ローカルの state と送信待ちは一つの保存になる。古い snapshot token、途中の不正な記録、容量不足のいずれでも、一部だけのローカル保存を成功扱いにしない。

図面間・ページ間の move は、サーバー能力を確認済みの transport がある場合に限り、一つの atomic group にまとめる。グループは端末の outbox、サーバー transaction、受信側の記録と cursor の各境界で分割しない。能力を未確認の場合や、移動元と移動先がそろわない場合は、元の内容を保持して拒否する。

bootstrap は prepare と install 時の計画再構築の両方へ同じ transport を渡す。能力確認が取り消された場合は、グループを単独イベントへ崩さず、初期保存を拒否する。検証では、旧保存の未送信 move をグループとして初期保存し、開き直して同じ引き継ぎを再試行しても、元の group ID と全イベントが保持されることを確認する。この経路は本番の writer 切替や metadata protocol の代わりにはならない。

実アプリの全 writer と必要な接続順序は `sentlog-delta-app-bridge.md`、認証と通知は `sentlog-delta-transport-prototype.md`、照合の内容は `sentlog-delta-reconcile.md` に記載する。

## 検証

`tests/delta_seed.test.cjs` と共有の `delta_seed_cases.js` は、同時初回保存、再試行後の編集保持、stale writer、設定の改変、容量不足、トランザクション中断、閉じた後の遅延イベント、外部 AbortSignal を検証する。

`tests/delta_bootstrap.test.cjs` は、旧形式の保存と Blob、移行控え、実際の reader/planner、通常の IndexedDB 保存を組み合わせる。`tests/delta_reconcile_sql_contract.cjs` は PostgreSQL が実際に返す JSON から JavaScript で差分を作り、SQL の検証・履歴マージへ戻して内容を照合する。

共有ケースは GitHub Actions の Chromium/WebKit の通常プロファイルでも動かす。既存のオフライン再読込・ブラウザープロセスの再起動、写真保存のテストも維持する。これらは iPhone/iPad や会社 PC の実機操作、本番データ移行の実施を意味しない。
