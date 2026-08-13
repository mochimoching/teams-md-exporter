/**
 * DOM サンプル採取スクリプト（人間が DevTools のコンソールに貼って実行する）
 *
 * 目的: selectors.json を確定するために足りていない「種類」のメッセージ DOM を集めること。
 *       同じ種類を大量に集めても意味がないので、種類ごとに代表を数件だけ拾う。
 *
 * 使い方:
 *   1. Teams Web で対象の会話（チャネル or チャット）を開く
 *   2. F12 → Console タブ → このファイルの中身を全部貼って Enter
 *   3. .md ファイルが自動ダウンロードされる → docs/dom-samples/ に置く（リネーム不要）
 *   4. 何度実行してもよい。ファイル名に「種別（channel/chat）＋日時」が入るので上書きされない
 *
 * 任意: 実行前に window.COLLECT_LABEL = 'test-features' などと入れておくと、
 *       ファイル名に自分用のラベルが入る（「機能確認用に作ったテスト投稿」等の区別に）。
 *
 * 原則:
 *   - 画面に表示されている DOM しか読まない（CLAUDE.md 原則1）。ネットワークにも送らない。
 *   - 認証情報・トークンには一切触れない（原則2）。
 *   - 低機密の会話で実施すること（原則5・仕様書 §10）。
 */

(() => {
  const MAX_BOXES = 12; // 1 種類あたり代表数件。ファイルが巨大になるのを防ぐ

  // --- 「種類」の定義。属性ベースのみ（class は使わない） --------------------
  const FEATURES = [
    { key: 'attachment', label: '添付ファイル', sel: '[id^="attachments-"], [data-tid*="attachment"], [data-tid*="file-"]' },
    // 編集済み・削除済みは「最新状態が取れればよい」という方針のため必須ではない（印を付けられないだけ）。
    { key: 'edited', label: '編集済み（印のみ・任意）', sel: '[id^="edited-"]', optional: true },
    { key: 'deleted', label: '削除済み（印のみ・任意）', sel: '[id^="tombstone-"]', optional: true },
    { key: 'codeBlock', label: 'コードブロック（複数行）', sel: 'pre' },
    { key: 'inlineCode', label: 'インラインコード', sel: 'code' },
    { key: 'list', label: '箇条書き・番号付き', sel: 'ul, ol' },
    { key: 'table', label: '表', sel: 'table' },
    { key: 'quote', label: '引用', sel: 'blockquote' },
    { key: 'image', label: '本文中の画像', sel: 'img[src^="blob:"], [data-tid*="image"]' },
    { key: 'multiMention', label: '複数人メンション', test: (el) => distinctMri(el) >= 2 },
    { key: 'manyReactions', label: 'リアクション複数種', test: (el) => el.querySelectorAll('[data-tid*="reaction-pill"], [data-tid*="reaction-summary"] button').length >= 2 },
    { key: 'plain', label: '装飾なしの普通の投稿', test: () => true },
  ];

  const doc = document;

  // --- メッセージ単位を探す（確定済みの属性のみを手がかりにする） ------------
  const units = Array.from(doc.querySelectorAll('[data-mid]'));
  if (units.length === 0) {
    console.error('[collect] メッセージが見つかりません。会話を開いた状態で、メッセージが表示されているか確認してください。');
    return;
  }

  // 採取する「箱」。チャットは送信者・日時がメッセージ本体の外側（chat-pane-item 配下の
  // ヘッダ）にあるため、内側だけ採ると送信者が取れない。広いほうから順に探す。
  const BOX_CANDIDATES = [
    '[data-tid="chat-pane-item"]',
    '[data-tid$="-pane-message"]',
    '[data-testid="message-wrapper"]',
    '[role="group"][id]',
  ];
  const boxOf = (unit) => {
    for (const sel of BOX_CANDIDATES) {
      const box = unit.closest(sel);
      if (box) return box;
    }
    return unit;
  };

  // --- 種類ごとに代表を選ぶ ---------------------------------------------------
  const found = {};
  const chosen = new Map(); // box 要素 → 理由（種類）の配列
  for (const f of FEATURES) {
    // 判定はメッセージ本体（data-mid の箱）ではなく、ヘッダを含む箱全体で行う。
    // 「編集済み」の印などはヘッダ側にあり、本体だけ見ていると取りこぼす（実際に取りこぼした）。
    const hits = units.filter((u) => {
      const scope = boxOf(u);
      return f.test ? f.test(scope) : scope.querySelector(f.sel);
    });
    found[f.key] = { label: f.label, count: hits.length, optional: Boolean(f.optional) };
    for (const u of hits.slice(0, f.key === 'plain' ? 2 : 2)) {
      const box = boxOf(u);
      if (!chosen.has(box)) chosen.set(box, []);
      if (!chosen.get(box).includes(f.label)) chosen.get(box).push(f.label);
      if (chosen.size >= MAX_BOXES) break;
    }
  }

  // システムメッセージ（参加/退出/名称変更など）は出力対象外の方針のため、件数だけ数えて採取はしない。
  const controlBoxes = doc.querySelectorAll('[data-tid*="control-message"], [data-tid*="system-message"]');
  found.systemMessage = { label: 'システムメッセージ（出力対象外・採取不要）', count: controlBoxes.length, optional: true };

  // --- スクロール対象ペインの特定（selectors.json の conversationPane 用） -----
  const ancestors = [];
  let cur = boxOf(units[0]).parentElement;
  while (cur && cur !== doc.body) {
    const scrollable = cur.scrollHeight > cur.clientHeight + 10;
    ancestors.push({ el: cur, scrollable });
    cur = cur.parentElement;
  }

  // --- 種別（チャネル / チャット）の判定 --------------------------------------
  const boxTids = [...new Set(units.map((u) => attrOf(boxOf(u), 'data-tid')).filter(Boolean))];
  const kind =
    boxTids.some((t) => t.includes('channel')) ? 'channel'
      : boxTids.some((t) => t.includes('chat')) ? 'chat'
        : 'unknown';

  // --- レポート組み立て -------------------------------------------------------
  const collectedAt = new Date();
  const lines = [];
  lines.push('# Teams DOM サンプル（種類ごとの代表）', '');
  lines.push(`- 種別: ${kind}`);
  lines.push(`- URL: ${location.href}`);
  lines.push(`- 採取日時: ${localStamp(collectedAt)} (ローカル) / ${collectedAt.toISOString()} (UTC)`);
  lines.push(`- 画面上のメッセージ数: ${units.length}`);
  lines.push(`- メッセージ箱の data-tid: ${boxTids.join(', ') || '(なし)'}`);
  lines.push('');

  lines.push('## 種類ごとの有無（0 のものは、この採取では確定できない）', '');
  lines.push('| 種類 | 画面上の件数 | 判定 |', '|---|---|---|');
  for (const entry of Object.values(found)) {
    const verdict = entry.count > 0 ? 'OK' : entry.optional ? '—' : '**不足**';
    lines.push(`| ${entry.label} | ${entry.count} | ${verdict} |`);
  }
  lines.push('');

  lines.push('## 祖先要素（スクロール対象ペインの特定用）', '');
  lines.push('```');
  ancestors.forEach((a, i) => {
    lines.push(`[${i}]${a.scrollable ? ' ★スクロール可能' : ''} ${shallow(a.el)}`);
  });
  lines.push('```', '');

  lines.push('## サンプル HTML', '');
  let index = 0;
  for (const [box, reasons] of chosen) {
    index += 1;
    lines.push(`### sample ${index} — ${reasons.join(' / ')}`, '');
    lines.push('```html');
    lines.push(box.outerHTML);
    lines.push('```', '');
  }

  const report = lines.join('\n');

  // --- 保存 ------------------------------------------------------------------
  // ファイル名の日時はローカル時刻（JST）で、秒まで入れる。
  // toISOString() は UTC なので、採取した実時刻と 9 時間ずれて紛らわしい。
  const stamp = localStamp(collectedAt);
  const label = typeof window.COLLECT_LABEL === 'string' && window.COLLECT_LABEL
    ? `_${window.COLLECT_LABEL.replace(/[^\w-]/g, '-')}`
    : '';
  const name = `teams-dom-samples_${kind}${label}_${stamp}.md`;
  const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  const missing = Object.values(found).filter((f) => f.count === 0 && !f.optional).map((f) => f.label);
  console.log(`[collect] ${name} を保存しました（サンプル ${chosen.size} 件 / メッセージ ${units.length} 件）`);
  console.table(Object.fromEntries(Object.entries(found).map(([k, v]) => [v.label, v.count])));
  if (missing.length > 0) {
    console.warn('[collect] この画面には無かった種類:', missing.join(' / '));
    console.warn('[collect] → 別の会話でもう一度実行するか、テスト用の会話でその種類の投稿を作ってから再実行してください。');
  } else {
    console.log('[collect] 必要な種類はすべて含まれています。');
  }

  function attrOf(el, name) {
    return el && el.getAttribute ? el.getAttribute(name) : null;
  }
  /** ローカル時刻の YYYY-MM-DD-HH-mm-ss */
  function localStamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return [
      d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()),
      p(d.getHours()), p(d.getMinutes()), p(d.getSeconds()),
    ].join('-');
  }
  function distinctMri(el) {
    return new Set(Array.from(el.querySelectorAll('[data-person-mri]')).map((m) => m.getAttribute('data-person-mri'))).size;
  }
  /** 子要素を除いた開始タグだけを、class / style を落として出す */
  function shallow(el) {
    const clone = el.cloneNode(false);
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    return clone.outerHTML.replace(/><\/[a-z-]+>$/i, '>');
  }
})();
