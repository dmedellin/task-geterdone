import { handleCallback } from './auth.js';

const msg = document.getElementById('msg');
handleCallback()
  .then((back) => {
    localStorage.removeItem('tg-mode');
    history.replaceState({}, '', '/oauth2/spa/callback/');
    location.replace(back);
  })
  .catch((e) => {
    msg.textContent = 'Sign-in did not complete: ' + (e.message || e);
  });
