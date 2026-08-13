/**
 * docs/dom-samples/ に採取した実 DOM に対する回帰テスト。
 * サンプルを書き換えずにそのまま読み込むので、実 Teams との差が生まれない。
 *
 * 件数の固定値はサンプルを採り直すと変わるため、原則は「全件で取れていること」を検査し、
 * 個別の値は構造の証拠になるものだけを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractConversation } from '../src/extract.js';
import { normalize } from '../src/normalize.js';
import { loadCollectedSamples, loadSelectors } from './fixtures.js';

const selectors = loadSelectors();

const samples = [
  ...loadCollectedSamples('channel').map((s) => ({ ...s, profile: 'channel' })),
  ...loadCollectedSamples('chat').map((s) => ({ ...s, profile: 'chat' })),
].map((s) => ({ ...s, extraction: extractConversation(s.root, selectors, { profile: s.profile }) }));

const channel = samples.filter((s) => s.profile === 'channel');
const chat = samples.filter((s) => s.profile === 'chat');
const allMessages = samples.flatMap((s) => s.extraction.messages);

test('採取サンプルが channel / chat とも存在する', () => {
  assert.ok(channel.length >= 1, 'channel サンプルが無い');
  assert.ok(chat.length >= 1, 'chat サンプルが無い');
  assert.ok(allMessages.length >= 50, `メッセージが少なすぎる: ${allMessages.length}`);
});

test('全サンプルの全メッセージで 送信者 / 日時 / 本文 が取れる', () => {
  const noAuthor = allMessages.filter((m) => !m.author);
  const noTime = allMessages.filter((m) => !m.timestamp.text && Object.keys(m.timestamp.attributes).length === 0);
  const noContent = allMessages.filter((m) => !m.bodyMarkdown && !m.subject && m.attachments.length === 0);

  assert.deepEqual(noAuthor.map((m) => m.id), []);
  assert.deepEqual(noTime.map((m) => m.id), []);
  assert.deepEqual(noContent.map((m) => m.id), []);
});

test('メッセージ ID はすべて data-mid 由来（合成 ID にフォールバックしない）', () => {
  const synthetic = allMessages.filter((m) => String(m.id).startsWith('synthetic:'));
  assert.deepEqual(synthetic.map((m) => m.bodyText.slice(0, 40)), []);
});

test('chat: ヘッダ（送信者・日時）はメッセージ本体の外側にあるので、箱ごと取る', () => {
  const messages = chat.flatMap((s) => s.extraction.messages);
  assert.ok(messages.every((m) => m.author), 'chat の送信者が取れていない');

  // chat の <time> には datetime="…Z"（UTC・秒つき）がある = 最も正確な情報源
  const model = normalize(
    { messages, boxes: [], warnings: [] },
    { capturedAt: '2026-08-06T19:06:23+09:00' },
    { patterns: selectors.patterns },
  );
  assert.ok(model.messages.every((m) => m.timestampPrecision === 'second'));
  assert.ok(model.messages.every((m) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(m.timestamp)));
});

test('chat: 入れ子の chat-pane-item（アバター用）を箱と誤認しない', () => {
  for (const s of chat) {
    const naive = s.root.querySelectorAll("[data-tid='chat-pane-item']").length;
    const boxes = s.extraction.boxes.length;
    assert.ok(boxes <= naive, '箱の数が候補数を超えている');
    assert.equal(
      boxes,
      s.root.querySelectorAll("[data-tid='chat-pane-message']").length,
      '箱の数が実メッセージ数と一致しない（入れ子を拾っている可能性）',
    );
  }
  assert.ok(!samples.flatMap((s) => s.extraction.warnings).some((w) => w.code === 'empty-message-box'));
});

test('コードブロック: <br> 区切りの複数行が行として復元され、言語名が付く', () => {
  const code = allMessages.find((m) => m.bodyMarkdown.includes('```'));
  assert.ok(code, 'コードブロックを含むサンプルが無い');

  const fenced = code.bodyMarkdown.match(/(`{3,})([a-z0-9]*)\n([\s\S]*?)\n\1/);
  assert.ok(fenced, 'フェンスが組み立てられていない');
  assert.equal(fenced[2], 'plaintext', '言語ラベル（ヘッダの data-tid）が拾えていない');
  assert.ok(fenced[3].split('\n').length > 50, `改行が失われている（${fenced[3].split('\n').length} 行）`);
  assert.ok(!code.bodyMarkdown.includes('Plain Text'), '言語ラベルが本文テキストとして混ざっている');
});

test('添付: ファイル名と URL が取れ、表示件数とも一致する', () => {
  const attachments = allMessages.flatMap((m) => m.attachments);
  assert.ok(attachments.length >= 5, `添付サンプルが少なすぎる: ${attachments.length}`);
  for (const a of attachments) {
    assert.ok(a.name, `添付名が空: ${JSON.stringify(a)}`);
    assert.match(a.url || '', /^https:\/\//, `添付 URL が取れていない: ${JSON.stringify(a)}`);
  }
  const codes = samples.flatMap((s) => s.extraction.warnings).map((w) => w.code);
  assert.ok(!codes.includes('attachment-count-mismatch'));
  assert.ok(!codes.includes('attachment-unrecognized'));
  assert.ok(!codes.includes('attachment-url-missing'));
});

test('連続投稿でヘッダが省略されたメッセージは直前から引き継ぎ、引き継いだと記録する', () => {
  const inherited = allMessages.filter((m) => m.authorInherited);
  assert.ok(inherited.length > 0, '引き継ぎのサンプルが無い');
  for (const m of inherited) {
    assert.ok(m.author);
    assert.ok(m.warnings.some((w) => w.code === 'author-inherited'));
  }
});

test('折りたたみ判定: 入れ物の有無ではなく実際に折りたたまれているものだけ警告する', () => {
  const containers = samples.reduce(
    (sum, s) => sum + s.root.querySelectorAll('[id^="see-more-container"]').length,
    0,
  );
  const collapsed = samples
    .flatMap((s) => s.extraction.warnings)
    .filter((w) => w.code === 'collapsed-body').length;
  assert.ok(containers > 0);
  assert.ok(collapsed < containers, `入れ物 ${containers} 件に対し警告 ${collapsed} 件（全件警告は誤検出）`);
});

test('日時: 相対表記（「昨日の 19:18」「13:47」）は取得日を基準に解決し、基準日が無ければ null にする', () => {
  const relativeSample = channel.find((s) => s.file.includes('18-43-21'));
  assert.ok(relativeSample, '相対表記を含むサンプルが無い');

  const resolved = normalize(
    relativeSample.extraction,
    { capturedAt: '2026-08-06T18:43:21+09:00' },
    { patterns: selectors.patterns },
  );
  const relative = resolved.messages.filter((m) => m.timestampPrecision === 'minute-relative');
  assert.equal(relative.length, 3);
  assert.ok(relative.every((m) => /^2026-08-0[56]T/.test(m.timestamp)), JSON.stringify(relative.map((m) => m.timestamp)));

  const unresolved = normalize(relativeSample.extraction, {}, { patterns: selectors.patterns });
  assert.ok(unresolved.warnings.some((w) => w.code === 'timestamp-relative-unresolved'));
  assert.equal(unresolved.messages.filter((m) => m.timestamp === null).length, 3);
});

test('本文: インラインコード・引用・メンションが Markdown になる', () => {
  assert.ok(allMessages.some((m) => /`[^`\n]+`/.test(m.bodyMarkdown.replace(/```[\s\S]*?```/g, ''))), 'インラインコードが無い');
  assert.ok(allMessages.some((m) => /^> /m.test(m.bodyMarkdown)), '引用が無い');
  assert.ok(allMessages.some((m) => /\*\*@/.test(m.bodyMarkdown)), 'メンションが無い');
});

test('本文: blob: の貼り付け画像は死んだリンクにせずコメントで残す', () => {
  assert.ok(allMessages.some((m) => m.bodyMarkdown.includes('<!-- 未対応要素: 画像')));
  assert.ok(!allMessages.some((m) => m.bodyMarkdown.includes('](blob:')), 'blob: URL がリンクとして出力されている');
});

test('未展開の返信は truncated=true として明示される（channel）', () => {
  const models = channel.map((s) => normalize(s.extraction, {}, { patterns: selectors.patterns }));
  assert.ok(models.every((m) => m.stats.truncated === true), 'channel サンプルで truncated が立っていない');

  const withGap = models.filter((m) => m.stats.replyGaps.length > 0);
  assert.ok(withGap.length > 0, '「N 件の返信」に対し DOM に出ていない返信が検出されていない');
  for (const gap of withGap.flatMap((m) => m.stats.replyGaps)) {
    assert.ok(gap.declared > gap.extracted);
  }
});
