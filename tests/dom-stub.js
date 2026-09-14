/* Minimal DOM/Canvas stub so main.js can run under Node for integration tests. */

const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient')
      return () => ({ addColorStop() {} });
    if (k === 'measureText') return () => ({ width: 10 });
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; }
});

function makeEl(tag) {
  const el = {
    tagName: tag, dataset: {}, style: {}, textContent: '', value: '',
    offsetWidth: 0, clientWidth: 1280, clientHeight: 720, width: 0, height: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    getContext() { return ctx2d; }, focus() {}, select() {}, setAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
  };
  return el;
}

const cache = new Map();
const q = (sel) => { if (!cache.has(sel)) cache.set(sel, makeEl('div')); return cache.get(sel); };

const winHandlers = new Map();

globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  body: makeEl('body'),
  head: makeEl('head'),
  querySelector: q,
  querySelectorAll: () => [],
  createElement: makeEl,
  addEventListener() {},
  execCommand() { return true; }
};
globalThis.navigator = { userAgent: 'node' };
globalThis.location = { origin: 'https://example.test', pathname: '/', search: '', href: 'https://example.test/' };
globalThis.history = { replaceState() {} };
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
globalThis.requestAnimationFrame = () => 0;   // the real loop is driven manually
globalThis.cancelAnimationFrame = () => {};
globalThis.crypto = globalThis.crypto || { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.Event = class { constructor(t) { this.type = t; } };

globalThis.addEventListener = (type, fn) => {
  if (!winHandlers.has(type)) winHandlers.set(type, []);
  winHandlers.get(type).push(fn);
};
globalThis.removeEventListener = () => {};

function fireKey(type, code) {
  (winHandlers.get(type) || []).forEach(fn =>
    fn({ code, repeat: false, key: code, preventDefault() {} }));
}

module.exports = { fireKey, q, winHandlers };
