const fs = require('fs');

let content = fs.readFileSync('src/bot.ts', 'utf8');

// 1. Remove old triggerGithubAction block using regex
content = content.replace(/\/\/ Helper: Trigger GitHub Action[\s\S]*?async function triggerGithubAction.*?catch\s*\(e:\s*any\)\s*\{[\s\S]*?return\s*\{\s*success:\s*false.*?\}\s*;\s*\}\s*\}/, '');

// 2. Fix ArrayBuffer errors using regex
content = content.replace(/const\s+buffer\s*=\s*Buffer\.from\(response\.data\);\s*const\s+content\s*=\s*buffer\.toString\('utf-8'\)\.trim\(\);/g, 'const content = new TextDecoder("utf-8").decode(response).trim();');

content = content.replace(/const\s+buffer\s*=\s*Buffer\.from\(response\.data\);\s*const\s+content\s*=\s*buffer\.toString\('utf-8'\);/g, 'const content = new TextDecoder("utf-8").decode(response);');

fs.writeFileSync('src/bot.ts', content);

let indexContent = fs.readFileSync('src/index.ts', 'utf8');
indexContent = indexContent.replace(/return handleUpdate\(request\);/g, 'return (handleUpdate as any)(request);');
fs.writeFileSync('src/index.ts', indexContent);

console.log("Fixed with Regex");
