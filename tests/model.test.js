import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueFromGraph, dueToGraph, recurrenceToGraph, recurrenceFromGraph, taskFromGraph, patchToGraph, metaToExtension } from '../site/js/model.js';

test('due dates round-trip as plain dates', () => {
  assert.deepEqual(dueToGraph('2026-10-21'), { dateTime: '2026-10-21T00:00:00', timeZone: 'UTC' });
  assert.equal(dueFromGraph({ dateTime: '2026-10-21T00:00:00.0000000', timeZone: 'UTC' }), '2026-10-21');
  assert.equal(dueFromGraph(null), null);
});

test('recurrence mapping', () => {
  const w = recurrenceToGraph({ type: 'weekly', interval: 2 }, '2026-10-21');
  assert.equal(w.pattern.type, 'weekly');
  assert.deepEqual(w.pattern.daysOfWeek, ['wednesday']);
  assert.equal(w.range.startDate, '2026-10-21');
  const m = recurrenceToGraph({ type: 'monthly', interval: 1 }, '2026-10-21');
  assert.equal(m.pattern.type, 'absoluteMonthly');
  assert.equal(m.pattern.dayOfMonth, 21);
  assert.deepEqual(recurrenceFromGraph(m), { type: 'monthly', interval: 1 });
  assert.equal(recurrenceToGraph(null, '2026-10-21'), null);
});

test('taskFromGraph reads the open extension', () => {
  const t = taskFromGraph({
    id: 'T1', title: 'Run', status: 'notStarted', importance: 'normal',
    body: { content: '<p>Easy</p>', contentType: 'html' },
    extensions: [{ id: 'Microsoft.OutlookServices.OpenTypeExtension.io.geterdone.task', extensionName: 'io.geterdone.task', project: 'Health', goalType: 'quantity', target: 40, unit: 'km', progress: 12 }],
  }, 'L1');
  assert.equal(t.listId, 'L1');
  assert.equal(t.description, 'Easy');
  assert.equal(t.meta.project, 'Health');
  assert.equal(t.metaExists, true);
  const bare = taskFromGraph({ id: 'T2', title: 'x', status: 'completed' }, 'L1');
  assert.equal(bare.metaExists, false);
  assert.equal(bare.status, 'completed');
});

test('patchToGraph only sends edited fields and keeps recurrence tied to due', () => {
  assert.deepEqual(patchToGraph({ title: 'A' }), { title: 'A' });
  const p = patchToGraph({ due: '2026-10-22' }, { recurrence: { type: 'daily', interval: 1 } });
  assert.equal(p.recurrence.range.startDate, '2026-10-22');
  assert.equal(patchToGraph({ due: null }, { recurrence: { type: 'daily', interval: 1 } }).recurrence, null);
  assert.equal(metaToExtension({ project: '', goalType: 'none', target: 0, unit: '', progress: 0, results: 0 }).extensionName, 'io.geterdone.task');
});
