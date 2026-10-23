'use strict';

const previewUrl = 'https://drive.google.com/file/d/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9/preview';
const shell = document.querySelector('#player-shell');
const stage = document.querySelector('#stage');
const cover = document.querySelector('#cover');
const load = document.querySelector('#load');
const close = document.querySelector('#close');
const reload = document.querySelector('#reload');
const theater = document.querySelector('#theater');
const fullscreen = document.querySelector('#fullscreen');
const status = document.querySelector('#status');
let frame = null;
let slowLoadTimer;

function loadPlayer() {
  if (frame) return;
  frame = document.createElement('iframe');
  frame.title = 'E. Monitoreo de SIPCOP Parte 4 — Google Drive video player';
  frame.allow = 'fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = previewUrl;
  status.textContent = 'Loading the Drive frame. Playback and access depend on Google Drive.';
  slowLoadTimer = setTimeout(() => {
    status.textContent = 'Taking a while? Check file sharing or open the original above. The frame may still be loading.';
  }, 15000);
  frame.addEventListener('load', () => {
    clearTimeout(slowLoadTimer);
    // A cross-origin load event confirms navigation, not playable media or access.
    status.textContent = 'Drive frame loaded. Press Play inside it. If Drive shows an error, check sharing or open the original.';
  }, { once: true });
  cover.hidden = true;
  close.hidden = false;
  reload.hidden = false;
  stage.append(frame);
  frame.focus();
}

function closePlayer(restoreFocus = true) {
  clearTimeout(slowLoadTimer);
  frame?.remove();
  frame = null;
  cover.hidden = false;
  close.hidden = true;
  reload.hidden = true;
  status.textContent = 'Player unloaded. Load the video again whenever you are ready.';
  if (restoreFocus) load.focus();
}

load.addEventListener('click', loadPlayer);
close.addEventListener('click', () => closePlayer());
reload.addEventListener('click', () => {
  closePlayer(false);
  loadPlayer();
});
theater.addEventListener('click', () => {
  const active = document.body.classList.toggle('cinema');
  theater.setAttribute('aria-pressed', String(active));
  theater.textContent = active ? 'Exit cinema' : 'Cinema mode';
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.fullscreenElement && document.body.classList.contains('cinema')) {
    theater.click();
    theater.focus();
  }
});
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen();
  } catch {
    status.textContent = 'Fullscreen is unavailable in this browser or context. Try Cinema mode instead.';
  }
});
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen ⛶';
});
