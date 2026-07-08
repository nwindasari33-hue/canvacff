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
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: target,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (e) {
        console.error("Telegram Error:", e);
    }
}

async function kickEnforcer() {
    console.log(`[${TimeUtils.format()}] 👮 Auto-Kick ENFORCER Mode Started (Multi-Account)...`);

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

    console.log(`📊 DB Stats: ${whiteList.size} Active, ${blackList.size} Expired, ${staleSet.size} Stale Invites.`);

    // 1. Get Active Nodes (Chunking limit: 5 oldest checked nodes)
    const accountsRes = await sql("SELECT * FROM canva_accounts WHERE is_active = 1 ORDER BY last_used ASC LIMIT 5");
    const accounts = accountsRes.rows;

    if (accounts.length === 0) {
        console.log("⚠️ No active accounts found. Skipping kick job.");
        return;
    }

    const chromePath = getChromePath();
    if (!chromePath) throw new Error("Chrome not found!");

    // Launch/Connect Browser
    let browser: any;
    try {
        const versionRes = await axios.get('http://127.0.0.1:9222/json/version', { timeout: 3000 });
        const wsEndpoint = versionRes.data.webSocketDebuggerUrl;
        console.log(`🔌 Connecting to existing Chrome instance on port 9222...`);
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
    } catch {
        console.log(`🚀 Spawning new Chrome instance...`);
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
        const page = await browser.newPage();

        for (const account of accounts) {
            console.log(`\n============== ACCOUNT ID: ${account.id} =================`);

            await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');

            const cookies = parseCanvaCookies(account.cookie as string);
            await page.setCookie(...cookies);
            console.log(`   🍪 Loaded cookies for Account ${account.id}.`);

            const peopleUrl = 'https://www.canva.com/settings/people';
            console.log(`   🔗 Navigating to: ${peopleUrl}`);

            await page.goto(peopleUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await randomDelay(2000, 3000);

            if (page.url().includes('login') || page.url().includes('signup')) {
                console.error(`   ❌ Account ${account.id} Cookie EXPIRED!`);
                await sql("UPDATE canva_accounts SET is_active = 0 WHERE id = ?", [account.id]);
                continue;
            }

            // Scroll down to load all table rows
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

            // Read live member count from header e.g. "People (123)"
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
                await sql("UPDATE canva_accounts SET member_count = ?, last_used = datetime('now', '+7 hours') WHERE id = ?", [liveMemberCount, account.id]);
                account.member_count = liveMemberCount;
            }

            console.log("   🔍 Scanning...");
            const scanResult = await page.evaluate((bgWhiteList: string[], bgBlackList: string[], bgSafetyList: string[], bgStaleList: string[]) => {
                const targets: string[] = [];
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
                    
                    // If in whitelist (active subscription/invite), skip kicking
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
                            targets.push(email);
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

                            console.log(`   🖱️ Clicking Primary Button: "${ariaLabel || txtRaw}"`);
                            await btn.click();
                            await randomDelay(1000, 2000);
                            kickSuccess = await handleConfirmation(page);
                            if (kickSuccess) break;
                        }
                    }

                    if (!kickSuccess) {
                        console.log("   ⚠️ Primary button not found. Trying fallback generic 'Remove'...");
                        for (const btn of buttons) {
                            const txtRaw = await btn.evaluate((e: any) => e.innerText);
                            const ariaLabel = await btn.evaluate((e: any) => e.getAttribute('aria-label')) || "";

                            if ((txtRaw && txtRaw.toLowerCase().includes('remove')) || (ariaLabel && ariaLabel.toLowerCase().includes('remove'))) {
                                console.log(`   🖱️ Clicking Fallback Button: "${ariaLabel || txtRaw}"`);
                                await btn.click();
                                await randomDelay(1000, 2000);
                                kickSuccess = await handleConfirmation(page);
                                if (kickSuccess) break;
                            }
                        }
                    }

                    if (kickSuccess) {
                        console.log("   ⚔️ Executed Kick (Confirmed). Syncing DB status...");
                        await sendTelegram(`⚔️ <b>Auto-Kick Executed</b>\nAccount: ${account.id}\nTargets: ${scanResult.targets.length}`);

                        // Sync Database state for kicked targets
                        for (const email of scanResult.targets) {
                            const userRes = await sql(`SELECT id, username, first_name FROM users WHERE email = ?`, [email]);
                            for (const row of userRes.rows) {
                                const userId = row.id as number;
                                const username = row.username ? `@${row.username}` : (row.first_name || 'No Name');
                                
                                await sql(`UPDATE users SET status = 'expired', assigned_node_id = NULL WHERE id = ?`, [userId]);
                                await sql(`UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`, [userId]);
                                
                                if (userId > 0) {
                                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                        chat_id: userId,
                                        text: `⚠️ <b>Akses Canva Pro Anda Telah Berakhir</b>\nAkses Anda telah berakhir sesuai durasi paket. Terima kasih telah berlangganan!`,
                                        parse_mode: 'HTML'
                                    }).catch(() => {});
                                }
                                console.log(`      ✅ Synced user ${userId} to expired/kicked.`);
                            }
                        }

                        // Update local and database member count
                        const updatedCount = Math.max(0, (account.member_count as number) - scanResult.targets.length);
                        await sql("UPDATE canva_accounts SET member_count = ? WHERE id = ?", [updatedCount, account.id]);
                    } else {
                        console.log("   ❌ Failed to find/click Confirmation Button.");
                    }

                } catch (e) {
                    console.error("Kick execution failed", e);
                }
            }

            // Save Session Cookies
            const currentCookies = await page.cookies();
            if (currentCookies.length > 0) {
                const cookieJson = JSON.stringify(currentCookies);
                await sql("UPDATE canva_accounts SET cookie = ?, last_used = datetime('now', '+7 hours') WHERE id = ?", [cookieJson, account.id]);
                console.log(`   🍪 [SESSION] Cookies Auto-Refreshed & Saved to Account ${account.id}!`);
            }
        }

    } catch (e: any) {
        console.error("Critical Error:", e);
    } finally {
        await browser.close();
    }
}

async function handleConfirmation(page: any): Promise<boolean> {
    console.log("   👀 Waking up for Confirmation Modal...");
    await new Promise(r => setTimeout(r, 2000));

    const confirms = await page.$$('button');
    const debugTexts: string[] = [];

    for (const cBtn of confirms) {
        const cTxtRaw = await cBtn.evaluate((e: any) => e.innerText);
        debugTexts.push(cTxtRaw.trim());
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
        debugTexts.push(`[DIV] ${dTxtRaw.trim()}`);
        const dTxt = dTxtRaw.toLowerCase();

        if (dTxt.includes('remove') || dTxt.includes('hapus')) {
            console.log(`   🔨 Clicking Confirm (Div): "${dTxtRaw}"`);
            await dBtn.click();
            return true;
        }
    }

    console.log(`   ❌ Confirmation Button NOT Found! Saw: ${JSON.stringify(debugTexts)}`);
    return false;
}

kickEnforcer();
