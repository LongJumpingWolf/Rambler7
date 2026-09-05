const fs = require("fs");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { Blob: NodeBlob, File: NodeFile } = require("buffer");

const HTML = fs.readFileSync(__dirname + "/../index.html", "utf8");

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
  const state = { granted: opts.granted !== false, chunkBytes: 4000, tracksStopped: 0, recorders: [], downloads: [], shared: [], vibrations: [] };

  class FakeMediaRecorder {
    constructor(stream, cfg) {
      this.stream = stream; this.cfg = cfg || {}; this.state = "inactive";
      this.n = 0; state.recorders.push(this);
    }
    static isTypeSupported(t) { return t.indexOf("webm") > -1; }
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

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://local.test/",
    beforeParse(w) {
      w.indexedDB = idb || undefined;
      w.Blob = NodeBlob; w.File = NodeFile;
      w.MediaRecorder = FakeMediaRecorder;
      w.AudioContext = class {
        constructor() { this.state = "running"; this.sampleRate = 48000; }
        resume() {}
        createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(a) { a.fill(128); } }; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
        createBufferSource() { return { connect() {}, start() {} }; }
        createBiquadFilter() { return { frequency: {}, Q: {}, connect() {} }; }
        createGain() { return { gain: {}, connect() {} }; }
      };
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
      w.URL.createObjectURL = () => "blob:fake"; w.URL.revokeObjectURL = () => {};
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () {};
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
const clickBtn = (env, row, label) => {
  const b = Array.from(row.querySelectorAll(".acts button")).find(x => x.textContent === label);
  if (!b) throw new Error("button not found: " + label);
  env.fire(b, "click"); return b;
};

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
  eq("no audio bytes were dropped", all[0].buf.byteLength, expected);
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
clickBtn(e, rows(e)[1], "DOWNLOAD"); await wait(30);
eq("download uses a safe filename", e.state.downloads[0], "Standup_notes.webm");
e.w.navigator.canShare = () => false;
clickBtn(e, rows(e)[1], "SHARE"); await wait(30);
eq("share falls back to a download when the sharesheet is unavailable", e.state.downloads.length, 2);
e.w.navigator.canShare = () => true;
let sharedWith = null;
e.w.navigator.share = o => { sharedWith = o; return Promise.resolve(); };
clickBtn(e, rows(e)[1], "SHARE"); await wait(30);
ok("share hands a real audio file to the sharesheet", !!sharedWith && sharedWith.files && sharedWith.files[0].name === "Standup_notes.webm");
eq("share did not also trigger a download", e.state.downloads.length, 2);
e.w.navigator.share = () => { const err = new Error("x"); err.name = "AbortError"; return Promise.reject(err); };
clickBtn(e, rows(e)[1], "SHARE"); await wait(40);
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
e.fire(e.$("#scrap"), "click"); await wait(120);
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
  eq("every recorded byte was recovered", all[0].buf.byteLength, written);
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

console.log("\n" + "=".repeat(52));
console.log((fail ? "\x1b[31m" : "\x1b[32m") + pass + " passed, " + fail + " failed\x1b[0m");
if (fail) { console.log("failed:\n - " + fails.join("\n - ")); process.exit(1); }
process.exit(0);
})();
