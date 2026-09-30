// The look of a tailored resume. Setup measures the user's own resume
// (extract-style.mjs) and stores the result as `resume_style` in profile.md;
// this turns it into the CSS the renderer injects, so a tailored resume looks
// like the one the user already has. The HTML template holds structure only.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fonts');
const WEIGHTS = [300, 400, 700];

// Used when the profile has no resume_style (or a field of it is unusable).
export const DEFAULT_STYLE = {
  font: 'Helvetica Neue',
  family: 'sans',
  weight: 400,
  sizes: { body: 10.5, name: 20, heading: 11, role: 10.5, contact: 9.5 },
  ink: '#1a1a1a',
  rule: '#1a4d7a',
  divider: '#dddddd',
  header: 'left',
  contact: ['email', 'phone', 'location', 'linkedin', 'github', 'website'],
  icons: false,
  sections: ['summary', 'experience', 'skills', 'education'],
  bullet: '•',
  margin: 0.6,
};

const FALLBACK = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
};
const CONTACT_KEYS = ['email', 'phone', 'location', 'linkedin', 'github', 'website'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : fallback);
const color = (v, fallback) => (HEX.test(String(v)) ? String(v).toLowerCase() : fallback);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Anything usable from `raw`, the rest from DEFAULT_STYLE. Never throws. */
export function normalizeStyle(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_STYLE;
  const sizes = r.sizes && typeof r.sizes === 'object' ? r.sizes : {};
  const sections = Array.isArray(r.sections) ? [...new Set(r.sections.map(slug).filter(Boolean))] : [];
  const contact = Array.isArray(r.contact) ? r.contact.map((c) => String(c).toLowerCase()).filter((c) => CONTACT_KEYS.includes(c)) : [];
  return {
    font: typeof r.font === 'string' && r.font.trim() ? r.font.trim().replace(/["'<>{};\\]/g, '') : d.font,
    family: r.family === 'serif' || r.family === 'sans' ? r.family : d.family,
    weight: WEIGHTS.includes(Number(r.weight)) ? Number(r.weight) : d.weight,
    sizes: Object.fromEntries(Object.keys(d.sizes).map((k) => [k, num(sizes[k], 5, 40, d.sizes[k])])),
    ink: color(r.ink, d.ink),
    rule: color(r.rule, d.rule),
    divider: color(r.divider, d.divider),
    header: r.header === 'center' || r.header === 'left' ? r.header : d.header,
    contact: contact.length ? [...new Set(contact)] : d.contact,
    icons: typeof r.icons === 'boolean' ? r.icons : d.icons,
    sections: sections.length ? sections : d.sections,
    bullet: typeof r.bullet === 'string' && [...r.bullet].length === 1 ? r.bullet : d.bullet,
    margin: num(r.margin, 0.3, 1.2, d.margin),
  };
}

/** Bundled files for a font: { 300: path, 400: path, 700: path } — only the weights present. */
export function bundledFont(name, dir = FONTS_DIR) {
  const files = {};
  for (const w of WEIGHTS) {
    const p = join(dir, `${slug(name)}-${w}.woff2`);
    if (existsSync(p)) files[w] = p;
  }
  return Object.keys(files).length ? files : null;
}

// 16px Feather-style glyphs, drawn in the ink color; text stays real text.
const ICON_PATHS = {
  email: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M12 18h.01"/>',
  linkedin: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.4 6.4-1.5 6.4-7A5.4 5.4 0 0 0 20 4.8 5 5 0 0 0 19.9 1S18.7.7 16 2.5a13.4 13.4 0 0 0-7 0C6.3.7 5.1 1 5.1 1A5 5 0 0 0 5 4.8a5.4 5.4 0 0 0-1.5 3.8c0 5.4 3.3 6.5 6.4 7a3.4 3.4 0 0 0-.9 2.6V22"/>',
  website: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  location: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
};

function iconUri(key, ink) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</svg>`;
  return `url("data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}")`;
}

function fontFaces(style, fontsDir) {
  const files = bundledFont(style.font, fontsDir);
  if (!files) return '';
  return Object.entries(files).map(([w, p]) =>
    `@font-face { font-family: "${style.font}"; font-weight: ${w}; font-style: normal; src: url(data:font/woff2;base64,${readFileSync(p).toString('base64')}) format("woff2"); }`).join('\n');
}

/** The full stylesheet for a resume in `style`, page size and margin included. */
export function styleCss(rawStyle, { format = 'a4', fontsDir = FONTS_DIR } = {}) {
  const s = normalizeStyle(rawStyle);
  const { sizes } = s;
  const stack = `"${s.font}", ${FALLBACK[s.family]}`;
  const order = s.sections.map((name, i) => `.s-${name} { order: ${i + 1}; }`).join('\n');
  const icons = s.icons
    ? s.contact.map((k) => `.c-${k}::before { content: ""; display: inline-block; width: 1.05em; height: 1.05em; margin-right: 0.35em; vertical-align: -0.16em; background: ${iconUri(k, s.ink)} center / contain no-repeat; }`).join('\n')
    : '';
  return `${fontFaces(s, fontsDir)}
@page { size: ${format === 'letter' ? 'Letter' : 'A4'}; margin: ${s.margin}in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ${stack}; font-weight: ${s.weight}; color: ${s.ink}; font-size: ${sizes.body}pt; line-height: 1.42; }
b, strong { font-weight: 700; }
.page { display: flex; flex-direction: column; }
header { text-align: ${s.header}; margin-bottom: 12px; }
h1 { font-size: ${sizes.name}pt; font-weight: 700; margin: 0 0 4px; line-height: 1.2; }
.contact { font-size: ${sizes.contact}pt; }
.contact span { display: inline-block; margin: 0 ${s.header === 'center' ? 5 : 10}px 0 ${s.header === 'center' ? 5 : 0}px; }
section { padding: 10px 0 8px; border-top: 1px solid ${s.divider}; }
h2 { font-size: ${sizes.heading}pt; font-weight: 700; text-transform: uppercase; margin: 0 0 6px; padding-bottom: 1px; border-bottom: 1.5px solid ${s.rule}; break-after: avoid; }
p { margin: 0; }
.role { margin-bottom: 9px; }
.role-title { font-size: ${sizes.role}pt; font-weight: 700; }
.role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-weight: 700; margin-bottom: 1px; }
.role-meta { text-align: right; white-space: nowrap; }
ul { list-style: none; margin: 2px 0 0; padding: 0; }
li { position: relative; padding-left: 7px; margin-bottom: 1.5px; }
li::before { content: "${s.bullet}"; position: absolute; left: 0; font-weight: 700; }
.skills p { margin: 0 0 5px; }
.edu { margin-bottom: 4px; }
.role-title, .role-head { break-after: avoid; }
li, header, .edu { break-inside: avoid; }
${order}
.s-${s.sections[0]} { border-top: 0; padding-top: 0; }
${icons}`;
}
