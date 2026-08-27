/* Deploy guard: inline HTML handlers call globals by name, so minification must not
   drop or rename them. Scans .html files and JS-generated markup for `on<event>="fn("`
   and verifies every referenced name still exists in public/js. */

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HANDLER_PATTERN = /\bon[a-z]+\s*=\s*(?:"|'|\\")\s*([A-Za-z_$][\w$]*)\s*\(/g;
const BUILT_INS = new Set(['this', 'return', 'javascript', 'alert', 'confirm']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(html|js)$/.test(entry.name) ? [full] : [];
  });
}

const files = walk(PUBLIC_DIR);
const referenced = new Set();
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(HANDLER_PATTERN)) {
    if (!BUILT_INS.has(match[1])) referenced.add(match[1]);
  }
}

const scripts = files.filter(file => file.endsWith('.js'))
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n');

const missing = [...referenced].filter(name =>
  !new RegExp(`(?:function\\s+${name}\\b|\\b${name}\\s*=|\\b${name}\\s*:)`).test(scripts)
);

if (missing.length) {
  console.error(`Inline handlers reference names that no longer exist in public/js:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

console.log(`Verified ${referenced.size} inline handler globals across ${files.length} files.`);
