/**
 * 会話名（画面のタイトルから取り出す）と、それを使ったファイル名。
 *
 * タイトルの実測値は 2026-08-13 に実機のコンソールで採取したもの。
 * 先頭のセクション名も末尾のアプリ名も UI 言語依存なので、位置で落としていることを確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, parseConversationTitle, resolveConversationTitle } from '../src/normalize.js';
import { buildFilename } from '../src/markdown-renderer.js';
import { loadSelectors } from './fixtures.js';

const selectors = loadSelectors();
const config = selectors.conversationTitle;

const CHANNEL_TITLE = '(3) チームとチャネル | DTS | 911_プロパー(星野PL-R＆D) | Microsoft Teams';
const CHAT_TITLE = '(3) チャット | ベトナム案件-DTSメンバのみ | Microsoft Teams';

test('チャネルのタイトルからチーム名とチャネル名を取り出す', () => {
  const result = parseConversationTitle(CHANNEL_TITLE, config, 'channel');
  assert.equal(result.team, 'DTS');
  assert.equal(result.channel, '911_プロパー(星野PL-R＆D)');
  assert.deepEqual(result.warnings, []);
});

test('チャットのタイトルからチャット名を取り出す', () => {
  const result = parseConversationTitle(CHAT_TITLE, config, 'chat');
  assert.equal(result.chatTitle, 'ベトナム案件-DTSメンバのみ');
  assert.equal(result.team, null);
  assert.deepEqual(result.warnings, []);
});

test('未読数が付いていなくても同じ結果になる', () => {
  const result = parseConversationTitle(CHANNEL_TITLE.replace('(3) ', ''), config, 'channel');
  assert.equal(result.team, 'DTS');
  assert.equal(result.channel, '911_プロパー(星野PL-R＆D)');
});

test('会話名に区切り文字が含まれていても失わない', () => {
  const result = parseConversationTitle('チャット | A | B | Microsoft Teams', config, 'chat');
  assert.equal(result.chatTitle, 'A | B');
});

test('会話を開いていないなど取り出せない場合は、埋めずに info を出す', () => {
  const result = parseConversationTitle('Microsoft Teams', config, 'channel');
  assert.equal(result.team, null);
  assert.equal(result.channel, null);
  assert.equal(result.warnings[0].code, 'conversation-title-unparsed');
});

/* ---- 候補が複数あるとき ----------------------------------------------- */

/**
 * 実機で観測した状況（2026-08-13）。ボタンを押した時点ではタイトルに会話名がまだ入っておらず、
 * 収集が終わったあとに入った。開始時の値だけを見ていたため会話名を取り逃していた。
 */
test('開始時のタイトルに会話名が無ければ、終了時のタイトルで補う', () => {
  const result = resolveConversationTitle(
    ['(3) Planner | Microsoft Teams', '(3) Planner | ベトナム案件-DTSメンバのみ | Microsoft Teams'],
    config,
    'chat',
  );
  assert.equal(result.chatTitle, 'ベトナム案件-DTSメンバのみ');
  assert.deepEqual(result.warnings, []);
});

test('両方で取れる場合は開始時のほうを採用する（収集開始時点の会話を正とする）', () => {
  const result = resolveConversationTitle(
    ['チャット | 収集した会話 | Microsoft Teams', 'チャット | あとで開いた別の会話 | Microsoft Teams'],
    config,
    'chat',
  );
  assert.equal(result.chatTitle, '収集した会話');
});

test('どの候補でも取れなければ、試した値を並べて警告する', () => {
  const result = resolveConversationTitle(['Microsoft Teams', '(3) Planner | Microsoft Teams'], config, 'chat');
  assert.equal(result.chatTitle, null);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'conversation-title-unparsed');
  assert.match(result.warnings[0].detail, /「Microsoft Teams」/);
  assert.match(result.warnings[0].detail, /「\(3\) Planner \| Microsoft Teams」/);
});

/* ---- ファイル名まで --------------------------------------------------- */

const emptyExtraction = { profile: 'channel', boxes: [], warnings: [], messages: [] };

function filenameFor(profile, title) {
  const parsed = parseConversationTitle(title, config, profile);
  const model = normalize(emptyExtraction, {
    kind: profile,
    capturedAt: '2026-08-13T18:30:00+09:00',
    team: parsed.team,
    channel: parsed.channel,
    chatTitle: parsed.chatTitle,
  }, { patterns: selectors.patterns });
  return buildFilename(model);
}

test('ファイル名にチャネル名が入る', () => {
  assert.equal(filenameFor('channel', CHANNEL_TITLE), 'teams_channel_DTS-911_プロパー(星野PL-R＆D)_20260813-1830.md');
});

test('ファイル名にチャット名が入る', () => {
  assert.equal(filenameFor('chat', CHAT_TITLE), 'teams_chat_ベトナム案件-DTSメンバのみ_20260813-1830.md');
});

test('会話名が取れなければ従来どおりの既定名になる（ファイル名を壊さない）', () => {
  assert.equal(filenameFor('channel', 'Microsoft Teams'), 'teams_channel_チャネル_20260813-1830.md');
});
