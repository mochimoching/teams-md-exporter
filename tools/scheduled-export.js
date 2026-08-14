/**
 * スケジュール実行（Playwright 版 / 仕様書 §7.1「補助方式B」）。
 *
 *   node tools/scheduled-export.js [設定ファイル]
 *   → 設定した会話を順に開いて収集し、Markdown をフォルダへ書き出す
 *
 * 認証について（CLAUDE.md 原則2）:
 *   ID / パスワード / トークンは一切保存しない。**人が一度ログインしたブラウザプロファイル**を
 *   再利用するだけ。ログインは tools/scheduled-login.js で人が行う。
 *   セッションが切れていたら自動ログインは試みず、理由を出して異常終了する。
 *
 * 収集そのものは dist/teams-collect-console.js（＝ユーザースクリプトと同じ中身）を
 * ページに流し込んで行う。抽出ロジックはブラウザ内実行と完全に同じもの。
 *
 * アクセスは低頻度・逐次（仕様書 §7.1）。会話ごとに待ちを入れ、並列化はしない。
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { repoRoot } from './bundle.js';
import {
  buildRunRecord,
  classifyRun,
  exitCodeFor,
  normalizeConfig,
  resolveSince,
  summarize,
  updateState,
} from './schedule-core.js';

const configPath = path.resolve(process.argv[2] || path.join(repoRoot, 'schedule.config.json'));

if (!fs.existsSync(configPath)) {
  fail(`設定ファイルがありません: ${configPath}\n  docs/scheduled.md の例をもとに作成してください`);
}

const config = loadConfig(configPath);
const selectors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8'));
const collectorScript = readCollector();

const stateFile = path.resolve(config.stateFile || path.join(path.dirname(configPath), 'schedule.state.json'));
const logFile = path.resolve(config.logFile || path.join(path.dirname(configPath), 'schedule.log.jsonl'));

await main();

async function main() {
  fs.mkdirSync(path.resolve(config.outDir), { recursive: true });

  let state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  const records = [];

  const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
    channel: config.browserChannel || 'chrome',
    headless: config.headless === true,
    viewport: null,
    args: ['--start-maximized'],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[teams-md]')) log(text);
    });

    await openTeams(page);

    for (const [index, target] of config.targets.entries()) {
      if (index > 0) await page.waitForTimeout(config.betweenTargetsMs);

      const startedAt = new Date().toISOString();
      const since = resolveSince(target, state, config.overlapMinutes);
      log(`--- ${target.name}（${target.mode}${since ? ` / ${since} 以降` : ' / 全件'}）`);

      const result = await runTarget(page, target, since);
      const record = buildRunRecord(target, startedAt, new Date().toISOString(), since, result);

      if (result.files && result.files.length > 0) writeFiles(result.files);
      records.push(record);
      state = updateState(state, target, record);

      writeJson(stateFile, state);
      fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
    }
  } finally {
    await context.close();
  }

  log('');
  log(summarize(records));
  log(`実行ログ: ${logFile}`);
  process.exit(exitCodeFor(records));
}

/** Teams を開き、ログイン済みであることを確かめる。切れていたら自動ログインは試みない */
async function openTeams(page) {
  log(`Teams を開いています（プロファイル: ${config.profileDir}）`);
  await page.goto(config.teamsUrl || 'https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' });

  const paneSelector = selectorList(selectors.profiles.channel.conversationPane)
    .concat(selectorList(selectors.profiles.chat.conversationPane))
    .join(', ');

  try {
    await page.waitForSelector(paneSelector, { timeout: config.loginTimeoutMs || 60000 });
  } catch {
    fail([
      'Teams の会話画面が出ませんでした。ログインが切れている可能性があります。',
      '  自動ログインは行いません（CLAUDE.md 原則2）。次を実行して、人の手でログインし直してください:',
      '    node tools/scheduled-login.js',
    ].join('\n'));
  }
  log('ログイン済みを確認しました');
}

/** 1 会話ぶん: 会話を開く → 収集スクリプトを流し込む → 結果を受け取る */
async function runTarget(page, target, since) {
  try {
    if (!target.current) await selectConversation(page, target);
    await page.waitForTimeout(config.settleMs);

    const options = {
      ...config.collect,
      ...(target.collect || {}),
      stopBefore: since,
      includeSystem: target.includeSystem === true,
    };

    await page.evaluate((opts) => {
      window.TEAMS_SAVE_MD = false; // ダウンロードさせず、Node 側で保存する
      window.TEAMS_RESULT = undefined;
      window.TEAMS_FILES = undefined;
      window.TEAMS_COLLECT = opts;
    }, options);

    await page.evaluate(collectorScript);
    await page.waitForFunction(() => window.TEAMS_RESULT !== undefined, null, { timeout: config.timeoutMs });

    const model = await page.evaluate(() => window.TEAMS_RESULT);
    const files = (await page.evaluate(() => window.TEAMS_FILES)) || [];
    const { status, reasons } = classifyRun(model);

    // 新着が無いときは空ファイルを作らない（差分取得では正常な結果）
    return { status, reasons, model, files: status === 'empty' ? [] : files };
  } catch (error) {
    return { status: 'failed', reasons: [], model: null, files: [], error: error.message };
  }
}

/**
 * 左の一覧から対象の会話を選ぶ。
 * セレクタは selectors.json の navigation に外だししてある（コードに書かない）。
 */
async function selectConversation(page, target) {
  const nav = selectors.navigation || {};
  const templates = selectorList(nav.conversationListItem);
  if (templates.length === 0) {
    throw new Error('selectors.json の navigation.conversationListItem が未設定のため、会話を選べません（target に current: true を指定すれば、開いている会話をそのまま取れます）');
  }

  const candidates = templates.map((t) => t.replace('{threadId}', cssEscape(target.threadId)));
  for (const selector of candidates) {
    const item = page.locator(selector).first();
    if (await item.count() === 0) continue;
    await item.click();
    return;
  }
  throw new Error(`左の一覧に会話 ${target.threadId} が見つかりませんでした（一覧に表示されている必要があります）`);
}

/* ---- 小物 ----------------------------------------------------------- */

/** 設定の不備はスタックトレースではなく、直し方が分かる文言で落とす */
function loadConfig(file) {
  try {
    return normalizeConfig(readJson(file));
  } catch (error) {
    fail(`設定ファイル ${file} に問題があります:\n  ${error.message}`);
    return null;
  }
}

function readCollector() {
  const file = path.join(repoRoot, 'dist', 'teams-collect-console.js');
  if (!fs.existsSync(file)) fail(`${file} がありません。先に npm run build を実行してください`);
  return fs.readFileSync(file, 'utf8');
}

function writeFiles(files) {
  for (const file of files) {
    const outPath = path.join(path.resolve(config.outDir), file.filename);
    fs.writeFileSync(outPath, file.content, 'utf8');
    log(`保存: ${outPath}`);
  }
}

function selectorList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter((s) => typeof s === 'string' && s !== '');
}

/** 属性セレクタに埋め込むためのエスケープ（会話 ID に ':' や '@' が含まれる） */
function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file} を読めません: ${error.message}`);
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function log(message) {
  console.log(`[teams-md-schedule] ${message}`);
}

function fail(message) {
  console.error(`[teams-md-schedule] ${message}`);
  process.exit(1);
}
