// Turso HTTP API client — no library, pure fetch
// Works 100% in Cloudflare Workers

let _dbUrl: string | null = null;
let _dbToken: string | null = null;

function getConfig() {
    if (_dbUrl) return { url: _dbUrl!, token: _dbToken! };
    const env = (globalThis as any).ENV || process.env;
    if (!env?.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL tidak ditemukan di ENV");
    // Turso HTTP API requires https://, not libsql://
    _dbUrl = (env.TURSO_DATABASE_URL as string).replace("libsql://", "https://");
    _dbToken = env.TURSO_AUTH_TOKEN as string;
    return { url: _dbUrl!, token: _dbToken! };
}

export async function sql(query: string, args: any[] = []): Promise<any> {
    const { url, token } = getConfig();

    // Convert positional args to Turso's named format
    const stmts = [{
        q: query,
        params: args.map((v) => {
            if (v === null || v === undefined) return { type: "null" };
            if (typeof v === "number") return { type: "integer", value: String(v) };
            return { type: "text", value: String(v) };
        }),
    }];

    const res = await fetch(`${url}/v2/pipeline`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            requests: [
                { type: "execute", stmt: { sql: query, args: args.map((v) => {
                    if (v === null || v === undefined) return { type: "null" };
                    if (typeof v === "number") return { type: "integer", value: String(v) };
                    return { type: "text", value: String(v) };
                }) } },
                { type: "close" },
            ],
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Turso HTTP error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const result = data.results?.[0];

    if (result?.type === "error") {
        throw new Error(`Turso query error: ${result.error?.message}`);
    }

    const cols = result?.response?.result?.cols ?? [];
    const rows_raw = result?.response?.result?.rows ?? [];

    // Convert to array-of-objects like libsql returns
    const rows = rows_raw.map((row: any[]) => {
        const obj: any = {};
        cols.forEach((col: any, i: number) => {
            const cell = row[i];
            if (!cell || cell.type === "null") {
                obj[col.name] = null;
            } else if (cell.type === "integer" || cell.type === "float") {
                const num = Number(cell.value);
                obj[col.name] = Number.isSafeInteger(num) ? num : cell.value;
            } else if (cell.type === "text") {
                obj[col.name] = cell.value;
            } else {
                obj[col.name] = cell.value ?? cell;
            }
        });
        return obj;
    });

    return { rows, columns: cols.map((c: any) => c.name) };
}

// Proxy for direct db.execute() calls in bot.ts
export const db = {
    execute: (opts: { sql: string; args?: any[] }) => sql(opts.sql, opts.args ?? []),
} as any;
