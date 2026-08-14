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
  const titleMetaWithFallback = applyConversationTitleFallback(titleMeta, profile, options && options.titleFallback);

  // 会話 ID は入力欄の送信ボタンなど「ペインの外」にあるので document.body から探す。
  // 本文に貼られた他会話のリンクを拾わないよう、専用の属性を持つ要素だけを見ている。
  const conversation = extractConversationId(document.body, selectors, { profile });
  conversation.warnings.forEach((w) => collected.warnings.push(w));
  titleMetaWithFallback.warnings.forEach((w) => collected.warnings.push(w));

  const model = normalize(collected, {
    kind: profile,
    url: location.href,
    threadId: conversation.threadId,
    team: titleMetaWithFallback.team,
    channel: titleMetaWithFallback.channel,
    chatTitle: titleMetaWithFallback.chatTitle,
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

function applyConversationTitleFallback(titleMeta, profile, fallbackInput) {
  const meta = {
    ...titleMeta,
    warnings: Array.isArray(titleMeta && titleMeta.warnings) ? [...titleMeta.warnings] : [],
  };
  const fallback = fallbackInput && typeof fallbackInput === 'object' ? fallbackInput : {};
  const normalizedTarget = normalizeTitleCandidate(fallback.targetName);
  const normalizedDisplay = normalizeTitleCandidate(fallback.displayName);
  const normalizedList = normalizeTitleCandidate(fallback.listText, [normalizedTarget, normalizedDisplay].filter(Boolean));

  // ターゲット設定値を最優先にし、左一覧テキストは補助として使う。
  const candidates = [
    { source: 'target-name', value: normalizedTarget },
    { source: 'display-name', value: normalizedDisplay },
    { source: 'list-text', value: normalizedList },
  ].filter((c) => c.value);

  if (profile === 'chat' && !meta.chatTitle) {
    const picked = candidates[0];
    if (picked) {
      meta.chatTitle = picked.value;
      meta.warnings.push({
        level: 'info',
        code: 'conversation-title-fallback',
        detail: `タブタイトルから会話名を取れなかったため、${picked.source} を会話名として使用しました`,
      });
    }
  }

  if (profile === 'channel' && !meta.channel) {
    const picked = candidates[0];
    if (picked) {
      meta.channel = picked.value;
      meta.warnings.push({
        level: 'info',
        code: 'conversation-title-fallback',
        detail: `タブタイトルからチャネル名を取れなかったため、${picked.source} をチャネル名として使用しました`,
      });
    }
  }

  return meta;
}

function normalizeTitleCandidate(value, hints = []) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  for (const hint of hints) {
    if (hint && text.includes(hint)) return hint;
  }

  // 左一覧の行テキストには時刻・抜粋が続くことがあるため、会話名部分を先頭寄りで切る。
  const m = text.match(/^(.*?)(?:\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日|今日|昨日)/);
  const head = m && m[1] ? m[1].trim() : text;
  const cleaned = head.replace(/^未読です\s*/, '').trim();
  return cleaned || null;
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
