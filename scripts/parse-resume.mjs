#!/usr/bin/env node
// jobpilot parse-resume — extract plain text from a resume file.
//
//   node parse-resume.mjs <resume.pdf|docx|txt|md>
//
// Prints the extracted text to stdout (and a stat line to stderr). The LLM
// side of `setup` structures this into profile.md — this script never
// interprets content.

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { isMainModule } from './lib/main.mjs';

export async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    // Import the library entry directly: importing the package root from ESM
    // makes `module.parent` falsy and triggers pdf-parse's debug self-test,
    // which parses a demo file and pollutes stdout.
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const buffer = await readFile(filePath);
    const { text } = await pdfParse(buffer);
    return text;
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value;
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return readFile(filePath, 'utf8');
  }
  throw new Error(`unsupported resume format "${ext}" — use PDF, DOCX, TXT or MD`);
}

if (isMainModule(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node parse-resume.mjs <resume.pdf|docx|txt|md>');
    process.exit(1);
  }
  extractText(file)
    .then((text) => {
      console.error(`✅ extracted ${text.length} characters from ${file}`);
      process.stdout.write(text);
    })
    .catch((err) => {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    });
}
