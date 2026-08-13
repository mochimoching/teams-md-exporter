/**
 * ブラウザのコンソールに貼って実行できる 1 ファイルを組み立てる。
 *
 *   node tools/build-console-script.js
 *   → dist/teams-collect-console.js
 *
 * src/ の ES モジュールから import/export を外して連結し、selectors.json を埋め込むだけ。
 * 変換の副作用で壊れていないか、tests/console-script.test.js が実 DOM サンプルで検証する。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 依存順に並べる（index.js は入口を下のテンプレートで書くので含めない） */
const MODULES = [
  'selector-utils.js',
  'html-to-markdown.js',
  'extract.js',
  'normalize.js',
  'scroll-driver.js',
  'markdown-renderer.js',
];

const selectorsJson = fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

const bodies = MODULES.map((file) => {
  const code = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
  const stripped = code
    .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '') // import 文を削除
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '') // 再エクスポートを削除
    .replace(/^export\s+(?=(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\b)/gm, ''); // export を外す
  return `/* ==== src/${file} ==== */\n${stripped.trim()}\n`;
});

assertNoDuplicateTopLevelNames(bodies);

const entry = `
/* ==== コンソール用の入口 ==== */
const SELECTORS = ${selectorsJson.trim()};

const userOptions = (typeof window !== 'undefined' && window.TEAMS_COLLECT) || {};
const options = Object.assign({
  // 初回確認用に控えめな上限。全部取りたいときは window.TEAMS_COLLECT で上書きする
  maxSteps: 20,
  maxDurationMs: 90 * 1000,
  expandBody: true,
  expandReplies: false,
}, userOptions);

const profile = options.profile || detectProfile();
const pane = findConversationPane(document.body, SELECTORS, profile);
if (!pane) {
  console.error('[teams-md] 会話ペインが見つかりません。チャネルかチャットを開いた状態で実行してください。');
} else {
  console.log('[teams-md] 収集開始:', { profile, pane: pane.getAttribute('data-tid'), options });
  const startedAt = new Date();
  const collected = await collectByScrolling(pane, SELECTORS, Object.assign({}, options, {
    profile,
    onProgress: ({ step, collected: count, gained }) => {
      if (gained > 0 || step % 5 === 0) console.log(\`[teams-md] \${step} 周目: \${count} 件（+\${gained}）\`);
    },
  }));

  // 会話 ID は入力欄の送信ボタンなど「ペインの外」にあるので、document.body から探す。
  // 本文に貼られた他会話のリンクを拾わないよう、専用の属性を持つ要素だけを見ている。
  const conversation = extractConversationId(document.body, SELECTORS, { profile });
  conversation.warnings.forEach((w) => collected.warnings.push(w));

  const model = normalize(collected, {
    kind: profile,
    url: location.href,
    threadId: conversation.threadId,
    capturedAt: toLocalIso(startedAt),
    toolVersion: '${version}',
  }, {
    patterns: SELECTORS.patterns,
    // リンクの形はチャネルとチャットで違う（チャットに parentMessageId を付けるとアプリが会話を見つけられない）
    permalink: permalinkConfigFor(SELECTORS, profile),
    tenantId: options.tenantId || null,
    groupId: options.groupId || null,
    truncated: collected.truncated,
  });
  model.stats.scroll = collected.stats;

  const { files } = renderMarkdownFiles(model, options);
  window.TEAMS_RESULT = model;
  window.TEAMS_FILES = files;
  printSummary(model, files);

  if (window.TEAMS_SAVE_MD !== false) files.forEach((file) => download(file.filename, file.content, 'text/markdown'));
  if (window.TEAMS_SAVE_JSON) {
    download(\`teams-model_\${model.source.kind}_\${localStamp(new Date())}.json\`, JSON.stringify(model, null, 2), 'application/json');
  }
}

function detectProfile() {
  const channel = document.querySelectorAll("[data-tid='channel-pane-message']").length;
  const chat = document.querySelectorAll("[data-tid='chat-pane-message']").length;
  return channel >= chat ? 'channel' : 'chat';
}

function printSummary(model, files) {
  const s = model.stats;
  console.log('%c[teams-md] 収集結果', 'font-weight:bold');
  console.table({
    メッセージ数: s.messageCount,
    スレッド数: s.threadCount,
    期間: \`\${s.rangeStart || '?'} 〜 \${s.rangeEnd || '?'}\`,
    truncated: s.truncated,
    メッセージへのリンク: \`\${s.permalinkCount} / \${s.messageCount}\`,
    停止理由: s.scroll.stopReason,
    スクロール周回: s.scroll.steps,
    展開した本文: s.scroll.expandedBodies,
    開いたスレッド: s.scroll.expandedReplies,
    所要秒: Math.round(s.scroll.durationMs / 1000),
  });

  const byCode = {};
  for (const w of model.warnings) byCode[w.code] = (byCode[w.code] || 0) + 1;
  if (Object.keys(byCode).length > 0) {
    console.log('[teams-md] 警告の内訳（取りこぼしの可能性を明示しているもの）');
    console.table(byCode);
  }
  if (s.replyGaps.length > 0) {
    console.log('[teams-md] 返信が取り切れていない投稿:', s.replyGaps);
  }

  if (files && files.length > 0) {
    console.log('[teams-md] 保存した Markdown:', files.map((f) => f.filename).join(', '));
    console.log('[teams-md] ※ 実際の会話内容が入ります。取り扱いは仕様書 §10 に従ってください');
  }

  const first = model.messages[0];
  const last = model.messages[model.messages.length - 1];
  if (first) console.log('[teams-md] 最古:', first.timestamp, first.author, preview(first));
  if (last) console.log('[teams-md] 最新:', last.timestamp, last.author, preview(last));
  console.log('[teams-md] 中間データは window.TEAMS_RESULT、Markdown は window.TEAMS_FILES に入っています');
  console.log('[teams-md] Markdown を保存したくない場合: window.TEAMS_SAVE_MD = false / 中間 JSON も保存: window.TEAMS_SAVE_JSON = true');
}

function preview(message) {
  const text = (message.bodyMarkdown || message.subject || '').replace(/\\s+/g, ' ');
  return text.length > 60 ? \`\${text.slice(0, 60)}…\` : text;
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()), p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join('-');
}

function toLocalIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return \`\${d.getFullYear()}-\${p(d.getMonth() + 1)}-\${p(d.getDate())}T\${p(d.getHours())}:\${p(d.getMinutes())}:\${p(d.getSeconds())}\${sign}\${p(Math.floor(abs / 60))}:\${p(abs % 60)}\`;
}
`;

const banner = `/**
 * Teams 会話履歴エクスポータ（コンソール貼り付け）— 収集して Markdown を保存する
 *
 * 自動生成: node tools/build-console-script.js（直接編集しない。src/ を直す）
 * 版: ${version} / 生成元セレクタ: selectors.json
 *
 * 使い方:
 *   1. Teams Web で対象のチャネル or チャットを開く
 *   2. F12 → Console → このファイルの中身を全部貼って Enter
 *   3. 進捗と結果サマリがコンソールに出て、.md ファイルが保存される
 *      （中間データは window.TEAMS_RESULT、Markdown は window.TEAMS_FILES）
 *
 * 既定は控えめ（最大 20 周・90 秒）。全部遡るときは実行前に:
 *   window.TEAMS_COLLECT = { maxSteps: 400, maxDurationMs: 600000 };
 * 返信スレッドも開いて取るとき（実験的・Esc で閉じます）:
 *   window.TEAMS_COLLECT = { expandReplies: true };
 * 保存せず結果だけ見たいとき:
 *   window.TEAMS_SAVE_MD = false;
 * リンクが Teams アプリで開かないとき（チャネルは tenantId / groupId が要る場合がある。
 * 実物の URL は投稿の「…」→「リンクをコピー」で確認できる）:
 *   window.TEAMS_COLLECT = { tenantId: '…', groupId: '…' };
 *
 * 行うのは会話ペインのスクロールと「詳細を表示」の展開だけです。
 * 認証情報には触れず、ネットワークへ送信もしません（CLAUDE.md 原則1・2）。
 */
`;

const output = `${banner}
(async () => {
'use strict';
${bodies.join('\n')}
${entry}
})();
`;

const outDir = path.join(repoRoot, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'teams-collect-console.js');
fs.writeFileSync(outFile, output, 'utf8');
console.log(`${path.relative(repoRoot, outFile)} を生成しました（${Math.round(output.length / 1024)} KB）`);

/** 連結で関数名がぶつかると静かに壊れるので、ビルド時に検出する */
function assertNoDuplicateTopLevelNames(sources) {
  const seen = new Map();
  const duplicates = [];
  sources.forEach((code, index) => {
    for (const m of code.matchAll(/^(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm)) {
      const name = m[1];
      if (seen.has(name)) duplicates.push(`${name}（${MODULES[seen.get(name)]} と ${MODULES[index]}）`);
      else seen.set(name, index);
    }
  });
  if (duplicates.length > 0) {
    throw new Error(`連結すると名前が衝突します: ${duplicates.join(', ')}`);
  }
}
