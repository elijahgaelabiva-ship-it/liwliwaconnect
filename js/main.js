// Liwliwa Connect — main.js

// ---------------------------------------------------------------------
// AppBackend — safe wrapper around calls to the Apps Script Web App.
//
// Used by register.html, dashboard.html, vendor-update.html — anywhere
// that POSTs to the backend and expects JSON back. Plain `fetch(...).then(
// r => r.json())` breaks in a way that's confusing for a non-technical
// user whenever Apps Script doesn't hand back clean JSON — which happens
// for reasons that have nothing to do with the internet connection:
//   - the deployment's "Execute as" / "Who has access" is misconfigured,
//     so Google serves an HTML sign-in or permission page instead of JSON
//   - the script hit an uncaught exception and Apps Script returned its
//     own HTML error page
//   - a real network drop (weak signal, wifi hiccup)
// All three used to surface as the same unhelpful message. This wraps
// them so: the *user* always sees one plain-language sentence, and the
// *real* reason (visible only to whoever opens devtools) is always
// logged to the console for debugging.
// ---------------------------------------------------------------------
window.AppBackend = (() => {
  async function postJSON(url, payload, { retries = 1 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
        const raw = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          // Apps Script handed back something that isn't JSON — almost
          // always an HTML page (auth screen, error page, or Google's
          // own "Sorry, unable to open the file" interstitial).
          console.error(
            'Backend returned a non-JSON response (likely a deployment/auth issue on the Apps Script side). ' +
            'HTTP ' + res.status + '. First 200 chars: ' + raw.slice(0, 200)
          );
          throw new Error('SERVER_BAD_RESPONSE');
        }
        return parsed;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) continue; // one silent retry before giving up
      }
    }
    if (lastErr && lastErr.message === 'SERVER_BAD_RESPONSE') {
      throw new Error("Something went wrong on our end. Please try again in a moment.");
    }
    console.error('Backend request failed (network-level):', lastErr);
    throw new Error('Could not reach the server — check your internet connection and try again.');
  }

  return { postJSON };
})();


// ---------------------------------------------------------------------
// AppImage — image optimization for business photos.
//
// Business owners paste raw photo links from postimages.org/imgur into the
// Dashboard (see PROJECT_STATUS.md). Those originals are whatever size/
// format a phone camera produced — often multi-MB JPEGs — and we have no
// server of our own to resize or convert them (static site, no build step).
//
// wsrv.nl (images.weserv.nl) solves this for free with no signup: give it
// any public image URL and it fetches, resizes, and re-encodes it on the
// fly, cached on their CDN. We use it to:
//   1. Convert everything to WebP (smaller than JPEG/PNG at the same quality)
//   2. Serve a size that actually matches where the image is displayed,

//      instead of shipping a full-resolution photo into a 300px card
//   3. Provide a srcset so phones pick the smallest size that still looks
//      sharp on their screen
//
// Pair with loading="lazy" (native lazy loading) so off-screen images don't
// download until the visitor scrolls near them.
// ---------------------------------------------------------------------
window.AppImage = (() => {
  const PROXY = 'https://wsrv.nl/';

  function escAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Builds a wsrv.nl URL: fetch `rawUrl`, resize so it's at most `width`px
  // wide (aspect ratio kept, never upscaled), re-encode as WebP.
  function optimizedUrl(rawUrl, width, quality = 75) {
    if (!rawUrl) return '';
    const params = new URLSearchParams({
      url: rawUrl,
      w: String(width),
      output: 'webp',
      q: String(quality),
      fit: 'inside', // resize only, no cropping — CSS object-cover/background-size handles the crop
      we: '1'        // "without enlarge" — never blow up a small source photo
    });
    return `${PROXY}?${params.toString()}`;
  }

  // Ready-to-insert <img> tag for a listing card: WebP, lazy-loaded,
  // responsive srcset, and the original tap-to-retry-broken-image fallback
  // pattern (calls the page's own placeholderPhotoHtml()).
  function cardImg(rawUrl, altText, opts = {}) {
    if (!rawUrl) return '';
    const {
      className = 'w-full h-44 object-cover rounded-t-2xl',
      priority = false,
      // Pages that list placeholderPhotoHtml() (the 5 directory pages) get a
      // nice placeholder box on a broken image. Pages without it (like
      // guest-home's featured cards, which already have a gradient sitting
      // behind the image) just hide the broken <img> instead.
      onError = "this.replaceWith(document.createRange().createContextualFragment(placeholderPhotoHtml()))"
    } = opts;
    const widths = [400, 800, 1200];
    const srcset = widths.map((w) => `${optimizedUrl(rawUrl, w)} ${w}w`).join(', ');
    return `<img src="${optimizedUrl(rawUrl, 800)}" srcset="${srcset}" sizes="(min-width: 1024px) 360px, (min-width: 640px) 46vw, 92vw" alt="${escAttr(altText)}" class="${className}" loading="${priority ? 'eager' : 'lazy'}" decoding="async"${priority ? ' fetchpriority="high"' : ''} onerror="${escAttr(onError)}" />`;
  }

  return { optimizedUrl, cardImg };
})();


// ---------------------------------------------------------------------
// AppAnalytics — client side of the Business Analytics System.
// Backend: Analytics.gs (paste into the Apps Script project alongside
// Code.gs). See docs/API.md "Analytics" section for the full picture.
//
// Every call is fire-and-forget: it never blocks, delays, or can fail the
// action it's attached to (opening the dialer, maps, a website...). That's
// the #1 requirement of this feature — analytics must fail silently.
// ---------------------------------------------------------------------
window.AppAnalytics = (() => {
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbx1doFh9X93nSzMbxtDFmOUWEDf8MoT7Csb8XiEmKnh7Zw33RDEDjN8N7WlSFTMS5gb/exec';
  const GUEST_ID_KEY = 'liwliwa_guest_id';

  // A stable anonymous id for this browser, so repeat visits from the same
  // guest can be told apart from separate guests. There's no guest login
  // system in the app yet, so this is always the "not logged in" case the
  // Analytics sheet allows (GuestID column blank) — except we still fill
  // it in with an anonymous id, which is more useful for counting unique
  // visitors than leaving it blank. Swap this out if/when real guest
  // accounts exist.
  function getGuestId() {
    try {
      let id = localStorage.getItem(GUEST_ID_KEY);
      if (!id) {
        id = 'guest_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem(GUEST_ID_KEY, id);
      }
      return id;
    } catch (e) {
      return ''; // private browsing / storage blocked — tracking still works, just anonymous
    }
  }

  // Apps Script web apps never receive the request's User-Agent header, so
  // device type can't be detected on the server. It's detected once, here,
  // in the browser instead — still fully automatic, no guest input needed,
  // just computed in a different place than a typical server would.
  function detectDevice() {
    const ua = navigator.userAgent || '';
    const touchPoints = navigator.maxTouchPoints || 0;
    const minDim = Math.min(window.innerWidth || 0, window.innerHeight || 0);

    const isTablet = /iPad|Tablet/i.test(ua) ||
      (/Android/i.test(ua) && !/Mobile/i.test(ua)) ||
      (touchPoints > 1 && minDim >= 600);
    if (isTablet) return 'Tablet';

    const isMobile = /Mobi|Android|iPhone|iPod/i.test(ua) || (window.innerWidth || 9999) < 768;
    return isMobile ? 'Mobile' : 'Desktop';
  }

  // Logs one event. Uses sendBeacon when available — unlike a normal
  // fetch(), it's guaranteed to actually complete even if the page
  // navigates away (e.g. tapping "Website" immediately unloads the page).
  function track(businessId, eventType, notes) {
    if (!businessId || !eventType) return; // e.g. id not wired up on this page yet — no-op, not an error
    try {
      const payload = JSON.stringify({
        action: 'log_analytics',
        businessId,
        eventType,
        guestId: getGuestId(),
        device: detectDevice(),
        notes: notes || '-'
      });

      // THE BUG: navigator.sendBeacon() to a Google Apps Script /exec URL
      // is known to silently fail to deliver in many real-world browsers —
      // Apps Script's response handling doesn't play well with the Beacon
      // API's strict rules, so the click fires but the row never gets
      // written, with nothing anywhere to surface that failure. fetch()
      // with keepalive:true still survives a page unload and is the exact
      // same pattern every other working request in this app already uses.
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch (e) {
      // Never let a tracking failure surface to the caller — see file header.
    }
  }

  // Logs a lightweight "someone opened the app" event — separate from
  // track() above, which only fires on business-specific actions (Call,
  // Directions, VIEW, etc). Without this, the "guests explored" banner
  // only counted people who tapped into a specific business's contact/CTA
  // buttons — everyone who just browsed, searched, or landed on the app
  // without going that deep was invisible to it.
  //
  // Fires once per browser session (sessionStorage, not localStorage) —
  // so every fresh landing on the app (a new tab, a new visit from a
  // shared link, reopening after closing the browser) counts as one visit,
  // but navigating between pages within the same visit doesn't multiply it.
  function trackVisitOnce() {
    const VISIT_KEY = 'liwliwa_session_pinged';
    try {
      if (sessionStorage.getItem(VISIT_KEY) === '1') return; // already pinged this session
      sessionStorage.setItem(VISIT_KEY, '1');
    } catch (e) {
      // storage blocked (private browsing) — fall through and still ping once for this page load
    }
    track('SITE', 'VISIT');
  }

  return { track, trackVisitOnce, detectDevice, getGuestId };
})();

// Ping once per guest per day, on every page — this is what makes the
// "guests explored this month" banner reflect real traffic instead of
// only business-CTA taps.
window.AppAnalytics.trackVisitOnce();

// ---------------------------------------------------------------------
// AppSiteStats — small marketing banner ("1,240 guests explored Liwliwa
// this month"). Hits Analytics.gs's public site_stats endpoint (no
// password, no per-business data — see Analytics.gs for why that split
// exists). Fails silently: if the request errors or the count is 0, the
// banner just never appears, so a slow/broken fetch never leaves an
// awkward empty box on the page.
// ---------------------------------------------------------------------
window.AppSiteStats = (() => {
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbx1doFh9X93nSzMbxtDFmOUWEDf8MoT7Csb8XiEmKnh7Zw33RDEDjN8N7WlSFTMS5gb/exec';

  async function renderBanner(container, { range = '30d', label = 'this month' } = {}) {
    if (!container) return;
    try {
      const res = await fetch(`${ENDPOINT}?type=site_stats&range=${range}`);
      const data = await res.json();
      if (!data || !data.uniqueVisitors) return; // stays hidden — no fake "0 guests" banner
      const visitsPart = data.totalVisits && data.totalVisits > data.uniqueVisitors
        ? `${data.totalVisits.toLocaleString()} visits from ` : '';
      container.innerHTML = `
        <div class="inline-flex items-center gap-2">
          <i data-lucide="users" class="w-4 h-4"></i>
          <span>${visitsPart}${data.uniqueVisitors.toLocaleString()} guests explored Liwliwa Connect ${label}</span>
        </div>`;
      container.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    } catch (e) {
      // silent — see file header
    }
  }

  return { renderBanner };
})();

// ---------------------------------------------------------------------
// AppChart — minimal bar chart, pure HTML/CSS (no chart library, per
// project's "no heavy libraries" rule). Used by the Analytics sections in
// dashboard.html and admin.html.
// ---------------------------------------------------------------------
window.AppChart = {
  // data: [{ label, value }]. Renders into `container` (a DOM element).
  bar(container, data, opts = {}) {
    if (!container) return;
    if (!data || data.length === 0) {
      container.innerHTML = '<p class="text-xs text-ink/40 py-8 text-center">No data yet for this range.</p>';
      return;
    }
    const { color = '#17A398', heightPx = 110 } = opts;
    const max = Math.max(...data.map((d) => d.value), 1);
    const esc = (v) => { const d = document.createElement('div'); d.textContent = String(v ?? ''); return d.innerHTML; };

    container.innerHTML = `
      <div class="flex items-end gap-1.5" style="height:${heightPx}px;">
        ${data.map((d) => `
          <div class="flex-1 min-w-0 flex flex-col items-center justify-end h-full" title="${esc(d.label)}: ${esc(d.value)}">
            <span class="text-[10px] text-ink/50 mb-1">${esc(d.value)}</span>
            <div style="height:${Math.max((d.value / max) * 78, 3)}%; background:${color};" class="w-full rounded-t-md"></div>
            <span class="text-[9px] text-ink/40 mt-1 truncate w-full text-center">${esc(d.label)}</span>
          </div>
        `).join('')}
      </div>`;
  }
};

// ---------------------------------------------------------------------
// Shared analytics summary-card definitions + renderer, used by both
// dashboard.html (one business's numbers) and admin.html (sitewide) so
// this list exists in exactly one place.
// ---------------------------------------------------------------------
window.ANALYTICS_CARD_DEFS = [
  { key: 'VIEW', label: 'Profile Views', emoji: '👁' },
  { key: 'CALL', label: 'Call Clicks', emoji: '📞' },
  { key: 'DIRECTION', label: 'Direction Clicks', emoji: '📍' },
  { key: 'WEBSITE', label: 'Website Clicks', emoji: '🌐' },
  { key: 'FACEBOOK', label: 'Facebook Clicks', emoji: '📘' },
  { key: 'INSTAGRAM', label: 'Instagram Clicks', emoji: '📷' },
  { key: 'SHARE', label: 'Shares', emoji: '🔗' },
  { key: 'PHOTO_VIEW', label: 'Photo Views', emoji: '🖼️' },
  { key: 'EVENT_CLICK', label: 'Event Clicks', emoji: '🎟️' },
  { key: 'FAVORITE', label: 'Favorites', emoji: '❤️' }
];

window.AppAnalyticsCards = {
  // Renders the 10 summary cards from a `counts` object — as returned by
  // Analytics.gs's getBusinessAnalytics()/getAnalyticsSummary() — into `container`.
  render(container, counts) {
    if (!container) return;
    counts = counts || {};
    container.innerHTML = window.ANALYTICS_CARD_DEFS.map((def) => `
      <div class="bg-sand/60 rounded-xl px-3 py-2.5 flex flex-col gap-0.5">
        <span class="text-lg leading-none">${def.emoji}</span>
        <span class="text-lg font-display font-bold text-ink leading-tight">${(counts[def.key] || 0).toLocaleString()}</span>
        <span class="text-[10px] text-ink/50 leading-tight">${def.label}</span>
      </div>
    `).join('');
  }
};


// ---------------------------------------------------------------------
// Single source of truth for category keys, used by guest-home.html, the 5
// directory pages, and business.html. Key = the `type=` value the Apps
// Script API expects (matches SHEET_MAP category keys server-side).
// ---------------------------------------------------------------------
window.CATEGORIES = {
  resorts: { label: 'Resort', labelPlural: 'Resorts', page: 'resorts.html' },
  restaurants: { label: 'Restaurant', labelPlural: 'Restaurants', page: 'restaurants.html' },
  cafes: { label: 'Café', labelPlural: 'Cafés', page: 'cafes.html' },
  surfschools: { label: 'Surf School', labelPlural: 'Surf Schools', page: 'surf-schools.html' },
  activities: { label: 'Activity', labelPlural: 'Activities', page: 'activities.html' }
};

// ---------------------------------------------------------------------
// AppLightbox — full-screen photo viewer. Takes an array of image URLs
// (1 to 5 — see AppGallery below for where that cap is enforced) plus
// which one to open on. Shows prev/next arrows and dot indicators
// whenever there's more than one photo; falls back to a plain single
// image with no chrome when there's just one, so nothing looks broken
// for listings that only ever set photo_url and no gallery photos.
// ---------------------------------------------------------------------
window.AppLightbox = {
  open(images, startIndex, altText) {
    // Backward compatible with the old single-string call signature.
    if (typeof images === 'string') images = [images];
    images = (images || []).filter(Boolean);
    if (images.length === 0) return;
    let index = Math.max(0, Math.min(startIndex || 0, images.length - 1));

    const esc = (v) => { const d = document.createElement('div'); d.textContent = String(v ?? ''); return d.innerHTML; };

    let overlay = document.getElementById('appLightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'appLightbox';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,37,40,0.94);display:flex;align-items:center;justify-content:center;padding:24px;';
      document.body.appendChild(overlay);
    }

    function render() {
      const hasMultiple = images.length > 1;
      overlay.innerHTML = `
        <img src="${esc(images[index])}" alt="${esc(altText || '')}" style="max-width:100%;max-height:100%;border-radius:12px;object-fit:contain;" />
        ${hasMultiple ? `
          <button aria-label="Previous photo" class="lb-prev" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);width:2.5rem;height:2.5rem;border-radius:9999px;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:1.25rem;">&#8249;</button>
          <button aria-label="Next photo" class="lb-next" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);width:2.5rem;height:2.5rem;border-radius:9999px;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:1.25rem;">&#8250;</button>
          <div style="position:absolute;bottom:16px;left:0;right:0;display:flex;justify-content:center;gap:6px;">
            ${images.map((_, i) => `<span style="width:6px;height:6px;border-radius:9999px;background:${i === index ? '#fff' : 'rgba(255,255,255,0.4)'};"></span>`).join('')}
          </div>
        ` : ''}
        <button aria-label="Close" class="lb-close" style="position:absolute;top:16px;right:16px;width:2.25rem;height:2.25rem;border-radius:9999px;background:rgba(255,255,255,0.15);color:#fff;border:none;font-size:1.1rem;">&times;</button>
      `;
      overlay.querySelector('.lb-close').addEventListener('click', close);
      if (hasMultiple) {
        overlay.querySelector('.lb-prev').addEventListener('click', (e) => { e.stopPropagation(); index = (index - 1 + images.length) % images.length; render(); });
        overlay.querySelector('.lb-next').addEventListener('click', (e) => { e.stopPropagation(); index = (index + 1) % images.length; render(); });
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft' && images.length > 1) { index = (index - 1 + images.length) % images.length; render(); }
      if (e.key === 'ArrowRight' && images.length > 1) { index = (index + 1) % images.length; render(); }
    }

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    render();
  }
};

// ---------------------------------------------------------------------
// AppGallery — turns a business's photo_url + photo_urls (comma-separated
// extras) into one capped, deduplicated array of up to 5 photos, and
// renders a swipeable hero carousel with dot indicators. Tapping any
// photo opens AppLightbox on that same set, starting at the tapped photo.
// ---------------------------------------------------------------------
window.AppGallery = (() => {
  const MAX_PHOTOS_FREE = 5;
  const MAX_PHOTOS_PREMIUM = 10;

  // photo_url is always first (it's the designated cover photo), then
  // photo_urls fills the rest — deduplicated in case the same URL was
  // pasted into both fields, capped at the business's tier limit
  // (5 for free listings, 10 for active Premium listings).
  function maxFor(item) {
    return window.AppPremium && window.AppPremium.isActive(item) ? MAX_PHOTOS_PREMIUM : MAX_PHOTOS_FREE;
  }

  function collect(item) {
    const extras = String(item.photo_urls || '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = [item.photo_url, ...extras].map((s) => String(s || '').trim()).filter(Boolean);
    return [...new Set(all)].slice(0, maxFor(item));
  }

  function renderHero(container, item, altText) {
    const photos = collect(item);
    if (photos.length === 0) {
      container.innerHTML = `<div class="w-full h-64 sm:h-80 bg-ocean/10 rounded-[1.5rem] flex items-center justify-center">
                                <i data-lucide="image-off" class="w-10 h-10 text-ocean/30"></i>
                              </div>`;
      return photos;
    }

    const slidesHtml = photos.map((url, i) => `
      <div class="gallery-slide shrink-0 w-full snap-center" data-index="${i}">
        ${window.AppImage.cardImg(url, altText || 'Photo', { className: 'w-full h-64 sm:h-80 object-cover rounded-[1.5rem] cursor-zoom-in', priority: i === 0, onError: 'this.style.display=\'none\'' })}
      </div>
    `).join('');

    const dotsHtml = photos.length > 1
      ? `<div class="gallery-dots absolute bottom-3 left-0 right-0 flex justify-center gap-1.5">
          ${photos.map((_, i) => `<span class="gallery-dot w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}" data-dot="${i}"></span>`).join('')}
        </div>
        <div class="gallery-counter absolute top-3 right-3 bg-black/50 text-white text-xs font-semibold px-2 py-1 rounded-full">
          <span class="gallery-counter-current">1</span>/${photos.length}
        </div>`
      : '';

    // Explicit prev/next buttons — swiping works, but nothing about a plain
    // scroll container signals that to a guest (especially on desktop with
    // a mouse, or anyone who doesn't think to try swiping a photo). These
    // give a visible, tappable way to see every uploaded photo.
    const arrowsHtml = photos.length > 1
      ? `<button type="button" class="gallery-prev absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/45 text-white flex items-center justify-center" aria-label="Previous photo">
          <i data-lucide="chevron-left" class="w-5 h-5"></i>
        </button>
        <button type="button" class="gallery-next absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/45 text-white flex items-center justify-center" aria-label="Next photo">
          <i data-lucide="chevron-right" class="w-5 h-5"></i>
        </button>`
      : '';

    container.innerHTML = `
      <div class="gallery-track flex overflow-x-auto snap-x snap-mandatory rounded-[1.5rem]" style="scroll-behavior:smooth;">
        ${slidesHtml}
      </div>
      ${dotsHtml}
      ${arrowsHtml}
    `;

    const track = container.querySelector('.gallery-track');
    const dots = container.querySelectorAll('.gallery-dot');
    const counterCurrent = container.querySelector('.gallery-counter-current');

    // Updates which dot is lit (and the "X/Y" counter) as the guest
    // swipes/scrolls between photos.
    if (photos.length > 1) {
      let scrollTimer = null;
      track.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const activeIndex = Math.round(track.scrollLeft / track.clientWidth);
          dots.forEach((d, i) => d.classList.toggle('bg-white', i === activeIndex));
          dots.forEach((d, i) => d.classList.toggle('bg-white/40', i !== activeIndex));
          if (counterCurrent) counterCurrent.textContent = activeIndex + 1;
        }, 80);
      });

      const prevBtn = container.querySelector('.gallery-prev');
      const nextBtn = container.querySelector('.gallery-next');
      prevBtn.addEventListener('click', () => track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' }));
      nextBtn.addEventListener('click', () => track.scrollBy({ left: track.clientWidth, behavior: 'smooth' }));
    }

    container.querySelectorAll('.gallery-slide img').forEach((img, i) => {
      img.addEventListener('click', () => {
        if (window.AppAnalytics && item.__businessId) window.AppAnalytics.track(item.__businessId, 'PHOTO_VIEW');
        window.AppLightbox.open(photos.map((u) => window.AppImage.optimizedUrl(u, 1600, 85)), i, altText);
      });
    });

    return photos;
  }

  return { collect, renderHero, maxFor, MAX_PHOTOS_FREE, MAX_PHOTOS_PREMIUM };
})();


// ---------------------------------------------------------------------
// AppRating — Google rating + review count display, used on directory
// cards and business.html. Reads three optional sheet columns (any of
// which may be blank — nothing renders if `google_rating` is missing):
//   google_rating         e.g. 4.6
//   google_reviews_count  e.g. 128
//   google_maps_url       link to the listing's Google Maps page, used as
//                          the "See reviews" / "Read reviews on Google" link
// These are plain pass-through columns — see docs/API.md — so adding them
// to a directory sheet tab is enough for them to show up here, no script
// changes needed for *display*. Saving them from the Dashboard is a
// separate, smaller Code.gs change — see docs/API.md.
// ---------------------------------------------------------------------
window.AppRating = (() => {
  function esc(v) { const d = document.createElement('div'); d.textContent = String(v ?? ''); return d.innerHTML; }

  function starsHtml(rating, sizeClass = 'w-3.5 h-3.5') {
    // 5 stars, each rendered fully filled, half, or empty based on `rating`.
    let html = '';
    for (let i = 1; i <= 5; i++) {
      const filled = rating >= i - 0.25;
      const half = !filled && rating >= i - 0.75;
      html += `<i data-lucide="star" class="${sizeClass} ${filled ? 'text-sunset fill-sunset' : half ? 'text-sunset fill-sunset opacity-50' : 'text-ink/15'}"></i>`;
    }
    return html;
  }

  // Compact badge for directory cards: ★ 4.6 (128)
  function badge(item) {
    const rating = parseFloat(item.google_rating);
    if (isNaN(rating)) return '';
    const count = parseInt(item.google_reviews_count, 10);
    const countText = !isNaN(count) && count > 0 ? ` (${count})` : '';
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-ink/80">
        <i data-lucide="star" class="w-3.5 h-3.5 text-sunset fill-sunset"></i>${rating.toFixed(1)}${countText}
      </span>`;
  }

  // Fuller block for business.html: star row + numeric rating + review
  // count + optional "Read reviews on Google" link.
  function block(item) {
    const rating = parseFloat(item.google_rating);
    if (isNaN(rating)) return '';
    const count = parseInt(item.google_reviews_count, 10);
    const countText = !isNaN(count) && count > 0 ? `${count} Google review${count === 1 ? '' : 's'}` : 'Google rating';
    const link = item.google_maps_url
      ? `<a href="${esc(item.google_maps_url)}" target="_blank" rel="noopener" class="text-ocean font-semibold underline">See on Google</a>`
      : '';
    return `<div class="flex flex-wrap items-center gap-2 mb-3">
        <div class="flex items-center gap-0.5">${starsHtml(rating, 'w-4 h-4')}</div>
        <span class="font-bold text-sm">${rating.toFixed(1)}</span>
        <span class="text-sm text-ink/50">·</span>
        <span class="text-sm text-ink/60">${esc(countText)}</span>
        ${link ? `<span class="text-sm text-ink/30">·</span>${link}` : ''}
      </div>`;
  }

  return { badge, block, starsHtml };
})();


// ---------------------------------------------------------------------
// AppFeatured — Monetization: Featured Homepage Placement.
//
// Separate paid product from Premium (a business can buy this without
// being a Premium listing, or on top of it). Driven by two columns on
// any listing tab (Resorts, Restaurants, Cafes, SurfSchools, Activities):
//   featured        TRUE / FALSE
//   featured_until  optional date (e.g. 2026-08-31) — past this date the
//                    listing quietly drops out of rotation automatically,
//                    same pattern as is_premium/premium_expires.
//
// MAX_SLOTS caps how many businesses can be in the paid rotation at once
// (first MAX_SLOTS found, in sheet order, if more than that are flagged)
// — this is what actually makes "Featured Today" a scarce, sellable slot
// instead of something anyone could just turn on for free forever. Raise
// or lower it directly here if you change how many slots you sell.
// ---------------------------------------------------------------------
window.AppFeatured = (() => {
  const MAX_SLOTS = 5;

  function isActive(item) {
    if (!item) return false;
    if (String(item.featured || '').toUpperCase() !== 'TRUE') return false;
    const exp = item.featured_until ? new Date(item.featured_until) : null;
    if (exp && !isNaN(exp.getTime()) && exp.getTime() < Date.now()) return false;
    return true;
  }

  // The pool that Featured Today (and any other homepage placement) draws
  // from — active, not-expired, capped at MAX_SLOTS.
  function activeCandidates(listings) {
    return (listings || []).filter(isActive).slice(0, MAX_SLOTS);
  }

  return { isActive, activeCandidates, MAX_SLOTS };
})();

// ---------------------------------------------------------------------
// AppPremium — Monetization: Premium Business Listing tier.
//
// Driven entirely by two sheet columns on any listing tab (Resorts,
// Restaurants, Cafes, SurfSchools, Activities):
//   is_premium       TRUE / FALSE
//   premium_expires  optional date (e.g. 2026-12-31) — once past, the
//                    listing quietly reverts to free-tier treatment
//                    everywhere, with zero code changes needed.
//
// TO MARK A BUSINESS AS PREMIUM: open its sheet tab, add an is_premium
// column if it doesn't exist, type TRUE in that business's row. Add
// premium_expires too if you want it to auto-expire on a date.
//
// This single flag drives every free-vs-premium difference described in
// the pricing plan: featured badge, first-in-search placement, larger
// card, verified badge. (Photo limit + analytics gating are separate,
// later pieces — see chat.)
// ---------------------------------------------------------------------
window.AppPremium = (() => {
  function isActive(item) {
    if (!item) return false;
    if (String(item.is_premium || '').toUpperCase() !== 'TRUE') return false;
    const exp = item.premium_expires ? new Date(item.premium_expires) : null;
    if (exp && !isNaN(exp.getTime()) && exp.getTime() < Date.now()) return false;
    return true;
  }

  // Premium listings first, free listings after — each group keeps its
  // existing relative order (JS sort is stable), so this only ever
  // re-shuffles the premium/free split, never scrambles rating order
  // within a tier.
  function sort(listings) {
    return [...(listings || [])].sort((a, b) => (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0));
  }

  // Ribbon shown on the photo of a premium card. Gold, distinct from the
  // orange/sunset used for the separate Featured tier (AppFeatured) — the
  // two are different paid products and shouldn't look identical.
  function ribbon() {
    return `<span class="absolute top-3 left-3 z-10 text-[11px] font-bold text-white px-2.5 py-1 rounded-full flex items-center gap-1 shadow-sm" style="background: linear-gradient(135deg, #FFD166, #B8860B);">
        <i data-lucide="crown" class="w-3 h-3"></i>Premium
      </span>`;
  }

  // Small verified checkmark shown next to the business name.
  function verifiedBadge(item) {
    if (!isActive(item)) return '';
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold text-turquoise" title="Verified business">
        <i data-lucide="badge-check" class="w-4 h-4 fill-turquoise/20"></i>Verified
      </span>`;
  }

  // Extra classes for the outer card wrapper — slightly larger padding,
  // a soft accent ring, and a stronger shadow so premium cards visibly
  // stand out in the grid without breaking the grid layout itself.
  function cardClass(item) {
    return isActive(item) ? 'ring-2 ring-[#D4A017]/60 shadow-lg' : '';
  }

  // Taller hero photo height for premium cards (h-48 vs the free h-40).
  function photoHeightClass(item) {
    return isActive(item) ? 'h-48' : 'h-40';
  }

  // Promotions is a Premium perk — a business sets promo_text (+ optional
  // promo_expires) themselves from the dashboard, but it only ever shows
  // publicly while the business is actually an active Premium listing, so
  // a lapsed subscription silently retires the banner along with everything else.
  function activePromo(item) {
    if (!isActive(item)) return null;
    const text = String(item.promo_text || '').trim();
    if (!text) return null;
    const exp = item.promo_expires ? new Date(item.promo_expires) : null;
    if (exp && !isNaN(exp.getTime()) && exp.getTime() < Date.now()) return null;
    return text;
  }

  return { isActive, sort, ribbon, verifiedBadge, cardClass, photoHeightClass, activePromo };
})();

// ---------------------------------------------------------------------
// AppAmenities — renders the optional `amenities` sheet column (a plain
// comma-separated string, e.g. "Free Wifi, Pool, Air Conditioning, Beach
// Access") as icon chips. Unknown amenity names still render fine, just
// with a generic checkmark icon — the list of names is not a fixed enum.
// ---------------------------------------------------------------------
window.AppAmenities = (() => {
  const ICON_MAP = [
    [/wifi|wi-fi/i, 'wifi'],
    [/park/i, 'car'],
    [/pool/i, 'waves'],
    [/air.?con|\bac\b/i, 'snowflake'],
    [/breakfast/i, 'coffee'],
    [/restaurant|dining/i, 'utensils'],
    [/bar\b/i, 'martini'],
    [/pet/i, 'dog'],
    [/beach/i, 'umbrella'],
    [/board|rental|gear|equipment/i, 'package'],
    [/locker/i, 'lock'],
    [/shower/i, 'droplets'],
    [/hot water/i, 'flame'],
    [/laundry/i, 'shirt'],
    [/family/i, 'users'],
    [/wheelchair|accessib/i, 'accessibility'],
    [/card|cashless|gcash/i, 'credit-card'],
    [/spa|massage/i, 'sparkles'],
    [/kitchen/i, 'cooking-pot'],
    [/gym|fitness/i, 'dumbbell'],
    [/security|guard/i, 'shield-check'],
    [/aircon.*fan|fan/i, 'fan'],
    [/tour|guide/i, 'compass'],
    [/lounge/i, 'sofa'],
    [/24|hour/i, 'clock']
  ];

  function iconFor(name) {
    const match = ICON_MAP.find(([re]) => re.test(name));
    return match ? match[1] : 'check-circle';
  }

  function esc(v) { const d = document.createElement('div'); d.textContent = String(v ?? ''); return d.innerHTML; }

  // Splits "Free Wifi, Pool,,  Air Conditioning" into ["Free Wifi","Pool","Air Conditioning"]
  function parse(raw) {
    return String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Compact chips for directory cards — capped at `max`, with a "+N" chip
  // for anything beyond that so cards don't grow unpredictably tall.
  function cardChips(raw, max = 3) {
    const list = parse(raw);
    if (list.length === 0) return '';
    const shown = list.slice(0, max);
    const extra = list.length - shown.length;
    const chips = shown.map((name) => `
        <span class="inline-flex items-center gap-1 text-[11px] font-semibold bg-ink/5 text-ink/70 px-2 py-1 rounded-full">
          <i data-lucide="${iconFor(name)}" class="w-3 h-3"></i>${esc(name)}
        </span>`).join('');
    const moreChip = extra > 0
      ? `<span class="inline-flex items-center text-[11px] font-semibold bg-ink/5 text-ink/50 px-2 py-1 rounded-full">+${extra} more</span>`
      : '';
    return `<div class="flex flex-wrap gap-1.5">${chips}${moreChip}</div>`;
  }

  // Full list for business.html — every amenity, larger touch-friendly chips.
  function fullChips(raw) {
    const list = parse(raw);
    if (list.length === 0) return '';
    return `<div class="flex flex-wrap gap-2">${list.map((name) => `
        <span class="inline-flex items-center gap-1.5 text-xs font-semibold bg-ocean/8 text-ocean px-3 py-1.5 rounded-full">
          <i data-lucide="${iconFor(name)}" class="w-3.5 h-3.5"></i>${esc(name)}
        </span>`).join('')}</div>`;
  }

  return { parse, iconFor, cardChips, fullChips };
})();


// ---------------------------------------------------------------------
// AppFavorites — NOT a real Favorites feature (no account/backend storage
// exists for this, by design — see docs/API.md). This is a small,
// device-only "save for later" toggle using localStorage, so the
// favorite button in card designs isn't a dead element. Tapping it also
// fires the FAVORITE analytics event (Analytics.gs already supports it).
// If a real cross-device Favorites feature gets built later, this can be
// swapped out without changing any card markup.
// ---------------------------------------------------------------------
window.AppFavorites = (() => {
  const KEY = 'liwliwa_favorites';

  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function isFavorited(businessId) {
    return getAll().includes(businessId);
  }

  function toggle(businessId) {
    if (!businessId) return false;
    const all = getAll();
    const idx = all.indexOf(businessId);
    let nowFavorited;
    if (idx === -1) {
      all.push(businessId);
      nowFavorited = true;
      AppAnalytics.track(businessId, 'FAVORITE');
    } else {
      all.splice(idx, 1);
      nowFavorited = false;
    }
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { /* storage blocked — toggle still works this session */ }
    return nowFavorited;
  }

  return { getAll, isFavorited, toggle };
})();


// ---------------------------------------------------------------------
// AppInstall — turns "it's a website" into "it's an app on your phone".
//
// Having manifest.json + the apple-mobile-web-app meta tags in <head> only
// makes the site ELIGIBLE to run full-screen with no browser address bar —
// it does nothing on its own. A visitor still has to actually install it
// (Android: tap "Install"/"Add to Home Screen" in Chrome's menu. iOS: Share
// sheet -> "Add to Home Screen"). Almost nobody discovers that on their own,
// so this shows a small dismissible banner that does it for them:
//   - Android/Chrome/Edge: catches the browser's `beforeinstallprompt` event
//     and offers a one-tap "Install" button.
//   - iOS Safari: has no such event (Apple doesn't support it), so instead
//     shows short instructions pointing at the Share icon.
//   - Skipped entirely if already running installed (standalone display
//     mode), and remembers a dismissal for 14 days so it isn't naggy.
// ---------------------------------------------------------------------
window.AppInstall = (() => {
  const DISMISS_KEY = 'installBannerDismissedAt';
  const DISMISS_DAYS = 14;
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS Safari's own flag
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function recentlyDismissed() {
    const at = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    if (!at) return false;
    const days = (Date.now() - at) / (1000 * 60 * 60 * 24);
    return days < DISMISS_DAYS;
  }

  function dismiss(banner) {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
    banner.remove();
  }

  function injectStyles() {
    if (document.getElementById('appInstallStyles')) return;
    const style = document.createElement('style');
    style.id = 'appInstallStyles';
    style.textContent = `
      #appInstallBanner {
        position: fixed; left: 0.75rem; right: 0.75rem; top: calc(0.75rem + env(safe-area-inset-top));
        z-index: 1500; display: flex; align-items: center; gap: 0.75rem;
        background: rgba(10, 37, 40, 0.96); color: #fff; border-radius: 1rem;
        padding: 0.75rem 0.9rem; box-shadow: 0 10px 30px rgba(0,0,0,0.25);
        font-family: inherit; backdrop-filter: blur(10px);
        animation: appInstallSlideIn 0.35s ease both;
      }
      @keyframes appInstallSlideIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
      #appInstallBanner img { width: 2.25rem; height: 2.25rem; border-radius: 0.6rem; flex-shrink: 0; }
      #appInstallBanner .aib-text { flex: 1; font-size: 0.78rem; line-height: 1.25; }
      #appInstallBanner .aib-text strong { display: block; font-size: 0.85rem; margin-bottom: 0.1rem; }
      #appInstallBanner button.aib-install {
        background: #17A398; color: #fff; border: none; border-radius: 0.6rem;
        padding: 0.45rem 0.8rem; font-size: 0.78rem; font-weight: 700; flex-shrink: 0;
      }
      #appInstallBanner button.aib-close {
        background: transparent; border: none; color: rgba(255,255,255,0.6);
        font-size: 1.1rem; line-height: 1; padding: 0.25rem; flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  function buildBanner({ title, body, showInstallBtn }) {
    injectStyles();
    const banner = document.createElement('div');
    banner.id = 'appInstallBanner';
    banner.innerHTML = `
      <img src="icons/icon-192.png" alt="" />
      <div class="aib-text"><strong>${title}</strong>${body}</div>
      ${showInstallBtn ? '<button class="aib-install">Install</button>' : ''}
      <button class="aib-close" aria-label="Dismiss">&times;</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('.aib-close').addEventListener('click', () => dismiss(banner));
    return banner;
  }

  function showAndroidBanner() {
    const banner = buildBanner({
      title: 'Get the full app',
      body: 'Install Liwliwa Connect for a real full-screen app — no browser bar, works offline.',
      showInstallBtn: true,
    });
    banner.querySelector('.aib-install').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      banner.remove();
    });
  }

  function showIOSBanner() {
    buildBanner({
      title: 'Add to Home Screen',
      body: 'Tap the Share icon <i data-lucide="share" style="width:0.8rem;height:0.8rem;display:inline;vertical-align:-1px;"></i>, then "Add to Home Screen" for the full app experience.',
      showInstallBtn: false,
    });
    if (window.lucide) lucide.createIcons();
  }

  function init() {
    if (isStandalone() || recentlyDismissed()) return;

    // Android/Chrome/Edge: wait for the browser to confirm installability.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      setTimeout(showAndroidBanner, 1500);
    });

    window.addEventListener('appinstalled', () => {
      try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
      const banner = document.getElementById('appInstallBanner');
      if (banner) banner.remove();
    });

    // iOS Safari never fires beforeinstallprompt — show instructions instead.
    if (isIOS() && !isStandalone()) {
      setTimeout(showIOSBanner, 1500);
    }
  }

  return { init };
})();


// Registers sw.js so the site can be installed and used offline. Loaded here
// (not per-page) because js/main.js is already included on every page — see
// sw.js itself for what gets cached and how to bump the cache after edits.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
window.AppInstall.init();
// Handles icon rendering, the header's transparent-to-solid transition on
// index.html, and highlighting the active bottom nav tab (visual only —
// each page already marks its own active tab, this just keeps icons in sync).

// Top progress bar element — created immediately (body exists by the time this
// script tag runs, even before DOMContentLoaded fires), so it's ready for any
// page that calls AppProgress.start() as soon as its own script runs.
if (!document.getElementById('appProgressBar')) {
  const bar = document.createElement('div');
  bar.id = 'appProgressBar';
  document.body.appendChild(bar);
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    lucide.createIcons();

    // Auto-refresh icons whenever the DOM changes — covers search results,
    // listing grids, featured cards, or anything else rendered dynamically
    // later, without every render function needing to remember to call
    // lucide.createIcons() itself.
    let iconRefreshTimer = null;
    const iconObserver = new MutationObserver(() => {
      clearTimeout(iconRefreshTimer);
      iconRefreshTimer = setTimeout(() => lucide.createIcons(), 50);
    });
    iconObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Header gains a subtle hairline border once you've scrolled a bit — index.html only.
  const isIndexPage = /(^|\/)index\.html$/.test(window.location.pathname) || window.location.pathname === '/' || window.location.pathname.endsWith('/');
  const header = document.getElementById('siteHeader');
  if (isIndexPage && header) {
    const toggleHeader = () => {
      header.classList.toggle('solid', window.scrollY > 8);
    };
    toggleHeader();
    window.addEventListener('scroll', toggleHeader, { passive: true });
  }
});

// Shared helper: renders N shimmer placeholder cards into a grid container,
// matching the shape of the real listing cards (photo + a couple of text lines).
// Used by resorts/restaurants/cafes/activities/surf-schools while their first
// fetch is still in flight, so the screen reads as "loading" not "frozen".
window.AppSkeleton = {
  cardGrid(container, count = 6) {
    if (!container) return;
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `
        <div class="bg-white border border-ink/10 rounded-2xl overflow-hidden flex flex-col">
          <div class="skel w-full h-44"></div>
          <div class="p-5 flex flex-col gap-3">
            <div class="skel skel-line" style="width:65%; height:1.1rem;"></div>
            <div class="skel skel-line" style="width:90%;"></div>
            <div class="skel skel-line" style="width:45%;"></div>
          </div>
        </div>`;
    }
    container.innerHTML = html;
    container.classList.remove('hidden');
  },
  row(container, count = 3, heightClass = 'h-16') {
    if (!container) return;
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `<div class="skel ${heightClass} rounded-xl mb-2"></div>`;
    }
    container.innerHTML = html;
  }
};
// Shared helper: call AppProgress.start() right before a fetch, AppProgress.done()
// once it resolves (success or fail). Safe to call from any page — it no-ops
// gracefully if the bar element isn't in the DOM yet for some reason.
window.AppProgress = (() => {
  let activeCount = 0;
  function bar() { return document.getElementById('appProgressBar'); }
  return {
    start() {
      activeCount++;
      const el = bar();
      if (!el) return;
      el.classList.add('active');
      el.style.width = '15%';
      requestAnimationFrame(() => { el.style.width = '70%'; });
    },
    done() {
      activeCount = Math.max(0, activeCount - 1);
      const el = bar();
      if (!el) return;
      el.style.width = '100%';
      setTimeout(() => {
        if (activeCount === 0) {
          el.classList.remove('active');
          setTimeout(() => { if (activeCount === 0) el.style.width = '0%'; }, 300);
        }
      }, 200);
    }
  };
})();
