/// <reference lib="dom" />
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import * as dotenv from 'dotenv';
import { sql } from '../lib/db';
import { parseCanvaCookies } from './canva_cookie';

dotenv.config();

const findChromeParams = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
];

function getChromePath() {
    for (const path of findChromeParams) {
        if (fs.existsSync(path)) return path;
    }
    return null;
}

async function main() {
    const nodeId = Number(process.argv[2] || 1);
    const res = await sql('SELECT id, cookie, email, team_id FROM canva_accounts WHERE id = ?', [nodeId]);
    if (res.rows.length === 0) throw new Error(`Node ${nodeId} not found`);

    const chromePath = getChromePath();
    if (!chromePath) throw new Error('Chrome not found');

    const browser = await puppeteer.launch({ executablePath: chromePath, headless: false, defaultViewport: null });
    const page = await browser.newPage();

    const cookies = parseCanvaCookies(res.rows[0].cookie as string);
    await page.setCookie(...cookies);
    await page.goto('https://www.canva.com/settings', { waitUntil: 'networkidle2', timeout: 45000 });

    console.log('URL:', page.url());
    console.log('Title:', await page.title());
    console.log('Cookies:', (await page.cookies()).map(c => c.name).join(','));

    if (page.url().includes('login') || page.url().includes('signup')) {
        console.log('RESULT: LOGIN_FAILED');
    } else {
        console.log('RESULT: LOGIN_OK');
    }

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
