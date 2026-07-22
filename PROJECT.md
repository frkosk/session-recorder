# PROJECT.md — Mini session recorder (rrweb)

Dokumentácia rozhodnutí a kontextu. `README.md` hovorí *ako* to nasadiť; tento
dokument hovorí *čo* a *prečo*, aby sa k projektu dalo vrátiť o pol roka bez straty
kontextu.

Posledná aktualizácia: 2026-07-21

---

## 1. Cieľ

Ľahká, self-hosted náhrada za Hotjar **session recording** na vlastných
PrestaShop e-shopoch. Primárny use-case: **výskum nedokončených košíkov** —
pozrieť sa, čo návštevníci na stránke reálne robia (kde váhajú, kde nastane
chyba, kde odpadnú), bez zbierania toho, čo píšu.

Nefunkčné požiadavky, ktoré tvarovali riešenie:
- **Nízka prevádzka** — rádovo stovky relácií mesačne. Netreba škálovať.
- **Beh na RPi5 cez Coolify**, ideálne vedľa existujúcich služieb (Umami).
- **Anonymizácia** — e-shop spracúva osobné a platobné údaje, nesmú unikať do nahrávok.
- **Nasaditeľné na PrestaShop** s cookie lištou; zásah do témy aj cez tag manager je možný.

---

## 2. Kontext a ako sme sa sem dostali

Pôvodná otázka bola širšia: náhrada za Hotjar + prípadne jednoduchá analytika
návštevnosti ako GA. Počas prieskumu sa ukázalo, že to sú **dve rôzne kategórie**
nástrojov s veľmi odlišnými nárokmi, a že „všetko v jednom, zadarmo, ľahké, na ARM"
neexistuje. Preto sme problém rozdelili:

- **Návštevnosť (GA-náhrada):** vyriešené samostatne — **Umami** na Pi/Coolify (ľahké, ARM, oficiálny one-click). Nie je súčasťou tohto repozitára.
- **Session recording (Hotjar-náhrada):** tento projekt — DIY rrweb.

---

## 3. Preskúmané alternatívy a prečo vypadli

| Riešenie | Verdikt | Dôvod |
|---|---|---|
| **PostHog** (self-hosted) | ❌ | Oficiálne 4 vCPU / 16 GB RAM, ťahá ClickHouse + Kafka + Postgres + Redis + MinIO. Na RPi5 nereálne. |
| **OpenReplay** | ❌ | Vyžaduje **x86** + 8 GB RAM; na ARM64 sa backend vôbec nespustí. |
| **Matomo + Heatmap & Session Recording** | ⚠️ | Core beží na ARM (PHP/MySQL), ale HSR je **platený** InnoCraft plugin (~€149–199/rok). Zvažiteľné, ak by sme chceli aj heatmapy naraz. |
| **Highlight.io** | ❌ | Akvizícia LaunchDarkly, hostovaný produkt sa vypína 2026, open-source vývoj spomalil. |
| **userTrack** | ⚠️ | Lacný (~$100/rok) PHP/MySQL nástroj s heatmapami + nahrávkami. Fallback, ak nechceme písať vlastné. |
| **Umami / Plausible** | — | Len analytika návštevnosti, nie nahrávky. Umami zvolené na tú druhú (samostatnú) potrebu. |
| **rrweb DIY** (zvolené) | ✅ | Len samotná record+replay vrstva (tú istú používa PostHog aj OpenReplay vnútri). ~100–200 MB RAM, beží na Pi vedľa Umami. Plná kontrola, nulová licencia. |

**Kľúčový insight:** session recording je v jadre len *append-only log časovaných
eventov*. rrweb spraví počiatočný DOM snapshot a potom už len mutácie. Celý ťažký
aparát okolo (ClickHouse atď.) je pre analytiku, ktorú my nepotrebujeme.

---

## 4. Rozhodnutie o hostingu (Pi vs VPS)

Zvažovali sme aj VPS (Hetzner vs Websupport), keby bolo treba x86/viac RAM
(napr. pre OpenReplay/PostHog):

- **Hetzner** je pri rovnakom RAM ~3–5× lacnejší; pozor, ceny v 2026 viackrát stúpli — drahé rady CPX/CCX (jún 2026 +113–176 %), lacné a rozumné ostali **CX** (Intel shared) a **CAX** (ARM). Výhoda: hodinové účtovanie (server na test zapneš/vypneš).
- **Websupport** je drahší, ale dáta v Bratislave (Tier III), slovenská faktúra s DPH a lokálna podpora — relevantné len ak na tom záleží kvôli dôvere/regulácii.

**Rozhodnutie:** keďže sme zvolili ľahké rrweb DIY, VPS **netreba** — všetko beží
na RPi5. VPS ostáva ako záložná úvaha, ak by v budúcnosti pribudlo niečo náročné.

---

## 5. Architektúra

```
Prehliadač návštevníka                 Raspberry Pi 5 / Coolify
┌─────────────────────────┐            ┌───────────────────────────────┐
│ recorder.js             │  eventy    │ Ingest API (server.js)        │
│  rrweb.record()         │ ─ HTTPS ─▶ │  POST /i/:site (overí origin) │
│  maskAllInputs, packFn  │            └──────────────┬────────────────┘
│  dávkuje, sendBeacon    │                           ▼
└─────────────────────────┘            ┌───────────────────────────────┐
                                        │ Úložisko: SQLite na /data(SSD)│
                                        └──────────────┬────────────────┘
                                                       ▼
                                        ┌───────────────────────────────┐
                                        │ Replay viewer (privátny, auth)│
                                        │  rrweb-player                 │
                                        └───────────────────────────────┘
```

Štyri časti: **recorder** (klient) → **ingest API** → **SQLite** → **viewer**.
Recorder a ingest sú verejné; viewer a API na čítanie sú za basic auth.

---

## 6. Kľúčové technické rozhodnutia (a prečo)

### R1 — rrweb v2 (`@rrweb/all`), nie starý `rrweb` balík
Starý `rrweb` all-in-one je oficiálne deprecated. Používame `@rrweb/all` cez oficiálne
CDN `cdn.rrweb.com` (UMD global `rrweb` s `record`, `Replayer`, `pack`, `unpack`).
Recorder si bundle natiahne sám → na e-shope stačí **jeden** script tag (dobré pre GTM).
`current` = posledná stabilná; pre produkciu odporúčané pinnúť verziu.

### R2 — SQLite (better-sqlite3), nie Postgres/ClickHouse
Pri stovkách relácií mesačne je SQLite ideálne: jeden súbor, žiadny extra kontajner,
synchrónne API, triviálna záloha (skopíruj súbor). Postgres by dával zmysel len keby
sme chceli zdieľať DB s Umami; nestálo to za réžiu. ClickHouse je overkill.

### R3 — Kompresia per-event cez `packFn` pri nahrávaní
rrweb komprimuje každý event pri emit (fflate/deflate). Backendová kompresia celej
relácie by mala lepší pomer, ale per-event je jednoduchšie pri streamovanom ingeste
a pri našom objeme úplne stačí. Vo vieweri sa rozbaľuje cez `unpack`.
> Uložené eventy sú teda **komprimované stringy**. Metadáta relácie (URL, čas) berieme
> z obálky payloadu a času prijatia, nie z rozbaľovania eventov.

### R4 — Ingest ako `text/plain` + `sendBeacon`/`fetch keepalive`
Telo posielame ako `text/plain` → je to "simple request", nevyvolá CORS preflight.
Na zatvorenie karty používame `sendBeacon` (fire-and-forget, prejde aj pri unloade),
inak `fetch` s `keepalive`. Server nečíta odpoveď na klientovi, takže CORS hlavičky
nie sú kritické (aj tak ich posielame pre čistotu).

### R5 — Súhlas cookies: gate cez GTM, nie autostart naslepo
Session replay je v EÚ **neesenciálne** spracovanie správania → potrebuje súhlas.
Recorder preto **sám od seba nezačne** — má `autostart` flag a `window.__rec.start()`.
Odporúčaná cesta je **GTM**, kde tag spustíme až na consent triggeri (Consent Mode
`analytics_storage`, alebo custom event z lišty). `autostart: true` je vtedy OK, lebo
tag samotný beží až po súhlase. Alternatíva bez GTM: `autostart: false` + ručný
`start()` po kliknutí na „Súhlasím" + kontrola consent cookie pri načítaní.

### R6 — Anonymizácia: `maskAllInputs: true` ako default
Najsilnejšia poistka: **nič, čo používateľ napíše, sa neodošle** (meno, e-mail,
adresa, karta → hviezdičky). Vidíme *čo robí*, nie *čo píše* — presne to, čo pri
košíkoch potrebujeme. Doplnkovo: `rr-block` (element sa vôbec nenahrá, napr. platby),
`rr-mask` (zamaskuje zobrazený text), `blockSelector` v configu. Platobné iframy
rrweb aj tak nenahrá.

### R7 — Multi-tenant cez `siteKey` + origin allowlist
Jeden server obsluhuje viac e-shopov. Každý má `siteKey` v URL (`/i/eshop1`) a
zoznam povolených originov (`SITES` env). Neznámy site alebo origin mimo allowlistu
sa ticho zahodí. `siteKey` je *verejný zapisovací kľúč* — pri internom výskume a
nízkom objeme akceptovateľné; ochranou je origin check (+ prípadne rate-limit neskôr).

### R8 — Viewer za basic auth, `rrweb-player`
Dashboard aj čítacie API sú za HTTP basic auth (bez extra závislosti). Prehrávanie
rieši `rrweb-player` (hotové ovládanie: play/pauza, rýchlosť, scrub). Viewer je
privátny, takže CDN tam nevadí (žiadny adblocker/consent problém).

### R9 — Retencia priamo v serveri
Cron-like `setInterval` maže relácie staršie než `RETENTION_DAYS` (default 30).
Bez toho by úložisko časom narástlo. Preto tiež dôrazne **SSD/USB, nie SD karta**.

---

## 7. Štruktúra súborov

| Súbor | Účel |
|---|---|
| `recorder.js` | Klientský skript: bootstrap rrweb, nahrávanie, maskovanie, dávkovanie, consent API (`window.__rec`). |
| `server.js` | Express ingest + SQLite + basic-auth API + serving recorder.js a viewera + retencia. |
| `viewer.html` | Privátny dashboard: zoznam relácií + `rrweb-player`. |
| `Dockerfile` | node:22-slim + build nástroje (better-sqlite3 sa kompiluje aj na ARM64). |
| `package.json` | Závislosti: `express`, `better-sqlite3`. |
| `README.md` | Návod na nasadenie (Coolify + PrestaShop GTM/téma + súhlas + maskovanie). |
| `PROJECT.md` | Tento dokument — rozhodnutia a kontext. |

---

## 8. Dátový model (SQLite)

```
sessions(site, id, first_seen, last_seen, url, ua, n)   PK(site, id)
events(site, sid, seq, ts, data)                        INDEX(site, sid, seq)
```
- `events.data` = jeden komprimovaný rrweb event (string z `pack`).
- `seq` = poradie v rámci relácie (server dopočíta z MAX(seq)+1 pri každej dávke).
- `sessions.n` = počet eventov; `url` sa aktualizuje na poslednú videnú.

---

## 9. Bezpečnostný a súkromný model

- **Zápis:** verejný, chránený origin allowlistom na `siteKey`. Verejný write key je
  vedomý kompromis pre nízko-rizikový interný výskum.
- **Čítanie/dashboard:** basic auth (`DASH_USER`/`DASH_PASS`). Musí bežať cez HTTPS.
- **Súkromie dát v nahrávkach:** `maskAllInputs` + block/mask triedy. Cieľ: v nahrávke
  nikdy nesmú byť čitateľné osobné/platobné údaje.
- **Právne:** patrí do cookie/privacy politiky ako analytické/štatistické spracovanie,
  spúšťané len po súhlase. (Nie je to právne poradenstvo — pri reálnych zákazníkoch overiť.)

---

## 10. Známe obmedzenia

- **Nie je to analytika.** Žiadne heatmapy/funnely/čísla — tie rieši Umami. Heatmapy by sa dali dorátať agregáciou klikov, ale to je extra projekt.
- **Verejný write key** — dá sa spamovať; origin check to len sťažuje. Pri raste doplniť rate-limit / podpísané tokeny.
- **Per-event kompresia** nie je optimálna pri veľkom objeme; pri raste zvážiť backendovú kompresiu celej relácie a dedup CSS.
- **Adblockery** môžu blokovať tretiostranový skript/ingest. Rieši sa first-party proxy cez doménu e-shopu (viď README §6) — zatiaľ netreba.
- **Cross-domain iframe / canvas** majú v rrweb obmedzenia; canvas by potreboval plugin (teraz vypnutý kvôli výkonu/veľkosti).

---

## 11. Budúce kroky / TODO

- [ ] Doladiť maskovacie a `blockSelector` selektory presne pre konkrétnu PrestaShop tému a checkout.
- [ ] Filter v dashboarde: zobraziť len relácie, ktoré sa dostali do košíka, ale nedokončili objednávku.
- [ ] Základné metadáta relácie priamo v zozname (zariadenie, krajina, vstupná/výstupná stránka).
- [ ] Zvážiť pinnutie konkrétnej rrweb verzie namiesto `current`.
- [ ] (Voliteľné) First-party proxy skriptu a ingestu, ak adblockery začnú prekážať.
- [ ] (Voliteľné) Rate-limit na ingest.

---

## 12. Changelog

- **2026-07-21** — Prvá verzia: recorder + ingest (SQLite) + viewer + Docker/Coolify, návod na PrestaShop cez GTM a tému, maskovanie a súhlas. Dokumentácia rozhodnutí (tento súbor).
