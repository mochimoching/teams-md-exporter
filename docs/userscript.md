# ユーザースクリプトとして入れる（推奨）

`dist/teams-md-exporter.user.js` を Tampermonkey に入れると、Teams Web の右下にボタンが出る。
押すと会話を遡って収集し、Markdown ファイルを保存する。コンソールに貼る必要はなくなる。

```
npm run build     # src/ と selectors.json から dist/ を作り直す
```

## 入れる

1. ブラウザに **Tampermonkey**（または Violentmonkey）を入れる
2. 拡張のアイコン → **新規スクリプトを追加**
3. エディタの中身を全部消して、`dist/teams-md-exporter.user.js` の中身を貼る
4. `Ctrl+S` で保存
5. Teams Web（`https://teams.microsoft.com/`）を開き直す

右下に **📥 会話を Markdown で保存** が出ていれば入っている。

> 更新するときは、同じスクリプトを開いて中身を貼り替えて保存し直す。
> `@version` はビルド時に `package.json` の版から入る。

## 使う

1. 対象のチャネル or チャットを開く
2. **📥 会話を Markdown で保存** を押す
3. 「N 周目 / M 件を収集中…」と進捗が出る。長いときは **中止** で打ち切れる
4. 終わると `.md` が保存され、件数・期間・ファイル名が表示される

**既定で会話の先頭まで遡る。** コンソール貼り付け版（`docs/try-it.md`）は控えめな上限だったが、
こちらは中止できるので既定を全件にしてある。

## 押したときに何が起きるか

- 行うのは**会話ペインのスクロール**と**「詳細を表示」の展開**だけ
- 認証情報には触れず、ネットワークへ送信もしない（`@grant none` / `@connect` 無し）
- 押していない間は何もしない。ページを開いただけでは収集は走らない

## 見てほしいところ

| 項目 | 期待 | ずれていたら |
|---|---|---|
| 件数 | 画面をスクロールして見える件数と大きくずれない | セレクタか停止条件の問題 |
| ファイル名 | `teams_channel_DTS-911_プロパー_20260813-1830.md` のように会話名が入る | `conversation-title-unparsed` が出ている |
| メッセージへのリンク | `15 / 15` のように全件に付く | `conversation-id-not-found` が出ている |
| ⚠ の有無 | 先頭まで遡れたなら出ない | 出たら停止理由が併記される |

## 設定を変える

取得範囲の設定 UI（仕様書 §7-2）はまだ無い。当面はコンソールで指定してからボタンを押す。

```js
window.TEAMS_COLLECT = { maxSteps: 100, maxDurationMs: 120000 };  // 上限を絞る
window.TEAMS_COLLECT = { expandReplies: true };                   // 返信スレッドも開く（実験的・未検証）
window.TEAMS_COLLECT = { tenantId: '…', groupId: '…' };           // リンクが開かないとき
window.TEAMS_SAVE_JSON = true;                                    // 中間データ（JSON）も保存
```

収集後の中間データは `window.TEAMS_RESULT`、Markdown は `window.TEAMS_FILES` に残る。

## コンソール貼り付け版との違い

| | ユーザースクリプト | コンソール貼り付け |
|---|---|---|
| ファイル | `dist/teams-md-exporter.user.js` | `dist/teams-collect-console.js` |
| 実行 | 右下のボタン | 毎回コンソールに貼る |
| 既定の範囲 | 先頭まで（中止できる） | 20 周・90 秒 |
| 進捗 | UI に表示 | コンソールに表示 |
| 拡張の要否 | Tampermonkey が要る | 不要 |

中身（収集・変換・出力）は完全に同じものを共有している（`tools/browser-runtime.js`）。
拡張を入れずに一度だけ試すならコンソール版、常用するならユーザースクリプト版。

## 保存したファイルの扱い

**実際の会話内容が入る。** 取り扱いは仕様書 §10 と勤務先の情報管理規程に従うこと。
