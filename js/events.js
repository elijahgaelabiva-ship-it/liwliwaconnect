// ---------------------------------------------------------------------
// EventsApp — live Events system for Liwliwa Connect.
//
// Events are submitted by business owners from dashboard.html and go
// live only after admin approval (see Events.gs / admin.html's "Pending
// Events" queue). This file fetches the already-approved public feed
// (type=events) once on load into EVENTS below.
//
// Every page (guest-home.html, events.html, event.html) reads through
// window.EventsApp.all() / upcoming() / getById(), never a raw array —
// so they just need to `await window.EventsApp.ready` once before their
// first render call, to make sure the fetch has finished.
// ---------------------------------------------------------------------
window.EventsApp = (() => {

  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbx1doFh9X93nSzMbxtDFmOUWEDf8MoT7Csb8XiEmKnh7Zw33RDEDjN8N7WlSFTMS5gb/exec';

  const CATEGORIES = {
    livemusic:  { label: 'Live Music',        icon: 'music',          gradient: 'linear-gradient(135deg, #1668E3, #0B2A4A)' },
    surfcomp:   { label: 'Surf Competition',  icon: 'waves',          gradient: 'linear-gradient(135deg, #17B8A6, #0B4A4A)' },
    yoga:       { label: 'Yoga',              icon: 'sparkles',       gradient: 'linear-gradient(135deg, #2FB380, #0B2A4A)' },
    bonfire:    { label: 'Bonfire',           icon: 'flame',          gradient: 'linear-gradient(135deg, #FF7A45, #7A1F3D)' },
    festival:   { label: 'Festival',          icon: 'party-popper',   gradient: 'linear-gradient(135deg, #F0605F, #7A1F3D)' },
    foodmarket: { label: 'Food Market',       icon: 'shopping-basket',gradient: 'linear-gradient(135deg, #8B5E34, #4A3220)' },
    workshop:   { label: 'Workshops',         icon: 'hammer',         gradient: 'linear-gradient(135deg, #1668E3, #17B8A6)' },
    family:     { label: 'Family Activities', icon: 'users',          gradient: 'linear-gradient(135deg, #FF7A45, #0B2A4A)' },
    petfriendly:{ label: 'Pet Friendly',      icon: 'dog',            gradient: 'linear-gradient(135deg, #2FB380, #17B8A6)' }
  };

  // Populated by load() below, from the backend's already-approved feed.
  let EVENTS = [];

  async function load() {
    try {
      const res = await fetch(`${ENDPOINT}?type=events`);
      const data = await res.json();
      EVENTS = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Could not load events from the server:', err);
      EVENTS = []; // fail quiet — pages show their existing empty state
    }
    return EVENTS;
  }

  // Every page awaits this once before its first render call.
  const ready = load();

  const INTEREST_KEY = 'liwliwa_event_interest';

  // Kept separate from window.AppFavorites (business favorites) so marking
  // interest in an event can never leak an event id into favorites.html's
  // business lookup and show up there as a broken/missing listing.
  const AppEventInterest = {
    getAll() {
      try { return JSON.parse(localStorage.getItem(INTEREST_KEY) || '[]'); }
      catch (e) { return []; }
    },
    isInterested(eventId) {
      return AppEventInterest.getAll().includes(eventId);
    },
    toggle(eventId) {
      const all = AppEventInterest.getAll();
      const idx = all.indexOf(eventId);
      let now;
      if (idx === -1) { all.push(eventId); now = true; }
      else { all.splice(idx, 1); now = false; }
      try { localStorage.setItem(INTEREST_KEY, JSON.stringify(all)); } catch (e) { /* storage blocked */ }
      return now;
    }
  };

  function interestedCount(event) {
    return event.interestedBase + (AppEventInterest.isInterested(event.id) ? 1 : 0);
  }

  function formatDateLabel(iso) {
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const startOfDay = new Date(d); startOfDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((startOfDay - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatTimeLabel(iso) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function isToday(event) {
    const d = new Date(event.startIso);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  }

  // Sponsored is a paid, admin-set flag on the Events sheet (is_sponsored +
  // optional sponsored_until) — separate revenue stream from business
  // Premium listings. Backend (Events.gs) already resolves expiry, so this
  // just reads the boolean it sends.
  function isSponsored(event) {
    return !!(event && event.is_sponsored);
  }

  function getById(id) {
    return EVENTS.find((e) => e.id === id) || null;
  }

  // Sponsored events first, then chronological within each group (stable
  // sort keeps date order intact inside the sponsored/non-sponsored split).
  function all() {
    return EVENTS.slice().sort((a, b) => {
      const sponsoredDiff = (isSponsored(b) ? 1 : 0) - (isSponsored(a) ? 1 : 0);
      if (sponsoredDiff !== 0) return sponsoredDiff;
      return new Date(a.startIso) - new Date(b.startIso);
    });
  }

  function upcoming() {
    const now = Date.now();
    return all().filter((e) => new Date(e.startIso).getTime() >= now - 6 * 3600 * 1000);
  }

  async function shareEvent(event) {
    const url = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}event.html?id=${encodeURIComponent(event.id)}`;
    const shareData = { title: event.title, text: `${event.title} — ${formatDateLabel(event.startIso)} at ${event.venue}`, url };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return 'shared';
      }
    } catch (e) { /* user cancelled share sheet — not an error */ }
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch (e) {
      return 'failed';
    }
  }

  function googleCalendarUrl(event) {
    const start = new Date(event.startIso);
    const end = new Date(start.getTime() + 2 * 3600 * 1000); // assume 2hr default duration
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.title,
      dates: `${fmt(start)}/${fmt(end)}`,
      details: event.description || '',
      location: event.venue || ''
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function esc(v) {
    const d = document.createElement('div');
    d.textContent = String(v ?? '');
    return d.innerHTML;
  }

  // Rich event card — image, title, date/time/venue, category badge,
  // interested count, organizer, and the Interested/Share/View Details
  // actions. `compact: true` fixes a width for horizontal carousels
  // (guest-home.html); omit it for a full-width stacked list (events.html).
  function renderCard(event, opts = {}) {
    const { compact = false, isFirst = false, isLast = false } = opts;
    const cat = CATEGORIES[event.category] || { label: event.category, icon: 'calendar', gradient: 'linear-gradient(135deg,#1668E3,#0B2A4A)' };
    const interested = AppEventInterest.isInterested(event.id);
    const count = interestedCount(event);
    const widthClass = compact ? `w-[78%] max-w-[300px] shrink-0 ${isFirst ? 'ml-6' : ''} ${isLast ? 'mr-6' : ''}` : 'w-full';

    return `
      <div class="card-app ${widthClass} flex flex-col">
        <a href="event.html?id=${encodeURIComponent(event.id)}" class="relative block">
          ${window.AppImage.cardImg(event.photo_url, event.title, { className: 'w-full h-36 object-cover', onError: 'this.remove()' })}
          <span class="absolute top-2.5 left-2.5 text-[11px] font-bold text-white px-2.5 py-1 rounded-full flex items-center gap-1"
                style="background:${cat.gradient}">
            <i data-lucide="${cat.icon}" class="w-3 h-3"></i>${esc(cat.label)}
          </span>
          ${isSponsored(event) ? `<span class="absolute top-2.5 right-2.5 text-[11px] font-bold text-white px-2.5 py-1 rounded-full flex items-center gap-1" style="background: linear-gradient(135deg, #FF7A45, #7A1F3D);"><i data-lucide="star" class="w-3 h-3"></i>Sponsored</span>` : ''}
        </a>
        <div class="p-3.5 flex flex-col gap-1.5">
          <a href="event.html?id=${encodeURIComponent(event.id)}">
            <h3 class="font-bold text-sm leading-snug line-clamp-2">${esc(event.title)}</h3>
          </a>
          <p class="text-xs text-ink/55 flex items-center gap-1.5">
            <i data-lucide="calendar" class="w-3.5 h-3.5"></i>${formatDateLabel(event.startIso)} · ${formatTimeLabel(event.startIso)}
          </p>
          <p class="text-xs text-ink/55 flex items-center gap-1.5 truncate">
            <i data-lucide="map-pin" class="w-3.5 h-3.5 shrink-0"></i><span class="truncate">${esc(event.venue)}</span>
          </p>
          <p class="text-xs text-ink/40">By ${esc(event.organizer)}</p>

          <div class="flex items-center justify-between mt-1.5">
            <span class="text-xs font-semibold text-ink/60 flex items-center gap-1">
              <i data-lucide="heart" class="w-3.5 h-3.5"></i>${count} interested
            </span>
          </div>

          <div class="grid grid-cols-3 gap-1.5 mt-2">
            <button type="button" data-event-interest="${event.id}"
              class="flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-full border ${interested ? 'bg-sunset/10 border-sunset/30 text-sunset' : 'border-ink/10 text-ink/70'}">
              <i data-lucide="heart" class="w-3.5 h-3.5"></i>${interested ? 'Interested' : 'Interested?'}
            </button>
            <button type="button" data-event-share="${event.id}"
              class="flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-full border border-ink/10 text-ink/70">
              <i data-lucide="share-2" class="w-3.5 h-3.5"></i>Share
            </button>
            <a href="event.html?id=${encodeURIComponent(event.id)}"
              class="flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-full text-white" style="background:${cat.gradient}">
              Details
            </a>
          </div>
        </div>
      </div>
    `;
  }

  // Delegated click handling for the Interested/Share buttons rendered by
  // renderCard — call this once per page after inserting cards into the DOM.
  function wireCardActions(container) {
    if (container.dataset.eventsWired === '1') return;
    container.dataset.eventsWired = '1';
    container.addEventListener('click', async (e) => {
      const interestBtn = e.target.closest('[data-event-interest]');
      if (interestBtn) {
        const id = interestBtn.dataset.eventInterest;
        AppEventInterest.toggle(id);
        const event = getById(id);
        const count = interestedCount(event);
        const nowInterested = AppEventInterest.isInterested(id);
        interestBtn.classList.toggle('bg-sunset/10', nowInterested);
        interestBtn.classList.toggle('border-sunset/30', nowInterested);
        interestBtn.classList.toggle('text-sunset', nowInterested);
        interestBtn.classList.toggle('border-ink/10', !nowInterested);
        interestBtn.classList.toggle('text-ink/70', !nowInterested);
        interestBtn.innerHTML = `<i data-lucide="heart" class="w-3.5 h-3.5"></i>${nowInterested ? 'Interested' : 'Interested?'}`;
        const countEl = interestBtn.closest('.card-app')?.querySelector('.flex.items-center.justify-between span');
        if (countEl) countEl.innerHTML = `<i data-lucide="heart" class="w-3.5 h-3.5"></i>${count} interested`;
        if (window.lucide) lucide.createIcons();
        return;
      }
      const shareBtn = e.target.closest('[data-event-share]');
      if (shareBtn) {
        const id = shareBtn.dataset.eventShare;
        const event = getById(id);
        const result = await shareEvent(event);
        if (result === 'copied') {
          const original = shareBtn.innerHTML;
          shareBtn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i>Copied!`;
          if (window.lucide) lucide.createIcons();
          setTimeout(() => { shareBtn.innerHTML = original; if (window.lucide) lucide.createIcons(); }, 1800);
        }
      }
    });
  }

  return {
    CATEGORIES, all, upcoming, getById, isToday, isSponsored,
    formatDateLabel, formatTimeLabel, interestedCount,
    shareEvent, googleCalendarUrl, AppEventInterest,
    renderCard, wireCardActions, ready
  };
})();
