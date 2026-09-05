const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) {
  if (c) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + n); }
  else { fail++; fails.push(n); console.log("  \x1b[31mFAIL\x1b[0m " + n + (x ? "  → " + x : "")); }
}
const group = t => console.log("\n\x1b[1m" + t + "\x1b[0m");

group("Viewport and page");
ok("viewport meta is set for device width", /name="viewport"[^>]*width=device-width/.test(html));
ok("notch and home-indicator areas respected", /viewport-fit=cover/.test(html) && /env\(safe-area-inset-bottom/.test(css));
ok("pinch zoom is not disabled", !/user-scalable=no/.test(html) && !/maximum-scale=1[,"]/.test(html));
ok("pull-to-refresh cannot fire mid-hold", /overscroll-behavior:\s*none/.test(css));
ok("double-tap zoom delay removed", /touch-action:\s*manipulation/.test(css));
ok("the hold button owns its gestures", /\.ptt\{[\s\S]*?touch-action:\s*none/.test(css));
ok("text is not auto-inflated on mobile Safari", /text-size-adjust:\s*100%/.test(css));

group("No fixed widths that can overflow a small phone");
{
  const decls = css.match(/[^-]width:\s*[0-9.]+px/g) || [];
  const wide = decls.filter(d => parseFloat(d.match(/[0-9.]+/)[0]) > 300);
  ok("nothing is pinned wider than a 320px screen", wide.length === 0, wide.join(", "));
  ok("the app scales rather than fixing a width", /\.app\{width:100%;max-width:430px/.test(css));
  const flexKids = ["\\.grille\\{[^}]*flex:1 1 auto;min-width:0", "\\.lcd\\{[^}]*flex:1 1 auto;min-width:0", "\\.nm\\{[^}]*flex:1;min-width:0"];
  ok("flexible children can shrink instead of pushing the page wide",
     flexKids.every(r => new RegExp(r).test(css)), flexKids.filter(r => !new RegExp(r).test(css)).join(" | "));
  ok("long take names truncate instead of overflowing", /\.nm\{[\s\S]*?text-overflow:ellipsis/.test(css));
  ok("screen labels truncate too", /\.lrow span\{[\s\S]*?text-overflow:ellipsis/.test(css));
}

group("Type and controls scale with the screen");
{
  const clamps = (css.match(/clamp\(/g) || []).length;
  ok("fluid sizing is used throughout (" + clamps + " clamps)", clamps >= 15);
  ok("the clock scales with viewport width", /\.clock\{font-size:clamp\(/.test(css));
  ok("the hold button scales its padding", /\.ptt\{[\s\S]*?padding:clamp\(/.test(css));
  ok("device padding scales", /--pad:clamp\(/.test(css));
}

group("Touch target sizes");
{
  const target = (sel, min) => {
    const m = css.match(new RegExp(sel.replace(/[.]/g, "\\.") + "\\{[^}]*min-height:(\\d+)px"));
    return m && parseInt(m[1], 10) >= min;
  };
  ok("save and scrap keys are at least 46px", target(".key", 46));
  ok("take actions are at least 40px", target(".acts button", 40));
  ok("library tabs are at least 34px", target(".tab", 34));
  ok("recovery buttons are at least 36px", target(".note button", 36));
  ok("the seek bar is thick enough to grab", /\.seek\{height:8px/.test(css));
  ok("take actions reflow into a grid rather than a cramped row", /\.acts\{display:grid;grid-template-columns:repeat\(auto-fit/.test(css));
}

group("Orientation and large screens");
ok("landscape phones get a two-column layout", /@media \(orientation:landscape\) and \(max-height:560px\)/.test(css));
ok("landscape shrinks the hold button so it still fits", /@media \(orientation:landscape\)[\s\S]*?\.ptt\{padding:18px/.test(css));
ok("tablets and desktops use the width", /@media \(min-width:860px\)[\s\S]*?grid-template-columns:1fr 1fr/.test(css));

group("Accessibility");
ok("keyboard focus on the hold button is visible", /\.ptt:focus-visible\{outline/.test(css));
ok("the hi-fi switch shows focus", /\.sw input:focus-visible \+ i\{outline/.test(css));
ok("reduced motion is respected", /prefers-reduced-motion:reduce/.test(css));
ok("the hold button is labelled for screen readers", /id="ptt" aria-label=/.test(html));
ok("the rename field is labelled", /setAttribute\("aria-label","Take name"\)/.test(html));
ok("decorative meter is hidden from screen readers", /<svg viewBox="0 0 100 62" aria-hidden="true"/.test(html));
ok("text selection is off on chrome but on in inputs", /input\{-webkit-user-select:text/.test(css));

group("Copy");
ok("no ALL-CAPS shouting in the empty state", /No takes yet/.test(html));
ok("the empty trash reads plainly", /Nothing in the trash\./.test(html));
ok("errors say what to do next", /Allow the mic for this page and hold again/.test(html));


group("Thumb reach and press hardening");
ok("the hold button stays reachable without scrolling on phones", /@media \(max-width:859px\)\{[\s\S]*?\.ptt\{[\s\S]*?position:sticky/.test(css));
ok("it sticks near the bottom, in thumb range", /position:sticky;[\s\S]*?bottom:calc\(10px \+ env\(safe-area-inset-bottom/.test(css));
ok("no long-press callout on any control", /-webkit-touch-callout:none/.test(css) && (css.match(/-webkit-touch-callout:none/g)||[]).length >= 2);
ok("selection is blocked on the hold button and the other controls", /\.ptt,\.key,\.tab,\.mini,\.acts button,\.sw,\.seek\{[\s\S]*?user-select:none/.test(css));
ok("the selection highlight itself is transparent", /\.ptt::selection/.test(css));
ok("selectstart is blocked at the JS level too", /addEventListener\("selectstart"/.test(html));
ok("drag ghosting is blocked", /addEventListener\("dragstart"/.test(html));

group("Orientation change");
ok("rotating releases a held burst instead of leaving it stuck", /addEventListener\("orientationchange", function\(\)\{ release\(\); \}\)/.test(html));
ok("the modern orientation API is also covered", /screen\.orientation\.addEventListener\("change"/.test(html));
console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
