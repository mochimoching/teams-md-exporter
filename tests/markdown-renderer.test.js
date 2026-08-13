/**
 * Markdown レンダラのテスト（仕様書 §6）。
 * 採取した実 DOM → 抽出 → 正規化 → Markdown までを通しで確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractConversation } from '../src/extract.js';
import { normalize } from '../src/normalize.js';
import { buildFilename, renderMarkdown, renderMarkdownFiles } from '../src/markdown-renderer.js';
import { loadCollectedSamples, loadSelectors } from './fixtures.js';

const selectors = loadSelectors();

function modelOf(kind, index = 0, meta = {}) {
  const sample = loadCollectedSamples(kind)[index];
  const extraction = extractConversation(sample.root, selectors, { profile: kind });
  return normalize(extraction, {
    kind,
    team: '開発チーム',
    channel: '一般',
    chatTitle: '田中・佐藤・山田',
    url: 'https://teams.microsoft.com/v2/',
    capturedAt: '2026-08-06T19:30:00+09:00',
    capturedBy: '田山 大輝',
    ...meta,
  }, { patterns: selectors.patterns });
}

const channelDoc = renderMarkdown(modelOf('channel', 1));
const chatDoc = renderMarkdown(modelOf('chat', 0));

test('フロントマター（§6.2）が必要な項目を持つ', () => {
  const front = channelDoc.slice(0, channelDoc.indexOf('\n---\n', 4) + 5);
  assert.match(front, /^---\n/);
  for (const key of ['source_kind', 'team', 'channel', 'url', 'captured_at', 'captured_by', 'message_count', 'range', 'truncated', 'tool_version']) {
    assert.match(front, new RegExp(`^${key}: `, 'm'), `${key} が無い`);
  }
  assert.match(front, /^source_kind: channel$/m);
  assert.match(front, /^truncated: true$/m); // 未展開の返信があるサンプル
});

test('見出し構造（§6.2）: タイトル → 日付 → 時刻＋送信者', () => {
  assert.match(channelDoc, /^# 開発チーム \/ 一般（チャネル）$/m);
  assert.match(channelDoc, /^> このファイルは Teams Web の表示内容から自動抽出したものです。抽出時点: 2026-08-06 19:30$/m);
  assert.match(channelDoc, /^## \d{4}-\d{2}-\d{2} \([日月火水木金土]\)$/m);
  assert.match(channelDoc, /^### \d{2}:\d{2} {2}\S/m);
});

test('曜日が日付と一致する', () => {
  const [, date, weekday] = /^## (\d{4}-\d{2}-\d{2}) \(([日月火水木金土])\)$/m.exec(channelDoc);
  const [y, m, d] = date.split('-').map(Number);
  const expected = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  assert.equal(weekday, expected);
});

test('返信は親にぶら下がり、引用インデント＋↳返信 が付く（§6.2）', () => {
  assert.match(channelDoc, /^> #### (?:\d{2}-\d{2} )?\d{2}:\d{2} {2}.+↳返信$/m);

  // 返信の見出しは必ず、どこかの親投稿の見出しより後ろに出る
  const lines = channelDoc.split('\n');
  const firstPost = lines.findIndex((l) => /^### \d{2}:\d{2}/.test(l));
  const firstReply = lines.findIndex((l) => /^> #### (?:\d{2}-\d{2} )?\d{2}:\d{2}/.test(l));
  assert.ok(firstPost >= 0 && firstReply > firstPost, '返信が親より前に出ている');

  // 返信の件数が中間モデルと一致する（親にぶら下げる過程で落ちていない）
  const model = modelOf('channel', 1);
  const ids = new Set(model.messages.map((m) => m.id));
  const nested = model.messages.filter((m) => m.parentId && ids.has(m.parentId)).length;
  assert.equal(lines.filter((l) => /^> #### /.test(l)).length, nested);
});

test('返信の本文が引用の中でも壊れない（複数行が > で揃う）', () => {
  const block = channelDoc.split('\n').filter((l) => l.startsWith('> ####'));
  assert.ok(block.length > 0);
  // 返信ブロック内の行はすべて > で始まる（空行は単独の >）
  const lines = channelDoc.split('\n');
  const start = lines.findIndex((l) => l.startsWith('> ####'));
  for (let i = start; i < lines.length && lines[i] !== ''; i += 1) {
    assert.ok(lines[i].startsWith('>'), `引用が途切れている: ${lines[i]}`);
  }
});

test('truncated のときはファイル冒頭に警告を出す（原則4）', () => {
  assert.match(channelDoc, /> ⚠️ \*\*このファイルは会話の全体ではありません（truncated）\*\*/);
  assert.match(channelDoc, /スレッドを開いていない返信が \d+ 件あります/);
});

test('添付・リアクション・件名が §6.2 の形で出る', () => {
  // 添付が返信に付いていると引用の中に入るので、その分の接頭辞も許す
  const withAttachment = renderMarkdown(modelOf('channel', 2));
  assert.match(withAttachment, /^(?:> )?📎 添付: \[.+\]\(https:\/\/.+\)$/m);
  assert.match(channelDoc, /^(?:>? ?)?[^\s]+ \d+(?: {2}[^\s]+ \d+)*$/m); // 👍 1 のような行
  // 件名（channel の投稿にだけ付く）は太字で本文の前に出る
  const model = modelOf('channel', 1);
  const subject = model.messages.find((m) => m.subject).subject;
  const doc = renderMarkdown(model);
  assert.ok(doc.includes(`**${subject}**`), '件名が太字で出ていない');
  assert.ok(doc.indexOf(`**${subject}**`) > doc.indexOf('### '), '件名が見出しより前にある');
});

test('コードブロックが本文の中でそのまま保たれる', () => {
  const doc = renderMarkdown(modelOf('chat', 1));
  const fence = doc.match(/```plaintext\n([\s\S]*?)\n```/);
  assert.ok(fence, 'コードブロックが出ていない');
  assert.ok(fence[1].split('\n').length > 50, '改行が失われている');
});

test('チャットはフラットに時系列で出る', () => {
  assert.match(chatDoc, /^# 田中・佐藤・山田（チャット）$/m);
  assert.doesNotMatch(chatDoc, /↳返信/);
  const times = [...chatDoc.matchAll(/^### (\d{2}:\d{2})/gm)].map((m) => m[1]);
  assert.ok(times.length > 0);
});

test('引き継いだ日時は「（推定）」と分かるようにする', () => {
  const model = modelOf('channel', 2);
  const inherited = model.messages.filter((m) => m.timestampPrecision === 'inherited');
  assert.ok(inherited.length > 0, '引き継ぎのサンプルが無い');
  const doc = renderMarkdown(model);
  assert.match(doc, /^(?:> )?#{3,4} \d{2}:\d{2}（推定）/m);
});

test('末尾に警告の要約表が付く', () => {
  assert.match(channelDoc, /^## 抽出時の注意（自動生成）$/m);
  assert.match(channelDoc, /^\| コード \| 件数 \| 重大度 \| 例 \|$/m);
  assert.match(channelDoc, /^\| collapsed-body \| \d+ \|/m);
});

test('ファイル名（§6.1）: teams_{kind}_{safeTitle}_{YYYYMMDD-HHmm}.md', () => {
  assert.equal(buildFilename(modelOf('channel', 0)), 'teams_channel_開発チーム-一般_20260806-1930.md');
  assert.equal(buildFilename(modelOf('chat', 0)), 'teams_chat_田中・佐藤・山田_20260806-1930.md');
  assert.equal(
    buildFilename(modelOf('channel', 0, { team: 'A/B:C*D?E', channel: '"F<G>H|I"' })),
    'teams_channel_A-B-C-D-E-F-G-H-I_20260806-1930.md',
  );
});

test('分割（§6.4）: 日付境界で分け、part / part_of をフロントマターに書く', () => {
  const model = modelOf('channel', 1);
  const { files } = renderMarkdownFiles(model, { maxMessagesPerFile: 3 });
  assert.ok(files.length > 1, `分割されていない（${files.length} ファイル）`);

  files.forEach((file, index) => {
    assert.match(file.filename, new RegExp(`_part${index + 1}\\.md$`));
    assert.match(file.content, new RegExp(`^part: ${index + 1}$`, 'm'));
    assert.match(file.content, new RegExp(`^part_of: ${files.length}$`, 'm'));
  });

  // 全メッセージが、どこかのファイルに 1 回ずつ出る
  const headingCount = files.reduce(
    (sum, f) => sum + (f.content.match(/^(?:> )?#{3,4} (?:\d{2}-\d{2} )?\d{2}:\d{2}/gm) || []).length,
    0,
  );
  assert.equal(headingCount, model.messages.length);
});

test('メッセージが 0 件でも壊れず、その旨が分かる', () => {
  const empty = normalize({ messages: [], boxes: [], warnings: [] }, { kind: 'chat', chatTitle: '空', capturedAt: '2026-08-06T19:30:00+09:00' }, { patterns: selectors.patterns });
  const doc = renderMarkdown(empty);
  assert.match(doc, /^message_count: 0$/m);
  assert.match(doc, /^range: "（メッセージなし）"$/m);
});
