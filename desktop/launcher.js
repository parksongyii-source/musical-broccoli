import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getAsset, getAssetKeys, isSea } from 'node:sea';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'onhyu-leave-manager';
const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

export function dataDirectory() {
  if (process.env.ONHYU_DATA_DIR) return resolve(process.env.ONHYU_DATA_DIR);
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Onhyu');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Onhyu');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'onhyu');
}

function browser(url) {
  if (process.env.ONHYU_NO_BROWSER === '1') return;
  const [command, args] = platform() === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
  child.on('error', () => console.log(`브라우저 주소창에 ${url} 을 입력해 주세요.`));
  child.unref();
}

function webDirectory(directory) {
  if (!isSea()) {
    const dist = resolve(process.env.ONHYU_DIST_DIR || join(ROOT, 'dist'));
    if (!existsSync(join(dist, 'index.html'))) throw new Error('화면 파일을 찾을 수 없습니다. 프로그램 패키지를 다시 받아 주세요.');
    return dist;
  }
  const keys = getAssetKeys().filter(key => key.startsWith('dist/')).sort();
  if (!keys.includes('dist/index.html')) throw new Error('프로그램 안에 화면 파일이 없습니다.');
  const hash = createHash('sha256');
  const files = keys.map(key => {
    const name = key.slice(5);
    if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('잘못된 프로그램 파일 경로입니다.');
    const content = Buffer.from(getAsset(key));
    hash.update(key); hash.update(content);
    return { name, content };
  });
  const dist = join(directory, 'web', hash.digest('hex').slice(0, 16));
  mkdirSync(dist, { recursive: true });
  for (const { name, content } of files) {
    const destination = resolve(dist, name);
    const rel = relative(dist, destination);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('잘못된 프로그램 파일 경로입니다.');
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination) || !readFileSync(destination).equals(content)) writeFileSync(destination, content);
  }
  return dist;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function existingInstance(record, directory) {
  if (record?.application !== APP_ID || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) return null;
  const url = `http://127.0.0.1:${record.port}`;
  try {
    const response = await fetch(`${url}/api/desktop-info`, { signal: AbortSignal.timeout(600) });
    const info = await response.json();
    return info.application === APP_ID && info.dataDirectory === directory && info.instanceId === record.instanceId ? url : null;
  } catch { return null; }
}

async function freePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function lock(directory) {
  const path = join(directory, 'instance.json');
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const record = { application: APP_ID, pid: process.pid, port: null, instanceId: randomBytes(16).toString('hex') };
      function save() {
        ftruncateSync(fd, 0);
        writeSync(fd, JSON.stringify(record), 0, 'utf8');
        fsyncSync(fd);
      }
      save();
      let released = false;
      return {
        record,
        update(port) { record.port = port; save(); },
        release() {
          if (released) return;
          released = true;
          closeSync(fd);
          try {
            if (JSON.parse(readFileSync(path, 'utf8')).instanceId === record.instanceId) unlinkSync(path);
          } catch { /* A replaced or removed lock belongs to another instance. */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let record;
      try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { record = null; }
      const url = await existingInstance(record, directory);
      if (url) return { existingUrl: url };
      if (record && (!alive(record.pid) || await freePort(record.port))) {
        try {
          const current = JSON.parse(readFileSync(path, 'utf8'));
          if (current.instanceId === record.instanceId && current.pid === record.pid && current.port === record.port) unlinkSync(path);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (!record && attempt >= 10) {
        // Preserve a damaged lock for diagnosis instead of overwriting unknown contents.
        try { renameSync(path, `${path}.invalid-${Date.now()}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      await sleep(120);
    }
  }
  throw new Error('온휴가 시작 중이거나 이미 실행 중입니다. 잠시 후 다시 실행해 주세요.');
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function startDesktop() {
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const instance = await lock(directory);
  if (instance.existingUrl) {
    browser(instance.existingUrl);
    console.log(`ONHYU_REUSED ${JSON.stringify({ url: instance.existingUrl, dataDirectory: directory })}`);
    return null;
  }
  let app;
  let server;
  let stopping = false;
  let readyUrl;
  const quitToken = randomBytes(32).toString('hex');
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (server) {
      const timeout = setTimeout(() => server.closeAllConnections(), 1500);
      timeout.unref();
      await new Promise(resolve => server.close(resolve));
      clearTimeout(timeout);
    }
    app?.locals.close();
    instance.release();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
  try {
    const dist = webDirectory(directory);
    app = createApp({
      dbPath: join(directory, 'leave.sqlite'), seed: false, staticDir: dist,
      configureApp(app) {
        app.use((req, res, next) => {
          const port = server?.address()?.port;
          const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
          if (!hosts.has(req.headers.host)) return res.status(403).json({ error: '이 프로그램은 이 PC에서만 사용할 수 있습니다.' });
          if (req.headers.origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(req.headers.origin)) return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' });
          res.setHeader('X-Content-Type-Options', 'nosniff');
          next();
        });
        app.get('/api/desktop-info', (_req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          res.json({ standalone: true, application: APP_ID, quitToken, dataDirectory: directory, instanceId: instance.record.instanceId });
        });
        app.post('/api/desktop-quit', (req, res) => {
          const supplied = req.headers['x-onhyu-token'];
          if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(quitToken))) return res.status(403).json({ error: '프로그램 종료 확인에 실패했습니다.' });
          res.json({ ok: true });
          setImmediate(() => { void stop(); });
        });
      },
    });
    const requestedPort = process.env.ONHYU_PORT === undefined ? 50577 : Number(process.env.ONHYU_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('프로그램 포트 설정이 올바르지 않습니다.');
    try { server = await listen(app, requestedPort); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || requestedPort === 0 || process.env.ONHYU_PORT !== undefined) throw error;
      server = await listen(app, 0);
    }
    const port = server.address().port;
    readyUrl = `http://127.0.0.1:${port}`;
    instance.update(port);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log('온휴가 실행되었습니다. 브라우저에서 연차를 관리하세요.');
    console.log(`자료 저장 폴더: ${directory}`);
    console.log('화면의 프로그램 종료 버튼을 누르거나 이 창을 닫으면 종료됩니다.');
    console.log(`ONHYU_READY ${JSON.stringify({ url: readyUrl, dataDirectory: directory })}`);
    browser(readyUrl);
    return { app, server, stop, url: readyUrl, dataDirectory: directory };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (typeof ONHYU_BUNDLED !== 'undefined' || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  startDesktop().catch(error => {
    console.error(`온휴를 실행하지 못했습니다: ${error.message}`);
    process.exitCode = 1;
  });
}
