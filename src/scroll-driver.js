/**
 * スクロールドライバ（仕様書 §3.1-1 / §7-3）。
 *
 * Teams Web は仮想スクロールで、画面外に出たメッセージを DOM から削除する。
 * そのため「全部読み込んでから抽出」はできない。
 * 上方向へ少しずつ遡りながら **その時点で DOM にあるものを都度抽出し、メッセージID で蓄積する**。
 *
 * 副作用（スクロール・クリック・待機）はこのモジュールに閉じ込め、
 * 抽出コア（純粋関数）はそのまま呼ぶだけにしてある。
 * 時計とスリープは注入可能なので、テストでは実時間を待たずに動かせる。
 *
 * 「見えているものだけ」の原則（CLAUDE.md 原則1）は守る:
 *   - 行うのは会話ペインのスクロールと、表示済みメッセージの「詳細を表示」展開だけ
 *   - ネットワークへ直接アクセスしない。ページ遷移もしない
 */

import { extractConversation } from './extract.js';
import { toIsoTimestamp } from './normalize.js';
import { compilePatterns, findById, isUnset, queryAll, queryFirst, toSelectorList } from './selector-utils.js';

const DEFAULTS = {
  profile: 'channel',
  /** 1 回のスクロール量（ペインの表示高さに対する割合）。小刻みにして飛ばさない */
  stepRatio: 0.75,
  /** スクロール直後の待ち */
  waitMs: 400,
  /** 遅延ロード待ちのポーリング間隔と上限 */
  pollMs: 150,
  maxWaitMs: 5000,
  /** 変化なしが何回続いたら「先頭に到達した」とみなすか */
  idleRounds: 3,
  /** 安全弁。到達したら truncated = true */
  maxSteps: 400,
  maxDurationMs: 10 * 60 * 1000,
  maxMessages: Infinity,
  /**
   * この日時より古いメッセージまで遡ったら停止（ISO 文字列）。到達したら truncated = false。
   * 相対表記（「昨日の 19:18」）を解決するために capturedAt（取得時刻の ISO）も渡すこと。
   */
  stopBefore: null,
  capturedAt: null,
  timezoneOffset: '+09:00',
  /** 折りたたまれた本文（「詳細を表示」）をクリックして展開する */
  expandBody: true,
  /**
   * 返信スレッドを開いて取りに行く。
   * 「N 件の返信を開く」をクリックすると**画面右にスレッドペインが開く**（ページ遷移ではない）ので、
   * そのペインを同じ手順で遡ってから閉じる、という入れ子の収集を行う。
   * 既定 false: スレッドペインのセレクタが未採取のため（未設定なら警告を出して何もしない）。
   */
  expandReplies: false,
  /** スレッドペインが開く/閉じるのを待つ上限 */
  threadWaitMs: 8000,
  onProgress: null,
  /**
   * true を返すと収集を打ち切る（UI の「中止」ボタン用）。
   * 打ち切った場合も stopReason: 'aborted' / truncated: true として必ず報告する。
   */
  shouldAbort: null,
};

/**
 * 会話ペインを遡りながら全メッセージを収集する。
 *
 * @param {Element} pane 会話ペイン（スクロールする要素）。省略時は findConversationPane() で探す
 * @param {object} selectors selectors.json
 * @param {object} options DEFAULTS 参照。sleep / now を渡すとテストから時間を制御できる
 * @returns {Promise<{messages, boxes, warnings, stats}>} extractConversation と同じ形＋stats
 */
export async function collectByScrolling(paneOrGetter, selectors, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  // stopBefore の判定で日時を解釈するために要る（抽出側は自前でコンパイルするので影響しない）
  opts.patterns = compilePatterns(selectors.patterns || {});
  let pane = paneOrGetter;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now || (() => Date.now());
  const sel = selectors.profiles[opts.profile];
  if (!sel) throw new Error(`collectByScrolling: selectors.profiles.${opts.profile} が定義されていません`);
  if (!pane || pane.nodeType !== 1) throw new TypeError('collectByScrolling: 会話ペインの DOM 要素を渡してください');

  const acc = new Map(); // messageId → message
  const boxAcc = new Map(); // boxId → box info
  const warnings = [];
  const startedAt = now();
  const stats = {
    steps: 0,
    expandedBodies: 0,
    expandedReplies: 0,
    sweptTop: false,
    stopReason: null,
    durationMs: 0,
  };

  let idle = 0;

  for (;;) {
    if (opts.expandBody) {
      const expanded = clickAll(pane, sel.expandBodyButton);
      stats.expandedBodies += expanded;
      if (expanded > 0) await sleep(opts.waitMs);
    }

    const before = acc.size;
    harvest(pane, selectors, opts, acc, boxAcc, warnings, stats.steps);

    // 返信は「N 件の返信」と表示されていても DOM には数件しか出ない。
    // 表示中のうち不足している投稿について、この場でスレッドペインを開いて取りに行く。
    if (opts.expandReplies) {
      await collectPendingThreads(pane, selectors, opts, {
        acc, boxAcc, warnings, stats, sleep, now, sel,
      });
      // スレッドを開くと会話ペインが作り直されることがある。外れていたら見つけ直す。
      const restored = restorePane(pane, selectors, opts, warnings);
      if (restored) pane = restored;
    }
    const gained = acc.size - before;

    stats.steps += 1;
    report(opts, { step: stats.steps, collected: acc.size, gained, scrollTop: pane.scrollTop });

    const stop = shouldStop(stats, acc, opts, now() - startedAt);
    if (stop) {
      stats.stopReason = stop;
      break;
    }

    const atTop = pane.scrollTop <= 0;
    const heightBefore = pane.scrollHeight;
    if (!atTop) {
      const step = Math.max(1, Math.floor(pane.clientHeight * opts.stepRatio));
      pane.scrollTop = Math.max(0, pane.scrollTop - step);
    }
    await sleep(opts.waitMs);
    await waitForLoading(pane, sel, opts, sleep, now);

    const grew = pane.scrollHeight > heightBefore;
    if (gained === 0 && !grew && atTop) {
      idle += 1;
      if (idle >= opts.idleRounds) {
        stats.sweptTop = true;
        stats.stopReason = 'reached-top';
        break;
      }
    } else {
      idle = 0;
    }
  }

  stats.durationMs = now() - startedAt;

  const messages = [...acc.values()].sort((a, b) => a.domOrder - b.domOrder);
  const truncated = stats.stopReason !== 'reached-top' && stats.stopReason !== 'stop-before-reached';
  if (truncated) {
    warnings.push({
      level: 'warn',
      code: 'scroll-truncated',
      detail: `会話の先頭まで遡れませんでした（停止理由: ${stats.stopReason}）。取りこぼしがあります`,
    });
  }
  if (messages.length === 0) {
    warnings.push({
      level: 'fatal',
      code: 'no-messages-extracted',
      detail: 'スクロールしても 1 件も抽出できませんでした（selectors.json の更新が必要）',
    });
  }

  return { profile: opts.profile, messages, boxes: [...boxAcc.values()], warnings, stats, truncated };
}

/**
 * 会話ペイン（スクロールする要素）を探す。
 * selectors に値があればそれを優先し、無ければメッセージ要素から上方向に
 * 「実際にスクロールできる祖先」を探す（DOM 変更に強い保険）。
 */
export function findConversationPane(root, selectors, profile = 'channel') {
  const sel = selectors.profiles[profile];
  const configured = queryFirst(root, sel.conversationPane)
    || (matches(root, sel.conversationPane) ? root : null);
  if (configured) return configured;

  const anchor = queryFirst(root, sel.messageUnit) || queryFirst(root, sel.messageBox);
  if (!anchor) return null;
  for (let el = anchor.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 10) return el;
  }
  return null;
}

/* ---- 返信スレッド（右ペイン） ---------------------------------------- */

/**
 * 「N 件の返信」と表示されているのに DOM に出ていない投稿について、
 * その場でスレッドペインを開き、同じ手順で遡って収集してから閉じる。
 *
 * クリックで開くのは**画面右のスレッドペイン**（ページ遷移ではない）ため、
 * 元の会話ペインはそのまま残り、閉じればスクロールを続行できる。
 */
async function collectPendingThreads(pane, selectors, opts, ctx) {
  const { acc, boxAcc, warnings, stats, sleep, now, sel } = ctx;
  const doc = pane.ownerDocument;
  const patterns = compilePatterns(selectors.patterns || {});

  if (isUnset(sel.threadPane) || isUnset(sel.expandRepliesButton)) {
    pushOnce(warnings, {
      level: 'warn',
      code: 'reply-thread-selectors-unset',
      detail: 'スレッドペインのセレクタ（threadPane 等）が未設定のため、返信の追加取得を行いませんでした。未取得の返信は replyGaps に残ります',
    });
    return;
  }

  for (const box of boxAcc.values()) {
    if (box.threadVisited) continue;
    const declared = parseCount(box.replyCountLabel, patterns.replyCountLabel);
    if (declared == null || declared <= box.replyCountExtracted) continue;

    const button = findReplyButton(pane, sel, box.postId);
    if (!button) continue; // 仮想スクロールで画面外に出た投稿は、再び見えたときに拾う

    box.threadVisited = true;
    button.click();

    const threadPane = await waitFor(() => queryFirst(doc.documentElement, sel.threadPane), opts, sleep, now);
    if (!threadPane) {
      pushOnce(warnings, {
        level: 'warn',
        code: 'reply-thread-not-opened',
        detail: `${box.postId}: スレッドペインが開きませんでした（threadPane セレクタ要確認）`,
      });
      continue;
    }

    // スレッド表示はチャネルとは別の DOM（チャット形式）で描画される。
    // どのプロファイルで読むかは selectors.json 側の threadProfile に従う。
    const scroller = queryFirst(threadPane, sel.threadPaneScroller) || threadPane;
    const thread = await collectByScrolling(scroller, selectors, {
      ...opts,
      profile: sel.threadProfile || opts.profile,
      expandReplies: false, // 入れ子で開かない
      onProgress: null,
    });

    for (const message of thread.messages) {
      const existing = acc.get(message.id);
      // スレッド側では親投稿も一緒に取れるが、親子関係は data-reply-chain-id が付けてくれる
      if (!existing) {
        // 親投稿の直後に並ぶよう、親の位置を基準にした順序を与える
        const anchor = acc.get(box.postId);
        acc.set(message.id, { ...message, domOrder: (anchor ? anchor.domOrder : 0) + 0.001 * (acc.size + 1) });
      } else if (contentSize(message) > contentSize(existing)) {
        acc.set(message.id, { ...message, domOrder: existing.domOrder });
      }
    }
    for (const w of thread.warnings) pushOnce(warnings, w);

    box.replyCountExtracted = Math.max(
      box.replyCountExtracted,
      thread.messages.filter((m) => m.parentId === box.postId).length,
    );
    stats.expandedReplies += 1;

    await closeThreadPane(threadPane, sel, opts, sleep, now, doc, warnings);
  }
}

/**
 * スレッド表示の間、元の会話ペインが DOM から外れることがある（チャネルのスレッドは
 * チャット形式の別ペインとして描画され、採取時には channel-pane-message が 1 件も無かった）。
 * 外れていたら同じ会話ペインを探し直す。見つからなければそのまま（次周回で停止条件に当たる）。
 */
function restorePane(pane, selectors, opts, warnings) {
  if (pane.isConnected !== false) return null;
  const doc = pane.ownerDocument;
  const found = doc && findConversationPane(doc.documentElement, selectors, opts.profile);
  if (found) {
    pushOnce(warnings, {
      level: 'info',
      code: 'pane-reacquired',
      detail: 'スレッドを開いた影響で会話ペインが作り直されたため、探し直して収集を続けました',
    });
    return found;
  }
  pushOnce(warnings, {
    level: 'warn',
    code: 'pane-lost',
    detail: 'スレッドを開いた後、会話ペインを見つけ直せませんでした（取りこぼしの可能性）',
  });
  return null;
}

async function closeThreadPane(threadPane, sel, opts, sleep, now, doc, warnings) {
  const closeButton = queryFirst(threadPane, sel.threadPaneClose) || queryFirst(doc.documentElement, sel.threadPaneClose);
  if (closeButton && typeof closeButton.click === 'function') closeButton.click();
  else dispatchEscape(threadPane, doc);

  const closed = await waitFor(() => !queryFirst(doc.documentElement, sel.threadPane), opts, sleep, now);
  if (!closed) {
    pushOnce(warnings, {
      level: 'warn',
      code: 'reply-thread-not-closed',
      detail: 'スレッドペインを閉じられませんでした（threadPaneClose セレクタ要確認）。以降の収集が不安定になる可能性があります',
    });
  }
}

function dispatchEscape(target, doc) {
  const view = doc.defaultView;
  if (!view || typeof view.KeyboardEvent !== 'function') return;
  target.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/** 「N 件の返信を開く」ボタン。id テンプレート（response-summary-{mid}）優先で引く */
function findReplyButton(pane, sel, postId) {
  const template = (sel.idTemplates || {}).replySummaryButton;
  if (template && postId) {
    const byId = findById(pane, template.replace('{mid}', postId));
    if (byId) return byId;
  }
  return queryFirst(pane, sel.expandRepliesButton);
}

/** 条件が満たされるまで待つ。満たされたらその値、時間切れなら falsy */
async function waitFor(check, opts, sleep, now) {
  const deadline = now() + (opts.threadWaitMs || opts.maxWaitMs);
  for (;;) {
    const value = check();
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(opts.pollMs);
  }
}

function parseCount(label, pattern) {
  if (!label || !pattern) return null;
  const m = pattern.exec(String(label));
  return m ? Number(m[1]) : null;
}

function pushOnce(warnings, warning) {
  const key = `${warning.code}:${warning.messageId || ''}:${warning.detail || ''}`;
  if (!warnings.some((w) => `${w.code}:${w.messageId || ''}:${w.detail || ''}` === key)) warnings.push(warning);
}

/* ------------------------------------------------------------------ */

/**
 * その時点で DOM にあるメッセージを抽出し、ID で蓄積する（仮想スクロール対策）。
 * 上方向へ遡るので「後の周回ほど古い」。時系列に並ぶよう、周回番号で負のオフセットを与える。
 */
function harvest(pane, selectors, opts, acc, boxAcc, warnings, pass) {
  const extraction = extractConversation(pane, selectors, opts);
  const orderBase = -pass * 100000;

  for (const w of extraction.warnings) {
    // 毎周回で同じ警告が積み上がるのを防ぐ（メッセージ単位のものは ID で一意化）
    const key = `${w.code}:${w.messageId || ''}:${w.detail || ''}`;
    if (!warnings.some((x) => `${x.code}:${x.messageId || ''}:${x.detail || ''}` === key)) warnings.push(w);
  }

  extraction.messages.forEach((message, index) => {
    const existing = acc.get(message.id);
    if (!existing) {
      acc.set(message.id, { ...message, domOrder: orderBase + index });
      return;
    }
    // 「詳細を表示」の展開後など、後から取り直したほうが情報量が多いことがある
    if (contentSize(message) > contentSize(existing)) {
      acc.set(message.id, { ...message, domOrder: existing.domOrder });
    }
  });

  for (const box of extraction.boxes) {
    const key = box.boxId || `#${box.boxIndex}`;
    const existing = boxAcc.get(key);
    if (!existing || box.replyCountExtracted > existing.replyCountExtracted) boxAcc.set(key, box);
  }
}

function contentSize(message) {
  return (message.bodyMarkdown || '').length
    + message.attachments.length * 100
    + message.reactions.length * 10;
}

/** 停止条件。到達した場合は理由の文字列を返す */
function shouldStop(stats, acc, opts, elapsedMs) {
  if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) return 'aborted';
  if (acc.size >= opts.maxMessages) return 'max-messages';
  if (stats.steps >= opts.maxSteps) return 'max-steps';
  if (elapsedMs >= opts.maxDurationMs) return 'max-duration';
  if (opts.stopBefore) {
    const limit = Date.parse(opts.stopBefore);
    const oldest = oldestTimestamp(acc, opts);
    if (oldest !== null && !Number.isNaN(limit) && oldest < limit) return 'stop-before-reached';
  }
  return null;
}

/**
 * 蓄積済みメッセージのうち最も古い日時（エポックミリ秒）。取れないものは無視する。
 *
 * datetime 属性だけを見ていた頃は **チャネルで常に null になり、stopBefore が無反応**だった
 * （datetime を持つのはチャットの <time> だけ）。正規化と同じ解釈器を通し、
 * タイムゾーンの違う文字列を混ぜても壊れないよう数値で比較する。
 */
function oldestTimestamp(acc, opts) {
  const options = { offset: opts.timezoneOffset, capturedAt: opts.capturedAt };
  let oldest = null;
  for (const m of acc.values()) {
    const { iso } = toIsoTimestamp(m.timestamp, opts.patterns || {}, options);
    if (!iso) continue;
    const at = Date.parse(iso);
    if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}

/** 遅延ロード中（スピナー表示中）なら、消えるまで待つ */
async function waitForLoading(pane, sel, opts, sleep, now) {
  if (toSelectorList(sel.loadingIndicator).length === 0) return;
  const deadline = now() + opts.maxWaitMs;
  while (queryFirst(pane, sel.loadingIndicator) && now() < deadline) {
    await sleep(opts.pollMs);
  }
}

/** 表示中の展開ボタンを押す。押した数を返す */
function clickAll(pane, selector) {
  let clicked = 0;
  for (const button of queryAll(pane, selector)) {
    if (button.getAttribute('aria-expanded') === 'true') continue;
    if (typeof button.click !== 'function') continue;
    button.click();
    clicked += 1;
  }
  return clicked;
}

function report(opts, progress) {
  if (typeof opts.onProgress === 'function') opts.onProgress(progress);
}

function matches(el, selector) {
  return toSelectorList(selector).some((s) => el.matches && el.matches(s));
}
