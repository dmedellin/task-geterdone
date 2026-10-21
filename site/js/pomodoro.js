// Pomodoro state machine. Pure functions over a plain state object, plus a
// tiny persistence helper; the DOM driver lives in app.js.
// Time is always computed from an absolute end timestamp, so a backgrounded
// or reloaded tab never drifts.

export const DEFAULT_SETTINGS = {
  focus: 25, short: 5, long: 15, every: 4,
  autoStart: false, sound: true, notify: true,
};

export const PHASE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const k of ['focus', 'short', 'long']) {
      const n = Math.round(Number(raw[k]));
      if (Number.isFinite(n) && n >= 1 && n <= 180) s[k] = n;
    }
    const e = Math.round(Number(raw.every));
    if (Number.isFinite(e) && e >= 1 && e <= 12) s.every = e;
    for (const k of ['autoStart', 'sound', 'notify']) if (typeof raw[k] === 'boolean') s[k] = raw[k];
  }
  return s;
}

export function initialState(settings) {
  return { phase: 'focus', running: false, endsAt: 0, remainingMs: settings.focus * 60000, completedFocus: 0, startedAt: 0 };
}

export function durationMs(phase, settings) {
  return settings[phase] * 60000;
}

export function remaining(state, now) {
  return state.running ? Math.max(0, state.endsAt - now) : state.remainingMs;
}

export function start(state, now) {
  if (state.running) return state;
  return { ...state, running: true, endsAt: now + state.remainingMs, startedAt: state.startedAt || now };
}

export function pause(state, now) {
  if (!state.running) return state;
  return { ...state, running: false, remainingMs: Math.max(0, state.endsAt - now), endsAt: 0 };
}

export function reset(state, settings) {
  return { ...state, running: false, endsAt: 0, startedAt: 0, remainingMs: durationMs(state.phase, settings) };
}

export function phaseAfter(state, settings) {
  if (state.phase !== 'focus') return 'focus';
  const done = state.completedFocus + 1;
  return done % settings.every === 0 ? 'long' : 'short';
}

// Move to the next phase. `completed` is true when the timer ran out (as
// opposed to a skip), which is what counts a focus session.
export function advance(state, settings, now, { completed }) {
  const countFocus = completed && state.phase === 'focus';
  const next = phaseAfter(state, settings);
  const s = {
    phase: next,
    running: false, endsAt: 0, startedAt: 0,
    remainingMs: durationMs(next, settings),
    completedFocus: state.completedFocus + (countFocus ? 1 : 0),
  };
  return settings.autoStart ? start(s, now) : s;
}

// Minutes actually spent in a focus phase, for logging toward a time goal.
export function focusMinutes(state, settings, now) {
  if (state.phase !== 'focus') return 0;
  const spent = durationMs('focus', settings) - remaining(state, now);
  return Math.max(0, Math.round(spent / 60000));
}

export function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function setPhase(state, phase, settings) {
  return { ...state, phase, running: false, endsAt: 0, startedAt: 0, remainingMs: durationMs(phase, settings) };
}
