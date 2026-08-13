/**
 * スクロールドライバのテスト。
 *
 * 実 Teams と同じく「画面外のメッセージは DOM から消える」仮想スクロールを模した
 * ペインを組み立てて、遡りながら蓄積できるかを検証する。
 * メッセージの中身は採取した実 DOM をそのまま使う（作り物のメッセージは使わない）。
 * sleep / now を注入するので実時間は待たない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectByScrolling, findConversationPane } from '../src/scroll-driver.js';
import { loadCollectedSamples, loadSelectors } from './fixtures.js';

const selectors = loadSelectors();
const blocks = loadCollectedSamples('channel')
  .flatMap((s) => Array.from(s.root.querySelectorAll("[data-tid='channel-pane-message']")))
  .map((el) => el.outerHTML);

/** ページ単位でしか DOM に存在しない仮想スクロールのペインを作る */
function makeVirtualPane(pages, { clientHeight = 500 } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="outer"><div id="pane"></div></div></body>');
  const pane = dom.window.document.getElementById('pane');
  const pageHeight = clientHeight;
  let scrollTop = pageHeight * (pages.length - 1); // 最下部（最新）から開始
  const rendered = [];

  const render = () => {
    const index = Math.min(pages.length - 1, Math.max(0, Math.round(scrollTop / pageHeight)));
    if (rendered[rendered.length - 1] === index) return;
    rendered.push(index);
    pane.innerHTML = pages[index]; // ← 前のページは DOM から消える（仮想スクロール）
  };

  Object.defineProperty(pane, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(pane, 'scrollHeight', { get: () => pageHeight * pages.length });
  Object.defineProperty(pane, 'scrollTop', {
    get: () => scrollTop,
    set: (value) => { scrollTop = Math.max(0, value); render(); },
  });

  render();
  return { dom, pane, renderedPages: rendered };
}

const noWait = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })() };

test('仮想スクロール: 途中で DOM から消えたメッセージも取りこぼさない', async () => {
  const pages = [blocks.slice(0, 3), blocks.slice(3, 6), blocks.slice(6, 9)].map((b) => b.join('\n'));
  const { pane, renderedPages } = makeVirtualPane(pages);

  // 開始時点で DOM にあるのは最新ページだけ
  const visibleAtStart = pane.querySelectorAll("[data-tid='channel-pane-message']").length;
  assert.equal(visibleAtStart, 3);

  const result = await collectByScrolling(pane, selectors, { ...noWait, profile: 'channel' });

  assert.ok(renderedPages.length >= 3, `3 ページとも描画されていない: ${renderedPages}`);
  assert.equal(pane.querySelectorAll("[data-tid='channel-pane-message']").length, 3, 'DOM 上は常に 1 ページ分');

  // 9 箱すべてのメッセージが蓄積されている
  const expectedIds = new Set(
    pages.flatMap((html) => [...html.matchAll(/data-mid="(\d+)"/g)].map((m) => m[1])),
  );
  const collectedIds = new Set(result.messages.map((m) => m.id));
  assert.equal(collectedIds.size, expectedIds.size);
  for (const id of expectedIds) assert.ok(collectedIds.has(id), `${id} が欠落`);
});

test('先頭まで遡れたら truncated=false、途中で打ち切ったら truncated=true と警告', async () => {
  const pages = [blocks.slice(0, 2), blocks.slice(2, 4), blocks.slice(4, 6)].map((b) => b.join('\n'));

  const full = await collectByScrolling(makeVirtualPane(pages).pane, selectors, { ...noWait });
  assert.equal(full.stats.stopReason, 'reached-top');
  assert.equal(full.truncated, false);
  assert.ok(!full.warnings.some((w) => w.code === 'scroll-truncated'));

  const cut = await collectByScrolling(makeVirtualPane(pages).pane, selectors, { ...noWait, maxSteps: 2 });
  assert.equal(cut.stats.stopReason, 'max-steps');
  assert.equal(cut.truncated, true);
  assert.ok(cut.warnings.some((w) => w.code === 'scroll-truncated'));
  assert.ok(cut.messages.length < full.messages.length, '打ち切ったのに全件取れている');
});

test('時系列の順序: 後から遡って見つけた古いメッセージが前に並ぶ', async () => {
  const pages = [blocks.slice(0, 2), blocks.slice(2, 4)].map((b) => b.join('\n'));
  const { pane } = makeVirtualPane(pages);
  const result = await collectByScrolling(pane, selectors, { ...noWait });

  const order = result.messages.map((m) => m.domOrder);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'domOrder が昇順になっていない');

  const oldestPageIds = [...pages[0].matchAll(/data-mid="(\d+)"/g)].map((m) => m[1]);
  const firstIds = result.messages.slice(0, oldestPageIds.length).map((m) => m.id);
  assert.deepEqual(new Set(firstIds), new Set(oldestPageIds), '最も古いページが先頭に来ていない');
});

test('進捗コールバックが各周回で呼ばれる', async () => {
  const pages = [blocks.slice(0, 2), blocks.slice(2, 4)].map((b) => b.join('\n'));
  const progress = [];
  const result = await collectByScrolling(makeVirtualPane(pages).pane, selectors, {
    ...noWait,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(progress.length, result.stats.steps);
  assert.ok(progress[progress.length - 1].collected === result.messages.length);
  assert.ok(progress.every((p) => typeof p.step === 'number' && typeof p.gained === 'number'));
});

test('「詳細を表示」を展開し、展開後の長い本文を採用する', async () => {
  // 折りたたみ中の本文を持つ実サンプルを使い、クリックで本文が伸びる挙動だけ模す
  const dom = new JSDOM(`<!doctype html><body><div id="pane">
    <div data-tid="channel-pane-message" id="reply-chain-summary-900">
      <div role="group" id="message-body-900">
        <div data-tid="post-message-subheader">
          <span id="author-900">送信者</span>
          <time data-tid="timestamp" id="timestamp-900" aria-label="2026年8月6日 10:00">08/06 10:00</time>
        </div>
        <div data-mid="900" data-reply-chain-id="900">
          <div id="see-more-content-900"><div data-tid="message-body" id="content-900"><p>先頭だけ</p></div></div>
          <div id="see-more-container" style="display: flex;">
            <button type="button" aria-expanded="false" aria-controls="see-more-content-900">詳細を表示</button>
          </div>
        </div>
      </div>
    </div>
  </div></body>`);
  const doc = dom.window.document;
  const pane = doc.getElementById('pane');
  Object.defineProperty(pane, 'clientHeight', { get: () => 500 });
  Object.defineProperty(pane, 'scrollHeight', { get: () => 500 });

  const button = doc.querySelector('#see-more-container button');
  button.addEventListener('click', () => {
    button.setAttribute('aria-expanded', 'true');
    doc.getElementById('see-more-container').setAttribute('style', 'display: none;');
    doc.getElementById('content-900').innerHTML = '<p>先頭だけ</p><p>展開して初めて見える続き</p>';
  });

  const result = await collectByScrolling(pane, selectors, { ...noWait, expandBody: true });
  assert.equal(result.stats.expandedBodies, 1);
  assert.ok(result.messages[0].bodyMarkdown.includes('展開して初めて見える続き'), result.messages[0].bodyMarkdown);
  // 展開済みなので折りたたみ警告は出ない
  assert.ok(!result.warnings.some((w) => w.code === 'collapsed-body'));
});

test('展開しない設定なら折りたたみは警告として残る（黙って捨てない）', async () => {
  const html = loadCollectedSamples('channel')[0].root.innerHTML;
  const { pane } = makeVirtualPane([html]);
  const result = await collectByScrolling(pane, selectors, { ...noWait, expandBody: false });
  assert.equal(result.stats.expandedBodies, 0);
  assert.ok(result.warnings.some((w) => w.code === 'collapsed-body'));
});

test('会話ペインは設定優先、無ければスクロール可能な祖先を自動判定する', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="scroller"><div data-tid="channel-pane-viewport"><div id="inner"></div></div></div>
  </body>`);
  const doc = dom.window.document;
  doc.getElementById('inner').innerHTML = blocks[0];
  const configured = findConversationPane(doc.body, selectors, 'channel');
  assert.equal(configured.getAttribute('data-tid'), 'channel-pane-viewport');

  // 設定値が外れた場合でも、実際にスクロールできる祖先を見つける
  const fallbackSelectors = {
    ...selectors,
    profiles: { ...selectors.profiles, channel: { ...selectors.profiles.channel, conversationPane: [] } },
  };
  const scroller = doc.getElementById('scroller');
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 1000 });
  Object.defineProperty(scroller, 'clientHeight', { get: () => 500 });
  assert.equal(findConversationPane(doc.body, fallbackSelectors, 'channel'), scroller);
});

test('返信スレッド: セレクタ未設定なら推測で動かず、警告して取りこぼしを報告する', async () => {
  const withoutThread = {
    ...selectors,
    profiles: {
      ...selectors.profiles,
      channel: { ...selectors.profiles.channel, threadPane: [], threadPaneScroller: [] },
    },
  };
  const html = loadCollectedSamples('channel')[0].root.innerHTML;
  const { pane } = makeVirtualPane([html]);
  const result = await collectByScrolling(pane, withoutThread, { ...noWait, expandReplies: true });

  assert.equal(result.stats.expandedReplies, 0);
  assert.ok(result.warnings.some((w) => w.code === 'reply-thread-selectors-unset'));
});

test('返信スレッド: スレッド画面を開いて返信を回収し、閉じてから続行する', async () => {
  // スレッド画面は「チャネルなのにチャット形式の DOM」で描画されることが採取で判明している。
  // ここでは会話ペイン側にチャネルの実サンプル、スレッド側にチャットの実サンプルを置き、
  // 「クリックで開き、閉じると消える」という確認済みの挙動だけを合成している。
  const postHtml = blocks.find((b) => b.includes("data-tid=\"response-summary-button\""));
  assert.ok(postHtml, '返信ボタンつきのサンプルが無い');
  const postId = /data-mid="(\d+)"/.exec(postHtml)[1];

  const chatSample = loadCollectedSamples('chat')[0];
  const replyHtml = Array.from(chatSample.root.querySelectorAll("[data-tid='chat-pane-item']"))
    .filter((el) => el.querySelector("[data-tid='chat-pane-message']"))
    .slice(0, 3)
    .map((el) => el.outerHTML)
    .join('\n');
  const replyIds = [...replyHtml.matchAll(/data-mid="(\d+)"/g)].map((m) => m[1]);
  assert.ok(replyIds.length >= 2, 'スレッド側のサンプルが足りない');

  const dom = new JSDOM(`<!doctype html><body>
    <div id="pane">${postHtml.replace(/aria-label="\d+ 件の返信"/, 'aria-label="99 件の返信"')}</div>
    <div id="thread-host"></div>
  </body>`);
  const doc = dom.window.document;
  const pane = doc.getElementById('pane');
  Object.defineProperty(pane, 'clientHeight', { get: () => 500 });
  Object.defineProperty(pane, 'scrollHeight', { get: () => 500 });

  const host = doc.getElementById('thread-host');
  const button = doc.querySelector("[data-tid='response-summary-button']");
  assert.ok(button, 'サンプルに「N 件の返信を開く」ボタンが無い');
  button.addEventListener('click', () => {
    host.innerHTML = `<div data-tid="thread-pane"><button data-tid="thread-close">閉じる</button>
      <div data-tid="thread-scroller">${replyHtml}</div></div>`;
    doc.querySelector("[data-tid='thread-close']").addEventListener('click', () => { host.innerHTML = ''; });
  });

  const withThread = {
    ...selectors,
    profiles: {
      ...selectors.profiles,
      channel: {
        ...selectors.profiles.channel,
        threadPane: "[data-tid='thread-pane']",
        threadPaneScroller: "[data-tid='thread-scroller']",
        threadPaneClose: "[data-tid='thread-close']",
      },
    },
  };

  const result = await collectByScrolling(pane, withThread, { ...noWait, expandReplies: true });

  assert.equal(result.stats.expandedReplies, 1);
  const ids = new Set(result.messages.map((m) => m.id));
  assert.ok(ids.has(postId), '親投稿が取れていない');
  for (const id of replyIds) assert.ok(ids.has(id), `スレッド側の ${id} が取れていない`);
  assert.equal(host.innerHTML, '', 'スレッドペインを閉じられていない');
  assert.ok(!result.warnings.some((w) => w.code === 'reply-thread-not-closed'));
});

test('スレッドを開いて会話ペインが作り直されても、探し直して収集を続ける', async () => {
  // 採取結果では、スレッド表示中は channel-pane-message が DOM に 1 件も無かった＝
  // 会話ペインは作り直される可能性がある。参照が外れたら見つけ直せることを確認する。
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const doc = dom.window.document;
  const host = doc.getElementById('host');

  const makePane = () => {
    host.innerHTML = `<div data-tid="channel-pane-viewport">${blocks[0]}</div>`;
    const el = host.firstElementChild;
    Object.defineProperty(el, 'clientHeight', { get: () => 500 });
    Object.defineProperty(el, 'scrollHeight', { get: () => 500 });
    return el;
  };

  const original = makePane();
  let replaced = false;
  const result = await collectByScrolling(original, selectors, {
    ...noWait,
    onProgress: () => {
      if (replaced) return;
      replaced = true;
      makePane(); // 元のペインを DOM から外して作り直す
    },
    expandReplies: true,
  });

  assert.equal(original.isConnected, false, '元のペインが外れていない（テストの前提が崩れている）');
  assert.ok(result.messages.length > 0, 'ペインを見失って 1 件も取れていない');
});

test('抽出 0 件は fatal 警告になる', async () => {
  const { pane } = makeVirtualPane(['<div>メッセージではない何か</div>']);
  const result = await collectByScrolling(pane, selectors, { ...noWait });
  assert.equal(result.messages.length, 0);
  assert.ok(result.warnings.some((w) => w.level === 'fatal' && w.code === 'no-messages-extracted'));
});

test('shouldAbort が true を返すと打ち切り、truncated として報告する', async () => {
  const pages = [blocks.slice(0, 3), blocks.slice(3, 6), blocks.slice(6, 9)].map((b) => b.join('\n'));
  const { pane } = makeVirtualPane(pages);

  let rounds = 0;
  const result = await collectByScrolling(pane, selectors, {
    ...noWait,
    profile: 'channel',
    shouldAbort: () => (rounds += 1) > 1, // 2 周目で中止
  });

  assert.equal(result.stats.stopReason, 'aborted');
  assert.equal(result.truncated, true);
  assert.ok(result.messages.length > 0, '中止でも、それまでに取れた分は返す');
  assert.ok(result.warnings.some((w) => w.code === 'scroll-truncated'), '取りこぼしが警告に出ていない');
});
