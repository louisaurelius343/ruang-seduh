const readline = require('node:readline');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const database = new DatabaseSync(path.join(__dirname, '..', 'data', 'ruang-seduh.sqlite'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = question => new Promise(resolve => rl.question(question, resolve));

(async () => {
  const username = (await ask('Username admin: ')).trim();
  const password = await ask('Password admin (input tidak ditampilkan): ');
  rl.close();
  if (!username || !password) throw new Error('Username dan password wajib diisi.');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  database.prepare(`INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, password_salt=excluded.password_salt`).run(username, hash, salt);
  database.close();
  console.log(`Admin "${username}" berhasil dibuat/diperbarui.`);
})().catch(error => { rl.close(); database.close(); console.error(error.message); process.exitCode = 1; });
