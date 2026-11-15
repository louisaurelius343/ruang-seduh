// Fungsi murni (tanpa DOM/jaringan) supaya bisa dites dengan `node --test`.

export const CATEGORIES = {
  kafe: { label: 'Kafe & kedai kopi', filters: ['["amenity"="cafe"]', '["shop"="coffee"]'] },
  makan: { label: 'Tempat makan santai', filters: ['["amenity"="restaurant"]', '["amenity"="fast_food"]'] },
};

/** Jarak dua titik (meter), rumus haversine. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

/** Query Overpass untuk kategori terpilih dalam radius (meter) dari titik. */
export function buildOverpassQuery(lat, lon, radius, categories = ['kafe']) {
  const r = Math.max(100, Math.min(10000, Math.round(radius)));
  const parts = categories
    .flatMap((c) => CATEGORIES[c]?.filters ?? [])
    .map((f) => `nwr${f}(around:${r},${lat.toFixed(6)},${lon.toFixed(6)});`);
  return `[out:json][timeout:25];(${parts.join('')});out center tags 300;`;
}

/** Ubah respons Overpass jadi daftar tempat yang rapi, diurutkan dari yang terdekat. */
export function parsePlaces(osm, originLat, originLon) {
  const seen = new Set();
  const places = [];
  for (const el of osm?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const t = el.tags ?? {};
    if (lat == null || lon == null || !t.name) continue;
    const key = `${t.name.toLowerCase()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const addr = [t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim(),
      t['addr:suburb'] ?? t['addr:village'], t['addr:city']].filter(Boolean).join(', ');
    places.push({
      id: `${el.type}/${el.id}`,
      name: t.name,
      lat, lon,
      kind: t.amenity === 'restaurant' || t.amenity === 'fast_food' ? 'makan' : 'kafe',
      cuisine: t.cuisine?.replace(/;/g, ', ').replace(/_/g, ' '),
      address: addr || null,
      openingHours: t.opening_hours ?? null,
      website: safeUrl(t.website ?? t['contact:website']),
      instagram: t['contact:instagram'] ?? null,
      wifi: t.internet_access === 'wlan' || t.internet_access === 'yes',
      outdoor: t.outdoor_seating === 'yes',
      distance: distanceMeters(originLat, originLon, lat, lon),
    });
  }
  return places.sort((a, b) => a.distance - b.distance);
}

function safeUrl(u) {
  if (!u) return null;
  const s = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try { return new URL(s).protocol.startsWith('http') ? s : null; } catch { return null; }
}

// ---------- jam buka (subset format OSM opening_hours yang paling umum) ----------

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function expandDays(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.trim().split('-');
    const i = DAYS.indexOf(a);
    if (i < 0) return null;
    if (!b) { out.add(i); continue; }
    const j = DAYS.indexOf(b);
    if (j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
  }
  return out;
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/**
 * true = buka, false = tutup, null = tidak diketahui / format tidak didukung.
 * Mendukung: "24/7", "Mo-Fr 08:00-22:00; Sa,Su 09:00-23:00", rentang lewat tengah malam, "off".
 */
export function isOpenAt(spec, date) {
  if (!spec) return null;
  const s = spec.trim();
  if (s === '24/7') return true;
  const day = date.getDay();
  const now = date.getHours() * 60 + date.getMinutes();
  const prevDay = (day + 6) % 7;
  let result = false;
  let understood = false;
  for (const rule of s.split(';').map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)?\s*(.*)$/);
    if (!m) return null;
    const days = m[1] ? expandDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    const times = m[2].trim();
    if (!days) return null;
    if (/^(off|closed)$/i.test(times)) {
      understood = true;
      if (days.has(day)) result = false;
      continue;
    }
    const ranges = times.split(',').map((x) => x.trim());
    if (!ranges.every((x) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}\+?$/.test(x))) return null;
    understood = true;
    let openHere = false;
    let ruleAppliesToday = days.has(day);
    for (const r of ranges) {
      const [a, b] = r.replace('+', '').split('-');
      const start = toMin(a);
      let end = toMin(b);
      if (end <= start) end += 24 * 60; // lewat tengah malam
      if (days.has(day) && now >= start && now < end) openHere = true;
      if (days.has(prevDay) && end > 24 * 60 && now < end - 24 * 60) { openHere = true; ruleAppliesToday = true; }
    }
    // aturan belakangan menimpa aturan sebelumnya untuk hari yang sama (perilaku OSM)
    if (ruleAppliesToday) result = openHere;
  }
  return understood ? result : null;
}

export function directionsUrl(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}`;
}
