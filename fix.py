import re

with open("src/bot.ts", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("Buffer.from(response.data)", "new TextDecoder('utf-8').decode(response)")
content = content.replace(".toString('utf-8')", "")
# Just to be safe, if there's any remaining:
content = content.replace("const content = new TextDecoder('utf-8').decode(response).trim().trim();", "const content = new TextDecoder('utf-8').decode(response).trim();")

with open("src/bot.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("Python fix done again!")
