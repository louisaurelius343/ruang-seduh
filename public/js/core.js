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

/** Perkiraan jalan kaki (~4,8 km/jam, jarak garis lurus x1,25 untuk belokan jalan). */
export function walkMinutes(m) {
  return Math.max(1, Math.round((m * 1.25) / 80));
}

/** Query Overpass untuk kategori terpilih dalam radius (meter) dari titik. */
export function buildOverpassQuery(lat, lon, radius, categories = ['kafe']) {
  const r = Math.max(100, Math.min(10000, Math.round(radius)));
  const parts = categories
    .flatMap((c) => CATEGORIES[c]?.filters ?? [])
    .map((f) => `nwr${f}(around:${r},${lat.toFixed(6)},${lon.toFixed(6)});`);
  return `[out:json][timeout:25];(${parts.join('')});out center tags 300;`;
}

// ---------- fasilitas, foto, deskripsi ----------

const yes = (v) => v === 'yes' || v === 'only' || v === 'designated';

/** Daftar fasilitas yang bisa ditampilkan sebagai ikon. */
export function amenities(t) {
  const out = [];
  if (t.internet_access === 'wlan' || t.internet_access === 'yes') out.push({ key: 'wifi', label: 'WiFi' });
  if (yes(t.outdoor_seating)) out.push({ key: 'outdoor', label: 'Area outdoor' });
  if (t.smoking === 'no' || t.smoking === 'outside') out.push({ key: 'nosmoke', label: t.smoking === 'no' ? 'Bebas rokok' : 'Rokok di luar' });
  if (yes(t.air_conditioning)) out.push({ key: 'ac', label: 'Ber-AC' });
  if (yes(t.takeaway)) out.push({ key: 'takeaway', label: 'Bisa dibawa pulang' });
  if (yes(t.delivery)) out.push({ key: 'delivery', label: 'Pesan antar' });
  if (yes(t.wheelchair)) out.push({ key: 'wheelchair', label: 'Ramah kursi roda' });
  if (yes(t['payment:qris']) || yes(t['payment:cards']) || yes(t['payment:credit_cards']) || yes(t['payment:debit_cards']))
    out.push({ key: 'card', label: yes(t['payment:qris']) ? 'QRIS' : 'Bayar kartu' });
  if (yes(t['diet:vegetarian']) || yes(t['diet:vegan'])) out.push({ key: 'veg', label: 'Pilihan vegetarian' });
  return out;
}

/**
 * Sumber foto dari tag OSM. Prioritas: image (URL langsung) > wikimedia_commons > wikidata.
 * Wikidata perlu satu panggilan API lagi untuk mendapatkan nama file (P18).
 */
export function photoSource(t) {
  const img = t.image?.trim();
  if (img && /^https:\/\//i.test(img) && !/\s/.test(img)) {
    const m = img.match(/commons\.wikimedia\.org\/wiki\/(File:.+)$/i);
    return m ? { type: 'commons', file: decodeURIComponent(m[1]) } : { type: 'url', url: img };
  }
  const c = t.wikimedia_commons?.trim();
  if (c && /^File:/i.test(c)) return { type: 'commons', file: c };
  const q = t.wikidata?.trim();
  if (q && /^Q\d+$/.test(q)) return { type: 'wikidata', id: q };
  return null;
}

export function commonsThumb(file, width = 640) {
  const name = file.replace(/^File:/i, '').replace(/ /g, '_');
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`;
}

/** Warna sampul (0-7) yang konsisten untuk nama yang sama. */
export function coverIndex(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 8;
}

const KIND_WORD = { kafe: 'Kafe', coffee: 'Kedai kopi', makan: 'Tempat makan', fast_food: 'Tempat makan cepat saji' };
const FAC_PHRASE = { wifi: 'WiFi', outdoor: 'area outdoor', ac: 'ruangan ber-AC' };
const CUISINE_ID = {
  indonesian: 'masakan Indonesia', regional: 'masakan daerah', sundanese: 'masakan Sunda', javanese: 'masakan Jawa',
  padang: 'masakan Padang', chinese: 'masakan Tionghoa', japanese: 'masakan Jepang', korean: 'masakan Korea',
  western: 'menu western', italian: 'masakan Italia', noodle: 'mi', ramen: 'ramen', chicken: 'ayam', fried_chicken: 'ayam goreng',
  burger: 'burger', pizza: 'piza', seafood: 'hidangan laut', bakery: 'roti', cake: 'kue', dessert: 'hidangan penutup',
  ice_cream: 'es krim', tea: 'teh', bubble_tea: 'boba', juice: 'jus', breakfast: 'sarapan', sandwich: 'roti lapis',
  coffee: 'kopi', satay: 'sate', bakso: 'bakso', vegetarian: 'menu vegetarian',
};
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} dan ${xs.at(-1)}` : xs[0]);

/** Kalimat deskripsi singkat dari data yang ada (tanpa mengarang). */
export function describe(p) {
  if (p.description) return p.description;
  const base = KIND_WORD[p.subtype] ?? KIND_WORD[p.kind] ?? 'Tempat';
  const bits = [];
  const dishes = (p.cuisineKeys ?? []).map((k) => CUISINE_ID[k]).filter(Boolean).filter((d) => !(d === 'kopi' && p.subtype === 'coffee'));
  if (dishes.length) bits.push(`menyajikan ${list(dishes.slice(0, 3))}`);
  const fac = p.amenities.map((a) => FAC_PHRASE[a.key]).filter(Boolean);
  if (p.amenities.some((a) => a.key === 'nosmoke' && a.label === 'Bebas rokok')) fac.push('area bebas rokok');
  if (fac.length) bits.push(`dengan ${list(fac)}`);
  let s = `${base}${bits.length ? ' ' + bits.join(' ') : ''}`;
  if (p.amenities.some((a) => a.key === 'wifi')) s += ', cocok untuk kerja atau belajar';
  s += '.';
  if (p.area) s += ` Berada di ${p.area}.`;
  return s;
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
    const street = t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim();
    const area = t['addr:suburb'] ?? t['addr:village'] ?? t['addr:district'] ?? null;
    const addr = [street, area, t['addr:city']].filter(Boolean).join(', ');
    const kind = t.amenity === 'restaurant' || t.amenity === 'fast_food' ? 'makan' : 'kafe';
    const p = {
      id: `${el.type}/${el.id}`,
      name: t.name,
      lat, lon, kind,
      subtype: t.shop === 'coffee' || /coffee/.test(t.cuisine ?? '') ? 'coffee' : t.amenity === 'fast_food' ? 'fast_food' : kind,
      cuisine: t.cuisine ? t.cuisine.split(';').map((c) => c.trim().replace(/_/g, ' ')).filter((c) => c !== 'coffee shop').join(', ') || null : null,
      cuisineKeys: t.cuisine ? t.cuisine.split(';').map((c) => c.trim().toLowerCase()).filter((c) => c !== 'coffee_shop') : [],
      description: t['description:id'] ?? t.description ?? null,
      address: addr || null,
      area: area ?? t['addr:city'] ?? null,
      openingHours: t.opening_hours ?? null,
      website: safeUrl(t.website ?? t['contact:website']),
      instagram: igHandle(t['contact:instagram'] ?? t.instagram),
      phone: t.phone ?? t['contact:phone'] ?? null,
      amenities: amenities(t),
      photo: photoSource(t),
      cover: coverIndex(t.name),
      distance: distanceMeters(originLat, originLon, lat, lon),
    };
    p.wifi = p.amenities.some((a) => a.key === 'wifi');
    p.outdoor = p.amenities.some((a) => a.key === 'outdoor');
    p.summary = describe(p);
    places.push(p);
  }
  return places.sort((a, b) => a.distance - b.distance);
}

function safeUrl(u) {
  if (!u) return null;
  const s = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try { return new URL(s).protocol.startsWith('http') ? s : null; } catch { return null; }
}

function igHandle(v) {
  if (!v) return null;
  const m = String(v).match(/(?:instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?$/);
  return m ? m[1] : null;
}

// ---------- jam buka (subset format OSM opening_hours yang paling umum) ----------

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

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
const fmtMin = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}.${String(m % 60).padStart(2, '0')}`;

/**
 * Jadwal mingguan: array 7 hari (0=Minggu), masing-masing daftar rentang [mulai, selesai] dalam menit
 * (selesai bisa > 1440 kalau lewat tengah malam). null kalau format tidak didukung.
 */
export function parseHours(spec) {
  if (!spec) return null;
  const s = spec.trim();
  const week = Array.from({ length: 7 }, () => []);
  if (s === '24/7') return week.map(() => [[0, 1440]]);
  for (const rule of s.split(';').map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)?\s*(.*)$/);
    if (!m) return null;
    const days = m[1] ? expandDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const times = m[2].trim();
    if (/^(off|closed)$/i.test(times)) { days.forEach((d) => { week[d] = []; }); continue; }
    const ranges = times.split(',').map((x) => x.trim());
    if (!ranges.every((x) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}\+?$/.test(x))) return null;
    const parsed = ranges.map((r) => {
      const [a, b] = r.replace('+', '').split('-');
      const start = toMin(a);
      let end = toMin(b);
      if (end <= start) end += 1440;
      return [start, end];
    });
    days.forEach((d) => { week[d] = parsed; }); // aturan belakangan menimpa (perilaku OSM)
  }
  return week;
}

/** true = buka, false = tutup, null = tidak diketahui / format tidak didukung. */
export function isOpenAt(spec, date) {
  return openStatus(spec, date).open;
}

/** Status lengkap: {open, label} mis. "Buka · tutup 21.00", "Tutup · buka 10.00", "Buka 24 jam". */
export function openStatus(spec, date) {
  const week = parseHours(spec);
  if (!week) return { open: null, label: null };
  const day = date.getDay();
  const now = date.getHours() * 60 + date.getMinutes();
  if (week.every((r) => r.length === 1 && r[0][0] === 0 && r[0][1] >= 1440)) return { open: true, label: 'Buka 24 jam' };
  // rentang aktif: hari ini, atau kemarin yang lewat tengah malam
  for (const [s, e] of week[day]) if (now >= s && now < e) return { open: true, label: `Buka · tutup ${fmtMin(e)}` };
  for (const [, e] of week[(day + 6) % 7]) if (e > 1440 && now < e - 1440) return { open: true, label: `Buka · tutup ${fmtMin(e)}` };
  const later = week[day].filter(([s]) => s > now).map(([s]) => s).sort((a, b) => a - b)[0];
  if (later != null) return { open: false, label: `Tutup · buka ${fmtMin(later)}` };
  for (let k = 1; k <= 7; k++) {
    const d = (day + k) % 7;
    if (week[d].length) {
      const s = Math.min(...week[d].map((r) => r[0]));
      return { open: false, label: `Tutup · buka ${k === 1 ? 'besok' : DAY_NAMES[d]} ${fmtMin(s)}` };
    }
  }
  return { open: false, label: 'Tutup' };
}

/** Jadwal untuk ditampilkan per hari, mulai Senin. */
export function weeklyTable(spec) {
  const week = parseHours(spec);
  if (!week) return null;
  return [1, 2, 3, 4, 5, 6, 0].map((d) => ({
    day: DAY_NAMES[d], idx: d,
    text: week[d].length ? week[d].map(([s, e]) => (s === 0 && e >= 1440 ? '24 jam' : `${fmtMin(s)}–${fmtMin(e)}`)).join(', ') : 'Tutup',
  }));
}

export function directionsUrl(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}`;
}
