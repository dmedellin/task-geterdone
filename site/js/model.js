// Mapping between Microsoft To Do (Graph) shapes and the app's task shape.
// Pure: unit-tested under node.
import { EXT_NAME } from './config.js';
import { normalizeMeta } from './goals.js';

export const RECURRENCE_TYPES = ['daily', 'weekly', 'monthly', 'yearly'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Graph returns dueDateTime as a wall-clock time in a time zone. To Do stores
// due dates at midnight, so the date part is the due date; anything else is a
// UTC instant that is converted to the local date.
export function dueFromGraph(dt) {
  if (!dt || !dt.dateTime) return null;
  const [date, time = ''] = dt.dateTime.split('T');
  if (/^00:00(:00)?/.test(time) || !/^utc$/i.test(dt.timeZone || '')) return date;
  const d = new Date(dt.dateTime.replace(/(\.\d{3})\d*$/, '$1') + 'Z');
  return Number.isNaN(d.getTime()) ? date : todayISO(d);
}

export function dueToGraph(date) {
  return date ? { dateTime: `${date}T00:00:00`, timeZone: 'UTC' } : null;
}

export function recurrenceFromGraph(r) {
  if (!r || !r.pattern) return null;
  const t = r.pattern.type;
  const type = t === 'daily' ? 'daily' : t === 'weekly' ? 'weekly'
    : /monthly/i.test(t) ? 'monthly' : /yearly/i.test(t) ? 'yearly' : null;
  return type ? { type, interval: Math.max(1, Number(r.pattern.interval) || 1) } : null;
}

export function recurrenceToGraph(rec, due) {
  if (!rec || !rec.type) return null;
  const d = new Date(due + 'T12:00:00');
  const interval = Math.max(1, Math.min(99, Number(rec.interval) || 1));
  const pattern = { type: rec.type, interval };
  if (rec.type === 'weekly') { pattern.daysOfWeek = [DAYS[d.getDay()]]; pattern.firstDayOfWeek = 'sunday'; }
  if (rec.type === 'monthly') { pattern.type = 'absoluteMonthly'; pattern.dayOfMonth = d.getDate(); }
  if (rec.type === 'yearly') { pattern.type = 'absoluteYearly'; pattern.dayOfMonth = d.getDate(); pattern.month = d.getMonth() + 1; }
  return { pattern, range: { type: 'noEnd', startDate: due } };
}

export function findExtension(extensions) {
  return (extensions || []).find((e) => e && (e.extensionName === EXT_NAME || String(e.id || '').endsWith(EXT_NAME))) || null;
}

export function taskFromGraph(t, listId) {
  const ext = findExtension(t.extensions);
  const body = t.body && t.body.content ? t.body.content : '';
  return {
    id: t.id,
    listId,
    title: t.title || '',
    description: t.body && t.body.contentType === 'html' ? htmlToText(body) : body,
    status: t.status === 'completed' ? 'completed' : 'notStarted',
    importance: t.importance || 'normal',
    due: dueFromGraph(t.dueDateTime),
    recurrence: recurrenceFromGraph(t.recurrence),
    created: t.createdDateTime || '',
    completedAt: t.completedDateTime ? t.completedDateTime.dateTime : '',
    hasAttachments: !!t.hasAttachments,
    meta: normalizeMeta(ext),
    metaExists: !!ext,
  };
}

// Only the fields the app edits. `fields` is a partial app task.
export function patchToGraph(fields, current = {}) {
  const p = {};
  if ('title' in fields) p.title = String(fields.title).slice(0, 255);
  if ('description' in fields) p.body = { content: String(fields.description), contentType: 'text' };
  if ('status' in fields) p.status = fields.status === 'completed' ? 'completed' : 'notStarted';
  if ('importance' in fields) p.importance = fields.importance === 'high' ? 'high' : 'normal';
  const due = 'due' in fields ? fields.due : current.due;
  const rec = 'recurrence' in fields ? fields.recurrence : current.recurrence;
  if ('due' in fields) p.dueDateTime = dueToGraph(fields.due);
  if ('recurrence' in fields || ('due' in fields && rec)) {
    p.recurrence = due ? recurrenceToGraph(rec, due) : null;
  }
  return p;
}

export function metaToExtension(meta) {
  return {
    '@odata.type': 'microsoft.graph.openTypeExtension',
    extensionName: EXT_NAME,
    v: 1,
    project: meta.project,
    goalType: meta.goalType,
    target: meta.target,
    unit: meta.unit,
    progress: meta.progress,
    results: meta.results,
  };
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
