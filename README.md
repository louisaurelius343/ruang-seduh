# Ruang Seduh

Toko kopi online berbasis Node.js, Express, dan SQLite.

## Fitur

- Katalog produk dan checkout WhatsApp
- Pesanan tersimpan di SQLite
- Dashboard admin dengan login, sesi cookie, pengelolaan produk, dan status pesanan
- Health check dan backup database

## Konfigurasi

Salin `.env.example` menjadi `.env`, lalu sesuaikan nilainya. Jangan masukkan `.env` ke Git.

- `TOKO_WHATSAPP`: nomor WhatsApp internasional tanpa tanda `+`.
- `COOKIE_SECURE`: `true` jika aplikasi diakses melalui HTTPS; `false` untuk lokal.
- `HOST`: alamat listen server; default `127.0.0.1`.
- `PORT`: port server; default `3000`.

## Menjalankan lokal

```bash
npm install
npm run seed
npm start
```

Aplikasi tersedia di `http://127.0.0.1:3000`. Buat akun admin dengan `npm run create-admin`, lalu buka `/admin.html`.

## Deploy di belakang Caddy

Jalankan aplikasi pada host loopback, misalnya `HOST=127.0.0.1` dan `PORT=3000`. Reverse proxy yang sudah ada dapat meneruskan trafik HTTPS ke alamat tersebut. Pastikan `COOKIE_SECURE=true` saat akses publik memakai HTTPS. Service produksi harus memuat file `.env` dengan `EnvironmentFile=/home/budi/.openclaw/workspace/ruang-seduh/.env` (atau path `.env` yang sesuai) agar `TOKO_WHATSAPP` dan konfigurasi lain tersedia untuk proses Node. Konfigurasi Caddy dan service dikelola di luar repository ini.

Periksa aplikasi dengan:

```bash
curl http://127.0.0.1:3000/healthz
```

Respons sehat adalah HTTP 200 dengan `{"status":"ok"}`.

## Backup dan update

Buat backup database manual dengan:

```bash
npm run backup
```

Backup dibuat di `/home/budi/backups/ruang-seduh` dan file yang lebih tua dari 14 hari dihapus otomatis.

Untuk update kode:

```bash
git pull --ff-only origin main
npm install
npm run backup
```

Setelah itu restart proses aplikasi yang dikelola operator. Repository ini tidak mengubah Caddy, systemd, firewall, atau `~/apps`.

## Pengembangan bertahap

- Fase 0: situs statis dengan domain dan HTTPS
- Fase 1: backend Node.js + Express dan database SQLite
- Fase 2: pesanan
- Fase 3: halaman admin
- Fase 4: persiapan produksi
