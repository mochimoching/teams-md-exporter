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
    let selectFallbackReason = null;
    let selectionMeta = null;
    if (!target.current) {
      try {
        selectionMeta = await selectConversation(page, target);
      } catch (error) {
        const currentThreadId = await getCurrentThreadId(page);
        if (currentThreadId && currentThreadId === target.threadId) {
          selectFallbackReason = `左一覧の選択は失敗したため、現在開いている会話（threadId 一致: ${currentThreadId}）を使用しました`;
          log(selectFallbackReason);
        } else {
          throw error;
        }
      }
    }
    await page.waitForTimeout(config.settleMs);

    const options = {
      ...config.collect,
      ...(target.collect || {}),
      stopBefore: since,
      includeSystem: target.includeSystem === true,
      titleFallback: {
        targetName: target.name || null,
        displayName: target.displayName || null,
        listText: selectionMeta && selectionMeta.listText ? selectionMeta.listText : null,
      },
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
    if (selectFallbackReason) reasons.unshift(selectFallbackReason);

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

  const candidates = buildConversationSelectors(templates, target.threadId);
  await waitForConversationListHydration(page, nav);

  const fromCandidates = await trySelectByCandidates(page, candidates, target.threadId);
  if (fromCandidates) return fromCandidates;

  const desiredView = desiredAppViewForThread(target.threadId);
  if (desiredView) {
    const switched = await switchConversationAppView(page, desiredView, nav);
    if (switched) {
      await waitForConversationListHydration(page, nav);
      const fromSwitched = await trySelectByCandidates(page, candidates, target.threadId);
      if (fromSwitched) return fromSwitched;
    }
  }

  if (target.displayName) {
    const byName = await clickConversationByName(page, target.displayName, target.threadId);
    if (byName) return byName;
    const bySearch = await searchConversationAndSelect(page, target, candidates, nav);
    if (bySearch) return bySearch;
  }

  const debug = await collectConversationListDebug(page, target.threadId);
  throw new Error([
    `左の一覧に会話 ${target.threadId} が見つかりませんでした（一覧に表示されている必要があります）`,
    `試行セレクタ数: ${candidates.length}`,
    `左一覧の data-fui-tree-item-value: 合計=${debug.total}, 一意=${debug.unique}, 完全一致=${debug.hasExact ? 'あり' : 'なし'}, 部分一致=${debug.contains.length}`,
    debug.contains.length > 0 ? `部分一致サンプル: ${debug.contains.join(' | ')}` : '',
  ].filter(Boolean).join(' / '));
}

async function trySelectByCandidates(page, candidates, threadId) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    for (const selector of candidates) {
      // 先に visible を優先する。仮想リストで非表示ノードが混ざるため。
      const visible = page.locator(`${selector}:visible`).first();
      if (await visible.count() > 0) {
        const listText = simplifyListText(await visible.textContent().catch(() => null));
        if (await clickAndConfirm(page, visible, threadId)) return { listText };
      }

      const item = page.locator(selector).first();
      if (await item.count() > 0) {
        const listText = simplifyListText(await item.textContent().catch(() => null));
        if (await clickAndConfirm(page, item, threadId)) return { listText };
      }
    }

    if (attempt < 5) await page.waitForTimeout(800);
  }
  return null;
}

function desiredAppViewForThread(threadId) {
  const id = String(threadId || '');
  if (id.includes('@thread.tacv2') || id.includes('@thread.skype')) return 'teams';
  if (id.includes('@thread.v2') || id.includes('@unq.gbl.spaces')) return 'chat';
  return null;
}

async function clickAndConfirm(page, locator, threadId) {
  await locator.click();
  return waitForTargetThread(page, threadId, 5000);
}

async function waitForTargetThread(page, threadId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await getCurrentThreadId(page);
    if (current === threadId) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function switchConversationAppView(page, view, nav) {
  const selectors = view === 'teams'
    ? selectorList(nav.appSwitchTeamsButton)
    : selectorList(nav.appSwitchChatButton);

  const defaultByAria = view === 'teams'
    ? [
        "button[aria-label*='チーム (Ctrl+Shift+3)']",
        "button[aria-label*='Teams (Ctrl+Shift+3)']",
      ]
    : [
        "button[aria-label*='チャット (Ctrl+Shift+2)']",
        "button[aria-label*='Chat (Ctrl+Shift+2)']",
      ];

  for (const selector of [...new Set([...selectors, ...defaultByAria])]) {
    const button = page.locator(`${selector}:visible`).first();
    if (await button.count() === 0) continue;
    try {
      await button.click({ timeout: 2500 });
      await page.waitForTimeout(1500);
      return true;
    } catch {
      continue;
    }
  }

  // 最後の保険。ショートカットは Teams の既定に依存するため、クリック候補が無い場合のみ使う。
  try {
    await page.keyboard.press(view === 'teams' ? 'Control+Shift+3' : 'Control+Shift+2');
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

function buildConversationSelectors(templates, threadId) {
  const escaped = cssEscape(threadId);
  const rendered = templates.map((t) => t.replace('{threadId}', escaped));
  const fallback = [
    `[data-fui-tree-item-value="${escaped}"]`,
    `[data-fui-tree-item-value$="|${escaped}"]`,
    `[data-fui-tree-item-value*="${escaped}"]`,
  ];
  return [...new Set([...rendered, ...fallback])];
}

async function clickConversationByName(page, displayName, threadId) {
  const candidate = page.locator(`[data-fui-tree-item-value]:visible`, {
    hasText: displayName,
  }).first();
  if (await candidate.count() > 0) {
    const listText = simplifyListText(await candidate.textContent().catch(() => null));
    if (await clickAndConfirm(page, candidate, threadId)) return { listText };
  }

  // テキストを持つコンテナ側に data-fui-tree-item-value が付いていない場合の保険。
  const fallback = page.locator(`:is([role='treeitem'], [role='listitem'], [data-fui-tree-item-value]):visible`, {
    hasText: displayName,
  }).first();
  if (await fallback.count() > 0) {
    const listText = simplifyListText(await fallback.textContent().catch(() => null));
    if (await clickAndConfirm(page, fallback, threadId)) return { listText };
  }
  return null;
}

async function searchConversationAndSelect(page, target, candidates, nav) {
  const searchInputs = selectorList(nav.conversationSearchInput);
  if (searchInputs.length === 0) return false;
  const selectorsToTry = [...new Set(searchInputs)];

  for (const inputSelector of selectorsToTry) {
    const input = page.locator(inputSelector).first();
    if (await input.count() === 0) continue;

    try {
      await input.click({ timeout: 2000 });
      await input.fill(target.displayName);
      await input.press('Enter');
      await page.waitForTimeout(1500);

      await waitForConversationListHydration(page, nav);

      for (const selector of candidates) {
        const visible = page.locator(`${selector}:visible`).first();
        if (await visible.count() > 0) {
          await visible.click();
          return true;
        }
      }

      const byName = await clickConversationByName(page, target.displayName, target.threadId);
      if (byName) return byName;
    } catch {
      // 入力欄の性質が画面状態で変わることがあるため、次候補を試す。
      continue;
    }
  }

  return null;
}

async function waitForConversationListHydration(page, nav) {
  const readySelectors = selectorList(nav.conversationListReady).length > 0
    ? selectorList(nav.conversationListReady)
    : ["[data-fui-tree-item-value]", "[role='treeitem']", "[role='listitem']"];

  const timeoutMs = Number.isFinite(nav.conversationListReadyTimeoutMs)
    ? Math.max(0, nav.conversationListReadyTimeoutMs)
    : 10000;

  try {
    await page.waitForFunction(
      (selectorsIn) => selectorsIn.some((selector) => document.querySelector(selector)),
      readySelectors,
      { timeout: timeoutMs },
    );
  } catch {
    // 描画待ちに失敗しても探索は続行し、最終エラーに診断情報を含める。
  }
}

async function collectConversationListDebug(page, threadId) {
  return page.evaluate((id) => {
    const values = Array.from(document.querySelectorAll('[data-fui-tree-item-value]'))
      .map((n) => n.getAttribute('data-fui-tree-item-value'))
      .filter(Boolean);
    const unique = [...new Set(values)];
    return {
      total: values.length,
      unique: unique.length,
      hasExact: unique.includes(id),
      contains: unique.filter((v) => v.includes(id)).slice(0, 5),
    };
  }, threadId);
}

async function getCurrentThreadId(page) {
  const hosts = [
    ...selectorList(selectors.profiles.channel.conversationIdHost),
    ...selectorList(selectors.profiles.chat.conversationIdHost),
  ];
  const attr = selectors.profiles.channel.conversationIdAttr || selectors.profiles.chat.conversationIdAttr || 'data-track-thread-id';
  if (hosts.length === 0) return null;

  return page.evaluate(({ hostsIn, attrIn }) => {
    const values = hostsIn
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.getAttribute(attrIn)))
      .filter(Boolean);
    const unique = [...new Set(values)];
    return unique.length === 1 ? unique[0] : null;
  }, { hostsIn: hosts, attrIn: attr });
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

function simplifyListText(text) {
  if (!text) return null;
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  const cleaned = oneLine.replace(/^未読です\s*/, '');
  return cleaned.slice(0, 120);
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
