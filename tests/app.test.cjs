const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

const source = readFileSync(new URL('../app.js', `file://${__filename.replaceAll('\\', '/')}`), 'utf8');

function setup(fullscreenEnabled = true) {
  class Element {
    hidden = false;
    events = {};
    attributes = {};
    addEventListener(name, action) { this.events[name] = action; }
    click() { return this.events.click?.(); }
    focus() { this.focused = true; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.child = child; }
    remove() { this.removed = true; }
  }
  const elements = Object.fromEntries(['player-shell', 'stage', 'cover', 'load', 'close', 'reload', 'theater', 'fullscreen', 'status'].map(id => [id, new Element()]));
  const classes = new Set();
  const timers = new Map();
  let timerId = 0;
  const document = {
    fullscreenEnabled,
    querySelector: selector => elements[selector.slice(1)],
    createElement: () => new Element(),
    events: {},
    addEventListener(name, action) { this.events[name] = action; },
    body: { classList: {
      contains: name => classes.has(name),
      toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; },
    } },
  };
  runInNewContext(source, {
    document,
    setTimeout(action) { timers.set(++timerId, action); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { elements, document, timers };
}

test('initial page creates no Google iframe', () => {
  const { elements, timers } = setup();
  assert.equal(elements.stage.child, undefined);
  assert.equal(timers.size, 0);
});

test('click creates one titled preview without autoplay', () => {
  const { elements: e } = setup();
  e.load.click();
  const frame = e.stage.child;
  assert.equal(frame.src, 'https://drive.google.com/file/d/1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9/preview');
  assert.ok(frame.title.includes('SIPCOP'));
  assert.equal(frame.allow, 'fullscreen');
  assert.equal(e.cover.hidden, true);
  e.load.click();
  assert.equal(e.stage.child, frame);
});

test('frame load reports navigation, not confirmed video playback', () => {
  const { elements: e, timers } = setup();
  e.load.click();
  e.stage.child.events.load();
  assert.match(e.status.textContent, /Drive frame loaded/);
  assert.match(e.status.textContent, /If Drive shows an error/);
  assert.equal(timers.size, 0);
});

test('slow navigation gives an honest recovery hint', () => {
  const { elements: e, timers } = setup();
  e.load.click();
  [...timers.values()][0]();
  assert.match(e.status.textContent, /may still be loading/);
});

test('close removes the player, clears timers and restores keyboard focus', () => {
  const { elements: e, timers } = setup();
  e.load.click();
  const frame = e.stage.child;
  e.close.click();
  assert.equal(frame.removed, true);
  assert.equal(e.cover.hidden, false);
  assert.equal(e.close.hidden, true);
  assert.equal(e.reload.hidden, true);
  assert.equal(e.load.focused, true);
  assert.equal(timers.size, 0);
});

test('reload replaces the iframe instead of duplicating it', () => {
  const { elements: e, timers } = setup();
  e.load.click();
  const previous = e.stage.child;
  e.reload.click();
  assert.equal(previous.removed, true);
  assert.notEqual(e.stage.child, previous);
  assert.equal(timers.size, 1);
});

test('cinema exposes pressed state and Escape restores it', () => {
  const { elements: e, document } = setup();
  e.theater.click();
  assert.equal(e.theater.attributes['aria-pressed'], 'true');
  document.events.keydown({ key: 'Escape' });
  assert.equal(e.theater.attributes['aria-pressed'], 'false');
  assert.equal(e.theater.focused, true);
});

test('fullscreen is hidden when unsupported and denial has a fallback', async () => {
  assert.equal(setup(false).elements.fullscreen.hidden, true);
  const { elements: e } = setup();
  e['player-shell'].requestFullscreen = async () => { throw new Error('Denied'); };
  await e.fullscreen.click();
  assert.match(e.status.textContent, /Try Cinema mode/);
});
