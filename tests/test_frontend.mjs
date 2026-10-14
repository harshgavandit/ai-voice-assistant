import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.textContent = '';
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.files = [];
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  scrollIntoView() {}
  remove() {}
  pause() { this.paused = true; }
  async play() { if (this.failPlay) throw new Error('autoplay blocked'); this.paused = false; }
}
async function fixture({ fetchError, denyMic, blockAutoplay } = {}) {
  const ids = ['chat','micBtn','audioFile','uploadLabel','clearBtn','demoBtn','status','connection','welcome'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const calls = [];
  let tracksStopped = 0;
  let recorder;
  let resolveMic;
  class FakeRecorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(stream, options) { this.stream = stream; this.mimeType = options?.mimeType; this.state = 'inactive'; recorder = this; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({data: new Blob(['recorded audio'], {type: this.mimeType})});
      queueMicrotask(() => this.onstop?.({}));
    }
  }
  const sandbox = {
    document: { getElementById: id => elements[id], createElement: tag => { const e = new Element(tag); if (tag === 'audio') e.failPlay = blockAutoplay; return e; } },
    crypto: webcrypto, Blob, FormData, AbortController, console,
    setTimeout: () => 1, clearTimeout: () => {},
    navigator: { mediaDevices: { getUserMedia: async () => {
      if (denyMic) { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; }
      if (resolveMic) await new Promise(resolve => { resolveMic = resolve; });
      return { getTracks: () => [{stop: () => tracksStopped++}] };
    } } },
    window: { MediaRecorder: FakeRecorder, addEventListener: () => {} }, MediaRecorder: FakeRecorder,
    fetch: async (url, options) => {
      calls.push({url, options});
      if (url === '/health') return {ok:true, json:async () => ({api_key_configured:true,model:'gpt-6-luna'})};
      if (url === '/demo.wav') return {ok:true, blob:async () => new Blob(['demo recording'])};
      return {ok:!fetchError, json:async () => fetchError ? {detail:'OpenAI API quota is exhausted.'} : {transcript:'Tell me a story on Mars.', response:'Maya met a robot.', audio_base64:'SUQz'}};
    },
  };
  vm.runInNewContext(source, sandbox);
  await settle();
  return {elements, calls, stopped: () => tracksStopped, getRecorder: () => recorder};
}
async function settle() { for (let i=0; i<8; i++) await new Promise(resolve => setImmediate(resolve)); }
async function click(element) { await element.listeners.click(); await settle(); }
const results = [];
async function test(name, body) { await body(); results.push(name); console.log(`PASS ${name}`); }
await test('demo runs full pipeline and renders audio', async () => {
  const f = await fixture();
  await click(f.elements.demoBtn);
  assert.equal(f.calls.at(-1).url, '/assistant');
  assert.equal(f.calls.at(-1).options.body.get('file').name, 'demo.wav');
  assert.equal(f.elements.chat.children[0].textContent, 'Tell me a story on Mars.');
  assert.equal(f.elements.chat.children[1].children[0].tagName, 'audio');
  assert.equal(f.elements.micBtn.disabled, false);
});
await test('recording sends final chunk and releases microphone', async () => {
  const f = await fixture();
  await click(f.elements.micBtn);
  assert.equal(f.elements.micBtn.textContent, 'Stop & send');
  assert.equal(f.elements.demoBtn.disabled, true);
  await click(f.elements.micBtn);
  assert.equal(f.stopped(), 1);
  assert.equal(f.calls.at(-1).options.body.get('file').name, 'speech.webm');
  assert.equal(f.elements.micBtn.textContent, 'Start recording');
});
await test('microphone permission failure is actionable and recoverable', async () => {
  const f = await fixture({denyMic:true});
  await click(f.elements.micBtn);
  assert.match(f.elements.status.textContent, /permission was denied/);
  assert.equal(f.elements.micBtn.disabled, false);
  assert.equal(f.calls.filter(c => c.url === '/assistant').length, 0);
});
await test('HTTP failure shows server detail and re-enables controls', async () => {
  const f = await fixture({fetchError:true});
  await click(f.elements.demoBtn);
  assert.match(f.elements.chat.children[1].textContent, /quota is exhausted/);
  assert.equal(f.elements.demoBtn.disabled, false);
  assert.equal(f.elements.micBtn.disabled, false);
});
await test('autoplay rejection retains manual playback control', async () => {
  const f = await fixture({blockAutoplay:true});
  await click(f.elements.demoBtn);
  assert.match(f.elements.status.textContent, /Press Play/);
  assert.equal(f.elements.chat.children[1].children[0].controls, true);
});
await test('new conversation resets session and pauses reply', async () => {
  const f = await fixture();
  await click(f.elements.demoBtn);
  const firstSession = f.calls.at(-1).options.body.get('session_id');
  const audio = f.elements.chat.children[1].children[0];
  await click(f.elements.clearBtn);
  assert.equal(f.elements.chat.children.length, 0);
  assert.equal(audio.paused, true);
  await click(f.elements.demoBtn);
  assert.notEqual(f.calls.at(-1).options.body.get('session_id'), firstSession);
});
await test('file upload uses the selected filename and rejects empty audio', async () => {
  const f = await fixture();
  const file = new Blob(['uploaded speech']);
  file.name = 'speech.mp3';
  f.elements.audioFile.files = [file];
  f.elements.audioFile.listeners.change();
  await settle();
  assert.equal(f.calls.at(-1).options.body.get('file').name, 'speech.mp3');
  const before = f.calls.length;
  const empty = new Blob([]); empty.name = 'empty.wav';
  f.elements.audioFile.files = [empty];
  f.elements.audioFile.listeners.change();
  await settle();
  assert.equal(f.calls.length, before);
  assert.match(f.elements.status.textContent, /empty/);
});
console.log(`${results.length} frontend regression checks passed.`);
