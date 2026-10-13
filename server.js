const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const app = express();
const database = new DatabaseSync(path.join(ROOT, 'data', 'ruang-seduh.sqlite'));
const COOKIE_NAME = 'ruang_seduh_session';
const SESSION_HOURS = 8;
const ALLOWED_STATUSES = ['baru', 'diproses', 'selesai', 'dibatalkan'];

// Membuat tabel baru dan menambah kolom active tanpa menghapus data fase sebelumnya.
database.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, notes TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0), type TEXT NOT NULL, emoji TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '', color TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL CHECK (total >= 0),
    status TEXT NOT NULL DEFAULT 'baru', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK (quantity >= 1),
    price INTEGER NOT NULL CHECK (price >= 0)
  );
`);
const productColumns = database.prepare('PRAGMA table_info(products)').all().map(column => column.name);
if (!productColumns.includes('active')) database.exec('ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
database.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    password_hash BLOB NOT NULL, password_salt BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash BLOB NOT NULL UNIQUE,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0,
    window_started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`);

app.set('trust proxy', 'loopback');
app.use(express.json());
function sendIndex(request, response) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  response.type('html').send(html.replace('__TOKO_WHATSAPP__', process.env.TOKO_WHATSAPP || ''));
}
// index.html harus melewati injeksi nomor WhatsApp sebelum static file handler.
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

app.get('/healthz', (request, response) => {
  try {
    database.prepare('SELECT 1').get();
    response.status(200).json({ status: 'ok' });
  } catch (error) {
    response.status(503).json({ status: 'error' });
  }
});

app.get('/api/products', (request, response) => {
  response.json(database.prepare(`SELECT id, name, origin, notes, price, type, emoji, tag, color FROM products WHERE active = 1 ORDER BY id`).all());
});

app.post('/api/orders', (request, response) => {
  const { name, phone, note = '', items } = request.body || {};
  if (typeof name !== 'string' || !name.trim()) return response.status(400).json({ message: 'Nama pemesan wajib diisi.' });
  if (typeof phone !== 'string' || !phone.trim()) return response.status(400).json({ message: 'Nomor HP wajib diisi.' });
  if (typeof note !== 'string' || note.length > 1000) return response.status(400).json({ message: 'Catatan harus berupa teks maksimal 1000 karakter.' });
  if (!Array.isArray(items) || items.length === 0) return response.status(400).json({ message: 'Keranjang harus berisi minimal satu produk.' });
  const counts = new Map();
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.productId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) return response.status(400).json({ message: 'Setiap item harus memiliki productId dan jumlah minimal 1.' });
    counts.set(item.productId, (counts.get(item.productId) || 0) + item.quantity);
  }
  const products = [];
  for (const [productId, quantity] of counts) {
    const product = database.prepare('SELECT id, name, price FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return response.status(400).json({ message: `Produk dengan ID ${productId} tidak ditemukan atau tidak aktif.` });
    if (!Number.isSafeInteger(quantity) || quantity > 10000) return response.status(400).json({ message: 'Jumlah produk terlalu besar.' });
    products.push({ ...product, quantity });
  }
  const total = products.reduce((sum, product) => sum + product.price * product.quantity, 0);
  if (!Number.isSafeInteger(total)) return response.status(400).json({ message: 'Total pesanan terlalu besar.' });
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = database.prepare('INSERT INTO orders (customer_name, phone, note, total) VALUES (?, ?, ?, ?)').run(name.trim(), phone.trim(), note.trim(), total);
    const orderId = Number(result.lastInsertRowid);
    const insertItem = database.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)');
    for (const product of products) insertItem.run(orderId, product.id, product.quantity, product.price);
    database.exec('COMMIT');
    response.status(201).json({ orderNumber: orderId, items: products.map(({ id, name, quantity, price }) => ({ productId: id, name, quantity, price })), total });
  } catch (error) {
    database.exec('ROLLBACK');
    console.error('Gagal menyimpan pesanan:', error);
    response.status(500).json({ message: 'Pesanan gagal disimpan. Silakan coba lagi.' });
  }
});

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(pair => {
    const index = pair.indexOf('=');
    return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())];
  }));
}
function tokenDigest(token) {
  // Cookie berisi token dalam format hex; hash kembali bytes aslinya agar cocok dengan database.
  return crypto.createHash('sha256').update(Buffer.from(token, 'hex')).digest();
}
function cookieSecure() { return String(process.env.COOKIE_SECURE).toLowerCase() === 'true'; }
function setSessionCookie(response, token) {
  const flags = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + SESSION_HOURS * 3600];
  if (cookieSecure()) flags.push('Secure');
  response.setHeader('Set-Cookie', flags.join('; '));
}
function clearSessionCookie(response) { response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure() ? '; Secure' : ''}`); }
function getAdmin(request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  return database.prepare(`SELECT admins.id, admins.username, sessions.id AS session_id FROM sessions JOIN admins ON admins.id = sessions.admin_id WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`).get(tokenDigest(token));
}
function requireAdmin(request, response, next) {
  const admin = getAdmin(request);
  if (!admin) return response.status(401).json({ message: 'Login admin diperlukan.' });
  request.admin = admin;
  next();
}
function passwordHash(password, salt) { return scrypt(password, salt, 64); }
async function verifyPassword(password, admin) {
  const calculated = await passwordHash(password, admin.password_salt);
  return calculated.length === admin.password_hash.length && crypto.timingSafeEqual(calculated, admin.password_hash);
}
function loginBlocked(ip) {
  const now = Date.now();
  const row = database.prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE ip = ?').get(ip);
  return row && now - row.window_started_at < 15 * 60 * 1000 && row.failed_count >= 5;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const row = database.prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE ip = ?').get(ip);
  if (!row || now - row.window_started_at >= 15 * 60 * 1000) database.prepare('INSERT OR REPLACE INTO login_attempts (ip, failed_count, window_started_at, updated_at) VALUES (?, 1, ?, ?)').run(ip, now, now);
  else database.prepare('UPDATE login_attempts SET failed_count = failed_count + 1, updated_at = ? WHERE ip = ?').run(now, ip);
}
function clearFailedLogins(ip) { database.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip); }

app.post('/api/admin/login', async (request, response) => {
  const { username, password } = request.body || {};
  const ip = request.ip;
  if (loginBlocked(ip)) return response.status(429).json({ message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' });
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    recordFailedLogin(ip); return response.status(401).json({ message: 'Username atau password salah.' });
  }
  const admin = database.prepare('SELECT id, username, password_hash, password_salt FROM admins WHERE username = ?').get(username.trim());
  const valid = admin ? await verifyPassword(password, admin) : false;
  if (!valid) { recordFailedLogin(ip); return response.status(401).json({ message: 'Username atau password salah.' }); }
  clearFailedLogins(ip);
  const token = crypto.randomBytes(32);
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(tokenDigest(token), admin.id, expiresAt);
  setSessionCookie(response, token.toString('hex'));
  response.json({ username: admin.username });
});
app.post('/api/admin/logout', (request, response) => {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token));
  clearSessionCookie(response); response.json({ message: 'Logout berhasil.' });
});
app.get('/api/admin/me', requireAdmin, (request, response) => response.json({ username: request.admin.username }));
app.get('/api/admin/products', requireAdmin, (request, response) => response.json(database.prepare('SELECT id, name, origin, notes, price, type, emoji, tag, color, active FROM products ORDER BY id').all()));

function productInput(body) {
  const fields = ['name', 'origin', 'notes', 'type', 'emoji', 'tag', 'color'];
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return { error: 'Nama produk wajib diisi.' };
  if (!Number.isSafeInteger(body.price) || body.price <= 0) return { error: 'Harga harus bilangan bulat lebih dari 0.' };
  const values = fields.map(field => typeof body[field] === 'string' ? body[field].trim() : '');
  return { values: [values[0], values[1], values[2], body.price, values[3], values[4], values[5], values[6]] };
}
app.post('/api/admin/products', requireAdmin, (request, response) => {
  const input = productInput(request.body); if (input.error) return response.status(400).json({ message: input.error });
  const result = database.prepare('INSERT INTO products (name, origin, notes, price, type, emoji, tag, color, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(...input.values);
  response.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.patch('/api/admin/products/:id', requireAdmin, (request, response) => {
  const id = Number(request.params.id); if (!Number.isSafeInteger(id)) return response.status(400).json({ message: 'ID produk tidak valid.' });
  const input = productInput(request.body); if (input.error) return response.status(400).json({ message: input.error });
  if (!Number.isInteger(request.body.active) || ![0, 1].includes(request.body.active)) return response.status(400).json({ message: 'active harus bernilai 0 atau 1.' });
  const result = database.prepare('UPDATE products SET name=?, origin=?, notes=?, price=?, type=?, emoji=?, tag=?, color=?, active=? WHERE id=?').run(...input.values, request.body.active, id);
  if (!result.changes) return response.status(404).json({ message: 'Produk tidak ditemukan.' });
  response.json({ message: 'Produk diperbarui.' });
});
app.get('/api/admin/orders', requireAdmin, (request, response) => {
  const orders = database.prepare('SELECT id, customer_name, phone, note, total, status, created_at FROM orders ORDER BY id DESC').all();
  const itemQuery = database.prepare('SELECT order_items.product_id, products.name, order_items.quantity, order_items.price FROM order_items JOIN products ON products.id = order_items.product_id WHERE order_id = ?');
  response.json(orders.map(order => ({ ...order, items: itemQuery.all(order.id) })));
});
app.patch('/api/admin/orders/:id/status', requireAdmin, (request, response) => {
  if (!ALLOWED_STATUSES.includes(request.body?.status)) return response.status(400).json({ message: `Status harus salah satu dari: ${ALLOWED_STATUSES.join(', ')}.` });
  const result = database.prepare('UPDATE orders SET status = ? WHERE id = ?').run(request.body.status, Number(request.params.id));
  if (!result.changes) return response.status(404).json({ message: 'Pesanan tidak ditemukan.' });
  response.json({ message: 'Status pesanan diperbarui.' });
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT harus berupa angka antara 1 dan 65535.');
app.listen(port, host, () => console.log(`Ruang Seduh berjalan di http://${host}:${port}`));
