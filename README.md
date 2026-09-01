# Threads MCP Server

Server MCP custom untuk Threads API. Mendukung **2 akun Threads sekaligus**
dalam satu server (pilih lewat parameter `account`: `"akun_1"` atau `"akun_2"`).

## Tools yang tersedia

- `list_accounts` — lihat akun mana aja yang sudah ke-setup di server ini
- `get_profile_info` — info profil (username, bio, follower count)
- `post_thread` — posting teks (+ opsional gambar via URL publik) ke Threads
- `get_my_posts` — ambil postingan terbaru akun kamu (preview, teks bisa terpotong)
- `get_full_thread` — ambil seluruh rantai thread (post 1/20, 2/20, dst) digabung jadi satu
- `get_post_detail` — ambil detail 1 post spesifik lewat ID-nya
- `get_post_insights` — lihat views/likes/replies/reposts/quotes sebuah post
- `get_replies` — lihat balasan/komentar di sebuah post (mendukung pagination lewat `after`)
- `delete_post` — hapus sebuah post/reply (butuh izin `threads_delete` diaktifkan di Meta App)
- `reply_to_post` — balas sebuah post/komentar

## 1. Bikin Meta App & ambil kredensial (per akun)

Setiap orang yang mau pakai server ini butuh Meta App miliknya sendiri:

1. Buka developers.facebook.com → My Apps → Create App
2. Add Product → Threads API
3. Catat App ID & App Secret (App Settings → Basic)
4. Buka menu "Akses Threads API" → "Peran aplikasi" → tambahkan akun Threads
   yang mau dipakai sebagai Tester. Akun itu harus login & menerima undangan
   tester-nya (biasanya via notifikasi di app Threads).
5. Kalau mau pakai fitur `delete_post`, buka "Izin dan fitur" → cari
   `threads_delete` → klik "Tambahkan..." buat mengaktifkannya.
6. Buka "Pengaturan" (di bawah "Izin dan fitur") → scroll ke "Generator Token
   Pengguna" → klik "Buat Token Akses" untuk tiap akun tester yang mau dipakai.
7. Untuk dapat User ID dari token itu, buka di browser:
   `https://graph.threads.net/v1.0/me?access_token={TOKEN}` — angka "id" di
   hasilnya itu User ID-nya.

## 2. Environment Variables (isi di Render)

| Key | Keterangan |
|---|---|
| `THREADS_ACCESS_TOKEN_1` | Access token akun pertama |
| `THREADS_USER_ID_1` | User ID akun pertama (dari langkah 7 di atas) |
| `THREADS_ACCOUNT_1_LABEL` | (opsional) nama akun pertama, misal "Akun Utama" |
| `THREADS_ACCESS_TOKEN_2` | Access token akun kedua |
| `THREADS_USER_ID_2` | User ID akun kedua |
| `THREADS_ACCOUNT_2_LABEL` | (opsional) nama akun kedua |

Server ini TIDAK melakukan proses OAuth otomatis — token harus didapat manual
dulu lewat "Generator Token Pengguna" di langkah 1.6 di atas (paling gampang),
atau lewat OAuth authorize flow manual.

## 3. Deploy ke Render

1. Push folder ini ke repo GitHub kamu sendiri (fork/copy dari repo asal boleh).
2. Di Render: **New → Web Service** → connect ke repo tadi.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Isi Environment Variables di atas.
6. Deploy. URL publiknya jadi `https://nama-app-kamu.onrender.com`.

## 4. Connect ke Claude

Di claude.ai → Settings → Connectors → Add custom connector, isi URL:

```
https://nama-app-kamu.onrender.com/mcp
```

**Catatan Claude Free:** cuma boleh 1 custom connector. Kalau butuh lebih dari
2 akun Threads, tambahkan langsung di server ini (env variable akun ke-3, dst)
daripada bikin connector terpisah.

Setiap kali kamu update kode server (index.js), setelah redeploy kamu perlu
**disconnect lalu connect ulang** connector-nya di Claude supaya daftar tool
terbaru ke-refresh (Claude nge-cache skema tool per koneksi).

## 5. Test lokal (opsional)

```bash
npm install
THREADS_ACCESS_TOKEN_1=xxx THREADS_USER_ID_1=xxx THREADS_ACCESS_TOKEN_2=yyy THREADS_USER_ID_2=yyy npm start
```

## Catatan

- Free plan Render akan "tidur" kalau tidak dipakai — request pertama
  setelah idle bisa lambat beberapa detik, ini normal.
- Access token Threads ada masa berlakunya — kalau tools mulai gagal dengan
  error terkait token/authorization, generate ulang token via "Generator
  Token Pengguna" dan update di Environment Variables Render.
- Gambar untuk `post_thread` harus berupa URL publik yang bisa diakses
  langsung (bukan link preview seperti Google Drive biasa) — misalnya dari
  Imgur.

