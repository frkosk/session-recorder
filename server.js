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
const zlib = require('zlib');
const geoip = require('geoip-lite');

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
    referrer TEXT, country TEXT, language TEXT,
    label TEXT, has_snapshot INTEGER DEFAULT 0,
    PRIMARY KEY(site, id));
  CREATE TABLE IF NOT EXISTS events(
    site TEXT, sid TEXT, seq INTEGER, ts INTEGER, data TEXT);
  CREATE INDEX IF NOT EXISTS idx_events ON events(site, sid, seq);
`);
// Idempotentne pridaj stĺpce pre staršie DB (ALTER TABLE ADD COLUMN vyhodí ak už existuje).
// Type suffixy sú explicit — SQLite je flexibilný, ale keep-schema-in-sync s CREATE TABLE.
const addCol = (col, type) => { try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`); } catch (e) {} };
addCol('referrer', 'TEXT');
addCol('country', 'TEXT');
addCol('language', 'TEXT');
addCol('label', 'TEXT');
addCol('has_snapshot', 'INTEGER DEFAULT 0');

// Backfill has_snapshot pre existujúce sessions. EXISTS pattern je robustnejší
// ako tuple-IN v SQLite. Threshold 5000 chytí aj FullSnapshoty malých stránok
// (Meta ~100B, Incrementals typicky <5KB). Beží bezpečne aj opakovane —
// touchuje iba rows kde has_snapshot=0.
try {
  const backfilled = db.prepare(`
    UPDATE sessions SET has_snapshot=1
    WHERE has_snapshot=0
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.site=sessions.site AND e.sid=sessions.id AND LENGTH(e.data) > 5000
      )`).run();
  if (backfilled.changes > 0) console.log('[backfill] has_snapshot set on ' + backfilled.changes + ' legacy sessions');
} catch (e) { console.warn('[backfill] failed:', e.message); }

const qMaxSeq = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE site=? AND sid=?');
const qInsEvent = db.prepare('INSERT INTO events(site, sid, seq, ts, data) VALUES(?,?,?,?,?)');
const qUpsertSession = db.prepare(`
  INSERT INTO sessions(site, id, first_seen, last_seen, url, ua, n, referrer, country, language, has_snapshot)
  VALUES(@site, @id, @ts, @ts, @url, @ua, @n, @referrer, @country, @language, @has_snapshot)
  ON CONFLICT(site, id) DO UPDATE SET
    last_seen=@ts, n=n+@n, url=excluded.url,
    referrer=COALESCE(sessions.referrer, excluded.referrer),
    country=COALESCE(sessions.country, excluded.country),
    language=COALESCE(sessions.language, excluded.language),
    has_snapshot=MAX(sessions.has_snapshot, excluded.has_snapshot)`);
const qList = db.prepare(`
  SELECT site, id, first_seen, last_seen, url, ua, n,
         (last_seen - first_seen) AS dur,
         referrer, country, language, label, has_snapshot
  FROM sessions ORDER BY last_seen DESC LIMIT 500`);
const qEvents = db.prepare('SELECT data FROM events WHERE site=? AND sid=? ORDER BY seq ASC');
const qSession = db.prepare('SELECT * FROM sessions WHERE site=? AND id=?');
const qDeleteEvents = db.prepare('DELETE FROM events WHERE site=? AND sid=?');
const qDeleteSession = db.prepare('DELETE FROM sessions WHERE site=? AND id=?');
const qUpdateLabel = db.prepare('UPDATE sessions SET label=? WHERE site=? AND id=?');

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
  var referrer = body.referrer ? String(body.referrer).slice(0, 500) : null;
  // Country z IP cez lokálnu geoip DB (žiadny odchádzajúci request, IP nikde neuložíme)
  var geo = geoip.lookup(req.ip);
  var country = geo ? geo.country : null;
  // Language z Accept-Language: "sk-SK,sk;q=0.9,en;q=0.8" → "sk-SK"
  var langHdr = String(req.headers['accept-language'] || '');
  var language = (langHdr.split(',')[0].split(';')[0].trim() || null);
  var base = qMaxSeq.get(site, sid).m + 1;

  // Detekcia FullSnapshot/Meta v tejto dávke — scan prvých max 5 eventov (typicky Meta+FS
  // v prvej dávke, Incrementals v ďalších). Cheap: 5 malých inflate-ov per POST.
  // Meta ~100B packed, FullSnapshot 5–500KB, Incrementals typicky <5KB. Zastavíme sa
  // hneď ako nájdeme type ∈ {2, 4}.
  var hasSnapshotInBatch = 0;
  for (var k = 0; k < Math.min(5, events.length); k++) {
    try {
      if (typeof events[k] !== 'string') continue;
      var evBuf = Buffer.from(events[k], 'binary');
      var evObj = JSON.parse(zlib.inflateSync(evBuf).toString('utf8'));
      if (evObj.type === 2 || evObj.type === 4) { hasSnapshotInBatch = 1; break; }
    } catch (err) { /* skip corrupted event */ }
  }

  var tx = db.transaction(function () {
    events.forEach(function (e, i) {
      qInsEvent.run(site, sid, base + i, now, typeof e === 'string' ? e : JSON.stringify(e));
    });
    qUpsertSession.run({
      site: site, id: sid, ts: now, url: url, ua: ua, n: events.length,
      referrer: referrer, country: country, language: language,
      has_snapshot: hasSnapshotInBatch
    });
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

// Session summary — parsuje eventy na serveri (menšia bandwidth ako posielať 200KB packed events).
app.get('/api/sessions/:site/:id/summary', auth, function (req, res) {
  var meta = qSession.get(req.params.site, req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  var rows = qEvents.all(req.params.site, req.params.id);
  var s = computeSummary(rows);
  res.json({ meta: meta, summary: s });
});

// Zmazanie session — hard delete v transakcii (events + sessions row).
app.delete('/api/sessions/:site/:id', auth, function (req, res) {
  var site = req.params.site, id = req.params.id;
  var existed = qSession.get(site, id);
  if (!existed) return res.status(404).json({ error: 'not found' });
  db.transaction(function () {
    qDeleteEvents.run(site, id);
    qDeleteSession.run(site, id);
  })();
  res.status(204).end();
});

// Update label — jediné meniteľné metadáta cez PATCH.
// Body: {"label": "interesting"|"reviewed"|"issue"|"test"|null}
var VALID_LABELS = ['interesting', 'reviewed', 'issue', 'test'];
app.patch('/api/sessions/:site/:id', auth, express.json({ limit: '4kb' }), function (req, res) {
  var site = req.params.site, id = req.params.id;
  var body = req.body || {};
  if (!('label' in body)) return res.status(400).json({ error: 'missing "label" field' });
  var label = body.label;
  if (label !== null && VALID_LABELS.indexOf(label) === -1) {
    return res.status(400).json({ error: 'invalid label', allowed: VALID_LABELS.concat([null]) });
  }
  var existed = qSession.get(site, id);
  if (!existed) return res.status(404).json({ error: 'not found' });
  qUpdateLabel.run(label, site, id);
  res.status(200).json({ ok: true, label: label });
});

function computeSummary(rows) {
  var firstTs = null, lastTs = null;
  var viewport = null;
  var pages = [];
  var activity = { interactions: 0, scrolls: 0, inputs: 0, mutations: 0 };
  var hasFullSnapshot = false;
  var timestamps = [];

  for (var i = 0; i < rows.length; i++) {
    try {
      // Packed event je binary string (charCode 0-255). Prevedieme na Buffer cez 'binary' encoding.
      var buf = Buffer.from(rows[i].data, 'binary');
      var inflated = zlib.inflateSync(buf).toString('utf8');
      var ev = JSON.parse(inflated);
      if (typeof ev.timestamp === 'number') {
        if (firstTs === null || ev.timestamp < firstTs) firstTs = ev.timestamp;
        if (lastTs === null || ev.timestamp > lastTs) lastTs = ev.timestamp;
        timestamps.push(ev.timestamp);
      }
      if (ev.type === 2) hasFullSnapshot = true;
      if (ev.type === 4 && ev.data) {
        if (!viewport && ev.data.width) viewport = { w: ev.data.width, h: ev.data.height };
        if (ev.data.href) {
          var u = ev.data.href;
          if (!pages.length || pages[pages.length - 1] !== u) pages.push(u);
        }
      }
      if (ev.type === 3 && ev.data) {
        switch (ev.data.source) {
          case 0: activity.mutations++; break;
          case 2: activity.interactions++; break;
          case 3: activity.scrolls++; break;
          case 5: activity.inputs++; break;
        }
      }
    } catch (e) { /* ignore malformed events */ }
  }

  // Aktívny čas: súčet gapov medzi eventmi kratších než IDLE_MS (default 30s).
  timestamps.sort(function (a, b) { return a - b; });
  var activeMs = 0;
  var IDLE_MS = 30000;
  for (var j = 1; j < timestamps.length; j++) {
    var gap = timestamps[j] - timestamps[j - 1];
    if (gap < IDLE_MS) activeMs += gap;
  }

  return {
    viewport: viewport,
    entryUrl: pages[0] || null,
    exitUrl: pages[pages.length - 1] || null,
    pages: pages,
    pagesCount: pages.length,
    activity: activity,
    playable: hasFullSnapshot,
    actualStartMs: firstTs,
    actualEndMs: lastTs,
    actualDurationMs: (firstTs && lastTs) ? lastTs - firstTs : null,
    activeMs: activeMs,
    eventCount: rows.length
  };
}

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
