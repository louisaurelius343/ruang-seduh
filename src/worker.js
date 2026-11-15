// Worker Ruang Seduh: menyajikan situs statis + API kecil dengan cache bersama di edge Cloudflare.
//   GET /api/places?lat&lon&r&cats   -> data tempat (Overpass), cache 24 jam lintas pengguna
//   GET /api/geocode?q               -> nama area -> koordinat (Nominatim), cache 7 hari
// Semua rute lain diteruskan ke aset statis (public/).
import {
  OVERPASS, UA, PLACES_TTL, GEOCODE_TTL, PHOTO_TTL, placesParams, placesCacheKey, overpassQuery, geocodeParams, slimOverpass,
  createLimiter, photoParams, bbox, pickPhoto,
} from './lib.js';

const perIp = createLimiter({ capacity: 20, refillPerSec: 0.2 });   // 20 permintaan beruntun, lalu 12/menit
const photoPerIp = createLimiter({ capacity: 40, refillPerSec: 1 }); // foto dimuat per kartu, jadi lebih longgar
const toNominatim = createLimiter({ capacity: 1, refillPerSec: 1 }); // kebijakan Nominatim: maks 1 req/detik

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...extra },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return json({ error: 'metode tidak didukung' }, 405);
    try {
      if (url.pathname === '/api/places') return await places(request, url, ctx);
      if (url.pathname === '/api/geocode') return await geocode(request, url, ctx);
      if (url.pathname === '/api/photo') return await photo(request, url, ctx, env);
      return json({ error: 'tidak ditemukan' }, 404);
    } catch (e) {
      return json({ error: e.message || 'kesalahan server' }, 502);
    }
  },
};

const clientIp = (req) => req.headers.get('cf-connecting-ip') ?? 'anon';

async function cached(key) {
  return caches.default.match(new Request(key));
}
function store(ctx, key, body, ttl) {
  const res = new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}` } });
  ctx.waitUntil(caches.default.put(new Request(key), res));
}

async function places(request, url, ctx) {
  const p = placesParams(url.searchParams);
  if (p.error) return json({ error: p.error }, 400);
  const key = placesCacheKey(p);
  const hit = await cached(key);
  if (hit) return json(await hit.json(), 200, { 'x-cache': 'HIT', 'cache-control': 'public, max-age=3600' });
  // cache=only: cek cache saja (cepat). Overpass sering menolak IP Cloudflare, jadi browser yang bertanya langsung.
  if (url.searchParams.get('cache') === 'only') return json({ cached: false }, 404, { 'x-cache': 'MISS' });
  if (!perIp(clientIp(request))) return json({ error: 'terlalu banyak permintaan, coba lagi sebentar' }, 429, { 'retry-after': '10' });

  const osm = slimOverpass(await hedgedOverpass(overpassQuery(p)));
  const body = JSON.stringify(osm);
  store(ctx, key, body, PLACES_TTL);
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'MISS', 'cache-control': 'public, max-age=3600' } });
}

/**
 * "Hedged request": tanya server pertama; kalau belum menjawab dalam 6 detik (atau gagal),
 * baru tanya server berikutnya. Biasanya hanya SATU server yang ditanya.
 */
async function hedgedOverpass(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // lebih cepat gagal -> browser pakai jalur cadangan
  const body = new URLSearchParams({ data: query });
  const ask = async (endpoint) => {
    const res = await fetch(endpoint, { method: 'POST', body, signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.elements)) throw new Error('format overpass tidak dikenal');
    return data;
  };
  try {
    return await new Promise((resolve, reject) => {
      const errs = [];
      let started = 0;
      let failed = 0;
      let next = null;
      const launch = () => {
        if (started >= OVERPASS.length) return;
        const endpoint = OVERPASS[started++];
        clearTimeout(next);
        next = setTimeout(launch, 5000);
        ask(endpoint).then(resolve, (e) => {
          failed += 1;
          errs.push(`${new URL(endpoint).hostname}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
          if (failed === OVERPASS.length) reject(new Error(`server data peta sedang sibuk (${errs.join('; ')})`));
          else if (failed === started) launch(); // gagal cepat -> langsung coba berikutnya
        });
      };
      launch();
    });
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function geocode(request, url, ctx) {
  const g = geocodeParams(url.searchParams);
  if (g.error) return json({ error: g.error }, 400);
  const hit = await cached(g.key);
  if (hit) return json(await hit.json(), 200, { 'x-cache': 'HIT' });
  if (!perIp(clientIp(request))) return json({ error: 'terlalu banyak permintaan, coba lagi sebentar' }, 429, { 'retry-after': '10' });
  if (!toNominatim('global')) return json({ error: 'pencarian sedang ramai, coba lagi sebentar' }, 429, { 'retry-after': '2' });

  const q = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'id', 'accept-language': 'id', q: g.q });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { 'user-agent': UA, referer: 'https://ruangseduh.cloud/' } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const [hit0] = await res.json();
  const out = hit0
    // Label = teks yang diketik pengguna; Nominatim kadang mengembalikan nama gedung/hotel di area itu.
    ? { found: true, lat: Number(hit0.lat), lon: Number(hit0.lon), label: g.q }
    : { found: false };
  store(ctx, g.key, JSON.stringify(out), out.found ? GEOCODE_TTL : 3600);
  return json(out, 200, { 'x-cache': 'MISS' });
}

/** Foto jalan terdekat dari Mapillary (token disimpan sebagai secret MAPILLARY_TOKEN, tidak pernah ke browser). */
async function photo(request, url, ctx, env) {
  const p = photoParams(url.searchParams);
  if (p.error) return json({ error: p.error }, 400);
  if (!env.MAPILLARY_TOKEN) return json({ found: false, reason: 'tidak dikonfigurasi' }, 200, { 'cache-control': 'public, max-age=3600' });
  const hit = await cached(p.key);
  if (hit) return json(await hit.json(), 200, { 'x-cache': 'HIT', 'cache-control': 'public, max-age=3600' });
  if (!photoPerIp(clientIp(request))) return json({ error: 'terlalu banyak permintaan' }, 429, { 'retry-after': '5' });

  const q = new URLSearchParams({
    fields: 'id,thumb_1024_url,thumb_256_url,captured_at,compass_angle,computed_compass_angle,computed_geometry,geometry',
    bbox: bbox(p.lat, p.lon, 120).join(','),
    limit: '50',
  });
  const res = await fetch(`https://graph.mapillary.com/images?${q}`, {
    headers: { authorization: `OAuth ${env.MAPILLARY_TOKEN}`, 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`mapillary ${res.status}`);
  const data = (await res.json()).data ?? [];
  const best = pickPhoto(data, p.lat, p.lon);
  const out = best ?? { found: false, checked: data.length }; // checked: jumlah foto Mapillary di sekitar sebelum disaring
  if (best) out.found = true;
  store(ctx, p.key, JSON.stringify(out), best ? PHOTO_TTL : 24 * 3600); // hasil kosong: 1 hari
  return json(out, 200, { 'x-cache': 'MISS', 'cache-control': 'public, max-age=3600' });
}