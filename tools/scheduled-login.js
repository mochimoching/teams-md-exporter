/**
 * スケジュール実行用プロファイルへのログイン（人が行う / 仕様書 §7.1）。
 *
 *   node tools/scheduled-login.js [設定ファイル]
 *   → ブラウザが開くので、**画面上で自分でログインする**。会話画面が出たら自動で閉じる。
 *
 * このスクリプトは ID / パスワード / MFA を一切扱わない（CLAUDE.md 原則2・「やらないこと」）。
 * 行うのはブラウザを開いて待つことだけ。認証結果はブラウザのプロファイルに残り、
 * 以後 scheduled-export.js がそれを再利用する。
 *
 * セッションは組織の設定（条件付きアクセス等）でいずれ切れる。切れたらこれを実行し直す。
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { repoRoot } from './bundle.js';
import { normalizeConfig } from './schedule-core.js';

const configPath = path.resolve(process.argv[2] || path.join(repoRoot, 'schedule.config.json'));
if (!fs.existsSync(configPath)) {
  console.error(`[teams-md-login] 設定ファイルがありません: ${configPath}`);
  console.error('  docs/scheduled.md の例をもとに作成してください');
  process.exit(1);
}

let config;
try {
  config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
} catch (error) {
  console.error(`[teams-md-login] 設定ファイル ${configPath} に問題があります:`);
  console.error(`  ${error.message}`);
  process.exit(1);
}

const selectors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8'));
const waitMs = config.loginWaitMs || 10 * 60 * 1000;

const paneSelector = [selectors.profiles.channel.conversationPane, selectors.profiles.chat.conversationPane]
  .flatMap((v) => (Array.isArray(v) ? v : [v]))
  .filter(Boolean)
  .join(', ');

console.log('[teams-md-login] ブラウザを開きます。表示された画面で、ご自身でログインしてください。');
console.log(`[teams-md-login] プロファイル: ${path.resolve(config.profileDir)}`);
console.log('[teams-md-login] 「サインインしたままにする」を選んでおくと、セッションが長持ちします。');

const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
  channel: config.browserChannel || 'chrome',
  headless: false, // ログインは人が行うので必ず画面を出す
  viewport: null,
  args: ['--start-maximized'],
});

try {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(config.teamsUrl || 'https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' });

  console.log(`[teams-md-login] 会話画面が出るまで待っています（最大 ${Math.round(waitMs / 60000)} 分）…`);
  await page.waitForSelector(paneSelector, { timeout: waitMs });

  // 認証結果がプロファイルに書き終わるのを待つ
  await page.waitForTimeout(3000);
  console.log('[teams-md-login] ログインを確認しました。以後は node tools/scheduled-export.js で無人実行できます。');
} catch {
  console.error('[teams-md-login] 会話画面を確認できませんでした。ログインが完了していない可能性があります。');
  console.error('[teams-md-login] もう一度実行して、Teams の会話が表示される状態までログインしてください。');
  await context.close();
  process.exit(1);
} finally {
  await context.close().catch(() => {});
}
