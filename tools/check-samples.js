/**
 * docs/dom-samples/ と docs/teams-calibration.md の全サンプルに対して抽出コアを回し、
 * 命中率と警告の内訳を出す自己テスト（キャリブレーションの回帰確認）。
 *
 *   node tools/check-samples.js
 *   node tools/check-samples.js --warnings   # 警告の内訳も出す
 *
 * Teams の DOM が変わったとき、まずこれを流して「どこが取れなくなったか」を見る。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { extractConversation } from '../src/extract.js';
import { normalize } from '../src/normalize.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8'));
const showWarnings = process.argv.includes('--warnings');

const sources = [
  { file: path.join(repoRoot, 'docs', 'teams-calibration.md'), profile: 'channel' },
  ...fs.readdirSync(path.join(repoRoot, 'docs', 'dom-samples'))
    .filter((f) => f.startsWith('teams-dom-samples_') && f.endsWith('.md'))
    .map((f) => ({
      file: path.join(repoRoot, 'docs', 'dom-samples', f),
      profile: f.includes('_chat_') ? 'chat' : 'channel',
    })),
];

let totals = { messages: 0, author: 0, timestamp: 0, body: 0, attachments: 0 };
const warningTotals = {};

for (const source of sources) {
  const md = fs.readFileSync(source.file, 'utf8');
  const blocks = [...md.matchAll(/```html\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (blocks.length === 0) continue;

  const dom = new JSDOM(`<!doctype html><body><div id="pane">${blocks.join('\n')}</div></body>`);
  const root = dom.window.document.getElementById('pane');
  const extraction = extractConversation(root, selectors, { profile: source.profile });
  // 相対表記（「昨日の 19:18」等）の解決に基準日が要るので、採取日をファイル名から渡す
  const capturedAt = capturedAtOf(path.basename(source.file));
  const model = normalize(extraction, { capturedAt }, { patterns: selectors.patterns });

  const n = model.messages.length;
  const withAuthor = model.messages.filter((m) => m.author).length;
  const withTime = model.messages.filter((m) => m.timestamp).length;
  const withBody = model.messages.filter((m) => m.bodyMarkdown || m.subject || m.attachments.length > 0).length;
  const attachments = model.messages.reduce((sum, m) => sum + m.attachments.length, 0);

  totals.messages += n;
  totals.author += withAuthor;
  totals.timestamp += withTime;
  totals.body += withBody;
  totals.attachments += attachments;
  for (const w of model.warnings) warningTotals[w.code] = (warningTotals[w.code] || 0) + 1;

  console.log(
    `${path.basename(source.file).padEnd(48)} [${source.profile}] `
    + `メッセージ ${String(n).padStart(3)} / 送信者 ${pct(withAuthor, n)} / 日時 ${pct(withTime, n)} `
    + `/ 本文 ${pct(withBody, n)} / 添付 ${attachments} / truncated=${model.stats.truncated}`,
  );
}

console.log('\n=== 合計 ===');
console.log(`メッセージ ${totals.messages} 件 / 送信者 ${pct(totals.author, totals.messages)} / 日時 ${pct(totals.timestamp, totals.messages)} / 本文 ${pct(totals.body, totals.messages)} / 添付 ${totals.attachments} 件`);

console.log('\n=== 警告の内訳 ===');
for (const [code, count] of Object.entries(warningTotals).sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(4)}  ${code}`);
}

if (showWarnings) {
  console.log('\n（--warnings 指定時の注記）collapsed-body / replies-not-expanded は「取りこぼしの可能性あり」の明示であり、異常ではない。');
}

/** teams-dom-samples_channel_2026-08-06-17-19-28.md → 2026-08-06T17:19:28+09:00 */
function capturedAtOf(basename) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.md$/.exec(basename);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

function pct(hit, total) {
  if (total === 0) return '-';
  return `${hit}/${total} (${Math.round((hit / total) * 100)}%)`;
}
