/**
 * 抽出コア（DOM → 生メッセージ）。
 *
 * - 純粋関数。document / window に触れず、渡された DOM ルート要素の配下だけを見る。
 *   そのため方式A（ブラウザ内）でも方式B（Playwright / jsdom）でも同じものを呼べる。
 * - セレクタはすべて第2引数の設定（selectors.json）から来る。コード内にセレクタを書かない。
 * - ここでは「DOM から文字列を取り出す」ところまでを行い、日時の ISO 化や件数の数値化は
 *   normalize.js に任せる（責務分離）。
 * - 取りこぼしは必ず warnings に積む。黙って捨てない（CLAUDE.md 原則4）。
 */

import { htmlToMarkdown } from './html-to-markdown.js';
import {
  closestWithin,
  compilePatterns,
  findById,
  hash32,
  idSuffix,
  isUnset,
  normalizeSpace,
  queryAll,
  queryFirst,
  querySelfOrAll,
  textOf,
} from './selector-utils.js';

/**
 * @param {Element} rootEl 会話ペイン、または 1 つのメッセージ箱、または 1 メッセージ
 * @param {object} selectors selectors.json をパースしたもの
 * @param {object} options { profile?: string, mergeAdjacentMentions?: boolean }
 * @returns {{profile: string, messages: Array, boxes: Array, warnings: Array}}
 */
export function extractConversation(rootEl, selectors, options = {}) {
  const profileName = options.profile || 'channel';
  const sel = selectors && selectors.profiles ? selectors.profiles[profileName] : null;
  const warnings = [];

  if (!rootEl || rootEl.nodeType !== 1) {
    throw new TypeError('extractConversation: rootEl に DOM 要素を渡してください');
  }
  if (!sel) {
    throw new Error(`extractConversation: selectors.profiles.${profileName} が定義されていません`);
  }

  for (const key of ['messageBox', 'messageUnit', 'author', 'timestamp', 'body']) {
    if (isUnset(sel[key])) {
      warnings.push({
        level: 'fatal',
        code: 'selector-unset',
        detail: `selectors.profiles.${profileName}.${key} が未設定です（キャリブレーションが必要）`,
      });
    }
  }
  // システムメッセージは既定で出力対象外（normalize 側で除外）。
  // 明示的に含める指定のときだけ、判別できない旨を知らせる。
  if (options.includeSystem === true && isUnset(sel.systemMessage)) {
    warnings.push({
      level: 'info',
      code: 'system-message-detection-unavailable',
      detail: 'システムメッセージ判別用セレクタが未設定のため、このプロファイルでは判別できません',
    });
  }

  let boxes = querySelfOrAll(rootEl, sel.messageBox);
  let boxesAreSynthetic = false;
  if (boxes.length === 0) {
    // 箱が見つからない場合でも、メッセージ単体が渡された可能性を拾う
    const loneUnits = querySelfOrAll(rootEl, sel.messageUnit);
    if (loneUnits.length > 0) {
      boxes = [rootEl];
      boxesAreSynthetic = true;
      warnings.push({
        level: 'warn',
        code: 'message-box-not-found',
        detail: 'messageBox が見つからないため、ルート直下のメッセージ単位のみを抽出しました（返信の親子関係は解決できません）',
      });
    }
  }

  const messages = [];
  const boxInfos = [];
  const patterns = compilePatterns(selectors.patterns || {});

  boxes.forEach((box, boxIndex) => {
    const info = extractBox(box, sel, {
      ...options,
      patterns,
      boxIndex,
      boxesAreSynthetic,
      messages,
      warnings,
    });
    boxInfos.push(info);
  });

  // 箱に属さないシステムメッセージ（chat の control-message-renderer は独立した項目として並ぶ）も
  // 数えられるように、ルート全体を対象に取りこぼしを拾う。出力に含めるかは normalize 側の判断。
  for (const el of querySelfOrAll(rootEl, sel.systemMessage)) {
    if (boxes.some((box) => box === el || box.contains(el))) continue;
    const message = extractSystemMessage(el, sel, { boxId: null, domOrder: messages.length });
    messages.push(message);
    for (const w of message.warnings) warnings.push({ ...w, messageId: message.id });
  }

  if (messages.length === 0) {
    warnings.push({
      level: 'fatal',
      code: 'no-messages-extracted',
      detail: '1 件も抽出できませんでした。DOM 構造が変わった可能性があります（selectors.json の更新が必要）',
    });
  }

  return { profile: profileName, messages, boxes: boxInfos, warnings };
}

/* ------------------------------------------------------------------ */

function extractBox(box, sel, ctx) {
  const boxId = attr(box, 'id');
  const replyContainerEl = ctx.boxesAreSynthetic ? null : queryFirst(box, sel.replyContainer);
  const units = querySelfOrAll(box, sel.messageUnit);

  const info = {
    boxId,
    boxIndex: ctx.boxIndex,
    postId: null,
    replyCountLabel: replyContainerEl ? attr(replyContainerEl, 'aria-label') : null,
    replyCountExtracted: 0,
    messageIds: [],
  };

  let previous = null;

  units.forEach((unit) => {
    const message = extractMessage(unit, sel, {
      mergeAdjacentMentions: ctx.mergeAdjacentMentions,
      patterns: ctx.patterns,
      domOrder: ctx.messages.length,
      boxId,
    });

    // 連続投稿はヘッダがまとめられ、送信者・日時が DOM に出ない。
    // 直前のメッセージから引き継ぎ、引き継いだことを記録する（黙って埋めない）。
    inheritFromPrevious(message, previous);
    previous = message;

    // 親子関係は data-reply-chain-id 属性が最優先。取れない場合のみ DOM 位置で判定する。
    const isReply =
      message.parentId != null
        ? true
        : Boolean(replyContainerEl && replyContainerEl.contains(unit) && replyContainerEl !== unit);

    if (isReply) {
      info.replyCountExtracted += 1;
      if (message.parentId == null) {
        message.parentId = info.postId;
        if (!info.postId) {
          message.warnings.push({
            level: 'warn',
            code: 'parent-not-resolved',
            detail: '返信の親投稿が同じ箱の中に見つかりませんでした',
          });
        }
      }
    } else if (!info.postId) {
      info.postId = message.id;
    }

    info.messageIds.push(message.id);
    ctx.messages.push(message);
    for (const w of message.warnings) ctx.warnings.push({ ...w, messageId: message.id });
  });

  // システムメッセージ（参加/退出/名称変更など）。内部構造は未確定なので、
  // 表示テキストと日時だけを最低限拾って system: true で残す（黙って落とさない）。
  for (const el of querySelfOrAll(box, sel.systemMessage)) {
    if (units.some((u) => u === el || u.contains(el) || el.contains(u))) continue;
    const message = extractSystemMessage(el, sel, { boxId, domOrder: ctx.messages.length });
    info.messageIds.push(message.id);
    ctx.messages.push(message);
    for (const w of message.warnings) ctx.warnings.push({ ...w, messageId: message.id });
  }

  if (info.messageIds.length === 0) {
    ctx.warnings.push({
      level: 'warn',
      code: 'empty-message-box',
      detail: `箱 ${boxId || `#${ctx.boxIndex}`} からメッセージ単位を 1 件も取り出せませんでした`,
    });
  }

  return info;
}

/** システムメッセージの最小抽出（構造が未確定なため、テキストと日時のみ） */
function extractSystemMessage(el, sel, options) {
  const warnings = [{
    level: 'info',
    code: 'system-message-minimal',
    detail: 'システムメッセージの内部構造は未確定のため、表示テキストのみ記録しました',
  }];
  const host = queryFirst(el, sel.messageIdHost);
  const id = (host && sel.messageIdAttr ? attr(host, sel.messageIdAttr) : null)
    || idSuffix(el, sel.messageUnitIdPrefix)
    || `system:${hash32(textOf(el))}`;

  return {
    id,
    parentId: null,
    boxId: options.boxId || null,
    domOrder: options.domOrder ?? 0,
    author: null,
    authorInherited: false,
    timestamp: readTimestamp(queryFirst(el, sel.timestamp), sel),
    timestampInherited: false,
    subject: null,
    bodyMarkdown: textOf(el),
    bodyText: textOf(el),
    mentions: [],
    linkPreviews: [],
    deepLinks: [],
    reactions: [],
    attachments: [],
    cards: [],
    links: [],
    edited: false,
    editedLabel: null,
    deleted: false,
    system: true,
    warnings,
  };
}

/**
 * メッセージ 1 件分の抽出。単体でもテストできるよう公開する。
 * @param {Element} unit  messageUnit セレクタに一致する要素
 */
export function extractMessage(unit, sel, options = {}) {
  const warnings = [];
  const patterns = options.patterns || {};
  const id = resolveMessageId(unit, sel, warnings);
  const ids = sel.idTemplates || {};

  const authorEl = byTemplateOrSelector(unit, ids.author, id, sel.author);
  const author = textOf(authorEl);

  const timestampEl = byTemplateOrSelector(unit, ids.timestamp, id, sel.timestamp);
  const timestamp = readTimestamp(timestampEl, sel);

  const subjectEl = byTemplateOrSelector(unit, ids.subject, id, sel.subject);
  const bodyEl = byTemplateOrSelector(unit, ids.body, id, sel.body);
  if (!bodyEl) {
    warnings.push({ level: 'warn', code: 'body-missing', detail: '本文要素が見つかりませんでした' });
  }

  const rendered = htmlToMarkdown(bodyEl, sel, {
    mergeAdjacentMentions: options.mergeAdjacentMentions !== false,
    patterns,
  });
  for (const w of rendered.warnings) warnings.push({ level: 'info', ...w });

  if (isCollapsed(unit, sel, patterns)) {
    warnings.push({
      level: 'warn',
      code: 'collapsed-body',
      detail: '「詳細を表示」で折りたたまれた本文です。DOM 上に全文があるか未検証のため、取りこぼしの可能性があります',
    });
  }

  const editedEl = byTemplateOrSelector(unit, ids.edited, id, sel.edited);
  const deletedEl = byTemplateOrSelector(unit, ids.deleted, id, sel.deleted);

  return {
    id,
    parentId: resolveParentId(unit, sel, id),
    boxId: options.boxId || null,
    domOrder: options.domOrder ?? 0,
    author,
    authorInherited: false,
    timestamp,
    timestampInherited: false,
    subject: subjectEl ? textOf(subjectEl) : null,
    bodyMarkdown: rendered.markdown,
    bodyText: bodyEl ? textOf(bodyEl) : '',
    mentions: rendered.mentions,
    linkPreviews: extractLinkPreviews(unit, sel),
    deepLinks: extractDeepLinks(unit, sel),
    reactions: extractReactions(unit, sel, warnings),
    attachments: extractAttachments(unit, sel, id, patterns, warnings),
    cards: rendered.cards,
    links: rendered.links,
    edited: Boolean(editedEl),
    editedLabel: editedEl ? textOf(editedEl) : null,
    // 編集時刻は「2026年8月4日 17:06 に編集しました」の形で title 属性に入っている
    editedTitle: editedEl && sel.editedTimeAttr ? attr(editedEl, sel.editedTimeAttr) : null,
    deleted: Boolean(deletedEl),
    system: false,
    warnings,
  };
}

/* ---- 各フィールド --------------------------------------------------- */

/**
 * 連続投稿（グループ化）で送信者・日時が省略されたメッセージを、直前のメッセージで補う。
 * 補ったことは *Inherited フラグと警告に残す。補えない場合は欠落のまま警告する。
 */
function inheritFromPrevious(message, previous) {
  if (!message.author) {
    if (previous && previous.author) {
      message.author = previous.author;
      message.authorInherited = true;
      message.warnings.push({
        level: 'info',
        code: 'author-inherited',
        detail: `送信者が DOM に無いため、直前のメッセージ（${previous.id}）から引き継ぎました（連続投稿のグループ化）`,
      });
    } else {
      message.warnings.push({
        level: 'warn',
        code: 'author-missing',
        detail: '送信者名を取得できず、引き継ぎ元もありませんでした',
      });
    }
  }

  const hasTimestamp = message.timestamp && (message.timestamp.text || Object.keys(message.timestamp.attributes || {}).length > 0);
  if (!hasTimestamp) {
    if (previous && previous.timestamp) {
      message.timestamp = previous.timestamp;
      message.timestampInherited = true;
      message.warnings.push({
        level: 'info',
        code: 'timestamp-inherited',
        detail: `日時が DOM に無いため、直前のメッセージ（${previous.id}）の日時を引き継ぎました。分単位の正確さは保証されません`,
      });
    } else {
      message.warnings.push({
        level: 'warn',
        code: 'timestamp-missing',
        detail: '日時要素が見つからず、引き継ぎ元もありませんでした',
      });
    }
  }
}

/**
 * 「詳細を表示」で実際に折りたたまれているか。
 * 入れ物自体は折りたたまれていないメッセージにも常に存在し、
 * 区別はインライン style の display:none だけ（意味的属性の差が無い）。
 * その判定パターンも selectors.json 側（patterns.hiddenStyle）に外だししてある。
 */
function isCollapsed(unit, sel, patterns) {
  for (const el of queryAll(unit, sel.collapsedBody)) {
    const style = attr(el, 'style') || '';
    if (!patterns.hiddenStyle || !patterns.hiddenStyle.test(style)) return true;
  }
  return false;
}

function resolveMessageId(unit, sel, warnings) {
  const host = queryFirst(unit, sel.messageIdHost);
  const fromAttr = host && sel.messageIdAttr ? attr(host, sel.messageIdAttr) : null;
  const fromId = idSuffix(unit, sel.messageUnitIdPrefix);

  if (fromAttr && fromId && fromAttr !== fromId) {
    warnings.push({
      level: 'warn',
      code: 'message-id-mismatch',
      detail: `${sel.messageIdAttr}=${fromAttr} と id 接尾辞=${fromId} が一致しません`,
    });
  }
  const id = fromAttr || fromId;
  if (id) return id;

  // §4: 一意属性が取れない場合は「送信者＋日時＋本文」から代替キーを作る
  const fallbackSource = [
    textOf(queryFirst(unit, sel.author)),
    textOf(queryFirst(unit, sel.timestamp)),
    textOf(queryFirst(unit, sel.body)),
  ].join('');
  warnings.push({
    level: 'warn',
    code: 'synthetic-id',
    detail: 'メッセージIDを DOM から取得できず、内容ハッシュで代替しました',
  });
  return `synthetic:${hash32(fallbackSource)}`;
}

/**
 * 親メッセージID。返信では data-reply-chain-id が親投稿の mid を指し、
 * 親投稿自身では data-mid と同じ値になる（＝自己参照なら親なし）。
 */
function resolveParentId(unit, sel, ownId) {
  const host = queryFirst(unit, sel.parentIdHost);
  const value = host && sel.parentIdAttr ? attr(host, sel.parentIdAttr) : null;
  if (!value || value === ownId) return null;
  return value;
}

function readTimestamp(el, sel) {
  if (!el) return { text: null, attributes: {} };
  const attributes = {};
  const wanted = Array.isArray(sel.timestampAttr) ? sel.timestampAttr : [sel.timestampAttr].filter(Boolean);
  for (const name of wanted) {
    const value = attr(el, name);
    if (value != null) attributes[name] = value;
  }
  return { text: textOf(el) || null, attributes };
}

/**
 * リンクのカード型プレビュー。本文（message-body）の外側・メッセージ単位の内側にあり、
 * プレビュー先の URL は本文に出てこないことがある（＝拾わないと情報が落ちる）。
 */
function extractLinkPreviews(unit, sel) {
  return queryAll(unit, sel.linkPreview).map((preview) => {
    const titleEl = queryFirst(preview, sel.linkPreviewTitle);
    const anchor = closestWithin(preview, sel.linkPreviewLink, unit);
    return {
      title: (titleEl && (attr(titleEl, 'title') || textOf(titleEl))) || null,
      url: anchor ? attr(anchor, 'href') : null,
    };
  });
}

/**
 * ディープリンクのチクレット（タブやワークスペースへのリンク）。
 * 添付ファイルとは別物で、DOM 上も [data-tid='deeplink-attachment-grid'] という別のグリッドに入る。
 * URL は DOM に出ていないことがあるため、名前だけでも残す（黙って捨てない）。
 */
function extractDeepLinks(unit, sel) {
  const grid = queryFirst(unit, sel.deepLinkGrid);
  if (!grid) return [];
  return queryAll(grid, sel.deepLinkItem).map((item) => {
    const link = queryFirst(item, sel.link);
    return {
      name: textOf(item) || attr(item, 'aria-label') || null,
      url: link ? attr(link, 'href') : null,
    };
  });
}

function extractReactions(unit, sel, warnings) {
  const summary = queryFirst(unit, sel.reactionSummary);
  if (!summary) return [];
  const pills = queryAll(summary, sel.reactionPill);
  if (pills.length === 0) return [];

  return pills.map((pill) => {
    const emojiEl = queryFirst(pill, sel.reactionEmoji);
    const emoji = emojiEl ? attr(emojiEl, 'alt') : null;
    // itemid は UI 言語に依存しない短縮名（yes / bowing / ok9;0-... 等）
    const emojiId = emojiEl && sel.emojiIdAttr ? attr(emojiEl, sel.emojiIdAttr) : null;
    const label = readLabelledBy(pill, unit, sel) || textOf(pill) || null;
    if (!label) {
      warnings.push({
        level: 'info',
        code: 'reaction-label-missing',
        detail: 'リアクションの件数ラベルを取得できませんでした（件数は不明）',
      });
    }
    return { emoji: emoji || null, emojiId: emojiId || null, label };
  });
}

/** aria-labelledby が指す要素のテキストを、同じメッセージ単位の中から解決する。 */
function readLabelledBy(el, scope, sel) {
  const refAttr = sel.reactionLabelRefAttr;
  if (!refAttr) return null;
  const raw = attr(el, refAttr);
  if (!raw) return null;
  const texts = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((refId) => textOf(findById(scope, refId)))
    .filter(Boolean);
  return texts.length > 0 ? normalizeSpace(texts.join(' ')) : null;
}

/**
 * 添付ファイル。
 * グリッド内にアンカーは無く、ファイル名は項目の aria-label、URL は
 * [data-testid='content-card-custom-title'] の aria-label 末尾（'{ファイル名} {URL}'）に入っている。
 * 宣言件数（グリッドの aria-label / numberoffiles）と取得件数が食い違ったら警告する。
 */
function extractAttachments(unit, sel, messageId, patterns, warnings) {
  const ids = sel.idTemplates || {};
  const container = byTemplateOrSelector(unit, ids.attachmentContainer, messageId, sel.attachmentContainer);
  if (!container) return [];

  const items = queryAll(container, sel.attachmentItem);
  const attachments = items.map((item) => {
    const titleEl = queryFirst(item, sel.attachmentTitle);
    const titleLabel = titleEl ? attr(titleEl, sel.attachmentTitleAttr) : null;
    const name = attr(item, sel.attachmentNameAttr) || textOf(titleEl) || null;
    let url = null;
    if (titleLabel && patterns.attachmentUrl) {
      const m = patterns.attachmentUrl.exec(titleLabel);
      if (m) url = m[1];
    }
    if (!url) {
      const link = queryFirst(item, sel.attachmentLink);
      if (link) url = attr(link, 'href');
    }
    if (!url) {
      warnings.push({
        level: 'warn',
        code: 'attachment-url-missing',
        detail: `添付「${name || '(名前不明)'}」の URL を取り出せませんでした（ファイル名のみ記録）`,
      });
    }
    return { name, url };
  });

  const declared = declaredAttachmentCount(container, items, sel, patterns);
  if (declared != null && declared !== attachments.length) {
    warnings.push({
      level: 'warn',
      code: 'attachment-count-mismatch',
      detail: `添付は ${declared} 件と表示されていますが ${attachments.length} 件しか取り出せませんでした`,
    });
  }
  if (attachments.length === 0) {
    warnings.push({
      level: 'warn',
      code: 'attachment-unrecognized',
      detail: '添付コンテナはあるが中身を解釈できませんでした（selectors.json の attachmentItem 要調整）',
    });
  }
  return attachments;
}

function declaredAttachmentCount(container, items, sel, patterns) {
  const fromAttr = items.length > 0 && sel.attachmentCountAttr ? attr(items[0], sel.attachmentCountAttr) : null;
  if (fromAttr && /^\d+$/.test(fromAttr)) return Number(fromAttr);
  const label = attr(container, 'aria-label');
  if (label && patterns.attachmentCountLabel) {
    const m = patterns.attachmentCountLabel.exec(normalizeSpace(label));
    if (m) return Number(m[1]);
  }
  return null;
}

/* ---- 小物 ----------------------------------------------------------- */

/** id テンプレート（"author-{mid}" 等）で引き、駄目ならセレクタで引く。 */
function byTemplateOrSelector(scope, template, messageId, selector) {
  if (template && messageId && !String(messageId).startsWith('synthetic:')) {
    const el = findById(scope, template.replace('{mid}', messageId));
    if (el) return el;
  }
  return queryFirst(scope, selector);
}

function attr(el, name) {
  return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
}
