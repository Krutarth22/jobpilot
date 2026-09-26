#!/usr/bin/env node
// jobpilot render-resume — HTML → PDF via headless Chromium (Playwright).
// Reduced from career-ops generate-pdf.mjs (MIT) to the ~50 lines a tailored
// resume needs: ATS-safe text normalization + a clean print render.
//
//   node render-resume.mjs <input.html> <output.pdf> [--format=a4|letter] [--max-pages=N]

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './lib/main.mjs';

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

function injectPrintPageCss(html, format) {
  const pageStyle = `<style>@page { size: ${format === 'letter' ? 'Letter' : 'A4'}; margin: 0.6in; }</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${pageStyle}\n</head>`);
  return `${pageStyle}\n${html}`;
}

export async function renderHtmlToPdf(html, outputPath, { format = 'a4' } = {}) {
  const { chromium } = await import('playwright');
  const tmpHtmlPath = resolve(dirname(outputPath), `.jobpilot-render-${randomUUID()}.html`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(tmpHtmlPath, injectPrintPageCss(normalizeTextForATS(html), format), 'utf8');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    // The resume is static, untrusted-input-derived markup: no scripts, no network.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      return url.startsWith('file:') || url.startsWith('data:') ? route.continue() : route.abort();
    });
    await page.goto(pathToFileURL(tmpHtmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    await writeFile(outputPath, buffer);
    return { outputPath, size: buffer.length };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await unlink(tmpHtmlPath).catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const format = args.find((a) => a.startsWith('--format='))?.slice(9) || 'a4';
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath || !['a4', 'letter'].includes(format)) {
    console.error('Usage: node render-resume.mjs <input.html> <output.pdf> [--format=a4|letter]');
    process.exit(1);
  }
  readFile(resolve(inputPath), 'utf8')
    .then((html) => renderHtmlToPdf(html, resolve(outputPath), { format }))
    .then(({ outputPath: out, size }) => {
      console.log(`✅ PDF generated: ${out} (${(size / 1024).toFixed(1)} KB)`);
    })
    .catch((err) => {
      console.error(`❌ PDF generation failed: ${err.message}`);
      process.exit(1);
    });
}
