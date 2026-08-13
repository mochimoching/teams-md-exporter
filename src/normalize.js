/**
 * 正規化（抽出結果 → 仕様書 §5 の中間データモデル）。
 *
 * 純粋関数。DOM にも時計にも触れない（capturedAt は呼び出し側が渡す）。
 * 文字列 → 型（ISO 日時 / 件数）の変換はここに集約する。
 */

import { compilePatterns, normalizeSpace } from './selector-utils.js';

const TOOL_VERSION = '0.1.0';

/**
 * @param {object} extraction extractConversation() の戻り値
 * @param {object} meta  { kind, team, channel, chatTitle, url, capturedAt, capturedBy, threadId }
 * @param {object} options { patterns, permalink?, tenantId?, groupId?, timezoneOffset?, assumeYear?, includeSystem?, truncated? }
 * @returns {{source: object, participants: Array, messages: Array, stats: object, warnings: Array}}
 */
export function normalize(extraction, meta = {}, options = {}) {
  const patterns = compilePatterns(options.patterns || {});
  const offset = options.timezoneOffset || '+09:00';
  const warnings = [...(extraction.warnings || [])];
  const permalinkConfig = options.permalink || null;
  const threadId = meta.threadId || null;

  const seen = new Map();
  const messages = [];

  for (const raw of extraction.messages || []) {
    if (seen.has(raw.id)) {
      warnings.push({ level: 'info', code: 'duplicate-message', messageId: raw.id, detail: '重複メッセージを除外しました' });
      continue;
    }
    seen.set(raw.id, true);

    const ts = toIsoTimestamp(raw.timestamp, patterns, {
      offset,
      assumeYear: options.assumeYear,
      capturedAt: meta.capturedAt,
    });
    // 日時要素そのものが無い場合は抽出側で timestamp-missing を出しているので、ここでは重複させない
    const hasTimestampSource = Boolean(
      raw.timestamp && (raw.timestamp.text || Object.keys(raw.timestamp.attributes || {}).length > 0),
    );
    if (!ts.iso && hasTimestampSource) {
      warnings.push({
        level: 'warn',
        code: ts.code || 'timestamp-unparsed',
        messageId: raw.id,
        detail: ts.detail || `日時を ISO 8601 に変換できませんでした（生値: ${JSON.stringify(raw.timestamp)}）`,
      });
    }

    // 編集時刻は「2026年8月4日 17:06 に編集しました」「今日の 14:00 に編集しました」「更新済み 今日の 9:49」など表記が揺れる
    const editedAt = parseEditedAt(raw.editedTitle, patterns, offset, meta.capturedAt);
    if (raw.edited && raw.editedTitle && !editedAt.iso) {
      warnings.push({
        level: 'info',
        code: 'edited-time-unparsed',
        messageId: raw.id,
        detail: `編集時刻を解釈できませんでした（生値: ${JSON.stringify(raw.editedTitle)}）`,
      });
    }

    const reactions = (raw.reactions || []).map((r) => {
      const parsed = parseReaction(r, patterns);
      if (parsed.count == null) {
        warnings.push({
          level: 'info',
          code: 'reaction-count-unparsed',
          messageId: raw.id,
          detail: `リアクション件数を解釈できませんでした（生値: ${JSON.stringify(r.label)}）`,
        });
      }
      return parsed;
    });

    messages.push({
      id: raw.id,
      parentId: raw.parentId ?? null,
      permalink: buildPermalink(permalinkConfig, {
        threadId,
        messageId: raw.id,
        // Teams のディープリンクは投稿本体でも parentMessageId を要求する（親は自分自身）
        parentId: raw.parentId ?? raw.id,
        tenantId: options.tenantId || null,
        groupId: options.groupId || null,
      }),
      author: raw.author || null,
      authorInherited: Boolean(raw.authorInherited),
      timestamp: ts.iso,
      timestampRaw: ts.iso ? undefined : raw.timestamp,
      timestampPrecision: raw.timestampInherited ? 'inherited' : ts.precision,
      editedAt: editedAt.iso,
      edited: Boolean(raw.edited),
      deleted: Boolean(raw.deleted),
      subject: raw.subject || null,
      bodyMarkdown: raw.bodyMarkdown || '',
      reactions,
      attachments: raw.attachments || [],
      linkPreviews: raw.linkPreviews || [],
      deepLinks: raw.deepLinks || [],
      cards: raw.cards || [],
      system: Boolean(raw.system),
      _domOrder: raw.domOrder ?? 0,
    });
  }

  // システムメッセージ（参加/退出/名称変更など）は既定で出力しない（仕様書 §9 の選択肢）。
  // ただし「何件落としたか」は必ず残す（黙って消さない）。
  const includeSystem = options.includeSystem === true;
  const systemMessages = messages.filter((m) => m.system);
  const kept = includeSystem ? messages : messages.filter((m) => !m.system);
  if (!includeSystem && systemMessages.length > 0) {
    warnings.push({
      level: 'info',
      code: 'system-messages-excluded',
      detail: `システムメッセージ ${systemMessages.length} 件を出力から除外しました（options.includeSystem: true で含められます）`,
    });
  }
  kept.sort(byTimestampThenDomOrder);

  // リンクを付けられなかったことは黙って隠さない（原則4）。会話 ID が取れなかったのが唯一の原因。
  const withPermalink = kept.filter((m) => m.permalink).length;
  if (permalinkConfig && kept.length > 0 && withPermalink === 0) {
    warnings.push({
      level: 'warn',
      code: 'permalink-unavailable',
      detail: threadId
        ? 'メッセージ ID が取れないため、個々のメッセージへのリンクを作れませんでした'
        : '会話 ID（threadId）が取れないため、個々のメッセージへのリンクを作れませんでした',
    });
  }

  const boxes = extraction.boxes || [];
  const replyGaps = [];
  for (const box of boxes) {
    const declared = parseFirstInt(box.replyCountLabel, patterns.replyCountLabel);
    if (declared != null && declared > box.replyCountExtracted) {
      replyGaps.push({ boxId: box.boxId, declared, extracted: box.replyCountExtracted });
      warnings.push({
        level: 'warn',
        code: 'replies-not-expanded',
        detail: `${box.boxId || 'box'}: 返信 ${declared} 件のうち ${box.replyCountExtracted} 件しか DOM に出ていません（スレッドを開いて再取得が必要）`,
      });
    }
  }

  const truncated =
    Boolean(options.truncated) ||
    replyGaps.length > 0 ||
    warnings.some((w) => w.code === 'collapsed-body');

  const stamps = kept.map((m) => m.timestamp).filter(Boolean).sort();
  const parents = new Set(kept.map((m) => m.parentId).filter(Boolean));

  const model = {
    source: {
      kind: meta.kind || null,
      team: meta.team || null,
      channel: meta.channel || null,
      chatTitle: meta.chatTitle || null,
      url: meta.url || null,
      threadId,
      capturedAt: meta.capturedAt || null,
      capturedBy: meta.capturedBy || null,
      toolVersion: meta.toolVersion || TOOL_VERSION,
    },
    participants: uniqueAuthors(kept).map((displayName) => ({ displayName })),
    messages: kept.map(stripInternal),
    stats: {
      messageCount: kept.length,
      threadCount: parents.size,
      rangeStart: stamps[0] || null,
      rangeEnd: stamps[stamps.length - 1] || null,
      systemExcluded: includeSystem ? 0 : systemMessages.length,
      permalinkCount: withPermalink,
      truncated,
      replyGaps,
      warningCount: warnings.length,
      fatalCount: warnings.filter((w) => w.level === 'fatal').length,
    },
    warnings,
  };

  if (!meta.capturedAt) {
    warnings.push({ level: 'info', code: 'captured-at-missing', detail: 'meta.capturedAt が未指定です（呼び出し側で現在時刻を渡してください）' });
  }
  return model;
}

/* ------------------------------------------------------------------ */

/**
 * 画面（ブラウザのタブ）のタイトルから会話名を取り出す。
 *
 * 純粋関数。document には触れず、タイトル文字列を受け取るだけ。
 * 実測値（2026-08-13）:
 *   チャネル: '(3) チームとチャネル | DTS | 911_プロパー(星野PL-R＆D) | Microsoft Teams'
 *   チャット: '(3) チャット | ベトナム案件-DTSメンバのみ | Microsoft Teams'
 * 先頭のセクション名（未読数が付くことがある）と末尾のアプリ名は UI 言語依存なので、
 * 文字列一致ではなく位置で落とす。設定は selectors.json の conversationTitle。
 *
 * @returns {{team: string|null, channel: string|null, chatTitle: string|null, warnings: Array}}
 */
export function parseConversationTitle(title, config, profile) {
  const result = { team: null, channel: null, chatTitle: null, warnings: [] };
  const fields = config && profile ? config[profile] : null;
  if (!config || !config.separator || !Array.isArray(fields) || fields.length === 0) return result;

  const segments = String(title || '').split(config.separator).map(normalizeSpace).filter(Boolean);
  const rest = segments.slice(config.dropLeading || 0, segments.length - (config.dropTrailing || 0));

  if (rest.length < fields.length) {
    result.warnings.push({
      level: 'info',
      code: 'conversation-title-unparsed',
      detail: `画面のタイトル「${title}」から会話名を取り出せませんでした（ファイル名は既定の名前になります）`,
    });
    return result;
  }

  // 会話名に区切り文字が含まれていても失わないよう、余った分は最後のフィールドに戻す
  fields.forEach((field, index) => {
    const isLast = index === fields.length - 1;
    result[field] = isLast ? rest.slice(index).join(config.separator) : rest[index];
  });
  return result;
}

/**
 * 会話種別に対応するリンク設定を取り出す。チャネルとチャットで URL の形が違う。
 * @returns {object|null}
 */
export function permalinkConfigFor(selectors, profile) {
  const config = selectors && selectors.permalink;
  if (!config || !profile) return null;
  const forProfile = config[profile];
  return forProfile && forProfile.base ? forProfile : null;
}

/**
 * 個々のメッセージへのディープリンクを組み立てる（設定は selectors.json の permalink）。
 *
 * base のプレースホルダが 1 つでも埋まらなければ null を返す（推測で URL を作らない）。
 * params は値のあるものだけを残す。
 *
 * エスケープの方針: **テンプレートの地の文はそのまま出し、{…} に埋める値だけ encodeURIComponent する。**
 * Teams の実物のリンクは、パス部が生の '19:…@thread.tacv2'、チャットの context が
 * '{"contextType"%3A"chat"}'（':' だけを %3A にした形）と独特なので、
 * 設定に書いたとおりの文字列をそのまま再現できるようにしてある。
 *
 * @param {object|null} config { base: string, params?: object }
 * @param {object} values { threadId, messageId, parentId, tenantId }
 * @returns {string|null}
 */
export function buildPermalink(config, values = {}) {
  if (!config || !config.base) return null;
  const base = fillTemplate(config.base, values, false);
  if (base == null) return null;

  const query = Object.entries(config.params || {})
    .map(([key, template]) => [key, fillTemplate(template, values, true)])
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  return query.length > 0 ? `${base}?${query.join('&')}` : base;
}

/**
 * '{a}/{b}' を values で埋める。埋まらないプレースホルダがあれば null。
 * @param {boolean} encodeValues 埋めた値を URL エンコードするか（地の文は常にそのまま）
 */
function fillTemplate(template, values, encodeValues) {
  if (typeof template !== 'string') return null;
  let missing = false;
  const filled = template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    if (value == null || value === '') {
      missing = true;
      return '';
    }
    return encodeValues ? encodeURIComponent(value) : String(value);
  });
  return missing ? null : filled;
}

function stripInternal(message) {
  const copy = { ...message };
  delete copy._domOrder;
  if (copy.timestampRaw === undefined) delete copy.timestampRaw;
  return copy;
}

function byTimestampThenDomOrder(a, b) {
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a._domOrder - b._domOrder;
}

function uniqueAuthors(messages) {
  const set = new Set();
  for (const m of messages) if (m.author) set.add(m.author);
  return Array.from(set);
}

/**
 * 日時の ISO 8601 化。
 * 優先順: datetime 属性（機械可読） > aria-label（「2026年7月23日 15:56」「昨日の 19:18」）> 表示テキスト（「07/23 15:56」「13:47」）。
 * Teams の <time> には datetime 属性が無かった（キャリブレーション時点）ため、実際は aria-label が主経路。
 * 直近のメッセージは「昨日の 19:18」「13:47」のような相対表記になり、
 * 基準日（meta.capturedAt）が無いと日付を決められない。その場合は勝手に埋めず null にして警告する。
 * 秒は DOM に存在しないため常に :00（precision='minute'）。
 */
export function toIsoTimestamp(timestamp, patterns, options = {}) {
  const { offset = '+09:00', assumeYear = null, capturedAt = null } = options;
  const attrs = (timestamp && timestamp.attributes) || {};
  const text = timestamp && timestamp.text;
  const candidates = [attrs['aria-label'], text].filter(Boolean).map(normalizeSpace);

  // chat の <time> には datetime="2026-08-06T05:42:24.704Z"（UTC・秒つき）がある。
  // 最も正確な情報源なので最優先で使い、出力タイムゾーンに合わせて整形する。
  const datetime = attrs.datetime;
  if (datetime) {
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.getTime())) {
      return { iso: formatWithOffset(parsed, offset), precision: 'second' };
    }
  }

  for (const value of candidates) {
    // 2026年7月23日 15:56
    let m = patterns.timestampAriaLabel && patterns.timestampAriaLabel.exec(value);
    if (m) {
      const [, y, mo, d, h, mi] = m;
      return { iso: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${offset}`, precision: 'minute' };
    }

    // 昨日の 19:18 / 13:47（今日）— 基準日が要る
    for (const [key, shift, precision] of [
      ['timestampYesterday', -1, 'minute-relative'],
      ['timestampToday', 0, 'minute-relative'],
    ]) {
      m = patterns[key] && patterns[key].exec(value);
      if (!m) continue;
      const baseDate = capturedAt ? String(capturedAt).slice(0, 10) : null;
      if (!baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
        return {
          iso: null,
          precision: null,
          code: 'timestamp-relative-unresolved',
          detail: `「${value}」は相対表記のため、meta.capturedAt（取得日時）が無いと日付を決められません`,
        };
      }
      const [, h, mi] = m;
      return { iso: `${shiftDate(baseDate, shift)}T${pad(h)}:${pad(mi)}:00${offset}`, precision };
    }

    // 07/23 15:56（年が無い）
    m = patterns.timestampTextShort && patterns.timestampTextShort.exec(value);
    if (m) {
      const [, mo, d, h, mi] = m;
      const year = assumeYear || (capturedAt ? String(capturedAt).slice(0, 4) : null);
      if (!year) {
        return {
          iso: null,
          precision: null,
          code: 'timestamp-year-unknown',
          detail: `表示テキスト「${value}」には年が含まれていません（options.assumeYear か meta.capturedAt が必要）`,
        };
      }
      return { iso: `${pad(year, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${offset}`, precision: 'minute-assumed-year' };
    }
  }

  return { iso: null, precision: null };
}

/** 編集時刻の title を ISO 8601 にする。相対表記（今日/昨日）は capturedAt を基準にする */
function parseEditedAt(title, patterns, offset, capturedAt) {
  if (!title) return { iso: null };
  const text = normalizeSpace(title);

  const abs = patterns.editedAbsolute && patterns.editedAbsolute.exec(text);
  if (abs) {
    const [, y, mo, d, h, mi] = abs;
    return { iso: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${offset}` };
  }

  const rel = patterns.editedRelative && patterns.editedRelative.exec(text);
  if (rel) {
    const baseDate = capturedAt ? String(capturedAt).slice(0, 10) : null;
    if (!baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return { iso: null };
    const [, word, h, mi] = rel;
    const date = word === '昨日' ? shiftDate(baseDate, -1) : baseDate;
    return { iso: `${date}T${pad(h)}:${pad(mi)}:00${offset}` };
  }
  return { iso: null };
}

/** UTC の Date を、指定オフセット（例 '+09:00'）付きの ISO 8601 文字列にする */
function formatWithOffset(date, offset) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return date.toISOString();
  const sign = m[1] === '-' ? -1 : 1;
  const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date(date.getTime() + minutes * 60000);
  return `${shifted.toISOString().slice(0, 19)}${offset}`;
}

/** 'YYYY-MM-DD' を days 日ずらす（タイムゾーン変換はしない純粋な日付計算） */
function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 「1 件の いいね! リアクション。」→ { type: 'いいね!', typeId: 'yes', count: 1, emoji: '👍' }
 * type は UI 言語依存の表示名、typeId は img[itemid] 由来の言語非依存の識別子。
 */
export function parseReaction(reaction, patterns) {
  const label = reaction && reaction.label ? normalizeSpace(reaction.label) : null;
  const result = {
    type: null,
    typeId: reaction ? reaction.emojiId || null : null,
    count: null,
    emoji: reaction ? reaction.emoji || null : null,
    label,
  };
  if (label && patterns.reactionLabel) {
    const m = patterns.reactionLabel.exec(label);
    if (m) {
      result.count = Number(m[1]);
      result.type = m[2];
    }
  }
  if (!result.type) result.type = result.emoji;
  return result;
}

function parseFirstInt(text, pattern) {
  if (!text || !pattern) return null;
  const m = pattern.exec(normalizeSpace(text));
  return m ? Number(m[1]) : null;
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}
