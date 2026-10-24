const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(process.env.APP_SOURCE || 'app.js', 'utf8');
const section = source.slice(source.indexOf('const MAX_PDF_BYTES') >= 0 ? source.indexOf('const MAX_PDF_BYTES') : source.indexOf('async function openPdf(file)'), source.indexOf('/* ============================================================\n   放置與操作標註'));
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function setup() {
  const canvases = [], tasks = [], alerts = [];
  function element(tag) { const e = { tag, style: {}, dataset: {}, children: [], width: 0, height: 0,
    append(...x) { this.children.push(...x); }, replaceChildren(...x) { this.children = x; },
    querySelector(tag) { return this.children.find(c => c.tag === tag); },
    getContext() { return {}; }, addEventListener() {} }; if (tag === 'canvas') canvases.push(e); return e; }
  const oldWrap = element('div'); oldWrap.append(element('canvas')); oldWrap.children[0].width = 100;
  const state = { pdfBytes: new Uint8Array([99]).buffer, fileName: 'original', marks: [{ text: 'preserve' }], pages: [{ wrapEl: oldWrap }], selectedId: 'old' };
  const el = { pages: element('div'), emptyState: {}, exportBtn: {}, clearMarksBtn: {}, stage: {} };
  const context = vm.createContext({ state, el, CSS_SCALE: 1.35, RENDER_SCALE: 2,
    document: { createElement: element }, console: { error() {} }, alert: x => alerts.push(x),
    stopEditing() {}, disarm() {}, hideFloatBar() {}, toast() {}, onOverlayMouseDown() {},
    pdfjsLib: { getDocument({ data }) {
      const id = new Uint8Array(data)[0]; const task = { destroyed: 0, destroy() { this.destroyed++; return Promise.resolve(); } };
      task.promise = id === 0 ? Promise.reject(new Error('corrupt')) : Promise.resolve({ numPages: id === 5 ? 101 : id === 7 ? 3 : id === 3 ? 2 : 1,
        async getPage(n) { return { getViewport({scale}) { return { width: (id === 6 ? 5000 : id === 7 ? 2000 : id * 100) * scale, height: (id === 6 ? 5000 : id === 7 ? 2000 : 200) * scale }; }, cleanup() {},
          render() { return { promise: id === 2 ? renderGate.promise : id === 3 && n === 2 ? Promise.reject(new Error('render failure')) : Promise.resolve() }; } }; } });
      tasks.push(task); return task;
    } } });
  const renderGate = deferred();
  vm.runInContext(section + '\nglobalThis.open = openPdf;', context);
  const file = id => ({ name: `doc${id}.pdf`, arrayBuffer: async () => new Uint8Array([id]).buffer });
  return { state, el, tasks, alerts, canvases, renderGate, open: context.open, file };
}
test('corrupt replacement preserves original bytes, marks and pages', async () => {
  const h = setup(); const previous = { ...h.state }; await h.open(h.file(0));
  assert.equal(h.state.pdfBytes, previous.pdfBytes); assert.equal(h.state.marks, previous.marks);
  assert.equal(h.state.pages, previous.pages); assert.equal(h.el.emptyState.hidden, true); assert.equal(h.alerts.length, 1);
});
test('failed page render retains original and releases staging canvases', async () => {
  const h = setup(); await h.open(h.file(3)); assert.equal(h.state.fileName, 'original');
  assert.equal(h.state.marks[0].text, 'preserve');
  assert.ok(h.canvases.slice(1).every(c => c.width === 0 && c.height === 0)); assert.ok(h.tasks[0].destroyed >= 1);
});
test('later PDF wins when earlier render resolves last', async () => {
  const h = setup(); const first = h.open(h.file(2));
  await new Promise(r => setImmediate(r)); await h.open(h.file(1)); h.renderGate.resolve(); await first;
  assert.equal(h.state.fileName, 'doc1'); assert.equal(h.state.pages.length, 1); assert.equal(h.state.pages[0].width, 100);
  assert.equal(h.el.pages.children.length, 1); assert.ok(h.tasks.every(t => t.destroyed >= 1));
  assert.equal(h.canvases[0].width, 0); assert.equal(h.canvases[1].width, 0);
});
test('slower file read cannot start obsolete PDF worker', async () => {
  const h = setup(), read = deferred(); const first = h.open({ name: 'slow.pdf', arrayBuffer: () => read.promise });
  await h.open(h.file(1)); h.renderGate.resolve(); read.resolve(new Uint8Array([2]).buffer); await first;
  assert.equal(h.tasks.length, 1); assert.equal(h.state.fileName, 'doc1');
});

test('oversized file is rejected before reading; original remains retryable', async () => {
  const h = setup(); let reads = 0;
  await h.open({name:'oversized.pdf',size:25*1024*1024+1,arrayBuffer(){reads++;throw Error('must not read');}});
  assert.equal(reads,0);assert.equal(h.tasks.length,0);assert.equal(h.state.fileName,'original');
  assert.equal(h.state.marks[0].text,'preserve');assert.match(h.alerts[0],/25 MB/);
  await h.open(h.file(1));assert.equal(h.state.fileName,'doc1');
});
for (const [id, hint, allocated] of [[5,/100 頁/,0],[6,/尺寸或總解析度/,0],[7,/尺寸或總解析度/,2]]) {
  test(`PDF resource limit ${id} preserves old document and releases staging`, async () => {
    const h = setup(); const previous = {...h.state};await h.open(h.file(id));
    assert.equal(h.state.pdfBytes,previous.pdfBytes);assert.equal(h.state.marks,previous.marks);
    assert.equal(h.state.pages,previous.pages);assert.match(h.alerts[0],hint);
    assert.ok(h.tasks[0].destroyed>=1);
    assert.equal(h.canvases.slice(1).filter(c=>c.width>0||c.height>0).length,0);
    // At most the bounded preceding pages were rendered, never the over-budget page.
    assert.equal(h.canvases.slice(1).length,allocated);
    await h.open(h.file(1));assert.equal(h.state.fileName,'doc1');
  });
}
