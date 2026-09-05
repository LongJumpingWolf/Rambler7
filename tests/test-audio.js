const fs = require("fs");
const vm = require("vm");
const path = require("path");
const Core = require("./core.js");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) {
  if (c) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + n); }
  else { fail++; fails.push(n); console.log("  \x1b[31mFAIL\x1b[0m " + n + (x ? "  → " + x : "")); }
}
const eq = (n, a, b) => ok(n, Object.is(a, b), JSON.stringify(a) + " !== " + JSON.stringify(b));
const group = t => console.log("\n\x1b[1m" + t + "\x1b[0m");

// load the encoder that actually ships with the app
const sandbox = { window: {}, self: {}, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "lame.js"), "utf8"), sandbox);
const lamejs = sandbox.lamejs || sandbox.window.lamejs;

const rmsOf = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const peakOf = a => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };
function tone(n, amp, freq = 220, rate = 48000) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin(2 * Math.PI * freq * i / rate) * amp;
  return f;
}
function speechish(n, amp) {          // bursts and gaps, closer to a real take
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = (Math.floor(i / 6000) % 3 === 2) ? 0 : Math.abs(Math.sin(i / 4000));
    f[i] = Math.sin(i / 9) * amp * env;
  }
  return f;
}

group("Quiet recordings are brought up to a usable level");
{
  const quiet = speechish(48000, 0.02);
  const g = Core.levelGain(quiet);
  ok("a very quiet take is boosted a lot (x" + g.toFixed(1) + ")", g > 4, "gain " + g);
  const after = Float32Array.from(quiet, v => Core.softClip(v * g));
  ok("its level lands in a normal range", rmsOf(after) > 0.04 && rmsOf(after) < 0.25, "rms " + rmsOf(after).toFixed(3));
  ok("and it does not clip", peakOf(after) <= 1.0, "peak " + peakOf(after).toFixed(3));
}
{
  const normal = speechish(48000, 0.3);
  const g = Core.levelGain(normal);
  const after = Float32Array.from(normal, v => Core.softClip(v * g));
  ok("an already healthy take is not blown out", peakOf(after) <= 1.0, "peak " + peakOf(after).toFixed(3));
  ok("nor crushed to nothing", rmsOf(after) > 0.02, "rms " + rmsOf(after).toFixed(3));
}
{
  const hot = tone(48000, 0.999);
  const g = Core.levelGain(hot);
  const after = Float32Array.from(hot, v => Core.softClip(v * g));
  ok("a take recorded too hot stays inside the rails", peakOf(after) <= 1.0, "peak " + peakOf(after).toFixed(4));
}
eq("silence is left alone", Core.levelGain(new Float32Array(1000)), 1);
eq("an empty buffer does not divide by zero", Core.levelGain(new Float32Array(0)), 1);

group("A single loud pop does not flatten the whole take");
{
  const s = speechish(48000, 0.05);
  s[20000] = 0.98;                    // a door slam
  const g = Core.levelGain(s);
  const after = Float32Array.from(s, v => Core.softClip(v * g));
  ok("speech is still lifted despite the peak", rmsOf(after) > rmsOf(s) * 2, "rms " + rmsOf(s).toFixed(4) + " → " + rmsOf(after).toFixed(4));
  ok("the lift is large enough to hear (x" + Core.levelGain(s).toFixed(1) + ")", Core.levelGain(s) > 3);
  ok("the pop itself is contained", peakOf(after) <= 1.0, "peak " + peakOf(after).toFixed(3));
}

group("Conversion to 16-bit");
{
  const s = tone(2000, 0.5);
  const i16 = Core.toInt16(s, 1);
  eq("sample count is preserved", i16.length, s.length);
  ok("output is 16-bit integers", i16 instanceof Int16Array);
  ok("nothing exceeds the 16-bit range", i16.every(v => v >= -32768 && v <= 32767));
  const loud = Core.toInt16(tone(2000, 1.0), 8);
  ok("an extreme gain still cannot overflow", loud.every(v => v >= -32768 && v <= 32767));
  eq("silence converts to silence", Core.toInt16(new Float32Array(100), 4).every(v => v === 0), true);
}

group("The exported file is a real MP3");
{
  const src = speechish(48000 * 3, 0.03);
  const gain = Core.levelGain(src);
  const enc = new lamejs.Mp3Encoder(1, 48000, 128);
  const parts = [];
  const BLOCK = 1152 * 64;
  const t0 = Date.now();
  for (let i = 0; i < src.length; i += BLOCK) {
    const c = enc.encodeBuffer(Core.toInt16(src.subarray(i, Math.min(i + BLOCK, src.length)), gain));
    if (c.length) parts.push(Buffer.from(c));
  }
  const last = enc.flush();
  if (last.length) parts.push(Buffer.from(last));
  const mp3 = Buffer.concat(parts);
  const ms = Date.now() - t0;

  ok("bytes were produced", mp3.length > 1000, mp3.length + " bytes");
  // an MP3 file starts with either an ID3 tag or a frame sync (11 set bits)
  const id3 = mp3.slice(0, 3).toString("latin1") === "ID3";
  let syncAt = -1;
  for (let i = 0; i < Math.min(mp3.length - 1, 4096); i++) {
    if (mp3[i] === 0xff && (mp3[i + 1] & 0xe0) === 0xe0) { syncAt = i; break; }
  }
  ok("it carries a valid MP3 frame header", id3 || syncAt >= 0, "id3=" + id3 + " sync@" + syncAt);
  const ver = (mp3[syncAt + 1] >> 3) & 3, layer = (mp3[syncAt + 1] >> 1) & 3;
  eq("MPEG version 1", ver, 3);
  eq("Layer III", layer, 1);
  eq("mono channel mode", (mp3[syncAt + 3] >> 6) & 3, 3);

  const kbps = (mp3.length * 8) / 3 / 1000;
  ok("bitrate is about 128 kbps (" + kbps.toFixed(0) + ")", kbps > 100 && kbps < 150);
  ok("3 s of audio encodes in " + ms + " ms, fast enough to export on demand", ms < 8000);
  ok("the file is a sane size for 3 s of speech (" + (mp3.length / 1024).toFixed(0) + " KB)",
     mp3.length > 20000 && mp3.length < 80000);
}

group("Format choice");
eq("a WebM recording exports as mp3", Core.fileName({ name: "Take 001", ext: "webm" }, "mp3"), "Take_001.mp3");
eq("without an override the stored extension is used", Core.fileName({ name: "Take 001", ext: "webm" }), "Take_001.webm");
eq("a Safari m4a recording keeps its own extension", Core.fileName({ name: "Chat", ext: "m4a" }), "Chat.m4a");

console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
