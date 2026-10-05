'use strict';
/**
 * Mission Control — tableau de bord du VPS.
 *
 * Zéro dépendance : Node lit l'API Docker (via docker-socket-proxy, en lecture
 * seule) et les métriques de l'hôte (/proc, /sys montés en lecture seule),
 * vérifie la disponibilité des sites et sert une SPA statique.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

const PORT = Number(process.env.PORT) || 3000;
const DOCKER_HOST = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';
const HOST_PROC = process.env.HOST_PROC || '/proc';
const HOST_SYS = process.env.HOST_SYS || '/sys';
const HOST_ETC = process.env.HOST_ETC || '/etc';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HOST_TICK_MS = 5_000;
const DOCKER_TICK_MS = 5_000;
const CHECK_TICK_MS = 60_000;
const HISTORY_POINTS = 120; // 10 min à 5 s
const CHECK_POINTS = 90; // 1 h 30 à 1 min
const EVENT_LIMIT = 100;

// ---------------------------------------------------------------------------
// API Docker
// ---------------------------------------------------------------------------
const dockerTarget = DOCKER_HOST.startsWith('unix://')
  ? { socketPath: DOCKER_HOST.slice('unix://'.length) }
  : (() => {
      const u = new URL(DOCKER_HOST.replace(/^tcp:/, 'http:'));
      return { host: u.hostname, port: Number(u.port) || 2375 };
    })();

function docker(apiPath, { raw = false, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...dockerTarget, path: apiPath, method: 'GET', timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          return reject(new Error(`Docker API ${res.statusCode} sur ${apiPath}`));
        }
        if (raw) return resolve(body);
        try {
          resolve(body.length ? JSON.parse(body) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API timeout sur ${apiPath}`)));
    req.on('error', reject);
    req.end();
  });
}

/** Les logs Docker (sans TTY) sont multiplexés : en-tête de 8 octets par trame. */
function demuxLogs(buf) {
  if (buf.length < 8 || buf[0] > 2 || buf[1] || buf[2] || buf[3]) return buf.toString('utf8');
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

// ---------------------------------------------------------------------------
// Métriques de l'hôte
// ---------------------------------------------------------------------------
const readText = (p) => fsp.readFile(p, 'utf8');
const pushCapped = (arr, v, max) => {
  arr.push(v);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

const host = {
  info: { hostname: '', os: '', kernel: '' },
  cpu: { pct: 0, cores: 0, load: [0, 0, 0] },
  mem: { total: 0, used: 0, pct: 0 },
  swap: { total: 0, used: 0, pct: 0 },
  disk: { total: 0, used: 0, pct: 0 },
  net: { rx: 0, tx: 0 },
  uptime: 0,
  history: { t: [], cpu: [], mem: [], rx: [], tx: [] },
};
const prev = { cpu: null, net: null };

async function readHostInfo() {
  const [hostname, osRelease, kernel] = await Promise.all([
    readText(path.join(HOST_ETC, 'hostname')).catch(() => require('node:os').hostname()),
    readText(path.join(HOST_ETC, 'os-release')).catch(() => ''),
    readText(path.join(HOST_PROC, 'sys/kernel/osrelease')).catch(() => ''),
  ]);
  const pretty = osRelease.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
  host.info = { hostname: hostname.trim(), os: pretty ? pretty[1] : 'Linux', kernel: kernel.trim() };
}

function parseCpu(stat) {
  const lines = stat.split('\n');
  const v = lines[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return {
    idle: v[3] + (v[4] || 0),
    total: v.reduce((a, b) => a + (b || 0), 0),
    cores: lines.filter((l) => /^cpu\d+/.test(l)).length,
  };
}

function parseMeminfo(txt) {
  const m = {};
  for (const line of txt.split('\n')) {
    const [k, v] = line.split(':');
    if (v) m[k.trim()] = parseInt(v, 10) * 1024;
  }
  return m;
}

async function readNetCounters() {
  const base = path.join(HOST_SYS, 'class/net');
  let rx = 0;
  let tx = 0;
  for (const iface of await fsp.readdir(base)) {
    if (iface === 'lo' || /^(docker|br-|veth)/.test(iface)) continue;
    try {
      rx += Number(await readText(path.join(base, iface, 'statistics/rx_bytes')));
      tx += Number(await readText(path.join(base, iface, 'statistics/tx_bytes')));
    } catch {
      /* interface disparue entre-temps */
    }
  }
  return { rx, tx, t: Date.now() };
}

async function sampleHost() {
  const [stat, meminfo, loadavg, uptime] = await Promise.all([
    readText(path.join(HOST_PROC, 'stat')),
    readText(path.join(HOST_PROC, 'meminfo')),
    readText(path.join(HOST_PROC, 'loadavg')),
    readText(path.join(HOST_PROC, 'uptime')),
  ]);

  const cpu = parseCpu(stat);
  if (prev.cpu) {
    const dTotal = cpu.total - prev.cpu.total;
    const dIdle = cpu.idle - prev.cpu.idle;
    host.cpu.pct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
  }
  prev.cpu = cpu;
  host.cpu.cores = cpu.cores;
  host.cpu.load = loadavg.split(' ').slice(0, 3).map(Number);
  host.uptime = Math.floor(Number(uptime.split(' ')[0]));

  const m = parseMeminfo(meminfo);
  const memUsed = m.MemTotal - (m.MemAvailable ?? m.MemFree);
  host.mem = { total: m.MemTotal, used: memUsed, pct: (memUsed / m.MemTotal) * 100 };
  const swapUsed = (m.SwapTotal || 0) - (m.SwapFree || 0);
  host.swap = { total: m.SwapTotal || 0, used: swapUsed, pct: m.SwapTotal ? (swapUsed / m.SwapTotal) * 100 : 0 };

  try {
    // statfs sur un fichier monté depuis l'hôte => stats du disque racine de l'hôte
    const s = await fsp.statfs(process.env.HOST_DISK_PATH || path.join(HOST_ETC, 'hostname'));
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    host.disk = { total, used, pct: (used / (used + avail)) * 100 };
  } catch {
    /* pas de statfs disponible */
  }

  try {
    const net = await readNetCounters();
    if (prev.net) {
      const dt = (net.t - prev.net.t) / 1000;
      host.net = {
        rx: Math.max(0, (net.rx - prev.net.rx) / dt),
        tx: Math.max(0, (net.tx - prev.net.tx) / dt),
      };
    }
    prev.net = net;
  } catch {
    /* /sys indisponible */
  }

  const h = host.history;
  pushCapped(h.t, Date.now(), HISTORY_POINTS);
  pushCapped(h.cpu, Math.round(host.cpu.pct * 10) / 10, HISTORY_POINTS);
  pushCapped(h.mem, Math.round(host.mem.pct * 10) / 10, HISTORY_POINTS);
  pushCapped(h.rx, Math.round(host.net.rx), HISTORY_POINTS);
  pushCapped(h.tx, Math.round(host.net.tx), HISTORY_POINTS);
}

// ---------------------------------------------------------------------------
// Conteneurs & projets
// ---------------------------------------------------------------------------
const dockerState = { ok: false, error: '', info: null, containers: [], stats: new Map() };

function cpuPercent(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  return sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
}

function memUsage(s) {
  const ms = s.memory_stats || {};
  const st = ms.stats || {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  return { used: Math.max(0, (ms.usage || 0) - cache), limit: ms.limit || 0 };
}

async function sampleDocker() {
  try {
    const [info, containers] = await Promise.all([docker('/info'), docker('/containers/json?all=1')]);
    const running = containers.filter((c) => c.State === 'running');
    // stream=false (sans one-shot) : Docker attend ~1 s pour fournir precpu_stats
    const stats = await Promise.all(
      running.map((c) => docker(`/containers/${c.Id}/stats?stream=false`, { timeout: 8_000 }).catch(() => null)),
    );
    const map = new Map();
    running.forEach((c, i) => {
      if (!stats[i]) return;
      const mem = memUsage(stats[i]);
      map.set(c.Id, { cpu: cpuPercent(stats[i]), mem: mem.used, memLimit: mem.limit });
    });
    Object.assign(dockerState, { ok: true, error: '', info, containers, stats: map });
  } catch (err) {
    Object.assign(dockerState, { ok: false, error: err.message });
  }
}

function extractUrls(labels) {
  const urls = new Set();
  for (const [key, value] of Object.entries(labels)) {
    if (!/^traefik\.http\.routers\.[^.]+\.rule$/.test(key)) continue;
    for (const host of value.matchAll(/Host\(([^)]*)\)/g)) {
      for (const h of host[1].matchAll(/[`"']([^`"']+)[`"']/g)) urls.add(`https://${h[1]}`);
    }
  }
  for (const u of (labels['mc.url'] || '').split(',')) if (u.trim()) urls.add(u.trim());
  return [...urls];
}

function healthOf(status) {
  if (/\(healthy\)/.test(status)) return 'healthy';
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/health: starting/.test(status)) return 'starting';
  return '';
}

function buildProjects() {
  const projects = new Map();
  for (const c of dockerState.containers) {
    const L = c.Labels || {};
    if (L['mc.hidden'] === 'true') continue;
    const key = L['com.docker.compose.project'] || '_standalone';
    if (!projects.has(key)) {
      projects.set(key, {
        id: key,
        name: key === '_standalone' ? 'Conteneurs isolés' : key,
        description: '',
        icon: '',
        repo: '',
        system: false,
        workingDir: '',
        urls: new Set(),
        services: [],
      });
    }
    const p = projects.get(key);
    if (L['mc.name'] && p.name === key) p.name = L['mc.name'];
    p.description ||= L['mc.description'] || '';
    p.icon ||= L['mc.icon'] || '';
    p.repo ||= L['mc.repo'] || '';
    p.system ||= L['mc.system'] === 'true';
    p.workingDir ||= L['com.docker.compose.project.working_dir'] || '';
    for (const u of extractUrls(L)) p.urls.add(u);

    const st = dockerState.stats.get(c.Id);
    const exitedOk = c.State === 'exited' && /^Exited \(0\)/.test(c.Status);
    p.services.push({
      id: c.Id.slice(0, 12),
      name: L['com.docker.compose.service'] || c.Names[0].replace(/^\//, ''),
      container: c.Names[0].replace(/^\//, ''),
      image: c.Image.replace(/@sha256:.*/, ''),
      state: exitedOk ? 'completed' : c.State,
      status: c.Status,
      health: healthOf(c.Status),
      created: c.Created * 1000,
      cpu: st ? Math.round(st.cpu * 10) / 10 : null,
      mem: st ? st.mem : null,
      memLimit: st ? st.memLimit : null,
    });
  }

  return [...projects.values()]
    .map((p) => {
      const urls = [...p.urls];
      const svc = p.services;
      const running = svc.filter((s) => s.state === 'running');
      const failing = svc.filter((s) => !['running', 'completed'].includes(s.state) || s.health === 'unhealthy');
      const urlDown = urls.some((u) => checks[u]?.last && !checks[u].last.ok);
      let status = 'up';
      if (!running.length) status = 'down';
      else if (failing.length || urlDown) status = 'degraded';
      else if (svc.some((s) => s.health === 'starting')) status = 'starting';
      return {
        ...p,
        urls,
        status,
        running: running.length,
        total: svc.length,
        cpu: Math.round(running.reduce((a, s) => a + (s.cpu || 0), 0) * 10) / 10,
        mem: running.reduce((a, s) => a + (s.mem || 0), 0),
        since: Math.min(...svc.map((s) => s.created)),
        services: svc.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.system - b.system || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Journal d'activité (événements Docker)
// ---------------------------------------------------------------------------
const events = [];
const seenEvents = new Set();
let eventCursor = Math.floor(Date.now() / 1000) - 24 * 3600;
const INTERESTING = /^(create|start|restart|die|stop|kill|oom|destroy|pause|unpause|health_status)/;

async function pollEvents() {
  const until = Math.floor(Date.now() / 1000);
  const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
  const raw = await docker(`/events?since=${eventCursor - 1}&until=${until}&filters=${filters}`, {
    raw: true,
    timeout: 15_000,
  });
  eventCursor = until;
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!INTERESTING.test(e.Action || '')) continue;
    const key = `${e.timeNano}|${e.Actor?.ID}|${e.Action}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const a = e.Actor?.Attributes || {};
    if (a['mc.hidden'] === 'true') continue;
    events.push({
      t: Math.floor(Number(e.timeNano) / 1e6) || e.time * 1000,
      action: e.Action,
      name: a.name || '',
      project: a['com.docker.compose.project'] || '',
      service: a['com.docker.compose.service'] || '',
      exitCode: a.exitCode,
    });
  }
  events.sort((a, b) => a.t - b.t);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  if (seenEvents.size > 5_000) seenEvents.clear();
}

// ---------------------------------------------------------------------------
// Vérification de disponibilité des sites
// ---------------------------------------------------------------------------
const CHECKS_FILE = path.join(DATA_DIR, 'checks.json');
let checks = {};
try {
  checks = JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8'));
} catch {
  checks = {};
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    let req;
    try {
      req = https.request(url, {
        method: 'GET',
        timeout: 10_000,
        headers: { 'user-agent': 'MissionControl/1.0 (uptime check)' },
      });
    } catch (err) {
      return resolve({ ok: false, code: 0, ms: 0, error: err.message });
    }
    req.on('response', (res) => {
      res.resume();
      // 401/403 = le site répond (il est juste protégé) => en ligne
      resolve({ ok: res.statusCode < 500, code: res.statusCode, ms: elapsed() });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (err) => resolve({ ok: false, code: 0, ms: elapsed(), error: err.code || err.message }));
    req.end();
  });
}

async function runChecks() {
  const urls = new Set(buildProjects().flatMap((p) => p.urls));
  await Promise.all(
    [...urls].map(async (url) => {
      const r = await checkUrl(url);
      const entry = (checks[url] ||= { history: [] });
      entry.last = { ...r, t: Date.now() };
      pushCapped(entry.history, { t: Date.now(), ok: r.ok, ms: r.ms }, CHECK_POINTS);
    }),
  );
  for (const url of Object.keys(checks)) if (!urls.has(url)) delete checks[url];
  fsp.mkdir(DATA_DIR, { recursive: true })
    .then(() => fsp.writeFile(CHECKS_FILE, JSON.stringify(checks)))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Boucles
// ---------------------------------------------------------------------------
function loop(name, fn, every) {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[${name}]`, err.message);
    }
    setTimeout(run, every).unref?.();
  };
  run();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function snapshot() {
  const info = dockerState.info || {};
  const checkView = {};
  for (const [url, c] of Object.entries(checks)) {
    const okCount = c.history.filter((h) => h.ok).length;
    checkView[url] = {
      last: c.last,
      uptime: c.history.length ? (okCount / c.history.length) * 100 : null,
      history: c.history.slice(-40),
    };
  }
  return {
    generatedAt: Date.now(),
    domain: process.env.DOMAIN || '',
    host,
    docker: {
      ok: dockerState.ok,
      error: dockerState.error,
      version: info.ServerVersion || '',
      containers: info.Containers || 0,
      running: info.ContainersRunning || 0,
      images: info.Images || 0,
    },
    projects: buildProjects(),
    checks: checkView,
    events: events.slice(-50).reverse(),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const sendJson = (res, data, code = 200) => send(res, code, JSON.stringify(data), 'application/json');

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const body = await fsp.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (url.pathname === '/api/health') return sendJson(res, { ok: true });
    if (url.pathname === '/api/state') return sendJson(res, snapshot());

    const logs = url.pathname.match(/^\/api\/containers\/([a-f0-9]{12,64})\/logs$/);
    if (logs) {
      const tail = Math.min(2000, Math.max(10, Number(url.searchParams.get('tail')) || 300));
      const buf = await docker(`/containers/${logs[1]}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`, {
        raw: true,
      });
      return send(res, 200, demuxLogs(buf), 'text/plain; charset=utf-8');
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404);
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error('[http]', err.message);
    sendJson(res, { error: err.message }, 500);
  }
});

readHostInfo().catch(() => {});
loop('host', sampleHost, HOST_TICK_MS);
loop('docker', sampleDocker, DOCKER_TICK_MS);
loop('events', pollEvents, DOCKER_TICK_MS);
setTimeout(() => loop('checks', runChecks, CHECK_TICK_MS), 8_000);

server.listen(PORT, () => console.log(`Mission Control en écoute sur :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
