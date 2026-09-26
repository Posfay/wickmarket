// Zero-dependency standalone build: packs index.html + CSS + every src/ module into ONE html file
// that opens straight from disk (file://), no server needed. Three.js and fonts still load from CDN.
//
// How: each module is embedded as a data: URL and registered in the page's import map under a bare
// specifier ("@wm/core/config.js"); relative imports are rewritten to those specifiers, so the
// browser's own module loader links everything exactly as it does when served.
//
// Usage: node scripts/build-standalone.mjs   →   dist/wickmarket.html
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'dist', 'wickmarket.html');
const PREFIX = '@wm/';

async function listModules(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listModules(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const toSpecifier = file => PREFIX + relative(SRC, file).split(sep).join('/');

/** Rewrite './x.js' / '../y/z.js' in static `from '…'` and dynamic `import('…')` to @wm/ specifiers. */
function rewriteImports(code, file) {
  const fromDir = relative(SRC, dirname(file)).split(sep).join('/');
  const fix = spec => {
    if (!spec.startsWith('.')) return spec;
    const target = posix.normalize(posix.join(fromDir || '.', spec));
    if (target.startsWith('..')) throw new Error(`${file}: import escapes src/: ${spec}`);
    return PREFIX + target;
  };
  return code
    .replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, kw, q, spec) => `${kw}${q}${fix(spec)}${q}`)
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, kw, q, spec) => `${kw}${q}${fix(spec)}${q}`);
}

const files = await listModules(SRC);
const imports = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js',
  'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/',
};
let bytes = 0;
for (const file of files.sort()) {
  const code = rewriteImports(await readFile(file, 'utf8'), file);
  bytes += code.length;
  imports[toSpecifier(file)] = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
}

// Inline the stylesheets (styles.css starts with @import of src/ui/ui.css).
const uiCss = await readFile(join(SRC, 'ui', 'ui.css'), 'utf8');
const baseCss = (await readFile(join(ROOT, 'styles.css'), 'utf8'))
  .replace(/@import\s+url\(["']?src\/ui\/ui\.css["']?\)\s*;?/, '');
const css = `${uiCss}\n${baseCss}`.replace(/<\/style/gi, '<\\/style');

let html = await readFile(join(ROOT, 'index.html'), 'utf8');
const mapJson = JSON.stringify({ imports }).replace(/<\/script/gi, '<\\/script');
html = html
  .replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="importmap">[\s\S]*?<\/script>/, () => `<script type="importmap">${mapJson}</script>`)
  .replace(/<script type="module" src="src\/main\.js"><\/script>/, () => `<script type="module">import '${PREFIX}main.js';</script>`);
if (!html.includes(`import '${PREFIX}main.js'`) || !html.includes('<style>')) {
  throw new Error('index.html no longer matches the expected structure; update build-standalone.mjs');
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`Wrote ${relative(ROOT, OUT)}: ${files.length} modules, ${(bytes / 1024).toFixed(0)} KB of source, ${(html.length / 1024).toFixed(0)} KB total.`);
