import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMeta, percent, progressLabel, formatAmount, makeResult, withResults, safeUrl, normalizeEvidence, sortResults,
} from '../site/js/goals.js';

test('normalizeMeta rejects junk and clamps', () => {
  assert.deepEqual(normalizeMeta(null), { project: '', goalType: 'none', target: 0, unit: '', progress: 0, results: 0 });
  const m = normalizeMeta({ project: '  Work ', goalType: 'bogus', target: -5, progress: '12.5', results: 3.7 });
  assert.equal(m.project, 'Work');
  assert.equal(m.goalType, 'none');
  assert.equal(m.target, 0);
  assert.equal(m.progress, 12.5);
  assert.equal(m.results, 3);
});

test('percent and labels per goal type', () => {
  const count = normalizeMeta({ goalType: 'count', target: 100, progress: 60 });
  assert.equal(percent(count), 60);
  assert.equal(progressLabel(count), '60 reps of 100 reps');
  const time = normalizeMeta({ goalType: 'time', target: 120, progress: 150 });
  assert.equal(percent(time), 100);
  assert.equal(progressLabel(time), '2h 30m of 2h');
  const qty = normalizeMeta({ goalType: 'quantity', target: 40, unit: 'km', progress: 12.5 });
  assert.equal(formatAmount(12.5, qty), '12.5 km');
  assert.equal(percent(normalizeMeta({ goalType: 'count', target: 0 })), 0);
});

test('results add toward progress', () => {
  const meta = normalizeMeta({ goalType: 'count', target: 50 });
  const rs = [makeResult({ amount: 20 }), makeResult({ amount: '5' }), makeResult({ amount: 0, note: 'rest day' })];
  const m = withResults(meta, rs);
  assert.equal(m.progress, 25);
  assert.equal(m.results, 3);
  assert.throws(() => makeResult({ amount: -1 }));
  assert.throws(() => makeResult({ amount: 'abc' }));
});

test('results sort newest first', () => {
  const a = makeResult({ amount: 1, at: '2026-01-01T00:00:00Z' });
  const b = makeResult({ amount: 1, at: '2026-02-01T00:00:00Z' });
  assert.deepEqual(sortResults([a, b]).map((r) => r.id), [b.id, a.id]);
});

test('only http(s) evidence links survive', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(normalizeEvidence({ kind: 'link', url: 'data:text/html,hi' }), null);
  assert.deepEqual(normalizeEvidence({ kind: 'attachment', attachmentId: 'abc', name: 'p.jpg' }), { kind: 'attachment', attachmentId: 'abc', name: 'p.jpg' });
});
