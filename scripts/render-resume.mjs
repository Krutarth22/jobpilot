#!/usr/bin/env node
// jobpilot render-resume — HTML → PDF via headless Chromium (Playwright).
// Reduced from career-ops generate-pdf.mjs (MIT) to the ~50 lines a tailored
// resume needs: ATS-safe text normalization + a clean print render.
//
//   node render-resume.mjs <input.html> <output.pdf> [--format=a4|letter] [--max-pages=N] [--preview=<dir>] [--style=<profile.md>]
//
// Exit 3: the PDF was written but is over the page limit or has text running
// past the page edge — trim and render again.

import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './lib/main.mjs';
import { parseProfile } from './lib/profile.mjs';
import { normalizeStyle, styleCss } from './lib/resume-style.mjs';

function normalizeTextForATS(html) {
  // Only touches body text — ATS parsers choke on typographic punctuation.
  return html.replace(/>([^<]+)</g, (_, text) => '>' + text
    .replace(/\u2014|\u2013/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ') + '<');
}

function injectStyle(html, css) {
  const tag = `<style>\n${css}\n</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return `${tag}\n${html}`;
}

// Printable width in CSS px (96/in): content wider than this runs off the page.
const PAPER_WIDTH_IN = { letter: 8.5, a4: 8.27 };
const contentWidthPx = (format, marginIn) => Math.floor((PAPER_WIDTH_IN[format] - 2 * marginIn) * 96);

async function pdfPageCount(buffer) {
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  return (await pdfParse(buffer)).numpages;
}

/** PNG previews of every page, for a visual check. pdftoppm when installed
 * (one image per page); otherwise one full-length screenshot of the print view. */
async function writePreviews(page, pdfPath, previewDir) {
  await mkdir(previewDir, { recursive: true });
  try {
    await promisify(execFile)('pdftoppm', ['-png', '-r', '60', pdfPath, join(previewDir, 'page')]);
    return (await readdir(previewDir)).filter((f) => /^page.*\.png$/.test(f)).sort().map((f) => join(previewDir, f));
  } catch {
    const shot = join(previewDir, 'page-all.png');
    await page.screenshot({ path: shot, fullPage: true });
    return [shot];
  }
}

/**
 * Render HTML to PDF. Returns the page count and any text that runs past the
 * printable width (`overflow`), and — with `previewDir` — PNG previews.
 */
export async function renderHtmlToPdf(html, outputPath, { format = 'a4', previewDir = null, style = null } = {}) {
  if (!PAPER_WIDTH_IN[format]) format = 'a4';
  const look = normalizeStyle(style);
  const { chromium } = await import('playwright');
  const tmpHtmlPath = resolve(dirname(outputPath), `.jobpilot-render-${randomUUID()}.html`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(tmpHtmlPath, injectStyle(normalizeTextForATS(html), styleCss(look, { format })), 'utf8');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    // The resume is static, untrusted-input-derived markup: no scripts, no network.
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: contentWidthPx(format, look.margin), height: 1000 },
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith('file:') || url.startsWith('data:') ? route.continue() : route.abort();
    });
    await page.goto(pathToFileURL(tmpHtmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ media: 'print' });
    // page.evaluate runs in Playwright's utility world, so it works with the
    // page's own scripts disabled.
    const overflow = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth + 1;
      const hits = [];
      // Only elements that hold text themselves: a container is "wide" only
      // because a child is, and would repeat the whole section.
      const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      for (const el of document.body.querySelectorAll('*')) {
        if (!ownText(el)) continue;
        const r = el.getBoundingClientRect();
        const spills = el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1; // text wider than its box
        if ((r.width > 0 && r.right > limit) || spills) {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (text && !hits.some((h) => h.includes(text.slice(0, 80)) || text.includes(h))) hits.push(text.slice(0, 80));
        }
      }
      return hits.slice(0, 5);
    });
    const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    await writeFile(outputPath, buffer);
    const pages = await pdfPageCount(buffer);
    const previews = previewDir ? await writePreviews(page, outputPath, previewDir) : [];
    return { outputPath, size: buffer.length, pages, overflow, previews };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await unlink(tmpHtmlPath).catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const format = args.find((a) => a.startsWith('--format='))?.slice(9) || 'a4';
  const maxPages = Number(args.find((a) => a.startsWith('--max-pages='))?.slice(12)) || null;
  const styleFrom = args.find((a) => a.startsWith('--style='))?.slice(8) || null;
  const previewDir = args.find((a) => a.startsWith('--preview='))?.slice(10) || null;
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath || !['a4', 'letter'].includes(format)) {
    console.error('Usage: node render-resume.mjs <input.html> <output.pdf> [--format=a4|letter] [--max-pages=N] [--preview=<dir>]');
    process.exit(1);
  }
  const styleFor = async () => (styleFrom ? parseProfile(await readFile(resolve(styleFrom), 'utf8')).frontmatter.resume_style : null);
  Promise.all([readFile(resolve(inputPath), 'utf8'), styleFor()])
    .then(([html, style]) => renderHtmlToPdf(html, resolve(outputPath), { format, style, previewDir: previewDir && resolve(previewDir) }))
    .then(({ outputPath: out, size, pages, overflow }) => {
      console.log(`✅ PDF generated: ${out} (${(size / 1024).toFixed(1)} KB, ${pages} page(s))`);
      for (const text of overflow) console.error(`⚠️  runs past the page edge: "${text}"`);
      if (maxPages && pages > maxPages) {
        console.error(`⚠️  ${pages} pages, limit is ${maxPages} — trim the least relevant bullets and render again.`);
        process.exit(3);
      }
      if (overflow.length) process.exit(3);
    })
    .catch((err) => {
      console.error(`❌ PDF generation failed: ${err.message}`);
      process.exit(1);
    });
}
