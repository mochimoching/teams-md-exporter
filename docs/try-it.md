# 実機で使う（コンソールに貼る）

`dist/teams-collect-console.js` をブラウザのコンソールに貼ると、会話を遡って収集し、
**Markdown ファイルを保存する**。中間データは `window.TEAMS_RESULT`、Markdown は `window.TEAMS_FILES` に残る。

```
npm run build     # src/ と selectors.json から dist/teams-collect-console.js を作り直す
```

## 手順

1. Teams Web で対象のチャネル or チャットを開く（まずは**低機密で、そこそこ流れている**会話がよい）
2. `F12` → **Console**
3. `dist/teams-collect-console.js` の中身を全部貼って Enter
4. 進捗が流れ、サマリの表が出て、`.md` ファイルが保存される

初回は控えめな上限（**最大 20 周・90 秒**）にしてある。全部遡るときは、貼る前に:

```js
window.TEAMS_COLLECT = { maxSteps: 400, maxDurationMs: 600000 };
```

返信スレッドも開いて取りに行く（実験的。閉じるのは Esc キー）:

```js
window.TEAMS_COLLECT = { expandReplies: true };
```

各メッセージの見出しには、Teams の該当メッセージを開くリンク `[🔗](…)` が付く。
リンクが Teams アプリで開かない場合は、`tenantId` / `groupId` を明示する（チャネルで要る場合がある）:

```js
window.TEAMS_COLLECT = { tenantId: '…', groupId: '…' };
```

値は、対象チャネルの投稿で「…」→「リンクをコピー」した実物の URL に含まれている。

保存せず結果だけ見たいとき / 中間データ（JSON）も保存したいとき:

```js
window.TEAMS_SAVE_MD = false;   // Markdown を保存しない
window.TEAMS_SAVE_JSON = true;  // 中間モデルの JSON も保存する
```

保存されるファイルには**実際の会話内容が入る**。取り扱いは仕様書 §10 に従うこと。

## 見てほしいところ

| 項目 | 期待 | ずれていたら |
|---|---|---|
| メッセージ数 | 画面をスクロールして見える件数と大きくずれない | セレクタか停止条件の問題 |
| 期間（最古〜最新） | 実際に遡れた範囲と一致 | 日時解釈の問題 |
| 停止理由 | 先頭まで行けたなら `reached-top` | `max-steps` / `max-duration` なら上限を上げる |
| truncated | 先頭まで行けたなら false | true なら理由が警告に出ている |
| メッセージへのリンク | `15 / 15` のように全件に付く | `0 / N` なら会話 ID が取れていない（`conversation-id-not-found`）|
| 🔗 を実際に開く | 該当メッセージが Teams で開く | 開かなければ `tenantId` の指定を試す |
| 警告の内訳 | `collapsed-body` や `replies-not-expanded` は仕様どおりの報告 | 見慣れないコードが出たら教えてほしい |
| 最古・最新のプレビュー | 実際の投稿と一致 | 本文の変換に問題 |
| 保存された .md | 日付見出し・返信のぶら下げ・添付・リアクションが読める形 | レンダラの問題 |

`expandReplies: true` を試す場合は、**スレッドが Esc で閉じたか**（`reply-thread-not-closed` 警告が出ていないか）と、
閉じたあとスクロールが続いたか（`pane-lost` 警告が出ていないか）を見てほしい。閉じるボタンの `data-tid` が分かれば
`selectors.json` の `threadPaneClose` に足すだけで確実になる。

## 中身を見る

```js
TEAMS_RESULT.stats                       // 件数・期間・truncated・停止理由
TEAMS_RESULT.messages.slice(0, 3)        // 先頭 3 件
TEAMS_RESULT.warnings                    // 取りこぼしの可能性の一覧
copy(JSON.stringify(TEAMS_RESULT, null, 2))  // クリップボードへ
```

## 安全性

- 行うのは**会話ペインのスクロール**と**「詳細を表示」の展開**だけ（`expandReplies: true` のときはスレッドを開閉）
- 認証情報には触れず、ネットワークへ送信もしない
- スクリプトは `src/` から機械的に組み立てたもので、`tests/console-script.test.js` が
  実 DOM サンプルを流し込んで動作を確認している（貼る前に壊れていないことは検証済み）
