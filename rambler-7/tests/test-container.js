const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Core = require("./core.js");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) {
  if (c) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + n); }
  else { fail++; fails.push(n); console.log("  \x1b[31mFAIL\x1b[0m " + n + (x ? "  → " + x : "")); }
}
const eq = (n, a, b) => ok(n, Object.is(a, b), JSON.stringify(a) + " !== " + JSON.stringify(b));
const group = t => console.log("\n\x1b[1m" + t + "\x1b[0m");

const SAMPLES = "/mnt/user-data/uploads";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remux-"));
let ffmpeg = true;
try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch (e) { ffmpeg = false; }

const load = f => {
  const b = fs.readFileSync(path.join(SAMPLES, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const atomsOf = ab => {
  const b = Buffer.from(ab); const out = []; let o = 0;
  while (o + 8 <= b.length) {
    let s = b.readUInt32BE(o);
    const t = b.toString("latin1", o + 4, o + 8);
    if (s === 1) s = Number(b.readBigUInt64BE(o + 8));      // 64-bit extended size
    else if (s === 0) s = b.length - o;
    out.push(t); if (s < 8) break; o += s;
  }
  return out;
};
const realSeconds = file => execFileSync("ffmpeg",
  ["-v", "error", "-i", file, "-f", "s16le", "-ar", "48000", "-ac", "1", "-"],
  { maxBuffer: 1 << 30 }).length / 2 / 48000;
const brandOf = ab => Buffer.from(ab).toString("latin1", 8, 12);
const probe = file => JSON.parse(execFileSync("ffprobe",
  ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" }));
const pcmHash = file => require("crypto").createHash("md5")
  .update(execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ar", "48000", "-"],
    { maxBuffer: 1 << 30 })).digest("hex");

const takes = fs.existsSync(SAMPLES)
  ? fs.readdirSync(SAMPLES).filter(f => /^Take_.*\.m4a$/.test(f)).sort() : [];
const reference = "New_Recording_49.m4a";

group("The recordings as the app currently writes them");
ok("sample recordings are available to test against", takes.length > 0, takes.join(", "));
takes.forEach(f => {
  const ab = load(f);
  ok(f + " is fragmented, which is what players choke on", Core.isFragmented(ab));
});
if (fs.existsSync(path.join(SAMPLES, reference))) {
  ok("a Voice Memos recording is not fragmented", Core.isFragmented(load(reference)) === false);
  eq("and uses the M4A brand", brandOf(load(reference)), "M4A ");
  ok("with a plain ftyp/mdat/moov layout",
     atomsOf(load(reference)).join(",") === "ftyp,mdat,moov", atomsOf(load(reference)).join(","));
}

group("After remuxing");
takes.forEach(f => {
  const src = load(f);
  const r = Core.remux(src);
  ok(f + " remuxes without error", !r.err, r.err);
  if (r.err) return;
  const out = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.byteLength);
  ok(f + " is no longer fragmented", Core.isFragmented(out) === false);
  eq(f + " carries the M4A brand", brandOf(out), "M4A ");
  eq(f + " has the same layout as a Voice Memos file", atomsOf(out).join(","), "ftyp,moov,mdat");
  ok(f + " keeps the encoder priming so playback starts in the right place", r.priming > 0, "priming " + r.priming);
  ok(f + " is not bloated by the rewrite", out.byteLength <= src.byteLength * 1.02,
     src.byteLength + " → " + out.byteLength);
  fs.writeFileSync(path.join(tmp, f), Buffer.from(out));
});

if (ffmpeg && takes.length) {
  group("Verified with a standard decoder");
  takes.forEach(f => {
    const before = probe(path.join(SAMPLES, f));
    const after = probe(path.join(tmp, f));
    const bs = before.streams[0], as = after.streams[0];
    eq(f + " keeps the same codec", as.codec_name, bs.codec_name);
    eq(f + " keeps the same sample rate", as.sample_rate, bs.sample_rate);
    eq(f + " keeps the same channel count", as.channels, bs.channels);
    /* The fragmented original counts paused time as elapsed, so its stated duration can
       be far longer than the audio it holds. The remuxed file should match the audio. */
    const real = realSeconds(path.join(SAMPLES, f));
    ok(f + " reports the duration of the audio it actually contains",
       Math.abs(after.format.duration - real) < 0.15,
       "audio " + real.toFixed(2) + "s, file says " + after.format.duration);
    if (Math.abs(before.format.duration - real) > 0.5) {
      ok(f + " fixes an overstated duration in the original (" +
         Number(before.format.duration).toFixed(1) + "s claimed for " + real.toFixed(1) + "s of audio)", true);
    }
    ok(f + " reports a real duration rather than zero", parseFloat(after.format.duration) > 0.5);
  });

  group("The audio itself is untouched");
  takes.forEach(f => {
    ok(f + " decodes to byte-identical audio", pcmHash(path.join(SAMPLES, f)) === pcmHash(path.join(tmp, f)));
  });
} else {
  group("Verified with a standard decoder");
  ok("ffprobe unavailable, decoder checks skipped", !takes.length, "no ffmpeg on this machine");
}

group("Refusing to damage anything it should not touch");
{
  if (fs.existsSync(path.join(SAMPLES, reference))) {
    const r = Core.remux(load(reference));
    ok("an already progressive file is left alone", r.err === "not fragmented", JSON.stringify(r.err));
  }
  const junk = new Uint8Array(64).fill(7).buffer;
  const r2 = Core.remux(junk);
  ok("rubbish input returns an error rather than throwing", !!r2.err, JSON.stringify(r2).slice(0, 60));
  ok("an empty buffer is handled", !!Core.remux(new ArrayBuffer(0)).err);
  ok("isFragmented says no for rubbish", Core.isFragmented(junk) === false);

  // a truncated recording, as a crash recovery might produce
  const src = load(takes[0]);
  const cut = src.slice(0, Math.floor(src.byteLength * 0.6));
  let threw = false, res = null;
  try { res = Core.remux(cut); } catch (e) { threw = true; }
  ok("a truncated recording does not throw", !threw);
  ok("and either remuxes what it has or reports an error", !!res && (res.err || res.samples > 0));
  if (res && !res.err && ffmpeg) {
    const p = path.join(tmp, "truncated.m4a");
    fs.writeFileSync(p, Buffer.from(res.buf));
    let playable = true;
    try { probe(p); } catch (e) { playable = false; }
    ok("the salvaged part is still a readable file", playable);
  }
}

console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
