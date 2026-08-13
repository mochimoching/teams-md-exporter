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

  const collected = await collectByScrolling(pane, selectors, Object.assign({}, options, { profile }));

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
    capturedAt: toLocalIso(startedAt),
    toolVersion: options.toolVersion || null,
  }, {
    patterns: selectors.patterns,
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
