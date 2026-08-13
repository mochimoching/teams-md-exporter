/**
 * ユーザースクリプト版の UI。画面右下にボタンを 1 つ置くだけの最小構成。
 *
 * 方針:
 *   - **勝手に走らない。** ページを開いただけでは何もせず、押されたときだけ収集する。
 *   - 進捗を出し、いつでも中止できる（中止しても truncated として必ず報告される）。
 *   - Teams の CSS と干渉しないよう Shadow DOM に閉じる。
 *   - 会話名やファイル名は textContent で入れる（実データを HTML として解釈させない）。
 *   - **innerHTML を一切使わない。** Teams は Trusted Types（require-trusted-types-for）を
 *     有効にしているため、innerHTML への代入は TypeError で拒否される（実機で確認）。
 *     要素は createElement、スタイルは <style> の textContent で組み立てる。
 *
 * 取得範囲の設定 UI（仕様書 §7-2）はここには無い。当面は window.TEAMS_COLLECT で上書きする。
 * このファイルは ES モジュールではなく、tools/build-userscript.js がそのまま埋め込む。
 */

const EXPORTER_STYLE = [
  ':host{all:initial}',
  '*{box-sizing:border-box;font:13px/1.6 "Segoe UI",system-ui,sans-serif}',
  '.panel{min-width:220px;max-width:340px;background:#fff;color:#242424;',
  'border:1px solid #d1d1d1;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:10px}',
  '@media (prefers-color-scheme:dark){.panel{background:#292929;color:#f5f5f5;border-color:#484644}}',
  'button{font:inherit;padding:6px 12px;border-radius:4px;border:1px solid transparent;cursor:pointer}',
  'button:disabled{opacity:.5;cursor:default}',
  '.run{background:#5b5fc7;color:#fff;width:100%}',
  '.run:hover:not(:disabled){background:#4f52b2}',
  '.abort{background:transparent;color:inherit;border-color:currentColor;margin-top:8px;width:100%}',
  '.status{margin-top:8px;opacity:.85}',
  '.result{margin-top:8px;border-top:1px solid rgba(128,128,128,.35);padding-top:8px}',
  '.result div{margin-top:2px;word-break:break-all}',
  '.warn{color:#bc4b09}',
  '@media (prefers-color-scheme:dark){.warn{color:#ffb900}}',
  '.note{opacity:.7;margin-top:6px}',
  'details{margin-top:8px}',
  'summary{cursor:pointer;opacity:.85}',
  'fieldset{border:0;margin:6px 0 0;padding:0}',
  'label{display:flex;align-items:center;gap:4px;margin-top:4px}',
  'input[type=number]{width:4.5em}',
  'input[type=date]{font:inherit}',
  'input[type=number],input[type=date]{padding:2px 4px;border:1px solid rgba(128,128,128,.6);',
  'border-radius:3px;background:transparent;color:inherit}',
  '[hidden]{display:none}',
].join('');

/** 取得範囲の選択肢。value は buildRangeOption() の分岐と対応する */
const RANGE_CHOICES = [
  { value: 'all', text: '全件（先頭まで遡る）' },
  { value: 'days', text: '直近' },
  { value: 'since', text: '指定日以降' },
];

/** createElement だけで要素を作る小さなヘルパ（innerHTML を使わないため） */
function makeEl(tag, props) {
  const el = document.createElement(tag);
  Object.assign(el, props || {});
  return el;
}

/** ローカルの「その日の 0 時」の ISO（オフセット付き） */
function startOfDayIso(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return toLocalIso(d);
}

/**
 * 設定 UI の値 → 収集オプション（仕様書 §7-2）。
 * 不正な入力は黙って既定に倒さず、理由を返して実行しない。
 * @returns {{options: object, error: string|null, label: string}}
 */
function buildRangeOption(range, days, sinceDate) {
  if (range === 'days') {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1) {
      return { options: null, error: '「直近N日」の日数には 1 以上の数を入れてください', label: '' };
    }
    const from = new Date();
    from.setDate(from.getDate() - Math.floor(n));
    return { options: { stopBefore: startOfDayIso(from) }, error: null, label: `直近 ${Math.floor(n)} 日` };
  }

  if (range === 'since') {
    if (!sinceDate) return { options: null, error: '開始日を選んでください', label: '' };
    const from = new Date(`${sinceDate}T00:00:00`);
    if (Number.isNaN(from.getTime())) return { options: null, error: `開始日「${sinceDate}」を解釈できません`, label: '' };
    return { options: { stopBefore: startOfDayIso(from) }, error: null, label: `${sinceDate} 以降` };
  }

  return { options: { stopBefore: null }, error: null, label: '全件' };
}

(function mountExporterUi() {
  if (window.__TEAMS_MD_EXPORTER_MOUNTED__) return;
  try {
    mount();
  } catch (error) {
    // 差し込みに失敗したら黙って消えない。原因が分かる形でコンソールに出す
    console.error('[teams-md] UI を差し込めませんでした:', error);
    console.error('[teams-md] コンソール貼り付け版（dist/teams-collect-console.js）は使えます');
  }
})();

function mount() {
  const host = makeEl('div', { id: 'teams-md-exporter' });
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const runButton = makeEl('button', { className: 'run', type: 'button', textContent: '📥 会話を Markdown で保存' });
  const abortButton = makeEl('button', { className: 'abort', type: 'button', textContent: '中止', hidden: true });
  const statusEl = makeEl('div', { className: 'status', hidden: true });
  const resultEl = makeEl('div', { className: 'result', hidden: true });

  /* ---- 設定（仕様書 §7-2） ---- */
  const daysInput = makeEl('input', { type: 'number', min: '1', value: '30' });
  const sinceInput = makeEl('input', { type: 'date' });
  const systemCheck = makeEl('input', { type: 'checkbox' });
  const radios = {};

  const rangeSet = makeEl('fieldset');
  for (const choice of RANGE_CHOICES) {
    const radio = makeEl('input', { type: 'radio', name: 'teams-md-range', value: choice.value });
    radio.checked = choice.value === 'all';
    radios[choice.value] = radio;

    const label = makeEl('label');
    label.append(radio, makeEl('span', { textContent: choice.text }));
    if (choice.value === 'days') label.append(daysInput, makeEl('span', { textContent: '日' }));
    if (choice.value === 'since') label.append(sinceInput);
    rangeSet.append(label);
  }

  // 数値・日付を触ったら、その範囲を選んだものとみなす（ラジオの押し忘れを防ぐ）
  daysInput.addEventListener('input', () => { radios.days.checked = true; });
  sinceInput.addEventListener('input', () => { radios.since.checked = true; });

  const systemLabel = makeEl('label');
  systemLabel.append(systemCheck, makeEl('span', { textContent: 'システムメッセージも含める' }));

  const settings = makeEl('details');
  settings.append(
    makeEl('summary', { textContent: '設定' }),
    makeEl('div', { textContent: '取得範囲', className: 'note' }),
    rangeSet,
    systemLabel,
  );

  const panel = makeEl('div', { className: 'panel' });
  panel.append(runButton, settings, abortButton, statusEl, resultEl);
  root.append(makeEl('style', { textContent: EXPORTER_STYLE }), panel);

  let aborting = false;

  /** 現在の設定を収集オプションにする */
  function currentSettings() {
    const range = RANGE_CHOICES.map((c) => c.value).find((v) => radios[v].checked) || 'all';
    const built = buildRangeOption(range, daysInput.value, sinceInput.value);
    if (built.error) return built;
    return {
      options: { ...built.options, includeSystem: systemCheck.checked },
      error: null,
      label: built.label + (systemCheck.checked ? '・システムメッセージ込み' : ''),
    };
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function addLine(text, className) {
    resultEl.appendChild(makeEl('div', { textContent: text, className: className || '' }));
    resultEl.hidden = false;
  }

  /** 結果表示を空にする。innerHTML = '' を使わない */
  function clearResult() {
    while (resultEl.firstChild) resultEl.removeChild(resultEl.firstChild);
    resultEl.hidden = true;
  }

  function showResult(model, files) {
    clearResult();
    const s = model.stats;
    addLine(`${s.messageCount} 件を保存しました`);
    addLine(`期間: ${s.rangeStart ? s.rangeStart.slice(0, 10) : '?'} 〜 ${s.rangeEnd ? s.rangeEnd.slice(0, 10) : '?'}`);
    addLine(`メッセージへのリンク: ${s.permalinkCount} / ${s.messageCount}`);
    if (s.rangeExcluded > 0) addLine(`取得範囲より古い ${s.rangeExcluded} 件は除外しました`);
    if (s.systemExcluded > 0) addLine(`システムメッセージ ${s.systemExcluded} 件は除外しました`);
    for (const file of files) addLine(file.filename);

    if (s.truncated) {
      addLine(`⚠ 会話の全体ではありません（停止理由: ${s.scroll.stopReason}）`, 'warn');
      addLine('詳しい理由は .md の冒頭と末尾に出ています', 'warn');
    }
    addLine('※ 実際の会話内容が入ります。取り扱いは情報管理規程に従ってください', 'note');
  }

  runButton.addEventListener('click', async () => {
    const settingsResult = currentSettings();
    if (settingsResult.error) {
      clearResult();
      addLine(settingsResult.error, 'warn');
      settings.open = true;
      return;
    }

    runButton.disabled = true;
    abortButton.hidden = false;
    aborting = false;
    clearResult();
    setStatus(`収集を開始します（${settingsResult.label}）…`);

    try {
      const { model, files } = await runExport(SELECTORS, Object.assign({
        expandBody: true,
        expandReplies: false,
        toolVersion: EXPORTER_VERSION,
        onProgress: ({ step, collected }) => setStatus(`${step} 周目 / ${collected} 件を収集中…`),
        shouldAbort: () => aborting,
      }, settingsResult.options, window.TEAMS_COLLECT || {}));

      window.TEAMS_RESULT = model;
      window.TEAMS_FILES = files;
      for (const file of files) downloadFile(file.filename, file.content, 'text/markdown');
      if (window.TEAMS_SAVE_JSON) {
        downloadFile(`teams-model_${model.source.kind}_${localStamp(new Date())}.json`, JSON.stringify(model, null, 2), 'application/json');
      }
      showResult(model, files);
    } catch (error) {
      clearResult();
      addLine(`エラー: ${error && error.message ? error.message : error}`, 'warn');
    } finally {
      runButton.disabled = false;
      abortButton.hidden = true;
      setStatus('');
    }
  });

  abortButton.addEventListener('click', () => {
    aborting = true;
    setStatus('中止しています（ここまでの分を保存します）…');
  });

  document.body.appendChild(host);
  window.__TEAMS_MD_EXPORTER_MOUNTED__ = true;
}
