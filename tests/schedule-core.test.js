/**
 * スケジュール実行の判断ロジック（tools/schedule-core.js）。
 *
 * 無人実行では「動いたが実は取れていない」が最悪の失敗なので、
 * 成否の判定・差分取得の起点・状態の進め方をここで固定する。
 * ブラウザを起動する部分（scheduled-export.js）は薄く保ち、判断はすべてこちらに寄せてある。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunRecord,
  classifyRun,
  exitCodeFor,
  normalizeConfig,
  resolveSince,
  summarize,
  updateState,
} from '../tools/schedule-core.js';

const BASE = {
  profileDir: 'C:/tmp/profile',
  outDir: 'C:/tmp/out',
  targets: [{ name: 'A', threadId: '19:aaa@thread.tacv2' }],
};

/* ---- 設定の検証 ------------------------------------------------------- */

test('必須項目が欠けていたら、直し方が分かる文言で落とす', () => {
  assert.throws(() => normalizeConfig({ ...BASE, profileDir: undefined }), /profileDir/);
  assert.throws(() => normalizeConfig({ ...BASE, outDir: undefined }), /outDir/);
  assert.throws(() => normalizeConfig({ ...BASE, targets: [] }), /targets/);
  assert.throws(() => normalizeConfig({ ...BASE, targets: [{ name: 'X' }] }), /threadId/);
  assert.throws(() => normalizeConfig({ ...BASE, targets: [{ threadId: '19:a', mode: 'diff' }] }), /mode/);
});

test('name の重複は弾く（状態の記録に使うため）', () => {
  const config = { ...BASE, targets: [{ name: 'A', threadId: '19:a' }, { name: 'A', threadId: '19:b' }] };
  assert.throws(() => normalizeConfig(config), /重複/);
});

test('既定値で埋まり、mode の既定は incremental', () => {
  const config = normalizeConfig(BASE);
  assert.equal(config.targets[0].mode, 'incremental');
  assert.equal(config.overlapMinutes, 60);
  assert.ok(config.betweenTargetsMs > 0, '逐次アクセスの待ちが入っていない');
});

test('current: true なら threadId は不要', () => {
  const config = normalizeConfig({ ...BASE, targets: [{ name: '開いている会話', current: true }] });
  assert.equal(config.targets[0].current, true);
});

/* ---- 差分取得の起点 --------------------------------------------------- */

const target = { name: 'A', mode: 'incremental' };

test('初回は全件（起点なし）', () => {
  assert.equal(resolveSince(target, {}, 60), null);
});

test('2 回目以降は前回実行時刻から巻き戻した時点を起点にする', () => {
  const state = { A: { lastRunAt: '2026-08-14T10:00:00.000Z' } };
  const since = resolveSince(target, state, 60);
  assert.equal(since, '2026-08-14T09:00:00.000Z');
});

test('mode: full は前回の記録があっても毎回全件', () => {
  const state = { A: { lastRunAt: '2026-08-14T10:00:00.000Z' } };
  assert.equal(resolveSince({ ...target, mode: 'full' }, state, 60), null);
});

test('壊れた前回時刻は起点にせず全件に倒す（誤った範囲で取りこぼさない）', () => {
  assert.equal(resolveSince(target, { A: { lastRunAt: 'こわれた値' } }, 60), null);
});

/* ---- 成否の判定 ------------------------------------------------------- */

const okModel = { stats: { messageCount: 12, truncated: false, replyGaps: [] }, warnings: [] };

test('取れていれば成功', () => {
  assert.equal(classifyRun(okModel).status, 'ok');
});

test('fatal があれば失敗（抽出 0 件などを成功にしない）', () => {
  const model = {
    stats: { messageCount: 0, truncated: true, replyGaps: [] },
    warnings: [{ level: 'fatal', code: 'no-messages-extracted', detail: '1 件も抽出できませんでした' }],
  };
  const result = classifyRun(model);
  assert.equal(result.status, 'failed');
  assert.match(result.reasons[0], /no-messages-extracted/);
});

test('差分取得で新着が無いのは正常（empty）', () => {
  const model = { stats: { messageCount: 0, truncated: false, replyGaps: [] }, warnings: [] };
  assert.equal(classifyRun(model).status, 'empty');
});

test('truncated は失敗にしないが、理由として必ず残す', () => {
  const model = {
    stats: { messageCount: 5, truncated: true, replyGaps: [], scroll: { stopReason: 'max-steps' } },
    warnings: [],
  };
  const result = classifyRun(model);
  assert.equal(result.status, 'ok');
  assert.match(result.reasons.join(' '), /max-steps/);
});

test('未取得の返信も理由として残す', () => {
  const model = {
    stats: { messageCount: 5, truncated: false, replyGaps: [{ declared: 10, extracted: 3 }] },
    warnings: [],
  };
  assert.match(classifyRun(model).reasons.join(' '), /返信が 7 件/);
});

test('結果そのものが取れなければ失敗', () => {
  assert.equal(classifyRun(null).status, 'failed');
});

/* ---- 状態と終了コード ------------------------------------------------- */

function record(status, at = '2026-08-14T10:00:00.000Z') {
  return buildRunRecord(
    { name: 'A', threadId: '19:a', mode: 'incremental' },
    '2026-08-14T09:59:00.000Z',
    at,
    null,
    { status, reasons: [], model: okModel, files: [{ filename: 'a.md' }] },
  );
}

test('失敗したときは前回時刻を進めない（次回に穴を空けない）', () => {
  const before = { A: { lastRunAt: '2026-08-13T10:00:00.000Z' } };
  const after = updateState(before, { name: 'A' }, record('failed'));
  assert.deepEqual(after, before);
});

test('成功・新着なしのときは前回時刻を進める', () => {
  for (const status of ['ok', 'empty']) {
    const after = updateState({}, { name: 'A', threadId: '19:a' }, record(status));
    assert.equal(after.A.lastRunAt, '2026-08-14T10:00:00.000Z');
    assert.equal(after.A.lastStatus, status);
  }
});

test('1 件でも失敗すれば異常終了する（無人実行で気づけるように）', () => {
  assert.equal(exitCodeFor([record('ok'), record('empty')]), 0);
  assert.equal(exitCodeFor([record('ok'), record('failed')]), 1);
});

test('実行ログには対象・件数・範囲・理由が残る', () => {
  const r = buildRunRecord(
    { name: 'A', threadId: '19:a', mode: 'incremental' },
    '2026-08-14T09:59:00.000Z',
    '2026-08-14T10:00:00.000Z',
    '2026-08-13T10:00:00.000Z',
    { status: 'ok', reasons: ['理由'], model: okModel, files: [{ filename: 'a.md' }] },
  );
  assert.equal(r.target, 'A');
  assert.equal(r.messageCount, 12);
  assert.equal(r.since, '2026-08-13T10:00:00.000Z');
  assert.deepEqual(r.files, ['a.md']);
  assert.equal(r.durationMs, 60000);
});

test('サマリは失敗件数が一目で分かる', () => {
  const text = summarize([record('ok'), record('failed')]);
  assert.match(text, /2 件中 1 件が失敗/);
});
