import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placesParams, placesCacheKey, overpassQuery, geocodeParams, slimOverpass, createLimiter, photoParams, bbox, pickPhoto } from '../src/lib.js';

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

test('photo: validasi & bbox', () => {
  assert.ok(photoParams(new URLSearchParams({ lat: '48', lon: '2' })).error);
  const p = photoParams(new URLSearchParams({ lat: '-6.885123', lon: '107.613456' }));
  assert.equal(p.lat, -6.8851);
  const [w, s, e, n] = bbox(-6.885, 107.613, 60);
  assert.ok(w < 107.613 && e > 107.613 && s < -6.885 && n > -6.885);
  assert.ok((n - s) * 111320 > 110 && (n - s) * 111320 < 130); // ~120 m
});

test('photo: pilih yang dekat & menghadap tempat, abaikan yang membelakangi', () => {
  const place = [-6.885, 107.613];
  const at = (dLatM, dLonM) => [107.613 + dLonM / 110400, -6.885 + dLatM / 111320];
  const now = Date.UTC(2026, 10, 15);
  const imgs = [
    { id: 'jauh', thumb_1024_url: 'u1', compass_angle: 0, captured_at: now, computed_geometry: { coordinates: at(-70, 0) } },
    { id: 'membelakangi', thumb_1024_url: 'u2', compass_angle: 180, captured_at: now, computed_geometry: { coordinates: at(-10, 0) } },
    { id: 'pas', thumb_1024_url: 'u3', compass_angle: 2, captured_at: now, computed_geometry: { coordinates: at(-15, 0) } },
    { id: 'tanpa-url', compass_angle: 0, computed_geometry: { coordinates: at(-5, 0) } },
  ];
  assert.equal(pickPhoto(imgs, ...place, now).id, 'pas');
  assert.equal(pickPhoto([imgs[1]], ...place, now), null);
  assert.equal(pickPhoto([], ...place, now), null);
});