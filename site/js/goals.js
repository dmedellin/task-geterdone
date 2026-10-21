// Pure goal and result logic. No DOM, no network: unit-tested under node.

export const GOAL_TYPES = {
  none: { label: 'No goal' },
  count: { label: 'Repetitions', unit: 'reps', step: 1 },
  time: { label: 'Time', unit: 'min', step: 5 },
  quantity: { label: 'Quantity', unit: '', step: 1 },
};

export function emptyMeta() {
  return { project: '', goalType: 'none', target: 0, unit: '', progress: 0, results: 0 };
}

// Coerce whatever came back from storage into a well-formed meta object.
export function normalizeMeta(raw) {
  const m = emptyMeta();
  if (!raw || typeof raw !== 'object') return m;
  if (typeof raw.project === 'string') m.project = raw.project.trim().slice(0, 80);
  if (raw.goalType in GOAL_TYPES) m.goalType = raw.goalType;
  m.target = clampNumber(raw.target);
  if (typeof raw.unit === 'string') m.unit = raw.unit.trim().slice(0, 24);
  m.progress = clampNumber(raw.progress);
  m.results = Math.max(0, Math.floor(clampNumber(raw.results)));
  return m;
}

function clampNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 0;
}

export function unitFor(meta) {
  if (meta.goalType === 'quantity') return meta.unit || 'units';
  return (GOAL_TYPES[meta.goalType] || {}).unit || '';
}

export function hasGoal(meta) {
  return meta.goalType !== 'none' && meta.target > 0;
}

export function percent(meta) {
  if (!hasGoal(meta)) return 0;
  return Math.max(0, Math.min(100, Math.round((meta.progress / meta.target) * 100)));
}

export function formatAmount(amount, meta) {
  const n = Math.round(Number(amount) * 100) / 100;
  if (meta.goalType === 'time') {
    if (n >= 60) {
      const h = Math.floor(n / 60), m = Math.round(n % 60);
      return m ? `${h}h ${m}m` : `${h}h`;
    }
    return `${n} min`;
  }
  const unit = unitFor(meta);
  return unit ? `${n} ${unit}` : String(n);
}

export function progressLabel(meta) {
  if (!hasGoal(meta)) return '';
  return `${formatAmount(meta.progress, meta)} of ${formatAmount(meta.target, meta)}`;
}

// A result log entry: one session's output toward the goal.
export function makeResult({ amount, note = '', evidence = null, source = 'manual', at = new Date() }) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error('Amount must be a positive number.');
  return {
    id: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    at: new Date(at).toISOString(),
    amount: Math.round(n * 1000) / 1000,
    note: String(note).slice(0, 2000),
    evidence: normalizeEvidence(evidence),
    source,
  };
}

export function normalizeEvidence(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.kind === 'link') {
    const url = safeUrl(e.url);
    return url ? { kind: 'link', url, name: String(e.name || url).slice(0, 200) } : null;
  }
  if (e.kind === 'attachment' && e.attachmentId) {
    return { kind: 'attachment', attachmentId: String(e.attachmentId), name: String(e.name || 'file').slice(0, 200) };
  }
  if (e.kind === 'file') {
    const url = safeUrl(e.url);
    return url ? { kind: 'file', url, name: String(e.name || 'file').slice(0, 200) } : null;
  }
  return null;
}

// Only http(s) links are ever rendered as hrefs.
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

export function totalOf(results) {
  return Math.round(results.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 1000) / 1000;
}

// Recompute the cached totals on meta from the full results log.
export function withResults(meta, results) {
  return { ...meta, progress: totalOf(results), results: results.length };
}

export function sortResults(results) {
  return [...results].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
