export function parseCanvaCookies(cookieStr: string) {
    try {
        const parsed = JSON.parse(cookieStr);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list.map(c => {
            const mapped: any = { ...c };
            if (c.expirationDate && !c.expires) {
                mapped.expires = c.expirationDate;
            }
            // Remove properties that Puppeteer might reject
            delete mapped.hostOnly;
            delete mapped.session;
            return mapped;
        });
    } catch {
        return cookieStr.split(';').map(part => {
            const [name, ...rest] = part.trim().split('=');
            if (!name) return null;
            return { name, value: rest.join('='), domain: '.canva.com', path: '/', secure: true };
        }).filter(Boolean);
    }
}
