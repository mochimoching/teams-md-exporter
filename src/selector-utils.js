/**
 * セレクタ設定（selectors.json）を扱う小さなヘルパ群。
 *
 * - 設定値は「CSS セレクタ文字列」または「優先順に試す文字列の配列」。
 * - ここにセレクタそのものは一切書かない（CLAUDE.md 原則3）。
 * - DOM グローバル（document / window）に触れない。渡された要素の API だけを使う。
 */

/** 設定値を配列に正規化する。null / undefined / 空配列は「未設定」。 */
export function toSelectorList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((s) => typeof s === 'string' && s.trim() !== '');
}

/** 未設定（＝キャリブレーション未了）かどうか。 */
export function isUnset(value) {
  return toSelectorList(value).length === 0;
}

/** 優先順に試して最初に見つかった 1 要素を返す。root 自身は含めない。 */
export function queryFirst(root, value) {
  for (const sel of toSelectorList(value)) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 優先順に試して、最初に 1 件以上ヒットしたセレクタの結果をすべて返す。 */
export function queryAll(root, value) {
  for (const sel of toSelectorList(value)) {
    const els = Array.from(root.querySelectorAll(sel));
    if (els.length > 0) return els;
  }
  return [];
}

/** root 自身も候補に含めて検索する（呼び出し側が単一メッセージを root に渡す場合に必要）。 */
export function querySelfOrAll(root, value) {
  const found = queryAll(root, value);
  if (matchesAny(root, value) && !found.includes(root)) return [root, ...found];
  return found;
}

/** 要素がいずれかのセレクタに一致するか。 */
export function matchesAny(el, value) {
  if (!el || typeof el.matches !== 'function') return false;
  return toSelectorList(value).some((sel) => el.matches(sel));
}

/** boundary の内側に限定した closest。境界外まで遡らない。 */
export function closestWithin(el, value, boundary) {
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
export function escapeAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** root の内側（root 自身を含む）から id 一致の要素を探す。document.getElementById は使わない。 */
export function findById(root, id) {
  if (!id) return null;
  const sel = `[id="${escapeAttrValue(id)}"]`;
  if (typeof root.matches === 'function' && root.matches(sel)) return root;
  return root.querySelector(sel);
}

/** `[id^='prefix-']` 形式の id から接尾辞（多くは message id）を取り出す。 */
export function idSuffix(el, prefix) {
  const id = el && el.getAttribute ? el.getAttribute('id') : null;
  if (!id || !prefix || !id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return rest === '' ? null : rest;
}

/** selectors.json の patterns（文字列の正規表現）をまとめてコンパイルする。 */
export function compilePatterns(patterns = {}) {
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
export function normalizeSpace(text) {
  return String(text == null ? '' : text)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 要素の textContent を空白正規化して返す。 */
export function textOf(el) {
  return el ? normalizeSpace(el.textContent) : '';
}

/** FNV-1a 32bit。メッセージIDが取れない場合の代替キー生成用（§4）。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
