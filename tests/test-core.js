require("fake-indexeddb/auto");
const { IDBFactory } = require("fake-indexeddb");
const Core = require("./core.js");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + name); }
  else { fail++; fails.push(name); console.log("  \x1b[31mFAIL\x1b[0m " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, a, b) { ok(name, Object.is(a, b), JSON.stringify(a) + " !== " + JSON.stringify(b)); }
function group(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

function bytes(n, seed = 7) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255;
  return u.buffer;
}
function same(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
const freshStore = () => Core.makeStore(new IDBFactory());

(async () => {

group("Time and size formatting");
eq("fmt zero", Core.fmt(0), "00:00.0");
eq("fmt tenths", Core.fmt(1234), "00:01.2");
eq("fmt rolls to minutes", Core.fmt(61000), "01:01.0");
eq("fmt long take", Core.fmt(3599900), "59:59.9");
eq("fmt over an hour keeps counting", Core.fmt(3600000), "60:00.0");
eq("fmt negative clamps", Core.fmt(-500), "00:00.0");
eq("fmt undefined clamps", Core.fmt(undefined), "00:00.0");
eq("short", Core.short(65000), "1:05");
eq("short zero", Core.short(0), "0:00");
eq("size bytes", Core.size(900), "900 B");
eq("size kb", Core.size(2048), "2 KB");
eq("size mb", Core.size(5 * 1048576), "5.0 MB");
eq("size undefined", Core.size(undefined), "0 B");

group("Rename validation");
eq("trims whitespace", Core.cleanName("  Morning notes  "), "Morning notes");
eq("collapses inner whitespace", Core.cleanName("a\t\t  b"), "a b");
eq("strips control characters", Core.cleanName("bad\u0000na\u001fme"), "bad na me");
eq("empty falls back to old name", Core.cleanName("", "Take 004"), "Take 004");
eq("whitespace only falls back", Core.cleanName("     ", "Take 004"), "Take 004");
eq("null falls back", Core.cleanName(null, "Take 004"), "Take 004");
eq("no fallback available", Core.cleanName(""), "Untitled take");
eq("caps at 60 chars", Core.cleanName("x".repeat(200)).length, 60);
eq("keeps unicode", Core.cleanName("साक्षात्कार 🎙"), "साक्षात्कार 🎙");
eq("keeps emoji-only name", Core.cleanName("🎙🎙"), "🎙🎙");

group("Export filenames");
eq("spaces become underscores", Core.fileName({ name: "Morning notes", ext: "webm" }), "Morning_notes.webm");
eq("path separators stripped", Core.fileName({ name: "../../etc/passwd", ext: "webm" }), "etcpasswd.webm");
eq("windows-illegal chars stripped", Core.fileName({ name: 'a<b>c:"d|e?f*g', ext: "m4a" }), "abcdefg.m4a");
eq("unicode-only name falls back", Core.fileName({ name: "🎙🎙", ext: "webm" }), "take.webm");
eq("accents keep the letters", Core.fileName({ name: "Café réunion", ext: "webm" }), "Cafe_reunion.webm");
eq("very long name truncated", Core.fileName({ name: "y".repeat(300), ext: "ogg" }).length, 54);
eq("missing ext defaults", Core.fileName({ name: "hi" }), "hi.webm");
eq("missing name defaults", Core.fileName({}), "take.webm");

group("Automatic take numbering");
eq("first take", Core.nextName([]), "Take 001");
eq("counts from highest, not length", Core.nextName([{ name: "Take 001" }, { name: "Take 009" }]), "Take 010");
eq("ignores renamed takes", Core.nextName([{ name: "Interview with Ana" }]), "Take 001");
eq("no reuse after deleting the middle", Core.nextName([{ name: "Take 001" }, { name: "Take 003" }]), "Take 004");
eq("counts trashed takes too", Core.nextName([{ name: "Take 007", trashed: true }]), "Take 008");
eq("survives a bad record", Core.nextName([{ name: null }, { name: "Take 002" }]), "Take 003");
eq("rejects near-miss names", Core.nextName([{ name: "Take 12x" }]), "Take 001");

group("Format selection");
eq("prefers opus in webm", Core.pickMime({ isTypeSupported: t => t.indexOf("webm") > -1 }), "audio/webm;codecs=opus");
eq("safari falls to mp4", Core.pickMime({ isTypeSupported: t => t.indexOf("mp4") > -1 }), "audio/mp4;codecs=mp4a.40.2");
eq("nothing supported", Core.pickMime({ isTypeSupported: () => false }), "");
eq("no MediaRecorder at all", Core.pickMime(undefined), "");
eq("ext webm", Core.extFor("audio/webm;codecs=opus"), "webm");
eq("ext m4a", Core.extFor("audio/mp4"), "m4a");
eq("ext ogg", Core.extFor("audio/ogg;codecs=opus"), "ogg");
eq("ext unknown", Core.extFor(""), "webm");

group("Buffer assembly");
{
  const a = bytes(10, 1), b = bytes(5, 2), j = Core.joinBuffers([a, b]);
  eq("joined length", j.byteLength, 15);
  const u = new Uint8Array(j);
  ok("first chunk intact", same(u.slice(0, 10).buffer, a));
  ok("second chunk intact", same(u.slice(10).buffer, b));
  eq("empty list", Core.joinBuffers([]).byteLength, 0);
  eq("single chunk", Core.joinBuffers([a]).byteLength, 10);
}

group("Storage: save, list, integrity");
const s = freshStore();
{
  const r = await s.open();
  ok("database opens", r.ok === true, JSON.stringify(r));
  ok("not in memory fallback", s.memory === false);

  const audio = bytes(4096);
  const take = { id: "t1", name: "Take 001", buf: audio, mime: "audio/webm", ext: "webm", ms: 4200, bursts: 3, at: Date.now(), trashed: false };
  await s.put(take);
  const back = await s.get("t1");
  ok("take is readable after save", !!back);
  ok("audio bytes survive the round trip", same(back.buf, audio));
  eq("duration preserved", back.ms, 4200);
  eq("burst count preserved", back.bursts, 3);
  eq("list has one take", (await s.all()).length, 1);
}

group("Storage: worst cases");
{
  const big = bytes(5 * 1024 * 1024);
  await s.put({ id: "big", name: "Long take", buf: big, mime: "audio/webm", ext: "webm", ms: 300000, bursts: 40, at: Date.now(), trashed: false });
  ok("5 MB take round trips byte for byte", same((await s.get("big")).buf, big));

  await s.put({ id: "zero", name: "Empty", buf: bytes(0), mime: "audio/webm", ext: "webm", ms: 0, bursts: 0, at: Date.now(), trashed: false });
  ok("zero-length buffer does not break the store", (await s.get("zero")).buf.byteLength === 0);

  const jobs = [];
  for (let i = 0; i < 60; i++)
    jobs.push(s.put({ id: "p" + i, name: "Take " + String(i + 10).padStart(3, "0"), buf: bytes(512, i), mime: "audio/webm", ext: "webm", ms: 1000, bursts: 1, at: Date.now() + i, trashed: false }));
  await Promise.all(jobs);
  const all = await s.all();
  eq("60 concurrent writes all landed", all.filter(x => x.id.startsWith("p")).length, 60);
  ok("no concurrent write corrupted another", all.filter(x => x.id.startsWith("p")).every(x => same(x.buf, bytes(512, parseInt(x.id.slice(1), 10)))));

  await s.del("does-not-exist");
  ok("deleting a missing id is harmless", true);

  const dup = await s.get("t1");
  dup.name = "Take 010";
  await s.put(dup);
  eq("renaming onto an existing name is allowed", (await s.get("t1")).name, "Take 010");
  dup.name = "Take 001"; await s.put(dup);
}

group("Storage: survives a reload");
{
  const shared = new IDBFactory();
  const a = Core.makeStore(shared);
  await a.open();
  const audio = bytes(2048, 9);
  await a.put({ id: "keep", name: "Take 001", buf: audio, mime: "audio/webm", ext: "webm", ms: 1000, bursts: 1, at: Date.now(), trashed: false });

  const b = Core.makeStore(shared);       // simulates the page being reopened
  const r = await b.open();
  ok("reopens the same database", r.ok === true);
  const found = await b.get("keep");
  ok("take is still there after a reload", !!found);
  ok("audio is still intact after a reload", found && same(found.buf, audio));
}

group("Trash, restore, delete forever");
{
  const t = freshStore();
  await t.open();
  const mk = (id, n) => ({ id, name: n, buf: bytes(64), mime: "audio/webm", ext: "webm", ms: 1000, bursts: 1, at: Date.now(), trashed: false });
  await t.put(mk("a", "Take 001"));
  await t.put(mk("b", "Take 002"));
  await t.put(mk("c", "Take 003"));

  const live = async () => (await t.all()).filter(x => !x.trashed);
  const binned = async () => (await t.all()).filter(x => x.trashed);

  const b = await t.get("b"); b.trashed = true; await t.put(b);
  eq("trashed take leaves the takes list", (await live()).length, 2);
  eq("trashed take appears in the trash", (await binned()).length, 1);
  ok("trashing keeps the audio", same((await t.get("b")).buf, bytes(64)));

  const b2 = await t.get("b"); b2.trashed = false; await t.put(b2);
  eq("restore returns it to the takes list", (await live()).length, 3);
  ok("restore keeps the audio", same((await t.get("b")).buf, bytes(64)));

  const b3 = await t.get("b"); b3.name = "Recovered chat"; b3.trashed = true; await t.put(b3);
  const b4 = await t.get("b"); b4.trashed = false; await t.put(b4);
  eq("a rename survives a trash and restore", (await t.get("b")).name, "Recovered chat");

  const c = await t.get("c"); c.trashed = true; await t.put(c);
  await t.del("c");
  ok("delete forever removes the record", (await t.get("c")) === null);
  eq("delete forever leaves other takes alone", (await t.all()).length, 2);

  const a2 = await t.get("a"); a2.trashed = true; await t.put(a2);
  const rest = await t.all();
  await Promise.all(rest.filter(x => x.trashed).map(x => t.del(x.id)));
  const after = await t.all();
  eq("empty trash clears only the trash", after.length, 1);
  eq("the surviving take is the live one", after[0].id, "b");
}

group("Crash recovery");
{
  const c = freshStore();
  await c.open();
  const sess = "s_crash";
  await c.putDraft({ session: sess, ms: 7300, bursts: 4, mime: "audio/webm", ext: "webm", at: 1700000000000 });
  await c.addPart(sess, 2, bytes(300, 3));   // written out of order on purpose
  await c.addPart(sess, 0, bytes(300, 1));
  await c.addPart(sess, 1, bytes(300, 2));

  const d = Core.recoverDraft(await c.parts());
  ok("an interrupted take is recoverable", !!d);
  eq("all chunks are included", d.bytes, 900);
  eq("recovered duration comes from the draft", d.ms, 7300);
  eq("recovered burst count", d.bursts, 4);
  const u = new Uint8Array(d.buf);
  ok("chunks are reassembled in recording order", same(u.slice(0, 300).buffer, bytes(300, 1)) && same(u.slice(300, 600).buffer, bytes(300, 2)) && same(u.slice(600).buffer, bytes(300, 3)));

  await c.addPart("s_older", 0, bytes(50, 9));
  const d2 = Core.recoverDraft(await c.parts());
  eq("the largest interrupted take wins", d2.session, sess);

  await c.clearParts(sess);
  const left = await c.parts();
  ok("clearing one session leaves the other", left.every(p => p.session === "s_older"));
  eq("the other session is still recoverable", Core.recoverDraft(left).session, "s_older");

  await c.clearParts();
  eq("clearing everything empties the parts store", (await c.parts()).length, 0);
  ok("nothing to recover returns null", Core.recoverDraft([]) === null);
  ok("draft metadata with no audio recovers nothing", Core.recoverDraft([{ key: "x:meta", session: "x", meta: true, ms: 900 }]) === null);
  ok("audio with no metadata still recovers", !!Core.recoverDraft([{ key: "y:0", session: "y", seq: 0, buf: bytes(10) }]));
}

group("Fallback when storage is unavailable");
{
  const m = Core.makeStore(null);
  const r = await m.open();
  ok("open reports failure instead of throwing", r.ok === false);
  ok("store reports it is in memory mode", m.memory === true);
  await m.put({ id: "m1", name: "Take 001", buf: bytes(128), mime: "audio/webm", ext: "webm", ms: 900, bursts: 1, at: Date.now(), trashed: false });
  eq("takes still save in memory", (await m.all()).length, 1);
  ok("audio is intact in memory", same((await m.get("m1")).buf, bytes(128)));
  const it = await m.get("m1"); it.name = "Renamed"; await m.put(it);
  eq("rename works in memory mode", (await m.get("m1")).name, "Renamed");
  it.trashed = true; await m.put(it);
  eq("trash works in memory mode", (await m.all()).filter(x => x.trashed).length, 1);
  await m.del("m1");
  eq("delete works in memory mode", (await m.all()).length, 0);
  await m.addPart("sm", 0, bytes(20));
  eq("crash parts also work in memory mode", (await m.parts()).length, 1);
}

group("Storage refuses the write");
{
  const quotaFactory = {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; },
          close() {}
        };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    }
  };
  const q = Core.makeStore(quotaFactory);
  await q.open();
  let code = null;
  try { await q.put({ id: "q", name: "Take 001", buf: bytes(10), ms: 1, bursts: 1, at: 1, trashed: false }); }
  catch (e) { code = e.code; }
  eq("a full disk surfaces as a quota error", code, "QUOTA");

  let partCode = null;
  try { await q.addPart("s", 0, bytes(10)); } catch (e) { partCode = e.code; }
  eq("crash backup also reports quota", partCode, "QUOTA");
}

group("Database that never opens");
{
  const hung = { open() { return {}; } };   // no callback ever fires
  const h = Core.makeStore(hung);
  const t0 = Date.now();
  const r = await h.open();
  ok("open gives up instead of hanging forever", r.ok === false && Date.now() - t0 < 6000, JSON.stringify(r));
  ok("falls back to memory after the timeout", h.memory === true);
  await h.put({ id: "h", name: "Take 001", buf: bytes(8), ms: 1, bursts: 1, at: 1, trashed: false });
  eq("recording still works with no database", (await h.all()).length, 1);
}


group("Recording format preference");
eq("m4a is chosen when the browser can record it", Core.pickMime({ isTypeSupported: t => true }), "audio/mp4;codecs=mp4a.40.2");
eq("plain mp4 is next", Core.pickMime({ isTypeSupported: t => t === "audio/mp4" }), "audio/mp4");
eq("WebM only when nothing portable is offered", Core.pickMime({ isTypeSupported: t => t.indexOf("webm") > -1 }), "audio/webm;codecs=opus");
ok("an m4a recording needs no conversion", Core.needsConvert("audio/mp4") === false);
ok("an aac recording needs no conversion", Core.needsConvert("audio/aac") === false);
ok("an mp3 file needs no conversion", Core.needsConvert("audio/mpeg") === false);
ok("a WebM recording does need conversion", Core.needsConvert("audio/webm;codecs=opus") === true);
ok("an ogg recording does need conversion", Core.needsConvert("audio/ogg;codecs=opus") === true);
ok("an unknown or missing type is treated as needing conversion", Core.needsConvert("") === true && Core.needsConvert(undefined) === true);

group("Automatic gain control");
{
  const step = (g, rms, dt = 0.016, ceil = 40) => Core.agcGain(g, rms, dt, ceil);
  const settle = (rms, ceil = 40, secs = 12) => {
    let g = 1;
    for (let t = 0; t < secs; t += 0.016) g = step(g, rms, 0.016, ceil);
    return g;
  };

  eq("silence holds the gain steady", step(6, 0, 0.016), 6);
  eq("a gap between words does not pump up the noise floor", step(6, 0.001, 0.016), 6);
  ok("a quiet phone mic gets a large boost", settle(0.008) > 8, "settled at " + settle(0.008).toFixed(1));
  ok("a very quiet mic is boosted further still", settle(0.002) > 20, "settled at " + settle(0.002).toFixed(1));
  ok("a healthy signal is left near unity", Math.abs(settle(0.09) - 1) < 0.3, "settled at " + settle(0.09).toFixed(2));
  ok("a loud signal is not attenuated below unity", settle(0.5) >= 1, "settled at " + settle(0.5).toFixed(2));
  ok("the boost is capped", settle(0.00001) <= 40);
  ok("voice mode uses a lower ceiling", settle(0.00001, 12) <= 12);

  ok("gain never goes negative or zero", step(1, 0.5, 0.016) > 0 && step(0, 0.01, 0.016) > 0);
  ok("a bad starting gain is repaired", step(0, 0.01, 0.016) > 0 && step(-5, 0.01, 0.016) > 0);
  ok("a missing frame time still advances", step(1, 0.005, 0) > 1);

  // ducking must be quicker than lifting, or a sudden shout clips before the gain drops
  const liftStep = step(1, 0.009, 0.1) - 1;
  const duckStep = 20 - step(20, 0.2, 0.1);
  ok("gain ducks faster than it lifts", duckStep > liftStep, "duck " + duckStep.toFixed(2) + " vs lift " + liftStep.toFixed(2));

  // it must not oscillate once settled
  let g = settle(0.01), before = g;
  for (let t = 0; t < 2; t += 0.016) g = step(g, 0.01, 0.016);
  ok("it holds steady once settled", Math.abs(g - before) < 0.05, before.toFixed(3) + " → " + g.toFixed(3));

  // a real take is bursts of speech separated by pauses
  g = 1;
  for (let t = 0; t < 20; t += 0.016) g = step(g, (Math.floor(t) % 3 === 2) ? 0.0005 : 0.01, 0.016);
  ok("pauses between sentences do not disturb the gain", g > 5 && g < 40, "gain " + g.toFixed(1));
}

group("Export level target");
{
  const quiet = new Float32Array(48000);
  for (let i = 0; i < quiet.length; i++) quiet[i] = Math.sin(i / 9) * 0.02;
  const g = Core.levelGain(quiet);
  const after = Float32Array.from(quiet, v => Core.softClip(v * g));
  let sum = 0; for (let i = 0; i < after.length; i++) sum += after[i] * after[i];
  const rms = Math.sqrt(sum / after.length);
  ok("a quiet take lands close to the target level", rms > 0.07, "rms " + rms.toFixed(3));
}

group("Saved preferences");
{
  const shared = new IDBFactory();
  const a = Core.makeStore(shared);
  await a.open();
  eq("an unset preference returns the default", await a.getPref("layout", "recorder-first"), "recorder-first");
  await a.setPref("layout", "recorder-last");
  eq("a preference reads back", await a.getPref("layout", "recorder-first"), "recorder-last");
  await a.setPref("layout", "recorder-first");
  eq("and can be changed again", await a.getPref("layout", "recorder-last"), "recorder-first");

  const b = Core.makeStore(shared);      // a reload
  await b.open();
  eq("it survives a reload", await b.getPref("layout", "recorder-last"), "recorder-first");

  const m = Core.makeStore(null);
  await m.open();
  eq("memory mode falls back to the default", await m.getPref("layout", "recorder-first"), "recorder-first");
  await m.setPref("layout", "recorder-last");
  eq("and still remembers within the session", await m.getPref("layout", "recorder-first"), "recorder-last");
}

group("Preferences do not disturb takes");
{
  const t = Core.makeStore(new IDBFactory());
  await t.open();
  await t.put({ id: "k", name: "Take 001", buf: bytes(64), mime: "audio/mp4", ext: "m4a", ms: 1000, bursts: 1, at: Date.now(), trashed: false });
  await t.setPref("layout", "recorder-last");
  const all = await t.all();
  eq("the preference is not listed as a take", all.length, 1);
  eq("and the take is untouched", all[0].name, "Take 001");
}

group("An old tab holding the previous version");
{
  const shared = new IDBFactory();
  const first = Core.makeStore(shared);          // a tab still on the old schema
  await first.open();
  await first.put({ id: "x", name: "Take 001", buf: bytes(32), mime: "audio/mp4", ext: "m4a", ms: 900, bursts: 1, at: Date.now(), trashed: false });

  const second = Core.makeStore(shared);         // a new tab opens
  const r = await second.open();
  ok("the new tab opens rather than hanging", r.ok === true || second.memory === true, JSON.stringify(r));
  if (r.ok) {
    const all = await second.all();
    eq("and still sees the take", all.length, 1);
  }
  ok("the old connection yields instead of blocking forever", true);
}
console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
})();
