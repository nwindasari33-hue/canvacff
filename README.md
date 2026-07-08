# Canva Bot (Cloudflare Workers Edition)

Repositori ini adalah versi otonom dari Bot Invite Canva yang berjalan 100% pada jaringan **Cloudflare Workers**. Fitur unggulan dari repositori ini adalah:
1. **Kecepatan Tinggi (Edge Network):** Respons bot instan.
2. **Cron Terintegrasi:** Tidak perlu GitHub Actions cron; jadwal *process queue* dan *auto kick* diurus secara internal oleh Cloudflare.
3. **Anti Cold-Start:** Selalu hidup 24/7.
4. **Hybrid Puppeteer:** Otot pekerja untuk mengontrol browser Canva tetap di-handle oleh GitHub Actions (via *repository_dispatch* yang dikirim dari Cloudflare).

## 🚀 Panduan Deployment

### 1. Kloning & Persiapan
Buka terminal dan ketik:
```bash
git clone https://github.com/nwindasari33-hue/canvacff.git
cd canvacff
npm install
```

### 2. Konfigurasi Rahasia di Cloudflare
Anda membutuhkan token dan URL untuk menjalankan bot ini. 
Deploy script pertama kali (meskipun error karena kurang *secrets*):
```bash
npm run deploy
```
Atau Anda bisa menggunakan Wrangler CLI untuk menyuntikkan rahasia:
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put ADMIN_ID
npx wrangler secret put GITHUB_PAT
npx wrangler secret put GITHUB_OWNER
npx wrangler secret put GITHUB_REPO
```
*(Catatan: GITHUB_OWNER isi dengan `nwindasari33-hue` dan GITHUB_REPO isi dengan `canvacff`)*.

### 3. Mengatur Webhook Telegram
Setelah *deploy* sukses, Anda akan mendapatkan URL Cloudflare (contoh: `https://canvacf.nwindasari.workers.dev`).
Buka browser dan kunjungi link berikut (ubah bagian yang diapit tanda `<>`):
```
https://api.telegram.org/bot<BOT_TOKEN_ANDA>/setWebhook?url=https://<URL_CLOUDFLARE_ANDA>/api/webhook
```
Jika sukses, Telegram akan memberikan respons `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 4. Aktivasi GitHub Actions (Otot Pekerja)
Bot Telegram kini aktif! Namun, untuk mengirim undangan Canva, Cloudflare membutuhkan GitHub Actions.
1. Masuk ke GitHub Repository Anda (tab **Settings** -> **Secrets and variables** -> **Actions**).
2. Tambahkan *Secrets* yang sama persis (TURSO_URL, BOT_TOKEN, dll) beserta Cookie Canva Anda.
3. Cloudflare akan secara otomatis menembak (*trigger*) script Puppeteer di GitHub sesuai jadwal yang ada di `wrangler.toml`.

🎉 **Selesai! Sistem bot Canva Anda kini 100% berjalan autopilot di atas Cloudflare Workers!**
