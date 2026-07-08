import { createClient } from "@libsql/client/web";

let _dbClient: any = null;

const getDb = () => {
    if (_dbClient) return _dbClient;

    const env = (globalThis as any).ENV;
    if (!env || !env.TURSO_DATABASE_URL) {
        throw new Error("TURSO_DATABASE_URL tidak ditemukan di environment variables (Global ENV belum di-set)");
    }

    _dbClient = createClient({
        url: env.TURSO_DATABASE_URL,
        authToken: env.TURSO_AUTH_TOKEN,
    });
    return _dbClient;
};

// Export db proxy in case it's used directly
export const db = new Proxy({}, {
    get: (target, prop) => {
        return getDb()[prop];
    }
}) as any;

// Fungsi bantuan untuk menjalankan query SQL standar
export const sql = async (query: string, args: any[] = []) => {
    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        attempts++;
        try {
            const result = await getDb().execute({ sql: query, args });
            return result;
        } catch (error: any) {
            // Only retry on network/fetch errors
            if (attempts < maxRetries && (
                error.message?.includes("fetch failed") ||
                error.message?.includes("ConnectTimeoutError") ||
                error.code === "UND_ERR_CONNECT_TIMEOUT"
            )) {
                console.warn(`⚠️ DB Retry ${attempts}/${maxRetries} due to network error...`);
                await new Promise(r => setTimeout(r, 1500)); // Wait 1.5s
                continue;
            }

            console.error("Database Error:", error);
            throw error;
        }
    }
    throw new Error("DB Connection Failed after retries");
};
