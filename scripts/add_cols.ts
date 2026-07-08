import { sql } from '../lib/db';

async function run() {
    try {
        await sql("ALTER TABLE canva_accounts ADD COLUMN invite_code TEXT;");
        console.log("Added invite_code column");
    } catch (e: any) {
        console.log("invite_code error:", e.message);
    }
    
    try {
        await sql("ALTER TABLE canva_accounts ADD COLUMN invite_code_updated_at DATETIME;");
        console.log("Added invite_code_updated_at column");
    } catch (e: any) {
        console.log("invite_code_updated_at error:", e.message);
    }
}
run();
