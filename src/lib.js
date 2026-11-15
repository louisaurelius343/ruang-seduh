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
