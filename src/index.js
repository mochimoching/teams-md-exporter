/**
 * 抽出パイプラインのエントリポイント。
 * スクロールドライバ（未実装）→ ここ → Markdown レンダラ（未実装）とつながる。
 */

import { extractConversation, extractMessage } from './extract.js';
import { normalize, toIsoTimestamp, parseReaction } from './normalize.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { collectByScrolling, findConversationPane } from './scroll-driver.js';
import { buildFilename, renderMarkdown, renderMarkdownFiles } from './markdown-renderer.js';

export {
  extractConversation, extractMessage, normalize, toIsoTimestamp, parseReaction, htmlToMarkdown,
  collectByScrolling, findConversationPane,
  renderMarkdown, renderMarkdownFiles, buildFilename,
};

/**
 * DOM ルート要素と設定から §5 の中間モデルまで一気に作る純粋関数。
 * @param {Element} rootEl  会話ペイン / メッセージ箱 / 単一メッセージのいずれか
 * @param {object} selectors selectors.json をパースしたもの
 * @param {object} meta      { kind, team, channel, chatTitle, url, capturedAt, capturedBy }
 * @param {object} options   { profile, timezoneOffset, assumeYear, includeSystem, truncated, mergeAdjacentMentions }
 *   includeSystem: 既定 false（システムメッセージは出力しない。除外件数は stats.systemExcluded と警告に残る）
 */
export function extractToModel(rootEl, selectors, meta = {}, options = {}) {
  const extraction = extractConversation(rootEl, selectors, options);
  return normalize(extraction, meta, { ...options, patterns: selectors.patterns });
}

/**
 * 会話ペインを遡って全件収集し、§5 の中間モデルにするところまで。
 * 副作用（スクロール・展開クリック・待機）を伴うのはここだけ。
 *
 * @param {Element} rootEl 会話ペイン、またはそれを含む要素（ペインは自動判定）
 * @returns {Promise<object>} 中間モデル
 */
export async function collectToModel(rootEl, selectors, meta = {}, options = {}) {
  const profile = options.profile || 'channel';
  const pane = findConversationPane(rootEl, selectors, profile) || rootEl;
  const collected = await collectByScrolling(pane, selectors, { ...options, profile });
  const model = normalize(collected, meta, {
    ...options,
    patterns: selectors.patterns,
    truncated: collected.truncated,
  });
  model.stats.scroll = collected.stats;
  return model;
}

/**
 * 収集から Markdown ファイル生成まで通しで行う（方式A の本流）。
 * @returns {Promise<{model: object, files: Array<{filename: string, content: string}>}>}
 */
export async function collectToMarkdown(rootEl, selectors, meta = {}, options = {}) {
  const model = await collectToModel(rootEl, selectors, meta, options);
  const { files } = renderMarkdownFiles(model, options);
  return { model, files };
}
