#!/usr/bin/env node
// jobpilot extract-style — measure the look of the user's own resume PDF.
//
//   node extract-style.mjs <resume.pdf> [--preview=<page.png>]
//
// Prints JSON: a `resume_style` measured from the PDF (font, sizes in pt,
// colors, header alignment, section order) for setup to review and store in
// profile.md, plus `notes` for what can't be measured (contact icons, bullet
// character, font family class) — those are read off the page image.
// Nothing here interprets content.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMainModule } from './lib/main.mjs';
import { bundledFont, normalizeStyle } from './lib/resume-style.mjs';

const require = createRequire(import.meta.url);
const SECTION_NAMES = /^(summary|profile|objective|about|experience|work experience|professional experience|employment|education|skills|technical skills|projects|certifications?|publications?|awards|languages|volunteer(?:ing)?)$/i;

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const hex = (rgb) => '#' + Array.from(rgb, (c) => Math.round(c).toString(16).padStart(2, '0')).join('');
const mode = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};
// "MerriweatherLight18pt-Regular" → "Merriweather"
const familyOf = (postscript) => String(postscript || '').replace(/^[A-Z]{6}\+/, '')
  .replace(/-.*$/, '').replace(/(Light|Regular|Bold|Medium|Semibold|Italic)\d*(pt)?$/i, '').replace(/(?<=[a-z])(?=[A-Z])/g, ' ').trim();
const isLight = (postscript) => /light|thin/i.test(String(postscript));
const luminance = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

export async function extractStyle(pdfPath) {
  const pdfjs = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  pdfjs.disableWorker = true; // as pdf-parse does: no browser worker or DOM font loading in Node
  // Fetching the operator list makes pdf.js try to attach fonts to a DOM that Node lacks;
  // it reads this setting from the global scope.
  globalThis.PDFJS = Object.assign(globalThis.PDFJS || {}, { disableFontFace: true });
  const doc = await pdfjs.getDocument(new Uint8Array(await readFile(pdfPath)));
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n);
    pages.push({ n, page, ops: await page.getOperatorList(), items: (await page.getTextContent()).items.filter((i) => i.str.trim()) });
  }
  const { width, height } = pages[0].page.getViewport(1);
  // One coordinate space top to bottom across pages: `pos` grows downward.
  const line = (i, n) => ({
    text: i.str.trim(), x: i.transform[4], y: i.transform[5], pos: n * 10000 - i.transform[5], w: i.width,
    size: Math.hypot(i.transform[0], i.transform[1]),
  });
  const all = pages.flatMap(({ n, items }) => items.map((i) => line(i, n)));
  const first = all.filter((t) => t.pos < 10000);

  // Body size: the most common size by characters. Name: the largest text.
  const bySize = new Map();
  for (const t of all) bySize.set(round(t.size), (bySize.get(round(t.size)) || 0) + t.text.length);
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0][0];
  const name = first.reduce((a, b) => (b.size > a.size ? b : a));
  const headings = all.filter((t) => SECTION_NAMES.test(t.text) && t.size > body);
  const heading = headings.length ? mode(headings.map((h) => round(h.size))) : round(body * 1.25);
  const roles = all.filter((t) => t.size > body && t.size < heading && t.size > body * 1.05 && !SECTION_NAMES.test(t.text));
  const role = roles.length ? mode(roles.map((r) => round(r.size))) : round(body * 1.15);
  const contactLine = first.filter((t) => t.pos > name.pos + 1 && t.pos - name.pos < name.size * 2.5).sort((a, b) => a.pos - b.pos)[0];
  const contact = contactLine ? first.filter((t) => Math.abs(t.pos - contactLine.pos) < 1) : [];

  // Header alignment: is the name centered on the page or flush with the body's left edge?
  const leftEdge = Math.min(...all.map((t) => t.x));
  const centered = Math.abs(name.x + name.w / 2 - width / 2) < width * 0.03 && name.x > leftEdge + width * 0.08;

  // Font family from the PDF's font descriptors (pdf.js doesn't expose it): the most
  // common one. A variable font ("Light18pt") reports one name for every weight, so only
  // "Light" in the name is read as a light body.
  const psNames = [...(await readFile(pdfPath)).toString('latin1').matchAll(/\/FontName\s*\/([^\s/>\]]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, ''));
  const bodyFont = mode(psNames.filter((n) => !/symbol|icon|awesome/i.test(n)));
  const font = bodyFont ? familyOf(bodyFont) : undefined;

  // Colors: the most-used fill is the ink; a very light one is the divider; a black-or-dark
  // stroke drawn under headings is the rule. Near-white is the page.
  const O = pdfjs.OPS;
  const fills = new Map(); const strokes = new Map();
  for (const { ops } of pages) for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i];
    const target = f === O.setFillRGBColor ? fills : f === O.setStrokeRGBColor ? strokes : null;
    if (target) { const k = hex(ops.argsArray[i]); target.set(k, (target.get(k) || 0) + 1); }
  }
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const darks = [...fills].filter(([h]) => luminance(rgb(h)) < 140).sort((a, b) => b[1] - a[1]);
  const lights = [...strokes].filter(([h]) => { const l = luminance(rgb(h)); return l > 200 && l < 250; });
  const ruleColors = [...strokes].filter(([h]) => luminance(rgb(h)) < 140).sort((a, b) => a[1] - b[1]);

  // Section order, as the headings appear top to bottom.
  const sections = headings.sort((a, b) => a.pos - b.pos).map((h) => h.text.toLowerCase().replace(/\s+/g, '-'));

  const resume_style = normalizeStyle({
    font,
    weight: bodyFont && isLight(bodyFont) ? 300 : 400,
    sizes: { body, name: round(name.size), heading, role, contact: contact.length ? round(contact[0].size) : round(body * 0.9) },
    ink: darks[0]?.[0],
    rule: ruleColors[0]?.[0] ?? darks[0]?.[0],
    divider: lights[0]?.[0],
    header: centered ? 'center' : 'left',
    sections: sections.length ? sections : undefined,
    margin: round(leftEdge / 72, 2),
  });

  const notes = [];
  if (!font) notes.push('no font name found in the PDF: pick the font and family (serif|sans) from the page image');
  else if (!bundledFont(font)) notes.push(`font "${font}" is not bundled (fonts/): set resume_style.family to serif or sans from the page image; the closest system font is used`);
  notes.push('read off the page image: family (serif|sans), bullet character, whether contact items have icons (icons), which contact items appear (contact)');
  return {
    resume_style,
    measured: { page: { width: round(width), height: round(height), paper: Math.abs(width - 595) < 8 ? 'a4' : Math.abs(width - 612) < 8 ? 'letter' : 'other' }, bodyFont, marginLeftPt: round(leftEdge) },
    pages: doc.numPages,
    notes,
  };
}

/** PNG of page 1 for the visual read. Needs poppler's pdftoppm; null when it isn't installed. */
async function previewPage(pdfPath, out) {
  try {
    await promisify(execFile)('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', '1', '-singlefile', pdfPath, out.replace(/\.png$/, '')]);
    return out;
  } catch { return null; }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const preview = args.find((a) => a.startsWith('--preview='))?.slice(10);
  if (!file || !/\.pdf$/i.test(file)) {
    console.error('Usage: node extract-style.mjs <resume.pdf> [--preview=<page.png>]');
    process.exit(1);
  }
  extractStyle(file)
    .then(async (result) => {
      if (preview) result.preview = await previewPage(file, preview);
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => { console.error(`❌ could not read the resume's style: ${err.message}`); process.exit(1); });
}
