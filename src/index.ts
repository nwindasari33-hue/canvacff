import { webhookCallback } from "grammy";
import { bot } from "./bot";

export interface Env {
    BOT_TOKEN: string;
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    ADMIN_ID: string;
    GITHUB_PAT: string;
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
    // Add any other env vars here
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Polyfill ENV globally for bot.ts and db.ts
        (globalThis as any).ENV = env;

        const url = new URL(request.url);

        // Handle Telegram Webhook
        if (url.pathname === "/api/webhook") {
            const handleUpdate = webhookCallback(bot, "cloudflare");
            return (handleUpdate as any)(request);
        }

        // Manual Trigger for Cron Actions (for testing)
        if (url.pathname === "/api/cron-trigger") {
            const eventType = url.searchParams.get("event") || "process_queue";
            if (!env.GITHUB_PAT || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
                return new Response("Missing GitHub Secrets", { status: 500 });
            }
            try {
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

        if (!env.GITHUB_PAT || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
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
 * Sends a repository_dispatch event to GitHub API
 */
async function triggerGithubAction(env: Env, eventType: string): Promise<Response> {
    const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`;

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
