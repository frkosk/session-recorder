/*
 * Mini session recorder (rrweb) — recorder.js
 * Nasadzuje sa na e-shop. Sám si natiahne rrweb z CDN, nahráva reláciu
 * a po dávkach ju posiela na tvoj ingest endpoint.
 *
 * Konfigurácia sa číta z window.__REC_CONFIG__ (nastav ju PRED načítaním
 * tohto súboru). Príklad je v README.
 *
 * Dôležité pre GDPR: maskAllInputs je zapnuté -> žiadny text, ktorý
 * používateľ napíše (meno, e-mail, adresa, karta), sa na server neodošle.
 * Nahráva sa len to, čo robí (pohyb, klik, scroll, chyby, prepínanie polí).
 */
(function () {
  var C = window.__REC_CONFIG__ || {};
  if (!C.endpoint) { return; }

  // 'current' = posledná stabilná verzia. Pre produkciu môžeš pinnúť napr.
  // https://cdn.rrweb.com/all/2.0.1/all.umd.cjs
  var RRWEB_SRC = C.rrwebSrc || 'https://cdn.rrweb.com/all/current/all.umd.cjs';
  var FLUSH_MS = C.flushMs || 5000;      // ako často posielať dávku
  var MAX_BUF = C.maxBuffer || 200;      // po koľkých eventoch poslať hneď

  var buf = [], stopFn = null, started = false, sid = null, timer = null, firstFlushDone = false;

  function uuid() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Jedna relácia = jedna session (drží sa aj cez prechody medzi stránkami)
  function getSid() {
    try {
      var s = sessionStorage.getItem('__rec_sid');
      if (!s) { s = uuid(); sessionStorage.setItem('__rec_sid', s); }
      return s;
    } catch (e) { return uuid(); }
  }

  function post(data, beacon) {
    var body = JSON.stringify(data);
    try {
      // text/plain -> "simple request", nevyvolá CORS preflight
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(C.endpoint, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(C.endpoint, {
          method: 'POST', body: body,
          headers: { 'Content-Type': 'text/plain' },
          keepalive: true, mode: 'cors', credentials: 'omit'
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function flush(beacon) {
    if (!buf.length) return;
    var batch = buf; buf = [];
    post({ sid: sid, url: location.href, events: batch }, beacon);
  }

  function begin() {
    sid = getSid();
    stopFn = window.rrweb.record({
      emit: function (ev) {
        buf.push(ev);
        // Prvý flush spravíme okamžite (do 100 ms) — chceme dostať Meta + FullSnapshot
        // na server hneď na začiatku, nie až po 5 s alebo pri buffer overflow.
        // Bez baseline FullSnapshot je session neprehratelná.
        if (!firstFlushDone) {
          firstFlushDone = true;
          setTimeout(function () { flush(false); }, 100);
        } else if (buf.length >= MAX_BUF) {
          flush(false);
        }
      },
      packFn: window.rrweb.pack,      // komprimácia každého eventu
      maskAllInputs: true,            // KĽÚČOVÉ: maskuje všetky vstupy
      maskTextClass: 'rr-mask',       // .rr-mask -> maskuje aj zobrazený text
      blockClass: 'rr-block',         // .rr-block -> element sa vôbec nenahrá
      ignoreClass: 'rr-ignore',       // .rr-ignore -> ignoruje zmeny v elemente
      blockSelector: C.blockSelector || null,
      recordCanvas: false,
      collectFonts: false,
      // Nový FullSnapshot každých 30 s — poistka pre prípad, že prvá dávka
      // (obsahujúca iniciálny FullSnapshot) sa nedostala na server.
      // Bez baseline snapshotu nedokáže rrweb-player zrekonštruovať DOM.
      checkoutEveryNms: 30000,
      sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' }
    });

    timer = setInterval(function () { flush(false); }, FLUSH_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', function () { flush(true); });
  }

  // Voliteľné: nahrávaj len na vybraných stránkach (PrestaShop page_name)
  function pageAllowed() {
    if (!C.pages || !C.pages.length) return true;
    try {
      var pn = window.prestashop && window.prestashop.page && window.prestashop.page.page_name;
      return C.pages.indexOf(pn) !== -1;
    } catch (e) { return true; }
  }

  function start() {
    if (started) return;
    if (!pageAllowed()) return;
    started = true;
    if (window.rrweb && window.rrweb.record) { begin(); return; }
    var s = document.createElement('script');
    s.src = RRWEB_SRC; s.async = true;
    s.onload = function () { if (window.rrweb && window.rrweb.record) begin(); };
    s.onerror = function () { started = false; };
    document.head.appendChild(s);
  }

  function stop() {
    try { if (stopFn) stopFn(); } catch (e) {}
    flush(true);
    if (timer) clearInterval(timer);
    started = false;
  }

  // API pre integráciu so súhlasom cookies:
  //   window.__rec.start()  -> spusti po udelení súhlasu
  //   window.__rec.stop()   -> zastav (napr. pri odvolaní súhlasu)
  window.__rec = { start: start, stop: stop };

  // autostart použi LEN keď je skript spúšťaný až po súhlase (napr. GTM trigger)
  if (C.autostart) start();
})();
