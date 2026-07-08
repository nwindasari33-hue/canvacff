# CanvaCF — Bot Telegram Canva (Cloudflare Workers + GitHub Actions)

Bot Telegram untuk undangan Canva Pro/Edu yang berjalan **100% serverless** menggunakan Cloudflare Workers sebagai penerima webhook dan GitHub Actions sebagai worker Puppeteer di balik layar.

## Arsitektur

```
User Telegram → Cloudflare Workers (webhook, cron) → GitHub Actions (Puppeteer/invite)
                        ↕
                  Turso (LibSQL DB)
```

- **Cloudflare Workers** — Menerima pesan Telegram secara real-time, membalas instan, mencatat ke DB
- **Turso (LibSQL)** — Database edge yang cepat dan ringan
- **GitHub Actions** — Dipicu oleh Cloudflare untuk menjalankan tugas berat (Puppeteer, auto-invite, auto-kick)

---

## 🚀 Cara Deploy

### Langkah 1: Buat Database Turso

1. Daftar gratis di [turso.tech](https://turso.tech)
2. Buat database baru, lalu buka tab **Connect**
3. Catat dua nilai ini:
   - **Database URL** → contoh: `libsql://nama-db-anda.aws-ap-northeast-1.turso.io`
   - **Auth Token** → string JWT panjang

### Langkah 2: Clone & Install

```bash
git clone https://github.com/nwindasari33-hue/canvacff.git
cd canvacff
npm install
```

### Langkah 3: Login ke Cloudflare

```bash
npx wrangler login
```

Browser akan terbuka untuk login ke akun Cloudflare Anda.

### Langkah 4: Masukkan Secrets ke Cloudflare

Jalankan perintah berikut **satu per satu** di terminal. Setiap perintah akan meminta Anda mengetikkan nilainya, lalu tekan Enter:

```bash
npx wrangler secret put BOT_TOKEN
```
> Masukkan: Token bot Telegram dari [@BotFather](https://t.me/BotFather)
> Contoh: `7081327890:AAGhf5S0Ev1Glfak9VOHf6c5AnKPBwsoKIs`

```bash
npx wrangler secret put TURSO_DATABASE_URL
```
> Masukkan: URL database Turso Anda
> Contoh: `libsql://botcanva-vlesskuyu.aws-ap-northeast-1.turso.io`

```bash
npx wrangler secret put TURSO_AUTH_TOKEN
```
> Masukkan: Auth token Turso Anda (string JWT panjang)

```bash
npx wrangler secret put ADMIN_ID
```
> Masukkan: ID Telegram Anda (angka). Cari ID Anda dengan forward pesan ke [@userinfobot](https://t.me/userinfobot)
> Contoh: `6242090623`

```bash
npx wrangler secret put GITHUB_USERNAME
```
> Masukkan: Username GitHub Anda
> Contoh: `nwindasari33-hue`

```bash
npx wrangler secret put GITHUB_REPO
```
> Masukkan: Nama repositori ini di GitHub
> Contoh: `canvacff`

```bash
npx wrangler secret put GITHUB_PAT
```
> Masukkan: GitHub Personal Access Token (PAT) dengan izin `repo` dan `workflow`
> Cara buat: [GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens)
> Centang scope: **`repo`** dan **`workflow`**

### Langkah 5: Deploy ke Cloudflare

```bash
npm run deploy
```

Jika berhasil, Anda akan mendapatkan URL seperti:
```
https://canvacf.SUBDOMAIN-ANDA.workers.dev
```

### Langkah 6: Set Webhook Telegram

Buka URL berikut di browser (ganti nilai yang sesuai):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://canvacf.<SUBDOMAIN>.workers.dev/api/webhook
```

Jika berhasil, browser akan menampilkan:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

---

## ⚙️ GitHub Actions Secrets (Untuk Fitur Puppeteer)

Agar fitur **auto-invite** dan **auto-kick** Canva bisa berjalan via GitHub Actions, Anda perlu menambahkan secrets di repositori GitHub ini.

Buka: **Repository → Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Nilai | Keterangan |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://nama-db.turso.io` | URL database Turso (sama dengan Cloudflare) |
| `TURSO_AUTH_TOKEN` | `eyJhbGci...` | Auth token Turso (sama dengan Cloudflare) |
| `BOT_TOKEN` | `1234:AABcc...` | Token bot Telegram (sama dengan Cloudflare) |
| `ADMIN_ID` | `6242090623` | ID Telegram admin (sama dengan Cloudflare) |
| `ADMIN_CHANNEL_ID` | `-1001767672802` | ID channel Telegram untuk log transaksi (opsional) |
| `CANVA_EMAIL` | `email@gmail.com` | Email akun Canva yang digunakan untuk invite |
| `CANVA_PASSWORD` | `password123` | Password akun Canva tersebut |
| `CANVA_COOKIE` | `(isi cookie dari browser)` | Cookie session Canva (opsional, alternatif email/password) |

> **Cara ambil Cookie Canva:**
> 1. Login ke [canva.com](https://canva.com) di browser
> 2. Buka DevTools → Application → Cookies → `https://www.canva.com`
> 3. Copy semua cookie dalam format `nama=nilai; nama2=nilai2; ...`

---

## 📅 Jadwal Cron Otomatis

Cloudflare Workers akan otomatis memicu GitHub Actions sesuai jadwal berikut:

| Jadwal | Waktu | Aksi |
|---|---|---|
| `*/10 * * * *` | Setiap 10 menit | Memproses antrian invite (`process_queue`) |
| `*/30 * * * *` | Setiap 30 menit | Sinkronisasi manual (`manual_sync`) |
| `30 2 * * *` | Setiap hari pukul 02:30 UTC | Perbarui session Canva (`refresh-sessions`) |

---

## 🔍 Verifikasi Setelah Deploy

Cek status webhook:
```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Cek log worker secara live:
```bash
npx wrangler tail
```
