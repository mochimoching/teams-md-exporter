/**
 * Teams 会話履歴エクスポータ（コンソール貼り付け）— 収集して Markdown を保存する
 *
 * 自動生成: node tools/build-console-script.js（直接編集しない。src/ を直す）
 * 版: 0.1.0 / 生成元セレクタ: selectors.json
 *
 * 常用するならユーザースクリプト版（dist/teams-md-exporter.user.js）のほうが手数が少ない。
 *
 * 使い方:
 *   1. Teams Web で対象のチャネル or チャットを開く
 *   2. F12 → Console → このファイルの中身を全部貼って Enter
 *   3. 進捗と結果サマリがコンソールに出て、.md ファイルが保存される
 *      （中間データは window.TEAMS_RESULT、Markdown は window.TEAMS_FILES）
 *
 * 既定は控えめ（最大 20 周・90 秒）。全部遡るときは実行前に:
 *   window.TEAMS_COLLECT = { maxSteps: 400, maxDurationMs: 600000 };
 * 返信スレッドも開いて取るとき（実験的・Esc で閉じます）:
 *   window.TEAMS_COLLECT = { expandReplies: true };
 * 保存せず結果だけ見たいとき:
 *   window.TEAMS_SAVE_MD = false;
 * リンクが Teams アプリで開かないとき（実物の URL は投稿の「…」→「リンクをコピー」で確認できる）:
 *   window.TEAMS_COLLECT = { tenantId: '…', groupId: '…' };
 *
 * 行うのは会話ペインのスクロールと「詳細を表示」の展開だけです。
 * 認証情報には触れず、ネットワークへ送信もしません（CLAUDE.md 原則1・2）。
 */

(async () => {
'use strict';
/* ==== src/selector-utils.js ==== */
/**
 * セレクタ設定（selectors.json）を扱う小さなヘルパ群。
 *
 * - 設定値は「CSS セレクタ文字列」または「優先順に試す文字列の配列」。
 * - ここにセレクタそのものは一切書かない（CLAUDE.md 原則3）。
 * - DOM グローバル（document / window）に触れない。渡された要素の API だけを使う。
 */

/** 設定値を配列に正規化する。null / undefined / 空配列は「未設定」。 */
function toSelectorList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((s) => typeof s === 'string' && s.trim() !== '');
}

/** 未設定（＝キャリブレーション未了）かどうか。 */
function isUnset(value) {
  return toSelectorList(value).length === 0;
}

/** 優先順に試して最初に見つかった 1 要素を返す。root 自身は含めない。 */
function queryFirst(root, value) {
  for (const sel of toSelectorList(value)) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 優先順に試して、最初に 1 件以上ヒットしたセレクタの結果をすべて返す。 */
function queryAll(root, value) {
  for (const sel of toSelectorList(value)) {
    const els = Array.from(root.querySelectorAll(sel));
    if (els.length > 0) return els;
  }
  return [];
}

/** root 自身も候補に含めて検索する（呼び出し側が単一メッセージを root に渡す場合に必要）。 */
function querySelfOrAll(root, value) {
  const found = queryAll(root, value);
  if (matchesAny(root, value) && !found.includes(root)) return [root, ...found];
  return found;
}

/** 要素がいずれかのセレクタに一致するか。 */
function matchesAny(el, value) {
  if (!el || typeof el.matches !== 'function') return false;
  return toSelectorList(value).some((sel) => el.matches(sel));
}

/** boundary の内側に限定した closest。境界外まで遡らない。 */
function closestWithin(el, value, boundary) {
  const selectors = toSelectorList(value);
  if (selectors.length === 0) return null;
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (selectors.some((sel) => cur.matches(sel))) return cur;
    if (cur === boundary) return null;
    cur = cur.parentElement;
  }
  return null;
}

/** 属性値を CSS セレクタに埋め込むためのエスケープ（id に ';' 等が含まれるため必要）。 */
function escapeAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** root の内側（root 自身を含む）から id 一致の要素を探す。document.getElementById は使わない。 */
function findById(root, id) {
  if (!id) return null;
  const sel = `[id="${escapeAttrValue(id)}"]`;
  if (typeof root.matches === 'function' && root.matches(sel)) return root;
  return root.querySelector(sel);
}

/** `[id^='prefix-']` 形式の id から接尾辞（多くは message id）を取り出す。 */
function idSuffix(el, prefix) {
  const id = el && el.getAttribute ? el.getAttribute('id') : null;
  if (!id || !prefix || !id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return rest === '' ? null : rest;
}

/** selectors.json の patterns（文字列の正規表現）をまとめてコンパイルする。 */
function compilePatterns(patterns = {}) {
  const compiled = {};
  for (const [key, source] of Object.entries(patterns)) {
    if (typeof source !== 'string' || source === '') continue;
    try {
      compiled[key] = new RegExp(source);
    } catch {
      compiled[key] = null;
    }
  }
  return compiled;
}

/** 空白（&nbsp; 含む）を潰したテキスト。 */
function normalizeSpace(text) {
  return String(text == null ? '' : text)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 要素の textContent を空白正規化して返す。 */
function textOf(el) {
  return el ? normalizeSpace(el.textContent) : '';
}

/** FNV-1a 32bit。メッセージIDが取れない場合の代替キー生成用（§4）。 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ==== src/html-to-markdown.js ==== */
/**
 * 本文 HTML → Markdown 変換（仕様書 §6.3 の写像ルール）。
 *
 * 純粋関数。DOM ノードとセレクタ設定だけを受け取り、文字列と警告を返す。
 * class 名には一切依存しない（itemtype / role / data-tid のみ）。
 */


const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const INLINE_WRAPPERS = {
  strong: '**',
  b: '**',
  em: '*',
  i: '*',
  s: '~~',
  strike: '~~',
  del: '~~',
};

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tbody', 'thead', 'tr', 'hr',
]);

/**
 * @param {Element} bodyEl 本文ルート（[data-tid='message-body'] 等）
 * @param {object} sel     selectors.json の profile
 * @param {object} options { mergeAdjacentMentions?: boolean }
 * @returns {{ markdown: string, warnings: Array, cards: Array, links: Array }}
 */
function htmlToMarkdown(bodyEl, sel, options = {}) {
  const ctx = {
    sel,
    patterns: options.patterns || {},
    options: { mergeAdjacentMentions: true, ...options },
    warnings: [],
    cards: [],
    links: [],
    mentions: [],
  };
  if (!bodyEl) {
    return { markdown: '', warnings: [], cards: [], links: [], mentions: [] };
  }
  const md = renderChildren(bodyEl, ctx, { listDepth: 0 });
  return {
    markdown: tidy(md),
    warnings: ctx.warnings,
    cards: ctx.cards,
    links: ctx.links,
    mentions: ctx.mentions,
  };
}

/* ------------------------------------------------------------------ */

function renderChildren(el, ctx, state) {
  const parts = [];
  const children = Array.from(el.childNodes);

  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];

    // メンションの連続を 1 人分にまとめる（Teams は表示名を単語ごとに分割して描画する）
    if (ctx.options.mergeAdjacentMentions && node.nodeType === ELEMENT_NODE) {
      const run = collectMentionRun(children, i, ctx);
      if (run) {
        ctx.mentions.push({ name: run.name, mri: run.mri });
        parts.push(`**@${run.name}**`);
        i = run.nextIndex - 1;
        continue;
      }
    }

    parts.push(renderNode(node, ctx, state));
  }
  return parts.join('');
}

function renderNode(node, ctx, state) {
  if (node.nodeType === TEXT_NODE) return escapeInline(softSpace(node.nodeValue));
  if (node.nodeType !== ELEMENT_NODE) return '';

  const el = node;

  if (matchesAny(el, ctx.sel.ignoreInBody)) return '';

  // カード類など Markdown に落とせない要素は、捨てずに存在だけ残す（§6.3）
  const unsupportedLabel = unsupportedKindOf(el, ctx);
  if (unsupportedLabel) {
    const link = el.querySelector('a[href]');
    const url = link ? link.getAttribute('href') : null;
    const title = normalizeSpace(link ? link.textContent : '');
    ctx.cards.push({ kind: unsupportedLabel, title: title || null, url });
    ctx.warnings.push({ code: 'unsupported-element', detail: unsupportedLabel, url });
    return `\n\n<!-- 未対応要素: ${unsupportedLabel}${url ? ` (${url})` : ''} -->\n\n`;
  }

  const tag = (el.tagName || '').toLowerCase();

  if (matchesAny(el, ctx.sel.mention)) {
    const name = normalizeSpace(el.textContent);
    const wrapper = ctx.sel.mentionIdAttr ? el.closest(`[${ctx.sel.mentionIdAttr}]`) : null;
    ctx.mentions.push({ name, mri: wrapper ? wrapper.getAttribute(ctx.sel.mentionIdAttr) : null });
    return `**@${name}**`;
  }

  switch (tag) {
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'img':
      return renderImage(el, ctx);
    case 'a':
      return renderAnchor(el, ctx, state);
    case 'pre':
      return renderPre(el, ctx);
    case 'code':
      return `\`${normalizeSpace(el.textContent).replace(/`/g, '\\`')}\``;
    case 'ul':
    case 'ol':
      return renderList(el, ctx, state);
    case 'blockquote':
      return renderBlockquote(el, ctx, state);
    case 'table':
      return renderTable(el, ctx, state);
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n${'#'.repeat(Number(tag[1]))} ${inline(renderChildren(el, ctx, state))}\n\n`;
    default:
      break;
  }

  if (INLINE_WRAPPERS[tag]) {
    const inner = renderChildren(el, ctx, state);
    if (inline(inner) === '') return '';
    const mark = INLINE_WRAPPERS[tag];
    return `${mark}${inner.trim()}${mark}`;
  }

  const inner = renderChildren(el, ctx, state);
  if (BLOCK_TAGS.has(tag)) {
    return inner.trim() === '' ? '' : `\n\n${inner.trim()}\n\n`;
  }
  return inner;
}

/* ---- 個別要素 ------------------------------------------------------ */

function renderImage(el, ctx) {
  const alt = el.getAttribute('alt') || '';
  if (matchesAny(el, ctx.sel.emoji)) return alt; // Unicode 絵文字はそのまま
  if (matchesAny(el, ctx.sel.customEmoji)) return alt ? `:${alt}:` : ':emoji:'; // カスタム絵文字は :name:
  const src = el.getAttribute('src') || '';
  if (!src) return alt;
  // 本文に貼られた画像は blob: URL で、保存後には開けない。リンクにせず存在だけ残す（§6.3）
  if (ctx.patterns.skipImageUrl && ctx.patterns.skipImageUrl.test(src)) {
    ctx.warnings.push({ code: 'inline-image-dropped', detail: alt || null, url: src });
    return `\n\n<!-- 未対応要素: 画像（本文に貼られた画像は保存対象外） -->\n\n`;
  }
  ctx.warnings.push({ code: 'inline-image', detail: alt || null, url: src });
  return `![${alt || '画像'}](${src})`;
}

/** unsupported マップ（ラベル → セレクタ）に一致するラベルを返す */
function unsupportedKindOf(el, ctx) {
  const map = ctx.sel.unsupported;
  if (!map || typeof map !== 'object') return null;
  for (const [label, selector] of Object.entries(map)) {
    if (matchesAny(el, selector)) return label;
  }
  return null;
}

function renderAnchor(el, ctx, state) {
  const href = el.getAttribute('href') || '';
  const text = inline(renderChildren(el, ctx, state)) || href;
  if (!href || href === '#') return text;
  ctx.links.push({ text, url: href });
  if (text === href) return `<${href}>`;
  return `[${text}](${href})`;
}

/**
 * コードブロック。
 * Teams は <pre><code>行1<br>行2…</code></pre> の形で、**改行を <br> で表現する**。
 * textContent を使うと改行が消えて 1 行に潰れるため、<br> を明示的に改行へ戻す。
 * インデントは &nbsp; で表現されるので半角空白に落とす（空白を畳んではいけない）。
 * 言語名は DOM に出ていない（itemid は編集器の UUID）ため、フェンスに言語は付かない。
 */
function renderPre(el, ctx) {
  const lang = codeLanguageOf(el, ctx);
  const raw = codeTextOf(el).replace(/\s+$/, '');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(raw) + 1));
  return `\n\n${fence}${lang}\n${raw}\n${fence}\n\n`;
}

/**
 * コードブロックの言語名。
 * <pre> 自身ではなく、直前の兄弟にあるヘッダ（[data-tid='code-block-editor-deserialized-language']、
 * 表示は "Plain Text" 等）に入っている。Markdown のフェンス用に小文字・空白なしへ寄せる。
 */
function codeLanguageOf(el, ctx) {
  const selectors = toSelectorList(ctx.sel.codeBlockLanguage);
  if (selectors.length === 0) return '';
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if ((sib.tagName || '').toLowerCase() === 'pre') break; // 直前の別コードブロックまで遡らない
    const label = matchesAny(sib, ctx.sel.codeBlockLanguage) ? sib : sib.querySelector(selectors.join(','));
    if (label) return normalizeSpace(label.textContent).toLowerCase().replace(/\s+/g, '');
  }
  return '';
}

/** コード内のテキストを、改行（<br>）とインデント（&nbsp;）を保ったまま取り出す */
function codeTextOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      out += String(child.nodeValue).replace(/ /g, ' ');
    } else if (child.nodeType === ELEMENT_NODE) {
      out += (child.tagName || '').toLowerCase() === 'br' ? '\n' : codeTextOf(child);
    }
  }
  return out;
}

function renderList(el, ctx, state) {
  const ordered = (el.tagName || '').toLowerCase() === 'ol';
  const items = Array.from(el.children).filter((c) => (c.tagName || '').toLowerCase() === 'li');
  const indent = '  '.repeat(state.listDepth);
  const lines = items.map((li, index) => {
    const marker = ordered ? `${index + 1}. ` : '- ';
    const inner = renderChildren(li, ctx, { ...state, listDepth: state.listDepth + 1 });
    const body = inner
      .trim()
      .split('\n')
      .map((line, lineIndex) => (lineIndex === 0 ? line : `${indent}${' '.repeat(marker.length)}${line}`))
      .join('\n');
    return `${indent}${marker}${body}`;
  });
  return lines.length === 0 ? '' : `\n\n${lines.join('\n')}\n\n`;
}

function renderBlockquote(el, ctx, state) {
  const inner = tidy(renderChildren(el, ctx, state));
  if (inner === '') return '';
  const quoted = inner
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return `\n\n${quoted}\n\n`;
}

function renderTable(el, ctx, state) {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((c) => ['td', 'th'].includes((c.tagName || '').toLowerCase()))
      .map((cell) => inline(renderChildren(cell, ctx, state)).replace(/\|/g, '\\|')),
  );
  const width = Math.max(...grid.map((r) => r.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] || '').join(' | ')} |`;
  const out = [line(grid[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const row of grid.slice(1)) out.push(line(row));
  return `\n\n${out.join('\n')}\n\n`;
}

/* ---- メンション連結 ------------------------------------------------ */

/**
 * children[start] から始まる「同一人物のメンション要素」の連続を検出する。
 * Teams は 1 人のメンションを単語単位の要素に分割して描画するため（サンプルでは
 * 1 人の表示名が 6 要素に分割されていた）、連続分を 1 つの表示名に結合する。
 * 別人が連続する場合は data-person-mri（mentionIdAttr）の変化で切る。
 * MRI が取れない場合のみ「連続していれば同一人物」というヒューリスティックになる。
 */
function collectMentionRun(children, start, ctx) {
  if (toSelectorList(ctx.sel.mention).length === 0) return null;
  const words = [];
  let mri = null;
  let mriSeen = false;
  let i = start;
  let consumedElement = false;

  while (i < children.length) {
    const node = children[i];
    if (node.nodeType === TEXT_NODE) {
      if (normalizeSpace(node.nodeValue) === '') {
        i += 1;
        continue;
      }
      break;
    }
    if (node.nodeType !== ELEMENT_NODE) break;

    const word = mentionTextOf(node, ctx);
    if (word == null) break;

    const nodeMri = ctx.sel.mentionIdAttr ? node.getAttribute(ctx.sel.mentionIdAttr) : null;
    if (nodeMri) {
      if (mriSeen && nodeMri !== mri) break; // 別人のメンションが続いている
      mri = nodeMri;
      mriSeen = true;
    }

    words.push(word);
    consumedElement = true;
    i += 1;
  }

  // 末尾の空白テキストノードは次の要素のために戻す
  while (i > start && children[i - 1] && children[i - 1].nodeType === TEXT_NODE) i -= 1;

  if (!consumedElement || words.length === 0) return null;
  return { name: words.join(' ').trim(), mri, nextIndex: i };
}

/** 要素が「メンションだけ」を含むなら、その表示テキストを返す。そうでなければ null。 */
function mentionTextOf(el, ctx) {
  const mentionSelectors = toSelectorList(ctx.sel.mention);
  if (mentionSelectors.length === 0) return null;
  const isWrapper = matchesAny(el, ctx.sel.mentionWrapper) || matchesAny(el, ctx.sel.mention);
  const self = matchesAny(el, ctx.sel.mention) ? el : el.querySelector(mentionSelectors.join(','));
  if (!self || !isWrapper) return null;
  const own = normalizeSpace(el.textContent);
  const mention = normalizeSpace(self.textContent);
  if (own !== mention || mention === '') return null;
  return mention;
}

/* ---- 文字列ユーティリティ ------------------------------------------ */

function softSpace(text) {
  return String(text == null ? '' : text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
}

function escapeInline(text) {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function inline(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function longestBacktickRun(text) {
  let max = 0;
  for (const m of String(text).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return max;
}

/** 連続する空行を 1 つに畳み、前後を落とす。 */
function tidy(markdown) {
  return String(markdown)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

/* ==== src/extract.js ==== */
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



/**
 * @param {Element} rootEl 会話ペイン、または 1 つのメッセージ箱、または 1 メッセージ
 * @param {object} selectors selectors.json をパースしたもの
 * @param {object} options { profile?: string, mergeAdjacentMentions?: boolean }
 * @returns {{profile: string, messages: Array, boxes: Array, warnings: Array}}
 */
function extractConversation(rootEl, selectors, options = {}) {
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

/**
 * いま開いている会話の ID（threadId）を DOM から読む。個々のメッセージへのリンク生成に使う。
 *
 * 目的の属性は会話ペインの外（入力欄の送信ボタンなど）にあるため、
 * 呼び出し側が広い検索ルート（ブラウザでは document.body 相当）を明示的に渡す。
 * ここでも document / window には触れない。
 *
 * ページ全体を正規表現で探す方式は使えない。左一覧に載っている全会話の ID や、
 * 本文に貼られた他会話へのリンク由来の ID が大量に混ざるため（selectors.json の _meta 参照）。
 * 「いま開いている会話に紐づく要素」だけを設定のセレクタで指名して読むこと。
 *
 * @param {Element} searchRoot 検索の起点。root 自身も候補に含む
 * @param {object} selectors selectors.json をパースしたもの
 * @param {object} options { profile?: string }
 * @returns {{threadId: string|null, warnings: Array}}
 */
function extractConversationId(searchRoot, selectors, options = {}) {
  const profileName = options.profile || 'channel';
  const sel = selectors && selectors.profiles ? selectors.profiles[profileName] : null;
  const warnings = [];

  if (!searchRoot || searchRoot.nodeType !== 1) {
    throw new TypeError('extractConversationId: searchRoot に DOM 要素を渡してください');
  }
  if (!sel || isUnset(sel.conversationIdHost) || !sel.conversationIdAttr) {
    warnings.push({
      level: 'warn',
      code: 'conversation-id-selector-unset',
      detail: `selectors.profiles.${profileName}.conversationIdHost / conversationIdAttr が未設定のため、会話 ID を取得できません`,
    });
    return { threadId: null, warnings };
  }

  const found = querySelfOrAll(searchRoot, sel.conversationIdHost)
    .map((el) => normalizeSpace(attr(el, sel.conversationIdAttr)))
    .filter(Boolean);
  const unique = [...new Set(found)];

  if (unique.length === 0) {
    warnings.push({
      level: 'warn',
      code: 'conversation-id-not-found',
      detail: '会話 ID を持つ要素が見つかりませんでした（入力欄が無い会話か、DOM 構造が変わった可能性があります）',
    });
    return { threadId: null, warnings };
  }
  if (unique.length > 1) {
    warnings.push({
      level: 'warn',
      code: 'conversation-id-ambiguous',
      detail: `会話 ID の候補が ${unique.length} 種類見つかりました（${unique.join(' / ')}）。先頭を採用しますが、リンク先が誤っている可能性があります`,
    });
  }
  return { threadId: unique[0], warnings };
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
function extractMessage(unit, sel, options = {}) {
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

/* ==== src/normalize.js ==== */
/**
 * 正規化（抽出結果 → 仕様書 §5 の中間データモデル）。
 *
 * 純粋関数。DOM にも時計にも触れない（capturedAt は呼び出し側が渡す）。
 * 文字列 → 型（ISO 日時 / 件数）の変換はここに集約する。
 */


const TOOL_VERSION = '0.1.0';

/**
 * @param {object} extraction extractConversation() の戻り値
 * @param {object} meta  { kind, team, channel, chatTitle, url, capturedAt, capturedBy, threadId }
 * @param {object} options { patterns, permalink?, tenantId?, groupId?, timezoneOffset?, assumeYear?,
 *   includeSystem?, since?（この日時より前は出力しない）, truncated? }
 * @returns {{source: object, participants: Array, messages: Array, stats: object, warnings: Array}}
 */
function normalize(extraction, meta = {}, options = {}) {
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
  let kept = includeSystem ? messages : messages.filter((m) => !m.system);
  if (!includeSystem && systemMessages.length > 0) {
    warnings.push({
      level: 'info',
      code: 'system-messages-excluded',
      detail: `システムメッセージ ${systemMessages.length} 件を出力から除外しました（options.includeSystem: true で含められます）`,
    });
  }
  // 取得範囲（options.since より前は出力しない）。スクロールは境界を少し越えて止まるため、
  // 指定範囲を厳密にするにはここで落とす必要がある。落とした件数は必ず残す（黙って消さない）。
  const rangeExcluded = [];
  if (options.since) {
    const limit = Date.parse(options.since);
    if (Number.isNaN(limit)) {
      warnings.push({
        level: 'warn',
        code: 'since-unparsed',
        detail: `取得範囲の開始日時「${options.since}」を解釈できませんでした（範囲を絞らずに出力します）`,
      });
    } else {
      kept = kept.filter((m) => {
        // 日時が取れなかったメッセージは判定できないので落とさない（取りこぼしを作らない）
        if (!m.timestamp) return true;
        const at = Date.parse(m.timestamp);
        if (Number.isNaN(at) || at >= limit) return true;
        rangeExcluded.push(m);
        return false;
      });
      if (rangeExcluded.length > 0) {
        warnings.push({
          level: 'info',
          code: 'out-of-range-excluded',
          detail: `取得範囲（${options.since} 以降）より古いメッセージ ${rangeExcluded.length} 件を出力から除外しました`,
        });
      }
    }
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
      rangeExcluded: rangeExcluded.length,
      since: options.since || null,
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
function parseConversationTitle(title, config, profile) {
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
 * 複数のタイトル候補から会話名を解決する。
 *
 * Teams はタイトルの更新が遅れることがあり、収集を始めた時点では会話名がまだ入っていない
 * （実機で `'(3) Planner | Microsoft Teams'` と、会話名を欠いた形を観測した）。
 * そのため開始時と終了時の両方を候補にして、名前が取れたほうを採用する。
 * 先に渡された候補を優先する（収集開始時点の会話を正とするため）。
 *
 * @param {Array<string>|string} titles 候補。並び順が優先順
 */
function resolveConversationTitle(titles, config, profile) {
  const list = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
  const tried = [];
  let lastResult = { team: null, channel: null, chatTitle: null, warnings: [] };

  for (const title of list) {
    if (tried.includes(title)) continue;
    tried.push(title);
    const parsed = parseConversationTitle(title, config, profile);
    if (parsed.team || parsed.channel || parsed.chatTitle) return parsed;
    lastResult = parsed;
  }

  if (tried.length > 1 && lastResult.warnings.length > 0) {
    lastResult.warnings = [{
      ...lastResult.warnings[0],
      detail: `画面のタイトルから会話名を取り出せませんでした（試した値: ${tried.map((t) => `「${t}」`).join(' / ')}）。ファイル名は既定の名前になります`,
    }];
  }
  return lastResult;
}

/**
 * 会話種別に対応するリンク設定を取り出す。チャネルとチャットで URL の形が違う。
 * @returns {object|null}
 */
function permalinkConfigFor(selectors, profile) {
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
function buildPermalink(config, values = {}) {
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
function toIsoTimestamp(timestamp, patterns, options = {}) {
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
function parseReaction(reaction, patterns) {
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

/* ==== src/scroll-driver.js ==== */
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
async function collectByScrolling(paneOrGetter, selectors, options = {}) {
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
function findConversationPane(root, selectors, profile = 'channel') {
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

/* ==== src/markdown-renderer.js ==== */
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
function renderMarkdownFiles(model, options = {}) {
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
function renderMarkdown(model, options = {}) {
  const { files } = renderMarkdownFiles(model, { ...options, maxMessagesPerFile: Infinity, maxBytesPerFile: Infinity });
  return files[0] ? files[0].content : '';
}

/**
 * ファイル名（§6.1）: teams_{kind}_{safeTitle}_{YYYYMMDD-HHmm}.md
 */
function buildFilename(model, options = {}) {
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

/* ==== tools/browser-runtime.js ==== */
/**
 * ブラウザ側の共通グルー。コンソール貼り付け版とユーザースクリプト版が同じものを使う。
 *
 * ここだけが document / window / 現在時刻に触れる。src/ の抽出コアは純粋関数のままにしてある。
 * 行うのは会話ペインのスクロールと「詳細を表示」の展開だけで、ネットワークへは一切送信しない
 * （CLAUDE.md 原則1・2）。
 *
 * このファイルは ES モジュールではなく、tools/bundle.js が src/ の後ろにそのまま連結する。
 */

/** 会話種別の自動判定。判定にもセレクタ設定を使う（コードにセレクタを書かない） */
function detectProfile(selectors) {
  const count = (profile) => {
    const box = selectors.profiles[profile].messageBox;
    const list = Array.isArray(box) ? box : [box];
    for (const sel of list) {
      const found = document.querySelectorAll(sel).length;
      if (found > 0) return found;
    }
    return 0;
  };
  return count('chat') > count('channel') ? 'chat' : 'channel';
}

/**
 * 収集から Markdown 生成までの本流。UI 側はこれを呼んで結果を表示するだけ。
 *
 * @param {object} selectors selectors.json の内容
 * @param {object} options 収集オプション（scroll-driver の DEFAULTS ＋ toolVersion / tenantId / groupId）
 * @returns {Promise<{model: object, files: Array, profile: string}>}
 * @throws {Error} 会話ペインが見つからない場合
 */
async function runExport(selectors, options) {
  const profile = options.profile || detectProfile(selectors);
  const pane = findConversationPane(document.body, selectors, profile);
  if (!pane) {
    throw new Error('会話ペインが見つかりません。チャネルかチャットを開いた状態で実行してください。');
  }

  const startedAt = new Date();
  // 会話名はタブのタイトルから取る。ただし Teams は更新が遅れることがあり、開始時点では
  // 会話名が入っていない場合がある（実機で観測）。開始時と終了時の両方を候補にする。
  const titleAtStart = document.title;

  const capturedAt = toLocalIso(startedAt);
  const collected = await collectByScrolling(pane, selectors, Object.assign({}, options, { profile, capturedAt }));

  const titleMeta = resolveConversationTitle([titleAtStart, document.title], selectors.conversationTitle, profile);

  // 会話 ID は入力欄の送信ボタンなど「ペインの外」にあるので document.body から探す。
  // 本文に貼られた他会話のリンクを拾わないよう、専用の属性を持つ要素だけを見ている。
  const conversation = extractConversationId(document.body, selectors, { profile });
  conversation.warnings.forEach((w) => collected.warnings.push(w));
  titleMeta.warnings.forEach((w) => collected.warnings.push(w));

  const model = normalize(collected, {
    kind: profile,
    url: location.href,
    threadId: conversation.threadId,
    team: titleMeta.team,
    channel: titleMeta.channel,
    chatTitle: titleMeta.chatTitle,
    capturedAt,
    toolVersion: options.toolVersion || null,
  }, {
    patterns: selectors.patterns,
    // 取得範囲。スクロールは境界を少し越えて止まるので、出力側でも同じ境界で切る
    since: options.stopBefore || null,
    includeSystem: options.includeSystem === true,
    // リンクの形はチャネルとチャットで違う（チャットに parentMessageId を付けると会話を見つけられない）
    permalink: permalinkConfigFor(selectors, profile),
    tenantId: options.tenantId || null,
    groupId: options.groupId || null,
    truncated: collected.truncated,
  });
  model.stats.scroll = collected.stats;

  const { files } = renderMarkdownFiles(model, options);
  return { model, files, profile };
}

/** Blob を作ってダウンロードさせる。ネットワークへは出ない */
function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()), p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join('-');
}

/** ローカルタイムのまま ISO 8601（オフセット付き）にする。UTC へ寄せない */
function toLocalIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}


/* ==== コンソール用の入口 ==== */
const SELECTORS = {
  "version": "2.0.0",
  "generatedFrom": {
    "reports": [
      "docs/teams-calibration.md（2026-08-05 / channel / 8 件）",
      "docs/dom-samples/teams-dom-samples_channel_2026-08-06-18-*.md（4 ファイル / 58 件）",
      "docs/dom-samples/teams-dom-samples_chat_2026-08-06-1*.md（2 ファイル / 13 件）"
    ],
    "origin": "https://teams.microsoft.com/v2/",
    "uiLanguage": "ja-JP",
    "coverage": "channel 66 件 / chat 13 件。送信者・日時・本文はいずれも 100%（node tools/check-samples.js で再確認できる）"
  },
  "note": "値は CSS セレクタ文字列、または優先順に試すセレクタの配列。class 名は難読化されており不安定なため使用しない（data-tid / role / id 接頭辞 / itemtype / aria-* のみ）。根拠と確度は _meta を参照。",

  "profiles": {
    "channel": {
      "conversationPane": ["[data-tid='channel-pane-viewport']", "[data-tid='message-pane-body']"],

      "messageBox": "[data-tid='channel-pane-message']",
      "postRoot": "[id^='post-message-renderer-']",
      "replyContainer": "[data-tid='response-surface']",

      "messageUnit": "[role='group'][id^='message-body-']",
      "messageUnitIdPrefix": "message-body-",
      "messageIdHost": "[data-mid]",
      "messageIdAttr": "data-mid",
      "parentIdHost": "[data-reply-chain-id]",
      "parentIdAttr": "data-reply-chain-id",

      "conversationIdHost": ["[data-tid='sendMessageCommands-send'][data-track-thread-id]", "[data-track-thread-id]"],
      "conversationIdAttr": "data-track-thread-id",

      "idTemplates": {
        "author": "author-{mid}",
        "timestamp": "timestamp-{mid}",
        "subject": "subject-line-{mid}",
        "body": "content-{mid}",
        "edited": "edited-{mid}",
        "deleted": "tombstone-{mid}",
        "attachmentContainer": "attachments-{mid}",
        "replySummaryButton": "response-summary-{mid}"
      },

      "author": ["[id^='author-']", "[data-tid='post-message-subheader'] span[id]", "[data-tid='reply-message-header'] span[id]"],
      "timestamp": "time[data-tid='timestamp']",
      "timestampAttr": ["datetime", "aria-label"],
      "subject": "[data-tid='subject-line']",
      "body": ["[data-tid='message-body']", "[data-message-content]"],

      "reactionSummary": ["[data-tid='channel-message-reaction-summary']", "[data-tid='diverse-reaction-summary']"],
      "reactionPill": "[data-tid='diverse-reaction-pill-button']",
      "reactionEmoji": ["[data-tid='emoticon-renderer'] img[alt]", "img[itemtype*='Emoji'][alt]", "img[alt][data-tid^='custom-emoji']"],
      "reactionLabelRefAttr": "aria-labelledby",
      "emojiIdAttr": "itemid",

      "edited": "[id^='edited-']",
      "editedTimeAttr": "title",
      "deleted": "[id^='tombstone-']",

      "attachmentContainer": "[data-tid='file-attachment-grid']",
      "attachmentItem": "[role='group'][aria-label]",
      "attachmentNameAttr": "aria-label",
      "attachmentTitle": "[data-testid='content-card-custom-title']",
      "attachmentTitleAttr": "aria-label",
      "attachmentCountAttr": "numberoffiles",
      "attachmentLink": "a[href]",

      "deepLinkGrid": "[data-tid='deeplink-attachment-grid']",
      "deepLinkItem": "[data-tid^='deep-link-chiclet']",

      "linkPreview": "[data-tid='url-preview']",
      "linkPreviewTitle": ["[data-tid='url-preview-body'] span[title]", "[data-tid='url-preview-body'] span"],
      "linkPreviewLink": "a[href]",

      "mention": "span[itemtype='http://schema.skype.com/Mention']",
      "mentionWrapper": "[data-mention-type]",
      "mentionIdAttr": "data-person-mri",
      "emoji": "img[itemtype='http://schema.skype.com/Emoji']",
      "customEmoji": "img[itemtype='http://schema.skype.com/CustomEmoji']",
      "link": "a[href]",
      "codeBlockLanguage": "[data-tid='code-block-editor-deserialized-language']",

      "unsupported": {
        "adaptive-card": ["[data-testid='componentUXWrapperTestId']", "[data-tid='adaptive-card']"],
        "url-preview": "[data-tid='url-preview']"
      },
      "collapsedBody": ["[id^='see-more-container']", "[data-testid^='see-more-container']"],
      "expandBodyButton": "[id^='see-more-container'] button",
      "expandRepliesButton": "[data-tid='response-summary-button']",
      "threadPane": "[data-tid='message-pane-list-viewport']",
      "threadPaneScroller": "[data-tid='message-pane-list-viewport']",
      "threadPaneClose": [],
      "threadProfile": "chat",
      "loadingIndicator": ["[role='progressbar']", "[aria-busy='true']"],

      "systemMessage": [],
      "ignoreInBody": ["[data-tid='message-extension-card-footer']", "[data-tid='image-placeholder-container']", "[data-tid='code-block-editor-deserialized-header']", "[aria-live]", "[role='progressbar']"]
    },

    "chat": {
      "conversationPane": ["[data-tid='message-pane-list-viewport']", "[data-tid='message-pane-body']"],

      "messageBox": "[data-tid='chat-pane-item']:has([data-tid='chat-pane-message'])",
      "postRoot": [],
      "replyContainer": [],

      "messageUnit": "[data-tid='chat-pane-item']:has([data-tid='chat-pane-message'])",
      "messageUnitIdPrefix": "message-body-",
      "messageIdHost": "[data-mid]",
      "messageIdAttr": "data-mid",
      "parentIdHost": [],
      "parentIdAttr": "data-reply-chain-id",

      "conversationIdHost": ["[data-tid='sendMessageCommands-send'][data-track-thread-id]", "[data-track-thread-id]"],
      "conversationIdAttr": "data-track-thread-id",

      "idTemplates": {
        "author": "author-{mid}",
        "timestamp": "timestamp-{mid}",
        "subject": "subject-line-{mid}",
        "body": "content-{mid}",
        "edited": "edited-{mid}",
        "attachmentContainer": "attachments-{mid}"
      },

      "author": ["[data-tid='message-author-name']", "[id^='author-']"],
      "timestamp": ["time[id^='timestamp-']", "time[data-tid='timestamp']", "time"],
      "timestampAttr": ["datetime", "aria-label", "title"],
      "subject": "[data-tid='subject-line']",
      "body": ["[data-message-content]", "[data-tid='message-body']"],

      "reactionSummary": "[data-tid='diverse-reaction-summary']",
      "reactionPill": "[data-tid='diverse-reaction-pill-button']",
      "reactionEmoji": ["[data-tid='emoticon-renderer'] img[alt]", "img[itemtype*='Emoji'][alt]", "img[alt][data-tid^='custom-emoji']"],
      "reactionLabelRefAttr": "aria-labelledby",
      "emojiIdAttr": "itemid",

      "edited": "[id^='edited-']",
      "editedTimeAttr": "title",
      "deleted": [],

      "attachmentContainer": "[data-tid='file-attachment-grid']",
      "attachmentItem": "[role='group'][aria-label]",
      "attachmentNameAttr": "aria-label",
      "attachmentTitle": "[data-testid='content-card-custom-title']",
      "attachmentTitleAttr": "aria-label",
      "attachmentCountAttr": "numberoffiles",
      "attachmentLink": "a[href]",

      "deepLinkGrid": "[data-tid='deeplink-attachment-grid']",
      "deepLinkItem": "[data-tid^='deep-link-chiclet']",

      "linkPreview": "[data-tid='url-preview']",
      "linkPreviewTitle": ["[data-tid='url-preview-body'] span[title]", "[data-tid='url-preview-body'] span"],
      "linkPreviewLink": "a[href]",

      "mention": "span[itemtype='http://schema.skype.com/Mention']",
      "mentionWrapper": "[data-mention-type]",
      "mentionIdAttr": "data-person-mri",
      "emoji": "img[itemtype='http://schema.skype.com/Emoji']",
      "customEmoji": "img[itemtype='http://schema.skype.com/CustomEmoji']",
      "link": "a[href]",
      "codeBlockLanguage": "[data-tid='code-block-editor-deserialized-language']",

      "unsupported": {
        "adaptive-card": ["[data-testid='componentUXWrapperTestId']", "[data-tid='adaptive-card']"],
        "url-preview": "[data-tid='url-preview']"
      },
      "collapsedBody": ["[id^='see-more-container']", "[data-testid^='see-more-container']"],
      "expandBodyButton": "[id^='see-more-container'] button",
      "expandRepliesButton": [],
      "loadingIndicator": ["[role='progressbar']", "[aria-busy='true']"],

      "systemMessage": "[data-tid='control-message-renderer']",
      "ignoreInBody": ["[data-tid='message-extension-card-footer']", "[data-tid='image-placeholder-container']", "[data-tid='code-block-editor-deserialized-header']", "[aria-live]", "[role='progressbar']"]
    }
  },

  "patterns": {
    "timestampAriaLabel": "^\\s*(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s+(\\d{1,2}):(\\d{2})\\s*$",
    "timestampTextShort": "^\\s*(\\d{1,2})/(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})\\s*$",
    "timestampYesterday": "^\\s*昨日の?\\s*(\\d{1,2}):(\\d{2})\\s*$",
    "timestampToday": "^\\s*(?:今日の?\\s*)?(\\d{1,2}):(\\d{2})\\s*$",
    "editedAbsolute": "(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s+(\\d{1,2}):(\\d{2})",
    "editedRelative": "(今日|昨日)の?\\s*(\\d{1,2}):(\\d{2})",
    "reactionLabel": "^\\s*(\\d+)\\s*件の\\s*(.+?)\\s*リアクション",
    "replyCountLabel": "(\\d+)\\s*件の返信",
    "attachmentCountLabel": "(\\d+)\\s*[つ個件]",
    "attachmentUrl": "(https?://\\S+)\\s*$",
    "hiddenStyle": "display\\s*:\\s*none",
    "skipImageUrl": "^blob:"
  },

  "navigation": {
    "note": "スケジュール実行（Playwright 版）で、左の一覧から対象の会話を開くためのセレクタ。{threadId} は対象の会話 ID に置換される。ブラウザ内実行では使わない（人が開いた会話をそのまま取るため）。",
    "_status": "**未確定**。2026-08-13 のコンソール調査で、左一覧の項目が data-fui-tree-item-value に会話 ID を持つことは確認した（DIV.data-fui-tree-item-value に 19:…@… が入っていた）。ただし、それをクリックして会話が開くかは未検証。効かない場合は target に current: true を指定すれば、開いている会話をそのまま取れる。",
    "conversationListItem": "[data-fui-tree-item-value=\"{threadId}\"]"
  },

  "conversationTitle": {
    "note": "会話名は画面（ブラウザのタブ）のタイトルから取る。2026-08-13 実測: チャネル '(3) チームとチャネル | DTS | 911_プロパー(星野PL-R＆D) | Microsoft Teams' / チャット '(3) チャット | ベトナム案件-DTSメンバのみ | Microsoft Teams'。先頭はアプリ内のセクション名（未読数 '(3) ' が付くことがある）、末尾はアプリ名で、どちらも UI 言語依存。そのため文字列一致ではなく位置で落とす。会話名自体に区切り文字が含まれる場合は、最後のフィールドに区切りごと戻して入れる（チーム名に含まれる場合だけは分離できない）。",
    "separator": " | ",
    "dropLeading": 1,
    "dropTrailing": 1,
    "channel": ["team", "channel"],
    "chat": ["chatTitle"]
  },

  "permalink": {
    "note": "個々のメッセージへのディープリンク。**チャネルとチャットで形が違う**ので会話種別ごとに分けてある。Teams の「リンクをコピー」が実際に出す URL に合わせること。base のプレースホルダが 1 つでも埋まらなければリンクを作らない（推測で URL を組み立てない）。params は値が無いものを落とす。テンプレートの地の文はそのまま出し、{…} に埋める値だけ URL エンコードする（Teams 実物の書き方を 1 文字も変えずに再現するため）。tenantId は DOM から確実に取れないため既定では付けない（options.tenantId で明示指定できる）。",
    "channel": {
      "_status": "2026-08-13 に実機の「リンクをコピー」と突き合わせた。実物は ?tenantId=…&groupId=…&parentMessageId=…&teamName=…&channelName=…&createdTime=…&ngc=true。createdTime は messageId と同じ値だった。parentMessageId は実装の値と一致（親の解決は正しい）。tenantId / groupId は DOM から取れる場所が未確定のため options で受け取る（未指定なら落とす）。teamName / channelName は表示名で、URL に載っても表示用と見られるため付けない。",
      "base": "https://teams.microsoft.com/l/message/{threadId}/{messageId}",
      "params": {
        "tenantId": "{tenantId}",
        "groupId": "{groupId}",
        "parentMessageId": "{parentId}",
        "createdTime": "{messageId}",
        "ngc": "true"
      }
    },
    "chat": {
      "_status": "2026-08-13 に実機の「リンクをコピー」と突き合わせて確定。parentMessageId を付けるとデスクトップアプリが「チームを見つけることができません」になる（チャネル投稿として解釈されるため）。context の値は Teams 実物が ':' だけを %3A にした形なので、それをそのまま写している。",
      "base": "https://teams.microsoft.com/l/message/{threadId}/{messageId}",
      "params": {
        "context": "{\"contextType\"%3A\"chat\"}"
      }
    }
  },

  "_meta": {
    "confirmed": {
      "conversationPane": "祖先要素の採取で確定。channel は [data-tid='channel-pane-viewport']、chat は [data-tid='message-pane-list-viewport'] が実際にスクロールする要素（4 回の channel 採取・1 回の chat 採取すべてで一致）。共通の外枠として [data-tid='message-pane-body'] が両方に存在するのでフォールバックに入れてある。",
      "messageBox(channel)": "[data-tid='channel-pane-message']。1 箱＝1 リプライチェーン（親投稿＋返信）。",
      "messageUnit(channel)": "[role='group'][id^='message-body-']。channel 4 ファイル・実メッセージ 61 件で送信者・日時・本文の取得率 97%（欠落 2 件は連続投稿でヘッダが省略されたケース＝下記 grouped-message）。",
      "messageUnit(chat)": "chat の 1 メッセージは [data-tid='chat-pane-item']（外側のラッパ）。送信者 [data-tid='message-author-name'] と <time> はこのラッパ直下にあり、[data-tid='chat-pane-message']（本文・添付・リアクションを含む箱）の外側にある。なおアバター用に入れ子の chat-pane-item が現れるため、:has([data-tid='chat-pane-message']) で本物だけを選ぶ。",
      "timestamp(chat)": "chat の <time> には datetime='2026-08-06T05:42:24.704Z'（UTC・秒つき）があり、これが最も正確。channel の <time> には datetime が無く data-tid='timestamp' + aria-label のみ、という非対称がある。",
      "codeBlock": "<pre itemid='codeBlockEditor-…'><code>行1<br>行2…</code></pre>。**改行は <br>**、インデントは &nbsp;。textContent を使うと 1 行に潰れる。言語名は <pre> ではなく直前の兄弟にある [data-tid='code-block-editor-deserialized-language']（表示は 'Plain Text' 等）。このヘッダは本文テキストに混ざるので ignoreInBody に入れてある。",
      "body(chat)": "chat の本文には data-tid='message-body' が付かない。id='content-{mid}' と data-message-content のみ。したがって body は両方を候補に持つ必要がある。",
      "attachment": "確定。[data-tid='file-attachment-grid'][id='attachments-{mid}'][aria-label='メッセージに添付ファイルが N つあります。'] の中に、ファイルごとの [role='group'][aria-label='{ファイル名}'][numberoffiles='N'] がある。URL は a[href] ではなく [data-testid='content-card-custom-title'] の aria-label 末尾に '{ファイル名} {URL}' の形で入っている（channel 4 件 / chat 1 件すべてで一致）。",
      "reactionSummary": "channel は [data-tid='channel-message-reaction-summary'] だが chat にはこのラッパーが無く [data-tid='diverse-reaction-summary'] から始まる。pill 以下は共通。",
      "mentionWrapper": "[data-mention-type] の値は person / tag / channel の 3 種を確認。いずれも data-person-mri を持つ（tag は 'tsRigp5CA' 形式、channel は '19:…@thread.tacv2'）ので、MRI 一致でメンションの結合可否を判定できる。なお同じ属性がヘッダのアバターにも付くが、本文要素だけを走査するため影響しない。",
      "inlineCode": "本文中の <code>（インラインコード）を channel サンプルで確認。<p> 直下に置かれる。",
      "table": "chat サンプルで <table><tbody><tr><td> の素の表を確認（属性による装飾なし）。",
      "urlPreview": "[data-tid='url-preview']。リンクのカード型プレビュー。本文のリンクと重複するため未対応要素として畳む。",
      "edited": "span[id='edited-{mid}'] に「編集済み」。**メッセージ本体（data-mid の箱）の外側・メッセージ単位の内側**にあり、採取スクリプトが本体だけを見ていたため当初 0 件と誤報告していた（実際は 22 件）。title 属性に「2026年8月4日 17:06 に編集しました」「今日の 14:00 に編集しました」「更新済み 今日の 9:49」の形で編集時刻が入るので、editedAt として ISO 化できる（22/22 で成功）。",
      "codeBlockLanguage": "コードブロックの言語名は <pre> ではなく直前の兄弟のヘッダ [data-tid='code-block-editor-deserialized-language']（表示は 'Plain Text' 等）にある。",
      "conversationId": "いま開いている会話の ID（threadId）は data-track-thread-id にある。2026-08-13 に実機のコンソールで確認: チャネル（[data-tid='sendMessageCommands-send'] ほか会議ヘッダのボタン計 3 個、値はすべて同一の 19:…@thread.tacv2）、会議チャット（1 個・19:meeting_…@thread.v2）。**ページ全文を正規表現で探す方式は使えない**（左一覧の全会話 120 件近くが DOM に載っており、さらに会話ペイン内にも本文に貼られた他会話のリンク由来の ID が混ざる）。この属性を持つ要素だけを見ること。なお location.href は 'https://teams.microsoft.com/v2' 固定で会話を識別できない。1:1 チャット（@unq.gbl.spaces）は未確認。",
      "deepLink": "[data-tid='deeplink-attachment-grid'] はタブ等へのディープリンクで、ファイル添付（file-attachment-grid）とは別物。id が attachments-deeplink-{mid} なので、添付コンテナを id 接頭辞で引くと誤検出する（実際に attachment-unrecognized 警告が出た）。添付は file-attachment-grid に限定し、ディープリンクは deepLinks として別に拾う。"
    },
    "corrected": {
      "collapsedBody": "「詳細を表示」の入れ物 [id='see-more-container'] は折りたたまれていないメッセージにも常に存在する（全 60 個中、実際に折りたたみ中なのは 28 個）。区別はインライン style の display:none だけで、意味的属性の差は無い（aria-expanded は常に false）。そのためセレクタは素のままにして、判定は patterns.hiddenStyle をコード側で当てる方式にした。",
      "attachmentLink": "初版の a[href] は誤り。添付グリッド内にアンカーは存在しない。上記の aria-label 方式に変更（a[href] はフォールバックとして残置）。",
      "card→unsupported": "カード類は 1 種類ではないため、ラベル→セレクタの対応表 unsupported に一般化した（adaptive-card / url-preview）。§6.3 に従い <!-- 未対応要素: {ラベル} --> として残す。"
    },
    "unverified": {
      "systemMessage": "出力対象外の方針（既定で除外）。chat に [data-tid='control-message-renderer'] という箱があることは確認済みだが中身は未採取。除外件数だけ stats.systemExcluded に残す。",
      "deleted": "削除済み（tombstone-{mid}）は全サンプルで未観測のまま。採取不要の方針だが、id 接頭辞セレクタは残してあり、実要素が現れればフラグが立つ。chat の aria-labelledby には tombstone が無く、削除表示の作りが channel と異なる可能性がある。",
      "inlineImage": "本文に貼られた画像は <img src='blob:…'> で、alt もファイル名も無い。blob: URL は保存後に無効になるため、patterns.skipImageUrl に一致する画像は <!-- 未対応要素: 画像 --> として残す（リンクとしては出さない）。"
    },
    "policy": "class 属性は難読化されているため一切使用していない。data-testid は Teams 内部のテスト用属性で data-tid ほどの安定性が確認できないため、メッセージ本体の抽出（ID・送信者・日時・本文）には使わず、補助用途（添付の URL・カードの外枠・collapsedBody のフォールバック）に留めた。これらが外れても本文抽出は壊れず、警告が増えるだけで済む設計にしてある。"
  }
};

const userOptions = (typeof window !== 'undefined' && window.TEAMS_COLLECT) || {};
const options = Object.assign({
  // 初回確認用に控えめな上限。全部取りたいときは window.TEAMS_COLLECT で上書きする
  maxSteps: 20,
  maxDurationMs: 90 * 1000,
  expandBody: true,
  expandReplies: false,
  toolVersion: '0.1.0',
  onProgress: ({ step, collected, gained }) => {
    if (gained > 0 || step % 5 === 0) console.log(`[teams-md] ${step} 周目: ${collected} 件（+${gained}）`);
  },
}, userOptions);

try {
  console.log('[teams-md] 収集開始:', options);
  const { model, files } = await runExport(SELECTORS, options);

  window.TEAMS_RESULT = model;
  window.TEAMS_FILES = files;
  printSummary(model, files);

  if (window.TEAMS_SAVE_MD !== false) files.forEach((file) => downloadFile(file.filename, file.content, 'text/markdown'));
  if (window.TEAMS_SAVE_JSON) {
    downloadFile(`teams-model_${model.source.kind}_${localStamp(new Date())}.json`, JSON.stringify(model, null, 2), 'application/json');
  }
} catch (error) {
  console.error('[teams-md]', error.message);
}

function printSummary(model, files) {
  const s = model.stats;
  console.log('%c[teams-md] 収集結果', 'font-weight:bold');
  console.table({
    メッセージ数: s.messageCount,
    スレッド数: s.threadCount,
    期間: `${s.rangeStart || '?'} 〜 ${s.rangeEnd || '?'}`,
    truncated: s.truncated,
    メッセージへのリンク: `${s.permalinkCount} / ${s.messageCount}`,
    停止理由: s.scroll.stopReason,
    スクロール周回: s.scroll.steps,
    展開した本文: s.scroll.expandedBodies,
    開いたスレッド: s.scroll.expandedReplies,
    所要秒: Math.round(s.scroll.durationMs / 1000),
  });

  const byCode = {};
  for (const w of model.warnings) byCode[w.code] = (byCode[w.code] || 0) + 1;
  if (Object.keys(byCode).length > 0) {
    console.log('[teams-md] 警告の内訳（取りこぼしの可能性を明示しているもの）');
    console.table(byCode);
  }
  if (s.replyGaps.length > 0) {
    console.log('[teams-md] 返信が取り切れていない投稿:', s.replyGaps);
  }

  if (files && files.length > 0) {
    console.log('[teams-md] 保存した Markdown:', files.map((f) => f.filename).join(', '));
    console.log('[teams-md] ※ 実際の会話内容が入ります。取り扱いは仕様書 §10 に従ってください');
  }

  const first = model.messages[0];
  const last = model.messages[model.messages.length - 1];
  if (first) console.log('[teams-md] 最古:', first.timestamp, first.author, preview(first));
  if (last) console.log('[teams-md] 最新:', last.timestamp, last.author, preview(last));
  console.log('[teams-md] 中間データは window.TEAMS_RESULT、Markdown は window.TEAMS_FILES に入っています');
  console.log('[teams-md] Markdown を保存したくない場合: window.TEAMS_SAVE_MD = false / 中間 JSON も保存: window.TEAMS_SAVE_JSON = true');
}

function preview(message) {
  const text = (message.bodyMarkdown || message.subject || '').replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

})();
