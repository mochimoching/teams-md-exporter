/**
 * ユーザースクリプト版の UI。画面右下にボタンを 1 つ置くだけの最小構成。
 *
 * 方針:
 *   - **勝手に走らない。** ページを開いただけでは何もせず、押されたときだけ収集する。
 *   - 進捗を出し、いつでも中止できる（中止しても truncated として必ず報告される）。
 *   - Teams の CSS と干渉しないよう Shadow DOM に閉じる。
 *   - 会話名やファイル名は textContent で入れる（実データを HTML として解釈させない）。
 *
 * 取得範囲の設定 UI（仕様書 §7-2）はここには無い。当面は window.TEAMS_COLLECT で上書きする。
 * このファイルは ES モジュールではなく、tools/build-userscript.js がそのまま埋め込む。
 */

(function mountExporterUi() {
  if (window.__TEAMS_MD_EXPORTER_MOUNTED__) return;
  window.__TEAMS_MD_EXPORTER_MOUNTED__ = true;

  const host = document.createElement('div');
  host.id = 'teams-md-exporter';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = [
    '<style>',
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
    '[hidden]{display:none}',
    '</style>',
    '<div class="panel">',
    '<button class="run" type="button">📥 会話を Markdown で保存</button>',
    '<button class="abort" type="button" hidden>中止</button>',
    '<div class="status" hidden></div>',
    '<div class="result" hidden></div>',
    '</div>',
  ].join('');

  const runButton = root.querySelector('.run');
  const abortButton = root.querySelector('.abort');
  const statusEl = root.querySelector('.status');
  const resultEl = root.querySelector('.result');
  let aborting = false;

  function setStatus(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function addLine(text, className) {
    const div = document.createElement('div');
    div.textContent = text;
    if (className) div.className = className;
    resultEl.appendChild(div);
    resultEl.hidden = false;
  }

  function showResult(model, files) {
    resultEl.textContent = '';
    resultEl.hidden = false;
    const s = model.stats;
    addLine(`${s.messageCount} 件を保存しました`);
    addLine(`期間: ${s.rangeStart ? s.rangeStart.slice(0, 10) : '?'} 〜 ${s.rangeEnd ? s.rangeEnd.slice(0, 10) : '?'}`);
    addLine(`メッセージへのリンク: ${s.permalinkCount} / ${s.messageCount}`);
    for (const file of files) addLine(file.filename);

    if (s.truncated) {
      addLine(`⚠ 会話の全体ではありません（停止理由: ${s.scroll.stopReason}）`, 'warn');
      addLine('詳しい理由は .md の冒頭と末尾に出ています', 'warn');
    }
    addLine('※ 実際の会話内容が入ります。取り扱いは情報管理規程に従ってください', 'note');
  }

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    abortButton.hidden = false;
    aborting = false;
    resultEl.hidden = true;
    resultEl.textContent = '';
    setStatus('会話の先頭まで遡ります…');

    try {
      const { model, files } = await runExport(SELECTORS, Object.assign({
        expandBody: true,
        expandReplies: false,
        toolVersion: EXPORTER_VERSION,
        onProgress: ({ step, collected }) => setStatus(`${step} 周目 / ${collected} 件を収集中…`),
        shouldAbort: () => aborting,
      }, window.TEAMS_COLLECT || {}));

      window.TEAMS_RESULT = model;
      window.TEAMS_FILES = files;
      for (const file of files) downloadFile(file.filename, file.content, 'text/markdown');
      if (window.TEAMS_SAVE_JSON) {
        downloadFile(`teams-model_${model.source.kind}_${localStamp(new Date())}.json`, JSON.stringify(model, null, 2), 'application/json');
      }
      showResult(model, files);
    } catch (error) {
      resultEl.textContent = '';
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
})();
