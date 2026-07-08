# CanvaCF - Serverless Telegram Bot (Cloudflare Workers + GitHub Actions)

Repositori ini berisi kode sumber untuk Bot Telegram Undangan Canva yang sepenuhnya di-*deploy* secara *serverless* menggunakan **Cloudflare Workers** (sebagai penerima Webhook & Cron trigger yang sangat cepat) dan **GitHub Actions** (sebagai *worker* Puppeteer di balik layar).

## Arsitektur
1. **Cloudflare Workers**: Bertugas menerima pesan Telegram secara *real-time*, membalas pengguna instan, dan mencatat transaksi ke database Turso.
2. **Turso (LibSQL)**: Database Edge yang cepat dan ringan.
3. **GitHub Actions**: Dipicu (di-*trigger*) oleh Cloudflare Workers untuk menjalankan tugas-tugas berat yang tidak didukung Cloudflare (misalnya `Puppeteer` untuk *auto-invite* atau *auto-kick* dari situs Canva).

---

## 🚀 Cara Deploy

### Langkah 1: Persiapan Database (Turso)
1. Buat database gratis di [Turso](https://turso.tech).
2. Dapatkan URL Database (contoh: `libsql://nama-db-anda.turso.io`) dan *Auth Token*.
3. Buka file `.dev.vars` (buat jika belum ada) dan masukkan rahasia Anda:
   ```env
   TURSO_DATABASE_URL="libsql://..."
   TURSO_AUTH_TOKEN="..."
   BOT_TOKEN="token_bot_telegram_anda"
   GITHUB_USERNAME="nwindasari33-hue"
   GITHUB_REPO="canvacff"
   GITHUB_PAT="token_github_personal_access_anda"
   ```

### Langkah 2: Konfigurasi Rahasia di Cloudflare
Karena Cloudflare Workers tidak membaca `.env` biasa di lingkungan *production*, Anda wajib memasukkan rahasia (*secrets*) tersebut ke Cloudflare.
Buka terminal dan jalankan (masukkan nilai satu per satu ketika diminta):
```bash
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GITHUB_USERNAME
npx wrangler secret put GITHUB_REPO
npx wrangler secret put GITHUB_PAT
```

### Langkah 3: Deploy ke Cloudflare Workers
Jalankan perintah berikut untuk mengunggah kode ke Cloudflare:
```bash
npm install
npm run deploy
```
Jika berhasil, Anda akan mendapatkan URL seperti: `https://canvacf.canvaqwe.workers.dev`.

### Langkah 4: Set Webhook Telegram
Setelah mendapatkan URL Cloudflare, hubungkan Bot Telegram Anda dengan cara membuka tautan ini di browser Anda:
```text
https://api.telegram.org/bot<TOKEN_BOT_ANDA>/setWebhook?url=https://canvacf.canvaqwe.workers.dev/api/webhook
```
*(Ganti `<TOKEN_BOT_ANDA>` dengan token bot yang asli)*.
Jika di halaman browser muncul tulisan `"Webhook was set"`, artinya bot Anda sudah berhasil aktif dan *online* 24/7.

### Langkah 5: Setup GitHub Actions (Untuk Puppeteer)
1. Pergi ke Pengaturan Repositori GitHub Anda > **Settings** > **Secrets and variables** > **Actions**.
2. Tambahkan *Repository secrets* yang dibutuhkan oleh *scripts* automasi Canva Anda (seperti cookie canva, turso url, dll yang mungkin Anda perlukan).
3. Buat workflow `.github/workflows/process_queue.yml` (dan yang lainnya) yang bereaksi terhadap `repository_dispatch`. Cloudflare Workers akan memicu *workflow* ini dengan *event type* `"process_queue"` dan `"manual_sync"`.

## Selesai! 🎉
Bot Anda sekarang berjalan 100% secara gratis tanpa server aktif (*serverless*). Cloudflare Workers akan langsung membangunkan GitHub Actions begitu ada tugas berat yang perlu diselesaikan.
