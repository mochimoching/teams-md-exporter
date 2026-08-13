/**
 * コンソール貼り付け用スクリプト（dist/teams-collect-console.js）の検証。
 *
 * import/export を外して連結する変換で壊れていないかを、実 DOM サンプルを流し込んで確かめる。
 * ブラウザで貼る前にここで落とすのが目的なので、実際に eval して動かす。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

import { loadCollectedSamples, repoRoot } from './fixtures.js';

const distFile = path.join(repoRoot, 'dist', 'teams-collect-console.js');

// 常に最新の src / selectors.json から作り直してから検証する
execFileSync(process.execPath, [path.join(repoRoot, 'tools', 'build-console-script.js')], { cwd: repoRoot });
const script = fs.readFileSync(distFile, 'utf8');

/** 会話ペインを持つ最小のページを作り、コンソール貼り付けと同じように eval する */
async function runScript(paneHtml, { paneTid = 'channel-pane-viewport', globals = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><div data-tid="${paneTid}" id="pane">${paneHtml}</div></body>`,
    { runScripts: 'outside-only', url: 'https://teams.microsoft.com/v2/' },
  );
  const { window } = dom;
  const pane = window.document.getElementById('pane');
  Object.defineProperty(pane, 'clientHeight', { get: () => 500 });
  Object.defineProperty(pane, 'scrollHeight', { get: () => 500 });

  const logs = [];
  const tables = [];
  const downloads = [];
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function stubClick() { downloads.push(this.download); };
  window.console = {
    log: (...args) => logs.push(args.map(String).join(' ')),
    warn: (...args) => logs.push(`WARN ${args.map(String).join(' ')}`),
    error: (...args) => logs.push(`ERROR ${args.map(String).join(' ')}`),
    table: (obj) => tables.push(obj),
  };
  Object.assign(window, globals);

  await window.eval(script);
  // 入口は async IIFE なので、マイクロタスクが片付くまで待つ
  for (let i = 0; i < 50 && !window.TEAMS_RESULT && !logs.some((l) => l.startsWith('ERROR')); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { window, logs, tables, downloads, model: window.TEAMS_RESULT, files: window.TEAMS_FILES };
}

test('ビルドしたスクリプトが構文的に正しく、名前の衝突もない', () => {
  // ビルド時に重複検出で例外を投げるので、ここまで来ていれば衝突なし
  assert.ok(script.includes('function collectByScrolling'));
  assert.ok(script.includes('function extractConversation'));
  assert.ok(!/^import /m.test(script), 'import 文が残っている');
  assert.ok(!/^export /m.test(script), 'export 文が残っている');
  new Function(script); // 構文エラーならここで落ちる
});

test('チャネルの実 DOM を流し込むと、収集して結果サマリを出す', async () => {
  const html = loadCollectedSamples('channel')[1].root.innerHTML;
  const { logs, tables, model } = await runScript(html);

  assert.ok(model, `モデルが作られていない: ${logs.join(' / ')}`);
  assert.equal(model.source.kind, 'channel');
  assert.ok(model.messages.length > 0);
  assert.ok(model.messages.every((m) => m.author && m.timestamp));
  assert.match(model.source.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.ok(model.stats.scroll.stopReason, '停止理由が記録されていない');

  assert.ok(logs.some((l) => l.includes('収集開始')));
  assert.ok(tables.length > 0, 'サマリの表が出ていない');
  assert.ok(logs.some((l) => l.includes('window.TEAMS_RESULT')));
});

test('Markdown ファイルが組み立てられ、保存まで走る', async () => {
  const html = loadCollectedSamples('channel')[1].root.innerHTML;
  const { files, downloads } = await runScript(html);

  assert.ok(files && files.length > 0, 'Markdown が作られていない');
  assert.match(files[0].filename, /^teams_channel_.*\.md$/);
  assert.match(files[0].content, /^---\n/);
  assert.match(files[0].content, /^## \d{4}-\d{2}-\d{2} \([日月火水木金土]\)$/m);
  // files は jsdom 側の配列なので、比較する前に素の配列へ揃える
  assert.deepEqual(downloads, Array.from(files, (f) => f.filename));
});

test('window.TEAMS_SAVE_MD = false なら保存しない', async () => {
  const html = loadCollectedSamples('channel')[1].root.innerHTML;
  const { files, downloads } = await runScript(html, { globals: { TEAMS_SAVE_MD: false } });
  assert.ok(files.length > 0);
  assert.deepEqual(downloads, []);
});

test('チャットの実 DOM でもプロファイルを自動判定して収集する', async () => {
  const html = loadCollectedSamples('chat')[0].root.innerHTML;
  const { model, logs } = await runScript(html, { paneTid: 'message-pane-list-viewport' });

  assert.ok(model, `モデルが作られていない: ${logs.join(' / ')}`);
  assert.equal(model.source.kind, 'chat');
  assert.ok(model.messages.length > 0);
  assert.ok(model.messages.every((m) => m.author && m.timestamp));
});

test('会話ペインが無いページでは、黙って終わらずエラーを表示する', async () => {
  const { logs, model } = await runScript('<div>会話ではない画面</div>', { paneTid: 'not-a-pane' });
  assert.equal(model, undefined);
  assert.ok(logs.some((l) => l.startsWith('ERROR') && l.includes('会話ペインが見つかりません')));
});

test('window.TEAMS_COLLECT で上限を上書きできる', async () => {
  const html = loadCollectedSamples('channel')[1].root.innerHTML;
  const { model } = await runScript(html, { globals: { TEAMS_COLLECT: { maxSteps: 1 } } });
  assert.equal(model.stats.scroll.steps, 1);
  assert.equal(model.stats.scroll.stopReason, 'max-steps');
  assert.equal(model.stats.truncated, true);
});
