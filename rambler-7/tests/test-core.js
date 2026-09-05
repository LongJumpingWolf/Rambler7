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

console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
})();
