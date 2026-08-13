import test from 'node:test';
import assert from 'node:assert/strict';

import { extractConversation } from '../src/extract.js';
import { normalize } from '../src/normalize.js';
import { loadSelectors, makeConversationRoot, makeElement } from './fixtures.js';

const selectors = loadSelectors();
const { root } = makeConversationRoot();
const extraction = extractConversation(root, selectors);

const POST_IDS = ['1784789795776', '1780555897146'];
const REPLY_IDS = {
  1784789795776: ['1785203987849', '1785217531683', '1785220157307'],
  1780555897146: ['1782090397305', '1782811800157', '1782968846148'],
};

test('メッセージ箱と単位: 2 箱 / 8 メッセージ（親 2 + 返信 6）', () => {
  assert.equal(extraction.boxes.length, 2);
  assert.equal(extraction.messages.length, 8);
  assert.deepEqual(extraction.boxes.map((b) => b.postId), POST_IDS);
});

test('メッセージ ID は data-mid から取れる（合成 ID にフォールバックしない）', () => {
  const ids = extraction.messages.map((m) => m.id);
  assert.deepEqual(ids, [
    POST_IDS[0], ...REPLY_IDS[POST_IDS[0]],
    POST_IDS[1], ...REPLY_IDS[POST_IDS[1]],
  ]);
  assert.ok(!ids.some((id) => id.startsWith('synthetic:')));
});

test('返信の parentId が親投稿を指す', () => {
  for (const postId of POST_IDS) {
    const replies = extraction.messages.filter((m) => m.parentId === postId);
    assert.deepEqual(replies.map((m) => m.id), REPLY_IDS[postId]);
  }
  assert.deepEqual(
    extraction.messages.filter((m) => m.parentId === null).map((m) => m.id),
    POST_IDS,
  );
});

test('送信者は author-{mid} から取れ、全メッセージで非空', () => {
  for (const m of extraction.messages) {
    assert.ok(m.author && m.author.length > 0, `author 欠落: ${m.id}`);
  }
  const first = extraction.messages[0];
  assert.equal(first.author, 'AIS ブライアン サリム/Brian, Salim (NTT DATA)');
});

test('日時は aria-label（年つき）と表示テキストの両方を保持する', () => {
  const first = extraction.messages[0];
  assert.equal(first.timestamp.attributes['aria-label'], '2026年7月23日 15:56');
  assert.equal(first.timestamp.text, '07/23 15:56');
  // Teams の <time> には datetime 属性が無い（キャリブレーション時点の事実）
  assert.equal(first.timestamp.attributes.datetime, undefined);
});

test('件名は親投稿のみに付く', () => {
  const withSubject = extraction.messages.filter((m) => m.subject);
  assert.deepEqual(withSubject.map((m) => m.id), POST_IDS);
  assert.equal(withSubject[0].subject, '【issueレビュー依頼】JDK25対応');
});

test('リアクション: 絵文字・言語非依存 ID・ラベル（件数の生テキスト）が取れる', () => {
  const post = extraction.messages[0];
  assert.deepEqual(post.reactions, [
    { emoji: '👍', emojiId: 'yes', label: '1 件の いいね! リアクション。' },
  ]);

  const customEmojiReply = extraction.messages.find((m) => m.id === '1782090397305');
  assert.deepEqual(customEmojiReply.reactions, [
    { emoji: 'ok9', emojiId: 'ok9;0-wjp-d2-dff586090628e2aab321f13eb1b04ef9', label: '1 件の ok9 リアクション。' },
  ]);
});

test('メンション: 表示名と MRI が取れ、別人は結合されない', () => {
  const post = extraction.messages.find((m) => m.id === '1780555897146');
  assert.deepEqual(post.mentions.map((m) => m.name), [
    'TIG 曽子 雅貴/Soshi, Masaki (NTT DATA)',
    'TIG 星野 奈津子/Hoshino, Natsuko (NTT DATA)',
  ]);
  assert.ok(post.mentions.every((m) => /^8:orgid:/.test(m.mri)), JSON.stringify(post.mentions));
});

test('本文: メンションは 1 人分にまとめて **@表示名** になる', () => {
  const post = extraction.messages[0];
  assert.ok(
    post.bodyMarkdown.startsWith('**@AIS 角本 勝典/Kakumoto, Masanori (NTT DATA)**'),
    post.bodyMarkdown.slice(0, 120),
  );
  assert.ok(post.bodyMarkdown.includes('お疲れ様です。'));
});

test('本文: リンクと引用が Markdown になる', () => {
  const post = extraction.messages[0];
  assert.ok(post.bodyMarkdown.includes('<https://terasolunaorg.atlassian.net/browse/TERAB-1398>'));

  const quoting = extraction.messages.find((m) => m.id === '1782090397305');
  assert.ok(quoting.bodyMarkdown.includes('> なんかここだけはしっかり見てほしかったってところある？'));
});

test('アダプティブカードは捨てずに HTML コメントで残す（§6.3）', () => {
  const post = extraction.messages[0];
  assert.match(post.bodyMarkdown, /<!-- 未対応要素: adaptive-card \(https:\/\/terasolunaorg\.atlassian\.net\/[^)]+\) -->/);
  assert.equal(post.cards.length, 1);
});

test('添付・編集済み・削除済みはサンプルに存在しないので空/false のまま', () => {
  for (const m of extraction.messages) {
    assert.deepEqual(m.attachments, []);
    assert.equal(m.edited, false);
    assert.equal(m.deleted, false);
  }
});

test('折りたたみ本文と未展開の返信を警告として必ず報告する', () => {
  const codes = new Set(extraction.warnings.map((w) => w.code));
  assert.ok(codes.has('collapsed-body'), '「詳細を表示」の検出が警告に出ていない');
  assert.ok(!codes.has('no-messages-extracted'));
});

test('normalize: §5 の中間モデルになる', () => {
  const model = normalize(extraction, {
    kind: 'channel',
    team: 'テストチーム',
    channel: 'テストチャネル',
    url: 'https://teams.microsoft.com/v2/',
    capturedAt: '2026-08-05T19:00:00+09:00',
    capturedBy: 'テスト実行者',
  }, { patterns: selectors.patterns });

  assert.equal(model.messages.length, 8);
  assert.equal(model.messages[0].timestamp, '2026-06-04T15:51:00+09:00'); // 時系列ソート後の先頭
  assert.equal(model.stats.messageCount, 8);
  assert.equal(model.stats.threadCount, 2);
  assert.equal(model.stats.rangeStart, '2026-06-04T15:51:00+09:00');
  assert.equal(model.stats.rangeEnd, '2026-07-28T15:29:00+09:00');
  assert.equal(model.participants.length, 4);

  const post = model.messages.find((m) => m.id === '1784789795776');
  assert.deepEqual(post.reactions, [
    { type: 'いいね!', typeId: 'yes', count: 1, emoji: '👍', label: '1 件の いいね! リアクション。' },
  ]);
});

test('normalize: 未展開の返信は truncated=true として明示される（原則4）', () => {
  const model = normalize(extraction, {}, { patterns: selectors.patterns });
  assert.equal(model.stats.truncated, true);
  assert.deepEqual(
    model.stats.replyGaps.map((g) => [g.declared, g.extracted]),
    [[7, 3], [18, 3]],
  );
  assert.ok(model.warnings.some((w) => w.code === 'replies-not-expanded'));
});

test('メッセージ単体を root に渡しても動く（方式A/B 共通の純粋関数）', () => {
  const { root: single } = makeConversationRoot([0]);
  const box = single.querySelector("[data-tid='channel-pane-message']");
  const one = extractConversation(box, selectors);
  assert.equal(one.messages.length, 4);
  assert.equal(one.boxes.length, 1);
});

test('システムメッセージは既定で出力から除外し、件数だけ残す', () => {
  // 注意: 実物の control-message-renderer はまだ採取できていないため、
  // ここで組み立てているのは「箱の data-tid と、その中に data-mid がある」という
  // 確認済みの事実だけを使った合成 DOM。中身の構造には踏み込まない。
  const root = makeElement(`
    <div data-tid="chat-pane-item">
      <div data-tid="chat-pane-message" role="group" id="message-body-100" data-mid="100">
        <div id="content-100" data-message-content="">こんにちは</div>
      </div>
    </div>
    <div data-tid="chat-pane-item">
      <div data-tid="control-message-renderer" data-mid="101">田山 大輝 がチャネル名を「一般」に変更しました</div>
    </div>
  `);

  const extraction = extractConversation(root, selectors, { profile: 'chat' });
  assert.equal(extraction.messages.length, 2);
  assert.deepEqual(extraction.messages.map((m) => m.system), [false, true]);

  const excluded = normalize(extraction, {}, { patterns: selectors.patterns });
  assert.equal(excluded.messages.length, 1);
  assert.equal(excluded.stats.systemExcluded, 1);
  assert.ok(excluded.warnings.some((w) => w.code === 'system-messages-excluded'));

  const included = normalize(extraction, {}, { patterns: selectors.patterns, includeSystem: true });
  assert.equal(included.messages.length, 2);
  assert.equal(included.stats.systemExcluded, 0);
});

test('抽出 0 件は成功にせず fatal 警告を出す（原則4）', () => {
  const { root: empty } = makeConversationRoot([]);
  const result = extractConversation(empty, selectors);
  assert.equal(result.messages.length, 0);
  assert.ok(result.warnings.some((w) => w.level === 'fatal' && w.code === 'no-messages-extracted'));
});
