const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const exists = f => fs.existsSync(path.join(root, f.replace(/^\//, "")));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) {
  if (c) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + n); }
  else { fail++; fails.push(n); console.log("  \x1b[31mFAIL\x1b[0m " + n + (x ? "  → " + x : "")); }
}
const group = t => console.log("\n\x1b[1m" + t + "\x1b[0m");

const html = read("index.html");
const sw = read("sw.js");
const vercel = JSON.parse(read("vercel.json"));
const manifest = JSON.parse(read("manifest.webmanifest"));

function pngSize(f) {
  const b = fs.readFileSync(path.join(root, f.replace(/^\//, "")));
  return b.readUInt32BE(16) + "x" + b.readUInt32BE(20);
}

group("Project layout");
ok("index.html is at the root where Vercel serves it", exists("index.html"));
ok("no build step is required", !exists("package.json"));
ok("tests are excluded from the deployment", /tests\//.test(read(".vercelignore")));
ok("node_modules is not committed", /node_modules/.test(read(".gitignore")));
ok("robots.txt is present", exists("robots.txt"));

group("Every referenced file exists");
{
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map(m => m[1]);
  const missing = refs.filter(r => !exists(r));
  ok("all " + refs.length + " local references resolve", missing.length === 0, missing.join(", "));
  const shell = [...sw.matchAll(/"(\/[^"]*)"/g)].map(m => m[1]).filter(p => p !== "/");
  const swMissing = shell.filter(r => !exists(r));
  ok("everything the service worker precaches exists", swMissing.length === 0, swMissing.join(", "));
  ok("the app pulls nothing from a CDN, so it works offline",
     !/(src|href)="https?:\/\//.test(html.replace(/<meta[^>]*>/g, "")));
}

group("Manifest");
ok("scope and start_url agree", manifest.start_url === "/" && manifest.scope === "/");
ok("display is standalone so it opens without browser chrome", manifest.display === "standalone");
ok("theme colour matches the device shell", manifest.theme_color === "#2a2723");
ok("has a maskable icon for Android", manifest.icons.some(i => i.purpose === "maskable"));
manifest.icons.forEach(i => {
  ok("icon " + i.src + " exists and really is " + i.sizes, exists(i.src) && pngSize(i.src) === i.sizes,
     exists(i.src) ? "actual " + pngSize(i.src) : "missing");
});
ok("apple touch icon is 180x180", exists("/icons/apple-touch-icon.png") && pngSize("/icons/apple-touch-icon.png") === "180x180");
ok("index links the manifest", /rel="manifest" href="\/manifest\.webmanifest"/.test(html));
ok("index links the apple touch icon", /rel="apple-touch-icon"/.test(html));

group("Headers");
{
  const all = vercel.headers.flatMap(h => h.headers.map(x => [h.source, x.key, x.value]));
  const find = (src, key) => (all.find(a => a[0] === src && a[1] === key) || [])[2];
  const perms = find("/(.*)", "Permissions-Policy");
  ok("microphone is allowed for this origin", /microphone=\(self\)/.test(perms || ""), perms);
  ok("microphone is not accidentally disabled", !/microphone=\(\)/.test(perms || ""));
  ok("camera and geolocation are switched off", /camera=\(\)/.test(perms || "") && /geolocation=\(\)/.test(perms || ""));
  ok("HSTS is set", /max-age=\d+/.test(find("/(.*)", "Strict-Transport-Security") || ""));
  ok("MIME sniffing is off", find("/(.*)", "X-Content-Type-Options") === "nosniff");
  ok("the shell is revalidated so deploys land", /must-revalidate/.test(find("/", "Cache-Control") || ""));
  ok("the service worker is never cached stale", /must-revalidate/.test(find("/sw.js", "Cache-Control") || ""));
  ok("icons are cached hard", /immutable/.test(find("/icons/(.*)", "Cache-Control") || ""));
  ok("the manifest is served with the right content type",
     find("/manifest.webmanifest", "Content-Type") === "application/manifest+json");
}

group("Service worker");
ok("cache name is versioned", /const VERSION = "v\d+"/.test(sw));
ok("old caches are cleaned up on activate", /caches\.delete/.test(sw));
ok("only GET requests are handled", /req\.method !== "GET"/.test(sw));
ok("cross-origin requests are left alone", /url\.origin !== self\.location\.origin/.test(sw));
ok("navigations try the network first so updates are picked up", /req\.mode === "navigate"[\s\S]{0,200}fetch\(req\)/.test(sw));
ok("navigations fall back to cache when offline", /catch\(\(\) => caches\.match\("\/index\.html"\)/.test(sw));
ok("registration is guarded to secure origins", /location\.protocol!=="https:"/.test(html));
ok("a failed registration cannot break the app", /register\("\/sw\.js"\)[\s\S]{0,200}catch/.test(html));

group("Storage");
ok("recordings use IndexedDB, not browser storage that a deploy could clear",
   /indexedDB/.test(html) && !/localStorage|sessionStorage/.test(html));
ok("the service worker never caches recordings", !/takes|rambler7"/.test(sw.replace(/rambler7-/g, "")));


group("MP3 encoder");
ok("the encoder ships with the site", exists("lame.js"));
ok("it is precached for offline export", /"\/lame\.js"/.test(sw));
ok("it is cached hard, it never changes", /immutable/.test((vercel.headers.find(h=>h.source==="/lame.js")||{headers:[]}).headers.map(x=>x.value).join(" ")));
ok("it is loaded on demand, not on every page load", !/<script src="lame\.js"/.test(html) && /sc\.src="lame\.js"/.test(html));
ok("the service worker version was bumped for the new shell", /VERSION = "v4"/.test(sw));
console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
