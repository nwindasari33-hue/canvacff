const fs = require('fs');
let content = fs.readFileSync('src/bot.ts', 'utf8');

// 1. Remove the old triggerGithubAction which imports axios (line 651-681)
content = content.replace(/\/\/ Helper: Trigger GitHub Action\nasync function triggerGithubAction.*?catch \(e: any\) \{\n.*?return \{ success: false, message: `Gagal memicu GitHub Action: \$\{details\}` \};\n    \}\n\}/s, '// Old triggerGithubAction removed');

// 2. Fix ArrayBuffer to Buffer errors
content = content.replace(/const buffer = Buffer\.from\(response\.data\);\s*\n\s*const content = buffer\.toString\('utf-8'\)\.trim\(\);/g, 'const content = new TextDecoder("utf-8").decode(response).trim();');
content = content.replace(/const buffer = Buffer\.from\(response\.data\);\s*\n\s*const content = buffer\.toString\('utf-8'\);/g, 'const content = new TextDecoder("utf-8").decode(response);');

// 3. Fix Expected 0-1 arguments for triggerGithubAction in bot.ts
// Replace any `await triggerGithubAction()` with `await triggerGithubAction((globalThis as any).ENV)`
content = content.replace(/await triggerGithubAction\(\)/g, 'await triggerGithubAction((globalThis as any).ENV)');

fs.writeFileSync('src/bot.ts', content);
console.log("Fixed bot.ts again!");
