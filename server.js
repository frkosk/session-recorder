/*
 * Mini session recorder — server.js
 * Ingest + úložisko (SQLite) + privátny dashboard na prehrávanie.
 *
 * ENV premenné (nastav v Coolify):
 *   PORT            (default 3000)
 *   DATA_DIR        (default /data) — sem namontuj perzistentný volume (na SSD!)
 *   RETENTION_DAYS  (default 30) — staršie relácie sa automaticky mažú
 *   DASH_USER       (default admin)
 *   DASH_PASS       (POVINNÉ, min. 12 znakov) — heslo do dashboardu, inak server neštartne
 *   SITES           (POVINNÉ, min. 1 site s aspoň 1 originom) — inak server neštartne
 *                   formát: "eshop1=https://mojeshop.sk,https://www.mojeshop.sk;eshop2=https://druhy.sk"
 *   INGEST_RATE_PER_MIN (default 120) — max POSTov na /i/:site per IP za minútu
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || '';
const SITES = parseSites(process.env.SITES || '');
const INGEST_RATE_PER_MIN = parseInt(process.env.INGEST_RATE_PER_MIN || '120', 10);

// ---- Boot-time sanity checks ----
if (!DASH_PASS || DASH_PASS === 'change-me' || DASH_PASS.length < 12) {
  console.error('FATAL: DASH_PASS is missing, default, or shorter than 12 chars. Set a strong password.');
  process.exit(1);
}
if (!Object.keys(SITES).length) {
  console.error('FATAL: SITES is empty. Configure at least one siteKey=origin.');
  process.exit(1);
}
for (const [key, conf] of Object.entries(SITES)) {
  if (!conf.origins.length) {
    console.error('FATAL: site "' + key + '" has no origins. Every site must declare at least one origin.');
    process.exit(1);
  }
}

function parseSites(s) {
  var out = {};
  s.split(';').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (pair) {
    var idx = pair.indexOf('=');
    var key = (idx === -1 ? pair : pair.slice(0, idx)).trim();
    var origins = (idx === -1 ? '' : pair.slice(idx + 1));
    out[key] = { origins: origins.split(',').map(function (o) { return o.trim(); }).filter(Boolean) };
  });
  return out;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'rec.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions(
    site TEXT, id TEXT, first_seen INTEGER, last_seen INTEGER,
    url TEXT, ua TEXT, n INTEGER,
    PRIMARY KEY(site, id));
  CREATE TABLE IF NOT EXISTS events(
    site TEXT, sid TEXT, seq INTEGER, ts INTEGER, data TEXT);
  CREATE INDEX IF NOT EXISTS idx_events ON events(site, sid, seq);
`);

const qMaxSeq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE site=? AND sid=?');
const qInsEvent = db.prepare('INSERT INTO events(site, sid, seq, ts, data) VALUES(?,?,?,?,?)');
const qUpsertSession = db.prepare(`
  INSERT INTO sessions(site, id, first_seen, last_seen, url, ua, n)
  VALUES(@site, @id, @ts, @ts, @url, @ua, @n)
  ON CONFLICT(site, id) DO UPDATE SET last_seen=@ts, n=n+@n, url=excluded.url`);
const qList = db.prepare(`
  SELECT site, id, first_seen, last_seen, url, ua, n,
         (last_seen - first_seen) AS dur
  FROM sessions ORDER BY last_seen DESC LIMIT 500`);
const qEvents = db.prepare('SELECT data FROM events WHERE site=? AND sid=? ORDER BY seq ASC');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // za Traefikom v Coolify

// ---- Healthcheck (bez auth, pre Coolify/Traefik) ----
app.get('/healthz', function (req, res) {
  try {
    db.prepare('SELECT 1').get();
    res.status(200).type('text/plain').send('ok');
  } catch (e) {
    res.status(500).type('text/plain').send('db error');
  }
});

// ---- Rate-limit na ingest (per IP, sliding window per minute) ----
const rlBuckets = new Map(); // ip -> { count, windowStart }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const b = rlBuckets.get(ip);
  if (!b || now - b.windowStart >= 60000) {
    rlBuckets.set(ip, { count: 1, windowStart: now });
    return next();
  }
  b.count++;
  if (b.count > INGEST_RATE_PER_MIN) {
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
    return res.status(429).end();
  }
  next();
}
// Periodic cleanup buckets (zabráni pomalému rastu pamäte)
setInterval(function () {
  const cutoff = Date.now() - 120000;
  for (const [ip, b] of rlBuckets) {
    if (b.windowStart < cutoff) rlBuckets.delete(ip);
  }
}, 60000).unref();

// ---- Ingest (verejný, cross-origin) ----
app.options('/i/:site', function (req, res) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.post('/i/:site', rateLimit, express.text({ type: function () { return true; }, limit: '8mb' }), function (req, res) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  var conf = SITES[req.params.site];
  if (!conf) return res.status(204).end();                 // neznámy site -> ticho zahoď
  var origin = req.headers.origin;
  if (!origin || conf.origins.indexOf(origin) === -1) {
    return res.status(204).end();                          // chýba origin alebo mimo allowlistu
  }
  var body;
  try { body = JSON.parse(req.body); } catch (e) { return res.status(204).end(); }
  var sid = body && body.sid;
  var events = body && body.events;
  if (!sid || !Array.isArray(events) || !events.length) return res.status(204).end();

  var site = req.params.site;
  var now = Date.now();
  var ua = String(req.headers['user-agent'] || '').slice(0, 300);
  var url = String((body.url || '')).slice(0, 500);
  var base = qMaxSeq.get(site, sid).m + 1;

  var tx = db.transaction(function () {
    events.forEach(function (e, i) {
      qInsEvent.run(site, sid, base + i, now, typeof e === 'string' ? e : JSON.stringify(e));
    });
    qUpsertSession.run({ site: site, id: sid, ts: now, url: url, ua: ua, n: events.length });
  });
  tx();
  res.status(204).end();
});

// ---- recorder.js (verejný, first-party k tvojej ingest doméne) ----
app.get('/recorder.js', function (req, res) {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'recorder.js'));
});

// ---- Basic auth pre dashboard + API ----
function safeEqual(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function auth(req, res, next) {
  var h = req.headers.authorization || '';
  var b64 = h.split(' ')[1] || '';
  var parts = Buffer.from(b64, 'base64').toString().split(':');
  if (safeEqual(parts[0], DASH_USER) && safeEqual(parts[1], DASH_PASS)) return next();
  res.set('WWW-Authenticate', 'Basic realm="recorder"').status(401).end('Auth required');
}

app.get('/', auth, function (req, res) {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});
app.get('/api/sessions', auth, function (req, res) {
  res.json(qList.all());
});
app.get('/api/sessions/:site/:id', auth, function (req, res) {
  var rows = qEvents.all(req.params.site, req.params.id);
  res.json({ events: rows.map(function (r) { return r.data; }) });
});

// ---- Retencia: maž staré relácie ----
function cleanup() {
  var cutoff = Date.now() - RETENTION_DAYS * 86400000;
  var old = db.prepare('SELECT site, id FROM sessions WHERE last_seen < ?').all(cutoff);
  if (!old.length) return;
  var dE = db.prepare('DELETE FROM events WHERE site=? AND sid=?');
  var dS = db.prepare('DELETE FROM sessions WHERE site=? AND id=?');
  db.transaction(function () {
    old.forEach(function (o) { dE.run(o.site, o.id); dS.run(o.site, o.id); });
  })();
  console.log('[cleanup] zmazaných relácií: ' + old.length);
}
setInterval(cleanup, 6 * 3600 * 1000);
cleanup();

const server = app.listen(PORT, function () {
  console.log('recorder beží na porte ' + PORT + ', data v ' + DATA_DIR);
  console.log('nakonfigurované site kľúče: ' + Object.keys(SITES).join(', '));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] ' + signal + ' received, closing...');
  server.close(function () {
    try { db.close(); } catch (e) { console.error('[shutdown] db.close error:', e); }
    console.log('[shutdown] clean exit');
    process.exit(0);
  });
  // ak sa niečo zasekne, vypadni po 10s
  setTimeout(function () {
    console.error('[shutdown] forced exit after 10s');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
