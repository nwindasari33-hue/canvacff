import { webhookCallback } from "grammy";
import { bot, initBot } from "./bot";
import { sql } from "../lib/db";

export interface Env {
    BOT_TOKEN: string;
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    ADMIN_ID: string;
    GITHUB_PAT: string;
    GITHUB_USERNAME: string;
    GITHUB_REPO: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Polyfill ENV globally for bot.ts and db.ts
        
        (globalThis as any).ENV = env;
        (globalThis as any).CF_CTX = ctx;
        (globalThis as any).CF_REQ_URL = request.url;
        if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is missing in env!");
        initBot(env.BOT_TOKEN);


        const url = new URL(request.url);

        // Handle Telegram Webhook
        if (url.pathname === "/api/webhook") {
            const handleUpdate = webhookCallback(bot, "cloudflare-mod");
            return (handleUpdate as any)(request);
        }

        // Manual Trigger for Cron Actions (for testing)
        if (url.pathname === "/api/cron-trigger") {
            const eventType = url.searchParams.get("event") || "process_queue";
            if (!env.GITHUB_PAT || !env.GITHUB_USERNAME || !env.GITHUB_REPO) {
                return new Response("Missing GitHub Secrets", { status: 500 });
            }
            try {
                if (eventType === "process_queue") {
                    const hasWork = await hasPendingQueueWork();
                    if (!hasWork) {
                        return new Response("Triggered process_queue: skipped (no work)");
                    }
                }
                const res = await triggerGithubAction(env, eventType);
                return new Response(`Triggered ${eventType}: ${res.status}`);
            } catch (e: any) {
                return new Response(`Error: ${e.message}`, { status: 500 });
            }
        }

        return new Response("Bot is running on Cloudflare Workers! Set your webhook to /api/webhook");
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        
        (globalThis as any).ENV = env;
        if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is missing in env!");
        initBot(env.BOT_TOKEN);


        if (!env.GITHUB_PAT || !env.GITHUB_USERNAME || !env.GITHUB_REPO) {
            console.error("Missing GitHub Secrets in Cloudflare Worker environment.");
            return;
        }

        const cron = event.cron;
        let eventType = "process_queue";

        if (cron === "*/30 * * * *") {
            eventType = "manual_sync";
        } else if (cron === "30 2 * * *") {
            eventType = "refresh-sessions";
        }

        // Apply conditional optimization check for process_queue only
        if (eventType === "process_queue") {
            const hasWork = await hasPendingQueueWork();
            if (!hasWork) {
                console.log("[CRON] No pending work in queue. Skipping GitHub Action trigger.");
                return;
            }
        }

        try {
            console.log(`Triggering GitHub Action: ${eventType}`);
            const res = await triggerGithubAction(env, eventType);
            if (!res.ok) {
                const text = await res.text();
                console.error(`Failed to trigger ${eventType}. Status: ${res.status}. Response: ${text}`);
            } else {
                console.log(`Successfully triggered ${eventType}`);
            }
        } catch (e) {
            console.error(`Fetch error triggering ${eventType}:`, e);
        }
    },
};

/**
 * Checks if there is any pending work in the database that requires GHA to run.
 */
async function hasPendingQueueWork(): Promise<boolean> {
    try {
        // 1. Check pending invites
        const inviteRes = await sql("SELECT 1 FROM users WHERE status = 'pending_invite' LIMIT 1");
        if (inviteRes.rows && inviteRes.rows.length > 0) return true;

        // 2. Check pending kicks (expired active subscriptions)
        const expiredSubRes = await sql("SELECT 1 FROM subscriptions WHERE status = 'active' AND end_date < datetime('now', '+7 hours') LIMIT 1");
        if (expiredSubRes.rows && expiredSubRes.rows.length > 0) return true;

        // 3. Check pending kicks (users with assigned node but no active subscription)
        const noSubRes = await sql(`
            SELECT 1 FROM users u 
            LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
            WHERE u.assigned_node_id IS NOT NULL 
              AND s.id IS NULL 
            LIMIT 1
        `);
        if (noSubRes.rows && noSubRes.rows.length > 0) return true;

        // 4. Check active broadcasts
        const broadcastRes = await sql("SELECT 1 FROM broadcasts LIMIT 1");
        if (broadcastRes.rows && broadcastRes.rows.length > 0) return true;

        // 5. Check pending message deletions
        const msgQueueRes = await sql("SELECT 1 FROM message_queue WHERE delete_at < datetime('now', '+7 hours') LIMIT 1");
        if (msgQueueRes.rows && msgQueueRes.rows.length > 0) return true;

    } catch (e: any) {
        console.error("[CRON] Error checking pending queue work:", e.message || e);
        // Fallback to true on error so we don't block queue runs
        return true;
    }
    return false;
}

/**
 * Sends a repository_dispatch event to GitHub API
 */
async function triggerGithubAction(env: Env, eventType: string): Promise<Response> {
    const apiUrl = `https://api.github.com/repos/${env.GITHUB_USERNAME}/${env.GITHUB_REPO}/dispatches`;

    return await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Accept": "application/vnd.github.v3+json",
            "Authorization": `Bearer ${env.GITHUB_PAT}`,
            "User-Agent": "Cloudflare-Worker-Cron-Bot",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            event_type: eventType,
        }),
    });
}
