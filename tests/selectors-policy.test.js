/**
 * セレクタ方針そのものを守るためのテスト。
 * - selectors.json に class セレクタを混ぜない（難読化されており不安定）
 * - コード側にセレクタをハードコードしない（CLAUDE.md 原則3）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadSelectors, repoRoot } from './fixtures.js';

const selectors = loadSelectors();

function collectSelectorStrings(node, keyPath = []) {
  const out = [];
  if (typeof node === 'string') {
    if (keyPath[0] === 'profiles' && !keyPath.includes('_meta') && !keyPath.some((k) => k.startsWith('_'))) {
      out.push({ path: keyPath.join('.'), value: node });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...collectSelectorStrings(v, [...keyPath, String(i)])));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) out.push(...collectSelectorStrings(v, [...keyPath, k]));
  }
  return out;
}

test('selectors.json に class セレクタが無い', () => {
  const strings = collectSelectorStrings(selectors).filter((s) => !s.path.includes('idTemplates'));
  const offenders = strings.filter((s) => /(^|[\s>+~,(])\.[A-Za-z_-]/.test(s.value));
  assert.deepEqual(offenders, [], `class セレクタが混入: ${JSON.stringify(offenders)}`);
});

test('selectors.json のセレクタは意味的属性（data-* / role / id / itemtype / aria-*）だけで書かれている', () => {
  // セレクタではない設定値（属性名・id 接頭辞・注記）は対象外
  const notSelector = (p) =>
    p.includes('idTemplates') ||
    /Attr(\.\d+)?$/.test(p) ||
    p.endsWith('messageUnitIdPrefix') ||
    p.endsWith('threadProfile') ||
    p.includes('_status');

  const allowedAttrs = new Set([
    'data-tid', 'data-testid', 'data-mid', 'data-reply-chain-id', 'data-message-content',
    'data-mention-type', 'data-person-mri', 'data-track-thread-id', 'role', 'id', 'itemtype', 'itemid',
    'aria-live', 'aria-label', 'aria-busy', 'aria-expanded', 'alt', 'href', 'type', 'title', 'numberoffiles',
  ]);

  const strings = collectSelectorStrings(selectors).filter((s) => !notSelector(s.path));
  assert.ok(strings.length > 15, 'セレクタが少なすぎる（収集ロジックの誤り）');

  // 素のタグ名（time / a / img など）は難読化されない意味的な指定なので許可する
  const bareTags = new Set(['time', 'a', 'img', 'span', 'div', 'pre', 'code', 'table', 'blockquote']);

  for (const s of strings) {
    const attrs = [...s.value.matchAll(/\[([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]);
    if (attrs.length === 0) {
      assert.ok(bareTags.has(s.value.trim()), `${s.path} = ${s.value} が属性セレクタでも素のタグ名でもない`);
      continue;
    }
    for (const a of attrs) {
      assert.ok(allowedAttrs.has(a), `${s.path} = ${s.value}: 属性 ${a} は許可リストにない`);
    }
  }
});

test('src/ にセレクタをハードコードしていない', () => {
  const dir = path.join(repoRoot, 'src');
  for (const file of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(stripped, /\[data-tid/, `${file} に data-tid セレクタがハードコードされている`);
    assert.doesNotMatch(stripped, /schema\.skype\.com/, `${file} に itemtype がハードコードされている`);
    assert.doesNotMatch(stripped, /\bclassName\b|classList|\[class/, `${file} が class に依存している`);
  }
});
