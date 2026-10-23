'use strict';

function createVideoControls({ video, isActive, description }) {
  const element = id => document.getElementById(id);
  const controls = element('custom-controls');
  const status = element('playback-status');
  const proof = element('playback-proof');
  const seek = element('seek');
  let played = false;
  let sought = false;
  let seekStart = null;
  let lastTime = null;
  function time(seconds) {
    const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }
  function updateProof() {
    proof.textContent = `Session evidence — playback advanced: ${played ? 'yes' : 'not yet'}; position changed after seek: ${sought ? 'yes' : 'not yet'}. ${description}`;
  }
  function sync() {
    element('play-pause').textContent = video.paused ? 'Play' : 'Pause';
    seek.value = String(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    seek.setAttribute('aria-valuetext', `${time(video.currentTime)} of ${time(video.duration)}`);
    element('time').textContent = `${time(video.currentTime)} / ${time(video.duration)}`;
    const silent = video.muted || video.volume === 0;
    element('mute').textContent = silent ? 'Unmute' : 'Mute';
    element('mute').setAttribute('aria-pressed', String(silent));
    element('volume').value = String(video.volume);
    element('speed').value = String(video.playbackRate);
  }
  function reset() {
    controls.disabled = true;
    controls.hidden = true;
    video.controls = true;
    played = false;
    sought = false;
    seekStart = null;
    lastTime = null;
    seek.max = '0';
    sync();
    updateProof();
  }
  function metadataReady() {
    if (!isActive()) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      status.textContent = 'Video duration is unavailable. Native controls remain enabled.';
      return;
    }
    seek.max = String(video.duration);
    controls.disabled = false;
    controls.hidden = false;
    video.controls = false;
    sync();
    status.textContent = 'Video metadata ready. Press Play to test playback.';
    element('play-pause').focus();
  }
  video.addEventListener('loadedmetadata', metadataReady);
  video.addEventListener('durationchange', () => {
    if (controls.disabled && Number.isFinite(video.duration) && video.duration > 0) metadataReady();
    else if (Number.isFinite(video.duration) && video.duration > 0) seek.max = String(video.duration);
  });
  element('play-pause').addEventListener('click', async () => {
    try { if (video.paused) await video.play(); else video.pause(); }
    catch { if (isActive()) status.textContent = 'Playback could not start. Try again or use the original viewer.'; }
  });
  function seekTo(value) {
    if (controls.disabled || !Number.isFinite(video.duration)) return;
    const next = Math.max(0, Math.min(video.duration, Number(value)));
    if (!Number.isFinite(next)) return;
    seekStart = video.currentTime;
    video.currentTime = next;
  }
  seek.addEventListener('input', () => seekTo(seek.value));
  element('back-ten').addEventListener('click', () => seekTo(video.currentTime - 10));
  element('forward-ten').addEventListener('click', () => seekTo(video.currentTime + 10));
  element('mute').addEventListener('click', () => {
    if (video.volume === 0) { video.volume = 1; video.muted = false; }
    else video.muted = !video.muted;
  });
  element('volume').addEventListener('input', event => { video.volume = Number(event.target.value); if (video.volume > 0) video.muted = false; });
  element('speed').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
  for (const name of ['play', 'pause', 'timeupdate', 'volumechange', 'ratechange', 'durationchange']) video.addEventListener(name, sync);
  video.addEventListener('playing', () => { lastTime = video.currentTime; if (isActive()) status.textContent = 'Playing.'; });
  video.addEventListener('seeking', () => { lastTime = null; });
  video.addEventListener('timeupdate', () => {
    if (isActive() && !video.paused && !video.seeking && seekStart === null) {
      if (lastTime !== null && video.currentTime > lastTime + 0.05) { played = true; updateProof(); }
      lastTime = video.currentTime;
    }
  });
  video.addEventListener('waiting', () => { if (isActive()) status.textContent = 'Waiting for media data or decoding.'; });
  video.addEventListener('pause', () => { if (isActive() && !video.ended) status.textContent = 'Paused.'; });
  video.addEventListener('ended', () => { if (isActive()) status.textContent = 'Playback ended.'; });
  video.addEventListener('seeked', () => {
    if (seekStart !== null && Math.abs(video.currentTime - seekStart) > 0.1) sought = true;
    seekStart = null;
    lastTime = video.currentTime;
    sync();
    updateProof();
    if (isActive()) status.textContent = video.paused ? 'Position changed. Press Play to continue.' : 'Position changed; playing.';
  });
  video.addEventListener('error', () => {
    if (!isActive()) return;
    controls.disabled = true;
    controls.hidden = true;
    video.controls = true;
    status.textContent = 'Video unavailable. Close this session and retry, or use the original Drive viewer.';
  });
  const fullscreen = element('native-fullscreen');
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await element('native-shell').requestFullscreen(); }
    catch { status.textContent = 'Fullscreen unavailable here. Cinema mode is still available.'; }
  });
  document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; });
  element('native-cinema').addEventListener('click', () => {
    const active = document.body.classList.toggle('native-cinema');
    element('native-cinema').setAttribute('aria-pressed', String(active));
    element('native-cinema').textContent = active ? 'Exit cinema' : 'Cinema mode';
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.fullscreenElement && document.body.classList.contains('native-cinema')) element('native-cinema').click();
  });
  return { reset };
}
