# スクロールドライバ（仕様書 §3.1-1 / §7-3）

`src/scroll-driver.js`。会話ペインを上へ遡りながら、過去のメッセージを収集する。

## 前提: Teams は「読み込んだら DOM に残る」わけではない

Teams Web は仮想スクロールで、**画面外に出たメッセージを DOM から削除する**。
採取サンプルでもこれは確認できていて、20〜25 件表示されている会話でも DOM 上のメッセージ箱は数件しか無い瞬間がある。

したがって「全部スクロールしてから抽出」は成立しない。実装はこうしている:

```
        ┌──────────────────────────────────────┐
  ┌───► │ ① 表示中のメッセージを抽出（純粋関数）  │
  │     └──────────────┬───────────────────────┘
  │                    ▼
  │     ┌──────────────────────────────────────┐
  │     │ ② メッセージID で蓄積（重複排除・上書き）│
  │     └──────────────┬───────────────────────┘
  │                    ▼
  │     ┌──────────────────────────────────────┐
  └──── │ ③ 少し上へスクロール → 遅延ロードを待つ  │
        └──────────────────────────────────────┘
```

同じメッセージを何周も拾うことになるが、ID で一意化する。
同一 ID を再取得したときは**情報量の多いほう**（本文が長い・添付やリアクションが増えた）を採用する。
「詳細を表示」を展開した後に再取得すると本文が伸びるため、この判定が要る。

並び順は、周回番号から負のオフセットを与えて時系列（古い→新しい）になるようにしている。

## 副作用はここだけ

抽出コア（`extract.js` / `normalize.js` / `html-to-markdown.js`）は純粋関数のままで、
スクロール・クリック・待機を行うのはこのモジュールだけ。時計とスリープは注入できるので、
テストでは実時間を待たずに仮想スクロールを再現して検証している（`tests/scroll-driver.test.js`）。

「見えているものだけ」の原則（CLAUDE.md 原則1）に対しては:

- 行うのは**会話ペインのスクロール**と、**表示済みメッセージの「詳細を表示」展開**だけ
- ネットワークへ直接アクセスしない。ページ遷移もしない

## 使い方

```js
import { collectToModel } from './src/index.js';

const model = await collectToModel(document.body, selectors, {
  kind: 'channel', team: '…', channel: '…', url: location.href,
  capturedAt: new Date().toISOString(), capturedBy: '…',
}, {
  profile: 'channel',
  onProgress: ({ step, collected, gained }) => console.log(`${step} 周目: ${collected} 件（+${gained}）`),
});

console.log(model.stats.truncated, model.stats.scroll.stopReason);
```

会話ペインは `selectors.json` の `conversationPane` で引き、外れていた場合は
メッセージ要素から上方向に「実際にスクロールできる祖先」を自動で探す（DOM 変更に対する保険）。

## オプション

| オプション | 既定 | 意味 |
|---|---|---|
| `stepRatio` | 0.75 | 1 回のスクロール量（表示高さに対する割合）。小刻みにして飛ばさない |
| `waitMs` / `pollMs` / `maxWaitMs` | 400 / 150 / 5000 | スクロール後の待ちと、遅延ロード（スピナー）待ちの上限 |
| `idleRounds` | 3 | 変化なしが何回続いたら「先頭到達」とみなすか |
| `maxSteps` / `maxDurationMs` / `maxMessages` | 400 / 10 分 / ∞ | 安全弁。到達したら `truncated = true` |
| `stopBefore` | null | この日時より古くなったら停止（ISO 文字列）。**意図した範囲指定なので `truncated` にはしない** |
| `expandBody` | **true** | 「詳細を表示」をクリックして本文を展開する |
| `expandReplies` | **false** | 「N 件の返信を開く」→ 右のスレッドペインを遡って回収 → 閉じる（下記） |
| `threadWaitMs` | 8000 | スレッドペインが開く/閉じるのを待つ上限 |
| `onProgress` | null | 周回ごとに `{ step, collected, gained, scrollTop }` |

## 停止理由と truncated

| stopReason | truncated | 意味 |
|---|---|---|
| `reached-top` | false | 会話の先頭まで遡れた（正常終了） |
| `stop-before-reached` | false | 指定した日時まで遡れた（意図した範囲指定） |
| `max-steps` / `max-duration` / `max-messages` | **true** | 安全弁で打ち切った＝取りこぼしがある |

`truncated = true` のときは `scroll-truncated` 警告も出す。
これに加えて、抽出コア側の `replies-not-expanded`（「N 件の返信」に対し DOM に出ていない返信）と
`collapsed-body`（折りたたまれたままの本文）も `truncated` に合流する。
**取りこぼしが黙って消えることはない**（CLAUDE.md 原則4）。

## 返信スレッドの回収

チャネルの「N 件の返信を開く」（`[data-tid='response-summary-button']`、id は `response-summary-{mid}`）を押すと
スレッド表示に切り替わる。2026-08-06 にスレッドを開いた状態で採取したサンプルから、次が分かった。

| 分かったこと | 根拠 |
|---|---|
| スレッドは**チャット形式の DOM** で描画される（`chat-pane-item` / `chat-pane-message` / `message-author-name`） | 採取サンプルの箱がすべて chat 系 |
| ただしアプリはチャネル | 祖先に `[data-tid='slot-measurer'][data-app-name="channels"]` |
| スクロールするのは `[data-tid='message-pane-list-viewport']` | 祖先チェーンで★スクロール可能と判定 |
| **スレッド表示中は `channel-pane-message` が DOM に 1 件も無い** | 採取サンプル全体で 0 件。会話ペインは作り直され得る |

これを踏まえた実装:

```
会話ペインを遡る
  └ 「N 件の返信」の宣言数 > DOM に出ている返信数 の投稿を見つけたら
       ├ その場でボタンをクリック（仮想スクロールで投稿が消えると押せないため、見えている周回で行う）
       ├ スレッド表示（[data-tid='message-pane-list-viewport']）の出現を待つ
       ├ **chat プロファイル**で同じ手順を再帰的に実行して収集（threadProfile 設定）
       │   親子関係は data-reply-chain-id が付けてくれるので、そのまま同じ蓄積に合流する
       ├ 閉じる（threadPaneClose が未設定のため、現状は Esc キー）
       └ 会話ペインが作り直されていたら探し直して続行（警告 pane-reacquired）
```

回収した返信は親投稿の直後に並ぶよう順序を与える。同じ返信を再取得した場合は情報量の多いほうを採用する。

### 残っている不確かさ

- **閉じる操作**: `threadPaneClose` は未採取（閉じるボタンの DOM が採取範囲外）。現状は Esc キーを送る実装で、
  閉じられなければ `reply-thread-not-closed` 警告を出す。実運用で閉じられないようなら、そのボタンの
  `data-tid` を教えてもらえれば設定に足すだけで直る。
- **会話ペインの作り直し**: 外れた参照は自動で探し直すが、スクロール位置が戻る可能性がある。
  その場合は同じ範囲を再走査することになる（ID で重複排除されるので結果は壊れないが、時間はかかる）。
- そのため `expandReplies` の既定は **false** のまま。使うときは明示的に `true` を指定する運用にしてある。
  false のままでも、取れなかった返信は `replyGaps` と `truncated` で必ず報告される。

---

## 課題: 返信スレッドの回収は未検証（2026-08-13 時点・対応保留）

**状態: 保留（利用者判断）。** 実装はあるが実機で動かしていない。急ぐ必要が無いため、当面は
`expandReplies: false`（既定）で運用する。取りこぼした返信は黙って消えるのではなく、
出力 Markdown 冒頭の警告・`replyGaps`・`truncated: true` に必ず出るので、実害は
「返信本文が入らない」ことに留まる。

再開するときに確認すべきことは以下。順番もこのとおりでよい。

1. 低機密のチャネルで `window.TEAMS_COLLECT = { expandReplies: true }` を指定して実行する。
2. **スレッドが Esc で閉じたか**（`reply-thread-not-closed` 警告が出ていないか）。
   出ていれば、閉じるボタンの `data-tid` を採取して `selectors.json` の `threadPaneClose` に足す。
   それだけで直る作りにしてある。
3. **閉じたあとスクロールが続いたか**（`pane-lost` / `pane-reacquired` 警告の有無）。
   `pane-lost` が出るようなら、会話ペインの再取得が間に合っていない。
4. `replyGaps` が空になり、`truncated` が返信起因では立たなくなること。
5. 所要時間。スレッドを開くたびに待機が入るため、既定の上限（20 周・90 秒）では足りない。

関連する未確定事項は上の「残っている不確かさ」を参照。
