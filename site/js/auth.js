// Authorization code + PKCE against Microsoft identity, written by hand.
// No auth library from a CDN: a third-party script would have access to the token.
import { CLIENT_ID, AUTHORITY, SCOPES, redirectUri } from './config.js';

const KEY = 'tg-auth';
const PKCE = 'tg-pkce';
const STATE = 'tg-state';
const RETURN = 'tg-return';

function b64url(bytes) {
  const s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function challenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// Tokens are kept in localStorage so the app survives a new tab. SPA refresh
// tokens from Microsoft live 24 hours, after which sign-in is interactive again.
function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function save(token) {
  const now = Date.now();
  const s = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || (load() || {}).refresh_token,
    id_token: token.id_token || (load() || {}).id_token,
    expires_at: now + (Number(token.expires_in) || 3600) * 1000,
  };
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export function isSignedIn() {
  const s = load();
  return !!(s && (s.refresh_token || s.expires_at > Date.now()));
}

export function account() {
  const s = load();
  if (!s || !s.id_token) return null;
  try {
    const part = s.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(decodeURIComponent(escape(atob(part))));
    return { name: claims.name || '', username: claims.preferred_username || claims.email || '' };
  } catch { return null; }
}

export async function signIn({ prompt } = {}) {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(PKCE, verifier);
  sessionStorage.setItem(STATE, state);
  sessionStorage.setItem(RETURN, location.pathname + location.search);
  const q = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(),
    response_mode: 'query', scope: SCOPES, state,
    code_challenge: await challenge(verifier), code_challenge_method: 'S256',
  });
  if (prompt) q.set('prompt', prompt);
  location.assign(AUTHORITY + '/oauth2/v2.0/authorize?' + q.toString());
}

async function tokenRequest(params) {
  const r = await fetch(AUTHORITY + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || 'token endpoint returned ' + r.status);
  return j;
}

// Runs on /oauth2/spa/callback/. Returns the path to go back to.
export async function handleCallback() {
  const q = new URLSearchParams(location.search);
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
  const code = q.get('code');
  const expected = sessionStorage.getItem(STATE);
  const verifier = sessionStorage.getItem(PKCE);
  if (!code) throw new Error('No authorization code in the redirect.');
  if (!expected || q.get('state') !== expected) throw new Error('State mismatch. Sign-in was not completed.');
  if (!verifier) throw new Error('The PKCE verifier is missing from this tab. Start sign-in again in the same tab.');
  sessionStorage.removeItem(STATE);
  sessionStorage.removeItem(PKCE);
  save(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }));
  const back = sessionStorage.getItem(RETURN) || '/';
  sessionStorage.removeItem(RETURN);
  return back.startsWith('/') && !back.startsWith('//') ? back : '/';
}

export class NeedSignIn extends Error {}

let refreshing = null;
export async function accessToken() {
  const s = load();
  if (!s) throw new NeedSignIn('not signed in');
  if (s.access_token && s.expires_at - 60000 > Date.now()) return s.access_token;
  if (!s.refresh_token) throw new NeedSignIn('session expired');
  refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token })
    .then(save)
    .catch((e) => { localStorage.removeItem(KEY); throw new NeedSignIn(e.message); })
    .finally(() => { refreshing = null; });
  return (await refreshing).access_token;
}

export function signOut() {
  localStorage.removeItem(KEY);
  const q = new URLSearchParams({ post_logout_redirect_uri: location.origin + '/' });
  location.assign(AUTHORITY + '/oauth2/v2.0/logout?' + q.toString());
}
