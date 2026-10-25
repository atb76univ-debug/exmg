"use strict";
const $ = id => document.getElementById(id);
const C = ["low", "medium", "high"], L = { low: "低", medium: "中", high: "高" };
const FPS = 60, DELAY = 100;           // 録画開始から100フレーム目で音源を再生
const START_IDS = ["startCalibration", "startPractice", "startArmTrials", "startFreeMusic", "startFreeTrials"];

let db, stream, mixed, ctx, buffers = {}, cameraFps = "";
let prepared = false, busy = false, aborted = false;
let recorder = null, src = null, nodes = [], clock = null;
const cancelers = new Set();           // 中断時に待機中の Promise を解除するための関数集合

/* ---------- 小物 ---------- */
const say = x => { $("status").textContent = x };
const progress = x => { $("progress").textContent = x };
const esc = x => String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safe = x => String(x).replace(/[\\\/:*?"<>|\s]/g, "_");     // 日本語は残す
const stamp = d => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
function shuffle(x) { const a = [...x]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
function live() { return !!stream && stream.getVideoTracks().some(t => t.readyState === "live") && $("preview").readyState >= 2 }
function waitFor(setup) {                // setup(done) を呼ぶと完了。中断でも完了扱いになる
  return new Promise(res => { const done = () => { cancelers.delete(done); res() }; cancelers.add(done); setup(done) });
}
const sleep = ms => waitFor(done => setTimeout(done, ms));
function sync() {
  START_IDS.forEach(i => $(i).disabled = busy || !prepared);
  $("camera").disabled = busy || !prepared;
  $("prepare").disabled = busy;
  $("stopPlayback").disabled = !busy;
}

/* ---------- 割り当て欄 ---------- */
const slot = (id, label) => `<label>${label}<select id="${id}" class="source"></select></label>`;
$("trialSounds").innerHTML = C.map(c => [1, 2, 3].map(n => slot(`t-${c}${n}`, `${L[c]}複雑性 ${n}`)).join("")).join("");
$("practiceSounds").innerHTML = C.map(c => slot(`p-${c}`, `${L[c]}練習用`)).join("");

/* ---------- IndexedDB ---------- */
function dbopen() {
  return new Promise((ok, no) => {
    const r = indexedDB.open("groove-calibration-archive", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("records")) d.createObjectStore("records", { keyPath: "id" });
      if (!d.objectStoreNames.contains("sounds")) d.createObjectStore("sounds", { keyPath: "id" });
    };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
const store = (n, m = "readonly") => db.transaction(n, m).objectStore(n);
const get = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) });
const allSounds = () => get(store("sounds").getAll()).then(x => x.sort((a, b) => a.name.localeCompare(b.name, "ja")));
const allRecords = () => get(store("records").getAll()).then(x => x.sort((a, b) => a.startedAt - b.startedAt));

/* ---------- 音源ライブラリ ---------- */
async function showLibrary() {
  const x = await allSounds(), old = {};
  document.querySelectorAll(".source,#participantMusic,#experimenterMusic,#createdMusic").forEach(s => old[s.id] = [...s.selectedOptions].map(o => o.value));
  const opt = x.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join("");
  const restore = s => old[s.id]?.forEach(id => { const v = [...s.options].find(q => q.value === id); if (v) v.selected = true });
  document.querySelectorAll(".source,#participantMusic,#experimenterMusic").forEach(s => { s.innerHTML = `<option value="">選択してください</option>${opt}`; restore(s) });
  $("createdMusic").innerHTML = opt; restore($("createdMusic"));
  $("libraryStatus").textContent = `登録済み: ${x.length} 曲`;
  $("library").innerHTML = x.map(v => `<div class="row">${esc(v.name)}</div>`).join("") || '<p class="muted">まだ音源は登録されていません。</p>';
}
$("importSounds").onclick = async () => {
  const f = [...$("soundImport").files];
  if (!f.length) return say("登録する音源を選択してください。");
  try {
    for (const v of f) await get(store("sounds", "readwrite").put({ id: crypto.randomUUID(), name: v.name, blob: v, createdAt: Date.now() }));
    $("soundImport").value = ""; await showLibrary(); say(`${f.length}曲を登録しました。`);
  } catch (e) { say("音源を保存できません: " + e.message) }
};
$("clearLibrary").onclick = async () => {
  if (!confirm("登録済みの音源ライブラリをすべて消去しますか？（動画記録は消去しません）")) return;
  await get(store("sounds", "readwrite").clear()); buffers = {}; prepared = false; sync();
  await showLibrary(); say("音源ライブラリを消去しました。");
};
async function load(id) {
  if (!id) throw Error("音源が未選択です。");
  if (buffers[id]) return buffers[id];
  const x = await get(store("sounds").get(id));
  if (!x) throw Error("選択音源が見つかりません。");
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  return buffers[id] = { name: x.name, buffer: await ctx.decodeAudioData(await x.blob.arrayBuffer()) };
}
async function ensureLoaded(items) {
  for (const it of items) { if (it.category === "calibration") continue; const b = await load(it.id); it.name = b.name }
}

/* ---------- 準備・カメラ ---------- */
$("prepare").onclick = async () => {
  try {
    if (!$("experimenter").value.trim() || !$("participant").value.trim()) throw Error("実験者IDと参加者IDを入力してください。");
    const ids = [];
    for (const c of C) for (let n = 1; n < 4; n++) ids.push($(`t-${c}${n}`).value);
    for (const c of C) ids.push($(`p-${c}`).value);
    if (ids.some(x => !x)) throw Error("本試行9曲と練習用3曲をすべて割り当ててください。");
    if ($("useParticipantMusic").checked) ids.push($("participantMusic").value);
    if ($("useExperimenterMusic").checked) ids.push($("experimenterMusic").value);
    if ($("useCreatedMusic").checked) ids.push(...[...$("createdMusic").selectedOptions].map(x => x.value));
    if (ids.some(x => !x)) throw Error("再生する実音楽刺激をすべて割り当ててください。");
    say("音源を読み込んでいます…"); buffers = {};
    for (const id of new Set(ids)) await load(id);
    prepared = true; sync();
    progress("準備完了。カメラ・マイクを開始後、課題を選んでください。"); say("設定を確認しました。");
  } catch (e) { prepared = false; sync(); say("準備できません: " + e.message) }
};
$("camera").onclick = async () => {
  try {
    stream?.getTracks().forEach(x => x.stop());
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: FPS } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    mixed = new MediaStream([...stream.getVideoTracks(), ...stream.getAudioTracks()]);
    const v = $("preview"); v.srcObject = stream; v.style.display = "block"; $("previewText").hidden = true; await v.play();
    const fps = stream.getVideoTracks()[0].getSettings().frameRate;
    cameraFps = fps ? Math.round(fps) : "";
    say(fps && fps < FPS - 1 ? `注意：カメラは ${cameraFps} fps で動作しています（60 fps になりませんでした）。` : "60fpsカメラとiPadマイクを開始しました。録画にはマイクで拾った音のみを保存します。");
  } catch (e) { say("カメラまたはマイクを開始できません: " + e.message) }
};
async function ready() {
  if (!live()) throw Error("カメラ映像を確認できません。カメラ・マイクを開始してください。");
  await ctx.resume();
  if (ctx.state !== "running") throw Error("音声出力を有効にできません。");
}

/* ---------- 試行の定義 ---------- */
const trialItem = (task, c, n) => ({ category: "trial", task, condition: c, number: n, id: $(`t-${c}${n}`).value, label: `${task}_${c}${n}` });
const practiceItem = c => ({ category: "practice", task: "腕振り", condition: c, id: $(`p-${c}`).value, label: `腕振り_practice-${c}` });
const armTrialItems = () => shuffle(C.flatMap(c => [1, 2, 3].map(n => trialItem("腕振り", c, n))));
const freeTrialItems = () => shuffle(C.flatMap(c => [1, 2, 3].map(n => trialItem("自由身体運動", c, n))));
function calibrationItems() {
  const bpm = +$("bpm").value;
  if (!(bpm >= 30 && bpm <= 240)) throw Error("BPMは30〜240で設定してください。");
  return [{ category: "calibration", task: "腕振り", bpm, beats: 32, name: "metronome", label: "calibration" }];
}
function realMusicItems() {
  const a = [], m = (cat, id) => ({ category: cat, task: "自由身体運動", id, label: `自由身体運動_${cat}` });
  if ($("useParticipantMusic").checked) a.push(m("real_music_participant", $("participantMusic").value));
  if ($("useExperimenterMusic").checked) a.push(m("real_music_experimenter", $("experimenterMusic").value));
  if ($("useCreatedMusic").checked) a.push(...shuffle([...$("createdMusic").selectedOptions].map(o => m("real_music_created", o.value))));
  if (!a.length) throw Error("再生する実音楽刺激を選択してください。");
  return a;
}
$("startCalibration").onclick = () => runSet(calibrationItems, "腕振り：キャリブレーション");
$("startPractice").onclick = () => runSet(() => C.map(practiceItem), "腕振り：練習3曲（低→中→高）");
$("startArmTrials").onclick = () => runSet(armTrialItems, "腕振り：本試行9曲");
$("startFreeMusic").onclick = () => runSet(realMusicItems, "自由運動：実音楽刺激");
$("startFreeTrials").onclick = () => runSet(freeTrialItems, "自由運動：本試行9曲");

/* ---------- セット実行 ---------- */
async function countdown(sec, label) {
  for (let s = sec; s > 0 && !aborted; s--) { progress(`${label}：あと ${s} 秒`); await sleep(1000) }
}
async function runSet(build, title) {
  if (busy) return say("実行中です。完了または中断してから新しいセットを開始してください。");
  let items;
  try { await ready(); items = build(); await ensureLoaded(items) } catch (e) { return say(e.message) }
  busy = true; aborted = false; sync();
  const rest = Math.max(0, Number($("rest").value) || 0), lead = Math.max(0, Number($("leadIn").value) || 0);
  try {
    if (lead) { say(`${title}：1試行目の録画開始まで待機します。`); await countdown(lead, `${title} 1試行目の録画開始まで`) }
    for (let i = 0; i < items.length && !aborted; i++) {
      await runTrial(items[i], i + 1, items.length, title);
      if (!aborted && i < items.length - 1 && rest) await countdown(rest, `${title} 試行 ${i + 1}/${items.length} を保存しました。次の試行まで休憩`);
    }
    progress(aborted ? `${title}：中断しました（ここまでの録画は保存済み）。` : `${title}：完了しました。休憩後、必要なら次のセットを開始してください。`);
    say(aborted ? "中断しました。" : "課題セット完了。");
  } catch (e) { progress(`${title}：エラーのため中止しました。`); say(e.message) }
  finally { busy = false; aborted = false; sync() }
}
function abortAll() {
  aborted = true;
  [...cancelers].forEach(f => f());
  stopAudio();
  if (recorder?.state === "recording") try { recorder.stop() } catch { }
}
$("stopPlayback").onclick = () => { if (!busy) return; abortAll(); say("再生・録画を中断し、ここまでを保存します。") };

/* ---------- 1試行 ---------- */
function makeRecorder() {
  const type = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
  const opt = { videoBitsPerSecond: 5000000 }; if (type) opt.mimeType = type;
  return new MediaRecorder(mixed, opt);
}
function showRec(on, started) {
  clearInterval(clock); $("rec").hidden = !on;
  if (!on) return;
  const upd = () => { const s = Math.floor((Date.now() - started) / 1000); $("time").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0") };
  upd(); clock = setInterval(upd, 250);
}
async function runTrial(item, order, total, title) {
  const tag = `${title} 試行 ${order}/${total}`;
  const rec = makeRecorder(), chunks = [], started = new Date();
  const participant = $("participant").value.trim(), experimenter = $("experimenter").value.trim();
  const stopped = new Promise(res => { rec.onstop = res });
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) };
  recorder = rec; rec.start(1000); showRec(true, started); cue();
  let err = null;
  try {
    if (item.category === "calibration") { progress(`${tag}：録画中。メトロノーム再生中`); await playMetronome(item) }
    else {
      progress(`${tag}：録画開始。${DELAY}フレーム後に再生します。`);
      await frames(DELAY);
      if (!aborted) { progress(`${tag}：再生中 ${item.name}`); await playBuffer(item) }
    }
  } catch (e) { err = e; aborted = true }
  stopAudio();
  if (rec.state === "recording") try { rec.stop() } catch { }
  await Promise.race([stopped, sleep(5000)]);
  recorder = null; showRec(false);
  progress(`${tag}：保存しています…`);
  await save({ item, order, started, chunks, type: rec.mimeType, interrupted: aborted, participant, experimenter });
  if (err) throw err;
}
function frames(n) {            // 実カメラフレームを n 枚数える
  return new Promise((res, rej) => {
    let i = 0, stall, dead = false;
    const fin = (f, v) => { if (dead) return; dead = true; clearTimeout(stall); cancelers.delete(cancel); f(v) };
    const cancel = () => fin(res);
    cancelers.add(cancel);
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => fin(rej, Error("カメラフレームが停止したため録画を中止しました。")), 5000) };
    arm();
    const v = $("preview");
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return void setTimeout(() => fin(res), n / FPS * 1000);
    const f = () => v.requestVideoFrameCallback(() => {
      if (dead) return;
      if (!live()) return fin(rej, Error("カメラ映像が停止しました。"));
      arm(); ++i >= n ? fin(res) : f();
    });
    f();
  });
}

/* ---------- 音 ---------- */
function stopAudio() {
  if (src) { src.onended = null; try { src.stop() } catch { } src = null }
  nodes.forEach(o => { try { o.stop() } catch { } }); nodes = [];
}
function cue() {
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
  o.frequency.value = 1800;
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.3, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + .15);
  o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .16);
}
function playBuffer(item) {
  return waitFor(done => {
    const s = ctx.createBufferSource(); s.buffer = buffers[item.id].buffer; s.connect(ctx.destination);
    s.onended = done; src = s; s.start();
  });
}
function playMetronome(item) {   // 合図音の直後に開始（待機フレームなし）
  const step = 60 / item.bpm, first = ctx.currentTime + .4;
  for (let b = 0; b < item.beats; b++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = first + b * step;
    o.frequency.value = b % 4 ? 880 : 1320;
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.25, t + .003); g.gain.exponentialRampToValueAtTime(.0001, t + .07);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .08); nodes.push(o);
  }
  const ms = (first - ctx.currentTime + item.beats * step + .3) * 1000;
  return waitFor(done => setTimeout(done, ms));
}

/* ---------- 保存 ---------- */
async function save(s) {
  const { item } = s, end = new Date(), mime = (s.type || "video/mp4").split(";")[0];
  const ext = mime.includes("webm") ? "webm" : "mp4", p = s.participant;
  const name = `${safe(p)}_${safe(item.label)}_${stamp(s.started)}`;
  const meta = {
    category: item.category, presentation_order: s.order, experimenter_id: s.experimenter, participant_id: p, task: item.task,
    condition: item.condition || "", stimulus_id: item.id || "", stimulus_file: item.name, calibration_bpm: item.bpm || "",
    started_at: s.started.toISOString(), finished_at: end.toISOString(), audio_start_frame_offset: DELAY,
    camera_frame_rate: cameraFps, recording_includes_microphone_audio: true, recording_includes_stimulus_audio: false,
    interrupted: !!s.interrupted, video_file: `${name}.${ext}`
  };
  try {
    await get(store("records", "readwrite").put({ id: crypto.randomUUID(), name, startedAt: +s.started, type: mime, video: new Blob(s.chunks, { type: mime }), metadata: meta }));
    await renderArchive(); say(`保存しました：${item.category} / ${item.name}`);
  } catch (e) { throw Error("iPad内へ保存できません: " + e.message) }
}

/* ---------- 記録一覧・書き出し ---------- */
const CSV_FIELDS = ["category", "presentation_order", "experimenter_id", "participant_id", "task", "condition", "stimulus_id", "stimulus_file", "calibration_bpm", "started_at", "finished_at", "audio_start_frame_offset", "camera_frame_rate", "recording_includes_microphone_audio", "recording_includes_stimulus_audio", "interrupted", "video_file"];
const csv = a => "\ufeff" + [CSV_FIELDS.join(","), ...a.map(r => CSV_FIELDS.map(k => `"${String(r.metadata[k] ?? "").replaceAll('"', '""')}"`).join(","))].join("\r\n");
function dl(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000) }
async function renderArchive() {
  const data = await allRecords(), people = [...new Set(data.map(r => r.metadata.participant_id))].sort(), sel = $("exportParticipant"), old = sel.value;
  sel.innerHTML = people.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if (people.includes(old)) sel.value = old;
  $("export").disabled = !people.length;
  const box = $("archive"); box.innerHTML = data.length ? "" : '<p class="muted">保存済みデータはありません。</p>';
  data.forEach(row => {
    const item = document.createElement("div"); item.className = "row";
    item.innerHTML = `<b>${esc(row.name)}</b>${row.metadata.interrupted ? "（中断）" : ""}<br><span class="muted">${esc(row.metadata.participant_id)} / ${esc(row.metadata.category)} / ${esc(row.metadata.stimulus_file)}</span>`;
    const del = document.createElement("button"); del.textContent = "削除"; del.className = "danger";
    del.onclick = async () => { if (confirm(`${row.name} を削除しますか？`)) { await get(store("records", "readwrite").delete(row.id)); renderArchive() } };
    item.append(del); box.append(item);
  });
}
const u16 = n => [n & 255, (n >>> 8) & 255], u32 = n => [...u16(n), ...u16(n >>> 16)];
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
function crc(a) { let c = 0xffffffff; for (const b of a) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
async function zip(files) {    // 無圧縮ZIP。ファイル名はUTF-8（フラグ bit11）
  const enc = new TextEncoder(), parts = [], dir = []; let offset = 0;
  const DATE = [33, 0];        // 1980-01-01
  for (const f of files) {
    const name = enc.encode(f.name), data = new Uint8Array(await f.blob.arrayBuffer()), sum = crc(data);
    const local = new Uint8Array([80, 75, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, ...DATE, ...u32(sum), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, ...name]);
    const central = new Uint8Array([80, 75, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, ...DATE, ...u32(sum), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset), ...name]);
    parts.push(local, data); dir.push(central); offset += local.length + data.length;
  }
  const size = dir.reduce((n, x) => n + x.length, 0);
  return new Blob([...parts, ...dir, new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, ...u16(dir.length), ...u16(dir.length), ...u32(size), ...u32(offset), 0, 0])], { type: "application/zip" });
}
$("export").onclick = async () => {
  const participant = $("exportParticipant").value, data = (await allRecords()).filter(r => r.metadata.participant_id === participant);
  if (!data.length) return say("選択した参加者のデータはありません。");
  const files = data.map(r => ({ name: r.metadata.video_file, blob: r.video }));
  files.push({ name: `${safe(participant)}_metadata.csv`, blob: new Blob([csv(data)], { type: "text/csv;charset=utf-8" }) });
  const file = new File([await zip(files)], `${safe(participant)}_groove_experiment.zip`, { type: "application/zip" });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ title: `${participant} Groove Experiment`, files: [file] }); return } }
  catch (e) { if (e.name === "AbortError") return }
  dl(file, file.name);
};

/* ---------- 起動 ---------- */
sync();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => { });
dbopen().then(async x => { db = x; await showLibrary(); await renderArchive() }).catch(e => say("iPad内ストレージを開けません: " + e.message));
