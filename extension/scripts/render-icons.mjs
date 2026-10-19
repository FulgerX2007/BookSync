// Renders icons/icon.svg to the PNGs the manifest uses (node scripts/render-icons.mjs).
// Toolbar sizes are full-bleed; 128 keeps the Chrome Web Store's 16 px
// transparent margin around 96 px of artwork.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync('icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
/** @type {Array<{ size: number, art: number }>} */
const sizes = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
];
for (const { size, art } of sizes) {
  const pad = (size - art) / 2;
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace('width="512" height="512"', `width="${art}" height="${art}"`);
  await page.setContent(`<body style="margin:0"><div style="padding:${pad}px;width:${art}px;height:${art}px">${sized}</div></body>`);
  await page.screenshot({ path: `icons/icon-${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
