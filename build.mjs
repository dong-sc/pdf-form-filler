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

// 取出 body 內容（去掉原本的 script 標籤，改用內嵌）。
// 從 </head> 之後才開始找開頭標籤——否則 head 裡只要有註解提到那個標籤名，
// indexOf 就會抓到註解，把 head 的內容一起切進來。
const headEnd = html.indexOf('</head>');
// Keep page metadata and the guide styling in the bundled output as well.
const seoHead = (html.slice(0, headEnd).match(/<title>[^]*?<\/title>|<meta\b[^>]*(?:name="(?:description|robots|twitter:[^"]+)"|property="og:[^"]+")[^>]*>|<link\b[^>]*rel="canonical"[^>]*>|<script type="application\/ld\+json">[^]*?<\/script>|<style>\s*\.tool-guide[^]*?<\/style>/g) || []).join('\n');
const identityIcons = (html.slice(0, headEnd).match(/<link\b[^>]*data-tool-icon[^>]*>/g) || []).join('\n');
const bodyOpen = html.indexOf('<body>', headEnd) + 6;
const bodyClose = html.indexOf('</body>', bodyOpen);
if (headEnd < 0 || bodyOpen < 6 || bodyClose < 0) {
  throw new Error('index.html 結構不符預期，找不到 body 區段');
}

const body = html
  .slice(bodyOpen, bodyClose)
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  // 單檔版是獨立的一個檔案，沒有 m/ 目錄，相對連結會壞掉
  .replace(/href="m\/"/g, 'href="https://simple-pdf.donglinphoto.com/m/"')
  .trim();

const out = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${seoHead}
${identityIcons}
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

const mb = (Buffer.byteLength(out) / 1024 / 1024).toFixed(2);

// 給本機用的：雙擊就開
fs.writeFileSync(path.join(DIR, '勞報單填寫工具.html'), out);

// 給 Cloudflare Pages 用的：整個網站就這一頁
const dist = path.join(DIR, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), out);
fs.copyFileSync(path.join(DIR, '_headers'), path.join(dist, '_headers'));
for (const name of ['robots.txt', 'sitemap.xml']) {
  fs.copyFileSync(path.join(DIR, name), path.join(dist, name));
}
fs.cpSync(path.join(DIR, 'identity'), path.join(dist, 'identity'), { recursive: true });

console.log(`已產生 勞報單填寫工具.html 與 dist/index.html  ${mb} MB`);
