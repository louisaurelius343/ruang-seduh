import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters, formatDistance, walkMinutes, buildOverpassQuery, parsePlaces, isOpenAt, openStatus,
  weeklyTable, photoSource, commonsThumb, coverIndex, amenities, describe,
} from '../public/js/core.js';

const at = (iso) => new Date(iso); // waktu lokal mesin

test('jarak haversine & jalan kaki', () => {
  const d = distanceMeters(-6.1754, 106.8272, -6.1950, 106.8230); // Monas -> Bundaran HI ~2,2 km
  assert.ok(d > 2000 && d < 2400, `d=${d}`);
  assert.equal(distanceMeters(1, 1, 1, 1), 0);
  assert.equal(walkMinutes(320), 5);
  assert.equal(walkMinutes(10), 1);
});

test('format jarak', () => {
  assert.equal(formatDistance(234), '230 m');
  assert.equal(formatDistance(1530), '1,5 km');
  assert.equal(formatDistance(12400), '12 km');
});

test('query overpass dibatasi dan berisi kategori', () => {
  const q = buildOverpassQuery(-6.2, 106.8, 99999, ['kafe', 'makan']);
  assert.match(q, /around:10000,/);
  assert.match(q, /"amenity"="cafe"/);
  assert.match(q, /"amenity"="restaurant"/);
  assert.doesNotMatch(buildOverpassQuery(-6.2, 106.8, 1000), /restaurant/);
});

test('parsePlaces: buang tanpa nama, dedup, urut jarak, url aman, ringkasan', () => {
  const osm = { elements: [
    { type: 'node', id: 1, lat: -6.21, lon: 106.8, tags: { amenity: 'cafe', name: 'Jauh' } },
    { type: 'node', id: 2, lat: -6.2001, lon: 106.8, tags: { amenity: 'cafe', name: 'Dekat', website: 'kopi.id', internet_access: 'wlan', outdoor_seating: 'yes', 'addr:suburb': 'Coblong', 'contact:instagram': 'https://instagram.com/kopi.dekat/' } },
    { type: 'way', id: 3, center: { lat: -6.2001, lon: 106.8 }, tags: { amenity: 'cafe', name: 'Dekat' } },
    { type: 'node', id: 4, lat: -6.2, lon: 106.8, tags: { amenity: 'cafe' } },
    { type: 'node', id: 5, lat: -6.205, lon: 106.8, tags: { amenity: 'restaurant', name: 'Warung', website: 'javascript:alert(1)', cuisine: 'indonesian;noodle' } },
  ] };
  const p = parsePlaces(osm, -6.2, 106.8);
  assert.deepEqual(p.map((x) => x.name), ['Dekat', 'Warung', 'Jauh']);
  assert.equal(p[0].website, 'https://kopi.id');
  assert.equal(p[0].instagram, 'kopi.dekat');
  assert.equal(p[0].wifi, true);
  assert.match(p[0].summary, /^Kafe dengan WiFi dan area outdoor, cocok untuk kerja atau belajar\. Berada di Coblong\.$/);
  assert.equal(p[1].kind, 'makan');
  assert.equal(p[1].website, null);
  assert.equal(p[1].cuisine, 'indonesian, noodle');
  assert.match(p[1].summary, /^Tempat makan menyajikan masakan Indonesia dan mi\.$/);
});

test('deskripsi asli dari OSM diutamakan', () => {
  assert.equal(describe({ description: 'Kopi susu gula aren.', amenities: [] }), 'Kopi susu gula aren.');
});

test('fasilitas', () => {
  const a = amenities({ smoking: 'no', 'payment:qris': 'yes', wheelchair: 'yes', takeaway: 'yes' }).map((x) => x.key);
  assert.deepEqual(a, ['nosmoke', 'takeaway', 'wheelchair', 'card']);
});

test('sumber foto', () => {
  assert.deepEqual(photoSource({ image: 'https://contoh.id/a.jpg' }), { type: 'url', url: 'https://contoh.id/a.jpg' });
  assert.deepEqual(photoSource({ image: 'http://tidak-aman.id/a.jpg' }), null);
  assert.deepEqual(photoSource({ image: 'https://commons.wikimedia.org/wiki/File:Kopi%20A.jpg' }), { type: 'commons', file: 'File:Kopi A.jpg' });
  assert.deepEqual(photoSource({ wikimedia_commons: 'File:B.jpg' }), { type: 'commons', file: 'File:B.jpg' });
  assert.deepEqual(photoSource({ wikidata: 'Q123' }), { type: 'wikidata', id: 'Q123' });
  assert.equal(photoSource({}), null);
  assert.equal(commonsThumb('File:Kopi A.jpg', 400), 'https://commons.wikimedia.org/wiki/Special:FilePath/Kopi_A.jpg?width=400');
  assert.equal(coverIndex('La Krema'), coverIndex('La Krema'));
  assert.ok(coverIndex('x') >= 0 && coverIndex('x') < 8);
});

test('jam buka: format umum', () => {
  const rabu10 = at('2026-11-18T10:00:00'); // Rabu
  const rabu23 = at('2026-11-18T23:30:00');
  assert.equal(isOpenAt('24/7', rabu23), true);
  assert.equal(isOpenAt('Mo-Fr 08:00-22:00', rabu10), true);
  assert.equal(isOpenAt('Mo-Fr 08:00-22:00', rabu23), false);
  assert.equal(isOpenAt('Sa,Su 09:00-23:00', rabu10), false);
  assert.equal(isOpenAt('Mo-Su 08:00-12:00,16:00-22:00', at('2026-11-18T14:00:00')), false);
  assert.equal(isOpenAt('Mo-Su 10:00-22:00; We off', rabu10), false);
  assert.equal(isOpenAt('08:00-22:00', rabu10), true);
});

test('jam buka: lewat tengah malam & format tak dikenal', () => {
  assert.equal(isOpenAt('Mo-Su 18:00-02:00', at('2026-11-19T01:00:00')), true);
  assert.equal(isOpenAt('Mo-Su 18:00-02:00', at('2026-11-19T03:00:00')), false);
  assert.equal(isOpenAt('Mo-Fr 08:00-17:00; PH off', at('2026-11-18T10:00:00')), null);
  assert.equal(isOpenAt(null, new Date()), null);
});

test('label status & jadwal mingguan', () => {
  assert.equal(openStatus('Mo-Su 10:00-21:00', at('2026-11-18T09:45:00')).label, 'Tutup · buka 10.00');
  assert.equal(openStatus('Mo-Su 10:00-21:00', at('2026-11-18T12:00:00')).label, 'Buka · tutup 21.00');
  assert.equal(openStatus('Mo-Su 10:00-21:00', at('2026-11-18T22:00:00')).label, 'Tutup · buka besok 10.00');
  assert.equal(openStatus('Mo-Su 18:00-02:00', at('2026-11-19T01:00:00')).label, 'Buka · tutup 02.00');
  assert.equal(openStatus('Mo-Fr 08:00-17:00', at('2026-11-21T12:00:00')).label, 'Tutup · buka Senin 08.00'); // Sabtu
  assert.equal(openStatus('24/7', new Date()).label, 'Buka 24 jam');
  const w = weeklyTable('Mo-Fr 08:00-17:00; Sa 09:00-12:00,13:00-15:00');
  assert.equal(w[0].day, 'Senin');
  assert.equal(w[0].text, '08.00–17.00');
  assert.equal(w[5].text, '09.00–12.00, 13.00–15.00');
  assert.equal(w[6].text, 'Tutup');
});
