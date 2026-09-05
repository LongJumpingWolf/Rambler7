const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const m = html.match(/\/\* CORE:START[\s\S]*?\*\/([\s\S]*?)\/\* CORE:END \*\//);
if (!m) { console.error("core block not found"); process.exit(1); }
fs.writeFileSync(__dirname + "/core.js", m[1] + "\nmodule.exports = Core;\n");
console.log("extracted core.js:", m[1].length, "chars");
