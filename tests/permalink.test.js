/**
 * 個々のメッセージへのリンク（ディープリンク）。
 *
 * 会話 ID（threadId）の在りかは 2026-08-13 に実機のコンソールで確認した:
 *   - チャネル: [data-track-thread-id] が 3 個（送信ボタン＋会議ヘッダ）、値はすべて同一
 *   - 会議チャット: 1 個
 *   - ページ全文の正規表現検索は使えない（左一覧の全会話・本文に貼られた他会話のリンクを拾う）
 * その状況を再現した DOM で、指名した属性だけを読んでいることを検査する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { extractConversationId } from '../src/extract.js';
import { buildPermalink, normalize, permalinkConfigFor } from '../src/normalize.js';
import { renderMarkdown } from '../src/markdown-renderer.js';
import { loadSelectors } from './fixtures.js';

const selectors = loadSelectors();
const CHANNEL_THREAD = '19:e8f600c345894f958527070a95f6f1c0@thread.tacv2';
const OTHER_THREAD = '19:f37f6209597e4ebebcc7826cbaecf837@thread.tacv2';

/** 送信ボタンと、無関係な ID（左一覧・本文に貼られたリンク）が同居した DOM */
function makePage({ threadIds = [CHANNEL_THREAD], noise = true } = {}) {
  const buttons = threadIds
    .map((id) => `<button data-tid="sendMessageCommands-send" data-track-thread-id="${id}">送信</button>`)
    .join('');
  const noiseHtml = noise
    ? `<div data-fui-tree-item-value="${OTHER_THREAD}">左一覧の別の会話</div>
       <a href="https://teams.microsoft.com/l/message/${OTHER_THREAD}/1785145811391">本文に貼られたリンク</a>`
    : '';
  const dom = new JSDOM(`<!doctype html><body>${noiseHtml}${buttons}</body>`);
  return dom.window.document.body;
}

test('会話 ID は指名した属性からだけ読む（左一覧や本文のリンクを拾わない）', () => {
  const { threadId, warnings } = extractConversationId(makePage(), selectors, { profile: 'channel' });
  assert.equal(threadId, CHANNEL_THREAD);
  assert.deepEqual(warnings, []);
});

test('同じ会話 ID を持つ要素が複数あっても警告しない（実機のチャネルは 3 個）', () => {
  const page = makePage({ threadIds: [CHANNEL_THREAD, CHANNEL_THREAD, CHANNEL_THREAD] });
  const { threadId, warnings } = extractConversationId(page, selectors, { profile: 'channel' });
  assert.equal(threadId, CHANNEL_THREAD);
  assert.deepEqual(warnings, []);
});

test('会話 ID の候補が食い違う場合は警告する（黙って先頭を使わない）', () => {
  const page = makePage({ threadIds: [CHANNEL_THREAD, OTHER_THREAD] });
  const { threadId, warnings } = extractConversationId(page, selectors, { profile: 'channel' });
  assert.equal(threadId, CHANNEL_THREAD);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'conversation-id-ambiguous');
});

test('会話 ID が見つからなければ警告し、null を返す', () => {
  const page = makePage({ threadIds: [] });
  const { threadId, warnings } = extractConversationId(page, selectors, { profile: 'chat' });
  assert.equal(threadId, null);
  assert.equal(warnings[0].code, 'conversation-id-not-found');
});

const channelConfig = permalinkConfigFor(selectors, 'channel');
const chatConfig = permalinkConfigFor(selectors, 'chat');

test('チャネルのリンクはパス部を素のまま、取れた値だけをクエリに載せる', () => {
  const url = buildPermalink(channelConfig, {
    threadId: CHANNEL_THREAD,
    messageId: '1785145811391',
    parentId: '1785145811391',
    tenantId: null,
    groupId: null,
  });
  assert.equal(
    url,
    `https://teams.microsoft.com/l/message/${CHANNEL_THREAD}/1785145811391`
    + '?parentMessageId=1785145811391&createdTime=1785145811391&ngc=true',
  );
});

/**
 * 2026-08-13 に実機の「リンクをコピー」で得た URL と、載せる項目・順序・値を揃える。
 * teamName / channelName は表示名なので付けない（無くても会話は一意に決まる）。
 */
test('tenantId と groupId を渡すと実物と同じ並びになる', () => {
  const url = buildPermalink(channelConfig, {
    threadId: '19:5bd8f4d415f642f1949fbe396f62ff4d@thread.tacv2',
    messageId: '1786525125055',
    parentId: '1786521292457',
    tenantId: '1fcf450d-bb71-4efd-ae5d-90c7be757e12',
    groupId: '32e1ccdc-2f4c-4eaf-8346-8910d0cf0195',
  });
  assert.equal(
    url,
    'https://teams.microsoft.com/l/message/19:5bd8f4d415f642f1949fbe396f62ff4d@thread.tacv2/1786525125055'
    + '?tenantId=1fcf450d-bb71-4efd-ae5d-90c7be757e12'
    + '&groupId=32e1ccdc-2f4c-4eaf-8346-8910d0cf0195'
    + '&parentMessageId=1786521292457'
    + '&createdTime=1786525125055'
    + '&ngc=true',
  );
});

/**
 * 2026-08-13 に実機の「リンクをコピー」で得た URL と 1 文字も違わないこと。
 * parentMessageId を付けるとデスクトップアプリが「チームを見つけることができません」になる。
 */
test('チャットのリンクは Teams の「リンクをコピー」と完全に一致する', () => {
  const url = buildPermalink(chatConfig, {
    threadId: '19:meeting_YTQwNTM2MGYtNzI3OS00ZjkzLThmYTMtNzRhYTY4ODc2OWYz@thread.v2',
    messageId: '1786605485086',
    parentId: '1786605485086',
    tenantId: null,
  });
  assert.equal(
    url,
    'https://teams.microsoft.com/l/message/19:meeting_YTQwNTM2MGYtNzI3OS00ZjkzLThmYTMtNzRhYTY4ODc2OWYz@thread.v2/1786605485086?context={"contextType"%3A"chat"}',
  );
  assert.doesNotMatch(url, /parentMessageId/);
});

test('tenantId を渡したときだけチャネルのクエリに載る', () => {
  const url = buildPermalink(channelConfig, {
    threadId: CHANNEL_THREAD,
    messageId: '100',
    parentId: '100',
    tenantId: 'aaaa-bbbb',
  });
  assert.match(url, /[?&]tenantId=aaaa-bbbb(&|$)/);
});

test('会話 ID が無ければ URL を推測で作らない', () => {
  assert.equal(buildPermalink(channelConfig, { threadId: null, messageId: '100', parentId: '100' }), null);
  assert.equal(buildPermalink(channelConfig, { threadId: CHANNEL_THREAD, messageId: null }), null);
});

test('リンク設定は会話種別ごとに用意されている', () => {
  assert.ok(channelConfig && chatConfig, 'channel / chat 両方の設定が要る');
  assert.notDeepEqual(channelConfig.params, chatConfig.params, 'チャネルとチャットで URL の形は違う');
  assert.equal(permalinkConfigFor(selectors, 'unknown-profile'), null);
});

/* ---- 中間モデル・Markdown まで ---------------------------------------- */

const extraction = {
  profile: 'channel',
  boxes: [],
  warnings: [],
  messages: [
    { id: '1000', parentId: null, author: '山田太郎', timestamp: { attributes: { 'aria-label': '2026年8月4日 9:12' } }, bodyMarkdown: '親投稿', domOrder: 0 },
    { id: '1001', parentId: '1000', author: '鈴木花子', timestamp: { attributes: { 'aria-label': '2026年8月4日 9:30' } }, bodyMarkdown: '返信', domOrder: 1 },
  ],
};

function buildModel(meta = {}, options = {}) {
  return normalize(extraction, { kind: 'channel', capturedAt: '2026-08-13T10:00:00+09:00', ...meta }, {
    patterns: selectors.patterns,
    permalink: permalinkConfigFor(selectors, 'channel'),
    ...options,
  });
}

test('投稿は自分自身、返信は親を parentMessageId にする', () => {
  const model = buildModel({ threadId: CHANNEL_THREAD });
  const [post, reply] = model.messages;
  assert.match(post.permalink, /\/1000\?parentMessageId=1000&/);
  assert.match(reply.permalink, /\/1001\?parentMessageId=1000&/);
  assert.equal(model.source.threadId, CHANNEL_THREAD);
  assert.equal(model.stats.permalinkCount, 2);
});

test('会話 ID が無いときはリンクを付けず、permalink-unavailable を出す', () => {
  const model = buildModel({});
  assert.equal(model.messages[0].permalink, null);
  assert.equal(model.stats.permalinkCount, 0);
  assert.ok(model.warnings.some((w) => w.code === 'permalink-unavailable'));
});

test('Markdown の見出しにリンクが載る', () => {
  const md = renderMarkdown(buildModel({ threadId: CHANNEL_THREAD }));
  // ':' や '@' を含むので YAML では引用される
  assert.match(md, /^thread_id: "19:.*@thread\.tacv2"$/m);
  assert.match(md, /### 09:12 {2}山田太郎 \[🔗\]\(https:\/\/teams\.microsoft\.com\/l\/message\//m);
  // 返信は引用ブロックの中に入る
  assert.match(md, /^> #### 09:30 {2}鈴木花子 ↳返信 \[🔗\]\(/m);
});

test('リンクが無いメッセージの見出しは従来どおり（余計な記号を足さない）', () => {
  const md = renderMarkdown(buildModel({}));
  assert.match(md, /^### 09:12 {2}山田太郎$/m);
});
