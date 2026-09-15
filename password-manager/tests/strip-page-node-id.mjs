/* 剔除 IDE 可视化页面编辑器注入的 data-page-node-id 属性
 *
 * 运行：node password-manager/tests/strip-page-node-id.mjs
 *
 * 背景：在 IDE 里用可视化页面编辑器打开过插件页面后，index.html 会被注入几百个
 * `data-page-node-id="xxx"`。后果有两层：
 *   1. 已签插件的文件哈希全变 → signature.json 失效（签名是逐文件 SHA-256）；
 *   2. 两百多行纯属性 diff 会污染 code review（插件审核要求读全文源码）。
 * 这些属性对运行毫无影响，纯编辑器内部标记，剔除后内容与手写版逐字节一致。
 *
 * 自检：剔除后跑 `git diff --stat <插件>/0.1.0/*.html` 应为空；
 *      或跑 tests/ui-smoke.mjs 的哨兵断言（页面不得出现该属性）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const versionDir = path.join(here, '..', '0.1.0');
const RE = / data-page-node-id="[^"]*"/g;

const pages = fs.readdirSync(versionDir).filter((f) => /\.html?$/i.test(f));
if (!pages.length) { console.log('未找到页面文件'); process.exit(1); }

let total = 0;
for (const page of pages) {
  const file = path.join(versionDir, page);
  const before = fs.readFileSync(file, 'utf8');
  const hits = (before.match(RE) || []).length;
  if (!hits) { console.log(`  ${page}：干净`); continue; }
  fs.writeFileSync(file, before.replace(RE, ''));
  total += hits;
  console.log(`  ${page}：剔除 ${hits} 个`);
}
console.log(total
  ? `\n共剔除 ${total} 个属性。改动后请重新签名（spark-sign sign），否则签名与文件对不上。`
  : '\n无需改动。');
