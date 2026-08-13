/**
 * 取得範囲とシステムメッセージ除外（仕様書 §7-2）。
 *
 * 範囲の指定は 2 か所で効く:
 *   - スクロールドライバ: 範囲より古いところまで遡ったら止める（stopBefore）
 *   - 正規化: 境界を越えて拾った分を出力から落とす（since）
 * どちらも「黙って捨てない」ことを含めて検査する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectByScrolling } from '../src/scroll-driver.js';
import { normalize } from '../src/normalize.js';
import { renderMarkdown } from '../src/markdown-renderer.js';
import { loadCollectedSamples, loadSelectors } from './fixtures.js';

const selectors = loadSelectors();
const CAPTURED_AT = '2026-08-13T10:00:00+09:00';

function makeExtraction(dates) {
  return {
    profile: 'channel',
    boxes: [],
    warnings: [],
    messages: dates.map((date, index) => ({
      id: String(1000 + index),
      parentId: null,
      author: '山田太郎',
      timestamp: { attributes: { 'aria-label': date } },
      bodyMarkdown: `本文 ${index}`,
      domOrder: index,
    })),
  };
}

function buildModel(dates, options) {
  return normalize(makeExtraction(dates), { kind: 'channel', capturedAt: CAPTURED_AT }, {
    patterns: selectors.patterns,
    ...options,
  });
}

const DATES = ['2026年6月1日 9:00', '2026年7月15日 9:00', '2026年8月10日 9:00'];

test('since より古いメッセージは出力から除外し、件数を残す', () => {
  const model = buildModel(DATES, { since: '2026-07-01T00:00:00+09:00' });

  assert.equal(model.stats.messageCount, 2);
  assert.equal(model.stats.rangeExcluded, 1);
  assert.equal(model.stats.since, '2026-07-01T00:00:00+09:00');
  assert.ok(model.warnings.some((w) => w.code === 'out-of-range-excluded'));
  assert.ok(model.messages.every((m) => m.timestamp >= '2026-07-01'));
});

test('since を指定しなければ全件そのまま', () => {
  const model = buildModel(DATES, {});
  assert.equal(model.stats.messageCount, 3);
  assert.equal(model.stats.rangeExcluded, 0);
  assert.equal(model.stats.since, null);
});

test('日時が取れないメッセージは範囲で落とさない（取りこぼしを作らない）', () => {
  const extraction = makeExtraction(DATES);
  extraction.messages[0].timestamp = { attributes: {} };
  const model = normalize(extraction, { kind: 'channel', capturedAt: CAPTURED_AT }, {
    patterns: selectors.patterns,
    since: '2026-07-01T00:00:00+09:00',
  });
  assert.equal(model.stats.messageCount, 3, '日時不明のメッセージが落ちている');
});

test('解釈できない since は黙って無視せず警告する', () => {
  const model = buildModel(DATES, { since: 'きのう' });
  assert.equal(model.stats.messageCount, 3);
  assert.ok(model.warnings.some((w) => w.code === 'since-unparsed'));
});

test('取得範囲を絞ったことがフロントマターに残る', () => {
  const md = renderMarkdown(buildModel(DATES, { since: '2026-07-01T00:00:00+09:00' }));
  assert.match(md, /^range_since: "2026-07-01T00:00:00\+09:00"$/m);
  assert.match(md, /^out_of_range_excluded: 1$/m);
});

/* ---- スクロールの打ち切り ------------------------------------------- */

const channelBlocks = loadCollectedSamples('channel')
  .flatMap((s) => Array.from(s.root.querySelectorAll("[data-tid='channel-pane-message']")))
  .map((el) => el.outerHTML);

/** 全ページが最初から DOM にある単純なペイン（stopBefore の判定だけを見たいので） */
function makePane(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="pane">${html}</div></body>`);
  const pane = dom.window.document.getElementById('pane');
  Object.defineProperty(pane, 'clientHeight', { get: () => 500 });
  Object.defineProperty(pane, 'scrollHeight', { get: () => 500 });
  return pane;
}

const noWait = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })() };

/**
 * かつて stopBefore は <time> の datetime 属性しか見ておらず、
 * **その属性を持たないチャネルでは常に無反応**だった（設定しても全件遡ってしまう）。
 * 正規化と同じ日時解釈を通すようにしたので、チャネルでも効く。
 */
test('チャネルでも stopBefore で打ち切れる（datetime 属性が無くても効く）', async () => {
  const pane = makePane(channelBlocks.slice(0, 6).join('\n'));
  const result = await collectByScrolling(pane, selectors, {
    ...noWait,
    profile: 'channel',
    capturedAt: CAPTURED_AT,
    stopBefore: '2030-01-01T00:00:00+09:00', // サンプルより必ず新しい＝即座に到達する
  });

  assert.equal(result.stats.stopReason, 'stop-before-reached');
  assert.equal(result.truncated, false, '範囲まで取れたのだから truncated ではない');
});

test('stopBefore に達しなければ通常どおり先頭まで遡る', async () => {
  const pane = makePane(channelBlocks.slice(0, 6).join('\n'));
  const result = await collectByScrolling(pane, selectors, {
    ...noWait,
    profile: 'channel',
    capturedAt: CAPTURED_AT,
    stopBefore: '2000-01-01T00:00:00+09:00',
  });

  assert.equal(result.stats.stopReason, 'reached-top');
  assert.equal(result.truncated, false);
});
