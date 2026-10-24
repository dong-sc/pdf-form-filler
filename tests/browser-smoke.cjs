const { chromium }=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=process.cwd();const server=http.createServer((req,res)=>{const f=path.join(root,decodeURIComponent(req.url.split('?')[0])==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));try{res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.statusCode=404;res.end();}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});try{const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());page.on('dialog',d=>d.dismiss());await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>typeof openPdf==='function');const result=await page.evaluate(async()=>{const doc=await PDFLib.PDFDocument.create();for(let i=0;i<12;i++)doc.addPage([200,300]);const bytes=await doc.save();await openPdf(new File([bytes],'synthetic.pdf',{type:'application/pdf'}));addTextMark(1,20,20,'合成測試');const old=state.pdfBytes,marks=state.marks;await openPdf(new File(['bad pdf'],'bad.pdf'));const preserved=state.pdfBytes===old&&state.marks===marks&&state.pages.length===12;await openPdf(new File([bytes],'replacement.pdf',{type:'application/pdf'}));return {preservedAfterCorrupt:preserved,finalPages:state.pages.length,visibleCanvases:document.querySelectorAll('#pages canvas').length,finalMarks:state.marks.length,exportEnabled:!el.exportBtn.disabled};});await page.goto(`http://127.0.0.1:${server.address().port}/m/index.html`);
await page.setViewportSize({width:390,height:844});
const mobileBytes = await page.evaluate(async () => { const doc=await PDFLib.PDFDocument.create();for(let i=0;i<3;i++)doc.addPage([200,300]);return Array.from(await doc.save()); });
await page.locator('#pdfInput').setInputFiles({name:'mobile-synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from(mobileBytes)});
await page.waitForFunction(()=>document.querySelectorAll('#pages canvas').length===3 && !document.querySelector('#exportBtn').disabled);
await page.locator('.overlay').first().click({position:{x:50,y:50}});
await page.locator('[contenteditable="plaintext-only"]').fill('手機合成標註');
await page.locator('header h1').click();
await Promise.all([
  page.waitForEvent('dialog'),
  page.locator('#pdfInput').setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('not pdf')}),
]);
result.mobile = await page.evaluate(()=>({pages:document.querySelectorAll('#pages canvas').length,marks:document.querySelector('#pages').textContent.includes('手機合成標註'),exportEnabled:!document.querySelector('#exportBtn').disabled}));
if(result.mobile.pages!==3 || !result.mobile.marks || !result.mobile.exportEnabled)throw Error('mobile recovery assertion failed');
console.log(JSON.stringify(result));if(!result.preservedAfterCorrupt||result.finalPages!==12||result.visibleCanvases!==12||!result.exportEnabled)throw Error('browser assertions failed');}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
