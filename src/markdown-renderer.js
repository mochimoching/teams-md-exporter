/**
 * Markdown レンダラ（仕様書 §6）。
 *
 * 中間データモデル（§5）→ 最終 Markdown。純粋関数で、DOM にも時計にも触れない。
 * 中間モデルさえあれば方式A/Bどちらの経路でも同じ出力になる。
 *
 * 方針:
 *   - 取りこぼしの可能性（truncated / 未展開の返信 / 折りたたみ本文）はファイル冒頭に必ず出す（原則4）
 *   - 推定で埋めた値（連続投稿で引き継いだ日時など）は、その旨が読んで分かるようにする
 */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const RENDER_DEFAULTS = {
  /** 1 ファイルの上限（§6.4）。超えたら日付境界で分割する */
  maxMessagesPerFile: 5000,
  maxBytesPerFile: 5 * 1024 * 1024,
  /** 警告の要約をファイル末尾に付ける */
  includeWarnings: true,
  /** 返信を親のぶら下げ（引用インデント）にする。false なら時系列フラット */
  nestReplies: true,
};

/**
 * 中間モデルから Markdown ファイル（1 つ以上）を組み立てる。
 * @param {object} model normalize() の戻り値
 * @param {object} options RENDER_DEFAULTS 参照
 * @returns {{files: Array<{filename: string, content: string, part: number|null, partOf: number|null}>}}
 */
export function renderMarkdownFiles(model, options = {}) {
  const opts = { ...RENDER_DEFAULTS, ...options };
  const days = groupByDay(model, opts);
  const chunks = splitIntoFiles(days, opts);

  const files = chunks.map((chunk, index) => {
    const part = chunks.length > 1 ? index + 1 : null;
    const content = renderFile(model, chunk, { ...opts, part, partOf: chunks.length > 1 ? chunks.length : null });
    return {
      filename: buildFilename(model, { ...opts, part }),
      content,
      part,
      partOf: chunks.length > 1 ? chunks.length : null,
    };
  });

  return { files };
}

/** 単一ファイルで欲しいときの薄いラッパ */
export function renderMarkdown(model, options = {}) {
  const { files } = renderMarkdownFiles(model, { ...options, maxMessagesPerFile: Infinity, maxBytesPerFile: Infinity });
  return files[0] ? files[0].content : '';
}

/**
 * ファイル名（§6.1）: teams_{kind}_{safeTitle}_{YYYYMMDD-HHmm}.md
 */
export function buildFilename(model, options = {}) {
  const kind = model.source.kind || 'conversation';
  const title = safeTitle(conversationTitle(model));
  const stamp = fileStamp(model.source.capturedAt);
  const part = options.part ? `_part${options.part}` : '';
  return `teams_${kind}_${title}_${stamp}${part}.md`;
}

/* ------------------------------------------------------------------ */

function renderFile(model, days, opts) {
  const lines = [];
  lines.push(renderFrontMatter(model, days, opts));
  lines.push(`# ${conversationTitle(model)}${model.source.kind === 'channel' ? '（チャネル）' : '（チャット）'}`);
  lines.push('');
  lines.push(`> このファイルは Teams Web の表示内容から自動抽出したものです。抽出時点: ${displayStamp(model.source.capturedAt)}`);

  const notice = renderTruncationNotice(model, opts);
  if (notice) {
    lines.push('');
    lines.push(notice);
  }

  for (const day of days) {
    lines.push('');
    lines.push(`## ${day.date} (${day.weekday})`);
    for (const entry of day.entries) {
      lines.push('');
      lines.push(renderMessage(entry.message, { ...opts, level: 3 }));
      for (const reply of entry.replies) {
        lines.push('');
        // 返信は親の日付見出しの下にぶら下げるので、日をまたいだ返信は日付も出す
        lines.push(quote(renderMessage(reply, {
          ...opts, level: 4, isReply: true, showDate: dateOf(reply) !== day.date,
        })));
      }
    }
  }

  if (opts.includeWarnings) {
    const summary = renderWarningSummary(model);
    if (summary) {
      lines.push('');
      lines.push(summary);
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderFrontMatter(model, days, opts) {
  const s = model.source;
  const stats = model.stats;
  const messageCount = days.reduce((sum, d) => sum + d.entries.reduce((n, e) => n + 1 + e.replies.length, 0), 0);
  const range = days.length > 0
    ? `${days[0].date} 〜 ${days[days.length - 1].date}`
    : '（メッセージなし）';

  const fields = [
    ['source_kind', s.kind],
    ['team', s.team],
    ['channel', s.channel],
    ['chat_title', s.chatTitle],
    ['url', s.url],
    ['thread_id', s.threadId],
    ['captured_at', s.capturedAt],
    ['captured_by', s.capturedBy],
    ['message_count', messageCount],
    ['range', range],
    ['truncated', Boolean(stats.truncated)],
    ['tool_version', s.toolVersion],
  ];
  if (opts.part) {
    fields.push(['part', opts.part], ['part_of', opts.partOf]);
  }
  if (stats.systemExcluded > 0) fields.push(['system_messages_excluded', stats.systemExcluded]);
  // 取得範囲を絞った場合は、そのことがファイル単体で分かるようにする
  if (stats.since) fields.push(['range_since', stats.since]);
  if (stats.rangeExcluded > 0) fields.push(['out_of_range_excluded', stats.rangeExcluded]);

  const body = fields
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${yamlValue(value)}`)
    .join('\n');
  return `---\n${body}\n---\n`;
}

/** 取りこぼしの可能性をファイル冒頭で明示する（原則4・§5 truncated） */
function renderTruncationNotice(model) {
  const stats = model.stats;
  if (!stats.truncated) return '';

  const reasons = [];
  if (stats.scroll && stats.scroll.stopReason && stats.scroll.stopReason !== 'reached-top') {
    reasons.push(`会話の先頭まで遡れていません（停止理由: ${stats.scroll.stopReason}）`);
  }
  if (stats.replyGaps && stats.replyGaps.length > 0) {
    const missing = stats.replyGaps.reduce((sum, g) => sum + (g.declared - g.extracted), 0);
    reasons.push(`スレッドを開いていない返信が ${missing} 件あります（${stats.replyGaps.length} スレッド）`);
  }
  const collapsed = countWarnings(model, 'collapsed-body');
  if (collapsed > 0) reasons.push(`「詳細を表示」で折りたたまれたままの本文が ${collapsed} 件あります`);

  const detail = reasons.length > 0 ? reasons.map((r) => `> - ${r}`).join('\n') : '> - 詳細は末尾の警告一覧を参照';
  return `> ⚠️ **このファイルは会話の全体ではありません（truncated）**\n>\n${detail}`;
}

function renderMessage(message, opts) {
  const lines = [];
  const heading = '#'.repeat(opts.level);
  const time = displayTime(message, opts);
  const author = message.author || '(送信者不明)';
  const marks = [];
  if (opts.isReply) marks.push('↳返信');
  if (message.edited) marks.push('(編集済み)');

  // 元のメッセージへのリンク。取れなかったメッセージには付かない（警告は末尾の一覧に出る）
  const link = message.permalink ? ` [🔗](${message.permalink})` : '';
  lines.push(`${heading} ${time}  ${author}${marks.length > 0 ? ` ${marks.join(' ')}` : ''}${link}`);

  if (message.subject) {
    lines.push('');
    lines.push(`**${message.subject}**`);
  }

  if (message.deleted) {
    lines.push('');
    lines.push('*(このメッセージは削除されました)*');
  } else if (message.bodyMarkdown) {
    lines.push('');
    lines.push(message.bodyMarkdown);
  }

  for (const attachment of message.attachments || []) {
    lines.push('');
    lines.push(attachment.url
      ? `📎 添付: [${attachment.name || attachment.url}](${attachment.url})`
      : `📎 添付: ${attachment.name || '(名前不明)'}（URL は取得できませんでした）`);
  }

  for (const preview of message.linkPreviews || []) {
    if (!preview.url || (message.bodyMarkdown || '').includes(preview.url)) continue; // 本文と重複しないものだけ
    lines.push('');
    lines.push(`🔗 ${preview.title ? `[${preview.title}](${preview.url})` : `<${preview.url}>`}`);
  }

  for (const deepLink of message.deepLinks || []) {
    lines.push('');
    lines.push(deepLink.url ? `🔗 タブ: [${deepLink.name}](${deepLink.url})` : `🔗 タブ: ${deepLink.name}`);
  }

  const reactions = renderReactions(message.reactions);
  if (reactions) {
    lines.push('');
    lines.push(reactions);
  }

  return lines.join('\n');
}

function renderReactions(reactions) {
  if (!reactions || reactions.length === 0) return '';
  return reactions
    .map((r) => {
      const face = r.emoji || (r.type ? `:${r.type}:` : ':reaction:');
      return r.count != null ? `${face} ${r.count}` : face;
    })
    .join('  ');
}

function renderWarningSummary(model) {
  const warnings = model.warnings || [];
  if (warnings.length === 0) return '';
  const byCode = new Map();
  for (const w of warnings) {
    const entry = byCode.get(w.code) || { count: 0, level: w.level, detail: w.detail };
    entry.count += 1;
    byCode.set(w.code, entry);
  }
  const rows = [...byCode.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([code, e]) => `| ${code} | ${e.count} | ${e.level || 'info'} | ${(e.detail || '').replace(/\|/g, '\\|').slice(0, 80)} |`);

  return [
    '---',
    '',
    '## 抽出時の注意（自動生成）',
    '',
    '| コード | 件数 | 重大度 | 例 |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/* ---- 構造化 --------------------------------------------------------- */

/** 親投稿ごとに返信をぶら下げ、日付で束ねる */
function groupByDay(model, opts) {
  const messages = model.messages || [];
  const byParent = new Map();
  const ids = new Set(messages.map((m) => m.id));

  for (const m of messages) {
    if (!opts.nestReplies || !m.parentId || !ids.has(m.parentId)) continue;
    if (!byParent.has(m.parentId)) byParent.set(m.parentId, []);
    byParent.get(m.parentId).push(m);
  }

  const days = [];
  let current = null;
  for (const message of messages) {
    const isNestedReply = opts.nestReplies && message.parentId && ids.has(message.parentId);
    if (isNestedReply) continue; // 親の下で出す

    const date = dateOf(message) || '日時不明';
    if (!current || current.date !== date) {
      current = { date, weekday: weekdayOf(date), entries: [] };
      days.push(current);
    }
    current.entries.push({ message, replies: byParent.get(message.id) || [] });
  }
  return days;
}

/** §6.4: 日付境界で分割する。1 日が上限を超える場合はその日を丸ごと 1 ファイルにする */
function splitIntoFiles(days, opts) {
  if (days.length === 0) return [[]];
  const chunks = [];
  let chunk = [];
  let messages = 0;
  let bytes = 0;

  for (const day of days) {
    const dayMessages = day.entries.reduce((n, e) => n + 1 + e.replies.length, 0);
    const dayBytes = estimateBytes(day);
    const wouldExceed = chunk.length > 0
      && (messages + dayMessages > opts.maxMessagesPerFile || bytes + dayBytes > opts.maxBytesPerFile);
    if (wouldExceed) {
      chunks.push(chunk);
      chunk = [];
      messages = 0;
      bytes = 0;
    }
    chunk.push(day);
    messages += dayMessages;
    bytes += dayBytes;
  }
  chunks.push(chunk);
  return chunks;
}

function estimateBytes(day) {
  let size = 0;
  for (const entry of day.entries) {
    for (const m of [entry.message, ...entry.replies]) {
      size += (m.bodyMarkdown || '').length + (m.subject || '').length + 80;
    }
  }
  return size;
}

/* ---- 小物 ----------------------------------------------------------- */

function conversationTitle(model) {
  const s = model.source;
  if (s.kind === 'channel') return [s.team, s.channel].filter(Boolean).join(' / ') || 'チャネル';
  return s.chatTitle || 'チャット';
}

/** ファイル名に使えない文字を - にする（§6.1） */
function safeTitle(title) {
  return String(title)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'conversation';
}

/** ISO → YYYYMMDD-HHmm（ローカル表記のまま文字列操作するので時差ズレしない） */
function fileStamp(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return 'unknown';
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

function displayStamp(iso) {
  if (!iso) return '(不明)';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function dateOf(message) {
  return message.timestamp ? message.timestamp.slice(0, 10) : null;
}

function weekdayOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '?';
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 時刻表示。日をまたぐ返信は日付つき、推定で埋めたものは分かるようにする */
function displayTime(message, opts = {}) {
  if (!message.timestamp) return '??:??';
  const time = message.timestamp.slice(11, 16);
  const shown = opts.showDate ? `${message.timestamp.slice(5, 10)} ${time}` : time;
  if (message.timestampPrecision === 'inherited') return `${shown}（推定）`;
  return shown;
}

/** 返信ブロックを引用にする（§6.2） */
function quote(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function countWarnings(model, code) {
  return (model.warnings || []).filter((w) => w.code === code).length;
}

function yamlValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[\w./+-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}
