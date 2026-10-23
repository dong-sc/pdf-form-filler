// Dependency-free syntax check for standalone JS and executable mobile inline scripts.
const fs = require('node:fs');
const vm = require('node:vm');
new vm.Script(fs.readFileSync('app.js', 'utf8'), {filename:'app.js'});
const mobile = fs.readFileSync('m/index.html', 'utf8');
let count = 0;
for (const match of mobile.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=|type\s*=\s*["'](?:application\/ld\+json|text\/plain)/i.test(match[1])) continue;
  new vm.Script(match[2], {filename:`m/index.html:inline-${++count}`});
}
if (!count) throw new Error('No executable mobile scripts found');
console.log(`Syntax valid: app.js and ${count} mobile inline scripts`);
