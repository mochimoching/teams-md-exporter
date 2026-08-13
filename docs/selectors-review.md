# selectors.json 確定レポート

入力:

- `docs/teams-calibration.md`（2026-08-05 採取 / channel / 実メッセージ 8 件）
- `docs/dom-samples/teams-dom-samples_channel_2026-08-06-18-*.md`（4 ファイル / 実メッセージ 58 件）
- `docs/dom-samples/teams-dom-samples_chat_2026-08-06-1*.md`（2 ファイル / 実メッセージ 13 件・ラッパごと採取）

出力: `selectors.json`（v2.0.0）、`src/`（抽出コア）、`tests/`（採取した実 DOM に対する回帰テスト）、`tools/check-samples.js`（全サンプルでの命中率レポート）

判定はすべて採取した実 DOM が根拠。class 属性は難読化されているため一切使っていない（`tests/selectors-policy.test.js` が機械的に検査）。

---

## 1. 現在の到達点（`node tools/check-samples.js`）

| ファイル | 種別 | メッセージ | 送信者 | 日時 | 本文 | 添付 |
|---|---|---|---|---|---|---|
| teams-calibration.md | channel | 8 | 100% | 100% | 100% | 0 |
| …channel_18-40-08 | channel | 5 | 100% | 100% | 100% | 0 |
| …channel_18-41-05 | channel | 20 | 100% | 100% | 100% | 0 |
| …channel_18-42-14 | channel | 18 | 100% | 100% | 100% | 1 |
| …channel_18-43-21 | channel | 15 | 100% | 100% | 100% | 4 |
| …chat_18-50-50 | chat | 6 | 100% | 100% | 100% | 0 |
| …chat_19-06-23 | chat | 7 | 100% | 100% | 100% | 3 |
| **合計** | | **79** | **100%** | **100%** | **100%** | **8** |

**チャネル・チャットとも、送信者・日時・本文が全件取れています。** 残る警告は「取りこぼしの可能性の明示」（未展開の返信・折りたたみ本文）と「未対応要素の記録」（カード・貼り付け画像）だけで、欠落によるものはありません。

## 2. 新しいサンプルで確定したこと

### 2.1 スクロール対象ペイン（これまで「取れない」としていた項目）

祖先要素の採取で確定しました。4 回の channel 採取すべてで一致しています。

| 種別 | スクロールする要素 |
|---|---|
| channel | `[data-tid='channel-pane-viewport']` |
| chat | `[data-tid='message-pane-list-viewport']` |
| 共通の外枠 | `[data-tid='message-pane-body']`（フォールバック） |

### 2.2 添付ファイル（「候補なし」だった項目）

```html
<div data-tid="file-attachment-grid" aria-label="メッセージに添付ファイルが 2 個あります。" id="attachments-{mid}">
  <div ... numberoffiles="2" role="group" aria-label="月次チェックシート_AI技術部_202607.xlsx">
    ...
    <div data-testid="content-card-custom-title" aria-label="月次チェックシート_AI技術部_202607.xlsx https://nttdatajpprod.sharepoint.com/...">
```

**添付グリッドの中にアンカー（`a[href]`）は存在しません。** ファイル名は項目の `aria-label`、URL は `content-card-custom-title` の `aria-label` 末尾に「`{ファイル名} {URL}`」の形で埋まっています。初版の `attachmentLink: "a[href]"` は誤りだったので差し替えました（フォールバックとしては残置）。

表示件数（`numberoffiles` とグリッドの `aria-label`）と取得件数を突き合わせ、食い違えば `attachment-count-mismatch` を出します。channel 5 件・chat 1 件すべてでファイル名と URL が取れ、件数の不一致もありません。

### 2.3 チャットの構造（チャネルと別物）

```html
<div data-tid="chat-pane-item">                    ← 1 メッセージ = ここ
  <div data-testid="message-wrapper">
    <span data-tid="message-author-name" id="author-{mid}">送信者</span>
    <time id="timestamp-{mid}" datetime="2026-08-06T05:42:24.704Z" aria-label="今日の 14:42.">14:42</time>
    <div data-tid="chat-pane-item"> …アバター…            ← 同じ data-tid の入れ子（罠）
    <div data-tid="chat-pane-message" role="group" id="message-body-{mid}" data-mid="{mid}">
      <div id="content-{mid}" data-message-content="">本文
```

- **送信者と日時はメッセージ本体（`chat-pane-message`）の外側**にあります。前回の採取が 0% だったのはこれが理由でした。1 メッセージの単位は外側の `[data-tid='chat-pane-item']` です。
- ただしアバター用に**同じ `data-tid` の入れ子**が現れるため、`:has([data-tid='chat-pane-message'])` を付けて本物だけを選んでいます（`:has()` は Teams が動く近代ブラウザと jsdom の双方で使えることを確認済み）。
- 送信者に `[data-tid='message-author-name']` という専用フックがある（チャネルには無い）。
- **チャットの `<time>` には `datetime="…Z"`（UTC・秒つき）がある。** チャネルには無く `aria-label` のみ、という非対称です。チャットはこの属性を最優先で使うため、秒まで正確な日時が取れます。
- 本文に `data-tid='message-body'` が付かない（`id='content-{mid}'` と `data-message-content` のみ）。
- リアクションは `channel-message-reaction-summary` ラッパーが無く `[data-tid='diverse-reaction-summary']` から始まる。

### 2.4 日時の相対表記

直近のメッセージは絶対日時ではありませんでした。

| 実際の値 | 意味 |
|---|---|
| `aria-label="2026年7月23日 15:56"` | 通常（過去日） |
| `aria-label="昨日の 19:18"` / text `"昨日 19:18"` | 前日 |
| `aria-label="13:47"` / text `"13:47"` | 当日 |

相対表記は **取得日（`meta.capturedAt`）が無いと日付を決められない**ため、基準日が渡されなければ勝手に埋めず `timestamp: null` ＋ `timestamp-relative-unresolved` 警告にしています。基準日があれば ISO 8601 に解決します（`timestampPrecision: 'minute-relative'`）。

### 2.5 連続投稿（グループ化）

同じ人が続けて投稿すると `[data-tid='reply-message-header']` が空になり、送信者も日時も DOM に出ません（79 件中 2 件）。直前のメッセージから引き継ぎ、`authorInherited` / `timestampInherited` フラグと `author-inherited` / `timestamp-inherited` 警告に残しています（黙って埋めない）。

### 2.6 「詳細を表示」の誤検出を修正

折りたたみの入れ物 `[id='see-more-container']` は、**折りたたまれていないメッセージにも常に存在します**（全 60 個のうち実際に折りたたみ中は 28 個）。区別できるのはインライン `style="display: none"` だけで、意味的属性の差はありません（`aria-expanded` は常に `false`）。

セレクタ自体は素のままにして、可視判定のパターン（`patterns.hiddenStyle`）を `selectors.json` 側に外だししました。これで警告が実際に折りたたまれているものだけに絞られます。

### 2.7 コードブロック（実装バグを 1 件発見）

```html
<div data-tid="code-block-editor-deserialized-header">…<div data-tid="code-block-editor-deserialized-language">Plain Text</div>…</div>
<pre itemid="codeBlockEditor-{uuid}"><code>行1<br>行2<br>…</code></pre>
```

- **改行が `<br>` で表現されている**ため、`textContent` で取ると全行が 1 行に潰れます。実際そうなっていたので、`<br>` を改行に戻す実装に修正しました（192 行のコードブロックが 192 行のまま復元されることをテストで固定）。
- インデントは `&nbsp;` なので、空白を畳まずに半角空白へ落とします。
- 言語名は `<pre>` ではなく**直前の兄弟のヘッダ**にあります（表示は `Plain Text` 等）。フェンスの言語に使い（```` ```plaintext ````）、ヘッダ自体は本文テキストに混ざらないよう除外しています。

### 2.8 その他

- **メンション**: `data-mention-type` の値は `person` / `tag` / `channel` の 3 種。いずれも `data-person-mri` を持つので、連続メンションの結合可否を MRI で判定できます。
- **インラインコード**: `<code>` を確認（`<p>` 直下）。Markdown の `` ` `` に変換されます。
- **表**: 素の `<table><tr><td>`。Markdown テーブルに変換されます。
- **本文中の画像**: `<img src="blob:…">` で alt もファイル名もありません。blob: URL は保存後に無効になるため、リンクにせず `<!-- 未対応要素: 画像 -->` として残します。
- **リンクプレビュー**: `[data-tid='url-preview']` は本文要素の**外側**にあり、本文だけ見ていると拾えません。ページタイトルと URL を `linkPreviews` として別項目で拾うようにしました。

---

## 3. まだ確定できていないもの

| 項目 | 状況 |
|---|---|
| 編集済み / 削除済み | **採取不要との判断のため対応終了**。Teams の DOM には常に最新状態しか出ないので、採取しても編集前・削除前の内容は取れない。失うのは印だけ（`(編集済み)` を付けられない／削除行が普通のメッセージとして出る）。id 接頭辞セレクタは残置してあり、実要素が現れればフラグが立つ |
| システムメッセージ | **出力不要との判断のため対応終了**。既定で出力から除外し、除外件数を `stats.systemExcluded` と警告に残す |
| 折りたたみ本文の全文 | 折りたたみ時に DOM に全文があるか、展開時に追加ロードされるかは未判明。`collapsed-body` 警告を出し続ける（スクロールドライバ実装時に、展開クリックを行うかどうかで方針を決める） |
| コードブロックの言語 | `Plain Text` は確認済み。他言語（javascript 等）でラベル文字列がどうなるかは未確認だが、そのまま小文字化して使うだけなので実害は小さい |

---

## 4. 追加の採取は不要です

前回お願いした 2 件（チャットの再採取・コードブロック）はいずれも今回の採取で解決しました。
`selectors.json` に必須の未確定項目は残っていません。

次に DOM サンプルが要るのは、**Teams の UI 更新で `node tools/check-samples.js` の命中率が落ちたとき**です。
そのときは同じ手順（`docs/dom-samples/README.md`）で採り直してください。

---

## 5. 実装

```
src/selector-utils.js   セレクタ設定の解決ヘルパ
src/html-to-markdown.js 本文 HTML → Markdown（仕様書 §6.3）
src/extract.js          DOM → 生メッセージ（純粋関数）
src/normalize.js        生メッセージ → 中間データモデル（仕様書 §5）
src/index.js            extractToModel(rootEl, selectors, meta, options)
src/scroll-driver.js    スクロールドライバ（仮想スクロール制御・重複排除・truncated 判定）→ docs/scroll-driver.md
src/markdown-renderer.js  Markdown レンダラ（フロントマター・日付見出し・返信のぶら下げ・分割、§6）
tools/build-console-script.js  コンソール貼り付け用の 1 ファイルを生成 → docs/try-it.md
tools/collect-dom-samples.js  DOM サンプル採取（ブラウザのコンソールに貼る）
tools/check-samples.js        全サンプルでの命中率レポート
```

- 抽出コア（extract / normalize / html-to-markdown）は **DOM ルート要素を引数で受け取る純粋関数**。
  副作用（スクロール・展開クリック・待機）は scroll-driver.js だけに閉じてある。`document` / `window` / 現在時刻に触れないので、方式A（ブラウザ内）でも方式B（Playwright / jsdom）でも同じものを呼べる。
- セレクタは **コード内に一切書かない**（`tests/selectors-policy.test.js` が `src/` を機械検査）。
- 取りこぼし・欠落は必ず `warnings[]` に積む（`fatal` / `warn` / `info`）。抽出 0 件は fatal。

### テスト（`npm test`: 80 件）

採取した実 DOM をそのまま読み込んで検証しています（テスト用に HTML を書き換えていない）。
件数の固定値はサンプルを採り直すと変わるため、原則は「全件で取れていること」を検査しています。

- channel / chat 全 79 件で送信者・日時・本文が 100% 取れること
- コードブロックの改行が保たれ、言語ラベルが付くこと
- chat の入れ子ラッパを箱と誤認しないこと
- 添付のファイル名・URL・件数一致
- 連続投稿の引き継ぎが 2 件で、引き継いだと記録されること
- 折りたたみ判定が入れ物の数ではなく実際の折りたたみ数と一致すること
- 相対日時（「昨日の 19:18」「13:47」）の解決と、基準日が無いときの null 化
- インラインコード / 表 / 引用 / メンション結合 / blob 画像 / リンクプレビュー
- chat の ID・本文・添付・複数リアクション
- 未展開の返信 → `truncated: true`、抽出 0 件 → fatal
- selectors.json と src に class セレクタが無いこと

### まだ実装していないもの

ユーザースクリプト（Tampermonkey）や拡張機能としてのパッケージ化と、設定 UI（§7-2 の取得範囲の選択）。
現状はコンソールに貼る運用（`docs/try-it.md`）。

---

## 6. メッセージへのリンク（2026-08-13 追加）

出力 Markdown の各メッセージ見出しに、Teams の該当メッセージを開くリンク `[🔗](…)` を付けられるようにした。
DOM サンプルには材料が無かったため、実機のコンソールで調査した結果を以下に残す。

### 6.1 会話 ID（threadId）の在りか

`data-track-thread-id`。**送信ボタン `[data-tid='sendMessageCommands-send']` が持っている。**

| 会話 | この属性を持つ要素数 | 値 |
|---|---|---|
| チャネル | 3（送信ボタン＋会議ヘッダの 2 ボタン） | すべて同一の `19:…@thread.tacv2` |
| 会議チャット | 1 | `19:meeting_…@thread.v2` |

要素数はチャネルによって 2〜3 と変わるが、**値は同一**であることを確認済み。1:1 チャット（`@unq.gbl.spaces`）は未確認。

### 6.2 使えなかった経路（同じ調査を繰り返さないための記録）

| 経路 | 結果 |
|---|---|
| `location.href` | `https://teams.microsoft.com/v2` 固定。会話を識別できない |
| ページ全文の正規表現検索 | **不可**。左一覧に載っている全会話の ID が約 120 件ヒットする（1:1・グループ・会議・チャネルが混在） |
| 会話ペイン内の正規表現検索 | **不可**。本文に貼られた他会話へのリンクやチップ由来の ID が混ざる（チャットのペインから `@thread.tacv2` が 3 種類出た） |
| 要素の `id` 属性（`[id^="19:"]`） | 0 件 |
| 左一覧の選択状態（`[aria-selected=true]`） | アプリのタブ（`com.microsoft.chattabs.chat`）しか返らない |
| `localStorage` / IndexedDB | **調べない**（CLAUDE.md 原則 1・方式C禁止） |

結論として、**この属性を持つ要素を指名して読む以外に安全な方法は無い**。
`src/extract.js` の `extractConversationId()` はそのためのもので、検索ルートを引数で受け取る純粋関数のまま
（送信ボタンは会話ペインの外にあるため、呼び出し側が `document.body` 相当を渡す）。

### 6.3 URL の形（チャネルとチャットで違う）

> **2026-08-13: チャネル・チャットとも、生成したリンクがデスクトップアプリで正しく開くことを実機で確認済み。**

**同じ形にしてはいけない。** 当初どちらも `parentMessageId` を付けていたところ、チャットのリンクを
デスクトップアプリで開くと「チームを見つけることができません」になった（チャネル投稿として解釈されるため）。

| 会話 | クエリ | 確認状況 |
|---|---|---|
| チャット | `?context={"contextType"%3A"chat"}` | **実機の「リンクをコピー」と 1 文字まで一致**（2026-08-13） |
| チャネル | `?tenantId=…&groupId=…&parentMessageId=…&createdTime=…&ngc=true` | 実物と突き合わせ済み。ただし `tenantId` / `groupId` は DOM から取れないため、指定が無ければ落とす |

チャネルの実物（2026-08-13）:

```
?tenantId=…&groupId=…&parentMessageId=1786521292457&teamName=DTS&channelName=911_…&createdTime=1786525125055&ngc=true
```

- `createdTime` は **`messageId` と同じ値**だった。
- `parentMessageId` は実装が出した値と一致していた（親の解決は正しい）。
- `teamName` / `channelName` は表示名なので付けない（会話は `threadId` で一意に決まる）。
- **`tenantId` / `groupId` は無くてもリンクが開くことを実機で確認済み**（2026-08-13）。
  そのため DOM からの取得は追わない。開かない環境（複数テナント所属など）向けに
  `window.TEAMS_COLLECT = { tenantId, groupId }` で渡せる逃げ道だけ用意してある。

- `messageId` は既存の `data-mid`、`parentId` は返信なら親投稿の ID、投稿本体なら自分自身。
- パス部の `19:…@thread.tacv2` はエスケープしない（実物のリンクが生のまま）。
- エスケープ方針は「**テンプレートの地の文はそのまま、`{…}` に埋める値だけ URL エンコード**」。
  チャットの `context` は Teams 実物が `:` だけを `%3A` にした独特な形なので、設定に書いたまま出せるようにしてある。
- `tenantId` は DOM から確実に取れる場所が無いため**既定では付けない**。複数テナントに所属していて
  リンクが開かない場合は `window.TEAMS_COLLECT = { tenantId: '…' }` で明示する。
- テンプレートは `selectors.json` の `permalink.{channel,chat}`。
  プレースホルダが 1 つでも埋まらなければ URL を作らない（推測しない）。

チャネルのリンクを直すときは、Teams で投稿の「…」→「リンクをコピー」した実物と突き合わせること。
推測で `groupId` や `teamName` を足さない。

### 6.4 取れなかったときの扱い

会話 ID が取れなければリンクは付けず、`conversation-id-not-found` / `permalink-unavailable` を警告に出す（原則 4）。
候補の値が食い違った場合は `conversation-id-ambiguous` を出したうえで先頭を採用する。
`stats.permalinkCount` に「何件にリンクを付けられたか」が入る。

生成したリンクは**その会話にアクセス権のある人しか開けない**。リンク自体は権限を回避しない。
