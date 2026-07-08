import { exec } from 'child_process';
import puppeteer from 'puppeteer-core';
import axios from 'axios';
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

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    const chromePath = getChromePath();
    if (!chromePath) throw new Error('Chrome not found');

    const res = await sql('SELECT cookie FROM canva_accounts WHERE id = 1');
    if (res.rows.length === 0) throw new Error('Node 1 not found in DB');

    const userDir = 'E:\\codingan\\botcanvainvite\\chrome-dev-profile';
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    console.log('?? Launching Chrome natively on your desktop...');
    // Launch Chrome natively with debugging port enabled using Windows start command
    const cmd = `start "" "${chromePath}" --remote-debugging-port=9222 --user-data-dir="${userDir}" "about:blank"`;
    exec(cmd);

    console.log('? Waiting for Chrome to initialize...');
    await delay(5000);

    console.log('?? Connecting Puppeteer to the open Chrome instance...');
    try {
        const versionRes = await axios.get('http://127.0.0.1:9222/json/version');
        const wsEndpoint = versionRes.data.webSocketDebuggerUrl;
        console.log(`?? WebSocket Endpoint: ${wsEndpoint}`);

        const browser = await puppeteer.connect({
            browserWSEndpoint: wsEndpoint,
            defaultViewport: null
        });

        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();

        console.log('?? Opening Canva domain for context...');
        await page.goto('https://www.canva.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        const cookies = parseCanvaCookies(res.rows[0].cookie as string);
        console.log(`?? Injecting ${cookies.length} cookies...`);
        await page.setCookie(...cookies);

        console.log('?? Navigating to Canva Settings with active session...');
        await page.goto('https://www.canva.com/settings', { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('? Chrome successfully opened and logged in!');
        await browser.disconnect();
    } catch (err: any) {
        console.error('? Connection failed:', err.message);
    }
}

main().catch(console.error);
