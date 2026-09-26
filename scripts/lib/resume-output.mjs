// Where a tailored resume goes and how it's printed: paper size, page
// limit, and the file name a recruiter sees. All read from profile.md,
// with sensible inference when a field is missing.

import { join } from 'node:path';

// US and Canada print on Letter; nearly everywhere else uses A4.
const NA_PLACES = /\b(?:united states|usa|u\.s\.|canada|new york|nyc|san francisco|bay area|seattle|los angeles|boston|chicago|austin|denver|atlanta|miami|washington|toronto|vancouver|montreal)\b/i;
// "Austin, TX" — case-sensitive. DE and IN are left out: "Berlin, DE" and
// "Bengaluru, IN" are Germany and India far more often than Delaware and Indiana.
const NA_REGION_CODE = /\b[A-Z][a-z]+, (?:A[KLRZ]|C[AOT]|DC|FL|GA|HI|I[ADL]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|ON|BC|QC|AB)\b/;

export function paperFor(profile = {}) {
  if (profile.paper === 'letter' || profile.paper === 'a4') return profile.paper;
  const places = [...(profile.locations?.cities || []), profile.locations?.country || ''].join(' ; ');
  if (NA_PLACES.test(places) || NA_REGION_CODE.test(places)) return 'letter';
  const currency = String(profile.comp?.currency || '').toUpperCase();
  if (currency === 'USD' || currency === 'CAD') return 'letter';
  if (currency) return 'a4';
  return 'letter'; // nothing to go on
}

/** 1 page under 10 years of experience, 2 from 10 years (or when unknown). */
export function maxPagesFor(profile = {}) {
  if (Number(profile.max_pages) > 0) return Number(profile.max_pages);
  const years = Number(profile.years_experience);
  return Number.isFinite(years) && years < 10 ? 1 : 2;
}

/** "Jordan Rivera" → "Jordan-Rivera-Resume.pdf". No company in the name:
 * the file gets forwarded, and "resume-figma.pdf" reads oddly elsewhere. */
export function resumeFileName(profile = {}) {
  const name = String(profile.name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 -]+/g, ' ').trim().split(/\s+/).filter(Boolean).join('-');
  return name ? `${name}-Resume.pdf` : 'Resume.pdf';
}

export function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
}

/** One folder per job, so tailored resumes for different jobs never collide. */
export function tailoredPaths(root, job, profile = {}) {
  const dir = join(root, 'out', `${job.id}-${slugify(job.company)}`);
  return {
    dir,
    html: join(dir, 'resume.html'),
    pdf: join(dir, resumeFileName(profile)),
    previewDir: join(dir, 'preview'),
    notes: join(dir, 'review.md'),
    paper: paperFor(profile),
    maxPages: maxPagesFor(profile),
  };
}
