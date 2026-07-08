const fs = require('fs');
let content = fs.readFileSync('src/bot.ts', 'utf8');

// 1. Remove old triggerGithubAction block entirely
content = content.replace(/\/\/\s*Helper:\s*Trigger GitHub Action\nasync function triggerGithubAction\(eventType: string = "process_queue"\): Promise<\{ success: boolean; message: string \}> \{[\s\S]*?\n\}/, '// Removed old triggerGithubAction');

// 2. Fix ArrayBuffer .data property errors
content = content.replace(/const buffer = Buffer\.from\(response\.data\);\s*\n\s*const content = buffer\.toString\('utf-8'\)\.trim\(\);/g, 'const content = new TextDecoder("utf-8").decode(response).trim();');

content = content.replace(/const buffer = Buffer\.from\(response\.data\);\s*\n\s*const content = buffer\.toString\('utf-8'\);/g, 'const content = new TextDecoder("utf-8").decode(response);');

// 3. Fix Expected 0-1 arguments for triggerGithubAction
// In bot.ts Vercel branches, triggerGithubAction was called with zero arguments.
// But the new one expects (env: any, eventType: string).
// Let's modify the new triggerGithubAction signature to make eventType optional, and return the same success object so it doesn't break old usages that expect .message
content = content.replace(/async function triggerGithubAction\(env: any, eventType: string\): Promise<any> \{/, 'async function triggerGithubAction(env: any = (globalThis as any).ENV, eventType: string = "process_queue"): Promise<{success: boolean; message: string}> {');
// Inside the new function, return success message:
content = content.replace(/return await fetch\(apiUrl, \{[\s\S]*?\}\);/, `
    try {
        const res = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Accept": "application/vnd.github.v3+json",
                "Authorization": \`Bearer \${env.GITHUB_PAT}\`,
                "User-Agent": "Cloudflare-Worker-Cron-Bot",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ event_type: eventType }),
        });
        if (res.ok) return { success: true, message: "GitHub Actions workflow berhasil dipicu!" };
        else return { success: false, message: "Gagal memicu GitHub Action: " + (await res.text()) };
    } catch (e: any) {
        return { success: false, message: "Error: " + e.message };
    }
`);

fs.writeFileSync('src/bot.ts', content);
console.log("Fixed TS errors");
