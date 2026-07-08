import { sql } from '../lib/db';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

async function run() {
    if (!BOT_TOKEN) {
        console.log("BOT_TOKEN is missing. Aborting.");
        return;
    }

    // Get mandatory channels
    const settings = await sql("SELECT value FROM settings WHERE key = 'mandatory_channels'");
    if (settings.rows.length === 0 || !settings.rows[0].value) {
        console.log("No mandatory channels configured.");
        return;
    }

    const rawStr = settings.rows[0].value as string;
    const channels = rawStr.split(',').map(c => c.trim()).filter(c => c);

    if (channels.length === 0) {
        console.log("No valid channels.");
        return;
    }

    console.log(`Checking ${channels.length} mandatory channels...`);

    // Get active users
    const activeUsers = await sql(`
        SELECT u.id, u.telegram_id, u.email 
        FROM subscriptions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.status = 'active'
    `);

    if (activeUsers.rows.length === 0) {
        console.log("No active users found.");
        return;
    }

    console.log(`Verifying ${activeUsers.rows.length} active users...`);

    let kickedCount = 0;

    for (const user of activeUsers.rows) {
        const tgId = user.telegram_id as number;
        if (!tgId) continue;

        let hasLeft = false;

        for (const raw of channels) {
            const chat = raw.split('|')[0].trim();
            try {
                const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
                    params: { chat_id: chat, user_id: tgId }
                });

                const status = res.data?.result?.status;
                if (status === 'left' || status === 'kicked') {
                    hasLeft = true;
                    break;
                }
            } catch (e: any) {
                // If the bot is not admin in the channel, it will throw 400 Bad Request
                // or if user not found. We can assume if error, we skip or mark as left.
                // To be safe, we only mark 'left' if explicitly returned by API.
                if (e.response?.data?.description?.includes('user not found')) {
                    hasLeft = true;
                    break;
                }
                // Other errors (e.g. chat not found) we ignore to prevent false positives
            }
        }

        if (hasLeft) {
            console.log(`[REVOKE] User ${user.email} (TG: ${tgId}) left the channel! Marking as expired.`);
            await sql(`UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`, [user.id]);
            kickedCount++;
        }
    }

    console.log(`✅ Channel verification complete. Kicked: ${kickedCount} users.`);
}

run().catch(console.error);
