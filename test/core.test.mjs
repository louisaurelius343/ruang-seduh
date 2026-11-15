import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, formatDistance, buildOverpassQuery, parsePlaces, isOpenAt } from '../public/js/core.js';

const at = (iso) => new Date(iso); // waktu lokal mesin

test('jarak haversine masuk akal', () => {
  // Monas -> Bundaran HI sekitar 2,2 km
  const d = distanceMeters(-6.1754, 106.8272, -6.1950, 106.8230);
  assert.ok(d > 2000 && d < 2400, `d=${d}`);
  assert.equal(distanceMeters(1, 1, 1, 1), 0);
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

test('parsePlaces: buang tanpa nama, dedup, urut jarak, url aman', () => {
  const osm = { elements: [
    { type: 'node', id: 1, lat: -6.21, lon: 106.8, tags: { amenity: 'cafe', name: 'Jauh' } },
    { type: 'node', id: 2, lat: -6.2001, lon: 106.8, tags: { amenity: 'cafe', name: 'Dekat', website: 'kopi.id', internet_access: 'wlan' } },
    { type: 'way', id: 3, center: { lat: -6.2001, lon: 106.8 }, tags: { amenity: 'cafe', name: 'Dekat' } },
    { type: 'node', id: 4, lat: -6.2, lon: 106.8, tags: { amenity: 'cafe' } },
    { type: 'node', id: 5, lat: -6.205, lon: 106.8, tags: { amenity: 'restaurant', name: 'Warung', website: 'javascript:alert(1)' } },
  ] };
  const p = parsePlaces(osm, -6.2, 106.8);
  assert.deepEqual(p.map((x) => x.name), ['Dekat', 'Warung', 'Jauh']);
  assert.equal(p[0].website, 'https://kopi.id');
  assert.equal(p[0].wifi, true);
  assert.equal(p[1].kind, 'makan');
  assert.equal(p[1].website, null);
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
