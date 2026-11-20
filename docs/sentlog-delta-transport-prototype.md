# 差分同期 transport 試作

`sentlog/delta-sync-transport.js` は、差分同期コアの `online / push / list / subscribe` を、認証済み Supabase RPC と private Realtime に接続する。実アプリが使う REST/session 経路と、外部から渡す Supabase JS クライアントの両方に対応する。案件を有効化する API は含まない。

## 接続契約

現在のアプリには REST provider を渡す。`session()` は現在のセッションを同期的に返し、`refreshSession()` は既存の認証処理で更新・保存を完了してから解決する。provider を共有すると、同時に期限切れを検出した案件の refresh が一つにまとまる。

```js
const provider = SentlogDeltaTransport.createRestProvider({
  url: supabaseUrl,
  key: publicApiKey,
  session: () => currentSession,
  refreshSession: () => refreshSession(),
  // subscribeAuth: callback => unsubscribeFunction, // 認証通知があれば渡す
  channelFactory: SentlogCollaborationChannel.create
});
const transport = SentlogDeltaTransport.createTransport({
  provider,
  scope: { ownerId, projectId, deviceId }, // サーバーで発行された UUID
  currentScope: () => activeScope,
  onStatus: state => showDeltaStatus(state)
});
await transport.ready();
// createReplica({ ownerId, projectId, deviceId, store, transport, ... }) に渡す
```

`projectId` はサーバー側案件 UUID。既存のローカル案件キーは baseline receipt の `clientProjectId` と照合し、ここへ代入しない。`deviceId` は登録・有効化された端末の UUID。端末名や localStorage の任意文字列では代用できない。

`client` を渡す方法もある。`createTransport({client: supabase, scope, currentScope})` は Supabase JS の `auth.getSession / auth.getUser / onAuthStateChange / rpc` を使う。Realtime 対応クライアントなら、同一クライアント・利用者の private チャンネルを案件間で共有する。一案件を閉じても別案件の購読は残る。認証 callback は同期処理にとどめ、SDK への再入は callback が返った後に行う。

| メソッド | 処理 |
| --- | --- |
| `ready({signal}?)` | 現在のセッションを取得し、Auth の利用者 ID を確認する |
| `push(event,{signal}?)` | append RPC。保存応答の案件・端末・イベント・図面・記録・seq を検証する |
| `list(projectId,after,limit,{signal}?)` | list RPC。連続する seq と scope を確認して配列を返す |
| `subscribe(projectId,callback)` | 通知と接続復帰で差分取得を促す。購読解除関数を返す |
| `prepareBaseline(revision,{signal}?)` | 指定したサーバー版の baseline を準備する |
| `importBaselineBatch(id,limit=100,{signal}?)` | baseline の取り込みを進める |
| `readBaselinePage(id,after=0,limit=100,{signal}?)` | 記録 JSON・照合情報を取得する |
| `readBaselineMetadataPage(id,after=0,limit=100,{signal}?)` | 案件・図面情報の JSON・照合情報を取得する |
| `wake()` | 現在の認証状態で再接続を進める |
| `close()` | 通信・購読・待機処理を終了する。繰り返し呼べる |

list の配列には、列挙対象外の `hasMore` と `headSeq` が付く。1 ページは件数と約 900 KB の両方で制限するため、`rows.length < limit` でも `rows.hasMore === true` なら次ページを取得する。baseline のページは RPC の `{receipt,records|metadata,nextOrdinal,hasMore}` を保持する。transport は scope・形式・順序を検査し、exact JSON の SHA-256 と全 manifest の照合は `delta-sync-reconcile.js` が行う。

## 認証と終了処理

- セッション内の利用者 ID だけで許可せず、Auth の `getUser` 応答を確認する。同じ token での確認結果は再利用し、token が変わると確認し直す。
- 非同期処理の境界で利用者・案件・端末・token 世代を確認する。別 scope に切り替わった後の応答は採用しない。
- logout や token 変更は進行中の RPC と利用者確認を中止する。provider が AbortSignal を無視しても呼び出し元は解放し、遅れて返った結果は採用しない。
- `close()`、外部 AbortSignal、通信 timeout は未送信内容を削除しない。再送時の重複排除は同じイベント ID と append RPC に任せる。
- REST の認証通知を渡さない場合も `session()` を操作前後に確認する。アプリは logout / 案件切替時に旧 transport を `close()` し、token 更新やオンライン復帰時に `wake()` する。

既存アプリの `refreshSession()` 自体にも、開始時と保存時の認証世代の一致を確認する処理が必要。transport は遅れた同期結果を拒否できるが、外部の refresh 実装が logout 後に古いセッションを書き戻すことまでは取り消せない。この provider の導入だけで既存認証処理が置き換わるわけではない。

REST は HTTPS の origin と公開 API キーだけを受け付ける。アクセストークンを URL に入れず、Authorization header に渡す。cookie 送信・redirect・HTTP cache を使わない。`sb_secret_` と legacy `service_role` JWT は拒否する。秘密キーや本番 DB 接続は不要。

## サーバー側の補足 SQL

`docs/sentlog-delta-transport-prototype.sql` は v1 schema・semantic validation・baseline SQL の後に隔離 DB で適用する試作。認証済みクライアントの event table 直接 SELECT を撤回し、`sentlog_delta_list_v1(p_project_id,p_device_id,p_after,p_limit)` を追加する。

RPC は、現在の利用者が所有する active 案件、有効な登録端末、差分同期を有効化した head を、共有行ロック下で確認する。保管・端末停止・append の途中で確認対象がすり替わらない。cursor が head を越える、履歴が欠ける、seq が飛ぶ場合はエラーにする。JSON の `bigint` は JavaScript の安全な整数範囲に限定する。

Realtime は `sentlog-delta:<owner UUID>` の private topic と `delta` event を使い、通知は `{project_id,seq}` のみ。利用者本人の broadcast 受信だけを許可し、delta topic へのクライアント送信を拒否する restrictive RLS を追加する。既存の広い permissive policy があっても、別利用者や匿名の delta 受信・送信を許可しない。他の topic の policy は維持する。

通知のチャンネルは利用者単位であり、案件・登録端末の現状確認は記録データを取得する RPC が毎回行う。通知から記録を適用したり、seq を保存済み cursor として扱ったりしない。通知が落ちても、再接続・通常の polling が RPC で追いつく。

## 検証

```sh
node tests/delta_transport.test.cjs
node tests/collaboration_channel.test.cjs
node tests/delta_transport_pglite.cjs
```

最後の検証には `@electric-sql/pglite` が必要。runner は URL・資格情報を受け取らず、プロセス内 DB に synthetic fixture と SQL を順番に適用する。既存の直接 SELECT を検証する schema テストは、この補足 SQL の適用前に実行する。

ローカル検証結果: transport の Node 契約テスト 23 シナリオ、既存通知と delta 通知の回帰、隔離 DB の 40 assertions が通過。scope・認証確認、late reply、外部中断・timeout・close、refresh 合流、SDK callback 再入回避、複数案件の購読終了、byte 制限ページ、保管案件・停止端末の拒否、広い旧 RLS と組み合わせた通知制限を含む。

実 Supabase への適用、実 Realtime サービスとの接続、実端末・実案件の切替は未実施。SQL fixture は Realtime の権限確認を模しており、稼働サービスの接続結果を示すものではない。

## 参照した公式契約

- [getSession](https://supabase.com/docs/reference/javascript/auth-getsession) と [getUser](https://supabase.com/docs/reference/javascript/auth-getuser): local session とサーバー確認の使い分け。
- [Auth state change](https://supabase.com/docs/reference/javascript/auth-onauthstatechange): callback 内の同期処理と再入回避。
- [RPC](https://supabase.com/docs/reference/javascript/rpc) と [AbortSignal](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal): PostgREST 呼び出しと中断。
- [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization) と [setAuth](https://supabase.com/docs/reference/javascript/setauth): private channel・topic の RLS と JWT 更新。
- [Supabase changelog](https://supabase.com/changelog) および [CBC TLS ciphers deprecated](https://supabase.com/changelog/cbc-tls-ciphers-deprecated): 現行の変更を確認。transport は HTTPS のみを受け付け、TLS の検証を緩めない。
