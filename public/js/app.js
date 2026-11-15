import {
  buildOverpassQuery, parsePlaces, openStatus, weeklyTable, formatDistance, walkMinutes, directionsUrl, commonsThumb,
} from './core.js';

// Data lewat Worker kita sendiri (/api/*): cache bersama di edge, rate limit, dan User-Agent yang sesuai
// kebijakan OpenStreetMap. Koordinat dibulatkan ~100 m sebelum dikirim (privasi).
const round3 = (x) => Math.round(x * 1000) / 1000;
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const DEFAULT_VIEW = [-2.5, 117.5]; // Indonesia
const FAV_KEY = 'ruangseduh.favorit';
const CACHE_KEY = 'ruangseduh.cache.v1';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const ICON = { wifi: 'wifi', outdoor: 'outdoor', nosmoke: 'nosmoke', ac: 'ac', takeaway: 'takeaway', delivery: 'delivery', wheelchair: 'wheelchair', card: 'card', veg: 'veg' };

const $ = (s) => document.querySelector(s);
const els = {
  layout: $('#layout'), welcome: $('#welcome'), results: $('#results'), detail: $('#detail'),
  status: $('#status'), list: $('#list'), radius: $('#radius'), openNow: $('#openNow'), wifiOnly: $('#wifiOnly'),
  outdoorOnly: $('#outdoorOnly'), favOnly: $('#favOnly'), locate: $('#locate'), search: $('#search'), q: $('#q'),
  viewToggle: $('#viewToggle'), toast: $('#toast'),
};

let origin = null;   // {lat, lon, label}
let places = [];
let selectedId = null;
let pendingSelect = null; // dari tautan berbagi
let favorites = loadFavorites();
let markers = new Map();
const photoUrl = new Map(); // id tempat -> url foto (hasil resolve Wikidata/Commons)
let requestSeq = 0;

// ---------- peta ----------
const map = L.map('map', { zoomControl: false }).setView(DEFAULT_VIEW, 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let meMarker = null;
let radiusCircle = null;

const pinIcon = (p, sel) => L.divIcon({
  className: '', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32],
  html: `<div class="pin ${p.kind}${p.open === false ? ' closed' : ''}${sel ? ' sel' : ''}"><svg><use href="#i-${p.kind === 'makan' ? 'bowl' : 'cup'}"/></svg></div>`,
});

// ---------- util ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
function setStatus(html, err = false) { els.status.innerHTML = html; els.status.classList.toggle('err', err); }
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}
function loadFavorites() { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); } }
function saveFavorites() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* mode privat */ } }
const categories = () => (document.querySelector('input[name="cat"]:checked').value === 'semua' ? ['kafe', 'makan'] : ['kafe']);
const isMobile = () => matchMedia('(max-width: 820px)').matches;

function show(section) {
  els.welcome.hidden = section !== 'welcome';
  els.results.hidden = section === 'welcome';
  els.detail.hidden = section !== 'detail';
  els.viewToggle.hidden = section === 'welcome';
}

// ---------- data ----------
async function fetchPlaces() {
  if (!origin) return;
  const cats = categories();
  const radius = Number(els.radius.value);
  show('results');
  setStatus(`Mencari tempat dalam ${radius / 1000} km dari <b>${esc(origin.label)}</b>…`);
  els.list.innerHTML = skeleton(5);
  els.locate.disabled = true;
  const key = `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}|${radius}|${cats.join('+')}`;
  const ticket = ++requestSeq;
  try {
    const osm = readCache(key) ?? await apiPlaces(origin.lat, origin.lon, radius, cats);
    if (ticket !== requestSeq) return;
    writeCache(key, osm);
    const now = new Date();
    places = parsePlaces(osm, origin.lat, origin.lon).map((p) => ({ ...p, ...statusOf(p, now) }));
    drawRadius(radius);
    render(true);
    resolvePhotos(places);
    if (pendingSelect) { const id = pendingSelect; pendingSelect = null; if (places.some((p) => p.id === id)) openDetail(id); }
  } catch (e) {
    if (ticket !== requestSeq) return;
    els.list.innerHTML = '';
    setStatus(`Server data peta sedang sibuk (${esc(e.message)}). <button type="button" class="btn" id="retry">Coba lagi</button>`, true);
    $('#retry')?.addEventListener('click', fetchPlaces);
  } finally {
    if (ticket === requestSeq) els.locate.disabled = false;
  }
}

function statusOf(p, now) {
  const s = openStatus(p.openingHours, now);
  return { open: s.open, openLabel: s.label };
}

async function api(path, params, timeoutMs = 35000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/${path}?${new URLSearchParams(params)}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `status ${res.status}`);
    return data;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'waktu habis' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Cadangan: kalau Worker gagal menjangkau Overpass (IP Cloudflare kadang dibatasi), browser bertanya langsung.
// Satu server dulu; server berikutnya hanya bila yang sebelumnya gagal.
// Server utama kadang sangat lambat (20-40 detik) tapi tetap menjawab; jadi diberi waktu panjang.
const OVERPASS_DIRECT = [
  ['https://overpass-api.de/api/interpreter', 60000],
  ['https://overpass.private.coffee/api/interpreter', 30000],
];
async function directOverpass(lat, lon, r, cats) {
  const body = new URLSearchParams({ data: buildOverpassQuery(round3(lat), round3(lon), r, cats) });
  const slow = setTimeout(() => setStatus('Server data peta sedang lambat, mohon tunggu sebentar… ☕'), 8000);
  let last;
  try {
    for (const [url, ms] of OVERPASS_DIRECT) {
      try {
        const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(ms) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.elements)) return data;
      } catch (e) { last = e; }
    }
  } finally {
    clearTimeout(slow);
  }
  throw new Error(last?.name === 'TimeoutError' ? 'waktu habis' : 'server data peta sedang sibuk');
}

/** Cek cache bersama di Worker dulu (cepat); kalau belum ada, browser bertanya langsung ke Overpass. */
async function apiPlaces(lat, lon, r, cats) {
  try {
    const hit = await api('places', { lat: round3(lat), lon: round3(lon), r, cats: cats.join(','), cache: 'only' }, 4000);
    if (Array.isArray(hit.elements)) return hit;
  } catch { /* belum ada di cache / Worker lambat */ }
  return directOverpass(lat, lon, r, cats);
}

function readCache(key) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[key];
    return hit && Date.now() - hit.t < CACHE_TTL ? hit.osm : null;
  } catch { return null; }
}
function writeCache(key, osm) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[key] = { t: Date.now(), osm };
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(0, 15);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]]))));
  } catch { /* penyimpanan penuh atau mode privat */ }
}

/** Foto: URL langsung & Commons langsung dipakai; Wikidata diambil P18-nya (satu panggilan per 50 tempat). */
async function resolvePhotos(list) {
  const wd = [];
  for (const p of list) {
    if (!p.photo || photoUrl.has(p.id)) continue;
    if (p.photo.type === 'url') photoUrl.set(p.id, p.photo.url);
    else if (p.photo.type === 'commons') photoUrl.set(p.id, commonsThumb(p.photo.file));
    else wd.push(p);
  }
  for (let i = 0; i < wd.length; i += 50) {
    const chunk = wd.slice(i, i + 50);
    try {
      const url = `${WIKIDATA}?action=wbgetentities&props=claims&format=json&origin=*&ids=${chunk.map((p) => p.photo.id).join('|')}`;
      const data = await (await fetch(url)).json();
      for (const p of chunk) {
        const file = data.entities?.[p.photo.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (file) photoUrl.set(p.id, commonsThumb(`File:${file}`));
      }
    } catch { /* tanpa foto tidak apa-apa */ }
  }
  if (photoUrl.size) {
    document.querySelectorAll('[data-cover]').forEach((el) => {
      const url = photoUrl.get(el.dataset.cover);
      if (url && !el.querySelector('img')) setPhoto(el, url);
    });
  }
}

// ---------- foto jalan sekitar (Mapillary lewat /api/photo), hanya untuk kartu yang terlihat ----------
const mapillary = new Map();   // id tempat -> {url, id} | null (sudah dicek, tidak ada)
const photoQueue = [];
let photoActive = 0;
const photoObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    photoObserver.unobserve(e.target);
    const id = e.target.dataset.cover;
    if (!photoUrl.has(id) && !mapillary.has(id)) { photoQueue.push(id); pumpPhotos(); }
  }
}, { rootMargin: '200px' }) : null;

function pumpPhotos() {
  while (photoActive < 3 && photoQueue.length) {
    const id = photoQueue.shift();
    const p = places.find((x) => x.id === id);
    if (!p || mapillary.has(id)) continue;
    photoActive++;
    mapillary.set(id, null);
    api('photo', { lat: p.lat.toFixed(4), lon: p.lon.toFixed(4) })
      .then((r) => {
        if (!r.found || photoUrl.has(id)) return;
        mapillary.set(id, { url: r.url, id: r.id });
        photoUrl.set(id, r.url);
        document.querySelectorAll(`[data-cover="${CSS.escape(id)}"]`).forEach((el) => { if (!el.querySelector('img')) setPhoto(el, r.url, true, r.id); });
      })
      .catch(() => {})
      .finally(() => { photoActive--; pumpPhotos(); });
  }
}

function observeCovers(root) {
  if (!photoObserver) return;
  root.querySelectorAll('[data-cover]:not(.has-photo)').forEach((el) => photoObserver.observe(el));
}

function creditHtml(id) {
  const m = mapillary.get(id);
  return m ? `<a class="credit" href="https://www.mapillary.com/app/?pKey=${encodeURIComponent(m.id)}" target="_blank" rel="noopener">Foto jalan sekitar · © Mapillary</a>` : '';
}

function coverHtml(p, cls = '') {
  const url = photoUrl.get(p.id);
  return `<div class="cover c${p.cover}${url ? ' has-photo' : ''} ${cls}" data-cover="${esc(p.id)}">${icon(p.kind === 'makan' ? 'bowl' : 'cup')}${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${creditHtml(p.id)}` : ''}</div>`;
}
function setPhoto(el, url, fromMapillary = false, mlyId = null) {
  const img = new Image();
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  el.classList.add('has-photo');
  el.append(img);
  if (fromMapillary && mlyId) el.insertAdjacentHTML('beforeend', creditHtml(el.dataset.cover));
}
// foto gagal dimuat -> kembali ke ilustrasi
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.parentElement?.dataset.cover) {
    photoUrl.delete(img.parentElement.dataset.cover);
    img.parentElement.classList.remove('has-photo');
    img.parentElement.querySelector('.credit')?.remove();
    img.remove();
  }
}, true);

function filtered() {
  return places.filter((p) => {
    if (els.openNow.checked && p.open !== true) return false;
    if (els.wifiOnly.checked && !p.wifi) return false;
    if (els.outdoorOnly.checked && !p.outdoor) return false;
    if (els.favOnly.checked && !favorites.has(p.id)) return false;
    return true;
  });
}

// ---------- tampilan ----------
function skeleton(n) {
  return Array.from({ length: n }, () => `<li class="card skeleton"><div class="cover"></div><div class="card-body"><div class="bar w60"></div><div class="bar w40"></div><div class="bar w80"></div></div></li>`).join('');
}

function statusTag(p) {
  if (p.open == null) return '';
  return `<span class="status-tag ${p.open ? 'open' : 'closed'}">${esc(p.openLabel)}</span>`;
}

function cardHtml(p) {
  const fav = favorites.has(p.id);
  const icons = p.amenities.slice(0, 4).map((a) => `<span title="${esc(a.label)}">${icon(ICON[a.key])}</span>`).join('');
  return `<li class="card${p.id === selectedId ? ' active' : ''}" data-id="${esc(p.id)}" tabindex="0">
    ${coverHtml(p)}
    <div class="card-body">
      <h3>${esc(p.name)}</h3>
      <div class="sub">${icon('walk')}${formatDistance(p.distance)} · ${walkMinutes(p.distance)} mnt${p.open != null ? `<span class="sep">|</span>${statusTag(p)}` : ''}</div>
      <p class="summary">${esc(p.summary)}</p>
      ${icons ? `<div class="icons">${icons}</div>` : ''}
    </div>
    <button type="button" class="fav-btn${fav ? ' on' : ''}" data-fav="${esc(p.id)}" aria-pressed="${fav}" aria-label="${fav ? 'Hapus dari' : 'Simpan ke'} favorit">${icon('heart')}</button>
  </li>`;
}

function render(fit = false) {
  const items = filtered();
  layer.clearLayers();
  markers = new Map();
  for (const p of items) {
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(p, p.id === selectedId), title: p.name, riseOnHover: true })
      .bindPopup(`<b>${esc(p.name)}</b><br>${formatDistance(p.distance)}${p.openLabel ? ` · ${esc(p.openLabel)}` : ''}`)
      .on('click', () => { openDetail(p.id, false); });
    m.addTo(layer);
    markers.set(p.id, m);
  }
  els.list.innerHTML = items.map(cardHtml).join('');
  observeCovers(els.list);

  const hidden = places.length - items.length;
  if (!places.length) setStatus(`Belum ada tempat tercatat di sekitar <b>${esc(origin?.label ?? '')}</b>. Coba perbesar radius.`);
  else if (!items.length) setStatus(`Tidak ada yang cocok dengan filter. ${hidden} tempat disembunyikan.`);
  else setStatus(`<b>${items.length}</b> tempat di sekitar <b>${esc(origin.label)}</b>${hidden ? ` · ${hidden} disembunyikan filter` : ''}`);

  if (fit && items.length) {
    const b = L.latLngBounds(items.slice(0, 40).map((p) => [p.lat, p.lon])).extend([origin.lat, origin.lon]);
    map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
  }
}

function openDetail(id, pan = true) {
  const p = places.find((x) => x.id === id);
  if (!p) return;
  selectedId = id;
  render();
  const fav = favorites.has(p.id);
  const week = weeklyTable(p.openingHours);
  const today = new Date().getDay();
  const facilities = p.amenities.map((a) => `<div>${icon(ICON[a.key])}${esc(a.label)}</div>`).join('');
  const links = [
    p.address && `<div>${icon('pin')}${esc(p.address)}</div>`,
    p.website && `<a href="${esc(p.website)}" target="_blank" rel="noopener nofollow">${icon('globe')}${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`,
    p.instagram && `<a href="https://instagram.com/${esc(p.instagram)}" target="_blank" rel="noopener nofollow">${icon('insta')}@${esc(p.instagram)}</a>`,
    p.phone && `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${icon('phone')}${esc(p.phone)}</a>`,
  ].filter(Boolean).join('');

  els.detail.innerHTML = `
    <div class="detail-bar">
      <button type="button" class="round" data-action="back" aria-label="Kembali ke daftar">${icon('back')}</button>
      <button type="button" class="round${fav ? ' on' : ''}" data-fav="${esc(p.id)}" aria-pressed="${fav}" aria-label="Favorit">${icon('heart')}</button>
    </div>
    ${coverHtml(p, 'hero')}
    <div class="detail-body">
      <div>
        <h2>${esc(p.name)}</h2>
        <div class="sub">${icon('walk')}${formatDistance(p.distance)} · sekitar ${walkMinutes(p.distance)} menit jalan kaki${p.open != null ? `<span class="sep">|</span>${statusTag(p)}` : ''}</div>
      </div>
      <p class="summary">${esc(p.summary)}</p>
      <div class="actions">
        <a class="btn primary" href="${directionsUrl(p)}" target="_blank" rel="noopener">${icon('route')}Arahkan</a>
        <button type="button" class="btn" data-action="share">${icon('share')}Bagikan</button>
      </div>
      ${facilities ? `<section><h3 class="section-title">Fasilitas</h3><div class="facilities">${facilities}</div></section>` : ''}
      <section><h3 class="section-title">Jam buka</h3>
        ${week ? `<table class="hours">${week.map((d) => `<tr class="${d.idx === today ? 'today' : ''}"><td>${d.day}</td><td>${esc(d.text)}</td></tr>`).join('')}</table>`
    : p.openingHours ? `<p class="raw-hours">${esc(p.openingHours)}</p>` : '<p class="note">Belum ada data jam buka.</p>'}
      </section>
      ${links ? `<section><h3 class="section-title">Info</h3><div class="info-list">${links}</div></section>` : ''}
      <p class="note">Data dari kontribusi komunitas OpenStreetMap dan bisa belum lengkap. Ada yang salah? <a href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">Perbaiki di OSM</a>.</p>
    </div>`;
  show('detail');
  observeCovers(els.detail);
  els.detail.scrollTop = 0;
  if (pan) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17));
  markers.get(id)?.openPopup();
  if (isMobile() && !pan) setView('list');
  history.replaceState(null, '', shareUrl(p));
}

function closeDetail() {
  selectedId = null;
  show('results');
  render();
  history.replaceState(null, '', location.pathname);
}

function shareUrl(p) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('lat', origin.lat.toFixed(5));
  u.searchParams.set('lon', origin.lon.toFixed(5));
  u.searchParams.set('area', origin.label);
  if (p) u.searchParams.set('tempat', p.id);
  return u.toString();
}

async function share() {
  const p = places.find((x) => x.id === selectedId);
  if (!p) return;
  const url = shareUrl(p);
  const text = `${p.name}: ${p.summary}`;
  try {
    if (navigator.share) await navigator.share({ title: p.name, text, url });
    else { await navigator.clipboard.writeText(url); toast('Tautan disalin'); }
  } catch { /* dibatalkan pengguna */ }
}

function drawRadius(r) {
  radiusCircle?.remove();
  radiusCircle = L.circle([origin.lat, origin.lon], { radius: r, color: '#b8612f', weight: 1, dashArray: '4 6', fillOpacity: 0.03 }).addTo(map);
}

function setOrigin(lat, lon, label, isMe = false) {
  origin = { lat, lon, label };
  selectedId = null;
  meMarker?.remove();
  meMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: isMe ? '<div class="me"></div>' : `<div class="pin sel"><svg><use href="#i-pin"/></svg></div>`, iconSize: isMe ? [18, 18] : [34, 34], iconAnchor: isMe ? [9, 9] : [17, 34] }),
    title: label, zIndexOffset: 1000, interactive: false,
  }).addTo(map);
  map.setView([lat, lon], 15);
  fetchPlaces();
}

function setView(v) {
  els.layout.dataset.view = v;
  els.viewToggle.innerHTML = v === 'map' ? `${icon('list')}<span>Daftar</span>` : `${icon('map')}<span>Peta</span>`;
  if (v === 'map') setTimeout(() => map.invalidateSize(), 50);
}

// ---------- event ----------
function locate() {
  if (!navigator.geolocation) { toast('Browser ini tidak mendukung lokasi'); return; }
  show('results');
  els.list.innerHTML = skeleton(3);
  setStatus('Meminta izin lokasi…');
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin(pos.coords.latitude, pos.coords.longitude, 'lokasimu', true),
    (err) => {
      els.list.innerHTML = '';
      setStatus(err.code === 1 ? 'Izin lokasi ditolak. Cari area lewat kolom pencarian di atas.' : 'Lokasi tidak ditemukan. Coba cari area secara manual.', true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
}

async function searchArea(q) {
  if (!q) return;
  els.q.value = q;
  show('results');
  els.list.innerHTML = skeleton(3);
  setStatus(`Mencari <b>${esc(q)}</b>…`);
  try {
    const hit = await api('geocode', { q });
    if (!hit.found) { els.list.innerHTML = ''; setStatus(`Area <b>${esc(q)}</b> tidak ditemukan. Coba lebih lengkap, mis. "Dago, Bandung".`, true); return; }
    setOrigin(hit.lat, hit.lon, hit.label);
  } catch (e) {
    els.list.innerHTML = '';
    setStatus(`Pencarian area gagal (${esc(e.message)}). Coba lagi sebentar.`, true);
  }
}

els.locate.addEventListener('click', locate);
els.search.addEventListener('submit', (e) => { e.preventDefault(); els.q.blur(); searchArea(els.q.value.trim()); });
els.welcome.addEventListener('click', (e) => {
  const area = e.target.closest('[data-area]')?.dataset.area;
  if (area) searchArea(area);
  if (e.target.closest('[data-action="locate"]')) locate();
});

function toggleFav(id) {
  favorites.has(id) ? favorites.delete(id) : favorites.add(id);
  saveFavorites();
  toast(favorites.has(id) ? 'Disimpan ke favorit' : 'Dihapus dari favorit');
}

els.list.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { toggleFav(fav.dataset.fav); render(); return; }
  if (e.target.closest('a')) return; // tautan atribusi foto
  const card = e.target.closest('.card[data-id]');
  if (card) openDetail(card.dataset.id);
});
els.list.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(card.dataset.id); }
});
els.detail.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { toggleFav(fav.dataset.fav); openDetail(fav.dataset.fav, false); return; }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'back') closeDetail();
  if (action === 'share') share();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.detail.hidden) closeDetail(); });

document.querySelectorAll('input[name="cat"]').forEach((x) => x.addEventListener('change', fetchPlaces));
els.radius.addEventListener('change', fetchPlaces);
[els.openNow, els.wifiOnly, els.outdoorOnly, els.favOnly].forEach((x) => x.addEventListener('change', () => origin && render()));
els.viewToggle.addEventListener('click', () => setView(els.layout.dataset.view === 'map' ? 'list' : 'map'));

// tautan berbagi: ?lat=..&lon=..&area=..&tempat=node/123
const params = new URLSearchParams(location.search);
const pLat = Number(params.get('lat'));
const pLon = Number(params.get('lon'));
if (params.has('lat') && Number.isFinite(pLat) && Number.isFinite(pLon) && Math.abs(pLat) <= 90 && Math.abs(pLon) <= 180) {
  pendingSelect = /^(node|way|relation)\/\d+$/.test(params.get('tempat') ?? '') ? params.get('tempat') : null;
  setOrigin(pLat, pLon, (params.get('area') || 'lokasi yang dibagikan').slice(0, 80));
}
