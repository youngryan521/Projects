// Build script -- preserves ==UserScript== header, minifies body with esbuild.
// Usage: node build.js  (or: bun build.js)
// Output: dist/fc-auto-v5.min.user.js

const esbuild = require('esbuild');
const fs      = require('fs');

const SRC  = 'fc-auto-v5.user.js';
const DIST = 'dist/fc-auto-v5.min.user.js';

const source = fs.readFileSync(SRC, 'utf8');

// Extract the ==UserScript== ... ==/UserScript== header block (must stay at top, unminified)
const headerMatch = source.match(/^(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\r?\n)/);
if (!headerMatch) {
  console.error('ERROR: UserScript header block not found in', SRC);
  process.exit(1);
}

const header = headerMatch[1];
const body   = source.slice(header.length);

// Minify the script body -- transform only, no bundling needed (no imports)
const result = esbuild.transformSync(body, {
  minify: true,
  loader: 'js',
  target: 'es2022',
});

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(DIST, header + result.code, 'utf8');

const origSize = Buffer.byteLength(source, 'utf8');
const minSize  = fs.statSync(DIST).size;
const savings  = ((1 - minSize / origSize) * 100).toFixed(1);

console.log('Built:    ' + DIST);
console.log('Original: ' + origSize + ' bytes');
console.log('Minified: ' + minSize  + ' bytes  (' + savings + '% smaller)');
