import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placesParams, placesCacheKey, overpassQuery, geocodeParams, slimOverpass, createLimiter } from '../src/lib.js';

const sp = (o) => new URLSearchParams(o);

test('places: koordinat dibulatkan ~100 m & kunci cache stabil', () => {
  const a = placesParams(sp({ lat: '-6.885123', lon: '107.613456', r: '2000' }));
  const b = placesParams(sp({ lat: '-6.88539', lon: '107.61311', r: '2000' }));
  assert.equal(a.lat, -6.885);
  assert.equal(a.lon, 107.613);
  assert.equal(placesCacheKey(a), placesCacheKey(b)); // dua pengguna berdekatan -> cache yang sama
  assert.match(placesCacheKey(a), /places\/v1\/-6\.885\/107\.613\/2000\/kafe$/);
});

test('places: validasi radius, kategori, wilayah', () => {
  assert.equal(placesParams(sp({ lat: '-6.9', lon: '107.6', r: '99999' })).radius, 2000);
  assert.deepEqual(placesParams(sp({ lat: '-6.9', lon: '107.6', cats: 'makan,kafe,hack' })).categories, ['kafe', 'makan']);
  assert.ok(placesParams(sp({ lat: 'x', lon: '1' })).error);
  assert.ok(placesParams(sp({ lat: '48.85', lon: '2.35' })).error); // Paris: di luar Indonesia
  assert.match(overpassQuery(placesParams(sp({ lat: '-6.9', lon: '107.6', r: '1000' }))), /around:1000,-6\.900000,107\.600000/);
});

test('geocode: panjang teks & kunci cache tidak peka huruf besar', () => {
  assert.ok(geocodeParams(sp({ q: 'a' })).error);
  assert.ok(geocodeParams(sp({ q: 'x'.repeat(101) })).error);
  assert.equal(geocodeParams(sp({ q: '  Dago   Bandung ' })).q, 'Dago Bandung');
  assert.equal(geocodeParams(sp({ q: 'DAGO' })).key, geocodeParams(sp({ q: 'dago' })).key);
});

test('slimOverpass: buang tanpa nama & tag tak terpakai', () => {
  const out = slimOverpass({ elements: [
    { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A', amenity: 'cafe', 'addr:city': 'X', source: 'survey', 'payment:qris': 'yes' } },
    { type: 'node', id: 2, lat: 1, lon: 2, tags: { amenity: 'cafe' } },
    { type: 'way', id: 3, center: { lat: 1, lon: 2 }, tags: { name: 'B' } },
  ] });
  assert.equal(out.elements.length, 2);
  assert.deepEqual(out.elements[0].tags, { name: 'A', amenity: 'cafe', 'addr:city': 'X', 'payment:qris': 'yes' });
  assert.deepEqual(out.elements[1].center, { lat: 1, lon: 2 });
});

test('rate limiter: token bucket per kunci', () => {
  let t = 0;
  const allow = createLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), true);
  assert.equal(allow('ip'), false);
  assert.equal(allow('ip-lain'), true);
  t = 1000;
  assert.equal(allow('ip'), true);
});
