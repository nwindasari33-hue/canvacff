/// <reference lib="dom" />
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as puppeteerCore from 'puppeteer-core';
import { sql } from '../lib/db';
import * as dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import { TimeUtils } from '../src/lib/time';
import { parseCanvaCookies } from './canva_cookie';

dotenv.config();

// Setup Puppeteer
const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(StealthPlugin());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = process.env.ADMIN_ID || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || process.env.ADMIN_CHANNEL_ID || '';

const randomDelay = (min: number, max: number) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min));

const findChromeParams = [
    process.env.CHROME_BIN || "",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\" + process.env.USERNAME + "\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
];

function getChromePath() {
    for (const path of findChromeParams) {
        if (path && fs.existsSync(path)) return path;
    }
    return null;
}

async function sendTelegram(message: string) {
    if (!BOT_TOKEN || (!ADMIN_ID && !LOG_CHANNEL_ID)) return;
    const target = LOG_CHANNEL_ID || ADMIN_ID;

    // Truncate message if it exceeds Telegram's 4096 character limit
    let finalMessage = message;
    if (finalMessage.length > 4000) {
        finalMessage = finalMessage.substring(0, 3950) + "\n\n... (Sebagian log dipotong karena melebihi batas pesan Telegram)";
    }

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: target,
            text: finalMessage,
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        const errMsg = e.response?.data || e.message;
        console.error(`Telegram Error (Kirim ke ${target}):`, errMsg);
        
        // SMART FALLBACK: If sending to LOG_CHANNEL failed, try sending to ADMIN_ID directly
        if (target === LOG_CHANNEL_ID && ADMIN_ID && LOG_CHANNEL_ID !== ADMIN_ID) {
            console.log(`Mencoba kirim ulang laporan ke ADMIN_ID (${ADMIN_ID})...`);
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: ADMIN_ID,
                    text: finalMessage,
                    parse_mode: 'HTML'
                });
                console.log("✅ Berhasil kirim ke ADMIN_ID.");
            } catch (e2: any) {
                console.error("Telegram Error (Kirim ke Admin):", e2.response?.data || e2.message);
            }
        }
    }
}

async function handleConfirmation(page: any): Promise<boolean> {
    console.log("   👀 Waking up for Confirmation Modal...");
    await new Promise(r => setTimeout(r, 2000));

    const confirms = await page.$$('button');
    for (const cBtn of confirms) {
        const cTxtRaw = await cBtn.evaluate((e: any) => e.innerText);
        const cTxt = cTxtRaw.toLowerCase();
        if (cTxt.includes('remove') || cTxt.includes('hapus') || cTxt.includes('delete') || cTxt.includes('confirm')) {
            console.log(`   🔨 Clicking Confirm (Button): "${cTxtRaw}"`);
            await cBtn.click();
            return true;
        }
    }

    const divBtns = await page.$$('div[role="button"]');
    for (const dBtn of divBtns) {
        const dTxtRaw = await dBtn.evaluate((e: any) => e.innerText);
        const dTxt = dTxtRaw.toLowerCase();
        if (dTxt.includes('remove') || dTxt.includes('hapus')) {
            console.log(`   🔨 Clicking Confirm (Div): "${dTxtRaw}"`);
            await dBtn.click();
            return true;
        }
    }
    return false;
}

async function runManualSync() {
    console.log(`[${TimeUtils.format()}] 🧹 MANUAL FULL SYNC Started...`);
    
    // Stats Trackers
    let totalGhostKicked = 0;
    let totalExpiredKicked = 0;
    let totalStaleRevoked = 0;
    let totalNodesProcessed = 0;
    let slotReport = "--- Rincian Slot Tersedia ---\n";
    let totalSlotsLeft = 0;

    // 0. Update expired subscriptions status to 'expired'
    await sql(`UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND end_date < datetime('now', '+7 hours')`);

    // 0.1 Prepare Memory Lists
    const activeSubRes = await sql(`
        SELECT DISTINCT u.email 
        FROM subscriptions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.status = 'active' 
          AND s.end_date >= datetime('now', '+7 hours')
        UNION
        SELECT email FROM users WHERE status = 'pending_invite'
    `);

    const expiredSubRes = await sql(`
        SELECT DISTINCT u.email 
        FROM subscriptions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.status = 'expired'
          AND NOT EXISTS (
              SELECT 1 FROM subscriptions s2 
              WHERE s2.user_id = s.user_id 
                AND s2.status = 'active' 
                AND s2.end_date >= datetime('now', '+7 hours')
          )
    `);

    const staleRes = await sql(`SELECT email FROM users WHERE status = 'pending_invite' AND joined_at < datetime('now', '+7 hours', '-15 minutes')`);
    const adminRes = await sql(`SELECT email FROM users WHERE role = 'admin'`);

    const safetyList = new Set([
        ...adminRes.rows.map((r: any) => (r.email || "").toLowerCase())
    ]);

    const whiteList = new Set(activeSubRes.rows.map((r: any) => (r.email || "").toLowerCase()));
    const blackList = new Set(expiredSubRes.rows.map((r: any) => (r.email || "").toLowerCase()));
    const staleSet = new Set(staleRes.rows.map((r: any) => (r.email || "").toLowerCase()));

    // 1. Get ALL Active Nodes
    const accountsRes = await sql("SELECT * FROM canva_accounts WHERE is_active = 1 ORDER BY id ASC");
    const accounts = accountsRes.rows;

    if (accounts.length === 0) {
        await sendTelegram("⚠️ <b>Sinkronisasi Manual Dibatalkan</b>\nTidak ada Node Canva aktif.");
        return;
    }

    const chromePath = getChromePath();
    if (!chromePath) throw new Error("Chrome not found!");

    // Get User Agent if any
    let globalUA = "";
    try {
        const uaRes = await sql("SELECT value FROM settings WHERE key = 'canva_user_agent'");
        if (uaRes.rows.length > 0) globalUA = uaRes.rows[0].value as string;
    } catch {}

    let browser: any;
    try {
        const versionRes = await axios.get('http://127.0.0.1:9222/json/version', { timeout: 3000 });
        const wsEndpoint = versionRes.data.webSocketDebuggerUrl;
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
    } catch {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: process.env.CI ? "new" : false,
            defaultViewport: null,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--start-maximized',
                '--disable-blink-features=AutomationControlled'
            ]
        });
    }

    try {
        for (const account of accounts) {
            totalNodesProcessed++;
            console.log(`\n============== NODE ID: ${account.id} =================`);

            const page = await browser.newPage();
            if (globalUA) await page.setUserAgent(globalUA);

            await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');

            const cookies = parseCanvaCookies(account.cookie as string);
            await page.setCookie(...cookies);

            console.log(`   🔗 Navigating to: settings/people`);
            await page.goto('https://www.canva.com/settings/people', { waitUntil: 'networkidle2', timeout: 60000 });
            await randomDelay(2000, 3000);

            if (page.url().includes('login') || page.url().includes('signup')) {
                console.error(`   ❌ Node ${account.id} Cookie EXPIRED!`);
                await sql("UPDATE canva_accounts SET is_active = 0 WHERE id = ?", [account.id]);
                slotReport += `• Akun ${account.id}: ❌ Cookie Expired\n`;
                await page.close();
                continue;
            }

            // Scroll down
            console.log("   📜 Scrolling...");
            await page.evaluate(async () => {
                await new Promise<void>((resolve) => {
                    let totalHeight = 0;
                    const distance = 150;
                    let noScrollCount = 0;
                    const timer = setInterval(() => {
                        const sH = (document as any).body.scrollHeight;
                        (window as any).scrollBy(0, distance);
                        totalHeight += distance;
                        if (((window as any).innerHeight + (window as any).scrollY) >= sH - 50) {
                            noScrollCount++;
                            if (noScrollCount > 40) { clearInterval(timer); resolve(); }
                        } else { noScrollCount = 0; }
                        if (totalHeight >= 150000) { clearInterval(timer); resolve(); }
                    }, 50);
                });
            });
            await randomDelay(2000, 3000);

            // Read live member count
            const liveMemberCount = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('h1, h2, h3, span, div'));
                for (const el of elements) {
                    const txt = el.textContent || '';
                    const match = txt.match(/(?:People|Anggota|Orang)\s*\((\d+)\)/i);
                    if (match) return parseInt(match[1]);
                }
                return null;
            });

            if (liveMemberCount !== null) {
                console.log(`   📊 Live Member Count: ${liveMemberCount}`);
                account.member_count = liveMemberCount;
            }

            console.log("   🔍 Scanning Users...");
            const scanResult = await page.evaluate((bgWhiteList: string[], bgBlackList: string[], bgSafetyList: string[], bgStaleList: string[]) => {
                const targets: { email: string, reason: string }[] = [];
                const safeSet = new Set(bgSafetyList);
                const whiteSet = new Set(bgWhiteList);
                const blackSet = new Set(bgBlackList);
                const staleSet = new Set(bgStaleList);

                document.querySelectorAll('tbody tr, div[role="row"]').forEach(row => {
                    const text = (row as HTMLElement).innerText.toLowerCase();
                    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/;
                    const match = text.match(emailRegex);
                    if (!match) return;

                    const email = match[0];
                    if (safeSet.has(email) || text.includes('owner') || text.includes('administrator')) return;
                    if (whiteSet.has(email)) return;

                    const isInvited = text.includes('invited') || text.includes('pending') || text.includes('diundang');
                    let reason = "";

                    if (isInvited) {
                        if (staleSet.has(email)) reason = "STALE INVITE";
                        else if (!whiteSet.has(email) && !blackSet.has(email)) reason = "GHOST INVITE";
                    } else {
                        if (blackSet.has(email)) reason = "EXPIRED";
                        else if (!whiteSet.has(email)) reason = "GHOST MEMBER";
                    }

                    if (reason) {
                        console.log(`   🔻 Selecting to KICK: ${email} | Reason: ${reason}`);
                        const checkbox = row.querySelector('input[type="checkbox"]');
                        if (checkbox && !(checkbox as any).checked) {
                            (checkbox as HTMLElement).click();
                            targets.push({ email, reason });
                        }
                    }
                });
                return { targets };
            }, Array.from(whiteList), Array.from(blackList), Array.from(safetyList), Array.from(staleSet));

            console.log(`   🎯 Selected ${scanResult.targets.length} users to kick.`);

            if (scanResult.targets.length > 0) {
                try {
                    await randomDelay(1000, 2000);
                    const buttons = await page.$$('button');
                    let kickSuccess = false;

                    for (const btn of buttons) {
                        const txtRaw = await btn.evaluate((e: any) => e.innerText);
                        const ariaLabel = await btn.evaluate((e: any) => e.getAttribute('aria-label')) || "";
                        const txt = txtRaw.toLowerCase();
                        const aria = ariaLabel.toLowerCase();

                        if (aria.includes('remove users') || aria.includes('hapus pengguna') ||
                            ((txt.includes('remove') || txt.includes('hapus')) && (txt.includes('team') || txt.includes('tim')))) {
                            await btn.click();
                            await randomDelay(1000, 2000);
                            kickSuccess = await handleConfirmation(page);
                            if (kickSuccess) break;
                        }
                    }

                    if (!kickSuccess) {
                        for (const btn of buttons) {
                            const txtRaw = await btn.evaluate((e: any) => e.innerText);
                            const ariaLabel = await btn.evaluate((e: any) => e.getAttribute('aria-label')) || "";
                            if ((txtRaw && txtRaw.toLowerCase().includes('remove')) || (ariaLabel && ariaLabel.toLowerCase().includes('remove'))) {
                                await btn.click();
                                await randomDelay(1000, 2000);
                                kickSuccess = await handleConfirmation(page);
                                if (kickSuccess) break;
                            }
                        }
                    }

                    if (kickSuccess) {
                        console.log("   ⚔️ Executed Kick (Confirmed).");
                        
                        // Sync DB and Count Stats
                        for (const target of scanResult.targets) {
                            if (target.reason.includes("GHOST")) totalGhostKicked++;
                            else if (target.reason === "EXPIRED") totalExpiredKicked++;
                            else if (target.reason === "STALE INVITE") totalStaleRevoked++;

                            const userRes = await sql(`SELECT id, username, first_name FROM users WHERE email = ?`, [target.email]);
                            for (const row of userRes.rows) {
                                const userId = row.id as number;
                                await sql(`UPDATE users SET status = 'expired', assigned_node_id = NULL WHERE id = ?`, [userId]);
                                await sql(`UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`, [userId]);
                            }
                        }

                        // Update local and database member count
                        account.member_count = Math.max(0, (account.member_count as number) - scanResult.targets.length);
                    }
                } catch (e) {
                    console.error("Kick execution failed", e);
                }
            }

            // ================== GET LATEST INVITE CODE ==================
            await randomDelay(2000, 3000);
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const inviteBtn = buttons.find(btn => {
                    const txt = btn.textContent?.toLowerCase() || '';
                    return txt.includes('invite') || txt.includes('undang');
                });
                if (inviteBtn) inviteBtn.click();
            });

            await randomDelay(3000, 4000);
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const codeBtn = buttons.find(btn => btn.getAttribute('aria-label') === 'Via code' || btn.textContent?.includes('Via code') || btn.textContent?.includes('Melalui kode'));
                if (codeBtn) codeBtn.click();
            });

            await randomDelay(2000, 3000);
            const inviteCode = await page.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('span'));
                const codeSpan = spans.find(s => {
                    const txt = s.textContent?.trim() || '';
                    return /^[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}\s*-\s*[A-Z0-9]{3}$/.test(txt);
                });
                return codeSpan ? codeSpan.textContent?.trim() : null;
            });

            if (inviteCode) {
                console.log(`   ✅ New Invite Code: ${inviteCode}`);
                account.invite_code = inviteCode;
            } else {
                console.log(`   ❌ Gagal menemukan kode invite.`);
            }

            // Save Session & Commit to DB
            const currentCookies = await page.cookies();
            const cookieJson = JSON.stringify(currentCookies);
            
            await sql(
                `UPDATE canva_accounts SET member_count = ?, invite_code = ?, cookie = ?, last_used = datetime('now', '+7 hours'), invite_code_updated_at = datetime('now', '+7 hours') WHERE id = ?`,
                [account.member_count, account.invite_code, cookieJson, account.id]
            );

            // Tally Slots
            const maxSlot = (account.max_slots as number) || 500;
            const currentMembers = (account.member_count as number) || 0;
            const slotLeft = Math.max(0, maxSlot - currentMembers);
            totalSlotsLeft += slotLeft;

            let slotStatusText = `${slotLeft} Slot`;
            if (slotLeft === 0) slotStatusText = "Penuh (0 Slot)";
            slotReport += `• Akun ${account.id}: ${slotStatusText}\n`;

            await page.close();
        }

        // ================== COMPILE AND SEND REPORT ==================
        const reportText = 
            `🧹 <b>LAPORAN SINKRONISASI MANUAL</b> 🧹\n\n` +
            `📊 <b>Total Node Diproses:</b> ${totalNodesProcessed} Node\n` +
            `✅ <b>Penumpang Gelap Dikeluarkan:</b> ${totalGhostKicked} Email\n` +
            `⏰ <b>User Expired Dikeluarkan:</b> ${totalExpiredKicked} Email\n` +
            `🗑️ <b>Undangan Hangus Dibatalkan:</b> ${totalStaleRevoked} Undangan\n\n` +
            `${slotReport}\n` +
            `<b>[Total Slot Tersisa: ${totalSlotsLeft} Slot]</b>\n\n` +
            `✅ <i>Semua kode undangan terbaru telah di-refresh!</i>`;

        // Print fully to console just in case
        console.log("\n--- FULL REPORT LOG ---\n" + reportText + "\n-----------------------\n");
        await sendTelegram(reportText);
        console.log(`[${TimeUtils.format()}] 🧹 MANUAL FULL SYNC FINISHED.`);

    } catch (e: any) {
        console.error("Critical Error:", e);
        await sendTelegram(`❌ <b>Manual Sync Error</b>\n${e.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

runManualSync().then(() => {
    console.log("Exiting cleanly.");
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
