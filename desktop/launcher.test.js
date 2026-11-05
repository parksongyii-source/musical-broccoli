import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'onhyu-desktop-'));
  const dist = join(directory, 'dist');
  const data = join(directory, 'data');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Onhyu desktop fixture</title>');
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  function launch({ defaultPort = false } = {}) {
    const env = { ...process.env, ONHYU_DATA_DIR: data, ONHYU_DIST_DIR: dist, ONHYU_NO_BROWSER: '1', ONHYU_PORT: '0' };
    if (defaultPort) delete env.ONHYU_PORT;
    const child = spawn(process.execPath, ['desktop/launcher.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Desktop readiness timeout: ${stdout}\n${stderr}`)), 8000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/ONHYU_(READY|REUSED) (\{[^\n]+\})/);
        if (match) { clearTimeout(timer); resolve({ mode: match[1], ...JSON.parse(match[2]) }); }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (!stdout.includes('ONHYU_READY ') && !stdout.includes('ONHYU_REUSED ')) reject(new Error(`Desktop exited ${code}: ${stderr}\n${stdout}`));
      });
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    return { child, ready, exited };
  }
  return { directory, data, launch };
}

async function json(url, path, options) {
  const response = await fetch(url + path, options);
  return { response, body: await response.json() };
}

test('standalone serves bundled screen with a clean database and rejects cross-origin or wrong-host requests', async t => {
  const f = await fixture(t);
  const { ready } = f.launch();
  const { url } = await ready;
  const html = await fetch(url).then(r => r.text());
  assert.match(html, /Onhyu desktop fixture/);
  const snapshot = await json(url, '/api/bootstrap?asOf=2026-11-05');
  assert.equal(snapshot.response.status, 200);
  assert.deepEqual(snapshot.body.employees, []);
  const info = await json(url, '/api/desktop-info');
  assert.equal(info.body.standalone, true);
  assert.equal(info.body.dataDirectory, f.data);
  assert.match(info.body.quitToken, /^[a-f0-9]{64}$/);
  const foreign = await json(url, '/api/desktop-info', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(foreign.response.status, 403);
  const rebind = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/bootstrap`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(rebind, 403);
  const own = await json(url, '/api/desktop-info', { headers: { Origin: url } });
  assert.equal(own.response.status, 200);
});

test('quitting requires its session token, responds successfully, and removes the instance lock', async t => {
  const f = await fixture(t);
  const running = f.launch();
  const { url } = await running.ready;
  const missing = await json(url, '/api/desktop-quit', { method: 'POST' });
  assert.equal(missing.response.status, 403);
  const malformed = await json(url, '/api/desktop-quit', { method: 'POST', headers: { 'X-Onhyu-Token': 'a'.repeat(63) + 'é' } });
  assert.equal(malformed.response.status, 403);
  const { body: info } = await json(url, '/api/desktop-info');
  const quit = await json(url, '/api/desktop-quit', { method: 'POST', headers: { 'X-Onhyu-Token': info.quitToken, Origin: url } });
  assert.equal(quit.response.status, 200);
  assert.deepEqual(quit.body, { ok: true });
  assert.equal(await running.exited, 0);
  await assert.rejects(readFile(join(f.data, 'instance.json')), { code: 'ENOENT' });
});

test('second launch opens the existing instance and saved staff survive a complete restart', async t => {
  const f = await fixture(t);
  const first = f.launch();
  const original = await first.ready;
  const created = await json(original.url, '/api/employees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '저장 직원', department: '운영팀', joinDate: '2024-07-12', annualAllowance: 18, asOf: '2026-11-05' }),
  });
  assert.equal(created.response.status, 201);
  const duplicate = f.launch();
  const reused = await duplicate.ready;
  assert.equal(reused.mode, 'REUSED');
  assert.equal(reused.url, original.url);
  assert.equal(await duplicate.exited, 0);
  let info = await json(original.url, '/api/desktop-info');
  await json(original.url, '/api/desktop-quit', { method: 'POST', headers: { 'X-Onhyu-Token': info.body.quitToken } });
  assert.equal(await first.exited, 0);
  const second = f.launch();
  const restarted = await second.ready;
  assert.equal(restarted.mode, 'READY');
  const snapshot = await json(restarted.url, '/api/bootstrap?asOf=2026-11-05');
  assert.equal(snapshot.body.employees.length, 1);
  assert.equal(snapshot.body.employees[0].name, '저장 직원');
  assert.equal(snapshot.body.employees[0].annualAllowance, 18);
});

test('an occupied default port falls back to an available loopback port', async t => {
  const occupied = createServer((_req, res) => res.end('different application'));
  let owned = false;
  await new Promise((resolve, reject) => {
    occupied.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    occupied.listen(50577, '127.0.0.1', () => { owned = true; resolve(); });
  });
  t.after(() => owned ? new Promise(resolve => occupied.close(resolve)) : undefined);
  const f = await fixture(t);
  const { url } = await f.launch({ defaultPort: true }).ready;
  assert.notEqual(new URL(url).port, '50577');
  assert.equal((await json(url, '/api/desktop-info')).body.standalone, true);
});

test('a stale instance lock is recovered when its port is free even if its PID has been reused', async t => {
  const f = await fixture(t);
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const free = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await mkdir(f.data);
  await writeFile(join(f.data, 'instance.json'), JSON.stringify({ application: 'onhyu-leave-manager', pid: process.pid, port: free, instanceId: 'stale-instance' }));
  const { url, mode } = await f.launch().ready;
  assert.equal(mode, 'READY');
  const info = await json(url, '/api/desktop-info');
  assert.equal(info.body.standalone, true);
  assert.notEqual(info.body.instanceId, 'stale-instance');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
