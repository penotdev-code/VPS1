'use strict';

const REFRESH_MS = 5000;
const $ = (sel) => document.querySelector(sel);

const ui = {
  data: null,
  filter: 'all',
  query: '',
  showSystem: readPref('showSystem', true),
  logs: { id: null, timer: null, text: '' },
};

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`mc.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(`mc.${key}`, JSON.stringify(value));
  } catch {
    /* stockage indisponible */
  }
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtBytes(b, digits = 1) {
  if (!b || b < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? digits : 0)} ${units[i]}`;
}
const fmtRate = (b) => `${fmtBytes(b)}/s`;
const pct = (v) => `${Math.round(v ?? 0)}%`;

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

function timeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

const ERRORS = {
  ENOTFOUND: 'DNS introuvable',
  ECONNREFUSED: 'connexion refusée',
  ECONNRESET: 'connexion coupée',
  Timeout: 'délai dépassé',
  CERT_HAS_EXPIRED: 'certificat expiré',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat invalide',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificat invalide',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat invalide',
};
const errLabel = (last) => (last.error ? ERRORS[last.error] || last.error : `HTTP ${last.code}`);

const levelColor = (v) => (v >= 90 ? 'var(--red)' : v >= 70 ? 'var(--amber)' : null);

function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// ---------------------------------------------------------------------------
// Sparkline SVG
// ---------------------------------------------------------------------------
let gradId = 0;
function sparkline(series, { max, colors = ['var(--accent)'] } = {}) {
  const W = 300;
  const H = 40;
  const all = series.flat();
  if (all.length < 2) return '';
  const top = max ?? Math.max(1, ...all) * 1.15;
  const paths = series.map((values, si) => {
    const n = values.length;
    const pts = values.map((v, i) => [(i / (n - 1)) * W, H - 2 - (Math.min(v, top) / top) * (H - 4)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const id = `g${++gradId}`;
    const c = colors[si] || colors[0];
    return `
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c}" stop-opacity=".35"/><stop offset="1" stop-color="${c}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${line}L${W},${H}L0,${H}Z" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${c}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${paths.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Rendu : ressources
// ---------------------------------------------------------------------------
function renderStats(d) {
  const h = d.host;
  const hist = h.history;
  const cpuC = levelColor(h.cpu.pct) || 'var(--accent)';
  const memC = levelColor(h.mem.pct) || 'var(--accent-2)';
  const diskC = levelColor(h.disk.pct) || 'var(--green)';

  $('#stats').innerHTML = `
    <article class="stat" style="--c:${cpuC}">
      <div class="label"><i></i>Processeur</div>
      <div class="value">${pct(h.cpu.pct)}</div>
      <div class="detail">${h.cpu.cores} cœur${h.cpu.cores > 1 ? 's' : ''} · charge ${h.cpu.load.map((l) => l.toFixed(2)).join(' ')}</div>
      <div class="spark">${sparkline([hist.cpu], { max: 100, colors: [cpuC] })}</div>
    </article>
    <article class="stat" style="--c:${memC}">
      <div class="label"><i></i>Mémoire</div>
      <div class="value">${fmtBytes(h.mem.used)}<small>/ ${fmtBytes(h.mem.total)}</small></div>
      <div class="detail">${pct(h.mem.pct)} utilisés${h.swap.total ? ` · swap ${fmtBytes(h.swap.used)}` : ''}</div>
      <div class="spark">${sparkline([hist.mem], { max: 100, colors: [memC] })}</div>
    </article>
    <article class="stat" style="--c:${diskC}">
      <div class="label"><i></i>Disque</div>
      <div class="value">${pct(h.disk.pct)}</div>
      <div class="detail">${fmtBytes(h.disk.used)} sur ${fmtBytes(h.disk.total)} · ${fmtBytes(h.disk.total - h.disk.used)} libres</div>
      <div class="bar"><span style="width:${h.disk.pct.toFixed(1)}%"></span></div>
    </article>
    <article class="stat" style="--c:var(--blue)">
      <div class="label"><i></i>Réseau</div>
      <div class="value" style="font-size:20px;margin-top:10px">↓ ${fmtRate(h.net.rx)}</div>
      <div class="detail">↑ ${fmtRate(h.net.tx)}</div>
      <div class="spark">${sparkline([hist.rx, hist.tx], { colors: ['var(--blue)', 'var(--accent)'] })}</div>
    </article>
    <article class="stat" style="--c:var(--amber)">
      <div class="label"><i></i>Système</div>
      <dl class="kv">
        <dt>Uptime</dt><dd>${fmtDuration(h.uptime)}</dd>
        <dt>Docker</dt><dd>${d.docker.ok ? esc(d.docker.version) : '<span style="color:var(--red)">injoignable</span>'}</dd>
        <dt>Conteneurs</dt><dd>${d.docker.running} / ${d.docker.containers} actifs</dd>
        <dt>Images</dt><dd>${d.docker.images}</dd>
      </dl>
    </article>`;
}

// ---------------------------------------------------------------------------
// Rendu : projets
// ---------------------------------------------------------------------------
const STATUS = {
  up: { label: 'En ligne', c: 'var(--green)' },
  degraded: { label: 'Dégradé', c: 'var(--amber)' },
  starting: { label: 'Démarrage', c: 'var(--blue)' },
  down: { label: 'Arrêté', c: 'var(--red)' },
};

const STATE_FR = {
  completed: 'terminé',
  exited: 'arrêté',
  created: 'créé',
  restarting: 'redémarre',
  paused: 'en pause',
  dead: 'mort',
  removing: 'suppression',
};

/** "Up 2 hours (healthy)" -> "2 h" */
function upFor(status) {
  return status
    .replace(/^Up /, '')
    .replace(/ \(.*\)$/, '')
    .replace(/^Less than a second$/, '< 1 s')
    .replace(/^About a minute$/, '~1 min')
    .replace(/^About an hour$/, '~1 h')
    .replace(/(\d+) seconds?/, '$1 s')
    .replace(/(\d+) minutes?/, '$1 min')
    .replace(/(\d+) hours?/, '$1 h')
    .replace(/(\d+) days?/, '$1 j')
    .replace(/(\d+) weeks?/, '$1 sem')
    .replace(/(\d+) months?/, '$1 mois')
    .replace(/(\d+) years?/, (_, n) => `${n} an${n === '1' ? '' : 's'}`);
}

function svcColor(s) {
  if (s.state === 'completed') return 'var(--dim)';
  if (s.state !== 'running') return 'var(--red)';
  if (s.health === 'unhealthy') return 'var(--red)';
  if (s.health === 'starting') return 'var(--blue)';
  return 'var(--green)';
}

function renderUrl(url, check) {
  const hist = check?.history || [];
  const ticks = Array.from({ length: 30 }, (_, i) => {
    const h = hist[hist.length - 30 + i];
    return `<i class="${!h ? 'none' : h.ok ? '' : 'ko'}" title="${h ? `${new Date(h.t).toLocaleTimeString('fr-FR')} · ${h.ok ? `${h.ms} ms` : 'erreur'}` : ''}"></i>`;
  }).join('');
  const last = check?.last;
  let meta = '<span>vérification…</span>';
  if (last) {
    meta = last.ok
      ? `<span>${last.ms} ms</span>`
      : `<span style="color:var(--red)">${esc(errLabel(last))}</span>`;
    if (check.uptime != null) meta += `<span>${check.uptime.toFixed(check.uptime === 100 ? 0 : 1)}%</span>`;
  }
  return `
    <div class="url">
      <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))} ↗</a>
      <div class="meta">${meta}<div class="ticks">${ticks}</div></div>
    </div>`;
}

function renderProject(p, checks) {
  const st = STATUS[p.status] || STATUS.down;
  const avatar = p.icon ? esc(p.icon) : esc(p.name.slice(0, 1).toUpperCase());
  const services = p.services
    .map(
      (s) => `
      <tr>
        <td style="width:14px"><span class="dot" style="--c:${svcColor(s)}" title="${esc(s.status)}"></span></td>
        <td><div class="n">${esc(s.name)}</div><div class="img" title="${esc(s.image)}">${esc(s.image)}</div></td>
        <td class="num" title="${esc(s.status)}">${s.state === 'running' ? esc(upFor(s.status)) : esc(STATE_FR[s.state] || s.state)}</td>
        <td class="num">${s.cpu != null ? `${s.cpu.toFixed(1)}%` : '—'}</td>
        <td class="num">${s.mem != null ? fmtBytes(s.mem) : '—'}</td>
        <td style="width:46px;text-align:right"><button class="icon-btn" data-logs="${s.id}" data-name="${esc(s.container)}">logs</button></td>
      </tr>`,
    )
    .join('');

  return `
    <article class="card${p.system ? ' system' : ''}" style="--status-c:${st.c}">
      <div class="card-head">
        <div class="avatar" style="--h:${hue(p.id)}">${avatar}</div>
        <div class="card-title">
          <h3 title="${esc(p.name)}">${esc(p.name)}</h3>
          <p>${esc(p.description) || `<span class="path">${esc(p.workingDir || p.id)}</span>`}</p>
        </div>
        <span class="pill" style="--c:${st.c}">${st.label}</span>
      </div>
      ${p.urls.length ? `<div class="urls">${p.urls.map((u) => renderUrl(u, checks[u])).join('')}</div>` : ''}
      <table class="svc"><tbody>${services}</tbody></table>
      <div class="card-foot">
        <div class="chips">
          <span>${p.running}/${p.total} service${p.total > 1 ? 's' : ''}</span>
          <span>CPU ${p.cpu.toFixed(1)}%</span>
          <span>RAM ${fmtBytes(p.mem)}</span>
          <span title="${new Date(p.since).toLocaleString('fr-FR')}">créé ${timeAgo(p.since)}</span>
        </div>
        ${p.repo ? `<a href="${esc(p.repo)}" target="_blank" rel="noopener">Dépôt ↗</a>` : ''}
      </div>
    </article>`;
}

function renderProjects(d) {
  const q = ui.query.trim().toLowerCase();
  const list = d.projects.filter((p) => {
    if (!ui.showSystem && p.system) return false;
    if (ui.filter === 'up' && p.status !== 'up') return false;
    if (ui.filter === 'issues' && !['degraded', 'down'].includes(p.status)) return false;
    if (q && !`${p.name} ${p.description} ${p.urls.join(' ')} ${p.services.map((s) => s.name).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const userProjects = d.projects.filter((p) => !p.system);
  const issues = userProjects.filter((p) => ['degraded', 'down'].includes(p.status)).length;
  $('#project-count').textContent = `${userProjects.length}${issues ? ` · ${issues} à surveiller` : ''}`;

  if (!userProjects.length && !list.some((p) => !p.system)) {
    list.unshift(null);
  }
  $('#projects').innerHTML =
    list
      .map((p) =>
        p
          ? renderProject(p, d.checks)
          : `<div class="empty">
              <div class="big">🚀</div>
              <p><strong>Aucun projet déployé pour l'instant.</strong></p>
              <p>Sur le VPS : <code>./scripts/new-project.sh mon-app</code></p>
            </div>`,
      )
      .join('') || '<div class="empty">Aucun projet ne correspond au filtre.</div>';
}

// ---------------------------------------------------------------------------
// Rendu : activité & raccourcis
// ---------------------------------------------------------------------------
const EVENT_STYLE = {
  start: ['▶', 'var(--green)', 'démarré'],
  restart: ['↻', 'var(--blue)', 'redémarré'],
  create: ['+', 'var(--accent)', 'créé'],
  stop: ['■', 'var(--muted)', 'arrêté'],
  kill: ['■', 'var(--muted)', 'tué'],
  die: ['✕', 'var(--red)', 'terminé'],
  oom: ['!', 'var(--red)', 'mémoire saturée (OOM)'],
  destroy: ['−', 'var(--dim)', 'supprimé'],
  pause: ['❚❚', 'var(--amber)', 'en pause'],
  unpause: ['▶', 'var(--green)', 'repris'],
  health_status: ['♥', 'var(--blue)', 'santé'],
};

function renderEvents(d) {
  if (!d.events.length) {
    $('#feed').innerHTML = '<li><span></span><span class="muted">Rien à signaler.</span><span></span></li>';
    return;
  }
  $('#feed').innerHTML = d.events
    .slice(0, 40)
    .map((e) => {
      const kind = e.action.split(':')[0];
      let [icon, c, label] = EVENT_STYLE[kind] || ['•', 'var(--muted)', e.action];
      if (kind === 'health_status') {
        const v = e.action.split(':')[1]?.trim();
        label = v === 'healthy' ? 'en bonne santé' : v === 'unhealthy' ? 'en mauvaise santé' : v || 'santé';
        c = v === 'unhealthy' ? 'var(--red)' : v === 'healthy' ? 'var(--green)' : c;
      }
      if (kind === 'die' && e.exitCode === '0') c = 'var(--muted)';
      const who = e.project && e.service ? `${e.project}/${e.service}` : e.name;
      const code = kind === 'die' && e.exitCode ? ` (code ${esc(e.exitCode)})` : '';
      return `
        <li>
          <span class="ev" style="--c:${c}">${icon}</span>
          <span class="what"><b>${esc(who)}</b> <span>${esc(label)}${code}</span></span>
          <time title="${new Date(e.t).toLocaleString('fr-FR')}">${timeAgo(e.t)}</time>
        </li>`;
    })
    .join('');
}

function renderShortcuts(d) {
  if (!d.domain) {
    $('#shortcuts').innerHTML = '<span class="muted small">Définis DOMAIN pour afficher les raccourcis.</span>';
    return;
  }
  const links = [
    ['Dashboard Traefik', `https://traefik.${d.domain}`],
    ['Domaine principal', `https://${d.domain}`],
    ['Zone DNS OVH', 'https://www.ovh.com/manager/#/web/domain'],
    ['Manager VPS OVH', 'https://www.ovh.com/manager/#/dedicated/vps'],
  ];
  $('#shortcuts').innerHTML = links
    .map(([label, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} <span>↗</span></a>`)
    .join('');
}

function render() {
  const d = ui.data;
  if (!d) return;
  const h = d.host.info;
  $('#host-line').textContent = [h.hostname, h.os, h.kernel && `noyau ${h.kernel}`, d.domain].filter(Boolean).join(' · ');
  document.title = `Mission Control · ${h.hostname || d.domain || 'VPS'}`;
  renderStats(d);
  renderProjects(d);
  renderEvents(d);
  renderShortcuts(d);
}

// ---------------------------------------------------------------------------
// Rafraîchissement
// ---------------------------------------------------------------------------
function setLive(on, text) {
  $('#live').className = `live ${on ? 'on' : 'off'}`;
  $('#live-text').textContent = text;
}

async function refresh() {
  try {
    const res = await fetch('api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ui.data = await res.json();
    setLive(ui.data.docker.ok, ui.data.docker.ok ? 'En direct' : 'Docker injoignable');
    render();
  } catch {
    setLive(false, 'Hors ligne');
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
function paintLogs() {
  const filter = $('#logs-filter').value.trim().toLowerCase();
  const lines = ui.logs.text.split('\n').filter((l) => !filter || l.toLowerCase().includes(filter));
  const body = $('#logs-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML =
    lines
      .map((l) => {
        const m = l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/);
        const ts = m ? new Date(m[1]).toLocaleString('fr-FR') : '';
        const msg = m ? m[2] : l;
        const cls = /\b(error|err|fatal|panic|exception|critical)\b/i.test(msg)
          ? 'err'
          : /\b(warn|warning)\b/i.test(msg)
            ? 'warn'
            : '';
        return `${ts ? `<span class="ts">${esc(ts)}</span> ` : ''}<span class="${cls}">${esc(msg)}</span>`;
      })
      .join('\n') || '<span class="ts">(aucun log)</span>';
  if (atBottom || $('#logs-follow').checked) body.scrollTop = body.scrollHeight;
}

async function loadLogs() {
  if (!ui.logs.id) return;
  try {
    const res = await fetch(`api/containers/${ui.logs.id}/logs?tail=500`, { cache: 'no-store' });
    ui.logs.text = res.ok ? await res.text() : `Erreur HTTP ${res.status}`;
  } catch (err) {
    ui.logs.text = `Erreur : ${err.message}`;
  }
  paintLogs();
}

function openLogs(id, name) {
  ui.logs.id = id;
  ui.logs.text = '';
  $('#logs-title').textContent = name;
  $('#logs-sub').textContent = `conteneur ${id} · 500 dernières lignes`;
  $('#logs-body').innerHTML = '<span class="ts">Chargement…</span>';
  $('#logs').showModal();
  loadLogs();
  clearInterval(ui.logs.timer);
  ui.logs.timer = setInterval(() => $('#logs-follow').checked && loadLogs(), 3000);
}

function closeLogs() {
  clearInterval(ui.logs.timer);
  ui.logs.id = null;
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
$('#projects').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-logs]');
  if (btn) openLogs(btn.dataset.logs, btn.dataset.name);
});
$('#search').addEventListener('input', (e) => {
  ui.query = e.target.value;
  if (ui.data) renderProjects(ui.data);
});
$('#filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  ui.filter = btn.dataset.filter;
  document.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('on', b === btn));
  if (ui.data) renderProjects(ui.data);
});
$('#show-system').checked = ui.showSystem;
$('#show-system').addEventListener('change', (e) => {
  ui.showSystem = e.target.checked;
  writePref('showSystem', ui.showSystem);
  if (ui.data) renderProjects(ui.data);
});
$('#logs-close').addEventListener('click', () => $('#logs').close());
$('#logs').addEventListener('close', closeLogs);
$('#logs-refresh').addEventListener('click', loadLogs);
$('#logs-filter').addEventListener('input', paintLogs);

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('fr-FR');
}

tickClock();
setInterval(tickClock, 1000);
refresh();
setInterval(refresh, REFRESH_MS);
