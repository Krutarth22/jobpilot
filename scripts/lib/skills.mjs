// Canonical skill vocabulary + extractor.
// Ported from career-ops skill-extract.mjs (MIT) — trimmed to the vocabulary
// and the two extractors; comments preserved where they encode a deliberate
// trade-off. Pure + dependency-free.

export const SKILL_TOKENS = [
  // Languages
  'JavaScript', 'TypeScript', 'Python', 'Ruby', 'Java', 'Golang', 'Rust', 'PHP',
  'Kotlin', 'Swift', 'Scala', 'Elixir', 'C\\+\\+', 'C#', '\\.NET', 'SQL',
  // Frontend / frameworks
  'React Native', 'React', 'Angular', 'Vue\\.?js', 'Svelte', 'Next\\.?js',
  'Django', 'Flask', 'FastAPI', 'Rails', 'Laravel', 'Symfony', 'Spring',
  'Node\\.?js', 'NodeJS',
  // Data stores
  'MongoDB', 'MySQL', 'PostgreSQL', 'Postgres', 'Redis', 'Elasticsearch',
  'Snowflake', 'BigQuery', 'Databricks', 'DynamoDB', 'Cassandra',
  // APIs / messaging
  'GraphQL', 'gRPC', 'Kafka', 'RabbitMQ',
  // Cloud / infra
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'k8s', 'Terraform',
  'Ansible', 'Helm', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'CI/CD',
  'Prometheus', 'Grafana', 'Datadog', 'Supabase',
  // Data / ML / AI
  'PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy', 'Spark',
  'Airflow', 'dbt', 'MLOps', 'MLflow', 'LangChain', 'LlamaIndex',
  'Hugging Face', 'RAG', 'LLMs?', 'Prompt Engineering', 'Fine-?tuning',
  'Computer Vision', 'NLP',
  // Analytics / enterprise
  'Tableau', 'Power BI', 'Looker', 'Salesforce', 'SAP',
  // Certifications / methodologies. Longest-first within each family so
  // alternation prefers the specific form ('Lean Six Sigma' before
  // 'Six Sigma'). Both spellings of every fused credential — a certification
  // the user holds and writes the ordinary way must not come back as a gap.
  'PMI-ACP', 'PMI ACP', 'PgMP', 'CAPM', 'PMBOK', 'PMP',
  'PRINCE2', 'PRINCE 2',
  'Certified Scrum Product Owner', 'Certified ScrumMaster', 'Certified Scrum Master', 'CSPO',
  'ITIL', 'COBIT', 'TOGAF',
  'Lean Six Sigma', 'Lean Six-Sigma', 'Six Sigma', 'Six-Sigma',
  'CISSP', 'CISM', 'CIPP',
  // DELIBERATELY OMITTED: 'CSM' — in job prose it far more often means
  // Customer Success Manager than Certified ScrumMaster. 'SAFe' is handled
  // case-sensitively below ('safe' is an everyday English word), as is 'Go'.
];

const SAFE_CERT_PATTERN = /(?<!\w)SAFe(?!\w)/;
const GO_SKILL_PATTERN = /(?<!\w)Go(?![\w-])/;

// \b fails at symbol edges (\bC\+\+\b needs a word char AFTER the +), so
// lookarounds instead.
export const SKILL_PATTERN = new RegExp('(?<!\\w)(?:' + SKILL_TOKENS.join('|') + ')(?!\\w)', 'gi');

export const DISPLAY = Object.fromEntries(
  SKILL_TOKENS.map((t) => {
    const display = t.replace(/\\/g, '').replace(/\?/g, '');
    return [display.toLowerCase(), display];
  })
);

// Exact-alias canonicalization ONLY (lowercased match → display name).
// Deliberately no umbrella aliases: "cloud" must never count as knowing
// AWS/GCP/Azure — a generous map silently suppresses real gaps.
export const CANONICAL = {
  'k8s': 'Kubernetes',
  'golang': 'Go',
  'postgres': 'PostgreSQL',
  'nodejs': 'Node.js', 'node.js': 'Node.js',
  'vuejs': 'Vue.js', 'vue.js': 'Vue.js',
  'nextjs': 'Next.js', 'next.js': 'Next.js',
  'llm': 'LLMs', 'llms': 'LLMs',
  'finetuning': 'Fine-tuning', 'fine-tuning': 'Fine-tuning',
  'power bi': 'Power BI',
  'github actions': 'GitHub Actions',
  'gitlab ci': 'GitLab CI',
  'ci/cd': 'CI/CD',
  'hugging face': 'Hugging Face',
  'react native': 'React Native',
  'prompt engineering': 'Prompt Engineering',
  'computer vision': 'Computer Vision',
  'scikit-learn': 'scikit-learn',
  'c++': 'C++', 'c#': 'C#', '.net': '.NET',
  'nlp': 'NLP', 'rag': 'RAG', 'sql': 'SQL', 'aws': 'AWS', 'gcp': 'GCP',
  'grpc': 'gRPC', 'dbt': 'dbt', 'mlops': 'MLOps', 'mlflow': 'MLflow',
  'pmp': 'PMP', 'pmi-acp': 'PMI-ACP', 'pgmp': 'PgMP', 'capm': 'CAPM',
  'pmbok': 'PMBOK', 'prince2': 'PRINCE2', 'cspo': 'CSPO',
  'certified scrummaster': 'Certified ScrumMaster',
  'certified scrum master': 'Certified ScrumMaster',
  'certified scrum product owner': 'CSPO',
  'pmi acp': 'PMI-ACP',
  'prince 2': 'PRINCE2',
  'itil': 'ITIL', 'cobit': 'COBIT', 'togaf': 'TOGAF',
  'lean six sigma': 'Lean Six Sigma', 'lean six-sigma': 'Lean Six Sigma',
  'six sigma': 'Six Sigma', 'six-sigma': 'Six Sigma',
  'cissp': 'CISSP', 'cism': 'CISM', 'cipp': 'CIPP',
  // NOTE: no 'safe' key, deliberately — canonicalize() lowercases its input,
  // so a 'safe' key would re-open the everyday-word hole.
};

/** Canonical form of a single raw token; unknown tokens pass through unchanged. */
export function canonicalize(token) {
  const key = String(token || '').toLowerCase();
  return CANONICAL[key] || DISPLAY[key] || token;
}

/** Extract the set of canonical skill names present in a free-text blob. */
export function extractSkills(text) {
  if (!text) return new Set();
  const found = new Set();
  for (const m of text.matchAll(SKILL_PATTERN)) found.add(canonicalize(m[0]));
  if (GO_SKILL_PATTERN.test(text)) found.add('Go');
  if (SAFE_CERT_PATTERN.test(text)) found.add('SAFe');
  return found;
}

/** The canonical skill set a profile knows: frontmatter.skills (canonicalized)
 * plus anything the prose mentions. */
export function profileSkillSet(profile, profileBody = '') {
  const known = new Set();
  for (const s of profile.skills || []) known.add(canonicalize(s));
  for (const s of extractSkills(profileBody)) known.add(s);
  return known;
}

// ── Practice terms: leadership, product and domain vocabulary ─────────────
// SKILL_TOKENS is tools and credentials, so a manager or product JD ("hire
// and grow the team, own the roadmap, partner cross-functionally") yields
// almost nothing and the keyword cross-check had nothing to compare.
// These terms feed ONLY the keyword pre-score and review's keyword coverage
// — never the fact gate: a tailored "mentoring" against a profile's
// "mentored" is not a fabricated skill. Each pattern folds the inflections
// ("mentor", "mentored", "mentorship") into one canonical name.
export const PRACTICE_TERMS = [
  ['People management', /\bpeople manage(?:ment|r)\b|\bmanag(?:e|ed|es|ing) (?:a |the )?(?:team|engineers)\b|\bdirect reports?\b/i],
  // Hiring as a duty, not company boilerplate ("we believe in hiring smart,
  // curious people" is in nearly every careers page).
  ['Hiring', /\b(?:hire|hiring|recruit(?:ing)?),? (?:and )?(?:grow|develop|retain|mentor|build)|\blead(?:ing)? and grow(?:ing)?\b|\b(?:build|built|grow|grew|scale|scaled)(?:s|ing)? (?:and (?:grow|lead|scale|develop)(?:s|ing)? )?(?:a |an |the |your )?(?:high[- ]performing |world[- ]class |strong )?(?:engineering |product )?(?:team|org|organization)s?\b|\bhired\b|\bhiring (?:plans?|pipeline|bar)\b|\bteam building\b/i],
  ['Mentoring', /\b(?:mentor(?:ed|ing|ship|s)?|coach(?:ed|es|ing)?)\b/i],
  ['Career development', /\bcareer (?:growth|development|progression)\b|\bperformance (?:management|reviews?)\b/i],
  ['Roadmapping', /\broadmap(?:s|ping)?\b/i],
  ['Technical strategy', /\b(?:technical|engineering|product|platform) (?:strategy|vision)\b/i],
  ['Stakeholder management', /\bstakeholders?\b/i],
  ['Cross-functional', /\bcross[- ]functional(?:ly)?\b|\bpartner(?:ed|ing|s)? (?:closely )?(?:with|across)\b/i],
  ['OKRs', /\bOKRs?\b/],
  ['Agile', /\bagile\b|\bscrum\b/i],
  ['Incident management', /\bincident(?:s| response| management)\b|\bon[- ]call\b|\bpostmortems?\b/i],
  ['Reliability', /\breliability\b|\bSLOs?\b|\bSLAs?\b|\bSRE\b/],
  ['Distributed systems', /\bdistributed systems?\b/i],
  ['Microservices', /\bmicro-?services?\b/i],
  ['System design', /\bsystems? design\b|\b(?:software|system|platform) architecture\b/i],
  ['Observability', /\bobservability\b|\bmonitoring\b|\bdistributed tracing\b|\btelemetry\b/i],
  ['Experimentation', /\bA\/B test(?:s|ing)?\b|\bexperimentation\b/i],
  ['Machine learning', /\bmachine learning\b|\bML\b/],
  ['Deep learning', /\bdeep learning\b|\bneural networks?\b/i],
  ['Recommender systems', /\brecommend(?:er|ation)s? (?:systems?|engines?|models?)\b|\bpersonali[sz]ation\b/i],
  ['Search and ranking', /\bsearch (?:and|&) (?:ranking|discovery|relevance)\b|\bsearch relevance\b|\branking models?\b|\blearning to rank\b/i],
  ['Model evaluation', /\bevals\b|\b(?:model|llm|ai) evaluations?\b/i],
  ['Anomaly detection', /\banomaly detection\b/i],
  ['Data pipelines', /\bdata pipelines?\b|\bETL\b/],
  ['Data platform', /\bdata (?:platform|infrastructure)\b/i],
  ['Payments', /\bpayments?\b|\bbilling\b/i],
  ['Marketplace', /\bmarketplaces?\b/i],
  ['Advertising', /\badvertising\b|\bad[- ]tech\b/i],
  ['Developer experience', /\bdeveloper (?:experience|productivity|tools|platform)\b|\bDevEx\b/i],
];

const TERM_STOPWORDS = new Set(['and', 'the', 'for', 'with', 'team', 'work', 'data', 'code', 'tools']);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Everything the keyword cross-check can recognize in a text: hard skills,
 * practice terms, and the user's own listed skills (so an unusual skill the
 * vocabulary doesn't know is still found in the JD). Profile terms shorter
 * than 3 characters or generic words are skipped — "go" or "data" would
 * match everywhere. Returns display names; compare case-insensitively.
 */
export function extractTerms(text, extraTerms = []) {
  const found = new Map([...extractSkills(text)].map((s) => [s.toLowerCase(), s])); // key → display
  if (!text) return new Set();
  for (const [name, pattern] of PRACTICE_TERMS) {
    if (pattern.test(text)) found.set(name.toLowerCase(), name);
  }
  for (const raw of extraTerms) {
    const term = String(raw || '').trim();
    const display = canonicalize(term);
    const key = display.toLowerCase();
    if (term.length < 3 || TERM_STOPWORDS.has(term.toLowerCase()) || found.has(key)) continue;
    if (new RegExp(`(?<!\\w)${escapeRegex(term)}(?!\\w)`, 'i').test(text)) found.set(key, display);
  }
  return new Set(found.values());
}
