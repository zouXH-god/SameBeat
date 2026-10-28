// Export web-sized assets from the original ImageGen PNGs. No visual retouching.
const fs = require('node:fs');
const path = require('node:path');
// Prefer a caller-provided/local sharp install, with the desktop bundled runtime as fallback.
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/prepare-theme-assets.cjs <generated-image-directory>');
const target = path.resolve('public/assets');
fs.mkdirSync(target, { recursive: true });
const assets = [
  ['mascot', 'exec-1f8dd7a2-3bde-4659-8205-43c2ada3ebe2.png', 640],
  ['forest', 'exec-2f53f571-ab7f-42fd-83d3-3b996e65cf70.png', 1200],
  ['avatar', 'exec-3b8456e1-dd2c-4b16-bee7-bf9e5165193f.png', 160],
  ['listening', 'exec-bfc3d3e2-4bbd-417c-b810-093e2aa2d34b.png', 320],
  ['waiting', 'exec-21608091-24aa-4a3e-98a4-f02fa1bbc761.png', 320],
  ['botanical', 'exec-e25a848d-85bc-474b-b0fc-c527d731865a.png', 480],
];
(async () => {
  for (const [name, filename, width] of assets) {
    const input = path.join(source, filename);
    fs.copyFileSync(input, path.join(target, name + '.png'));
    await sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 100 }).toFile(path.join(target, name + '.webp'));
    const stats = await sharp(input).stats();
    console.log(name, JSON.stringify({ opaque: stats.isOpaque, bytes: fs.statSync(path.join(target, name + '.webp')).size }));
  }
  await sharp(path.join(target, 'avatar.png')).resize(48, 48).png().toFile(path.join(target, 'favicon.png'));
})().catch(error => { console.error(error); process.exitCode = 1; });
