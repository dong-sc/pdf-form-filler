/* 把整個工具打包成一個可以雙擊開啟的 HTML 檔。
   改過 app.js / style.css / index.html 之後，重跑一次：
       node build.mjs
*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

// 內嵌的 JS 若含有 </script> 會提早關閉標籤，先擋掉（在 JS 裡兩者等價）
const safe = (js) => js.replace(/<\/script>/gi, '<\\/script>');

const html = read('index.html');
const css = read('style.css');
const app = read('app.js');
const pdfjs = read('lib/pdf.js');
const pdflib = read('lib/pdf-lib.min.js');
const worker = read('lib/pdf.worker.js');

// 取出 <body> 內容（去掉原本的 script 標籤，改用內嵌）
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .trim();

const out = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>勞報單填寫工具</title>
<style>
${css}
</style>
</head>
<body>

${body}

<script>${safe(pdfjs)}</script>
<script>${safe(pdflib)}</script>

<!-- worker 的原始碼；file:// 底下不能直接載入外部 worker，改包成 blob -->
<script id="pdfWorkerSource" type="text/plain">${safe(worker)}</script>
<script>
  window.__PDFJS_WORKER_SRC = URL.createObjectURL(
    new Blob([document.getElementById('pdfWorkerSource').textContent],
             { type: 'text/javascript' }));
</script>

<script>${safe(app)}</script>
</body>
</html>
`;

const target = path.join(DIR, '勞報單填寫工具.html');
fs.writeFileSync(target, out);

console.log(`已產生 ${path.basename(target)}  ${(Buffer.byteLength(out) / 1024 / 1024).toFixed(2)} MB`);
