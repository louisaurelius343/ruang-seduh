const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', (request, response) => {
  const products = database.prepare(`
    SELECT id, name, origin, notes, price, type, emoji, tag, color
    FROM products
    ORDER BY id
  `).all();
  response.json(products);
});

const port = 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`Ruang Seduh berjalan di http://127.0.0.1:${port}`);
});
