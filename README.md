# Mini session recorder (rrweb) pre PrestaShop

Ľahká DIY náhrada za Hotjar session recording — nahráva, čo používatelia robia
(pohyb, klik, scroll, prepínanie polí, chyby), **bez toho, čo píšu**. Postavené na
[rrweb](https://github.com/rrweb-io/rrweb). Beží pohodlne na RPi5 cez Coolify vedľa
Umami. Určené na výskum hypotéz — napr. prečo návštevníci nedokončia košík.

Súbory:
- `recorder.js` — klientský skript (nasadíš na e-shop)
- `server.js` — ingest + úložisko (SQLite) + privátny dashboard
- `viewer.html` — prehrávač nahrávok
- `Dockerfile`, `package.json` — pre Coolify

---

## 1. Nasadenie na Coolify (RPi5)

1. Hoď tento priečinok do gitového repozitára (alebo použi Coolify "Dockerfile" deploy).
2. V Coolify vytvor novú **Application** z repozitára, build pack **Dockerfile**.
3. Nastav **persistent volume**: mount path `/data`. **Daj ho na SSD/USB, nie na SD kartu** — nahrávky veľa zapisujú.
4. Nastav doménu (napr. `rec.mojadomena.sk`) — Coolify vybaví HTTPS cez Traefik/Let's Encrypt. HTTPS je nutné.
5. Nastav ENV premenné:

| Premenná | Príklad | Popis |
|---|---|---|
| `DASH_USER` | `feri` | login do dashboardu |
| `DASH_PASS` | `dlhé-náhodné-heslo` | **POVINNÉ, min. 12 znakov** — inak server neštartne |
| `RETENTION_DAYS` | `30` | po koľkých dňoch mazať relácie |
| `SITES` | `eshop1=https://mojeshop.sk,https://www.mojeshop.sk` | **POVINNÉ** — siteKey → povolené originy (aspoň 1) |
| `INGEST_RATE_PER_MIN` | `120` | max POSTov per IP za minútu (default 120) |

`SITES` formát pre viac e-shopov (oddelené `;`):
```
eshop1=https://prvyshop.sk,https://www.prvyshop.sk;eshop2=https://druhyshop.sk,https://www.druhyshop.sk
```

Po nasadení:
- dashboard: `https://rec.mojadomena.sk/` (pýta login)
- ingest endpoint pre eshop1: `https://rec.mojadomena.sk/i/eshop1`
- recorder skript: `https://rec.mojadomena.sk/recorder.js`

---

## 2. Nasadenie na PrestaShop — cez Google Tag Manager (odporúčané)

GTM je najčistejšia cesta: prežije aktualizácie témy a **súhlas cookies vyriešiš
priamo v GTM**. Recorder spustíš až po udelení štatistického/analytického súhlasu.

Vytvor v GTM **Custom HTML** tag:

```html
<script>
  window.__REC_CONFIG__ = {
    endpoint: "https://rec.mojadomena.sk/i/eshop1",
    autostart: true
    // Voliteľné — nahrávaj len funnel (menšie dáta, ostrejší fokus):
    // , pages: ["product","cart","checkout","order","order-confirmation"]
    // Voliteľné — kompletne vynechaj citlivé bloky (viď sekcia Maskovanie):
    // , blockSelector: "#payment-confirmation, .js-payment-option-form"
  };
</script>
<script async src="https://rec.mojadomena.sk/recorder.js"></script>
```

**Trigger (dôležité — súhlas):** tag musí spúšťať až po súhlase. Dve možnosti:
- **GTM Consent Mode:** v nastaveniach tagu zapni *Additional consent checks* a vyžaduj `analytics_storage`. Tag sa potom spustí len keď má používateľ udelený analytický súhlas. `autostart: true` je vtedy v poriadku.
- **Custom event trigger:** ak tvoja cookie lišta pri súhlase pushne do dataLayer udalosť (napr. `cookie_consent_statistics`), spusti tag na tejto udalosti.

> Keďže tag beží až po súhlase, `autostart: true` je správne. Nič sa nenahráva pred súhlasom.

---

## 3. Nasadenie na PrestaShop — priamo v téme (alternatíva)

Ak nechceš GTM, vlož loader cez hook, aby prežil update témy. Najjednoduchšie
malý modul s hookom `displayHeader` (PrestaShop 1.7 / 8.x):

```php
public function hookDisplayHeader() {
    return '<script>window.__REC_CONFIG__={endpoint:"https://rec.mojadomena.sk/i/eshop1",autostart:false};</script>'
         . '<script async src="https://rec.mojadomena.sk/recorder.js"></script>';
}
```

Rýchla (menej čistá) alternatíva: vložiť ten istý kód do
`themes/<tema>/templates/_partials/head.tpl` v child téme.

**Súhlas bez GTM:** nastav `autostart: false` a recorder spusti ručne až po
súhlase. Generický vzor napojenia na cookie lištu:

```html
<script>
  // 1) ak už súhlas existuje z minula, spusti hneď
  function hasConsent(){ return document.cookie.indexOf("consent_stats=1") !== -1; }
  if (hasConsent() && window.__rec) window.__rec.start();

  // 2) po kliknutí na "Súhlasím" na tvojej cookie lište:
  document.addEventListener("click", function(e){
    if (e.target.closest("#accept-cookies-button")) {  // uprav selektor podľa svojej lišty
      document.cookie = "consent_stats=1; max-age=" + (180*86400) + "; path=/; SameSite=Lax";
      if (window.__rec) window.__rec.start();
    }
  });
</script>
```

> PrestaShop má viacero cookie modulov (natívny, psgdpr, tretie strany), každý sa
> chová inak. Uprav selektor tlačidla / názov cookie podľa toho, čo reálne používaš.
> Ak sa dá, radšej použi GTM — má súhlas vyriešený systémovo.

---

## 4. Maskovanie a súkromie (POVINNÉ pri e-shope)

Recorder má `maskAllInputs: true` — **žiadny text, ktorý používateľ napíše, sa
neodošle**. V nahrávke uvidíš, že klikol do poľa "e-mail" a niečo písal, ale nie čo.
To pokrýva väčšinu GDPR rizika pri formulároch (meno, adresa, telefón, e-mail).

Nad rámec toho:
- **Platby:** ak platobná brána beží v iframe (Stripe a pod.), rrweb ju aj tak nenahrá. Pre istotu pridaj `blockSelector` na platobný blok (viď GTM príklad) — blokované elementy sa nenahrávajú vôbec.
- **Zobrazené osobné údaje** (napr. e-mail vypísaný na stránke potvrdenia): pridaj takým elementom triedu `rr-mask` (zamaskuje zobrazený text) alebo `rr-block` (úplne vynechá).
- **Trvalé vynechanie oblasti:** trieda `rr-block` na obaľujúcom elemente.

**Právne:** session replay je v EÚ neesenciálna funkcia spracúvajúca správanie —
gate-ni ju na súhlas (viď vyššie) a doplň ju do cookie/privacy politiky ako
"analytické/štatistické" spracovanie. (Toto nie je právne poradenstvo — pri
e-shope s reálnymi zákazníkmi si to nechaj potvrdiť.)

---

## 5. Prehrávanie

Otvor `https://rec.mojadomena.sk/`, prihlás sa, vľavo klikni na reláciu. Vpravo sa
prehrá s ovládaním (play/pauza, rýchlosť, scrub). Relácie sú zoradené od najnovších.

---

## 6. Voliteľné vylepšenia (neskôr)

- **First-party skript** (obídeš adblockery): namiesto načítania `recorder.js` z ingest domény ho reverzne proxy-ni cez vlastnú doménu e-shopu (napr. `mojeshop.sk/rec.js` → `rec.mojadomena.sk/recorder.js`) a rovnako aj ingest endpoint. Pri stovkách relácií mesačne to zatiaľ netreba riešiť.
- **Self-host rrweb bundle** (tiež proti adblockerom a proti výpadku CDN): stiahni `all.umd.cjs` a nastav `rrwebSrc` v configu na svoju kópiu.
- **Filter na funnel:** odkomentuj `pages: [...]` ak chceš nahrávať len košík/checkout a šetriť miesto.
