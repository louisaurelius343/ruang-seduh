const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

// Membaca .env lokal tanpa dependensi tambahan. Nilai dari environment shell tetap diprioritaskan.
for (const line of (require('node:fs').existsSync(path.join(__dirname, '.env')) ? require('node:fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/) : [])) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}

const app = express();
const databasePath = path.join(__dirname, 'data', 'ruang-seduh.sqlite');
const database = new DatabaseSync(databasePath);

// Tabel dibuat otomatis saat server pertama kali dijalankan.
database.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    notes TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    type TEXT NOT NULL,
    emoji TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL
  )
`);

database.exec(`
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

app.use(express.json());
app.get('/', (request, response) => {
  const html = require('node:fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  response.type('html').send(html.replace('__TOKO_WHATSAPP__', process.env.TOKO_WHATSAPP || ''));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', (request, response) => {
  const products = database.prepare(`
    SELECT id, name, origin, notes, price, type, emoji, tag, color
    FROM products
    ORDER BY id
  `).all();
  response.json(products);
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
    const product = database.prepare('SELECT id, name, price FROM products WHERE id = ?').get(productId);
    if (!product) return response.status(400).json({ message: `Produk dengan ID ${productId} tidak ditemukan.` });
    if (!Number.isSafeInteger(quantity) || quantity > 10000) return response.status(400).json({ message: 'Jumlah produk terlalu besar.' });
    products.push({ ...product, quantity });
  }
  const total = products.reduce((sum, product) => sum + product.price * product.quantity, 0);
  if (!Number.isSafeInteger(total)) return response.status(400).json({ message: 'Total pesanan terlalu besar.' });
  // Satu transaksi: jika penyimpanan item gagal, header pesanan ikut dibatalkan.
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

const port = 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`Ruang Seduh berjalan di http://127.0.0.1:${port}`);
});
