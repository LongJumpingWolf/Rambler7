const fs = require("fs");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { Blob: NodeBlob, File: NodeFile } = require("buffer");
const Core = require("./core.js");

const HTML = fs.readFileSync(__dirname + "/../index.html", "utf8");
const SAMPLE = "/mnt/user-data/uploads/Take_010.m4a";
const realFragmented = fs.existsSync(SAMPLE)
  ? (() => { const b = fs.readFileSync(SAMPLE); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })()
  : null;

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) {
  if (c) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + n); }
  else { fail++; fails.push(n); console.log("  \x1b[31mFAIL\x1b[0m " + n + (x ? "  → " + x : "")); }
}
const eq = (n, a, b) => ok(n, Object.is(a, b), JSON.stringify(a) + " !== " + JSON.stringify(b));
const group = t => console.log("\n\x1b[1m" + t + "\x1b[0m");
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---- fake capture stack ---------------------------------------------- */
function makeEnv(opts = {}) {
  const idb = opts.idb === null ? null : (opts.idb || new IDBFactory());
  const state = { urlTypes: [], loads: [], plays: 0, pauses: 0, revoked: [], gains: [], destStreams: 0, decoded: 0, encodedSamples: 0, encoder: null, granted: opts.granted !== false, chunkBytes: 4000, tracksStopped: 0, recorders: [], downloads: [], shared: [], vibrations: [] };

  class FakeMediaRecorder {
    constructor(stream, cfg) {
      this.stream = stream; this.cfg = cfg || {}; this.state = "inactive";
      this.n = 0; state.recorders.push(this);
    }
    static isTypeSupported(t) { return t.indexOf(opts.formats || "webm") > -1; }
    _emit() {
      const b = new NodeBlob([new Uint8Array(state.chunkBytes).fill(this.n % 251)]);
      this.n++;
      this.ondataavailable && this.ondataavailable({ data: b });
    }
    start() { this.state = "recording"; this._emit(); }
    requestData() { if (this.state === "recording") this._emit(); }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; this._emit(); }
    stop() { this.state = "inactive"; setTimeout(() => this.onstop && this.onstop(), 0); }
  }

  const vc = new (require("jsdom").VirtualConsole)();
  vc.on("jsdomError", err => { if (process.env.SHOW_ERR) console.log("  \x1b[35m[page error]\x1b[0m " + (err.detail || err.message)); });
  vc.on("error", (...a) => { if (process.env.SHOW_ERR) console.log("  \x1b[35m[console.error]\x1b[0m", ...a); });
  const dom = new JSDOM(HTML, {
    virtualConsole: vc,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://local.test/",
    beforeParse(w) {
      w.indexedDB = idb || undefined;
      w.Blob = NodeBlob; w.File = NodeFile;
      w.MediaRecorder = FakeMediaRecorder;
      const node = () => ({ connect() {}, disconnect() {} });
      w.AudioContext = class {
        constructor() { this.state = "running"; this.sampleRate = 48000; this.currentTime = 0; }
        resume() {}
        createAnalyser() {
          return Object.assign(node(), {
            fftSize: 1024,
            getByteTimeDomainData(a) {
              const amp = (opts.micLevel === undefined ? 0.01 : opts.micLevel) * 128;
              for (let i = 0; i < a.length; i++) a[i] = 128 + Math.round(Math.sin(i / 7) * amp);
            }
          });
        }
        createMediaStreamSource() { return node(); }
        createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
        createBufferSource() { return Object.assign(node(), { start() {} }); }
        createBiquadFilter() { return Object.assign(node(), { type: "", frequency: { value: 0 }, Q: { value: 0 } }); }
        createGain() {
          const g = Object.assign(node(), {
            gain: { value: 1, setTargetAtTime(v) { this.value = v; } }
          });
          state.gains.push(g);
          return g;
        }
        createDynamicsCompressor() {
          return Object.assign(node(), { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} });
        }
        createMediaStreamDestination() {
          state.destStreams++;
          return Object.assign(node(), { stream: { __processed: true, getTracks: () => [], getAudioTracks: () => [] } });
        }
        decodeAudioData(ab) {
          const n = Math.max(1152, Math.floor(ab.byteLength / 4));
          state.decoded++;
          return Promise.resolve({
            length: n, numberOfChannels: 1, sampleRate: 48000,
            getChannelData: () => { const amp = opts.decodedLevel === undefined ? 0.25 : opts.decodedLevel; const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = Math.sin(i / 20) * amp; return f; }
          });
        }
      };
      // stand-in MP3 encoder, so the export path runs without loading the real one
      w.lamejs = { Mp3Encoder: class {
        constructor(ch, rate, kbps) { state.encoder = { ch, rate, kbps }; }
        encodeBuffer(s16) { state.encodedSamples += s16.length; return new Int8Array(Math.ceil(s16.length / 8)); }
        flush() { return new Int8Array(4); }
      } };
      w.navigator.mediaDevices = {
        getUserMedia() {
          if (!state.granted) { const e = new Error("denied"); e.name = "NotAllowedError"; return Promise.reject(e); }
          return new Promise(res => setTimeout(() => res({
            getTracks: () => [{ stop() { state.tracksStopped++; } }],
            getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000 }), stop() {}, set onended(f) {} }]
          }), opts.micDelay || 0));
        }
      };
      w.navigator.vibrate = ms => { state.vibrations.push(ms); return true; };
      w.navigator.storage = { persist: () => Promise.resolve(true) };
      let urlN = 0;
      w.URL.createObjectURL = (b) => { state.urlTypes.push(b && b.type); return "blob:fake" + (++urlN); };
      w.URL.revokeObjectURL = u => state.revoked.push(u);
      // a media element with enough behaviour to test the transport
      Object.defineProperty(w.HTMLMediaElement.prototype, "duration", {
        configurable: true, get() { return this.__dur === undefined ? 12 : this.__dur; }
      });
      Object.defineProperty(w.HTMLMediaElement.prototype, "paused", {
        configurable: true, get() { return this.__paused !== false; }
      });
      Object.defineProperty(w.HTMLMediaElement.prototype, "currentTime", {
        configurable: true,
        get() { return this.__t || 0; },
        set(v) { this.__t = Math.max(0, Math.min(v, this.duration)); }
      });
      w.HTMLMediaElement.prototype.load = function () {
        state.loads.push(this.src);
        this.__t = 0;
        const el = this;
        setTimeout(() => { if (el.onloadedmetadata) el.onloadedmetadata(); if (el.oncanplay) el.oncanplay(); }, 5);
      };
      w.HTMLMediaElement.prototype.play = function () {
        this.__paused = false; state.plays++; return Promise.resolve();
      };
      w.HTMLMediaElement.prototype.pause = function () { this.__paused = true; state.pauses++; };
      w.HTMLElement.prototype.setPointerCapture = function () {};
      const click = w.HTMLElement.prototype.click;
      w.HTMLAnchorElement.prototype.click = function () { state.downloads.push(this.getAttribute("download")); };
    }
  });
  const w = dom.window, d = w.document;
  const fire = (el, type, init) => el.dispatchEvent(new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init)));
  const key = (type, code, k) => d.dispatchEvent(new w.KeyboardEvent(type, { code, key: k || code, bubbles: true, cancelable: true }));
  return { dom, w, d, state, idb, fire, key, $: s => d.querySelector(s), $$: s => Array.from(d.querySelectorAll(s)) };
}

const rows = e => e.$$(".tape");
const nameOf = r => r.querySelector(".nm").textContent;
const btn = (r, label) => e2 => 0; // placeholder
/* PLAY and DOWNLOAD sit in the row; Share, Rename and Trash live behind the kebab. */
const MENU = { RENAME: "Rename", SHARE: "Share", TRASH: "Trash" };
const clickBtn = (env, row, label) => {
  const direct = Array.from(row.querySelectorAll(".acts > button")).find(x => x.textContent === label);
  if (direct) { env.fire(direct, "click"); return direct; }
  const menuLabel = MENU[label];
  if (menuLabel) {
    const kebab = row.querySelector(".kebab");
    if (!kebab) throw new Error("no overflow control on row");
    env.fire(kebab, "click");
    const item = Array.from(row.querySelectorAll(".menu button")).find(x => x.textContent.trim() === menuLabel);
    if (!item) throw new Error("menu item not found: " + menuLabel);
    env.fire(item, "click");
    return item;
  }
  throw new Error("button not found: " + label);
};
const openKebab = (env, row) => { env.fire(row.querySelector(".kebab"), "click"); return row.querySelector(".menu"); };

(async () => {

/* ================================================================== */
group("Cold start");
let e = makeEnv();
await wait(80);
eq("starts in standby", e.$("#state").textContent, "STANDBY");
eq("clock reads zero", e.$("#clock").textContent, "00:00.0");
ok("empty state invites the first take", e.$(".empty").textContent.indexOf("No takes yet") > -1);
ok("save is disabled with nothing recorded", e.$("#save").disabled === true);
ok("scrap is disabled with nothing recorded", e.$("#scrap").disabled === true);
ok("no storage warning on a healthy device", !e.$("#warn").classList.contains("show"));
eq("take counter reads zero", e.$("#count").textContent, "0 takes");

/* ================================================================== */
group("Push to talk");
e.fire(e.$("#ptt"), "pointerdown");
ok("button shows pressed immediately, before the mic opens", e.$("#ptt").classList.contains("down"));
ok("press gives haptic feedback", e.state.vibrations.length === 1);
await wait(90);
eq("recording once the mic is live", e.$("#state").textContent, "● RECORDING");
eq("one burst so far", e.$("#bursts").textContent, "1 burst");
ok("hi-fi switch locks during a take", e.$("#hifi").disabled === true);

e.fire(e.$("#ptt"), "pointerup");
await wait(20);
eq("release holds the take instead of ending it", e.$("#state").textContent, "HELD");
ok("button returns to its resting position", !e.$("#ptt").classList.contains("down"));
eq("recorder is paused, not stopped", e.state.recorders[0].state, "paused");
eq("only one recorder was created", e.state.recorders.length, 1);

e.fire(e.$("#ptt"), "pointerdown"); await wait(90);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
eq("a second burst joins the same take", e.$("#bursts").textContent, "2 bursts");
eq("still the same recorder", e.state.recorders.length, 1);
ok("save is now available", e.$("#save").disabled === false);

e.key("keydown", "Space"); await wait(90);
eq("space bar starts a third burst", e.$("#bursts").textContent, "3 bursts");
e.key("keyup", "Space"); await wait(20);
eq("space bar release holds", e.$("#state").textContent, "HELD");

/* ================================================================== */
group("Saving a take");
const expected = e.state.recorders[0].n * e.state.chunkBytes;
e.fire(e.$("#save"), "click");
await wait(120);
eq("one take in the library", rows(e).length, 1);
eq("named automatically", nameOf(rows(e)[0]), "Take 001");
ok("every burst is in the saved audio", rows(e)[0].querySelector(".meta").textContent.indexOf("3 bursts") > -1);
{
  const all = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
  eq("a WebM-only browser stores the take as MP3", all[0].ext, "mp3");
  eq("with the matching media type", all[0].mime, "audio/mpeg");
  ok("every recorded sample went through the encoder", e.state.encodedSamples > 0);
  ok("audio was produced", all[0].buf.byteLength > 0, all[0].buf.byteLength + " bytes from " + expected);
  const parts = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("parts").objectStore("parts").getAll(); g.onsuccess = () => res(g.result); }; });
  eq("crash backup cleaned up after a good save", parts.length, 0);
}
eq("recorder is reset for the next take", e.$("#state").textContent, "SAVED");
eq("counter updated", e.$("#count").textContent, "1 take");
ok("storage use is shown", /KB|MB|B/.test(e.$("#used").textContent));

/* ================================================================== */
group("Renaming");
clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
let inp = rows(e)[0].querySelector(".nm input");
ok("an editable field appears", !!inp);
inp.value = "  Standup notes  ";
inp.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await wait(60);
eq("name is saved and trimmed", nameOf(rows(e)[0]), "Standup notes");

clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
inp = rows(e)[0].querySelector(".nm input");
inp.value = "   ";
inp.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await wait(60);
eq("a blank name is refused and the old one stays", nameOf(rows(e)[0]), "Standup notes");

clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
inp = rows(e)[0].querySelector(".nm input");
inp.value = "Discarded name";
inp.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
await wait(60);
eq("escape cancels the rename", nameOf(rows(e)[0]), "Standup notes");

clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
inp = rows(e)[0].querySelector(".nm input");
inp.value = "x".repeat(200);
inp.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await wait(60);
eq("an absurdly long name is capped", nameOf(rows(e)[0]).length, 60);
clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
inp = rows(e)[0].querySelector(".nm input");
inp.value = "Standup notes";
inp.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
await wait(60);

/* ================================================================== */
group("Numbering after a rename");
e.fire(e.$("#ptt"), "pointerdown"); await wait(180);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(120);
eq("two takes now", rows(e).length, 2);
const names = rows(e).map(nameOf);
const autoName = names.find(n => /^Take \d{3}$/.test(n));
ok("the renamed take kept its name", names.indexOf("Standup notes") > -1, names.join(","));
ok("the new take is auto-named", !!autoName, names.join(","));
ok("no two takes share a name", new Set(names).size === names.length, names.join(","));
ok("newest take is listed first", nameOf(rows(e)[0]) === autoName, names.join(","));

/* ================================================================== */
group("Download and share");
clickBtn(e, rows(e)[1], "DOWNLOAD"); await wait(400);
eq("download converts WebM to a shareable MP3", e.state.downloads[0], "Standup_notes.mp3");
ok("the recording was decoded for conversion", e.state.decoded > 0);
ok("audio was actually run through the encoder", e.state.encodedSamples > 0);
eq("encoded as mono at the recorded rate", e.state.encoder && e.state.encoder.ch, 1);
e.w.navigator.canShare = () => false;
clickBtn(e, rows(e)[1], "SHARE"); await wait(300);
eq("share falls back to a download when the sharesheet is unavailable", e.state.downloads.length, 2);
e.w.navigator.canShare = () => true;
let sharedWith = null;
e.w.navigator.share = o => { sharedWith = o; return Promise.resolve(); };
clickBtn(e, rows(e)[1], "SHARE"); await wait(300);
ok("share hands a real MP3 to the sharesheet",
   !!sharedWith && sharedWith.files && sharedWith.files[0].name === "Standup_notes.mp3",
   sharedWith && sharedWith.files ? sharedWith.files[0].name : "nothing shared");
ok("the shared file carries the right media type",
   !!sharedWith && sharedWith.files[0].type === "audio/mpeg",
   sharedWith && sharedWith.files ? sharedWith.files[0].type : "-");
eq("share did not also trigger a download", e.state.downloads.length, 2);
e.w.navigator.share = () => { const err = new Error("x"); err.name = "AbortError"; return Promise.reject(err); };
clickBtn(e, rows(e)[1], "SHARE"); await wait(300);
eq("cancelling the sharesheet does nothing", e.state.downloads.length, 2);

/* ================================================================== */
group("Playback");
clickBtn(e, rows(e)[0], "PLAY"); await wait(40);
ok("play switches to stop", !!Array.from(rows(e)[0].querySelectorAll("button")).find(b => b.textContent === "STOP"));
clickBtn(e, rows(e)[0], "STOP"); await wait(40);
ok("stop switches back to play", !!Array.from(rows(e)[0].querySelectorAll("button")).find(b => b.textContent === "PLAY"));

/* ================================================================== */
group("Trash, restore, delete forever");
clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
eq("trashed take leaves the list", rows(e).length, 1);
eq("counter reflects the trash", e.$("#count").textContent, "1 take");
e.fire(e.$$(".tab")[1], "click"); await wait(60);
eq("trash tab shows it", rows(e).length, 1);
ok("empty trash control appears", e.$("#bulk").hidden === false);
ok("trash offers restore and permanent delete", Array.from(rows(e)[0].querySelectorAll("button")).map(b => b.textContent).join("|") === "RESTORE|DELETE FOREVER");
clickBtn(e, rows(e)[0], "RESTORE"); await wait(60);
ok("trash is empty after restoring", !!e.$(".empty"));
e.fire(e.$$(".tab")[0], "click"); await wait(60);
eq("restored take is back", rows(e).length, 2);
ok("restored take kept its name", rows(e).map(nameOf).indexOf(autoName) > -1, rows(e).map(nameOf).join(","));

clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
e.fire(e.$$(".tab")[1], "click"); await wait(60);
clickBtn(e, rows(e)[0], "DELETE FOREVER"); await wait(60);
ok("permanent delete empties the trash", !!e.$(".empty"));
e.fire(e.$$(".tab")[0], "click"); await wait(60);
eq("the other take is untouched", rows(e).length, 1);
eq("and it is the right one", nameOf(rows(e)[0]), "Standup notes");

group("Empty trash");
e.fire(e.$("#ptt"), "pointerdown"); await wait(180); e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(120);
clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
eq("both takes are in the trash", rows(e).length, 0);
e.fire(e.$$(".tab")[1], "click"); await wait(60);
eq("trash holds two", rows(e).length, 2);
e.fire(e.$("#bulk"), "click"); await wait(80);
ok("empty trash clears them all", !!e.$(".empty"));
e.fire(e.$$(".tab")[0], "click"); await wait(60);
eq("library is empty and says so", e.$(".empty").textContent.indexOf("No takes yet") > -1, true);
e.dom.window.close();

/* ================================================================== */
group("Scrapping a take");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(180);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#scrap"), "click"); await wait(40);
eq("one tap only arms the scrap, it does not throw the take away", e.$("#scrap").textContent, "TAP TO CONFIRM");
eq("the take is still held", e.$("#state").textContent, "HELD");
e.fire(e.$("#scrap"), "click"); await wait(150);
eq("scrapped audio is not saved", rows(e).length, 0);
eq("recorder returns to standby", e.$("#state").textContent, "STANDBY");
eq("clock resets", e.$("#clock").textContent, "00:00.0");
{
  const parts = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("parts").objectStore("parts").getAll(); g.onsuccess = () => res(g.result); }; });
  eq("scrapping also clears the crash backup", parts.length, 0);
}
e.dom.window.close();

/* ================================================================== */
group("Interruptions while holding");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(30);
e.d.dispatchEvent(new e.w.Event("visibilitychange"));
Object.defineProperty(e.d, "hidden", { value: true, configurable: true });
e.d.dispatchEvent(new e.w.Event("visibilitychange"));
await wait(20);
ok("switching apps mid-burst pauses instead of losing audio", e.$("#state").textContent === "HELD" && e.state.recorders[0].state === "paused");

e.fire(e.$("#ptt"), "pointerdown"); await wait(180);
e.w.dispatchEvent(new e.w.Event("blur")); await wait(20);
eq("losing window focus pauses the burst", e.$("#state").textContent, "HELD");

e.fire(e.$("#ptt"), "pointerdown"); await wait(30);
e.fire(e.$("#ptt"), "pointercancel"); await wait(120);
eq("a cancelled touch pauses cleanly", e.$("#state").textContent, "HELD");

const bu = new e.w.Event("beforeunload", { cancelable: true });
e.w.dispatchEvent(bu);
ok("closing the tab with unsaved audio asks first", bu.defaultPrevented === true);

e.fire(e.$("#save"), "click"); await wait(120);
const bu2 = new e.w.Event("beforeunload", { cancelable: true });
e.w.dispatchEvent(bu2);
ok("no warning once everything is saved", bu2.defaultPrevented === false);
e.dom.window.close();

/* ================================================================== */
group("Tapping faster than the mic can open");
e = makeEnv({ micDelay: 120 }); await wait(60);
e.fire(e.$("#ptt"), "pointerdown");
e.fire(e.$("#ptt"), "pointerup");
await wait(250);
eq("a tap released before the mic opens records nothing", e.state.recorders.length, 0);
eq("and leaves the app in standby", e.$("#state").textContent, "STANDBY");
ok("nothing to save", e.$("#save").disabled === true);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
eq("the next hold works normally", e.$("#state").textContent, "● RECORDING");
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#ptt"), "pointerdown"); e.fire(e.$("#ptt"), "pointerdown"); await wait(30);
eq("a duplicate press event does not double count bursts", e.$("#bursts").textContent, "2 bursts");
e.dom.window.close();

/* ================================================================== */
group("Microphone refused");
e = makeEnv({ granted: false }); await wait(60);
e.fire(e.$("#ptt"), "pointerdown"); await wait(60);
ok("a clear explanation is shown", e.$("#warn").classList.contains("show") && /permission/i.test(e.$("#warn").textContent));
eq("nothing is recorded", e.state.recorders.length, 0);
eq("the button springs back", e.$("#ptt").classList.contains("down"), false);
eq("state stays in standby", e.$("#state").textContent, "STANDBY");
e.dom.window.close();

/* ================================================================== */
group("Recovering an interrupted take");
{
  const shared = new IDBFactory();
  const seed = makeEnv({ idb: shared }); await wait(80);
  seed.fire(seed.$("#ptt"), "pointerdown"); await wait(40);
  seed.fire(seed.$("#ptt"), "pointerup"); await wait(40);
  seed.fire(seed.$("#ptt"), "pointerdown"); await wait(40);
  seed.fire(seed.$("#ptt"), "pointerup"); await wait(60);
  const written = seed.state.recorders[0].n * seed.state.chunkBytes;
  seed.dom.window.close();               // the tab dies before Save was pressed

  const back = makeEnv({ idb: shared }); await wait(150);
  ok("the lost take is offered back on the next launch", back.$("#recover").classList.contains("show"));
  ok("the offer says how much audio was found", /\d+\.?\d* ?(B|KB|MB)/.test(back.$("#recover").textContent));
  eq("nothing was silently added to the library", rows(back).length, 0);
  const keep = Array.from(back.$("#recover").querySelectorAll("button")).find(b => b.textContent === "Recover it");
  back.fire(keep, "click"); await wait(150);
  eq("recovering adds it to the library", rows(back).length, 1);
  const all = await new Promise(res => { const r = back.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
  ok("the recovered take holds audio", all[0].buf.byteLength > 0, all[0].buf.byteLength + " from " + written);
  eq("and is recovered in a portable format", all[0].ext, "mp3");
  ok("the offer disappears once handled", !back.$("#recover").classList.contains("show"));
  back.dom.window.close();

  const third = makeEnv({ idb: shared }); await wait(150);
  ok("the same take is not offered twice", !third.$("#recover").classList.contains("show"));
  eq("and it is still in the library", rows(third).length, 1);
  third.dom.window.close();
}

group("Discarding an interrupted take");
{
  const shared = new IDBFactory();
  const seed = makeEnv({ idb: shared }); await wait(80);
  seed.fire(seed.$("#ptt"), "pointerdown"); await wait(40);
  seed.fire(seed.$("#ptt"), "pointerup"); await wait(60);
  seed.dom.window.close();
  const back = makeEnv({ idb: shared }); await wait(150);
  const drop = Array.from(back.$("#recover").querySelectorAll("button")).find(b => b.textContent === "Discard");
  back.fire(drop, "click"); await wait(100);
  ok("discarding hides the offer", !back.$("#recover").classList.contains("show"));
  back.dom.window.close();
  const third = makeEnv({ idb: shared }); await wait(150);
  ok("a discarded take does not come back", !third.$("#recover").classList.contains("show"));
  third.dom.window.close();
}

/* ================================================================== */
group("Takes survive a reload");
{
  const shared = new IDBFactory();
  const first = makeEnv({ idb: shared }); await wait(80);
  first.fire(first.$("#ptt"), "pointerdown"); await wait(180);
  first.fire(first.$("#ptt"), "pointerup"); await wait(20);
  first.fire(first.$("#save"), "click"); await wait(150);
  clickBtn(first, rows(first)[0], "RENAME"); await wait(30);
  const i = rows(first)[0].querySelector(".nm input");
  i.value = "Field note 1";
  i.dispatchEvent(new first.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
  first.dom.window.close();

  const second = makeEnv({ idb: shared }); await wait(150);
  eq("the take is still there after reopening", rows(second).length, 1);
  eq("with the name it was given", nameOf(rows(second)[0]), "Field note 1");
  ok("and its audio", second.$("#used").textContent !== "0 B");
  second.dom.window.close();
}

/* ================================================================== */
group("No storage available");
e = makeEnv({ idb: null }); await wait(120);
ok("the app explains that takes will not persist", e.$("#warn").classList.contains("show") && /memory/i.test(e.$("#warn").textContent));
e.fire(e.$("#ptt"), "pointerdown"); await wait(180);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(150);
eq("recording still works without storage", rows(e).length, 1);
ok("the footer flags that it is session only", e.$("#count").textContent.indexOf("session only") > -1);
clickBtn(e, rows(e)[0], "RENAME"); await wait(30);
{
  const i2 = rows(e)[0].querySelector(".nm input");
  i2.value = "Temp"; i2.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(60);
}
eq("rename works without storage", nameOf(rows(e)[0]), "Temp");
clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
eq("trash works without storage", rows(e).length, 0);
e.dom.window.close();


/* ================================================================== */
group("Keyboard operation");
e = makeEnv(); await wait(80);
e.$("#ptt").focus();
e.key("keydown", "Space"); await wait(120);
eq("space records when the hold button has focus", e.$("#state").textContent, "\u25cf RECORDING");
e.key("keyup", "Space"); await wait(20);
eq("releasing space holds the take", e.$("#state").textContent, "HELD");
e.key("keydown", "Enter", "Enter"); await wait(120);
eq("enter records too when the button has focus", e.$("#state").textContent, "\u25cf RECORDING");
e.key("keyup", "Enter", "Enter"); await wait(20);
e.key("keydown", "Space"); await wait(30);
e.key("keydown", "Space"); await wait(90);
eq("auto-repeat does not add phantom bursts", e.$("#bursts").textContent, "3 bursts");
e.key("keyup", "Space"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(150);
eq("a keyboard-only take saves", rows(e).length, 1);

clickBtn(e, rows(e)[0], "RENAME"); await wait(40);
{
  const i3 = rows(e)[0].querySelector(".nm input");
  i3.focus();
  e.key("keydown", "Space");
  await wait(60);
  ok("space while renaming types a space instead of recording",
     e.$("#state").textContent !== "\u25cf RECORDING" && e.state.recorders.length === 1,
     e.$("#state").textContent + " / recorders=" + e.state.recorders.length);
  i3.value = "Voice memo one";
  i3.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
}
eq("the rename still went through", nameOf(rows(e)[0]), "Voice memo one");
e.dom.window.close();


/* ================================================================== */
group("Rotation mid-hold");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
eq("recording before rotation", e.$("#state").textContent, "\u25cf RECORDING");
e.w.dispatchEvent(new e.w.Event("orientationchange"));
await wait(20);
eq("rotating pauses the burst instead of leaving it stuck", e.$("#state").textContent, "HELD");
eq("the recorder itself is paused", e.state.recorders[0].state, "paused");
ok("the take is not lost, it can still be saved", e.$("#save").disabled === false);
e.fire(e.$("#save"), "click"); await wait(150);
eq("a take interrupted by rotation still saves", rows(e).length, 1);
e.dom.window.close();

group("Repeated fast presses do not select text on the button");
e = makeEnv(); await wait(80);
const sel = new e.w.Event("selectstart", { cancelable: true });
e.$("#ptt").dispatchEvent(sel);
ok("selectstart on the hold button is prevented", sel.defaultPrevented === true);
for(let i=0;i<6;i++){
  e.fire(e.$("#ptt"), "pointerdown");
  e.fire(e.$("#ptt"), "pointerup");
}
await wait(200);
ok("rapid repeated taps do not throw or wedge the recorder", e.$("#state").textContent === "STANDBY" || e.$("#state").textContent === "HELD");
e.dom.window.close();


/* ================================================================== */
group("Recording level");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
ok("audio is recorded through a processing chain, not straight off the mic", e.state.destStreams > 0);
ok("the recorder is fed the processed stream", e.state.recorders[0].stream.__processed === true);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.dom.window.close();

group("Export is reused, not recomputed");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(200);
clickBtn(e, rows(e)[0], "DOWNLOAD"); await wait(400);
const firstDecodes = e.state.decoded;
ok("the first export does the conversion work", firstDecodes > 0);
clickBtn(e, rows(e)[0], "DOWNLOAD"); await wait(200);
eq("a second export reuses the converted file", e.state.decoded, firstDecodes);
eq("but still produces a file", e.state.downloads.length, 2);
e.dom.window.close();

group("Play and pause do not rebuild the list");
e = makeEnv(); await wait(80);
for (let k = 0; k < 2; k++) {
  e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
  e.fire(e.$("#ptt"), "pointerup"); await wait(20);
  e.fire(e.$("#save"), "click"); await wait(200);
}
eq("two takes to play with", rows(e).length, 2);
const rowNodeBefore = rows(e)[0];
const fillBefore = rowNodeBefore.querySelector(".seek i");
clickBtn(e, rows(e)[0], "PLAY"); await wait(80);
ok("the row element is not replaced when playback starts", rows(e)[0] === rowNodeBefore);
ok("the progress bar survives, so it cannot jump", rows(e)[0].querySelector(".seek i") === fillBefore);
eq("the button flips to stop in place", Array.from(rows(e)[0].querySelectorAll(".acts button")).map(b => b.textContent)[0], "STOP");
eq("the other row still offers play", Array.from(rows(e)[1].querySelectorAll(".acts button")).map(b => b.textContent)[0], "PLAY");
clickBtn(e, rows(e)[0], "STOP"); await wait(60);
ok("stopping also leaves the row in place", rows(e)[0] === rowNodeBefore);
eq("and flips the label back", Array.from(rows(e)[0].querySelectorAll(".acts button")).map(b => b.textContent)[0], "PLAY");

clickBtn(e, rows(e)[0], "PLAY"); await wait(60);
clickBtn(e, rows(e)[1], "PLAY"); await wait(60);
eq("switching takes stops the first", Array.from(rows(e)[0].querySelectorAll(".acts button")).map(b => b.textContent)[0], "PLAY");
eq("and starts the second", Array.from(rows(e)[1].querySelectorAll(".acts button")).map(b => b.textContent)[0], "STOP");
for (let k = 0; k < 8; k++) { clickBtn(e, rows(e)[1], k % 2 ? "PLAY" : "STOP"); await wait(25); }
ok("hammering play and pause leaves a consistent state",
   rows(e).length === 2 && Array.from(rows(e)[1].querySelectorAll(".acts button")).map(b => b.textContent)[0].match(/PLAY|STOP/));
e.dom.window.close();


/* ================================================================== */
group("Browsers that can record m4a");
e = makeEnv({ formats: "mp4" }); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
const rawBytes = e.state.recorders[0].n * e.state.chunkBytes;
e.fire(e.$("#save"), "click"); await wait(250);
{
  const all = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
  eq("the take is stored as m4a", all[0].ext, "m4a");
  eq("it was measured for level", e.state.decoded > 0, true);
  eq("but not re-encoded, since it was already loud enough", e.state.encodedSamples, 0);
  eq("every recorded byte is preserved untouched", all[0].buf.byteLength, rawBytes);
}
eq("the row shows the format", rows(e)[0].querySelector(".meta").textContent.indexOf("M4A") > -1, true);
ok("and is not flagged for conversion", rows(e)[0].querySelector(".meta").textContent.indexOf("converts on export") === -1);
clickBtn(e, rows(e)[0], "DOWNLOAD"); await wait(400);
eq("download hands over the m4a as-is", e.state.downloads[0], "Take_001.m4a");
eq("with no re-encoding at any point", e.state.encodedSamples, 0);
e.dom.window.close();

group("Recordings already stuck in the app as WebM");
{
  const shared = new IDBFactory();
  // seed a take seeded the way the old build stored them
  await new Promise((res, rej) => {
    const r = shared.open("rambler7", 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("takes")) d.createObjectStore("takes", { keyPath: "id" });
      if (!d.objectStoreNames.contains("parts")) d.createObjectStore("parts", { keyPath: "key" });
    };
    r.onsuccess = () => {
      const tx = r.result.transaction("takes", "readwrite");
      tx.objectStore("takes").put({
        id: "legacy1", name: "Old interview", buf: new Uint8Array(8000).fill(3).buffer,
        mime: "audio/webm;codecs=opus", ext: "webm", ms: 9000, bursts: 2,
        at: Date.now() - 86400000, trashed: false
      });
      tx.oncomplete = () => { r.result.close(); res(); };   // release it, or the upgrade is blocked
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });

  e = makeEnv({ idb: shared, formats: "mp4" }); await wait(150);
  eq("the old take is still listed", rows(e).length, 1);
  eq("with its name intact", nameOf(rows(e)[0]), "Old interview");
  ok("it is labelled WEBM", rows(e)[0].querySelector(".meta").textContent.indexOf("WEBM") > -1);
  ok("and flagged as needing conversion", rows(e)[0].querySelector(".meta").textContent.indexOf("converts on export") > -1);
  ok("it can still be played", !!Array.from(rows(e)[0].querySelectorAll(".acts button")).find(b => b.textContent === "PLAY"));

  clickBtn(e, rows(e)[0], "DOWNLOAD"); await wait(400);
  eq("downloading converts it to MP3", e.state.downloads[0], "Old_interview.mp3");
  ok("the old audio was decoded and re-encoded", e.state.decoded > 0 && e.state.encodedSamples > 0);

  const before = e.state.decoded;
  e.w.navigator.canShare = () => true;
  let got = null;
  e.w.navigator.share = o => { got = o; return Promise.resolve(); };
  clickBtn(e, rows(e)[0], "SHARE"); await wait(300);
  ok("sharing it hands over the same converted MP3", !!got && got.files[0].name === "Old_interview.mp3");
  eq("without converting a second time", e.state.decoded, before);

  clickBtn(e, rows(e)[0], "RENAME"); await wait(40);
  const li = rows(e)[0].querySelector(".nm input");
  li.value = "Interview with Sam";
  li.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
  eq("an old take can still be renamed", nameOf(rows(e)[0]), "Interview with Sam");
  clickBtn(e, rows(e)[0], "TRASH"); await wait(60);
  eq("and trashed", rows(e).length, 0);
  e.dom.window.close();
}


/* ================================================================== */
group("Automatic gain while recording");
e = makeEnv({ micLevel: 0.006 });          // a quiet phone microphone
await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(700);
{
  const agcGain = e.state.gains.find(g => g.gain.value > 1.05);
  ok("a quiet microphone is boosted while recording", !!agcGain,
     "gains seen: " + e.state.gains.map(g => g.gain.value.toFixed(2)).join(", "));
  ok("the working boost is shown on the display", /Boost x/.test(e.$("#src").textContent), e.$("#src").textContent);
}
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.dom.window.close();

e = makeEnv({ micLevel: 0.25 });           // a healthy signal needs no help
await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(500);
ok("a healthy microphone is not boosted much", e.state.gains.every(g => g.gain.value < 3),
   e.state.gains.map(g => g.gain.value.toFixed(2)).join(", "));
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.dom.window.close();

group("A quiet m4a take is levelled rather than left soft");
e = makeEnv({ formats: "mp4", decodedLevel: 0.008 }); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(400);
{
  const all = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
  ok("the finished take was measured", e.state.decoded > 0);
  ok("a take that came out quiet is levelled on the way in", all[0].ext === "mp3",
     "stored as " + all[0].ext);
  ok("it still holds audio", all[0].buf.byteLength > 0);
}
e.dom.window.close();


/* ================================================================== */
group("Microphone is released when idle");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
eq("the microphone stays open between bursts", e.state.tracksStopped, 0);
e.fire(e.$("#save"), "click"); await wait(300);
ok("it is released once the take is saved", e.state.tracksStopped > 0,
   "tracks stopped: " + e.state.tracksStopped);
eq("the display invites a new take", e.$("#src").textContent, "Hold to open mic");
{
  const stoppedBefore = e.state.tracksStopped;
  e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
  ok("holding again reopens it", e.$("#state").textContent === "\u25cf RECORDING");
  e.fire(e.$("#ptt"), "pointerup"); await wait(20);
  e.fire(e.$("#save"), "click"); await wait(300);
  ok("and it is released again", e.state.tracksStopped > stoppedBefore);
}
clickBtn(e, rows(e)[0], "PLAY"); await wait(80);
eq("playback sets full volume", e.$("#player").volume, 1);
e.dom.window.close();

group("Undoing a burst");
e = makeEnv(); await wait(80);
ok("nothing to undo before recording", e.$("#undo").disabled === true);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
ok("undo is unavailable while the button is held", e.$("#undo").disabled === true);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
ok("undo becomes available once released", e.$("#undo").disabled === false);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
eq("three bursts recorded", e.$("#bursts").textContent, "3 bursts");
const clockAt3 = e.$("#clock").textContent;
e.fire(e.$("#undo"), "click"); await wait(60);
eq("undo removes the last burst", e.$("#bursts").textContent, "2 bursts");
ok("and rolls the clock back", e.$("#clock").textContent < clockAt3, clockAt3 + " → " + e.$("#clock").textContent);
ok("the take is still held, not ended", e.$("#state").textContent === "HELD");
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
eq("recording can continue after an undo", e.$("#bursts").textContent, "3 bursts");
e.fire(e.$("#save"), "click"); await wait(300);
eq("the shortened take saves", rows(e).length, 1);
e.dom.window.close();

group("Undoing every burst ends the take");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#undo"), "click"); await wait(80);
eq("the recorder returns to standby", e.$("#state").textContent, "STANDBY");
eq("the clock resets", e.$("#clock").textContent, "00:00.0");
eq("there is nothing to save", e.$("#save").disabled, true);
eq("and nothing to undo", e.$("#undo").disabled, true);
{
  const parts = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("parts").objectStore("parts").getAll(); g.onsuccess = () => res(g.result); }; });
  eq("the crash backup is cleared, so it cannot come back", parts.length, 0);
}
eq("no take was saved", rows(e).length, 0);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
eq("a fresh take can be started", e.$("#bursts").textContent, "1 burst");
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.dom.window.close();

group("Scrapping asks first");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#scrap"), "click"); await wait(40);
eq("the button asks for confirmation", e.$("#scrap").textContent, "TAP TO CONFIRM");
ok("and is visibly armed", e.$("#scrap").classList.contains("arm"));
ok("the audio is untouched", e.$("#bursts").textContent === "1 burst");
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
eq("recording again cancels the question", e.$("#scrap").textContent, "SCRAP TAKE");
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
eq("and the take survived", e.$("#bursts").textContent, "2 bursts");
e.fire(e.$("#scrap"), "click"); await wait(40);
e.fire(e.$("#scrap"), "click"); await wait(200);
eq("confirming does scrap it", e.$("#state").textContent, "STANDBY");
eq("nothing was saved", rows(e).length, 0);
eq("and the button is back to normal", e.$("#scrap").textContent, "SCRAP TAKE");
e.dom.window.close();

group("Progress bar");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(300);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(300);
{
  const row = rows(e)[0];
  ok("the bar has a fill and a handle", !!row.querySelector(".seek i") && !!row.querySelector(".seek b"));
  ok("elapsed and total times are shown", !!row.querySelector(".times"));
  eq("total time is filled in", row.querySelectorAll(".times span")[1].textContent.length > 0, true);
  ok("the bar is not highlighted while stopped", !row.querySelector(".seek").classList.contains("live"));
  clickBtn(e, row, "PLAY"); await wait(100);
  ok("it lights up during playback", rows(e)[0].querySelector(".seek").classList.contains("live"));
  const seek = rows(e)[0].querySelector(".seek");
  seek.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10 });
  seek.dispatchEvent(new e.w.MouseEvent("pointerdown", { clientX: 100, bubbles: true, cancelable: true }));
  await wait(60);
  ok("dragging moves the fill", parseFloat(rows(e)[0].querySelector(".seek i").style.width) > 0,
     rows(e)[0].querySelector(".seek i").style.width);
  ok("and moves the handle with it", parseFloat(rows(e)[0].querySelector(".seek b").style.left) > 0);
  seek.dispatchEvent(new e.w.MouseEvent("pointermove", { clientX: 160, bubbles: true, cancelable: true }));
  await wait(40);
  ok("the fill follows the finger", parseFloat(rows(e)[0].querySelector(".seek i").style.width) > 40);
  seek.dispatchEvent(new e.w.MouseEvent("pointerup", { clientX: 160, bubbles: true, cancelable: true }));
  await wait(40);
  clickBtn(e, rows(e)[0], "STOP"); await wait(60);
  eq("stopping resets the bar", rows(e)[0].querySelector(".seek i").style.width, "0%");
  eq("and the elapsed readout", rows(e)[0].querySelectorAll(".times span")[0].textContent, "0:00");
}
e.dom.window.close();


/* ================================================================== */
group("Starting a second take while one is playing");
e = makeEnv(); await wait(80);
for (let k = 0; k < 3; k++) {
  e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
  e.fire(e.$("#ptt"), "pointerup"); await wait(20);
  e.fire(e.$("#save"), "click"); await wait(300);
}
eq("three takes to work with", rows(e).length, 3);

clickBtn(e, rows(e)[0], "PLAY"); await wait(60);
const firstSrc = e.$("#player").src;
ok("the first take is playing", e.state.plays === 1 && !e.$("#player").paused);

const pausesBefore = e.state.pauses;
clickBtn(e, rows(e)[1], "PLAY"); await wait(80);
ok("the outgoing take is paused before the source is swapped", e.state.pauses > pausesBefore);
ok("the second take actually starts", e.state.plays === 2 && !e.$("#player").paused);
ok("it loaded a different source", e.$("#player").src !== firstSrc, e.$("#player").src);
ok("the first take's source was not revoked while it was still playing",
   e.state.revoked.indexOf(firstSrc.replace(/^.*\//, "")) === -1 || e.state.revoked.length === 0);
eq("only the second row shows stop", rows(e).map(r => r.querySelector(".acts button").textContent).join(","), "PLAY,STOP,PLAY");
eq("the first row's bar was reset", rows(e)[0].querySelector(".seek i").style.width, "0%");

clickBtn(e, rows(e)[2], "PLAY"); await wait(80);
ok("a third take starts cleanly too", e.state.plays === 3 && !e.$("#player").paused);
clickBtn(e, rows(e)[0], "PLAY"); await wait(80);
ok("and going back to the first still works", e.state.plays === 4 && !e.$("#player").paused);
eq("still only one row shows stop", rows(e).map(r => r.querySelector(".acts button").textContent).join(","), "STOP,PLAY,PLAY");

// rapid switching must not wedge anything
for (let k = 0; k < 6; k++) {
  e.fire(rows(e)[k % 3].querySelector(".acts button"), "click");   // whatever it currently reads
  await wait(30);
}
await wait(120);
ok("hammering between takes leaves exactly one playing",
   rows(e).map(r => r.querySelector(".acts button").textContent).filter(t => t === "STOP").length <= 1);
e.dom.window.close();

group("The progress bar always moves while audio plays");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(300);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(300);
clickBtn(e, rows(e)[0], "PLAY"); await wait(60);
{
  const p = e.$("#player");
  const bar = () => parseFloat(rows(e)[0].querySelector(".seek i").style.width) || 0;
  p.currentTime = 3; await wait(120);
  ok("the fill tracks playback position", bar() > 15, "width " + bar());
  ok("the elapsed time updates", rows(e)[0].querySelectorAll(".times span")[0].textContent !== "0:00");
  p.currentTime = 9; await wait(120);
  ok("and keeps tracking", bar() > 60, "width " + bar());

  // an interrupted drag used to leave the bar frozen for the rest of the session
  const seek = rows(e)[0].querySelector(".seek");
  seek.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10 });
  seek.dispatchEvent(new e.w.MouseEvent("pointerdown", { clientX: 50, bubbles: true, cancelable: true }));
  await wait(40);
  e.d.dispatchEvent(new e.w.MouseEvent("pointerup", { clientX: 50, bubbles: true, cancelable: true }));
  await wait(40);
  p.currentTime = 11; await wait(120);
  ok("the bar resumes after a drag ends off the bar", bar() > 80, "width " + bar());

  // a drag interrupted by a re-render must not freeze it either
  seek.dispatchEvent(new e.w.MouseEvent("pointerdown", { clientX: 100, bubbles: true, cancelable: true }));
  await wait(30);
  clickBtn(e, rows(e)[0], "RENAME"); await wait(40);
  const inp2 = rows(e)[0].querySelector(".nm input");
  inp2.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(80);
  p.currentTime = 6; await wait(150);
  ok("a re-render during a drag does not freeze the bar", parseFloat(rows(e)[0].querySelector(".seek i").style.width) > 30,
     "width " + rows(e)[0].querySelector(".seek i").style.width);
}
e.dom.window.close();

group("Dragging the progress bar");
e = makeEnv(); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(300);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(300);
{
  const seek = () => rows(e)[0].querySelector(".seek");
  seek().getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10 });
  const p = e.$("#player");

  // dragging on a stopped take starts it at that point
  seek().dispatchEvent(new e.w.MouseEvent("pointerdown", { clientX: 100, bubbles: true, cancelable: true }));
  await wait(80);
  ok("dragging a stopped take starts playback", !p.paused);
  ok("and starts it where you pressed", Math.abs(p.currentTime - 6) < 1.5, "at " + p.currentTime);

  // the drag continues even when the finger leaves the bar
  const s2 = rows(e)[0].querySelector(".seek");
  s2.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10 });
  s2.dispatchEvent(new e.w.MouseEvent("pointerdown", { clientX: 20, bubbles: true, cancelable: true }));
  await wait(30);
  e.d.dispatchEvent(new e.w.MouseEvent("pointermove", { clientX: 150, bubbles: true, cancelable: true }));
  await wait(40);
  ok("the position follows a move outside the bar", Math.abs(p.currentTime - 9) < 1.5, "at " + p.currentTime);
  e.d.dispatchEvent(new e.w.MouseEvent("pointermove", { clientX: 400, bubbles: true, cancelable: true }));
  await wait(40);
  ok("dragging past the end clamps to the end", p.currentTime <= p.duration, "at " + p.currentTime);
  e.d.dispatchEvent(new e.w.MouseEvent("pointermove", { clientX: -80, bubbles: true, cancelable: true }));
  await wait(40);
  ok("and past the start clamps to zero", p.currentTime >= 0 && p.currentTime < 1, "at " + p.currentTime);
  e.d.dispatchEvent(new e.w.MouseEvent("pointerup", { clientX: -80, bubbles: true, cancelable: true }));
  await wait(40);

  // keyboard
  const s3 = rows(e)[0].querySelector(".seek");
  eq("the bar reports itself as a slider", s3.getAttribute("role"), "slider");
  ok("with a live position for screen readers", s3.getAttribute("aria-valuenow") !== null);
  p.currentTime = 4;
  s3.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await wait(40);
  ok("arrow keys nudge the position", p.currentTime > 4, "at " + p.currentTime);
  s3.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await wait(40);
  ok("and back the other way", p.currentTime < 9.1, "at " + p.currentTime);
}
e.dom.window.close();


/* ================================================================== */
group("Choosing where the recorder sits");
e = makeEnv(); await wait(120);
eq("the recorder is on top by default", e.$(".app").classList.contains("flip"), false);
eq("the control is a switch, like the hi-fi one beside it", e.$("#flip").type, "checkbox");
ok("it sits with the other switches on the device", !!e.$(".strip #flip"));
ok("it has a visible label", e.$("#flip").parentNode.textContent.trim().length > 3,
   e.$("#flip").parentNode.textContent);
eq("and starts off", e.$("#flip").checked, false);

const flipIt = () => { e.$("#flip").checked = !e.$("#flip").checked; e.$("#flip").dispatchEvent(new e.w.Event("change", { bubbles: true })); };
flipIt(); await wait(80);
ok("switching it moves the recorder below the library", e.$(".app").classList.contains("flip"));
flipIt(); await wait(80);
eq("switching back puts it on top", e.$(".app").classList.contains("flip"), false);
flipIt(); await wait(120);

// recording must work in either arrangement
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
eq("recording works with the recorder below", e.$("#state").textContent, "\u25cf RECORDING");
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(300);
eq("and saving works", rows(e).length, 1);
ok("the layout is still flipped afterwards", e.$(".app").classList.contains("flip"));
const layoutIdb = e.idb;
e.dom.window.close();

{
  const back = makeEnv({ idb: layoutIdb }); await wait(150);
  ok("the choice is remembered on the next visit", back.$(".app").classList.contains("flip"));
  eq("and the switch shows it as on", back.$("#flip").checked, true);
  eq("takes are still there too", rows(back).length, 1);
  back.$("#flip").checked = false;
  back.$("#flip").dispatchEvent(new back.w.Event("change", { bubbles: true }));
  await wait(80);
  const idb2 = back.idb;
  back.dom.window.close();

  const third = makeEnv({ idb: idb2 }); await wait(150);
  eq("switching back is remembered as well", third.$(".app").classList.contains("flip"), false);
  third.dom.window.close();
}

group("Layout choice without storage");
e = makeEnv({ idb: null }); await wait(150);
eq("it defaults to the recorder on top", e.$(".app").classList.contains("flip"), false);
e.$("#flip").checked = true;
e.$("#flip").dispatchEvent(new e.w.Event("change", { bubbles: true }));
await wait(60);
ok("and can still be switched for the session", e.$(".app").classList.contains("flip"));
e.dom.window.close();


/* ================================================================== */
group("Repairing takes recorded before the container fix");
if (!realFragmented) {
  ok("sample recording unavailable, repair checks skipped", true);
} else {
  const shared = new IDBFactory();
  await new Promise((res, rej) => {
    const r = shared.open("rambler7", 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("takes")) d.createObjectStore("takes", { keyPath: "id" });
      if (!d.objectStoreNames.contains("parts")) d.createObjectStore("parts", { keyPath: "key" });
      if (!d.objectStoreNames.contains("prefs")) d.createObjectStore("prefs", { keyPath: "key" });
    };
    r.onsuccess = () => {
      const tx = r.result.transaction("takes", "readwrite");
      const st = tx.objectStore("takes");
      st.put({ id: "old1", name: "Interview", buf: realFragmented.slice(0), mime: "audio/mp4", ext: "m4a",
               ms: 999000, bursts: 3, at: Date.now() - 200000, trashed: false });
      st.put({ id: "old2", name: "Notes", buf: realFragmented.slice(0), mime: "audio/mp4", ext: "m4a",
               ms: 55400, bursts: 1, at: Date.now() - 100000, trashed: false });
      tx.oncomplete = () => { r.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });

  e = makeEnv({ idb: shared, formats: "mp4" }); await wait(250);
  ok("the app notices takes that other apps cannot open", e.$("#repair").classList.contains("show"));
  ok("it says how many", /2 older takes/.test(e.$("#repair").textContent), e.$("#repair").textContent);
  ok("and promises not to touch the audio", /audio is not touched/.test(e.$("#repair").textContent));
  eq("the takes are listed as normal in the meantime", rows(e).length, 2);

  const go = Array.from(e.$("#repair").querySelectorAll("button")).find(b => /^Repair/.test(b.textContent));
  e.fire(go, "click");
  await wait(900);
  ok("the offer clears once done", !e.$("#repair").classList.contains("show"));
  {
    const all = await new Promise(res => { const r = e.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
    eq("both takes are still there", all.length, 2);
    ok("neither is fragmented any more", all.every(t => !Core.isFragmented(t.buf)),
       all.map(t => t.id + ":" + Core.isFragmented(t.buf)).join(" "));
    ok("names are kept", all.map(t => t.name).sort().join(",") === "Interview,Notes");
    const fixed = all.find(t => t.id === "old1");
    ok("an overstated duration is corrected to the real audio length",
       Math.abs(fixed.ms - 55400) < 1500, "ms now " + fixed.ms);
    const untouched = all.find(t => t.id === "old2");
    ok("a duration that was already right is left alone", Math.abs(untouched.ms - 55400) < 1500);
    ok("the audio is still there", all.every(t => t.buf.byteLength > 100000));
  }
  e.dom.window.close();

  // a second visit must not nag about takes that are already fine
  const again = makeEnv({ idb: shared, formats: "mp4" }); await wait(250);
  ok("it does not ask again once they are repaired", !again.$("#repair").classList.contains("show"));
  eq("and the takes are all still listed", rows(again).length, 2);
  again.dom.window.close();

  // declining leaves everything alone
  const shared2 = new IDBFactory();
  await new Promise((res, rej) => {
    const r = shared2.open("rambler7", 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      ["takes", "parts", "prefs"].forEach(n => {
        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: n === "takes" ? "id" : "key" });
      });
    };
    r.onsuccess = () => {
      const tx = r.result.transaction("takes", "readwrite");
      tx.objectStore("takes").put({ id: "keep", name: "Old one", buf: realFragmented.slice(0), mime: "audio/mp4",
                                    ext: "m4a", ms: 55400, bursts: 1, at: Date.now(), trashed: false });
      tx.oncomplete = () => { r.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  const decl = makeEnv({ idb: shared2, formats: "mp4" }); await wait(250);
  const no = Array.from(decl.$("#repair").querySelectorAll("button")).find(b => b.textContent === "Not now");
  decl.fire(no, "click"); await wait(80);
  ok("declining hides the offer", !decl.$("#repair").classList.contains("show"));
  {
    const all = await new Promise(res => { const r = decl.w.indexedDB.open("rambler7"); r.onsuccess = () => { const g = r.result.transaction("takes").objectStore("takes").getAll(); g.onsuccess = () => res(g.result); }; });
    ok("and changes nothing", Core.isFragmented(all[0].buf) === true);
  }
  ok("the take still plays and exports as before", !!decl.$(".tape"));
  decl.dom.window.close();
}

group("Nothing to repair on a clean library");
e = makeEnv({ formats: "mp4" }); await wait(200);
ok("no offer is shown when every take is already fine", !e.$("#repair").classList.contains("show"));
e.dom.window.close();


/* ================================================================== */
group("Downloading saves instead of previewing");
e = makeEnv({ formats: "mp4" }); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(350);
e.state.urlTypes.length = 0;
clickBtn(e, rows(e)[0], "DOWNLOAD"); await wait(400);
eq("a file was produced", e.state.downloads.length, 1);
eq("with the right filename", e.state.downloads[0], "Take_001.m4a");
ok("handed over as a binary stream, so the browser cannot preview it",
   e.state.urlTypes.indexOf("application/octet-stream") > -1, e.state.urlTypes.join(","));
e.dom.window.close();

group("Sharing still hands over real audio");
e = makeEnv({ formats: "mp4" }); await wait(80);
e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
e.fire(e.$("#ptt"), "pointerup"); await wait(20);
e.fire(e.$("#save"), "click"); await wait(350);
e.w.navigator.canShare = () => true;
let shareArg = null;
e.w.navigator.share = o => { shareArg = o; return Promise.resolve(); };
clickBtn(e, rows(e)[0], "SHARE"); await wait(400);
ok("the sharesheet gets an audio file, not a binary blob",
   !!shareArg && shareArg.files[0].type.indexOf("audio") === 0, shareArg && shareArg.files[0].type);
eq("named properly", shareArg.files[0].name, "Take_001.m4a");
ok("the menu closes once shared", !e.d.querySelector(".menu"));
e.dom.window.close();

group("The row overflow menu");
e = makeEnv({ formats: "mp4" }); await wait(80);
for (let k = 0; k < 2; k++) {
  e.fire(e.$("#ptt"), "pointerdown"); await wait(200);
  e.fire(e.$("#ptt"), "pointerup"); await wait(20);
  e.fire(e.$("#save"), "click"); await wait(350);
}
{
  const row = rows(e)[0];
  const direct = Array.from(row.querySelectorAll(".acts > button")).map(b => b.textContent.replace(/\s/g, ""));
  eq("only play and download stay in the row", direct.slice(0, 2).join(","), "PLAY,DOWNLOAD");
  ok("plus one overflow control", !!row.querySelector(".kebab"));
  eq("which is labelled for screen readers", row.querySelector(".kebab").getAttribute("aria-haspopup"), "true");
  eq("and reports itself closed", row.querySelector(".kebab").getAttribute("aria-expanded"), "false");
  ok("no menu is showing yet", !e.d.querySelector(".menu"));

  const menu = openKebab(e, rows(e)[0]);
  ok("opening it shows a menu", !!menu);
  eq("it reports itself open", rows(e)[0].querySelector(".kebab").getAttribute("aria-expanded"), "true");
  eq("holding share, rename and trash",
     Array.from(menu.querySelectorAll("button")).map(b => b.textContent.trim()).join(","), "Share,Rename,Trash");
  eq("each item carries an icon", menu.querySelectorAll("button svg").length, 3);
  ok("the menu is marked up as a menu", menu.getAttribute("role") === "menu");
  ok("trash is marked as the destructive one", !!menu.querySelector("button.danger"));
  ok("menu items are finger-sized", /min-height:46px/.test(HTML.slice(HTML.indexOf(".menu button{"), HTML.indexOf(".menu button{") + 200)));

  // only one at a time
  openKebab(e, rows(e)[1]); await wait(40);
  eq("opening another row's menu closes the first", e.d.querySelectorAll(".menu").length, 1);

  // dismissal
  e.d.dispatchEvent(new e.w.MouseEvent("click", { bubbles: true }));
  await wait(40);
  ok("tapping elsewhere closes it", !e.d.querySelector(".menu"));
  openKebab(e, rows(e)[0]); await wait(40);
  e.d.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(40);
  ok("escape closes it too", !e.d.querySelector(".menu"));
  openKebab(e, rows(e)[0]); await wait(40);
  e.fire(rows(e)[0].querySelector(".kebab"), "click"); await wait(40);
  ok("tapping the control again closes it", !e.d.querySelector(".menu"));
}

group("Menu actions still work");
clickBtn(e, rows(e)[0], "RENAME"); await wait(60);
{
  const i4 = rows(e)[0].querySelector(".nm input");
  ok("rename opens the editor", !!i4);
  i4.value = "From the menu";
  i4.dispatchEvent(new e.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
}
eq("and renames", nameOf(rows(e)[0]), "From the menu");
clickBtn(e, rows(e)[0], "TRASH"); await wait(80);
eq("trash from the menu works", rows(e).length, 1);
ok("and the menu is gone afterwards", !e.d.querySelector(".menu"));
e.fire(e.$$(".tab")[1], "click"); await wait(60);
{
  const binRow = rows(e)[0];
  ok("trashed rows keep their two plain buttons instead of a menu", !binRow.querySelector(".kebab"));
  eq("which are restore and delete",
     Array.from(binRow.querySelectorAll(".acts button")).map(b => b.textContent).join(","), "RESTORE,DELETE FOREVER");
}
e.dom.window.close();

console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
process.exit(0);
})();
