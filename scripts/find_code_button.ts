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

    console.log("Mencari akun aktif di DB...");
    const accountsRes = await sql("SELECT id, cookie, team_id FROM canva_accounts WHERE is_active = 1 LIMIT 1");
    if (accountsRes.rows.length === 0) {
        console.log("Tidak ada akun aktif.");
        return;
    }
    const acc = accountsRes.rows[0];

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        
        console.log("Set Cookie...");
        await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded' });
        const cookies = parseCanvaCookies(acc.cookie as string);
        await page.setCookie(...cookies);

        console.log("Ke halaman People Settings...");
        await page.goto('https://www.canva.com/settings/people', { waitUntil: 'networkidle2', timeout: 60000 });
        await randomDelay(3000, 4000);
        
        await page.screenshot({ path: 'debug_people_page.png' });
        console.log("Screenshot disimpan: debug_people_page.png");

        // Cari tombol Invite/Undang
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const inviteBtn = buttons.find(btn => {
                const txt = btn.textContent?.toLowerCase() || '';
                return txt.includes('invite') || txt.includes('undang');
            });
            if (inviteBtn) inviteBtn.click();
        });

        console.log("Menunggu modal...");
        await randomDelay(3000, 4000);
        await page.screenshot({ path: 'debug_invite_modal.png' });
        console.log("Screenshot disimpan: debug_invite_modal.png");

        // Dump HTML Modal
        const modalHtml = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('div[data-focus-lock-disabled]');
            return dialog ? dialog.innerHTML : document.body.innerHTML;
        });

        fs.writeFileSync('debug_modal_dump.html', modalHtml);

        // Click "Via code"
        console.log("Klik tombol Via code...");
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const codeBtn = buttons.find(btn => btn.getAttribute('aria-label') === 'Via code' || btn.textContent?.includes('Via code'));
            if (codeBtn) codeBtn.click();
        });

        await randomDelay(2000, 3000);
        await page.screenshot({ path: 'debug_code_modal.png' });
        console.log("Screenshot disimpan: debug_code_modal.png");

        // Cari kode
        const inviteCode = await page.evaluate(() => {
            // Usually it's in a readonly input or a bold span. Let's look for uppercase text of length 6-10 or just dump the new modal HTML
            const dialog = document.querySelector('[role="dialog"]') || document.querySelector('div[data-focus-lock-disabled]');
            return dialog ? dialog.innerHTML : '';
        });

        fs.writeFileSync('debug_code_modal.html', inviteCode);
        console.log("Selesai. Cek file debug_code_modal.html");

    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        await browser.close();
    }
}

run().catch(console.error);
