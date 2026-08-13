/**
 * src/ の ES モジュールを、ブラウザにそのまま貼れる 1 つのコードに畳む共通処理。
 *
 * コンソール貼り付け版（build-console-script.js）とユーザースクリプト版（build-userscript.js）が
 * 同じものを使う。バンドラは入れない（依存は最小限に、が方針）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 依存順に並べる（index.js は入口をフロントエンド側で書くので含めない） */
const MODULES = [
  'selector-utils.js',
  'html-to-markdown.js',
  'extract.js',
  'normalize.js',
  'scroll-driver.js',
  'markdown-renderer.js',
];

/** ブラウザ側の共通グルー（DOM に触れる部分）。src/ の純粋関数とは分けてある */
const RUNTIME = 'browser-runtime.js';

export function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

export function readSelectorsJson() {
  return fs.readFileSync(path.join(repoRoot, 'selectors.json'), 'utf8').trim();
}

/**
 * src/ の各モジュールと共通ランタイムを、import/export を外して連結する。
 * @returns {string} 連結済みのコード
 */
export function bundleSources() {
  const bodies = MODULES.map((file) => {
    const code = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
    return `/* ==== src/${file} ==== */\n${stripModuleSyntax(code)}\n`;
  });

  const runtime = fs.readFileSync(path.join(repoRoot, 'tools', RUNTIME), 'utf8');
  bodies.push(`/* ==== tools/${RUNTIME} ==== */\n${stripModuleSyntax(runtime)}\n`);

  assertNoDuplicateTopLevelNames(bodies, [...MODULES, RUNTIME]);
  return bodies.join('\n');
}

function stripModuleSyntax(code) {
  return code
    .replace(/^import[\s\S]*?from\s+'[^']*';\s*$/gm, '') // import 文を削除
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '') // 再エクスポートを削除
    .replace(/^export\s+(?=(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\b)/gm, '') // export を外す
    .trim();
}

/** 連結で関数名がぶつかると静かに壊れるので、ビルド時に検出する */
export function assertNoDuplicateTopLevelNames(sources, labels) {
  const seen = new Map();
  const duplicates = [];
  sources.forEach((code, index) => {
    for (const m of code.matchAll(/^(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm)) {
      const name = m[1];
      if (seen.has(name)) duplicates.push(`${name}（${labels[seen.get(name)]} と ${labels[index]}）`);
      else seen.set(name, index);
    }
  });
  if (duplicates.length > 0) {
    throw new Error(`連結すると名前が衝突します: ${duplicates.join(', ')}`);
  }
}

export function writeDist(filename, content) {
  const outDir = path.join(repoRoot, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, filename);
  fs.writeFileSync(outFile, content, 'utf8');
  console.log(`${path.relative(repoRoot, outFile)} を生成しました（${Math.round(content.length / 1024)} KB）`);
  return outFile;
}
