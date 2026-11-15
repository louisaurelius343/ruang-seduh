# Ruang Seduh

Ruang Seduh mencari kafe dan tempat nongkrong di sekitarmu. Tekan **Di sekitarku** atau ketik nama area, lalu lihat tempat terdekat di peta beserta jaraknya, jam buka, ketersediaan WiFi, dan tempat duduk outdoor. Tombol **Arahkan** membuka navigasi di Google Maps.

🔗 https://ruangseduh.cloud

## Fitur
- Lokasi pengguna (Geolocation) atau pencarian area (Nominatim, khusus Indonesia).
- Kategori: kafe dan kedai kopi, serta tempat makan santai.
- Radius 1, 2, atau 5 km. Filter **buka sekarang**, **ada WiFi**, dan **favorit**.
- Favorit dan cache hasil (24 jam) disimpan di browser, tanpa akun.
- Status buka/tutup dibaca dari tag `opening_hours` OpenStreetMap. Format yang tidak dikenali ditampilkan apa adanya.

## Arsitektur
Situs statis ditambah satu Cloudflare Worker kecil (`src/worker.js`) sebagai perantara ber-cache. Tidak ada database dan tanpa API key.

| Bagian | Teknologi |
|---|---|
| Peta | [Leaflet 1.9.4](https://leafletjs.com), disimpan langsung di `public/vendor` dengan tile OpenStreetMap |
| Data tempat | `/api/places` → [Overpass API](https://overpass-api.de). Cache bersama di edge 24 jam, permintaan *hedged* (server cadangan baru ditanya setelah 6 detik), dan rate limit per IP |
| Pencarian area | `/api/geocode` → [Nominatim](https://nominatim.org). Cache 7 hari, maksimal 1 request per detik, User-Agent sesuai kebijakan OSM |
| Privasi | Koordinat dibulatkan sekitar 100 m sebelum dikirim. Lihat `public/privasi.html` |
| Hosting | Cloudflare Pages, dengan header keamanan (CSP) di `public/_headers` |

Logika inti ada di `public/js/core.js`: jarak haversine, query Overpass, normalisasi data, dan pembaca jam buka. Semuanya fungsi murni yang dites dengan `node --test`.

## Menjalankan secara lokal
```bash
npm test
npm run dev
```
Setelah `npm run dev`, buka http://localhost:5173.

## Riwayat
- **v1, tag [`v1-toko-budi`](../../tree/v1-toko-budi):** toko kopi online (Express + SQLite, keranjang, admin, pesanan via WhatsApp). Dibangun bersama **Budi**, AI agent pribadi saya. Screenshot ada di `docs/v1/`.
- **v2:** dirombak total menjadi pencari kafe berbasis peta. Server dan database dihapus, sehingga situs bisa di-hosting gratis tanpa perawatan.

## Kredit data
© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. Kelengkapan jam buka dan fasilitas tergantung kontribusi komunitas.

Lisensi kode: MIT (lihat `LICENSE`).
