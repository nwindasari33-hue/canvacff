// @ts-nocheck
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

// Setup Puppeteer Extra with Stealth
const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(StealthPlugin());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = process.env.ADMIN_ID || '';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || process.env.ADMIN_CHANNEL_ID || '';

// Find Chrome Path
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

const randomDelay = (min: number, max: number) => new Promise(r => setTimeout(r, Math.random() * (max - min) + min));

async function editTelegramMessage(chatId: string | number, messageId: number, text: string, options: any = {}) {
    if (!BOT_TOKEN) return null;
    try {
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: 'HTML',
            ...options
        });
        return response.data.result.message_id;
    } catch (e: any) {
        console.error("Failed to edit Telegram message:", e.message);
        return null;
    }
}

async function sendTelegram(chatId: string | number, message: string, options: any = {}) {
    if (!BOT_TOKEN) return null;
    try {
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            ...options
        });
        return response.data.result.message_id;
    } catch (e: any) {
        console.error("Failed to send Telegram:", e.message);
        return null;
    }
}

async function deleteTelegramMessage(chatId: string | number, messageId: number) {
    if (!BOT_TOKEN) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            chat_id: chatId,
            message_id: messageId
        });
        console.log(`🗑️ Deleted message ${messageId} for user ${chatId}`);
    } catch (e: any) {
        console.error("Failed to delete Telegram message:", e.message);
    }
}

async function processMessageQueue() {
    console.log("🧹 Processing Message Deletion Queue...");
    try {
        const expired = await sql(`SELECT * FROM message_queue WHERE delete_at < datetime('now', '+7 hours')`);
        if (expired.rows.length > 0) {
            console.log(`   🗑️ Found ${expired.rows.length} messages to delete.`);
            for (const msg of expired.rows) {
                await deleteTelegramMessage(msg.chat_id, msg.message_id as number);
                await sql(`DELETE FROM message_queue WHERE id = ?`, [msg.id]);
            }
        }
    } catch (e: any) {
        console.error("❌ Error processing message queue:", e.message);
    }
}

async function sendSystemLog(message: string) {
    const target = LOG_CHANNEL_ID || ADMIN_ID;
    if (!BOT_TOKEN || !target) return;
    const time = TimeUtils.format();
    const logMsg = `📝 <b>System Log</b> [${time}]\n\n${message}`;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: target,
            text: logMsg,
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        console.error("Failed to send system log:", e.message);
    }
}

async function runPuppeteerQueue() {
    console.log("🦾 Queue Processor Started...");

    // 0. Process message deletions first
    await processMessageQueue();

    // 0.1 Update expired subscriptions status to 'expired'
    await sql(`
        UPDATE subscriptions 
        SET status = 'expired' 
        WHERE status = 'active' 
          AND end_date < datetime('now', '+7 hours')
    `);

    // 1. Fetch pending invites
    const pendingInvites = await sql(`
        SELECT u.*, p.name as plan_name, p.duration_days, p.id as prod_id
        FROM users u 
        LEFT JOIN products p ON u.selected_product_id = p.id 
        WHERE u.status = 'pending_invite'
    `);

    // 1.2 Fetch users to kick (active status but has no active subscriptions)
    const toKick = await sql(`
        SELECT DISTINCT u.id, u.email, u.username, u.first_name, u.assigned_node_id, p.name as plan_name, s.end_date
        FROM users u 
        LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
        LEFT JOIN products p ON s.product_id = p.id
        WHERE u.assigned_node_id IS NOT NULL 
          AND s.id IS NULL
    `);

    if (pendingInvites.rows.length === 0 && toKick.rows.length === 0) {
        console.log("✅ Queue is empty. Nothing to do.");
        return;
    }

    const startMsg = `⚙️ <b>Job Dimulai</b>\n📊 Antrian Invite: ${pendingInvites.rows.length}\n📊 User Expired (Kick Queue): ${toKick.rows.length}`;
    console.log(startMsg);
    await sendSystemLog(startMsg);

    // 2. Select and Distribute to Canva Accounts (Nodes)
    const accountsRes = await sql("SELECT * FROM canva_accounts WHERE is_active = 1 ORDER BY id ASC");
    const accounts = accountsRes.rows.map((acc: any) => ({
        ...acc,
        slots_left: Math.max(0, (acc.max_slots as number) - (acc.member_count as number)),
        invites_to_process: [] as any[],
        kicks_to_process: [] as any[]
    }));

    if (accounts.length === 0) {
        throw new Error("❌ No active Canva accounts found in DB!");
    }

    // Distribute Kicks
    for (const user of toKick.rows) {
        const nodeId = user.assigned_node_id as number;
        const acc = accounts.find(a => a.id === nodeId);
        if (acc) {
            acc.kicks_to_process.push(user);
        } else {
            console.log(`⚠️ User ${user.email} assigned to inactive/missing node ${nodeId}. Updating DB status...`);
            await sql(`UPDATE users SET status = 'expired', assigned_node_id = NULL WHERE id = ?`, [user.id]);
        }
    }

    // Distribute Invites
    for (const user of pendingInvites.rows) {
        const acc = accounts.find(a => a.slots_left > 0);
        if (acc) {
            acc.invites_to_process.push(user);
            acc.slots_left--;
        } else {
            console.log(`⚠️ No slots available for user ${user.email}. Retaining in queue.`);
        }
    }

    let successInvites = 0;
    let failInvites = 0;
    let successKicks = 0;
    let failKicks = 0;

    const chromePath = getChromePath();
    if (!chromePath) throw new Error("Chrome tidak ditemukan!");

    // Load User Agent
    let globalUA = "";
    try {
        const uaRes = await sql("SELECT value FROM settings WHERE key = 'canva_user_agent'");
        if (uaRes.rows.length > 0) globalUA = uaRes.rows[0].value as string;
    } catch { console.log("⚠️ Failed to fetch custom UA, using default."); }

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
            headless: process.env.CI ? 'new' : false,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--start-maximized',
                '--disable-blink-features=AutomationControlled'
            ]
        });
    }

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    if (globalUA) {
        await page.setUserAgent(globalUA);
    }

    // Process each Account Node
    for (const acc of accounts) {
        if (acc.invites_to_process.length === 0 && acc.kicks_to_process.length === 0) continue;

        console.log(`\n============== PROCESSING NODE ID: ${acc.id} =================`);

        try {
            // Set Cookies
            await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            
            // Clear current browser cookies before injecting new ones
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');

            const cookies = parseCanvaCookies(acc.cookie as string);
            await page.setCookie(...cookies);
            console.log(`   🍪 Loaded ${cookies.length} cookies.`);

            await page.goto('https://www.canva.com/folder/all-designs', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await randomDelay(2000, 3000);

            if (page.url().includes('login') || page.url().includes('signup')) {
                console.error(`   ❌ Account ID ${acc.id} Cookie EXPIRED!`);
                await sendSystemLog(`⚠️ <b>Akun Mati!</b>\nID: ${acc.id}\nCookie Expired. Mohon update.`);
                await sql("UPDATE canva_accounts SET is_active = 0 WHERE id = ?", [acc.id]);
                continue;
            }

            console.log("   ✅ Login Success!");

            // Auto-Discovery Team ID
            if (!acc.team_id) {
                await page.goto("https://www.canva.com/brand", { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                const currentUrl = page.url();
                const brandMatch = currentUrl.match(/brand\/([a-zA-Z0-9_-]+)/);
                if (brandMatch) {
                    acc.team_id = brandMatch[1];
                    await sql("UPDATE canva_accounts SET team_id = ? WHERE id = ?", [acc.team_id, acc.id]);
                }
            }

            const teamUrl = 'https://www.canva.com/settings/people';
            console.log(`   🌐 Navigating to people settings: ${teamUrl}`);
            await page.goto(teamUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await randomDelay(3000, 4000);

            // Read member count from header e.g. "People (123)"
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
                await sql("UPDATE canva_accounts SET member_count = ?, last_used = datetime('now', '+7 hours') WHERE id = ?", [liveMemberCount, acc.id]);
                acc.member_count = liveMemberCount;
            }

            // ============================================================
            // 1. PROCESS KICKS
            // ============================================================
            for (const user of acc.kicks_to_process) {
                const email = user.email as string;
                const userId = user.id as number;
                const username = user.username ? `@${user.username}` : (user.first_name || 'No Name');
                const planName = user.plan_name || 'Premium';
                const endDate = user.end_date ? TimeUtils.format(new Date((user.end_date as string).replace(' ', 'T') + 'Z')).replace(' WIB', '') : '-';

                console.log(`   🦶 Kicking user: ${email}`);

                // Search for row containing email
                const rowResult = await page.evaluate((targetEmail: string) => {
                    const allEl = Array.from(document.querySelectorAll('span, div, td, p'));
                    const found = allEl.find(el => el.textContent?.trim().toLowerCase() === targetEmail.toLowerCase());
                    if (found) {
                        let parent = found.parentElement;
                        while (parent && parent.tagName !== 'TR' && !parent.querySelector('input[type="checkbox"]')) {
                            parent = parent.parentElement;
                            if (parent === document.body) break;
                        }
                        const checkbox = parent ? parent.querySelector('input[type="checkbox"]') : null;
                        return checkbox ? { found: true } : { found: false };
                    }
                    return { found: false };
                }, email);

                if (rowResult.found) {
                    // Execute Kick
                    const kickSuccess = await page.evaluate(async (targetEmail: string) => {
                        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
                        const findByText = (tag: string, text: string) => Array.from(document.querySelectorAll(tag)).find(el => el.textContent?.toLowerCase().includes(text.toLowerCase())) as HTMLElement;

                        try {
                            const allEl = Array.from(document.querySelectorAll('span, div, td, p'));
                            const found = allEl.find(el => el.textContent?.trim().toLowerCase() === targetEmail.toLowerCase());
                            let row = found?.parentElement;
                            while (row && row.tagName !== 'TR' && !row.querySelector('input[type="checkbox"]')) {
                                row = row.parentElement;
                            }
                            const checkbox = row?.querySelector('input[type="checkbox"]') as HTMLElement;
                            checkbox.click();
                            await sleep(1500);

                            const deleteBtn = (document.querySelector('button[aria-label*="Remove" i]') ||
                                              document.querySelector('button[aria-label*="Delete" i]') ||
                                              document.querySelector('button[aria-label*="Hapus" i]') ||
                                              document.querySelector('.vxQy1w')) as HTMLElement;
                            
                            deleteBtn.click();
                            await sleep(2000);

                            const confirmBtn = (findByText('button', 'Remove from team') ||
                                               findByText('span', 'Remove from team') ||
                                               findByText('button', 'Hapus dari tim') ||
                                               findByText('span', 'Hapus dari tim') ||
                                               document.querySelector('button[kind="destructive"]')) as HTMLElement;

                            confirmBtn.click();
                            await sleep(2500);
                            return { success: true };
                        } catch (err: any) {
                            return { success: false, message: err.message };
                        }
                    }, email);

                    if (kickSuccess.success) {
                        console.log(`      ✅ Successfully kicked: ${email}`);
                        successKicks++;
                        await sql(`UPDATE users SET status = 'expired', assigned_node_id = NULL WHERE id = ?`, [userId]);
                        await sql(`UPDATE subscriptions SET status = 'kicked' WHERE user_id = ? AND status = 'active'`, [userId]);
                        
                        if (userId > 0) {
                            await sendTelegram(userId, `⚠️ <b>Akses Canva Pro Anda Telah Berakhir</b>\nAkses Anda telah berakhir sesuai durasi paket. Terima kasih telah berlangganan!`);
                        }
                        await sendSystemLog(`🦶 <b>User Kicked</b>\n👤 User: ${username}\n📧 Email: <code>${email}</code>\n📦 Paket: ${planName}`);
                        acc.member_count--;
                    } else {
                        console.log(`      ⚠️ Kick execution failed: ${kickSuccess.message}`);
                        failKicks++;
                    }
                } else {
                    // Email not found in Canva, sync database directly
                    console.log(`      ℹ️ Email ${email} not found in Canva list. Syncing DB state to expired...`);
                    successKicks++;
                    await sql(`UPDATE users SET status = 'expired', assigned_node_id = NULL WHERE id = ?`, [userId]);
                    await sql(`UPDATE subscriptions SET status = 'kicked' WHERE user_id = ? AND status = 'active'`, [userId]);
                    await sendSystemLog(`ℹ️ <b>User Kicked (Sync)</b>\nUser ${username} sudah tidak berada di Canva. DB disinkronisasi.`);
                }
            }

            // ============================================================
            // 2. PROCESS INVITES
            // ============================================================
            for (const user of acc.invites_to_process) {
                const email = user.email as string;
                const userId = user.id as number;
                const prodId = user.prod_id || 1;
                const duration = user.duration_days || 30;
                const planName = user.plan_name || 'Trial';
                
                const endDateObj = TimeUtils.addDaysWIB(duration);
                const endDateStr = endDateObj.toISOString().replace('T', ' ').substring(0, 19);

                console.log(`   🚀 Inviting user: ${email}`);

                // Click "Review and invite"
                let opened = false;
                for (let retry = 0; retry < 3; retry++) {
                    await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const inviteBtn = buttons.find(btn => {
                            const txt = btn.textContent?.toLowerCase() || '';
                            return txt.includes('review and invite') || txt.includes('undang') || txt.includes('invite');
                        });
                        if (inviteBtn) inviteBtn.click();
                    });
                    
                    try {
                        await page.waitForSelector('input[placeholder="Enter email address..."]', { visible: true, timeout: 2500 });
                        opened = true;
                        break;
                    } catch {
                        console.log(`      ⚠️ Modal did not open, retrying click (attempt ${retry + 1}/3)...`);
                        await randomDelay(1000, 1500);
                    }
                }

                if (!opened) {
                    console.log('      ❌ Review and invite modal could not be opened.');
                    failInvites++;
                    continue;
                }

                let inviteSuccess = false;
                let inviteErr = "";
                const debugDir = './debug_screenshots';
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                const ts = Date.now();

                try {
                    await page.screenshot({ path: `${debugDir}/invite_1_modal_open_${ts}.png`, fullPage: false });
                    await page.focus('input[placeholder="Enter email address..."]');
                    await page.keyboard.down('Control');
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up('Control');
                    await page.keyboard.press('Backspace');
                    await page.type('input[placeholder="Enter email address..."]', email, { delay: 80 });
                    await randomDelay(800, 1200);
                    await page.screenshot({ path: `${debugDir}/invite_2_typed_${ts}.png`, fullPage: false });
                    await page.keyboard.press('Tab');
                    await randomDelay(500, 800);
                    try { await page.focus('input[placeholder="Enter email address..."]'); } catch {}
                    await page.keyboard.press('Enter');
                    await randomDelay(1500, 2000);
                    await page.screenshot({ path: `${debugDir}/invite_3_chip_${ts}.png`, fullPage: false });

                    const sendBtnState = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const submitBtn = buttons.find(btn => {
                            const txt = btn.textContent || '';
                            return txt.includes('Send invitations') || txt.includes('Undang');
                        });
                        if (!submitBtn) return { found: false, disabled: false, text: '' };
                        return { found: true, disabled: submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true', text: submitBtn.textContent?.trim() || '' };
                    });

                    console.log(`      📋 Send button: found=${sendBtnState.found}, disabled=${sendBtnState.disabled}, text="${sendBtnState.text}"`);

                    if (!sendBtnState.found) {
                        inviteErr = "Send button not found in DOM";
                    } else if (sendBtnState.disabled) {
                        inviteErr = `Send button is DISABLED (email chip may not have been created). Button text: "${sendBtnState.text}"`;
                    } else {
                        await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button'));
                            const submitBtn = buttons.find(btn => {
                                const txt = btn.textContent || '';
                                return txt.includes('Send invitations') || txt.includes('Undang');
                            }) as HTMLElement;
                            submitBtn.click();
                        });

                        await randomDelay(2000, 3000);
                        await page.screenshot({ path: `${debugDir}/invite_4_after_send_${ts}.png`, fullPage: false });

                        const modalClosed = await page.waitForSelector(
                            'input[placeholder="Enter email address..."]',
                            { hidden: true, timeout: 8000 }
                        ).then(() => true).catch(() => false);

                        console.log(`      📋 Modal closed after send: ${modalClosed}`);

                        if (modalClosed) {
                            await randomDelay(2000, 3000);
                            const postInviteCheck = await page.evaluate((targetEmail: string) => {
                                const rows = Array.from(document.querySelectorAll('tbody tr'));
                                const emailInTable = rows.some(row => (row.textContent || '').toLowerCase().includes(targetEmail.toLowerCase()));
                                return { emailInTable };
                            }, email);
                            await page.screenshot({ path: `${debugDir}/invite_5_final_${ts}.png`, fullPage: false });
                            if (postInviteCheck.emailInTable) inviteSuccess = true;
                            else inviteErr = "Modal closed but email NOT found in table";
                        } else {
                            await page.screenshot({ path: `${debugDir}/invite_5_modal_stuck_${ts}.png`, fullPage: false });
                            inviteErr = "Modal did not close after clicking Send — invite likely failed";
                        }
                    }
                } catch (err: any) {
                    await page.screenshot({ path: `${debugDir}/invite_error_${ts}.png`, fullPage: false }).catch(() => {});
                    inviteErr = err.message;
                }

                if (inviteSuccess) {
                    console.log(`      ✅ Successfully invited: ${email}`);
                    successInvites++;

                    await sql(`UPDATE users SET status = 'active', assigned_node_id = ?, selected_product_id = NULL WHERE id = ?`, [acc.id, userId]);
                    const activeSub = await sql(`SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active'`, [userId]);
                    const startStr = TimeUtils.getWIBISOString();

                    if (activeSub.rows.length > 0) {
                        await sql(`UPDATE subscriptions SET end_date = ?, product_id = ?, start_date = ? WHERE id = ?`, [endDateStr, prodId, startStr, activeSub.rows[0].id]);
                    } else {
                        const subId = `sub_${Date.now()}_${userId}`;
                        await sql(`INSERT INTO subscriptions (id, user_id, product_id, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, 'active')`, [subId, userId, prodId, startStr, endDateStr]);
                    }

                    if (userId > 0) {
                        const userText = `🎉 <b>UNDANGAN CANVA PRO BERHASIL DIKIRIM!</b>\n\nSilakan cek inbox email Anda: <code>${email}</code> (termasuk folder Spam/Promosi) dan klik **Gabung Tim** dari Canva.\n\n📅 <b>Expired:</b> ${endDateStr}\n\n⏳ <i>Pesan ini akan dihapus dalam 2 menit.</i>`;
                        const msgId = await sendTelegram(userId, userText);
                        if (msgId) {
                            await sql(`INSERT INTO message_queue (chat_id, message_id, delete_at) VALUES (?, ?, datetime('now', '+7 hours', '+2 minutes'))`, [userId, msgId]);
                        }
                    }

                    await sendSystemLog(`📩 <b>User Invited</b>\n👤 ID: <code>${userId}</code>\n📧 Email: <code>${email}</code>\n📦 Paket: ${planName}`);
                    acc.member_count++;
                } else {
                    console.log(`      ❌ Invite failed: ${inviteErr}`);
                    failInvites++;
                }

                await page.keyboard.press('Escape');
                await page.waitForSelector('input[placeholder="Enter email address..."]', { hidden: true, timeout: 5000 }).catch(() => {});
                await randomDelay(1500, 2500);
            }

            // Save Session Cookies
            const currentCookies = await page.cookies();
            if (currentCookies.length > 0) {
                const cookieJson = JSON.stringify(currentCookies);
                await sql("UPDATE canva_accounts SET cookie = ?, member_count = ?, last_used = datetime('now', '+7 hours'), invite_code_updated_at = datetime('now', '+7 hours') WHERE id = ?", [cookieJson, acc.member_count, acc.id]);
                console.log(`   💾 Saved updated cookies and member_count (${acc.member_count}) to DB.`);
            }

        } catch (accErr: any) {
            console.error(`❌ Critical error processing Account Node ${acc.id}:`, accErr.message);
            await sendSystemLog(`⛔ <b>Error Node ${acc.id}</b>\n${accErr.message}`);
        }
    }

    await browser.close();

    const summary = `
🏁 <b>Job Selesai</b>
✅ Sukses Invite: ${successInvites} | Kicked: ${successKicks}
❌ Gagal Invite:   ${failInvites} | Gagal Kick: ${failKicks}
    `.trim();
    await sendSystemLog(summary);
    console.log("🏁 Queue Processing Finished.");
}

runPuppeteerQueue().catch(console.error);
