const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruang-seduh-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.TOKO_WHATSAPP = '6282110769069';
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
let base;
const db = new DatabaseSync(process.env.DATABASE_PATH);
const scrypt = promisify(crypto.scrypt);
let activeId;
let inactiveId;
let adminCookie;

before(async () => {
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const insert = db.prepare(`INSERT INTO products (name, origin, notes, price, type, emoji, tag, color, active) VALUES (?, '', '', ?, '', '', '', '', ?)`);
  activeId = Number(insert.run('Uji aktif', 12500, 1).lastInsertRowid);
  inactiveId = Number(insert.run('Uji nonaktif', 5000, 0).lastInsertRowid);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt('test-password-only', salt, 64);
  db.prepare('INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)').run('test-admin', hash, salt);
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function json(pathname, body, options = {}) {
  return fetch(`${base}${pathname}`, { method: body === undefined ? (options.method || 'GET') : (options.method || 'POST'), ...options, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('healthz returns healthy status', async () => {
  const response = await json('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
test('public products only include active products', async () => {
  const response = await json('/api/products');
  const products = await response.json();
  assert.ok(products.some(product => product.id === activeId));
  assert.ok(!products.some(product => product.id === inactiveId));
});
test('valid order saves server-side price and ignores browser price', async () => {
  const response = await json('/api/orders', { name: 'Pembeli Uji', phone: '08123456789', items: [{ productId: activeId, quantity: 2, price: 1 }] });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(result.total, 25000);
  assert.equal(result.items[0].price, 12500);
});
test('empty name, zero quantity and missing product return 400', async t => {
  await t.test('empty name', async () => assert.equal((await json('/api/orders', { name: ' ', phone: '0812', items: [{ productId: activeId, quantity: 1 }] })).status, 400));
  await t.test('zero quantity', async () => assert.equal((await json('/api/orders', { name: 'Uji', phone: '0812', items: [{ productId: activeId, quantity: 0 }] })).status, 400));
  await t.test('missing product', async () => assert.equal((await json('/api/orders', { name: 'Uji', phone: '0812', items: [{ productId: 999999, quantity: 1 }] })).status, 400));
});
test('admin endpoints require authentication', async () => {
  assert.equal((await json('/api/admin/products')).status, 401);
});
test('wrong login is 401 and repeated failures are rate limited with 429', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await json('/api/admin/login', { username: 'test-admin', password: 'wrong' })).status, 401);
  assert.equal((await json('/api/admin/login', { username: 'test-admin', password: 'wrong' })).status, 429);
});
test('correct login creates session and logout revokes it', async () => {
  db.prepare('DELETE FROM login_attempts').run();
  const response = await json('/api/admin/login', { username: 'test-admin', password: 'test-password-only' });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  adminCookie = setCookie.split(';')[0];
  assert.equal((await json('/api/admin/me', undefined, { headers: { cookie: adminCookie } })).status, 200);
  assert.equal((await json('/api/admin/logout', undefined, { method: 'POST', headers: { cookie: adminCookie } })).status, 200);
  assert.equal((await json('/api/admin/me', undefined, { headers: { cookie: adminCookie } })).status, 401);
});
test('homepage routes replace WhatsApp token placeholder', async t => {
  for (const pathname of ['/', '/index.html']) await t.test(pathname, async () => {
    const response = await json(pathname);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /storePhone='6282110769069'/);
    assert.ok(!html.includes('__TOKO_WHATSAPP__'));
  });
});
