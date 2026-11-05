import { build } from 'esbuild';
import { inject } from 'postject';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This packaging tool runs in the Linux cloud build environment. It produces
// Windows executables too; users of those executables need no Node installation.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = new Set(['win-x64', 'linux-x64']);
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const targetArgument = process.argv.slice(2).find(argument => argument.startsWith('--target='));
const target = targetArgument?.slice('--target='.length) || 'win-x64';
if (!TARGETS.has(target) || process.argv.slice(2).some(argument => !argument.startsWith('--target='))) {
  throw new Error('Usage: node scripts/package-desktop.mjs [--target=win-x64|linux-x64]');
}
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Run the packager on Linux x64. The generated Windows executable runs on Windows x64.');
}
if (!/^v24\.\d+\.\d+$/.test(process.version)) throw new Error('Packaging requires Node.js 24.');

const version = process.version;
const packageInfo = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const outputRoot = join(ROOT, 'out');
const cache = join(outputRoot, 'cache', version);
const buildDirectory = join(outputRoot, `build-${target}`);
const distribution = join(outputRoot, `onhyu-${target}`);
await Promise.all([cache, buildDirectory, distribution].map(path => mkdir(path, { recursive: true })));

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

async function exists(path) {
  try { await readFile(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function download(url, destination) {
  if (await exists(destination)) return;
  const temporary = `${destination}.download-${process.pid}`;
  try {
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '30', '--proto', '=https', '--proto-redir', '=https', '--output', temporary, url]);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const archiveName = `node-${version}-${target}.${target === 'win-x64' ? 'zip' : 'tar.xz'}`;
const officialBase = `https://nodejs.org/dist/${version}`;
const checksumFile = join(cache, 'SHASUMS256.txt');
const archive = join(cache, archiveName);
await download(`${officialBase}/SHASUMS256.txt`, checksumFile);
await download(`${officialBase}/${archiveName}`, archive);
const checksumLine = (await readFile(checksumFile, 'utf8')).split(/\r?\n/).find(line => line.trim().split(/\s+/)[1] === archiveName);
if (!checksumLine) throw new Error(`No official checksum found for ${archiveName}.`);
const expectedChecksum = checksumLine.trim().split(/\s+/)[0];
const actualChecksum = createHash('sha256').update(await readFile(archive)).digest('hex');
if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || actualChecksum !== expectedChecksum) {
  throw new Error(`SHA-256 verification failed for ${archiveName}; no executable will be produced.`);
}
console.log(`Official Node archive SHA-256 verified: ${archiveName}`);

const extractionDirectory = join(buildDirectory, 'node-runtime');
await mkdir(extractionDirectory, { recursive: true });
if (target === 'win-x64') run('unzip', ['-q', '-o', archive, '-d', extractionDirectory]);
else run('tar', ['-xJf', archive, '-C', extractionDirectory]);
const runtimeRoot = join(extractionDirectory, `node-${version}-${target}`);
const runtime = join(runtimeRoot, target === 'win-x64' ? 'node.exe' : 'bin/node');
const executable = join(distribution, target === 'win-x64' ? 'Onhyu.exe' : 'onhyu');
await copyFile(runtime, executable);
await copyFile(join(runtimeRoot, 'LICENSE'), join(distribution, 'NODE-LICENSE.txt'));

const noticeSections = new Map();
async function collectPackageNotices(modulesDirectory) {
  let entries;
  try { entries = await readdir(modulesDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = join(modulesDirectory, entry.name);
    if (entry.name.startsWith('@')) { await collectPackageNotices(directory); continue; }
    let metadata;
    try { metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const key = `${metadata.name}@${metadata.version}`;
    if (!noticeSections.has(key)) {
      const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:$|[.\-_])/i.test(name)).sort();
      const contents = [];
      for (const name of licenses) {
        try { contents.push(`--- ${name} ---\n${await readFile(join(directory, name), 'utf8')}`); }
        catch (error) { if (error.code !== 'EISDIR') throw error; }
      }
      noticeSections.set(key, `${key}\nLicense metadata: ${JSON.stringify(metadata.license ?? 'See package notices')}\n${contents.join('\n')}`);
    }
    await collectPackageNotices(join(directory, 'node_modules'));
  }
}
await collectPackageNotices(join(ROOT, 'node_modules'));
await writeFile(join(distribution, 'THIRD-PARTY-NOTICES.txt'), [
  'Onhyu third-party package notices',
  'This distribution includes the following open source components. Notices for build-only components may also be included. The Node.js runtime and its dependencies have a separate NODE-LICENSE.txt.',
  ...[...noticeSections].sort(([a], [b]) => a < b ? -1 : 1).map(([, content]) => content),
].join('\n\n============================================================\n\n'));

// A modified Node executable cannot retain Node's original Authenticode signature.
// Clear the PE certificate directory before injecting the application. We do not
// change or bypass the checksum used to authenticate the original archive above.
if (target === 'win-x64') {
  let binary = await readFile(executable);
  if (binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a Windows PE executable.');
  const pe = binary.readUInt32LE(0x3c);
  if (binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Expected an x64 PE executable.');
  const optionalHeader = pe + 24;
  if (binary.readUInt16LE(optionalHeader) !== 0x20b) throw new Error('Expected a PE32+ optional header.');
  const certificateDirectory = optionalHeader + 112 + 4 * 8;
  const certificateOffset = binary.readUInt32LE(certificateDirectory);
  const certificateSize = binary.readUInt32LE(certificateDirectory + 4);
  binary.writeUInt32LE(0, certificateDirectory);
  binary.writeUInt32LE(0, certificateDirectory + 4);
  if (certificateOffset > 0 && certificateOffset + certificateSize === binary.length) binary = binary.subarray(0, certificateOffset);
  await writeFile(executable, binary);
}

const bundledScript = join(buildDirectory, 'launcher.cjs');
await build({
  absWorkingDir: ROOT,
  entryPoints: ['desktop/launcher.js'],
  outfile: bundledScript,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  minify: false,
  define: { ONHYU_BUNDLED: 'true', ONHYU_VERSION: JSON.stringify(packageInfo.version), 'import.meta.url': '__onhyu_module_url' },
  banner: { js: 'var __onhyu_module_url = require("node:url").pathToFileURL(process.execPath).href;' },
});

const assets = {};
async function collectAssets(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in application assets: ${path}`);
    if (entry.isDirectory()) await collectAssets(path, `${prefix}/${entry.name}`);
    else if (entry.isFile()) assets[`${prefix}/${entry.name}`] = path;
  }
}
await collectAssets(join(ROOT, 'dist'), 'dist');
if (!assets['dist/index.html']) throw new Error('Build the frontend with npm run build before packaging.');
const buildInfo = { version: packageInfo.version, nodeVersion: version, target };
const buildInfoFile = join(buildDirectory, 'build-info.json');
await writeFile(buildInfoFile, JSON.stringify(buildInfo, null, 2));
assets['build-info.json'] = buildInfoFile;
const blob = join(buildDirectory, 'sea-prep.blob');
const configuration = join(buildDirectory, 'sea-config.json');
await writeFile(configuration, JSON.stringify({ main: bundledScript, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }, null, 2));
run(process.execPath, ['--experimental-sea-config', configuration]);
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: FUSE });
if (!(await readFile(executable)).includes(Buffer.from(`${FUSE}:1`))) throw new Error('Executable SEA injection was not confirmed.');
if (target === 'linux-x64') await chmod(executable, 0o755);
await writeFile(join(distribution, 'build-info.json'), JSON.stringify({ ...buildInfo, officialNodeArchiveSHA256: actualChecksum, applicationSHA256: createHash('sha256').update(await readFile(executable)).digest('hex'), signed: false }, null, 2));
console.log(`Packaged ${target}: ${executable}`);
console.log('This application is unsigned. Windows builds must be validated on Windows before release.');
