# Session recorder (rrweb, self-hosted)

Lightweight, self-hosted replacement for Hotjar-style session recording.
Records what visitors do on your site (mouse, scroll, clicks, focus, DOM
changes) **without recording what they type**. Built on
[rrweb](https://github.com/rrweb-io/rrweb). Runs anywhere Docker runs.

Intended for **research on your own web**: understanding where users
hesitate, what breaks, and why they abandon carts — without the weight
(and vendor lock-in) of PostHog, Matomo HSR, or Hotjar.

**Not** an analytics tool — no aggregate numbers, no funnels, no
heatmaps. See it as a video recorder for user sessions, one at a time.

---

## What you get

- **`recorder.js`** — client script you inject on your site (via GTM or
  directly into your theme).
- **`server.js`** — Node/Express ingest + SQLite storage + private
  dashboard with rrweb-based playback.
- **`viewer.html`** — dashboard UI: session list with expandable
  per-session metadata, and a playback pane that fits the recorded
  viewport (including mobile snapshots).
- **`Dockerfile`** + **`docker-compose.yml`** — single container,
  ~200 MB after build, one persistent volume.

Multi-tenant out of the box: one recorder can serve many sites, each
gated by an origin allowlist.

---

## System requirements

- Docker Engine 20.10+ (or Docker Desktop) on any of:
  - **linux/amd64** — cloud VMs, workstations
  - **linux/arm64** — Raspberry Pi 5, AWS Graviton, Hetzner CAX, Apple Silicon
- A reverse proxy that terminates HTTPS and forwards to port 3000
  (Traefik, Nginx, Caddy, Cloudflare Tunnel, Coolify, …).
- Persistent storage for `/data` (SQLite DB + WAL). Any bind mount or
  named volume works. Avoid SD cards for high write volume; SSD/NVMe is
  recommended for anything past hundreds of sessions/day.

Resource footprint at rest: ~80 MB RAM, negligible CPU. Under load
(active recording ingest), still comfortably under 200 MB RAM on an
RPi5.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/frkosk/session-recorder.git
cd session-recorder

# 2. Create your config
cp .env.example .env
# Edit .env: set DASH_PASS (min 12 chars, must not be "change-me") and
# SITES (at least one site with at least one origin).

# 3. Run
docker compose up -d --build

# 4. Verify
curl http://127.0.0.1:3000/healthz   # → "ok"
```

Server refuses to start if `DASH_PASS` is missing/weak or `SITES` is
empty — this is intentional. Check `docker compose logs` for the FATAL
line and fix `.env`.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DASH_USER` | no | `admin` | Dashboard login |
| `DASH_PASS` | **yes** | — | Dashboard password (min. 12 chars, refuses "change-me") |
| `SITES` | **yes** | — | `siteKey1=origin1,origin2;siteKey2=origin` — see below |
| `RETENTION_DAYS` | no | `30` | Delete sessions older than this |
| `INGEST_RATE_PER_MIN` | no | `120` | Rate limit per IP for POST /i/:site |
| `PORT` | no | `3000` | HTTP port inside container |
| `DATA_DIR` | no | `/data` | Where the SQLite DB lives |

### `SITES` format

Semicolon separates sites. `siteKey=origin1,origin2` — the key becomes
part of the ingest URL. Only listed origins can POST for that key.

Single site:
```
SITES=myshop=https://myshop.com,https://www.myshop.com
```

Multiple sites:
```
SITES=shop1=https://shop1.com;shop2=https://shop2.com,https://www.shop2.com
```

Ingest URL for `myshop` is then `https://<your-recorder-host>/i/myshop`.

---

## Put a reverse proxy in front

The container listens on plain HTTP on port 3000. **You must terminate
TLS externally** — the recorder is not designed to serve HTTPS itself.

### Traefik (docker labels)

Add to the `recorder` service in `docker-compose.yml`:

```yaml
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.recorder.rule=Host(`rec.example.com`)"
      - "traefik.http.routers.recorder.entrypoints=websecure"
      - "traefik.http.routers.recorder.tls.certresolver=letsencrypt"
      - "traefik.http.services.recorder.loadbalancer.server.port=3000"
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name rec.example.com;

    ssl_certificate     /etc/letsencrypt/live/rec.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rec.example.com/privkey.pem;

    # Large ingest bodies can happen when a FullSnapshot is included
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy (Caddyfile)

```caddy
rec.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Coolify (recommended on RPi5)

Coolify handles TLS, routing, healthchecks, and auto-deploy from Git.
See PROJECT.md §4 for hosting rationale on RPi5 vs VPS. In short:

1. New Application → source: this repo → build pack: **Dockerfile**
2. Persistent Storage → **Directories** (bind mount type) → source path
   on host SSD (e.g. `/mnt/ssd/session-recorder`) → destination
   `/data`. On the host, first run:
   ```
   sudo mkdir -p /mnt/ssd/session-recorder
   sudo chown -R 1000:1000 /mnt/ssd/session-recorder
   ```
3. Domain: `rec.your-domain.com` → Coolify handles Let's Encrypt.
4. Ports Exposes: `3000` (don't publish to host — Traefik connects internally).
5. Environment Variables: everything from `.env.example`.
6. Deploy.

Coolify healthcheck picks up the `HEALTHCHECK` from the Dockerfile
automatically.

### Cloudflare Tunnel

Useful if you don't want a public IP. Install `cloudflared`, create a
tunnel pointing at `http://127.0.0.1:3000`, expose via a
`*.your-domain.com` route. TLS is handled by Cloudflare.

---

## Integrating the recorder on your site

The client script lives at `https://<your-recorder-host>/recorder.js`.
It's a small IIFE that waits for a config on `window.__REC_CONFIG__` and
then loads the rrweb bundle from `cdn.rrweb.com`.

Minimum HTML snippet to put on the site you want to record:

```html
<script>
  window.__REC_CONFIG__ = {
    endpoint: "https://rec.your-domain.com/i/myshop",
    autostart: true          // only true if the script is loaded *after* consent
  };
</script>
<script async src="https://rec.your-domain.com/recorder.js"></script>
```

### Consent

**In the EU, session recording requires prior consent.** Do not autostart
the recorder unconditionally on every page load. Two options:

- **Load the script only after consent** (e.g. via a GTM tag gated on
  the consent event) — `autostart: true` is fine because the script
  itself doesn't run until the trigger fires.
- **Load the script early but with `autostart: false`**, then call
  `window.__rec.start()` from your cookie-banner "Accept" handler.

See **[INTEGRATIONS.md](INTEGRATIONS.md)** for a full worked example
using Google Tag Manager on a PrestaShop store.

### Privacy defaults

The recorder ships with `maskAllInputs: true` — **nothing typed into a
form is sent to the server** (email, name, address, card, password all
become `••••`). What the visitor *does* is recorded; what they *type* is
not.

For displayed personal data (e.g. an email shown in the order
confirmation), add one of:

- `class="rr-block"` — the element is not recorded at all
- `class="rr-mask"` — visible text is masked in the recording
- `blockSelector` option — CSS selector list to block globally

Cross-origin `<iframe>`s (typical payment widgets) are not recorded by
rrweb anyway.

---

## Using the dashboard

Open `https://<your-recorder-host>/` — Basic Auth with `DASH_USER` /
`DASH_PASS`.

Left column: **filter bar** on top of the session list.

- **Site dropdown** — hidden when only one site is configured, shows a
  per-site filter once multiple sites are ingesting.
- **Label dropdown** — filter by manual classification (see below), by
  "no label", or across all.
- **`iba playable` toggle** — hide sessions that never delivered a
  FullSnapshot (unplayable).
- **Search input** — case-insensitive substring match against the
  session's last URL (200 ms debounce).
- Current filter state is mirrored to the URL hash
  (`#site=X&label=Y&playable=1&q=checkout`) so filters survive reloads
  and can be shared as bookmarks.

Each session row:

- **Colored dot** left of the site name = deterministic per-site colour
  (hash of siteKey → HSL hue), so multi-site views are visually
  scannable.
- **Label pill** in the top-right corner. Click to open a small picker
  with four preset labels — **interesting** (gold), **reviewed**
  (green), **issue** (red), **test** (grey) — plus a "no label" option.
  Toggling the label is one click, syncs via `PATCH` to the server.

Clicking a row does two things:

1. **Expands the row** into a detail card showing: device / OS / browser
   (parsed from User-Agent), viewport, country (via bundled MaxMind
   GeoLite2), preferred language, referrer, entry / exit URLs, page
   list, activity counts (interactions / scrolls / inputs / DOM
   changes), actual vs server-side duration, active-time estimate,
   playability status, copyable session ID, and a **Delete** button
   (hard delete, single confirm dialog).
2. **Loads the session into the player** on the right. The player fits
   its stage to the recorded viewport size (never upscales), redraws
   on window resize, and offers play / pause, click-to-seek scrubber,
   0.5× — 8× speed, skip-inactive toggle, and colored timeline markers
   for clicks (green), inputs (orange), and page navigation (purple)
   with click-to-seek.

If a session's dashboard row shows a red "✗ no snapshot" badge, the
recorder never delivered a FullSnapshot event to the server (usually
because the site is served over a network that intermittently loses
the first ingest batch) — the row still exists but cannot be played
back.

---

## Data model & retention

SQLite, `WAL` mode, single file at `$DATA_DIR/rec.db` + WAL/SHM
sidecars.

```
sessions(site, id, first_seen, last_seen, url, ua, n,
         referrer, country, language)                   PK(site, id)
events(site, sid, seq, ts, data)                        INDEX(site, sid, seq)
```

`events.data` is a single rrweb event, compressed per-event with rrweb's
`packFn` (fflate/zlib). Metadata (URLs, UA, times, ingest-derived
country/language) lives in the session envelope, not inside events.

Retention runs on a 6-hour interval (also on startup): any session
whose `last_seen` is older than `RETENTION_DAYS` is deleted, events
included. SQLite does not auto-VACUUM; if you delete millions of events,
run `sqlite3 rec.db "VACUUM"` manually to reclaim space.

---

## API

All read endpoints require Basic Auth. Ingest is public (gated by
origin allowlist + rate limit).

- `POST /i/:siteKey` — ingest. Body is `text/plain` JSON:
  `{ sid, url, referrer?, events: [packedString, ...] }`. Response: `204`.
- `GET /healthz` — plain-text `ok` if DB is reachable; used by
  Docker/Coolify healthcheck.
- `GET /recorder.js` — the client script (public).
- `GET /` — dashboard HTML (auth).
- `GET /api/sessions` — session list, newest first, hard-capped at 500.
  Each row includes `label` (nullable) and `has_snapshot` (0/1) so the
  dashboard can filter without extra fetches.
- `GET /api/sessions/:site/:id` — full packed events array for playback.
- `GET /api/sessions/:site/:id/summary` — parsed aggregates (viewport,
  pages, activity counts, timing) plus session metadata. Cheaper than
  fetching all events client-side.
- `PATCH /api/sessions/:site/:id` — update mutable metadata. Currently
  only `label` is supported. Body `application/json`:
  `{ "label": "interesting" | "reviewed" | "issue" | "test" | null }`.
  Returns `200 {ok: true, label}` on success, `400` for invalid label,
  `404` for unknown session.
- `DELETE /api/sessions/:site/:id` — hard delete. Removes the session
  row and all its events in a single transaction. Returns `204` on
  success, `404` if the session doesn't exist.

---

## Security & privacy model

- **Ingest write is public**, gated by (1) origin allowlist per
  `siteKey` and (2) per-IP rate limit. The `siteKey` is effectively a
  public write token; the origin check is the actual gate. For
  low-volume internal research this is acceptable; for higher stakes
  add signed tokens.
- **Dashboard and read APIs are Basic Auth.** Password is compared with
  `crypto.timingSafeEqual`. Must be served over HTTPS.
- **IP is never persisted** — used briefly at ingest time to look up
  country via the bundled MaxMind GeoLite2 DB, then discarded.
- **Cross-origin resources in playback**: the dashboard iframe re-fetches
  images/CSS from the original site's origin. Fonts often fail to load
  cross-origin (requires CORS on the origin server); this is cosmetic
  and text falls back to the browser default font.
- **Sandboxed replay iframe**: captured `<script>` tags do not execute
  during playback. This is by design and cannot be disabled without
  code changes.

Add session recording to your cookie / privacy policy as
"analytical/statistical processing of behaviour". This is not legal
advice — for a live e-commerce site with real customers, get it
confirmed.

---

## Development

```bash
# Run locally without Docker
npm install
DASH_PASS=$(openssl rand -base64 24) \
DASH_USER=me \
SITES="dev=http://localhost:8000" \
DATA_DIR=./dev-data \
node server.js
```

The `better-sqlite3` native module compiles on install; you need
Python 3, make, and a C++ toolchain. macOS with recent Python 3.14 may
fail — the Docker build works around this by using Debian bookworm's
Python 3.11.

---

## Related documents

- **[INTEGRATIONS.md](INTEGRATIONS.md)** — GTM setup, PrestaShop
  installation, consent handling, working example with a real PS theme.
- **[PROJECT.md](PROJECT.md)** — design rationale: why rrweb DIY over
  PostHog/OpenReplay/Matomo, why SQLite, why not VPS, security model.

---

## License

MIT — see [LICENSE](LICENSE).
