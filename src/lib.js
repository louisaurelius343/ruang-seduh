// Fungsi murni untuk Worker (bisa dites dengan node --test, tanpa API Cloudflare).
import { buildOverpassQuery } from '../public/js/core.js';

export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const UA = 'ruangseduh/2.1 (+https://ruangseduh.cloud)';
export const RADII = [500, 1000, 2000, 5000];
export const PLACES_TTL = 24 * 3600;      // detik
export const GEOCODE_TTL = 7 * 24 * 3600;

/** Validasi & normalisasi parameter /api/places. Koordinat dibulatkan ~100 m (privasi + rasio cache). */
export function placesParams(sp) {
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { error: 'lat/lon tidak valid' };
  }
  // Layanan ini untuk Indonesia; tolak koordinat jauh di luar (mencegah dipakai sebagai proxy umum).
  if (lat < -12 || lat > 7 || lon < 94 || lon > 142) return { error: 'di luar wilayah Indonesia' };
  const r = Number(sp.get('r') ?? 2000);
  const radius = RADII.includes(r) ? r : 2000;
  const cats = (sp.get('cats') ?? 'kafe').split(',').filter((c) => c === 'kafe' || c === 'makan');
  const categories = [...new Set(cats.length ? cats : ['kafe'])].sort();
  return {
    lat: Math.round(lat * 1000) / 1000,
    lon: Math.round(lon * 1000) / 1000,
    radius, categories,
  };
}

export function placesCacheKey(p) {
  return `https://cache.ruangseduh.cloud/places/v1/${p.lat.toFixed(3)}/${p.lon.toFixed(3)}/${p.radius}/${p.categories.join('+')}`;
}

export function overpassQuery(p) {
  return buildOverpassQuery(p.lat, p.lon, p.radius, p.categories);
}

/** Validasi /api/geocode: teks pendek saja. */
export function geocodeParams(sp) {
  const q = (sp.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 100) return { error: 'kata pencarian 2-100 karakter' };
  return { q, key: `https://cache.ruangseduh.cloud/geocode/v1/${encodeURIComponent(q.toLowerCase())}` };
}

/** Pangkas respons Overpass: hanya elemen bernama + tag yang dipakai situs (hemat cache & bandwidth). */
const KEEP = /^(name|amenity|shop|cuisine|opening_hours|website|contact:website|contact:instagram|instagram|phone|contact:phone|description|description:id|internet_access|outdoor_seating|smoking|air_conditioning|takeaway|delivery|wheelchair|payment:.*|diet:.*|image|wikimedia_commons|wikidata|addr:.*)$/;
export function slimOverpass(osm) {
  const elements = [];
  for (const el of osm?.elements ?? []) {
    if (!el.tags?.name) continue;
    const tags = {};
    for (const [k, v] of Object.entries(el.tags)) if (KEEP.test(k)) tags[k] = v;
    const out = { type: el.type, id: el.id, tags };
    if (el.lat != null) { out.lat = el.lat; out.lon = el.lon; } else if (el.center) out.center = el.center;
    elements.push(out);
  }
  return { elements };
}

export const PHOTO_TTL = 12 * 3600; // URL thumbnail Mapillary bertanda tangan & bisa kedaluwarsa

/** Validasi /api/photo: koordinat tempat (dibulatkan ~10 m untuk kunci cache). */
export function photoParams(sp) {
  const lat = Number(sp.get('lat'));
  const lon = Number(sp.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -12 || lat > 7 || lon < 94 || lon > 142) return { error: 'lat/lon tidak valid' };
  const rl = Math.round(lat * 1e4) / 1e4;
  const ro = Math.round(lon * 1e4) / 1e4;
  return { lat: rl, lon: ro, key: `https://cache.ruangseduh.cloud/photo/v2/${rl.toFixed(4)}/${ro.toFixed(4)}` };
}

/** Kotak pencarian ~d meter di sekitar titik: [minLon, minLat, maxLon, maxLat]. */
export function bbox(lat, lon, d = 60) {
  const dLat = d / 111320;
  const dLon = d / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((x) => Number(x.toFixed(6)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/**
 * Pilih foto Mapillary terbaik untuk sebuah tempat: dekat, kamera menghadap ke tempat itu, dan tidak terlalu tua.
 * images: [{id, thumb_1024_url, captured_at, compass_angle, computed_geometry:{coordinates:[lon,lat]}}]
 */
export function pickPhoto(images, lat, lon, nowMs = Date.now()) {
  let best = null;
  for (const im of images ?? []) {
    const c = im.computed_geometry?.coordinates ?? im.geometry?.coordinates;
    const url = im.thumb_1024_url ?? im.thumb_2048_url ?? im.thumb_256_url;
    if (!url || !c) continue;
    const [ilon, ilat] = c;
    const dy = (lat - ilat) * 111320;
    const dx = (lon - ilon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dist = Math.hypot(dx, dy);
    if (dist > 120) continue;
    let angle = 90; // tanpa arah kamera: anggap sedang
    const heading = im.computed_compass_angle ?? im.compass_angle;
    if (typeof heading === 'number' && dist > 3) {
      angle = Math.abs(((bearing(ilat, ilon, lat, lon) - heading + 540) % 360) - 180);
    }
    if (angle > 135) continue; // kamera jelas membelakangi tempat
    const years = im.captured_at ? (nowMs - im.captured_at) / (365.25 * 864e5) : 5;
    const score = dist + angle * 0.3 + Math.max(0, years - 3) * 4;
    im.url = url;
    if (!best || score < best.score) best = { score, id: im.id, url: im.url, captured: im.captured_at ?? null };
  }
  return best && { id: best.id, url: best.url, captured: best.captured, source: 'mapillary' };
}

/**
 * Pembatas laju sederhana per IP (token bucket di memori isolate).
 * Bukan jaminan global, tapi menahan satu klien yang membanjiri satu lokasi edge.
 */
export function createLimiter({ capacity, refillPerSec, now = () => Date.now() }) {
  const buckets = new Map();
  return function allow(key) {
    const t = now();
    const b = buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
    return ok;
  };
}
