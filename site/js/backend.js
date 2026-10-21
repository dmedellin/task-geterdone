// Storage backends. GraphBackend talks to the signed-in user's own Microsoft
// account (To Do + OneDrive app folder); LocalBackend keeps a demo copy in
// this browser only. Both expose the same methods.
import { GRAPH, EXT_NAME, APP_DIR } from './config.js';
import { accessToken } from './auth.js';
import { taskFromGraph, patchToGraph, metaToExtension, todayISO } from './model.js';
import { normalizeMeta, emptyMeta } from './goals.js';

export const SMALL_ATTACHMENT = 3 * 1024 * 1024;   // single POST limit for To Do attachments
export const MAX_ATTACHMENT = 25 * 1024 * 1024;    // To Do attachment cap

export class GraphError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(path, { method = 'GET', body, headers = {}, raw = false } = {}, attempt = 0) {
  const token = await accessToken();
  const h = { Authorization: 'Bearer ' + token, ...headers };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const url = path.startsWith('https://') ? path : GRAPH + path;
  const r = await fetch(url, { method, headers: h, body: payload });
  if ((r.status === 429 || r.status === 503 || r.status === 504) && attempt < 4) {
    const wait = Math.min(30, Number(r.headers.get('Retry-After')) || 2 ** attempt) * 1000;
    await sleep(wait);
    return graph(path, { method, body, headers, raw }, attempt + 1);
  }
  if (!r.ok) {
    let msg = 'Microsoft Graph returned ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* not json */ }
    throw new GraphError(r.status, msg);
  }
  if (raw) return r;
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function graphAll(path) {
  const out = [];
  let next = path;
  while (next) {
    const page = await graph(next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return out;
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

// Chunked PUT to a pre-authenticated upload URL (no Authorization header).
async function uploadChunks(uploadUrl, file, chunkSize, onProgress) {
  let last = null;
  for (let start = 0; start < file.size; start += chunkSize) {
    const end = Math.min(file.size, start + chunkSize);
    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` },
      body: file.slice(start, end),
    });
    if (!r.ok && r.status !== 202) throw new GraphError(r.status, 'Upload failed with status ' + r.status);
    last = r;
    if (onProgress) onProgress(end / file.size);
  }
  const text = last ? await last.text() : '';
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const taskPath = (listId, taskId) => `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
const appPath = (rel) => `/me/drive/special/approot:/${APP_DIR}/${rel}`;

export class GraphBackend {
  get kind() { return 'graph'; }

  async me() {
    return graph('/me?$select=displayName,userPrincipalName,mail');
  }

  async lists() {
    const v = await graphAll('/me/todo/lists');
    return v.map((l) => ({ id: l.id, name: l.displayName, wellknown: l.wellknownListName || 'none' }));
  }

  async createList(name) {
    const l = await graph('/me/todo/lists', { method: 'POST', body: { displayName: name } });
    return { id: l.id, name: l.displayName, wellknown: 'none' };
  }

  async tasks(listId) {
    const v = await graphAll(`/me/todo/lists/${encodeURIComponent(listId)}/tasks?$top=100&$expand=extensions`);
    return v.map((t) => taskFromGraph(t, listId));
  }

  async createTask(listId, fields) {
    const body = patchToGraph(fields);
    const t = await graph(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`, { method: 'POST', body });
    const task = taskFromGraph(t, listId);
    if (fields.meta) return this.setMeta(task, fields.meta);
    return task;
  }

  async updateTask(task, fields) {
    const t = await graph(taskPath(task.listId, task.id), { method: 'PATCH', body: patchToGraph(fields, task) });
    const next = taskFromGraph(t, task.listId);
    return { ...next, meta: task.meta, metaExists: task.metaExists };
  }

  async deleteTask(task) {
    await graph(taskPath(task.listId, task.id), { method: 'DELETE' });
  }

  async setMeta(task, meta) {
    const m = normalizeMeta(meta);
    const body = metaToExtension(m);
    if (task.metaExists) {
      try {
        await graph(`${taskPath(task.listId, task.id)}/extensions/${EXT_NAME}`, { method: 'PATCH', body });
        return { ...task, meta: m, metaExists: true };
      } catch (e) {
        if (!(e instanceof GraphError) || e.status !== 404) throw e;
      }
    }
    await graph(`${taskPath(task.listId, task.id)}/extensions`, { method: 'POST', body });
    return { ...task, meta: m, metaExists: true };
  }

  // ---- result log: one JSON file per task in the OneDrive app folder ----
  async results(task) {
    const name = await sha256hex(task.id);
    try {
      const r = await graph(appPath(`results/${name}.json:/content`), { raw: true });
      const j = await r.json();
      return Array.isArray(j.results) ? j.results : [];
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return [];
      throw e;
    }
  }

  async saveResults(task, results) {
    const name = await sha256hex(task.id);
    const doc = { taskId: task.id, title: task.title, updated: new Date().toISOString(), results };
    await graph(appPath(`results/${name}.json:/content`), {
      method: 'PUT', body: JSON.stringify(doc, null, 1), headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---- projects: names and colours, shared across devices ----
  async projects() {
    try {
      const r = await graph(appPath('projects.json:/content'), { raw: true });
      const j = await r.json();
      return Array.isArray(j.projects) ? j.projects : [];
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return [];
      throw e;
    }
  }

  async saveProjects(projects) {
    await graph(appPath('projects.json:/content'), {
      method: 'PUT', body: JSON.stringify({ projects }, null, 1), headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---- native To Do attachments (25 MB cap) ----
  async attachments(task) {
    const v = await graph(`${taskPath(task.listId, task.id)}/attachments?$select=id,name,size,contentType,lastModifiedDateTime`);
    return (v.value || []).map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, modified: a.lastModifiedDateTime }));
  }

  async addAttachment(task, file, onProgress) {
    if (file.size > MAX_ATTACHMENT) throw new Error('To Do attachments are limited to 25 MB.');
    const base = `${taskPath(task.listId, task.id)}/attachments`;
    if (file.size < SMALL_ATTACHMENT) {
      const a = await graph(base, {
        method: 'POST',
        body: {
          '@odata.type': '#microsoft.graph.taskFileAttachment',
          name: file.name, contentType: file.type || 'application/octet-stream',
          contentBytes: await fileToBase64(file),
        },
      });
      if (onProgress) onProgress(1);
      return { id: a.id, name: a.name, size: a.size, contentType: a.contentType };
    }
    const session = await graph(`${base}/createUploadSession`, {
      method: 'POST', body: { attachmentInfo: { attachmentType: 'file', name: file.name, size: file.size } },
    });
    await uploadChunks(session.uploadUrl, file, 3 * 1024 * 1024, onProgress);
    const list = await this.attachments(task);
    return list.find((a) => a.name === file.name && a.size === file.size) || list[list.length - 1] || null;
  }

  async attachmentBlob(task, attachmentId) {
    const a = await graph(`${taskPath(task.listId, task.id)}/attachments/${encodeURIComponent(attachmentId)}`);
    return { name: a.name, blob: base64ToBlob(a.contentBytes || '', a.contentType) };
  }

  async deleteAttachment(task, attachmentId) {
    await graph(`${taskPath(task.listId, task.id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  }

  // ---- native To Do linked resources: links and large files kept in OneDrive ----
  async links(task) {
    const v = await graph(`${taskPath(task.listId, task.id)}/linkedResources`);
    return (v.value || []).filter((l) => l.webUrl).map((l) => ({ id: l.id, url: l.webUrl, name: l.displayName || l.webUrl }));
  }

  async addLink(task, { url, name }) {
    const l = await graph(`${taskPath(task.listId, task.id)}/linkedResources`, {
      method: 'POST', body: { webUrl: url, displayName: name || url, applicationName: 'task.geterdone.io' },
    });
    return { id: l.id, url: l.webUrl, name: l.displayName };
  }

  async deleteLink(task, id) {
    await graph(`${taskPath(task.listId, task.id)}/linkedResources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // Evidence larger than the To Do cap goes to the OneDrive app folder.
  async uploadLargeFile(file, onProgress) {
    const safe = file.name.replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 120) || 'file';
    const rel = `evidence/${todayISO()}-${safe}`;
    const session = await graph(appPath(`${rel}:/createUploadSession`), {
      method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
    });
    const item = await uploadChunks(session.uploadUrl, file, 10 * 320 * 1024, onProgress);
    if (!item || !item.webUrl) throw new Error('Upload finished but OneDrive returned no link.');
    return { name: item.name || safe, url: item.webUrl };
  }
}

// ---------------------------------------------------------------------------
// Demo backend: same interface, everything in this browser's localStorage.
// ---------------------------------------------------------------------------
const DEMO_KEY = 'tg-demo';

function demoSeed() {
  const today = todayISO();
  const inbox = 'demo-tasks', fit = 'demo-fitness';
  const t = (id, listId, title, extra = {}) => ({
    id, listId, title, description: '', status: 'notStarted', importance: 'normal', due: null,
    recurrence: null, created: new Date().toISOString(), completedAt: '', hasAttachments: false,
    meta: emptyMeta(), metaExists: false, ...extra,
  });
  return {
    lists: [{ id: inbox, name: 'Tasks', wellknown: 'defaultList' }, { id: fit, name: 'Fitness', wellknown: 'none' }],
    tasks: [
      t('d1', inbox, 'Write the quarterly plan', { due: today, meta: { ...emptyMeta(), project: 'Work', goalType: 'time', target: 120, progress: 50, results: 2 }, metaExists: true }),
      t('d2', fit, 'Push-ups', { recurrence: { type: 'daily', interval: 1 }, due: today, meta: { ...emptyMeta(), project: 'Health', goalType: 'count', target: 100, progress: 60, results: 3 }, metaExists: true }),
      t('d3', fit, 'Run', { meta: { ...emptyMeta(), project: 'Health', goalType: 'quantity', target: 40, unit: 'km', progress: 12.5, results: 2 }, metaExists: true }),
      t('d4', inbox, 'Renew passport'),
    ],
    results: {
      d1: [{ id: 'r1', at: new Date(Date.now() - 86400000).toISOString(), amount: 25, note: 'Outline', evidence: null, source: 'pomodoro' },
        { id: 'r2', at: new Date().toISOString(), amount: 25, note: 'Draft of goals section', evidence: null, source: 'pomodoro' }],
      d2: [{ id: 'r3', at: new Date().toISOString(), amount: 20, note: '', evidence: null, source: 'manual' },
        { id: 'r4', at: new Date().toISOString(), amount: 20, note: '', evidence: null, source: 'manual' },
        { id: 'r5', at: new Date().toISOString(), amount: 20, note: '', evidence: null, source: 'manual' }],
      d3: [{ id: 'r6', at: new Date().toISOString(), amount: 5, note: 'Easy pace', evidence: null, source: 'manual' },
        { id: 'r7', at: new Date().toISOString(), amount: 7.5, note: 'Long run', evidence: { kind: 'link', url: 'https://example.com/run', name: 'Route' }, source: 'manual' }],
    },
    projects: [{ name: 'Work', color: '#3b82f6' }, { name: 'Health', color: '#10b981' }],
    attachments: {},
  };
}

export class LocalBackend {
  constructor() { this.db = this.load(); }
  get kind() { return 'demo'; }
  load() {
    try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || demoSeed(); } catch { return demoSeed(); }
  }
  save() { localStorage.setItem(DEMO_KEY, JSON.stringify(this.db)); }
  static reset() { localStorage.removeItem(DEMO_KEY); }
  newId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  async me() { return { displayName: 'Demo' }; }
  async lists() { return this.db.lists.map((l) => ({ ...l })); }
  async createList(name) { const l = { id: this.newId(), name, wellknown: 'none' }; this.db.lists.push(l); this.save(); return { ...l }; }
  async tasks(listId) { return this.db.tasks.filter((t) => t.listId === listId).map((t) => structuredClone(t)); }
  async createTask(listId, fields) {
    const t = {
      id: this.newId(), listId, title: fields.title || '', description: fields.description || '', status: 'notStarted',
      importance: fields.importance || 'normal', due: fields.due || null, recurrence: fields.recurrence || null,
      created: new Date().toISOString(), completedAt: '', hasAttachments: false,
      meta: normalizeMeta(fields.meta), metaExists: !!fields.meta,
    };
    this.db.tasks.push(t); this.save(); return structuredClone(t);
  }
  async updateTask(task, fields) {
    const t = this.db.tasks.find((x) => x.id === task.id);
    if (!t) throw new Error('Task not found');
    for (const k of ['title', 'description', 'status', 'importance', 'due', 'recurrence']) if (k in fields) t[k] = fields[k];
    if ('status' in fields) t.completedAt = fields.status === 'completed' ? new Date().toISOString() : '';
    if (t.recurrence && !t.due) t.due = todayISO();
    this.save(); return structuredClone(t);
  }
  async deleteTask(task) { this.db.tasks = this.db.tasks.filter((t) => t.id !== task.id); delete this.db.results[task.id]; this.save(); }
  async setMeta(task, meta) {
    const t = this.db.tasks.find((x) => x.id === task.id);
    t.meta = normalizeMeta(meta); t.metaExists = true; this.save(); return structuredClone(t);
  }
  async results(task) { return structuredClone(this.db.results[task.id] || []); }
  async saveResults(task, results) { this.db.results[task.id] = results; this.save(); }
  async projects() { return structuredClone(this.db.projects); }
  async saveProjects(projects) { this.db.projects = projects; this.save(); }
  async attachments(task) { return (this.db.attachments[task.id] || []).map(({ data, ...a }) => a); }
  async addAttachment(task, file, onProgress) {
    if (file.size > 2 * 1024 * 1024) throw new Error('The demo keeps files in this browser and is limited to 2 MB. Sign in to attach up to 25 MB.');
    const a = { id: this.newId(), name: file.name, size: file.size, contentType: file.type, modified: new Date().toISOString(), data: await fileToBase64(file) };
    (this.db.attachments[task.id] = this.db.attachments[task.id] || []).push(a);
    const t = this.db.tasks.find((x) => x.id === task.id); if (t) t.hasAttachments = true;
    this.save(); if (onProgress) onProgress(1);
    const { data, ...out } = a; return out;
  }
  async attachmentBlob(task, id) {
    const a = (this.db.attachments[task.id] || []).find((x) => x.id === id);
    if (!a) throw new Error('Attachment not found');
    return { name: a.name, blob: base64ToBlob(a.data, a.contentType) };
  }
  async deleteAttachment(task, id) {
    this.db.attachments[task.id] = (this.db.attachments[task.id] || []).filter((a) => a.id !== id);
    const t = this.db.tasks.find((x) => x.id === task.id); if (t) t.hasAttachments = this.db.attachments[task.id].length > 0;
    this.save();
  }
  async links(task) { return structuredClone((this.db.links || {})[task.id] || []); }
  async addLink(task, { url, name }) {
    this.db.links = this.db.links || {};
    const l = { id: this.newId(), url, name: name || url };
    (this.db.links[task.id] = this.db.links[task.id] || []).push(l); this.save(); return { ...l };
  }
  async deleteLink(task, id) {
    this.db.links = this.db.links || {};
    this.db.links[task.id] = (this.db.links[task.id] || []).filter((l) => l.id !== id); this.save();
  }
  async uploadLargeFile() { throw new Error('Files over 25 MB go to your OneDrive and need you to sign in.'); }
}
