import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../scripts/parse-resume.mjs';
import { htmlToText } from '../scripts/jobs.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Minimal fixture builders ────────────────────────────────────────────

/** Build a minimal DOCX (stored-entry zip) with one paragraph. */
function buildDocx(paragraphText) {
  const esc = paragraphText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${esc}</w:t></w:r></w:p></w:body></w:document>`;
  const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

  const table = [];
  const files = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/document.xml', documentXml],
  ];
  let offset = 0;
  const entries = [];
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (any valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    entries.push({ nameBuf, crc, size: data.length, compSize: compressed.length, offset });
    table.push(Buffer.concat([local, nameBuf, compressed]));
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralParts = [];
  for (const e of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compSize, 20);
    central.writeUInt32LE(e.size, 24);
    central.writeUInt16LE(e.nameBuf.length, 28);
    central.writeUInt32LE(e.offset, 42);
    centralParts.push(Buffer.concat([central, e.nameBuf]));
  }
  const centralSize = centralParts.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...table, ...centralParts, eocd]);
}

// ── Tests ───────────────────────────────────────────────────────────────

test('parse-resume: real PDF fixture extracts text', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-resume.pdf');
  const text = await extractText(fixture);
  assert.match(text, /Krutarth Majithia/);
  assert.match(text, /Kubernetes/);
});

test('parse-resume: DOCX fixture extracts text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobpilot-'));
  try {
    const docxPath = join(dir, 'resume.docx');
    await writeFile(docxPath, buildDocx('Backend engineer with 8 years of experience'));
    const text = await extractText(docxPath);
    assert.match(text, /Backend engineer with 8 years of experience/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse-resume: unsupported extension is a clean error', async () => {
  await assert.rejects(() => extractText('resume.pages'), /unsupported resume format/);
});

test('jobs.mjs htmlToText: strips tags, decodes entities, keeps line structure', () => {
  const html = '<p>Hello &amp; welcome</p><ul><li>Go</li><li>K8s</li></ul><script>alert(1)</script>';
  const text = htmlToText(html);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /• Go\n• K8s/);
  assert.doesNotMatch(text, /alert|<p>/);
});

test('jobs.mjs htmlToText: greenhouse double-encoded content decodes then strips', () => {
  const text = htmlToText('&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;Build the platform&lt;/p&gt;&lt;/div&gt;');
  assert.equal(text, 'Build the platform');
});
