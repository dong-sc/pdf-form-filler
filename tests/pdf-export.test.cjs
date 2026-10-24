const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(process.env.APP_SOURCE || 'app.js', 'utf8');
const start = source.includes('let exportingPdf') ? source.indexOf('let exportingPdf') : source.indexOf('async function exportPdf()');
const section = source.slice(start, source.indexOf('// 頁面若有 rotation'));
test('export freezes original document and marks across replacement; duplicate call ignored', async () => {
  let resolveLoad, loads = 0, filename; const drawn = [];
  const state = { pdfBytes: new Uint8Array([1]).buffer, fileName: 'original', marks: [{page: 1,kind:'text',text:'original mark',size:12,x:0,y:0,seq:1}], images: [], pages:[{width:100,height:100}] };
  const ctx = vm.createContext({ state, el:{exportBtn:{textContent:'輸出 PDF'}}, stopEditing(){},confirm(){return true;}, toast(){},console,alert(){},
    PDFDocument:{ load(){ loads++; return new Promise(r => resolveLoad=r); } },
    document:{createElement(){return {getContext(){return {scale(){},fillText(text){drawn.push(text);}};},toDataURL(){return 'image';}};}},
    EXPORT_SCALE:3,TEXT_FONT:'sans-serif',LINE_HEIGHT:1.2,unrotateLayer(x){return x;}, Blob,
    downloadBlob(blob,name){filename=name;} });
  vm.runInContext(section+'\nglobalThis.run = exportPdf;',ctx);
  const exporting = ctx.run(); const duplicate = ctx.run();
  state.fileName='replacement'; state.marks[0].text='changed';state.marks=[];state.pages=[];
  resolveLoad({getPages(){return [{getCropBox(){return {x:0,y:0,width:100,height:100};},getRotation(){return {angle:0};},drawImage(){}}];},async embedPng(){return {};},async save(){return new Uint8Array([1]);}});
  await exporting; await duplicate;
  assert.equal(loads,1);assert.equal(filename,'original-已填.pdf');assert.deepEqual(drawn,['original mark']);assert.equal(ctx.el.exportBtn.disabled,false);
});
