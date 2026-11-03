const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the shipped Host logic; replace only ESM bindings and the helper URL.
const filename = path.join(__dirname, '..', 'index.js');
const source = fs.readFileSync(filename, 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/^const HELPER_PATH = .*$/m, "const HELPER_PATH = '/mock/helper'");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ available = true } = {}) {
  const routes = new Map();
  const cleanups = [];
  const commands = [];
  const stats = [];
  const statWaiters = new Map();
  let spawns = 0;
  let terminations = 0;
  const scope = {
    Response,
    console,
    homedir: () => '/mock',
    join: path.join,
    appendFileSync() {},
    mkdirSync() {},
    readFileSync() { throw new Error('No saved settings'); },
    writeFileSync() {},
    statSync: () => ({ isFile: () => true, mode: 0o755 }),
  };
  vm.createContext(scope);
  vm.runInContext(`${source}\nthis.apply = apply;`, scope, { filename });
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    connection: { fetch: { register(route) {
      routes.set(route.path, route.fetch);
      return () => routes.delete(route.path);
    } } },
    sessionController: { workspaceDesktop: () => ({ available }) },
    sandboxPolicy: { workspaceRoot: '/mock' },
    sessionQuery: { async readEvent({ sessionId, seq, before, after }, signal) {
      assert.equal(sessionId, 'session');
      assert.equal(before, 0);
      assert.equal(after, 0);
      assert.ok(signal instanceof AbortSignal);
      return {
        target: { type: 'deliverables/presented', data: { files: [{ path: `${seq}.png` }] } },
        session: { cwd: '/mock' },
      };
    } },
    workspaceFiles: { stat(coordinates, file, signal) {
      assert.equal(coordinates.sessionId, 'session');
      assert.equal(coordinates.workspaceRoot, '/mock');
      assert.ok(signal instanceof AbortSignal);
      const pending = deferred();
      const call = { file, resolve: pending.resolve };
      stats.push(call);
      statWaiters.get(stats.length)?.resolve(call);
      // Deliberately ignore abort: the Host must check again before sending.
      return pending.promise;
    } },
    subprocess: { spawn(options) {
      assert.deepEqual(Array.from(options.argv), ['/mock/helper']);
      assert.equal(options.stdio.stdin, 'pipe');
      spawns++;
      return {
        stdin: { write(line) { commands.push(JSON.parse(line)); }, once() {} },
        done: new Promise(() => {}),
        terminate() { terminations++; },
      };
    } },
  };
  scope.apply(ctx);
  const fetch = routes.get('/api/quicklook.preview');
  assert.equal(typeof fetch, 'function');
  return {
    fetch,
    commands,
    stats,
    get spawns() { return spawns; },
    get terminations() { return terminations; },
    waitForStat(number = 1) {
      if (stats.length >= number) return Promise.resolve(stats[number - 1]);
      const waiting = deferred();
      statWaiters.set(number, waiting);
      return waiting.promise;
    },
    dispose() { for (const cleanup of cleanups.toReversed()) cleanup(); },
  };
}

function request(body, signal) {
  return new Request('http://localhost/api/quicklook.preview', {
    method: 'POST', body: JSON.stringify(body), signal,
  });
}

const preview = (seq = 1) => ({ action: 'toggle', sessionId: 'session', seq, index: 0 });
const commandNames = (h) => h.commands.map(({ cmd }) => cmd);

// Both methods retain their actual Request semantics. Gates control precisely
// which body-reading await pauses, without timers or assuming a microtask count.
function delayedRequest(body, phase) {
  const original = request(body);
  const entered = deferred();
  const release = deferred();
  const calls = [];
  return {
    entered: entered.promise,
    release: release.resolve,
    calls,
    request: {
      signal: original.signal,
      clone() {
        calls.push('clone');
        const clone = original.clone();
        return { async json() {
          calls.push('clone.json');
          if (phase === 'clone') { entered.resolve(); await release.promise; }
          return clone.json();
        } };
      },
      async json() {
        calls.push('json');
        if (phase === 'body') { entered.resolve(); await release.promise; }
        return original.json();
      },
    },
  };
}

test('pending preview followed by hide returns 499 and never sends toggle', async () => {
  const h = harness();
  const opening = h.fetch(request(preview()));
  const stat = await h.waitForStat();
  const hidden = await h.fetch(request({ action: 'hide' }));
  assert.equal(hidden.status, 200);
  assert.deepEqual(await hidden.json(), { hidden: true });
  stat.resolve({ absolutePath: '/mock/1.png' });
  assert.equal((await opening).status, 499);
  assert.deepEqual(commandNames(h), ['hide']);
  assert.equal(h.spawns, 1);
});

test('dispose during pending preview cancels it without resurrecting helper', async () => {
  const h = harness();
  const opening = h.fetch(request(preview()));
  const stat = await h.waitForStat();
  h.dispose();
  stat.resolve({ absolutePath: '/mock/1.png' });
  assert.equal((await opening).status, 499);
  assert.deepEqual(commandNames(h), ['quit']);
  assert.equal(h.spawns, 1);
  assert.equal(h.terminations, 1);
  assert.equal((await h.fetch(request(preview(2)))).status, 499);
  assert.equal(h.spawns, 1);
});

test('A/B resolve in reverse order: only the newer B sends a preview', async () => {
  const h = harness();
  const a = h.fetch(request(preview(1)));
  const statA = await h.waitForStat(1);
  const b = h.fetch(request(preview(2)));
  const statB = await h.waitForStat(2);
  statB.resolve({ absolutePath: '/mock/2.png' });
  const responseB = await b;
  assert.equal(responseB.status, 200);
  assert.deepEqual(await responseB.json(), { previewing: true, path: '/mock/2.png' });
  statA.resolve({ absolutePath: '/mock/1.png' });
  assert.equal((await a).status, 499);
  assert.deepEqual(commandNames(h), ['toggle']);
  assert.equal(h.commands[0].path, '/mock/2.png');
});

test('abort during stat prevents send even when the service still resolves', async () => {
  const h = harness();
  const controller = new AbortController();
  const opening = h.fetch(request(preview(), controller.signal));
  const stat = await h.waitForStat();
  controller.abort();
  stat.resolve({ absolutePath: '/mock/1.png' });
  assert.equal((await opening).status, 499);
  assert.deepEqual(h.commands, []);
  assert.equal(h.spawns, 1);
});

test('focus succeeds without file coordinates', async () => {
  const h = harness();
  const response = await h.fetch(request({ action: 'focus' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { focused: true });
  assert.deepEqual(commandNames(h), ['focus']);
  assert.equal(h.stats.length, 0);
});

test('focus with unavailable desktop returns 409 without spawning', async () => {
  const h = harness({ available: false });
  assert.equal((await h.fetch(request({ action: 'focus' }))).status, 409);
  assert.deepEqual(h.commands, []);
  assert.equal(h.spawns, 0);
});

test('unknown action returns 400 before file resolution or send', async () => {
  const h = harness();
  const response = await h.fetch(request({ ...preview(), action: 'surprise' }));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Unknown action.');
  assert.deepEqual(h.commands, []);
  assert.equal(h.stats.length, 0);
});

for (const phase of ['clone', 'body']) {
  for (const olderAction of ['toggle', 'hide']) {
    test(`earlier ${olderAction} with slow ${phase} JSON cannot override a newer preview`, async () => {
      const h = harness();
      const slow = delayedRequest({ ...preview(1), action: olderAction }, phase);
      const older = h.fetch(slow.request);
      await slow.entered;
      const newer = h.fetch(request(preview(2)));
      const stat = await h.waitForStat();
      assert.equal(stat.file, '2.png');
      stat.resolve({ absolutePath: '/mock/2.png' });
      assert.equal((await newer).status, 200);
      slow.release();
      assert.equal((await older).status, 499);
      assert.deepEqual(slow.calls, ['clone', 'clone.json', 'json']);
      assert.deepEqual(commandNames(h), ['toggle']);
      assert.equal(h.commands[0].path, '/mock/2.png');
      assert.equal(h.stats.length, 1);
    });
  }
}
