import { h, mount, clear, icon } from './dom.js';
import * as auth from './auth.js';
import { GraphBackend, LocalBackend, MAX_ATTACHMENT } from './backend.js';
import {
  GOAL_TYPES, emptyMeta, hasGoal, percent, progressLabel, formatAmount, unitFor,
  makeResult, withResults, sortResults, safeUrl,
} from './goals.js';
import { RECURRENCE_TYPES, todayISO } from './model.js';
import * as P from './pomodoro.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const MODE_KEY = 'tg-mode';
const VIEW_KEY = 'tg-view';
const POMO_KEY = 'tg-pomo';
const POMO_SETTINGS_KEY = 'tg-pomo-settings';
const PROJECT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const S = {
  backend: null,
  user: null,
  lists: [],
  tasks: new Map(),          // listId -> task[]
  projects: [],              // [{name, color}]
  view: readJSON(VIEW_KEY, { kind: 'today' }),
  showCompleted: false,
  search: '',
  selected: null,            // {id, listId}
  detail: { results: [], attachments: [], links: [], loading: false, forId: null },
  pomo: null,                // {settings, state, task}
  pomoOpen: false,
  navOpen: false,
  ready: false,              // tasks loaded for the current backend
  landing: false,            // signed-out screen showing
};

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Toasts and errors
// ---------------------------------------------------------------------------
function toast(text, kind = 'info') {
  const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text);
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 4200);
  setTimeout(() => el.remove(), 4800);
}

async function guard(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText, 'ok');
    return r;
  } catch (e) {
    if (e instanceof auth.NeedSignIn) { showLanding('Your session ended. Sign in again to keep going.'); return undefined; }
    console.error(e);
    toast(e.message || String(e), 'error');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
const allTasks = () => [...S.tasks.values()].flat();
const findTask = (ref) => ref && (S.tasks.get(ref.listId) || []).find((t) => t.id === ref.id);
const listName = (id) => (S.lists.find((l) => l.id === id) || {}).name || '';
const defaultList = () => S.lists.find((l) => l.wellknown === 'defaultList') || S.lists[0];
const projectColor = (name) => (S.projects.find((p) => p.name === name) || {}).color || '#64748b';

function replaceTask(task) {
  const arr = S.tasks.get(task.listId) || [];
  const i = arr.findIndex((t) => t.id === task.id);
  if (i >= 0) arr[i] = task; else arr.push(task);
  S.tasks.set(task.listId, arr);
}

function removeTask(task) {
  S.tasks.set(task.listId, (S.tasks.get(task.listId) || []).filter((t) => t.id !== task.id));
}

function projectNames() {
  const names = new Set(S.projects.map((p) => p.name));
  for (const t of allTasks()) if (t.meta.project) names.add(t.meta.project);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function tasksForView() {
  const v = S.view;
  let list;
  if (v.kind === 'list') list = S.tasks.get(v.id) || [];
  else if (v.kind === 'project') list = allTasks().filter((t) => t.meta.project === v.name);
  else if (v.kind === 'goals') list = allTasks().filter((t) => hasGoal(t.meta));
  else if (v.kind === 'today') {
    const today = todayISO();
    list = allTasks().filter((t) => (t.due && t.due <= today) || (t.status === 'completed' && (t.completedAt || '').slice(0, 10) === today));
  } else list = allTasks();
  const q = S.search.trim().toLowerCase();
  if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.meta.project.toLowerCase().includes(q));
  return list;
}

function sortTasks(arr) {
  return [...arr].sort((a, b) => {
    if (a.importance !== b.importance) return a.importance === 'high' ? -1 : 1;
    const ad = a.due || '9999', bd = b.due || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (b.created || '').localeCompare(a.created || '');
  });
}

function viewTitle() {
  const v = S.view;
  if (v.kind === 'list') return listName(v.id) || 'List';
  if (v.kind === 'project') return v.name;
  if (v.kind === 'goals') return 'Goals';
  if (v.kind === 'today') return 'Today';
  return 'All tasks';
}

function setView(v) {
  S.view = v;
  S.navOpen = false;
  writeJSON(VIEW_KEY, v);
  render();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  initPomodoro();
  const mode = localStorage.getItem(MODE_KEY);
  if (mode === 'demo') return start(new LocalBackend());
  if (auth.isSignedIn()) return start(new GraphBackend());
  showLanding();
}

function showLanding(message) {
  S.backend = null;
  S.ready = false;
  S.landing = true;
  $('app').hidden = true;
  const landing = $('landing');
  landing.hidden = false;
  mount($('landing-msg'), message ? h('p', { class: 'notice' }, message) : null);
}

async function start(backend) {
  S.backend = backend;
  S.ready = false;
  S.landing = false;
  $('landing').hidden = true;
  $('app').hidden = false;
  document.body.classList.toggle('demo', backend.kind === 'demo');
  renderHeader();
  mount($('tasks'), h('p', { class: 'muted pad' }, 'Loading your tasks…'));
  const ok = await guard(async () => {
    const [lists, projects] = await Promise.all([backend.lists(), backend.projects().catch(() => [])]);
    S.lists = lists;
    S.projects = projects;
    const loaded = await Promise.all(lists.map((l) => backend.tasks(l.id).then((t) => [l.id, t])));
    S.tasks = new Map(loaded);
    if (backend.kind === 'graph') {
      const acct = auth.account();
      S.user = acct ? acct.name || acct.username : '';
    } else S.user = 'Demo';
    return true;
  });
  if (!ok) return;
  S.ready = true;
  if (S.view.kind === 'list' && !S.lists.some((l) => l.id === S.view.id)) S.view = { kind: 'today' };
  render();
}

async function refresh() {
  if (!S.backend) return;
  await guard(async () => {
    const lists = await S.backend.lists();
    S.lists = lists;
    const loaded = await Promise.all(lists.map((l) => S.backend.tasks(l.id).then((t) => [l.id, t])));
    S.tasks = new Map(loaded);
  });
  render();
}

// ---------------------------------------------------------------------------
// Render: header, nav, list
// ---------------------------------------------------------------------------
function render() {
  renderHeader();
  renderNav();
  renderTasks();
  if (S.selected && !findTask(S.selected)) closeDetail();
  document.body.classList.toggle('nav-open', S.navOpen);
}

function accountControls() {
  return S.backend.kind === 'demo'
      ? [h('span', { class: 'pill warn' }, 'Demo: saved in this browser only'),
        h('button', { class: 'btn small', onclick: () => { localStorage.removeItem(MODE_KEY); auth.signIn(); } }, 'Sign in with Microsoft'),
        h('button', { class: 'btn small ghost', onclick: exitDemo }, 'Exit demo')]
      : [h('span', { class: 'muted user' }, S.user || ''),
        h('button', { class: 'btn small ghost', onclick: () => auth.signOut() }, 'Sign out')];
}

function renderHeader() {
  const acct = $('account');
  if (!S.backend) { clear(acct); return; }
  mount(acct, accountControls());
}

function navItem(label, iconName, view, count, extra) {
  const active = S.view.kind === view.kind && (S.view.id === view.id) && (S.view.name === view.name);
  return h('li', null,
    h('button', { class: 'nav-item' + (active ? ' active' : ''), onclick: () => setView(view) },
      extra || icon(iconName, 16), h('span', { class: 'grow' }, label),
      count ? h('span', { class: 'count' }, count) : null));
}

function renderNav() {
  const open = (arr) => arr.filter((t) => t.status !== 'completed').length;
  const today = todayISO();
  const all = allTasks();
  mount($('nav'),
    h('ul', { class: 'nav-group' },
      navItem('Today', 'sun', { kind: 'today' }, all.filter((t) => t.status !== 'completed' && t.due && t.due <= today).length),
      navItem('All tasks', 'inbox', { kind: 'all' }, open(all)),
      navItem('Goals', 'target', { kind: 'goals' }, open(all.filter((t) => hasGoal(t.meta))))),
    h('h3', { class: 'nav-head' }, 'Projects'),
    h('ul', { class: 'nav-group' },
      projectNames().map((name) => navItem(name, null, { kind: 'project', name },
        open(all.filter((t) => t.meta.project === name)),
        h('span', { class: 'dot', style: { background: projectColor(name) } })))),
    inlineAdd('New project', addProject),
    h('h3', { class: 'nav-head' }, 'Lists'),
    h('ul', { class: 'nav-group' },
      S.lists.map((l) => navItem(l.name, 'list', { kind: 'list', id: l.id }, open(S.tasks.get(l.id) || [])))),
    inlineAdd('New list', addList),
    h('div', { class: 'nav-account only-mobile' }, accountControls()),
  );
}

function inlineAdd(label, onAdd) {
  const input = h('input', { type: 'text', placeholder: label, 'aria-label': label, maxlength: 80 });
  const form = h('form', { class: 'inline-add' },
    icon('plus', 14), input);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    await onAdd(v);
  });
  return form;
}

async function addProject(name) {
  if (projectNames().includes(name)) { setView({ kind: 'project', name }); return; }
  const color = PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length];
  S.projects = [...S.projects, { name, color }];
  await guard(() => S.backend.saveProjects(S.projects));
  setView({ kind: 'project', name });
}

async function addList(name) {
  const l = await guard(() => S.backend.createList(name));
  if (!l) return;
  S.lists.push(l);
  S.tasks.set(l.id, []);
  setView({ kind: 'list', id: l.id });
}

function renderTasks() {
  const visible = tasksForView();
  const open = sortTasks(visible.filter((t) => t.status !== 'completed'));
  const done = visible.filter((t) => t.status === 'completed')
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

  mount($('view-title'), viewTitle());
  const subtitle = S.view.kind === 'today'
    ? new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : `${open.length} open`;
  mount($('view-sub'), subtitle);

  const addInput = h('input', { type: 'text', id: 'add-title', placeholder: 'Add a task', 'aria-label': 'Add a task', maxlength: 255, autocomplete: 'off' });
  const addForm = h('form', { class: 'add-task' }, icon('plus'), addInput,
    h('button', { class: 'btn', type: 'submit' }, 'Add'));
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = addInput.value.trim();
    if (!title) return;
    addInput.value = '';
    await createTask(title);
    $('add-title') && $('add-title').focus();
  });

  const rows = open.map(taskRow);
  const empty = !open.length ? h('p', { class: 'empty' }, S.search ? 'No tasks match your search.' : emptyText()) : null;
  const completed = done.length ? [
    h('button', { class: 'completed-toggle', onclick: () => { S.showCompleted = !S.showCompleted; renderTasks(); } },
      (S.showCompleted ? 'Hide' : 'Show') + ` completed (${done.length})`),
    S.showCompleted ? h('ul', { class: 'task-list done' }, done.map(taskRow)) : null,
  ] : null;

  mount($('tasks'), addForm, empty, h('ul', { class: 'task-list' }, rows), completed);
}

function emptyText() {
  if (S.view.kind === 'today') return 'Nothing due today. Add a task, or pick one from All tasks.';
  if (S.view.kind === 'goals') return 'No tasks with goals yet. Open a task and set a goal.';
  return 'No open tasks here.';
}

function taskRow(t) {
  const selected = S.selected && S.selected.id === t.id;
  const today = todayISO();
  const bits = [];
  if (S.view.kind !== 'list') bits.push(h('span', { class: 'chip' }, icon('list', 12), listName(t.listId)));
  if (t.meta.project && S.view.kind !== 'project') {
    bits.push(h('span', { class: 'chip' }, h('span', { class: 'dot', style: { background: projectColor(t.meta.project) } }), t.meta.project));
  }
  if (t.due) {
    const cls = t.status !== 'completed' && t.due < today ? 'chip overdue' : t.due === today ? 'chip due-today' : 'chip';
    bits.push(h('span', { class: cls }, icon('calendar', 12), formatDue(t.due)));
  }
  if (t.recurrence) bits.push(h('span', { class: 'chip', title: 'Repeats ' + t.recurrence.type }, icon('repeat', 12)));
  if (t.hasAttachments) bits.push(h('span', { class: 'chip', title: 'Has attachments' }, icon('clip', 12)));
  if (S.pomo && S.pomo.task && S.pomo.task.id === t.id) bits.push(h('span', { class: 'chip focus' }, icon('timer', 12), 'Focus'));

  const goal = hasGoal(t.meta) ? h('div', { class: 'goal-mini' },
    h('div', { class: 'bar' }, h('div', { class: 'fill', style: { width: percent(t.meta) + '%' } })),
    h('span', { class: 'muted' }, progressLabel(t.meta))) : null;

  const check = h('button', {
    class: 'check' + (t.status === 'completed' ? ' on' : ''), title: t.status === 'completed' ? 'Mark not done' : 'Mark done',
    'aria-label': (t.status === 'completed' ? 'Mark not done: ' : 'Mark done: ') + t.title,
    onclick: (e) => { e.stopPropagation(); toggleDone(t); },
  }, icon('check', 14));

  const star = h('button', {
    class: 'star' + (t.importance === 'high' ? ' on' : ''), 'aria-label': 'Toggle important',
    onclick: (e) => { e.stopPropagation(); saveFields(t, { importance: t.importance === 'high' ? 'normal' : 'high' }); },
  }, icon('star', 16));

  return h('li', { class: 'task' + (selected ? ' selected' : '') + (t.status === 'completed' ? ' is-done' : '') },
    check,
    h('button', { class: 'task-main', onclick: () => openDetail(t) },
      h('span', { class: 'title' }, t.title || '(untitled)'),
      bits.length ? h('span', { class: 'chips' }, bits) : null,
      goal),
    star);
}

function formatDue(date) {
  const today = todayISO();
  const tomorrow = todayISO(new Date(Date.now() + 86400000));
  if (date === today) return 'Today';
  if (date === tomorrow) return 'Tomorrow';
  const d = new Date(date + 'T12:00:00');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------
async function createTask(title) {
  const v = S.view;
  const list = v.kind === 'list' ? S.lists.find((l) => l.id === v.id) : defaultList();
  if (!list) { toast('No To Do list to add to.', 'error'); return; }
  const fields = { title };
  if (v.kind === 'today') fields.due = todayISO();
  if (v.kind === 'project') fields.meta = { ...emptyMeta(), project: v.name };
  const t = await guard(() => S.backend.createTask(list.id, fields));
  if (!t) return;
  replaceTask(t);
  render();
}

async function toggleDone(t) {
  const status = t.status === 'completed' ? 'notStarted' : 'completed';
  const updated = await guard(() => S.backend.updateTask(t, { status }));
  if (!updated) return;
  replaceTask(updated);
  // To Do creates the next occurrence of a recurring task on completion.
  if (status === 'completed' && t.recurrence) {
    const fresh = await guard(() => S.backend.tasks(t.listId));
    if (fresh) S.tasks.set(t.listId, fresh);
  }
  render();
  if (S.selected && S.selected.id === t.id) renderDetail();
}

async function saveFields(t, fields) {
  if ('recurrence' in fields && fields.recurrence && !('due' in fields) && !t.due) fields.due = todayISO();
  const updated = await guard(() => S.backend.updateTask(t, fields));
  if (!updated) return null;
  replaceTask(updated);
  render();
  return updated;
}

async function saveMeta(t, patch) {
  const updated = await guard(() => S.backend.setMeta(t, { ...t.meta, ...patch }));
  if (!updated) return null;
  replaceTask(updated);
  if (patch.project && !S.projects.some((p) => p.name === patch.project)) {
    S.projects = [...S.projects, { name: patch.project, color: PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length] }];
    guard(() => S.backend.saveProjects(S.projects));
  }
  render();
  return updated;
}

async function deleteTask(t) {
  if (!confirm(`Delete "${t.title}"? This removes it from Microsoft To Do too.`)) return;
  const ok = await guard(async () => { await S.backend.deleteTask(t); return true; });
  if (!ok) return;
  removeTask(t);
  if (S.pomo.task && S.pomo.task.id === t.id) setPomoTask(null);
  closeDetail();
  render();
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
async function openDetail(t) {
  S.selected = { id: t.id, listId: t.listId };
  S.detail = { results: [], attachments: [], links: [], loading: true, forId: t.id };
  document.body.classList.add('detail-open');
  renderTasks();
  renderDetail();
  const [results, attachments, links] = await Promise.all([
    guard(() => S.backend.results(t)),
    t.hasAttachments ? guard(() => S.backend.attachments(t)) : Promise.resolve([]),
    guard(() => S.backend.links(t)),
  ]);
  if (!S.selected || S.selected.id !== t.id) return;
  S.detail = { results: results || [], attachments: attachments || [], links: links || [], loading: false, forId: t.id };
  renderDetail();
}

function closeDetail() {
  S.selected = null;
  document.body.classList.remove('detail-open');
  clear($('detail'));
  renderTasks();
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

function renderDetail() {
  const t = findTask(S.selected);
  const panel = $('detail');
  if (!t) { clear(panel); return; }
  const m = t.meta;

  const title = h('input', { type: 'text', class: 'title-input', value: t.title, maxlength: 255, 'aria-label': 'Title' });
  title.addEventListener('change', () => { const v = title.value.trim(); if (v && v !== t.title) saveFields(t, { title: v }); });

  const desc = h('textarea', { rows: 4, placeholder: 'Description, notes, definition of done…' });
  desc.value = t.description;
  desc.addEventListener('change', () => { if (desc.value !== t.description) saveFields(t, { description: desc.value }); });

  const due = h('input', { type: 'date', value: t.due || '' });
  due.addEventListener('change', () => saveFields(t, { due: due.value || null, ...(due.value ? {} : { recurrence: null }) }).then(renderDetail));

  const recType = h('select', { 'aria-label': 'Repeat' },
    h('option', { value: '' }, 'Does not repeat'),
    RECURRENCE_TYPES.map((r) => h('option', { value: r, selected: t.recurrence && t.recurrence.type === r }, r[0].toUpperCase() + r.slice(1))));
  const recInterval = h('input', { type: 'number', min: 1, max: 99, value: t.recurrence ? t.recurrence.interval : 1, class: 'narrow', 'aria-label': 'Every' });
  const saveRec = () => saveFields(t, { recurrence: recType.value ? { type: recType.value, interval: Number(recInterval.value) || 1 } : null }).then(renderDetail);
  recType.addEventListener('change', saveRec);
  recInterval.addEventListener('change', () => { if (recType.value) saveRec(); });

  // Project
  const NEW = '__new__';
  const project = h('select', { 'aria-label': 'Project' },
    h('option', { value: '' }, 'No project'),
    projectNames().map((p) => h('option', { value: p, selected: m.project === p }, p)),
    h('option', { value: NEW }, 'New project…'));
  project.addEventListener('change', async () => {
    let v = project.value;
    if (v === NEW) {
      v = (prompt('Project name') || '').trim();
      if (!v) { project.value = m.project; return; }
    }
    await saveMeta(t, { project: v });
    renderDetail();
  });

  // Goal
  const goalType = h('select', { 'aria-label': 'Goal type' },
    Object.entries(GOAL_TYPES).map(([k, g]) => h('option', { value: k, selected: m.goalType === k }, g.label)));
  const target = h('input', { type: 'number', min: 0, step: 'any', value: m.target || '', placeholder: 'Target', 'aria-label': 'Target', class: 'narrow' });
  const unit = h('input', { type: 'text', value: m.unit, placeholder: 'Unit (km, pages…)', maxlength: 24, 'aria-label': 'Unit' });
  const saveGoal = async () => {
    await saveMeta(t, { goalType: goalType.value, target: Number(target.value) || 0, unit: unit.value.trim() });
    renderDetail();
  };
  goalType.addEventListener('change', saveGoal);
  target.addEventListener('change', saveGoal);
  unit.addEventListener('change', saveGoal);

  const goalBlock = m.goalType === 'none'
    ? field('Goal', goalType, 'Track repetitions, time, or a quantity toward a target.')
    : h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Goal'),
      h('div', { class: 'row' }, goalType, target,
        m.goalType === 'quantity' ? unit : h('span', { class: 'muted' }, m.goalType === 'time' ? 'minutes' : 'reps')));

  const progress = hasGoal(m) ? h('div', { class: 'progress-card' },
    h('div', { class: 'row between' },
      h('strong', null, progressLabel(m)),
      h('span', { class: 'pct' }, percent(m) + '%')),
    h('div', { class: 'bar big' }, h('div', { class: 'fill', style: { width: percent(m) + '%' } })),
    m.progress >= m.target ? h('p', { class: 'ok-text' }, 'Goal reached.') : null) : null;

  const focusing = S.pomo.task && S.pomo.task.id === t.id;
  const actions = h('div', { class: 'row detail-actions' },
    h('button', { class: 'btn' + (focusing ? ' ghost' : ''), onclick: () => { setPomoTask(focusing ? null : t); openPomo(); } },
      icon('timer', 16), focusing ? 'Stop focusing' : 'Focus with Pomodoro'),
    h('button', { class: 'btn ghost danger', onclick: () => deleteTask(t) }, icon('trash', 16), 'Delete'));

  mount(panel,
    h('div', { class: 'detail-head' },
      h('button', {
        class: 'check' + (t.status === 'completed' ? ' on' : ''), 'aria-label': 'Toggle done', onclick: () => toggleDone(t),
      }, icon('check', 14)),
      title,
      h('button', { class: 'icon-btn', 'aria-label': 'Close details', onclick: closeDetail }, icon('close'))),
    h('p', { class: 'muted small' }, 'In ', listName(t.listId), t.status === 'completed' && t.completedAt ? ' · completed ' + new Date(t.completedAt + (t.completedAt.endsWith('Z') ? '' : 'Z')).toLocaleDateString() : ''),
    actions,
    field('Description', desc),
    h('div', { class: 'grid2' },
      field('Due', due),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Repeat'), h('div', { class: 'row' }, recType, t.recurrence ? [h('span', { class: 'muted' }, 'every'), recInterval] : null))),
    field('Project', project),
    goalBlock,
    progress,
    resultsSection(t),
    attachmentsSection(t),
  );
}

// ---- results log ----
function resultsSection(t) {
  const m = t.meta;
  const loading = S.detail.loading && S.detail.forId === t.id;
  const results = sortResults(S.detail.results);
  const step = (GOAL_TYPES[m.goalType] || {}).step || 1;

  const amount = h('input', { type: 'number', min: 0, step: 'any', value: m.goalType === 'none' ? '' : step, placeholder: 'Amount', class: 'narrow', 'aria-label': 'Amount', required: m.goalType !== 'none' });
  const note = h('input', { type: 'text', placeholder: 'What did you get done?', maxlength: 2000, 'aria-label': 'Note' });
  const link = h('input', { type: 'url', placeholder: 'Evidence link (optional)', 'aria-label': 'Evidence link' });
  const file = h('input', { type: 'file', 'aria-label': 'Evidence file' });
  const status = h('span', { class: 'muted small' });

  const form = h('form', { class: 'result-form' },
    h('div', { class: 'row' }, amount, m.goalType !== 'none' ? h('span', { class: 'muted' }, unitFor(m)) : null, note),
    h('div', { class: 'row' }, link),
    h('div', { class: 'row between' }, h('label', { class: 'file-label' }, icon('clip', 14), file), status,
      h('button', { class: 'btn', type: 'submit' }, 'Log result')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let evidence = null;
    if (link.value.trim()) {
      const url = safeUrl(link.value.trim());
      if (!url) { toast('Evidence links must start with http:// or https://', 'error'); return; }
      evidence = { kind: 'link', url, name: url };
    }
    const f = file.files && file.files[0];
    form.querySelector('button[type=submit]').disabled = true;
    if (f) {
      status.textContent = 'Uploading…';
      evidence = await uploadEvidence(t, f, (p) => { status.textContent = `Uploading ${Math.round(p * 100)}%`; });
      if (!evidence) { form.querySelector('button[type=submit]').disabled = false; status.textContent = ''; return; }
    }
    status.textContent = '';
    const ok = await logResult(t, { amount: amount.value || 0, note: note.value.trim(), evidence });
    form.querySelector('button[type=submit]').disabled = false;
    if (ok) renderDetail();
  });

  const quick = m.goalType === 'count' ? h('div', { class: 'row quick' },
    [1, 5, 10].map((n) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => logResult(t, { amount: n }).then((ok) => ok && renderDetail()) }, '+' + n))) : null;

  return h('section', { class: 'section' },
    h('h3', null, 'Results'),
    h('p', { class: 'muted small' }, 'Log what each session produced. Amounts add toward the goal.'),
    quick,
    form,
    loading ? h('p', { class: 'muted' }, 'Loading results…')
      : results.length ? h('ul', { class: 'results' }, results.map((r) => resultRow(t, r)))
        : h('p', { class: 'muted small' }, 'No results logged yet.'));
}

function resultRow(t, r) {
  const ev = r.evidence;
  let evidence = null;
  if (ev && (ev.kind === 'link' || ev.kind === 'file')) {
    const url = safeUrl(ev.url);
    if (url) evidence = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'ev' }, icon(ev.kind === 'file' ? 'clip' : 'link', 12), ev.name || url);
  } else if (ev && ev.kind === 'attachment') {
    evidence = h('button', { class: 'linklike ev', onclick: () => downloadAttachment(t, ev.attachmentId) }, icon('clip', 12), ev.name);
  }
  const when = new Date(r.at);
  return h('li', { class: 'result' },
    h('div', { class: 'row between' },
      h('strong', null, t.meta.goalType === 'none' && !r.amount ? 'Session' : formatAmount(r.amount, t.meta)),
      h('span', { class: 'muted small' }, when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        r.source === 'pomodoro' ? ' · Pomodoro' : '',
        h('button', { class: 'icon-btn tiny', 'aria-label': 'Delete result', onclick: () => deleteResult(t, r) }, icon('trash', 12)))),
    r.note ? h('p', null, r.note) : null,
    evidence);
}

async function logResult(t, { amount, note = '', evidence = null, source = 'manual' }) {
  return guard(async () => {
    const r = makeResult({ amount, note, evidence, source });
    const current = S.detail.forId === t.id && !S.detail.loading ? S.detail.results : await S.backend.results(t);
    const results = [...current, r];
    await S.backend.saveResults(t, results);
    if (S.detail.forId === t.id) S.detail.results = results;
    const fresh = findTask(t) || t;
    const updated = await S.backend.setMeta(fresh, withResults(fresh.meta, results));
    replaceTask(updated);
    render();
    return true;
  }, source === 'pomodoro' ? null : 'Result logged');
}

async function deleteResult(t, r) {
  if (!confirm('Delete this result entry?')) return;
  await guard(async () => {
    const results = S.detail.results.filter((x) => x.id !== r.id);
    await S.backend.saveResults(t, results);
    S.detail.results = results;
    const updated = await S.backend.setMeta(findTask(t) || t, withResults(t.meta, results));
    replaceTask(updated);
    render();
    renderDetail();
  });
}

async function uploadEvidence(t, f, onProgress) {
  return guard(async () => {
    if (f.size <= MAX_ATTACHMENT) {
      const a = await S.backend.addAttachment(t, f, onProgress);
      if (!a) throw new Error('Upload finished but the attachment was not found.');
      S.detail.attachments = [...S.detail.attachments.filter((x) => x.id !== a.id), a];
      replaceTask({ ...(findTask(t) || t), hasAttachments: true });
      return { kind: 'attachment', attachmentId: a.id, name: a.name };
    }
    const big = await S.backend.uploadLargeFile(f, onProgress);
    const l = await S.backend.addLink(t, big);
    S.detail.links = [...S.detail.links, l];
    return { kind: 'file', url: big.url, name: big.name };
  });
}

// ---- attachments and links ----
function attachmentsSection(t) {
  const file = h('input', { type: 'file', multiple: true, 'aria-label': 'Attach files' });
  const status = h('span', { class: 'muted small' });
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      status.textContent = `Uploading ${f.name}…`;
      if (f.size > MAX_ATTACHMENT) {
        const big = await guard(() => S.backend.uploadLargeFile(f, (p) => { status.textContent = `Uploading ${f.name} ${Math.round(p * 100)}% to OneDrive`; }));
        if (big) {
          const l = await guard(() => S.backend.addLink(t, big));
          if (l) S.detail.links = [...S.detail.links, l];
        }
      } else {
        const a = await guard(() => S.backend.addAttachment(t, f, (p) => { status.textContent = `Uploading ${f.name} ${Math.round(p * 100)}%`; }));
        if (a) {
          S.detail.attachments = [...S.detail.attachments, a];
          replaceTask({ ...(findTask(t) || t), hasAttachments: true });
        }
      }
    }
    status.textContent = '';
    render();
    renderDetail();
  });

  const linkInput = h('input', { type: 'url', placeholder: 'https://…', 'aria-label': 'Link URL' });
  const linkForm = h('form', { class: 'row' }, linkInput, h('button', { class: 'btn small', type: 'submit' }, 'Add link'));
  linkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = safeUrl(linkInput.value.trim());
    if (!url) { toast('Links must start with http:// or https://', 'error'); return; }
    const l = await guard(() => S.backend.addLink(t, { url, name: url }));
    if (l) { S.detail.links = [...S.detail.links, l]; renderDetail(); }
  });

  const items = [
    ...S.detail.attachments.map((a) => h('li', { class: 'row between' },
      h('button', { class: 'linklike', onclick: () => downloadAttachment(t, a.id) }, icon('download', 14), a.name),
      h('span', { class: 'muted small' }, formatSize(a.size),
        h('button', { class: 'icon-btn tiny', 'aria-label': 'Delete attachment ' + a.name, onclick: () => deleteAttachment(t, a) }, icon('trash', 12))))),
    ...S.detail.links.map((l) => h('li', { class: 'row between' },
      h('a', { href: safeUrl(l.url) || '#', target: '_blank', rel: 'noopener noreferrer' }, icon('link', 14), l.name),
      h('button', { class: 'icon-btn tiny', 'aria-label': 'Remove link', onclick: () => deleteLink(t, l) }, icon('trash', 12)))),
  ];

  return h('section', { class: 'section' },
    h('h3', null, 'Files and links'),
    h('p', { class: 'muted small' }, 'Files up to 25 MB attach to the task in To Do. Larger files go to your OneDrive and are linked.'),
    items.length ? h('ul', { class: 'files' }, items) : null,
    h('div', { class: 'row between' }, h('label', { class: 'file-label' }, icon('clip', 14), file), status),
    linkForm);
}

function formatSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function downloadAttachment(t, id) {
  const r = await guard(() => S.backend.attachmentBlob(t, id));
  if (!r) return;
  const url = URL.createObjectURL(r.blob);
  const a = h('a', { href: url, download: r.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function deleteAttachment(t, a) {
  if (!confirm(`Delete ${a.name}?`)) return;
  const ok = await guard(async () => { await S.backend.deleteAttachment(t, a.id); return true; });
  if (!ok) return;
  S.detail.attachments = S.detail.attachments.filter((x) => x.id !== a.id);
  replaceTask({ ...(findTask(t) || t), hasAttachments: S.detail.attachments.length > 0 });
  render();
  renderDetail();
}

async function deleteLink(t, l) {
  const ok = await guard(async () => { await S.backend.deleteLink(t, l.id); return true; });
  if (!ok) return;
  S.detail.links = S.detail.links.filter((x) => x.id !== l.id);
  renderDetail();
}

// ---------------------------------------------------------------------------
// Pomodoro
// ---------------------------------------------------------------------------
let audioCtx = null;
let tickTimer = null;

function initPomodoro() {
  const settings = P.normalizeSettings(readJSON(POMO_SETTINGS_KEY, null));
  const saved = readJSON(POMO_KEY, null);
  S.pomo = {
    settings,
    state: saved && saved.state ? { ...P.initialState(settings), ...saved.state } : P.initialState(settings),
    task: saved && saved.task ? saved.task : null,
  };
  window.addEventListener('storage', (e) => {
    if (e.key === POMO_KEY) {
      const v = readJSON(POMO_KEY, null);
      if (v) { S.pomo.state = v.state; S.pomo.task = v.task; renderPomo(); }
    }
    if (e.key === POMO_SETTINGS_KEY) { S.pomo.settings = P.normalizeSettings(readJSON(POMO_SETTINGS_KEY, null)); renderPomo(); }
  });
  $('pomo-chip').addEventListener('click', () => (S.pomoOpen ? closePomo() : openPomo()));
  tickTimer = setInterval(tick, 250);
  tick();
  renderPomo();
}

function persistPomo() {
  writeJSON(POMO_KEY, { state: S.pomo.state, task: S.pomo.task });
}

function setPomoTask(t) {
  S.pomo.task = t ? { id: t.id, listId: t.listId, title: t.title } : null;
  persistPomo();
  renderPomo();
  if (S.backend) { renderTasks(); if (S.selected) renderDetail(); }
}

function openPomo() { S.pomoOpen = true; renderPomo(); }
function closePomo() { S.pomoOpen = false; renderPomo(); }

function tick() {
  const { state } = S.pomo;
  const now = Date.now();
  if (state.running && state.endsAt <= now) {
    // Wait for tasks to load so a session that ended while the tab was closed
    // still logs its minutes.
    if (S.pomo.task && !S.ready && !S.landing) return;
    // Another tab may have already completed this phase; re-read first.
    const stored = readJSON(POMO_KEY, null);
    if (stored && stored.state && stored.state.endsAt !== state.endsAt) {
      S.pomo.state = stored.state; S.pomo.task = stored.task; renderPomo(); return;
    }
    completePhase(now);
    return;
  }
  const ms = P.remaining(state, now);
  const clock = P.formatClock(ms);
  const chip = $('pomo-clock');
  if (chip.textContent !== clock) chip.textContent = clock;
  const big = $('pomo-big');
  if (big && big.textContent !== clock) big.textContent = clock;
  const ring = $('pomo-ring');
  if (ring) {
    const total = P.durationMs(state.phase, S.pomo.settings);
    ring.style.setProperty('--p', String(1 - ms / total));
  }
  document.title = state.running ? `${clock} · ${P.PHASE_LABEL[state.phase]} · task.geterdone` : 'task.geterdone';
}

async function completePhase(now) {
  const { settings } = S.pomo;
  const prev = S.pomo.state;
  const minutes = P.focusMinutes(prev, settings, now);
  S.pomo.state = P.advance(prev, settings, now, { completed: true });
  persistPomo();
  renderPomo();
  alertPhaseEnd(prev.phase, S.pomo.state.phase);
  if (prev.phase === 'focus') await logFocus(minutes);
}

async function logFocus(minutes) {
  const ref = S.pomo.task;
  if (!ref || !S.backend || minutes < 1) return;
  const t = findTask(ref);
  if (!t) return;
  if (t.meta.goalType !== 'time') {
    toast(`Focus session done on "${t.title}".`, 'ok');
    return;
  }
  const ok = await logResult(t, { amount: minutes, note: 'Pomodoro focus session', source: 'pomodoro' });
  if (ok) {
    toast(`Logged ${minutes} min to "${t.title}".`, 'ok');
    if (S.selected && S.selected.id === t.id) renderDetail();
  }
}

function alertPhaseEnd(endedPhase, nextPhase) {
  const { settings } = S.pomo;
  if (settings.sound) chime(endedPhase === 'focus' ? [880, 660, 880] : [660, 880]);
  const title = endedPhase === 'focus' ? 'Focus session complete' : 'Break over';
  const body = endedPhase === 'focus' ? `Time for a ${P.PHASE_LABEL[nextPhase].toLowerCase()}.` : 'Back to focus.';
  if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'task-geterdone-pomodoro', icon: '/favicon.svg' }); } catch { /* some browsers need a service worker */ }
  }
  toast(`${title}. ${body}`, 'info');
}

function chime(freqs) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t0 = audioCtx.currentTime + 0.05;
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0);
      o.stop(t0 + 0.4);
      t0 += 0.42;
    }
  } catch { /* audio unavailable */ }
}

function pomoStart() {
  // A user gesture: unlock audio and ask for notification permission once.
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* ignore */ }
  if (S.pomo.settings.notify && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  S.pomo.state = P.start(S.pomo.state, Date.now());
  persistPomo();
  renderPomo();
}

function pomoPause() { S.pomo.state = P.pause(S.pomo.state, Date.now()); persistPomo(); renderPomo(); }
function pomoReset() { S.pomo.state = P.reset(S.pomo.state, S.pomo.settings); persistPomo(); renderPomo(); }
async function pomoSkip() {
  const now = Date.now();
  const prev = S.pomo.state;
  const minutes = prev.running || prev.startedAt ? P.focusMinutes(prev, S.pomo.settings, now) : 0;
  S.pomo.state = P.advance(prev, S.pomo.settings, now, { completed: false });
  persistPomo();
  renderPomo();
  // Time actually spent focusing still counts toward a time goal.
  if (prev.phase === 'focus' && minutes >= 1) await logFocus(minutes);
}

function renderPomo() {
  const { state, settings, task } = S.pomo;
  const chip = $('pomo-chip');
  chip.classList.toggle('running', state.running);
  chip.dataset.phase = state.phase;
  mount($('pomo-phase'), P.PHASE_LABEL[state.phase]);
  const panel = $('pomo-panel');
  panel.hidden = !S.pomoOpen;
  chip.setAttribute('aria-expanded', String(S.pomoOpen));
  if (!S.pomoOpen) { tick(); return; }

  const phases = h('div', { class: 'seg', role: 'tablist' },
    ['focus', 'short', 'long'].map((p) => h('button', {
      class: state.phase === p ? 'on' : '', role: 'tab', 'aria-selected': String(state.phase === p),
      onclick: () => { S.pomo.state = P.setPhase(state, p, settings); persistPomo(); renderPomo(); },
    }, P.PHASE_LABEL[p])));

  const t = task && findTask(task);
  const taskLine = task
    ? h('p', { class: 'pomo-task' }, 'Focusing on ', h('strong', null, (t && t.title) || task.title),
      t && t.meta.goalType === 'time' ? h('span', { class: 'muted' }, ` · minutes count toward ${progressLabel(t.meta) || 'its goal'}`) : h('span', { class: 'muted' }, ' · set a Time goal to log minutes'),
      ' ', h('button', { class: 'linklike', onclick: () => setPomoTask(null) }, 'clear'))
    : h('p', { class: 'pomo-task muted' }, 'No task selected. Open a task and choose "Focus with Pomodoro" to log minutes toward a time goal.');

  const num = (key, label, min, max) => {
    const i = h('input', { type: 'number', min, max, value: settings[key], class: 'narrow', 'aria-label': label });
    i.addEventListener('change', () => updateSettings({ [key]: Number(i.value) }));
    return h('label', { class: 'field compact' }, h('span', { class: 'label' }, label), i);
  };
  const tog = (key, label) => {
    const i = h('input', { type: 'checkbox', checked: settings[key] });
    i.addEventListener('change', () => updateSettings({ [key]: i.checked }));
    return h('label', { class: 'toggle' }, i, label);
  };

  mount(panel,
    h('div', { class: 'row between' }, h('h2', null, 'Pomodoro'),
      h('button', { class: 'icon-btn', 'aria-label': 'Close timer', onclick: closePomo }, icon('close'))),
    phases,
    h('div', { class: 'ring', id: 'pomo-ring', 'data-phase': state.phase },
      h('div', { class: 'ring-inner' }, h('div', { id: 'pomo-big', class: 'big-clock' }, P.formatClock(P.remaining(state, Date.now()))),
        h('div', { class: 'muted small' }, `${state.completedFocus} focus session${state.completedFocus === 1 ? '' : 's'} · long break every ${settings.every}`))),
    h('div', { class: 'row center' },
      state.running
        ? h('button', { class: 'btn big', onclick: pomoPause }, icon('pause'), 'Pause')
        : h('button', { class: 'btn big', onclick: pomoStart }, icon('play'), state.startedAt ? 'Resume' : 'Start'),
      h('button', { class: 'icon-btn', title: 'Reset', 'aria-label': 'Reset timer', onclick: pomoReset }, icon('reset')),
      h('button', { class: 'icon-btn', title: 'Skip to next phase', 'aria-label': 'Skip to next phase', onclick: pomoSkip }, icon('skip'))),
    taskLine,
    h('details', { class: 'pomo-settings' },
      h('summary', null, icon('gear', 14), 'Settings'),
      h('div', { class: 'grid4' },
        num('focus', 'Focus (min)', 1, 180), num('short', 'Short break', 1, 60), num('long', 'Long break', 1, 90), num('every', 'Long break every', 1, 12)),
      h('div', { class: 'row wrap' }, tog('autoStart', 'Auto-start next phase'), tog('sound', 'Sound'), tog('notify', 'Browser notification'))),
  );
  tick();
}

function updateSettings(patch) {
  const settings = P.normalizeSettings({ ...S.pomo.settings, ...patch });
  S.pomo.settings = settings;
  writeJSON(POMO_SETTINGS_KEY, settings);
  if (!S.pomo.state.running && !S.pomo.state.startedAt) S.pomo.state = P.reset(S.pomo.state, settings);
  persistPomo();
  renderPomo();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function exitDemo() {
  localStorage.removeItem(MODE_KEY);
  showLanding();
}

document.addEventListener('DOMContentLoaded', () => {
  $('signin').addEventListener('click', () => auth.signIn());
  $('demo').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'demo'); start(new LocalBackend()); });
  $('menu').addEventListener('click', () => { S.navOpen = !S.navOpen; document.body.classList.toggle('nav-open', S.navOpen); });
  $('scrim').addEventListener('click', () => { S.navOpen = false; document.body.classList.remove('nav-open'); });
  $('refresh').addEventListener('click', refresh);
  const search = $('search');
  search.addEventListener('input', () => { S.search = search.value; renderTasks(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.pomoOpen) closePomo();
      else if (S.selected) closeDetail();
    }
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      const i = $('add-title'); if (i) { e.preventDefault(); i.focus(); }
    }
  });
  // Pick up changes made in the To Do apps when the tab comes back.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S.backend && S.backend.kind === 'graph' && Date.now() - hiddenAt > 60000) refresh();
  });
  boot();
});
