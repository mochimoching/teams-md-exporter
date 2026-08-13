/**
 * ユーザースクリプト（dist/teams-md-exporter.user.js）の検証。
 *
 * 実 DOM サンプルを載せたページで実際に読み込み、ボタンを押して収集〜保存まで走らせる。
 * ブラウザに入れる前にここで落とすのが目的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

import { loadCollectedSamples, repoRoot } from './fixtures.js';

const distFile = path.join(repoRoot, 'dist', 'teams-md-exporter.user.js');

// 常に最新の src / selectors.json / UI から作り直してから検証する
execFileSync(process.execPath, [path.join(repoRoot, 'tools', 'build-userscript.js')], { cwd: repoRoot });
const script = fs.readFileSync(distFile, 'utf8');

/**
 * 会話ペインを持つ最小のページでユーザースクリプトを読み込む。
 *
 * UI 版は「ボタンの click ハンドラ」で走るため、コンソール版のように戻り値の Promise を
 * await できない。待ち時間を実際に待つと遅いので、scroll-driver の sleep を差し替えて
 * マイクロタスクだけで進むようにしている（sleep 注入はドライバが元から持つ口）。
 */
function mount(paneHtml, { paneTid = 'channel-pane-viewport', globals = {} } = {}) {
  const collect = { sleep: () => Promise.resolve(), ...(globals.TEAMS_COLLECT || {}) };
  globals = { ...globals, TEAMS_COLLECT: collect };
  const dom = new JSDOM(
    `<!doctype html><body><div data-tid="${paneTid}" id="pane">${paneHtml}</div></body>`,
    { runScripts: 'outside-only', url: 'https://teams.microsoft.com/v2/' },
  );
  const { window } = dom;
  const pane = window.document.getElementById('pane');
  Object.defineProperty(pane, 'clientHeight', { get: () => 500 });
  Object.defineProperty(pane, 'scrollHeight', { get: () => 500 });

  const downloads = [];
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function stubClick() { downloads.push(this.download); };
  Object.assign(window, globals);

  // Teams は Trusted Types を有効にしていて innerHTML への代入が拒否される。
  // 実機で UI が出なかった原因なので、同じ条件を作って再発を防ぐ。
  const errors = [];
  window.console.error = (...args) => errors.push(args.map(String).join(' '));
  for (const proto of [window.Element.prototype, window.ShadowRoot.prototype]) {
    Object.defineProperty(proto, 'innerHTML', {
      configurable: true,
      get() { return ''; },
      set() { throw new TypeError("Failed to set the 'innerHTML' property: This document requires 'TrustedHTML' assignment."); },
    });
  }

  window.eval(script);
  const host = window.document.getElementById('teams-md-exporter');
  return { window, downloads, errors, host, ui: host && host.shadowRoot };
}

/** UI の表示が落ち着くまで待つ（収集は非同期） */
async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`待っても起きなかった: ${label}`);
}

const channelHtml = () => loadCollectedSamples('channel')[1].root.innerHTML;

test('ユーザースクリプトのヘッダが正しく、構文的にも問題ない', () => {
  assert.match(script, /^\/\/ ==UserScript==$/m);
  assert.match(script, /^\/\/ @match\s+https:\/\/teams\.microsoft\.com\/\*$/m);
  assert.match(script, /^\/\/ @grant\s+none$/m);
  assert.match(script, /^\/\/ ==\/UserScript==$/m);
  assert.ok(!/^import /m.test(script), 'import 文が残っている');
  assert.ok(!/^export /m.test(script), 'export 文が残っている');
  new Function(script); // 構文エラー・名前の衝突はここで落ちる
});

test('innerHTML を使っていない（Trusted Types 環境でも UI が出る）', () => {
  assert.ok(!/\.innerHTML\s*=/.test(script), 'innerHTML への代入が残っている');
  const { host, ui, errors } = mount(channelHtml());
  assert.ok(host, `UI が差し込まれていない: ${errors.join(' / ')}`);
  assert.ok(ui.querySelector('.run'), '実行ボタンが無い');
  assert.deepEqual(errors, []);
});

test('読み込んだだけでは何も収集しない（勝手に走らない）', async () => {
  const { window, downloads, ui } = mount(channelHtml());
  assert.ok(ui, 'UI が差し込まれていない');
  assert.ok(ui.querySelector('.run'), '実行ボタンが無い');

  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.TEAMS_RESULT, undefined, '押していないのに収集が走っている');
  assert.deepEqual(downloads, []);
});

test('ボタンを押すと収集して Markdown を保存し、結果を表示する', async () => {
  const { window, downloads, ui } = mount(channelHtml());
  ui.querySelector('.run').click();
  await waitFor(() => window.TEAMS_RESULT, '収集の完了');

  const model = window.TEAMS_RESULT;
  assert.equal(model.source.kind, 'channel');
  assert.ok(model.messages.length > 0);
  assert.ok(model.messages.every((m) => m.author && m.timestamp));
  assert.deepEqual(downloads, Array.from(window.TEAMS_FILES, (f) => f.filename));

  await waitFor(() => !ui.querySelector('.result').hidden, '結果の表示');
  const text = ui.querySelector('.result').textContent;
  assert.match(text, new RegExp(`${model.stats.messageCount} 件を保存しました`));
  assert.match(text, /teams_channel_.*\.md/);
  assert.equal(ui.querySelector('.run').disabled, false, '実行後にボタンが戻っていない');
});

test('チャットでもプロファイルを自動判定する', async () => {
  const html = loadCollectedSamples('chat')[0].root.innerHTML;
  const { window, ui } = mount(html, { paneTid: 'message-pane-list-viewport' });
  ui.querySelector('.run').click();
  await waitFor(() => window.TEAMS_RESULT, '収集の完了');
  assert.equal(window.TEAMS_RESULT.source.kind, 'chat');
});

test('会話ペインが無ければ、黙って終わらず UI にエラーを出す', async () => {
  const { window, downloads, ui } = mount('<div>会話ではない画面</div>', { paneTid: 'not-a-pane' });
  ui.querySelector('.run').click();
  await waitFor(() => !ui.querySelector('.result').hidden, 'エラーの表示');

  assert.match(ui.querySelector('.result').textContent, /エラー: 会話ペインが見つかりません/);
  assert.equal(window.TEAMS_RESULT, undefined);
  assert.deepEqual(downloads, []);
});

test('window.TEAMS_COLLECT で上限を上書きでき、打ち切りは truncated として出る', async () => {
  const { window, ui } = mount(channelHtml(), { globals: { TEAMS_COLLECT: { maxSteps: 1 } } });
  ui.querySelector('.run').click();
  await waitFor(() => window.TEAMS_RESULT, '収集の完了');

  assert.equal(window.TEAMS_RESULT.stats.scroll.stopReason, 'max-steps');
  assert.equal(window.TEAMS_RESULT.stats.truncated, true);
  await waitFor(() => !ui.querySelector('.result').hidden, '結果の表示');
  assert.match(ui.querySelector('.result').textContent, /会話の全体ではありません/);
});

test('二重に読み込んでも UI は 1 つだけ', () => {
  const { window } = mount(channelHtml());
  window.eval(script);
  assert.equal(window.document.querySelectorAll('#teams-md-exporter').length, 1);
});
