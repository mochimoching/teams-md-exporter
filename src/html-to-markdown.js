/**
 * 本文 HTML → Markdown 変換（仕様書 §6.3 の写像ルール）。
 *
 * 純粋関数。DOM ノードとセレクタ設定だけを受け取り、文字列と警告を返す。
 * class 名には一切依存しない（itemtype / role / data-tid のみ）。
 */

import { matchesAny, normalizeSpace, toSelectorList } from './selector-utils.js';

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
export function htmlToMarkdown(bodyEl, sel, options = {}) {
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
export function tidy(markdown) {
  return String(markdown)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}
