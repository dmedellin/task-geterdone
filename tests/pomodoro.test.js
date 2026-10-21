import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../site/js/pomodoro.js';

const S = P.normalizeSettings({});

test('defaults are 25/5/15 with a long break every 4', () => {
  assert.deepEqual([S.focus, S.short, S.long, S.every], [25, 5, 15, 4]);
  assert.equal(P.normalizeSettings({ focus: 0, every: 99 }).focus, 25);
  assert.equal(P.normalizeSettings({ focus: 50 }).focus, 50);
});

test('cycle: focus, short x3, then long', () => {
  let s = P.initialState(S);
  const phases = [];
  for (let i = 0; i < 8; i++) {
    s = P.advance(s, S, 0, { completed: true });
    phases.push(s.phase);
  }
  assert.deepEqual(phases, ['short', 'focus', 'short', 'focus', 'short', 'focus', 'long', 'focus']);
  assert.equal(s.completedFocus, 4);
});

test('skipping a focus phase does not count it', () => {
  const s = P.advance(P.initialState(S), S, 0, { completed: false });
  assert.equal(s.phase, 'short');
  assert.equal(s.completedFocus, 0);
});

test('time is computed from an absolute end, pause keeps the remainder', () => {
  let s = P.start(P.initialState(S), 1000);
  assert.equal(P.remaining(s, 1000 + 60000), 24 * 60000);
  s = P.pause(s, 1000 + 60000);
  assert.equal(P.remaining(s, 9e12), 24 * 60000);
  s = P.start(s, 5000);
  assert.equal(s.endsAt, 5000 + 24 * 60000);
});

test('focus minutes for logging', () => {
  let s = P.start(P.initialState(S), 0);
  assert.equal(P.focusMinutes(s, S, 25 * 60000), 25);
  assert.equal(P.focusMinutes(s, S, 10 * 60000 + 20000), 10);
  s = P.setPhase(s, 'short', S);
  assert.equal(P.focusMinutes(s, S, 0), 0);
});

test('clock format', () => {
  assert.equal(P.formatClock(25 * 60000), '25:00');
  assert.equal(P.formatClock(59001), '01:00');
  assert.equal(P.formatClock(0), '00:00');
});
