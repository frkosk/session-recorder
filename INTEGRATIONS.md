# Integration guide

The recorder is site-agnostic — anything that can inject a `<script>`
tag can feed it. This document shows one worked end-to-end example on
**PrestaShop 8** via **Google Tag Manager**, plus common gotchas that
apply to any CMS.

Prerequisite: you already have a working recorder deployment (see
[README.md](README.md)) reachable at `https://rec.your-domain.com/`,
with a `siteKey` configured in `SITES` whose origin allowlist matches
the site you want to record.

---

## 1. Choose your delivery mechanism

Two clean options:

- **Google Tag Manager** (recommended when you already have GTM or plan
  to add other tags like GA4 / Ads pixels): the recorder becomes one
  Custom HTML tag among many, gated behind a consent trigger.
- **Direct injection into the site's theme** (recommended for a single
  tag with no other tracking needs): a small `<script>` tag in the
  page `<head>`, gated by the consent-cookie state.

Both are covered below. Pick one.

---

## 2. Consent gating

Session recording is **not essential** processing under GDPR/ePrivacy —
it needs explicit consent. The recorder ships with `autostart: false`
support and a `window.__rec.start()` API for this reason.

Two consent-gating patterns:

### Pattern A — load the tag *after* consent

Best used with GTM Consent Mode or a custom event fired from your
cookie banner when the user accepts. The recorder script itself doesn't
load until the trigger fires; therefore `autostart: true` is safe and
recording begins immediately.

### Pattern B — load the tag early, start on click

The script is present on every page load but doesn't record until
consent is captured. Set `autostart: false`, add a click listener on
the cookie banner's "Accept" button, and call
`window.__rec.start()` from that handler. Persist consent in a cookie
so returning visitors auto-start on subsequent page loads.

The GTM tag below implements Pattern B in a way that works with the
majority of custom cookie modules, without requiring GTM Consent Mode.

---

## 3. PrestaShop 8 via GTM — worked example

### 3.1 Install GTM into the PrestaShop theme

Create a **child theme** (do not edit the parent — it will be
overwritten on theme updates). In your child theme:

**`themes/<child-theme>/templates/_partials/head.tpl`** — GTM head
snippet, wrapped in `{literal}...{/literal}` so Smarty does not
interpret the `{` characters inside the JS as template tags:

```smarty
{literal}
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-XXXXXXX');</script>
<!-- End Google Tag Manager -->
{/literal}
```

**`themes/<child-theme>/templates/layouts/layout-both-columns.tpl`** —
the noscript body snippet, immediately after `<body>`. It does not
contain `{` characters so no `{literal}` needed:

```html
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXXXXX"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
```

> **Common bug:** forgetting `{literal}` around the head snippet
> produces a 500 error the moment you activate the child theme —
> Smarty tries to parse `{'gtm.start': ...}` as a Smarty tag and the
> template compile fails silently. If this happens, clear the Smarty
> cache after fixing (`rm -rf var/cache/prod/* cache/smarty/compile/*`).

> **Common bug (PS 8):** the correct path for layout overrides is
> `templates/layouts/...`, not `layouts/...` at the theme root. Files
> at the wrong path are silently ignored (no error, feature just
> doesn't work).

Replace `GTM-XXXXXXX` with your actual GTM container ID. Activate the
child theme in **Admin → Design → Theme & Logo**.

### 3.2 Verify GTM loads

Open the site in an incognito window. In DevTools Console:

```js
window.dataLayer
```

Should return an array containing `{gtm.start: ..., event: "gtm.js"}`.

If you see `net::ERR_CONNECTION_REFUSED` on the `gtm.js` request, your
own network is blocking Google (Pi-hole, AdGuard, or a corporate proxy).
Whitelist `googletagmanager.com` or test from a different network. Real
visitors on unfiltered networks will not have this problem.

### 3.3 Add the recorder as a Custom HTML tag in GTM

In GTM: **Tags → New → Tag Configuration → Custom HTML**. Paste:

```html
<script>
(function () {
  var CONSENT_COOKIE = '__rec_consent';
  var CONSENT_DAYS = 180;
  var ACCEPT_SELECTOR = '.close-cookie'; // adjust to your cookie banner's Accept button

  window.__REC_CONFIG__ = {
    endpoint: 'https://rec.your-domain.com/i/myshop',
    autostart: false
    // Optional: skip elements that show personal data on the confirmation page
    // , blockSelector: '#payment-confirmation, .customer-account, .order-recap-email'
  };

  function hasConsent() {
    return document.cookie.indexOf(CONSENT_COOKIE + '=1') !== -1;
  }
  function setConsent() {
    document.cookie = CONSENT_COOKIE + '=1; max-age=' + (CONSENT_DAYS * 86400) +
      '; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }
  function startWhenReady() {
    if (window.__rec && window.__rec.start) { window.__rec.start(); return; }
    var tries = 0;
    var iv = setInterval(function () {
      if (window.__rec && window.__rec.start) { clearInterval(iv); window.__rec.start(); }
      else if (++tries > 50) clearInterval(iv);
    }, 100);
  }

  // 1) Load the recorder loader (it does not start recording on its own).
  var s = document.createElement('script');
  s.src = 'https://rec.your-domain.com/recorder.js';
  s.async = true;
  document.head.appendChild(s);

  // 2) If consent was already granted in a previous session, start immediately.
  if (hasConsent()) { startWhenReady(); return; }

  // 3) Otherwise, listen for the Accept click (event delegation, works even
  //    if the cookie banner is injected asynchronously).
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest(ACCEPT_SELECTOR);
    if (!el) return;
    setConsent();
    startWhenReady();
  });
})();
</script>
```

**Trigger:** built-in **All Pages** trigger. The tag doesn't actually
record anything until the user has clicked Accept (or already had
`__rec_consent=1` from a previous visit).

**Save the tag → Submit → Publish** in GTM.

### 3.4 Find your cookie-banner's Accept selector

`.close-cookie` above is a placeholder. For your specific banner:

1. Open the site in an incognito window (so the banner appears).
2. DevTools → Element inspector → click the Accept button.
3. Copy a stable selector — usually a class or `id` present on the
   button. Avoid ephemeral selectors like `nth-child()`.

Common examples across PS cookie modules:
- Native PS Legal Compliance: `#js-cookies-info a.btn-primary`
- iQitCookieLaw: `.iqitcookielaw-btn-accept`
- Cookiebot: `#CybotCookiebotDialogBodyLevelButtonAcceptRecommended`
- Custom TVCms theme modules: `.close-cookie`, `.tvclose-icon`, etc.

Replace `ACCEPT_SELECTOR` in the tag with your actual selector.

### 3.5 Testing in Preview mode

- GTM → **Preview** → enter your site URL → **Connect**.
- The site opens in the same browser session as GTM. If you had already
  accepted cookies previously in that browser, the banner will not
  reappear and the consent-click handler won't fire. Test in a fresh
  incognito window instead, and make sure Preview is *published*.
- Accept the banner, then scroll and click around for ~30 seconds. The
  recorder buffers events every 5 seconds; the first flush happens
  ~100 ms after `start()` and carries the initial Meta + FullSnapshot.
- Refresh the dashboard — a new session should appear at the top with a
  green "✓ playable" badge.

---

## 4. Direct-theme integration (no GTM)

If you don't want GTM, drop the recorder loader straight into a child
theme. Simplest: a small module hooking `displayHeader`:

```php
public function hookDisplayHeader() {
    return '<script>window.__REC_CONFIG__={'
         . 'endpoint:"https://rec.your-domain.com/i/myshop",'
         . 'autostart:false'
         . '};</script>'
         . '<script async src="https://rec.your-domain.com/recorder.js"></script>';
}
```

Alternative, less clean: add the same two `<script>` tags to
`themes/<child-theme>/templates/_partials/head.tpl` (inside `{literal}`
where needed).

Then, to gate on consent, add a companion script anywhere in your
theme (or in the same hook):

```html
<script>
  function hasConsent(){ return document.cookie.indexOf("consent_stats=1") !== -1; }
  if (hasConsent() && window.__rec) window.__rec.start();
  document.addEventListener("click", function(e){
    if (e.target.closest("#accept-cookies-button")) {  // adjust selector
      document.cookie = "consent_stats=1; max-age=" + (180*86400) + "; path=/; SameSite=Lax; Secure";
      if (window.__rec) window.__rec.start();
    }
  });
</script>
```

Adjust the selector and cookie name to match whatever cookie module you
run.

---

## 5. Masking personal data in the recording

`maskAllInputs: true` (the default) prevents anything **typed** from
reaching the server. Everything the visitor sees on the rendered page —
their name in the account bar, their email on the order-confirmation
page, their saved address in checkout — is still captured in the DOM
snapshot.

Three tools to mask that:

- **`class="rr-block"`** on any element — that entire subtree is not
  recorded at all (best for whole "My account" widgets, address blocks).
- **`class="rr-mask"`** on any element — visible text is replaced with
  asterisks in the recording. The element is still recorded, just its
  text is masked (good for a rendered email in a receipt).
- **`blockSelector` option** in `__REC_CONFIG__` — a CSS selector list
  applied globally, useful when you can't edit the template but can
  identify offending elements by class.

Payment iframes (Stripe, Adyen, etc.) are cross-origin and rrweb does
not record them regardless.

**When to add these:** after your first real playback with a full
checkout, walk through the recording and note any spot where you see
customer PII. Add `rr-mask` / `rr-block` to those spots in the theme
(usually in `checkout/*.tpl` and `customer/*.tpl` overrides).

### Selectively **unmasking** specific input fields

Sometimes you need to see what customers actually type in one specific
field (e.g. shipping address, so you can see typos or unusual
formatting), while keeping everything else masked. Do this by passing
a `maskInputFn` in `__REC_CONFIG__`:

```html
<script>
window.__REC_CONFIG__ = {
  endpoint: 'https://rec.your-domain.com/i/myshop',
  autostart: false,
  // Unmask only the listed field names; mask everything else.
  // Password inputs are ALWAYS masked regardless.
  maskInputFn: function (text, element) {
    if (!element || element.type === 'password') return '*'.repeat(text.length);
    var name = String(element.name || element.id || '').toLowerCase();
    // PrestaShop address fields — adjust for your form
    var UNMASK = /^(firstname|lastname|address\d?|street|postcode|zip|city|phone(_mobile)?|company|vat_number)$/;
    if (UNMASK.test(name)) return text;
    return '*'.repeat(text.length);
  }
};
</script>
```

Combine with the consent-gated loader from §3.3.

> **Legal note.** The moment you record actual typed content of PII
> fields (address, phone, name), you leave "behaviour analytics"
> territory and enter "processing of personal data". Your privacy
> policy and cookie consent must explicitly cover this. For an EU
> e-commerce site, get legal review before enabling this.

If you'd rather annotate at the HTML level than in JS, the recorder
also honours `class="rr-unmask"` on any element — that element's text
and inputs are exempt from masking. Same legal caveat applies.

---

## 6. Verifying end-to-end

From a machine that can reach your recorder host:

```bash
# Health
curl https://rec.your-domain.com/healthz         # → ok

# Dashboard is auth-gated
curl -o /dev/null -w "%{http_code}\n" https://rec.your-domain.com/                  # → 401
curl -o /dev/null -w "%{http_code}\n" -u user:pass https://rec.your-domain.com/     # → 200

# Ingest without Origin is dropped
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: text/plain" \
  --data '{"sid":"probe","events":["x"]}' https://rec.your-domain.com/i/myshop
# → 204, but session should NOT appear in dashboard

# Ingest with allowed Origin is accepted
curl -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Content-Type: text/plain" -H "Origin: https://myshop.com" \
  --data '{"sid":"probe-ok","events":["e1"]}' https://rec.your-domain.com/i/myshop
# → 204, session appears in dashboard with n=1

# Recorder script is served
curl -I https://rec.your-domain.com/recorder.js     # → 200, application/javascript
```

---

## 7. Common problems

**Dashboard shows the session but playback is a blank white box.**
The session was recorded successfully but has no FullSnapshot event
(dashboard row will show `✗ no snapshot`). This is now guarded against
with `checkoutEveryNms: 30000` in the recorder — every 30 seconds rrweb
re-snapshots the DOM, so at least one FullSnapshot always exists in a
session longer than 30 seconds. If you still see this on very short
sessions (< 30 s), the initial flush was likely dropped by the network.

**Playback shows the page but images/backgrounds are missing.**
Captured HTML likely contained root-relative URLs (`/img/…`) that would
resolve against your recorder host instead of the original site. The
dashboard rewrites these to absolute URLs based on the first Meta
event's `href` — if you see this, the Meta event might be missing
(same root cause as above).

**Playback plays but the cursor is visible while page is blank.**
The rrweb wrapper element positioning got clipped or scaled off-stage.
See viewer.html — the wrapper is force-positioned at top-left of the
stage via `!important` overrides, and scaled with the recorded viewport
dimensions. If you customize the dashboard CSS, make sure not to
override these.

**Chrome shows some resources being blocked by CORS on font files.**
Cosmetic. Fonts require CORS headers to load cross-origin, and most
static hosts don't send them for `.woff2`. Text renders in a fallback
font in the recording; the shape of the page is preserved. To fix,
add `Access-Control-Allow-Origin: *` on your webserver for `.woff2`
files (or accept the fallback).

**Console shows "Blocked script execution … the frame is sandboxed".**
Intentional — the replay iframe deliberately does not `allow-scripts`
so captured `<script>` tags don't execute during playback. This means
any content that only appears after the site's own JS runs (lazy-loaded
sections, JS-injected banners, etc.) will not appear in the replay
either.

**No session appears at all after Accept.**
Check DevTools Network → filter `rec.your-domain.com` → do you see
POSTs to `/i/myshop`? If not, your ad blocker / DNS filter may be
blocking your recorder domain. If POSTs are there but return 204 with
nothing appearing in the dashboard, the `Origin` header didn't match
`SITES` for that key — check the exact origin string (protocol +
host, no trailing slash) matches what you configured.
