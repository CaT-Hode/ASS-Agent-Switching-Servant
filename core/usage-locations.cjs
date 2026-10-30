// Locate native usage files; paths stay in the encrypted cache, never the UI.
const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
const { displayPath, pathKey } = require('./conversation-paths.cjs');
const CLIENTS = ['codex', 'claude', 'pi'];
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache',
  'dist', 'build', 'release', 'target', 'coverage', 'tests', 'test', 'fixtures', 'qa']);
const distroOf = dir => /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)/i.exec(dir)?.[1];
const execute = (file, args, encoding = 'utf8') => new Promise((resolve, reject) =>
  execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 ** 2, encoding },
    (error, stdout) => error ? reject(error) : resolve(stdout)));

function projectPaths(codexDirs) {
  const projects = [];
  for (const dir of codexDirs) try {
    const file = path.join(dir, '.codex-global-state.json');
    if (fs.statSync(file).size > 16 * 1024 ** 2) continue;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    projects.push(...(state['electron-saved-workspace-roots'] || []),
      ...Object.values(state['local-projects'] || {}).flatMap(p => p.rootPaths || []));
  } catch {}
  return projects.map(p => displayPath(p).replace(/^UNC\\/i, '\\\\')).filter(p => path.isAbsolute(p));
}

// A project may give its config directory any name. Recognize the native
// transcript header instead of assuming names such as .claude-state or scratch.
function sessionClient(dir, budget = { left: 40 }) {
  if (--budget.left < 0) return '';
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const client = sessionClient(file, budget); if (client) return client;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      let fd;
      try {
        fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(65536);
        const head = buffer.subarray(0, fs.readSync(fd, buffer)).toString('utf8');
        for (const line of head.split('\n')) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (row.type === 'session_meta') return 'codex';
          if (row.type === 'session') return 'pi';
          if (row.sessionId && ['user', 'assistant', 'queue-operation', 'file-history-snapshot'].includes(row.type)) return 'claude';
        }
      } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  return '';
}

async function projectRoots(projects, home) {
  const roots = [], seen = new Set(), queue = []; let partial = false;
  const enqueue = (dir, depth) => {
    const key = pathKey(dir); if (seen.has(key)) return; seen.add(key);
    if (queue.length >= 30000 || depth > 16) { partial = true; return; }
    queue.push({ dir, depth });
  };
  // A selected project is a scan boundary. Never turn a home/drive selection
  // into an automatic crawl of every application or mounted filesystem.
  for (const project of projects) {
    if (!path.isAbsolute(project) || pathKey(project) === pathKey(home) || path.parse(project).root === path.resolve(project)) continue;
    try { if (fs.lstatSync(project).isSymbolicLink()) continue; } catch { continue; }
    enqueue(project, 0);
  }
  // Directory reads overlap on the filesystem worker pool; no project walk runs
  // on the Electron UI thread. Batches also keep large repositories bounded.
  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + 32);
    offset += batch.length;
    const lists = await Promise.all(batch.map(async ({ dir }) => {
      try { return await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') partial = true; return []; }
    }));
    for (let index = 0; index < batch.length; index++) for (const entry of lists[index]) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP.has(entry.name.toLowerCase())) continue;
      const { dir, depth } = batch[index], child = path.join(dir, entry.name);
      if (['projects', 'sessions', 'archived_sessions'].includes(entry.name)) {
        const client = sessionClient(child);
        if (client) { roots.push({ client, dir }); continue; }
      }
      enqueue(child, depth + 1);
    }
  }
  return { roots, partial };
}

async function discover(options, previous = {}, run = execute) {
  const roots = [...(previous.roots || [])];
  const projects = [...(previous.projects || []), ...(options.projects || [])];
  const homes = new Set([pathKey(options.home)]);
  const running = new Set(), unavailable = new Set(); let partial = false;
  if (options.discover) {
    projects.push(...projectPaths(options.codexRoots || []));
    if (process.platform === 'win32') {
      try {
        const listing = await run('wsl.exe', ['--list', '--running', '--quiet'], 'buffer');
        for (const name of Buffer.isBuffer(listing) ? listing.toString('utf16le').replaceAll('\0', '').split(/\r?\n/) : listing.split(/\r?\n/))
          if (name.trim()) running.add(name.trim());
        const helper = fs.readFileSync(path.join(__dirname, 'usage-locations.py'), 'utf8');
        // Only running distributions are inspected. A refresh never boots WSL.
        for (const distro of running) try {
          const found = JSON.parse(await run('wsl.exe', ['-d', distro, '--exec', 'python3', '-c', helper]));
          roots.push(...found.roots); projects.push(...found.projects);
          for (const home of found.homes || []) homes.add(pathKey(home));
          partial ||= found.partial;
        } catch { unavailable.add(distro); partial = true; }
      } catch { if (roots.some(r => distroOf(r.dir))) partial = true; }
    }
  }
  let scannedAt = previous.scannedAt || 0, projectPartial = previous.projectPartial || false;
  if (options.discover || options.projects?.length) {
    const activeProjects = projects.filter(p => typeof p === 'string' && !homes.has(pathKey(p)) &&
      (!distroOf(p) || running.has(distroOf(p)) && !unavailable.has(distroOf(p))));
    const prior = new Set((previous.projects || []).map(pathKey)), now = options.now || Date.now();
    if (!options.automatic || now - scannedAt >= 10 * 60000 || activeProjects.some(p => !prior.has(pathKey(p)))) {
      const found = await projectRoots(activeProjects, options.home);
      roots.push(...found.roots); scannedAt = now; projectPartial = found.partial;
    }
    partial ||= projectPartial;
  }
  const unique = new Map();
  for (const root of roots) if (CLIENTS.includes(root.client) && typeof root.dir === 'string' && path.isAbsolute(root.dir))
    unique.set(root.client + '\0' + pathKey(root.dir) + '\0' + !!root.sessionDir, root);
  const saved = { roots: [...unique.values()], projects: [...new Map(projects.filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => [pathKey(p), p])).values()], scannedAt, projectPartial };
  const active = saved.roots.filter(r => {
    const distro = distroOf(r.dir);
    if (!distro || !options.discover || running.has(distro) && !unavailable.has(distro)) return true;
    unavailable.add(distro); return false;
  });
  return { saved, roots: active, unavailable, partial };
}
module.exports = { discover, projectPaths, projectRoots, distroOf };
