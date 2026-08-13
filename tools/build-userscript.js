/**
 * Tampermonkey 等に入れるユーザースクリプトを組み立てる。
 *
 *   node tools/build-userscript.js
 *   → dist/teams-md-exporter.user.js
 *
 * 中身はコンソール貼り付け版と同じ（src/ ＋ tools/browser-runtime.js）。
 * 違いは入口だけで、コンソールに貼る代わりに画面右下のボタンから実行する。
 *
 * @grant none / @connect なし＝拡張の特権 API を一切使わない。
 * 行うのは会話ペインのスクロールと「詳細を表示」の展開だけで、ネットワークへは送信しない。
 */

import fs from 'node:fs';
import path from 'node:path';

import { bundleSources, readSelectorsJson, readVersion, repoRoot, writeDist } from './bundle.js';

const version = readVersion();
const ui = fs.readFileSync(path.join(repoRoot, 'tools', 'userscript-ui.js'), 'utf8');

const header = `// ==UserScript==
// @name         Teams 会話履歴 Markdown エクスポータ
// @namespace    https://github.com/mochimoching/teams-md-exporter
// @version      ${version}
// @description  Teams Web に表示されている会話を Markdown に書き出す。画面右下のボタンから実行する。
// @match        https://teams.microsoft.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/**
 * 自動生成: node tools/build-userscript.js（直接編集しない。src/ と tools/userscript-ui.js を直す）
 * 版: ${version} / 生成元セレクタ: selectors.json
 *
 * 動作:
 *   - ページを開いただけでは何もしない。右下のボタンを押したときだけ収集する
 *   - 行うのは会話ペインのスクロールと「詳細を表示」の展開だけ
 *   - 認証情報には触れず、ネットワークへ送信もしない（CLAUDE.md 原則1・2）
 *   - 取りこぼしは truncated と警告で必ず報告する（原則4）
 *
 * 既定では会話の先頭まで遡る。上限を変えたいときは、実行前にコンソールで:
 *   window.TEAMS_COLLECT = { maxSteps: 100, maxDurationMs: 120000 };
 * 返信スレッドも開いて取るとき（実験的・未検証）:
 *   window.TEAMS_COLLECT = { expandReplies: true };
 * 中間データ（JSON）も保存するとき:
 *   window.TEAMS_SAVE_JSON = true;
 */
`;

writeDist('teams-md-exporter.user.js', `${header}
(() => {
'use strict';
const EXPORTER_VERSION = '${version}';
const SELECTORS = ${readSelectorsJson()};

${bundleSources()}

/* ==== ユーザースクリプト用の入口（tools/userscript-ui.js） ==== */
${ui.trim()}
})();
`);
