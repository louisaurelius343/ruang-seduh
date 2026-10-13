const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.join(__dirname, '..', 'data', 'ruang-seduh.sqlite');
const backupDirectory = '/home/budi/backups/ruang-seduh';
const retentionMs = 14 * 24 * 60 * 60 * 1000;
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDirectory, `ruang-seduh-${timestamp}.sqlite`);
const database = new DatabaseSync(databasePath);
try {
  // VACUUM INTO menghasilkan salinan SQLite yang konsisten tanpa menyalin file saat sedang berubah.
  database.prepare('VACUUM INTO ?').run(backupPath);
} finally {
  database.close();
}
for (const file of fs.readdirSync(backupDirectory)) {
  const filePath = path.join(backupDirectory, file);
  const stat = fs.statSync(filePath);
  if (stat.isFile() && stat.mtimeMs < Date.now() - retentionMs) fs.unlinkSync(filePath);
}
console.log(`Backup dibuat: ${backupPath}`);
