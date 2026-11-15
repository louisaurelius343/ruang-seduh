import { buildOverpassQuery, parsePlaces, isOpenAt, formatDistance, directionsUrl } from './core.js';

// Server Overpass publik kadang penuh; semua ditanya bersamaan, jawaban sukses pertama yang dipakai.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CACHE_KEY = 'ruangseduh.cache.v1';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_VIEW = [-6.2, 106.8167]; // Jakarta
const FAV_KEY = 'ruangseduh.favorit';

const $ = (s) => document.querySelector(s);
const els = {
  status: $('#status'), list: $('#list'), radius: $('#radius'), openNow: $('#openNow'),
  wifiOnly: $('#wifiOnly'), favOnly: $('#favOnly'), locate: $('#locate'), search: $('#search'), q: $('#q'),
};

let origin = null;        // {lat, lon, label}
let places = [];
let selectedId = null;
let favorites = loadFavorites();
let markers = new Map();

// ---------- peta ----------
const map = L.map('map', { zoomControl: true }).setView(DEFAULT_VIEW, 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let meMarker = null;
let radiusCircle = null;

const pinIcon = (kind, sel) => L.divIcon({
  className: '', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
  html: `<div class="pin ${kind}${sel ? ' sel' : ''}"><span>${kind === 'makan' ? '🍜' : '☕'}</span></div>`,
});

// ---------- util ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(html, err = false) { els.status.innerHTML = html; els.status.classList.toggle('err', err); }
function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); }
}
function saveFavorites() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* mode privat */ }
}
const categories = () => [...document.querySelectorAll('input[name="cat"]:checked')].map((x) => x.value);

// ---------- data ----------
async function fetchPlaces() {
  if (!origin) return;
  const cats = categories();
  if (!cats.length) { places = []; render(); setStatus('Pilih minimal satu kategori.'); return; }
  const radius = Number(els.radius.value);
  setStatus(`Mencari tempat dalam ${radius / 1000} km dari <b>${esc(origin.label)}</b>…`);
  els.locate.disabled = true;
  const query = buildOverpassQuery(origin.lat, origin.lon, radius, cats);
  const key = `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}|${radius}|${cats.join('+')}`;
  const ticket = ++requestSeq;
  try {
    const osm = readCache(key) ?? await queryOverpass(query);
    if (ticket !== requestSeq) return; // sudah ada pencarian yang lebih baru
    writeCache(key, osm);
    places = parsePlaces(osm, origin.lat, origin.lon);
    drawRadius(radius);
    render(true);
  } catch (e) {
    if (ticket !== requestSeq) return;
    setStatus(`Server data peta sedang sibuk (${esc(e.message)}). <button type="button" class="btn" id="retry">Coba lagi</button>`, true);
    $('#retry')?.addEventListener('click', fetchPlaces);
  } finally {
    if (ticket === requestSeq) els.locate.disabled = false;
  }
}

let requestSeq = 0;

async function queryOverpass(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35000);
  const body = new URLSearchParams({ data: query });
  try {
    return await Promise.any(OVERPASS.map(async (url) => {
      const res = await fetch(url, { method: 'POST', body, signal: ctrl.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('format tidak dikenal');
      return json;
    })).finally(() => ctrl.abort()); // hentikan server lain setelah ada yang menjawab
  } catch (e) {
    throw new Error(ctrl.signal.aborted && !(e instanceof AggregateError) ? 'waktu habis' : 'semua server gagal');
  } finally {
    clearTimeout(timer);
  }
}

function readCache(key) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const hit = all[key];
    return hit && Date.now() - hit.t < CACHE_TTL ? hit.osm : null;
  } catch { return null; }
}

function writeCache(key, osm) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[key] = { t: Date.now(), osm };
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(0, 15); // simpan 15 area terakhir
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, all[k]]))));
  } catch { /* penyimpanan penuh atau mode privat: abaikan */ }
}

function filtered() {
  const now = new Date();
  return places.filter((p) => {
    if (els.openNow.checked && isOpenAt(p.openingHours, now) !== true) return false;
    if (els.wifiOnly.checked && !p.wifi) return false;
    if (els.favOnly.checked && !favorites.has(p.id)) return false;
    return true;
  });
}

// ---------- tampilan ----------
function render(fit = false) {
  const items = filtered();
  const now = new Date();
  layer.clearLayers();
  markers = new Map();
  for (const p of items) {
    const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.kind, p.id === selectedId), title: p.name })
      .bindPopup(`<b>${esc(p.name)}</b><br>${formatDistance(p.distance)} · <a href="${directionsUrl(p)}" target="_blank" rel="noopener">Arahkan</a>`)
      .on('click', () => select(p.id, false));
    m.addTo(layer);
    markers.set(p.id, m);
  }

  els.list.innerHTML = items.map((p) => {
    const open = isOpenAt(p.openingHours, now);
    const status = open === true ? '<span class="tag open">Buka</span>' : open === false ? '<span class="tag closed">Tutup</span>' : '';
    const fav = favorites.has(p.id);
    return `<li class="card${p.id === selectedId ? ' active' : ''}" data-id="${esc(p.id)}">
      <div class="card-top"><h3>${esc(p.name)}</h3><span class="dist">${formatDistance(p.distance)}</span></div>
      <div class="meta">${esc(p.address || (p.kind === 'makan' ? 'Tempat makan' : 'Kafe'))}${p.cuisine ? ` · ${esc(p.cuisine)}` : ''}
        ${p.openingHours ? `<br>🕒 ${esc(p.openingHours)}` : ''}</div>
      <div class="tags">${status}${p.wifi ? '<span class="tag">WiFi</span>' : ''}${p.outdoor ? '<span class="tag">Outdoor</span>' : ''}</div>
      <div class="actions">
        <a class="go" href="${directionsUrl(p)}" target="_blank" rel="noopener">Arahkan</a>
        ${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener nofollow">Situs</a>` : ''}
        <button type="button" class="fav${fav ? ' on' : ''}" data-fav="${esc(p.id)}" aria-pressed="${fav}">${fav ? '★ Favorit' : '☆ Simpan'}</button>
      </div></li>`;
  }).join('');

  const hidden = places.length - items.length;
  if (!places.length) setStatus(`Belum ada tempat yang tercatat di sekitar <b>${esc(origin?.label ?? '')}</b>. Coba perbesar radius.`);
  else setStatus(`<b>${items.length}</b> tempat di sekitar <b>${esc(origin.label)}</b>${hidden ? ` (${hidden} disembunyikan filter)` : ''}.`);

  if (fit && items.length) {
    const b = L.latLngBounds(items.map((p) => [p.lat, p.lon])).extend([origin.lat, origin.lon]);
    map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
  }
}

function select(id, pan = true) {
  selectedId = id;
  const p = places.find((x) => x.id === id);
  render();
  const card = els.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (p && pan) { map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16)); markers.get(id)?.openPopup(); }
}

function drawRadius(r) {
  radiusCircle?.remove();
  radiusCircle = L.circle([origin.lat, origin.lon], { radius: r, color: '#c66b3d', weight: 1, fillOpacity: 0.04 }).addTo(map);
}

function setOrigin(lat, lon, label, isMe = false) {
  origin = { lat, lon, label };
  selectedId = null;
  meMarker?.remove();
  meMarker = L.marker([lat, lon], {
    icon: isMe ? L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
      : pinIcon('kafe', true),
    title: label, zIndexOffset: 1000,
  }).addTo(map);
  map.setView([lat, lon], 15);
  fetchPlaces();
}

// ---------- event ----------
els.locate.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Browser ini tidak mendukung lokasi. Cari area secara manual.', true); return; }
  setStatus('Meminta izin lokasi…');
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin(pos.coords.latitude, pos.coords.longitude, 'lokasimu', true),
    (err) => setStatus(err.code === 1 ? 'Izin lokasi ditolak. Cari area lewat kolom pencarian.' : 'Lokasi tidak bisa ditemukan. Coba cari area secara manual.', true),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
});

els.search.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (!q) return;
  setStatus(`Mencari <b>${esc(q)}</b>…`);
  try {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=id&accept-language=id&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const [hit] = await res.json();
    if (!hit) { setStatus(`Area <b>${esc(q)}</b> tidak ditemukan. Coba tulis lebih lengkap, mis. "Dago, Bandung".`, true); return; }
    setOrigin(Number(hit.lat), Number(hit.lon), hit.display_name.split(',').slice(0, 2).join(','));
  } catch {
    setStatus('Pencarian area gagal. Periksa koneksi lalu coba lagi.', true);
  }
});

els.list.addEventListener('click', (e) => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    const id = favBtn.dataset.fav;
    favorites.has(id) ? favorites.delete(id) : favorites.add(id);
    saveFavorites();
    render();
    return;
  }
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (card) select(card.dataset.id);
});

document.querySelectorAll('input[name="cat"]').forEach((x) => x.addEventListener('change', fetchPlaces));
els.radius.addEventListener('change', fetchPlaces);
[els.openNow, els.wifiOnly, els.favOnly].forEach((x) => x.addEventListener('change', () => origin && render()));
