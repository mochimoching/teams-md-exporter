/**
 * テスト用フィクスチャ。
 * docs/teams-calibration.md に貼られた実 DOM サンプル（outerHTML）をそのまま読み込んで
 * jsdom に流し込む。テストのために HTML を書き換えないこと（実物との差が生まれるため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');

export function loadSelectors() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8'));
}

/** キャリブレーションレポート中の ```html フェンスを取り出す。 */
export function loadSampleHtml() {
  const md = fs.readFileSync(path.join(repoRoot, 'docs', 'teams-calibration.md'), 'utf8');
  const blocks = [...md.matchAll(/```html\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error('サンプル HTML がレポートから取り出せませんでした');
  return blocks;
}

/** サンプルをまとめて 1 つのコンテナに入れ、会話ペイン相当のルート要素を返す。 */
export function makeConversationRoot(indexes = null) {
  const blocks = loadSampleHtml();
  const chosen = indexes ? indexes.map((i) => blocks[i]) : blocks;
  const dom = new JSDOM(`<!doctype html><body><div id="pane">${chosen.join('\n')}</div></body>`);
  return { dom, root: dom.window.document.getElementById('pane') };
}

/** docs/dom-samples/ に置かれた採取ファイルを読む。 */
export function loadCollectedSamples(kind) {
  const dir = path.join(repoRoot, 'docs', 'dom-samples');
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(`teams-dom-samples_${kind}_`) && f.endsWith('.md'))
    .map((f) => {
      const md = fs.readFileSync(path.join(dir, f), 'utf8');
      const blocks = [...md.matchAll(/```html\n([\s\S]*?)\n```/g)].map((m) => m[1]);
      const dom = new JSDOM(`<!doctype html><body><div id="pane">${blocks.join('\n')}</div></body>`);
      return { file: f, root: dom.window.document.getElementById('pane'), blockCount: blocks.length };
    });
}

/** 断片 HTML を 1 要素として組み立てる（変換ロジック単体テスト用）。 */
export function makeElement(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="wrap">${html}</div></body>`);
  return dom.window.document.getElementById('wrap');
}
