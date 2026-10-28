#!/usr/bin/env node
// 把 license.txt 编译成 license.rtf：非 ASCII 一律转成 \uN? 转义，避免任何编码歧义。
// 用法：node src-tauri/installer/src/make_license_rtf.mjs
// 依据：docs/安装器原型/setup-ui-prototype.html（中文摘要 + MIT 全文，正文控制在 3 屏以内）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'license.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const esc = (text) =>
  [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (ch === '\\') return '\\\\';
      if (ch === '{' || ch === '}') return '\\' + ch;
      if (ch === '\n') return '\\par\n';
      if (cp < 128) return ch;
      // RTF 的 \uN 取有符号 16 位整数，超出 32767 要折算为负值
      return `\\u${cp > 32767 ? cp - 65536 : cp}?`;
    })
    .join('');

const rtf =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0\n' +
  '{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}}\n' +
  '\\fs20\\f0\n' +
  esc(src) +
  '\n}';

writeFileSync(join(here, '..', 'license.rtf'), rtf, 'utf8');
console.log(`license.rtf written: ${rtf.length} chars`);
