const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const database = new DatabaseSync(path.join(__dirname, '..', 'data', 'ruang-seduh.sqlite'));
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

const products = [
  { name: 'Gayo Wine', origin: 'Aceh · Arabika', notes: 'Anggur merah · cokelat · floral', price: 89000, type: 'Arabika', emoji: '🫘', tag: 'Panen baru', color: 'b1' },
  { name: 'Kintamani', origin: 'Bali · Arabika', notes: 'Jeruk · madu · teh hitam', price: 78000, type: 'Arabika', emoji: '☕', tag: 'Favorit', color: 'b2' },
  { name: 'Java Preanger', origin: 'Jawa Barat · Arabika', notes: 'Karamel · rempah · lembut', price: 82000, type: 'Arabika', emoji: '🌰', tag: '', color: 'b3' },
  { name: 'Senja Blend', origin: 'House blend · Blend', notes: 'Cokelat susu · hazelnut', price: 69000, type: 'Blend', emoji: '✨', tag: 'Espresso pick', color: 'b4' },
];

// Seed berulang tetap aman: kosongkan dahulu agar tidak membuat produk duplikat.
database.exec('BEGIN');
try {
  database.exec('DELETE FROM products');
  const insert = database.prepare(`
    INSERT INTO products (name, origin, notes, price, type, emoji, tag, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const product of products) {
    insert.run(product.name, product.origin, product.notes, product.price,
      product.type, product.emoji, product.tag, product.color);
  }
  database.exec('COMMIT');
  console.log(`Berhasil mengisi ${products.length} produk.`);
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
} finally {
  database.close();
}
