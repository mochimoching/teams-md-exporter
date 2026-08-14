/**
 * スケジュール実行の判断ロジック（純粋関数）。
 *
 * ブラウザにもファイルシステムにも触れない。実際の起動・保存は scheduled-export.js が行う。
 * 無人実行では「動いたが実は取れていない」が最悪の失敗なので、
 * 成否の判定と、成功と見なす条件をここに集約して単体テストで固定する。
 */

export const CONFIG_DEFAULTS = {
  /** 収集後、次の対象に移るまでの待ち（低頻度・逐次アクセス。仕様書 §7.1） */
  betweenTargetsMs: 10000,
  /** 会話を開いてから収集を始めるまでの待ち */
  settleMs: 5000,
  /** 1 会話あたりの収集の上限 */
  timeoutMs: 15 * 60 * 1000,
  /**
   * 差分取得の巻き戻し幅（分）。前回実行時刻ちょうどから取ると、
   * 実行中に届いたメッセージや日時のずれで取りこぼすため、少し重ねて取る。
   */
  overlapMinutes: 60,
  collect: {},
};

const TARGET_MODES = ['incremental', 'full'];

/**
 * 設定を検証して既定値で埋める。不備は黙って直さず、直し方が分かる文言で落とす。
 * @returns {object} 正規化した設定
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('設定ファイルの中身がオブジェクトではありません');

  for (const key of ['profileDir', 'outDir']) {
    if (!raw[key] || typeof raw[key] !== 'string') {
      throw new Error(`設定に ${key}（文字列）が必要です。docs/scheduled.md の例を参照してください`);
    }
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error('設定に targets（取得対象の配列）が必要です。1 件以上指定してください');
  }

  const targets = raw.targets.map((target, index) => normalizeTarget(target, index));
  const names = targets.map((t) => t.name);
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicated.length > 0) {
    throw new Error(`targets の name が重複しています: ${[...new Set(duplicated)].join(', ')}（状態の記録に使うので一意にしてください）`);
  }

  return {
    ...CONFIG_DEFAULTS,
    ...raw,
    collect: { ...CONFIG_DEFAULTS.collect, ...(raw.collect || {}) },
    targets,
  };
}

function normalizeTarget(target, index) {
  if (!target || typeof target !== 'object') throw new Error(`targets[${index}] がオブジェクトではありません`);

  const current = target.current === true;
  if (!current && !target.threadId) {
    throw new Error(`targets[${index}]: threadId（会話 ID）か current: true のどちらかが必要です。threadId は書き出した .md のフロントマター thread_id にあります`);
  }
  const mode = target.mode || 'incremental';
  if (!TARGET_MODES.includes(mode)) {
    throw new Error(`targets[${index}]: mode は ${TARGET_MODES.join(' / ')} のいずれかです（指定値: ${mode}）`);
  }
  return {
    ...target,
    current,
    mode,
    name: target.name || target.threadId || `target-${index}`,
  };
}

/**
 * 差分取得の開始日時を決める。
 *
 * full 指定、または前回の成功記録が無い（初回）場合は null＝全件。
 * 「前回は 0 件だった」場合も、その時刻を起点にしてよい（会話を開けてはいるため）。
 *
 * @param {object} target normalizeTarget 済み
 * @param {object} state  読み込んだ状態（{ [name]: { lastRunAt } }）
 * @param {number} overlapMinutes 巻き戻し幅
 * @returns {string|null} ISO 8601（ローカルオフセット付き）または null
 */
export function resolveSince(target, state, overlapMinutes) {
  if (target.mode === 'full') return null;
  const previous = state && state[target.name];
  if (!previous || !previous.lastRunAt) return null;

  const at = Date.parse(previous.lastRunAt);
  if (Number.isNaN(at)) return null;
  return new Date(at - overlapMinutes * 60 * 1000).toISOString();
}

/**
 * 1 会話ぶんの実行結果を判定する。
 *
 * - fatal があれば失敗（抽出 0 件・セレクタ未設定など）
 * - 差分取得で新着が無いのは正常。ファイルは書かない（空ファイルを量産しない）
 * - truncated は失敗にしないが、必ず記録して報告する
 *
 * @returns {{status: 'ok'|'empty'|'failed', reasons: string[]}}
 */
export function classifyRun(model) {
  if (!model || !model.stats) return { status: 'failed', reasons: ['収集結果を取得できませんでした'] };

  const stats = model.stats;
  const reasons = [];
  const fatals = (model.warnings || []).filter((w) => w.level === 'fatal');
  if (fatals.length > 0) {
    for (const f of fatals) reasons.push(`${f.code}: ${f.detail}`);
    return { status: 'failed', reasons };
  }

  if (stats.messageCount === 0) return { status: 'empty', reasons: ['新しいメッセージはありませんでした'] };

  if (stats.truncated) reasons.push(`会話の全体ではありません（停止理由: ${stats.scroll ? stats.scroll.stopReason : '不明'}）`);
  if (stats.replyGaps && stats.replyGaps.length > 0) {
    const missing = stats.replyGaps.reduce((sum, g) => sum + (g.declared - g.extracted), 0);
    reasons.push(`未取得の返信が ${missing} 件あります`);
  }
  return { status: 'ok', reasons };
}

/** 実行ログ 1 行ぶん（JSON Lines で追記する） */
export function buildRunRecord(target, startedAt, finishedAt, since, result) {
  return {
    at: finishedAt,
    target: target.name,
    threadId: target.threadId || null,
    mode: target.mode,
    since,
    status: result.status,
    messageCount: result.model && result.model.stats ? result.model.stats.messageCount : 0,
    truncated: Boolean(result.model && result.model.stats && result.model.stats.truncated),
    files: (result.files || []).map((f) => f.filename),
    reasons: result.reasons || [],
    error: result.error || null,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  };
}

/**
 * 状態を更新する。**成功したときだけ** lastRunAt を進める。
 * 失敗時に進めてしまうと、次回の差分取得が失敗した区間を飛ばしてしまう。
 */
export function updateState(state, target, record) {
  if (record.status === 'failed') return state;
  return {
    ...state,
    [target.name]: {
      lastRunAt: record.at,
      lastStatus: record.status,
      lastMessageCount: record.messageCount,
      threadId: target.threadId || null,
    },
  };
}

/** 全体の終了コード。1 件でも失敗があれば異常終了させる（無人実行で気づけるように） */
export function exitCodeFor(records) {
  return records.some((r) => r.status === 'failed') ? 1 : 0;
}

/** 人が読むための実行サマリ */
export function summarize(records) {
  const lines = records.map((r) => {
    const detail = r.status === 'failed'
      ? `失敗: ${r.error || r.reasons.join(' / ')}`
      : `${r.messageCount} 件${r.files.length > 0 ? ` → ${r.files.join(', ')}` : ''}${r.reasons.length > 0 ? `（${r.reasons.join(' / ')}）` : ''}`;
    return `  ${statusMark(r.status)} ${r.target}: ${detail}`;
  });
  const failed = records.filter((r) => r.status === 'failed').length;
  const header = failed > 0
    ? `${records.length} 件中 ${failed} 件が失敗しました`
    : `${records.length} 件を処理しました`;
  return [header, ...lines].join('\n');
}

function statusMark(status) {
  if (status === 'failed') return '✗';
  if (status === 'empty') return '−';
  return '✓';
}
