import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as puppeteerCore from 'puppeteer-core';
import { sql } from '../lib/db';
import * as dotenv from 'dotenv';
import { parseCanvaCookies } from './canva_cookie';
import fs from 'fs';

dotenv.config();

const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(StealthPlugin());

const findChromeParams = [
    process.env.CHROME_BIN || "",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function getChromePath() {
    for (const path of findChromeParams) {
        if (path && fs.existsSync(path)) return path;
    }
    return null;
}

const randomDelay = (min: number, max: number) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min));

async function run() {
    const chromePath = getChromePath();
    if (!chromePath) throw new Error("Chrome tidak ditemukan!");

    console.log("Mencari akun aktif di DB (Chunking limit 5)...");
    const accountsRes = await sql("SELECT id, cookie, team_id FROM canva_accounts WHERE is_active = 1 ORDER BY invite_code_updated_at ASC LIMIT 5");
    if (accountsRes.rows.length === 0) {
        console.log("Tidak ada akun aktif.");
        return;
    }

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        let globalUA = "";
        try {
            const uaRes = await sql("SELECT value FROM settings WHERE key = 'canva_user_agent'");
            if (uaRes.rows.length > 0) globalUA = uaRes.rows[0].value as string;
        } catch {}

        for (const acc of accountsRes.rows) {
            try {
                console.log(`Memproses Node ID: ${acc.id}`);
                const page = await browser.newPage();
                if (globalUA) await page.setUserAgent(globalUA);

                await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded' });
                
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');

                const cookies = parseCanvaCookies(acc.cookie as string);
                await page.setCookie(...cookies);

                console.log("Ke halaman People Settings...");
                await page.goto('https://www.canva.com/settings/people', { waitUntil: 'networkidle2', timeout: 60000 });
                await randomDelay(3000, 4000);

                if (page.url().includes('login') || page.url().includes('signup')) {
                    console.error(`Cookie Node ${acc.id} expired!`);
                    await page.close();
                    continue;
                }

                // Klik tombol Invite/Undang
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const inviteBtn = buttons.find(btn => {
                        const txt = btn.textContent?.toLowerCase() || '';
                        return txt.includes('invite') || txt.includes('undang');
                    });
                    if (inviteBtn) inviteBtn.click();
                });

                await randomDelay(3000, 4000);

                // Klik tombol "Via code"
                console.log("Mencari tombol 'Via code'...");
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const codeBtn = buttons.find(btn => btn.getAttribute('aria-label') === 'Via code' || btn.textContent?.includes('Via code') || btn.textContent?.includes('Melalui kode'));
                    if (codeBtn) codeBtn.click();
                });

                await randomDelay(2000, 3000);

                // Ekstrak kode
                console.log("Mengekstrak kode invite...");
                const inviteCode = await page.evaluate(() => {
                    const spans = Array.from(document.querySelectorAll('span'));
                    const codeSpan = spans.find(s => {
                        const txt = s.textContent?.trim() || '';
                        return /^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(txt);
                    });
                    return codeSpan ? codeSpan.textContent?.trim() : null;
                });

                if (inviteCode) {
                    console.log(`✅ Kode ditemukan: ${inviteCode}`);
                    const currentCookies = await page.cookies();
                    const cookieJson = JSON.stringify(currentCookies);
                    
                    await sql(
                        `UPDATE canva_accounts SET invite_code = ?, cookie = ?, invite_code_updated_at = datetime('now', '+7 hours') WHERE id = ?`,
                        [inviteCode, cookieJson, acc.id]
                    );
                    console.log(`Kode & session diperbarui untuk Node ${acc.id}`);
                } else {
                    console.log(`❌ Gagal menemukan kode untuk Node ${acc.id}`);
                }
                await page.close();
            } catch (err: any) {
                console.error(`Error pada Node ${acc.id}:`, err.message);
            }
        }
    } catch (e: any) {
        console.error("Fatal Error:", e.message);
    } finally {
        await browser.close();
    }
}

run().catch(console.error);
