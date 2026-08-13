/**
 * ブラウザのコンソールに貼って実行できる 1 ファイルを組み立てる。
 *
 *   node tools/build-console-script.js
 *   → dist/teams-collect-console.js
 *
 * src/ と tools/browser-runtime.js を連結し（tools/bundle.js）、selectors.json を埋め込むだけ。
 * 変換の副作用で壊れていないか、tests/console-script.test.js が実 DOM サンプルで検証する。
 *
 * 常用するならユーザースクリプト版（build-userscript.js）のほうが手数が少ない。
 * こちらは「入れずに一度だけ試す」「UI を挟まず結果を確かめる」ときのためのもの。
 */

import { bundleSources, readSelectorsJson, readVersion, writeDist } from './bundle.js';

const version = readVersion();

const entry = `
/* ==== コンソール用の入口 ==== */
const SELECTORS = ${readSelectorsJson()};

const userOptions = (typeof window !== 'undefined' && window.TEAMS_COLLECT) || {};
const options = Object.assign({
  // 初回確認用に控えめな上限。全部取りたいときは window.TEAMS_COLLECT で上書きする
  maxSteps: 20,
  maxDurationMs: 90 * 1000,
  expandBody: true,
  expandReplies: false,
  toolVersion: '${version}',
  onProgress: ({ step, collected, gained }) => {
    if (gained > 0 || step % 5 === 0) console.log(\`[teams-md] \${step} 周目: \${collected} 件（+\${gained}）\`);
  },
}, userOptions);

try {
  console.log('[teams-md] 収集開始:', options);
  const { model, files } = await runExport(SELECTORS, options);

  window.TEAMS_RESULT = model;
  window.TEAMS_FILES = files;
  printSummary(model, files);

  if (window.TEAMS_SAVE_MD !== false) files.forEach((file) => downloadFile(file.filename, file.content, 'text/markdown'));
  if (window.TEAMS_SAVE_JSON) {
    downloadFile(\`teams-model_\${model.source.kind}_\${localStamp(new Date())}.json\`, JSON.stringify(model, null, 2), 'application/json');
  }
} catch (error) {
  console.error('[teams-md]', error.message);
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
`;

const banner = `/**
 * Teams 会話履歴エクスポータ（コンソール貼り付け）— 収集して Markdown を保存する
 *
 * 自動生成: node tools/build-console-script.js（直接編集しない。src/ を直す）
 * 版: ${version} / 生成元セレクタ: selectors.json
 *
 * 常用するならユーザースクリプト版（dist/teams-md-exporter.user.js）のほうが手数が少ない。
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
 * リンクが Teams アプリで開かないとき（実物の URL は投稿の「…」→「リンクをコピー」で確認できる）:
 *   window.TEAMS_COLLECT = { tenantId: '…', groupId: '…' };
 *
 * 行うのは会話ペインのスクロールと「詳細を表示」の展開だけです。
 * 認証情報には触れず、ネットワークへ送信もしません（CLAUDE.md 原則1・2）。
 */
`;

writeDist('teams-collect-console.js', `${banner}
(async () => {
'use strict';
${bundleSources()}
${entry}
})();
`);
