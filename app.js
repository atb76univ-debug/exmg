"use strict";
const BUILD = "build 2026-10-26-e";
const $ = id => document.getElementById(id);
const C = ["low", "medium", "high"], L = { low: "低", medium: "中", high: "高" };
const FPS = 60, DELAY = 100;
const START_IDS = ["startCalibration", "startPractice", "startArmTrials", "startFreeMusic", "startFreeTrials"];

let db, stream, ctx, buffers = {}, cameraFps = "", prepared = false;
// 実行状態
let queue = [], pos = -1, active = null, running = false, recording = false, interrupted = false, endNote = "";
let rec = null, stopCurrent = () => { }, src = null, nodes = [], metroTimer = null;
let waitTimer = null, frameGuard = null, frameToken = 0, clock = null;

const say = x => { $("status").textContent = x };
const progress = x => { $("progress").textContent = x };
const esc = x => String(x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safe = x => String(x).replace(/[\\\/:*?"<>|\s]/g, "_");
const stamp = d => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
function shuffle(x) { const a = [...x]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
function liveCamera() { return !!stream && stream.getVideoTracks().some(t => t.readyState === "live") && $("preview").readyState >= 2 }
function sync() {
  START_IDS.forEach(i => $(i).disabled = running || !prepared);
  $("camera").disabled = running || !prepared;
  $("prepare").disabled = running;
  $("stopPlayback").disabled = !running;
}
$("build").textContent = BUILD;
window.addEventListener("error", e => say("エラー: " + e.message));
window.addEventListener("unhandledrejection", e => say("エラー: " + (e.reason?.message || e.reason)));

/* ---------- 割り当て欄 ---------- */
const slot = (id, label) => `<label>${label}<select id="${id}" class="source"></select></label>`;
$("trialSounds").innerHTML = C.map(c => [1, 2, 3].map(n => slot(`t-${c}${n}`, `${L[c]}複雑性 ${n}`)).join("")).join("");
$("practiceSounds").innerHTML = C.map(c => slot(`p-${c}`, `${L[c]}練習用`)).join("");

/* ---------- IndexedDB ---------- */
function openDb() {
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
const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) });
const store = (n, m = "readonly") => db.transaction(n, m).objectStore(n);
const allSounds = () => req(store("sounds").getAll()).then(x => x.sort((a, b) => a.name.localeCompare(b.name, "ja")));
const allRecords = () => req(store("records").getAll()).then(x => x.sort((a, b) => a.startedAt - b.startedAt));

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
    for (const v of f) await req(store("sounds", "readwrite").put({ id: crypto.randomUUID(), name: v.name, blob: v, createdAt: Date.now() }));
    $("soundImport").value = ""; await showLibrary(); say(`${f.length}曲を登録しました。`);
  } catch (e) { say("音源を保存できません: " + e.message) }
};
$("clearLibrary").onclick = async () => {
  if (!confirm("登録済みの音源ライブラリをすべて消去しますか？（動画記録は消去しません）")) return;
  await req(store("sounds", "readwrite").clear()); buffers = {}; prepared = false; sync();
  await showLibrary(); saveSettings(); say("音源ライブラリを消去しました。");
};
async function load(id) {
  if (!id) throw Error("音源が未選択です。");
  if (buffers[id]) return buffers[id];
  const x = await req(store("sounds").get(id));
  if (!x) throw Error("選択音源が見つかりません。");
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  return buffers[id] = { name: x.name, buffer: await ctx.decodeAudioData(await x.blob.arrayBuffer()) };
}
async function ensureLoaded(items) {
  for (const it of items) { if (it.category === "calibration") continue; it.name = (await load(it.id)).name }
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
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    say("音源を読み込んでいます…"); buffers = {};
    for (const id of new Set(ids)) await load(id);
    prepared = true; sync();
    progress("準備完了。カメラ・マイクを開始後、課題を選んでください。"); say("設定を確認しました。");
  } catch (e) { prepared = false; sync(); say("準備できません: " + e.message) }
};
$("camera").onclick = async () => {
  try {
    stream?.getTracks().forEach(x => x.stop());
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record" } catch { }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: FPS } },
      audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const v = $("preview"); v.srcObject = stream; v.style.display = "block"; $("previewText").hidden = true; await v.play();
    const fps = stream.getVideoTracks()[0].getSettings().frameRate;
    cameraFps = fps ? Math.round(fps) : "";
    say(fps && fps < FPS - 1 ? `注意：カメラは ${cameraFps} fps で動作しています（60 fps になりませんでした）。` : "カメラとマイクを開始しました。");
  } catch (e) { say("カメラまたはマイクを開始できません: " + e.message) }
};
async function preflight() {
  if (!liveCamera()) throw Error("カメラ映像を確認できません。カメラ・マイクを開始してください。");
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  if (ctx.state !== "running") throw Error("音声出力を有効にできません。iPadの消音モード・音量を確認してください。");
}

/* ---------- 試行の定義 ---------- */
const trialItem = (task, c, n) => ({ category: "trial", task, condition: c, number: n, id: $(`t-${c}${n}`).value, label: `${task}_${c}${n}` });
const practiceItem = c => ({ category: "practice", task: "腕振り", condition: c, id: $(`p-${c}`).value, label: `腕振り_practice-${c}` });
const armTrialItems = () => shuffle(C.flatMap(c => [1, 2, 3].map(n => trialItem("腕振り", c, n))));
const freeTrialItems = () => shuffle(C.flatMap(c => [1, 2, 3].map(n => trialItem("自由身体運動", c, n))));
function calibrationItems() {
  const bpm = Number($("bpm").value);
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
$("startCalibration").onclick = () => startSet(calibrationItems, "腕振り：キャリブレーション");
$("startPractice").onclick = () => startSet(() => C.map(practiceItem), "腕振り：練習3曲（低→中→高）");
$("startArmTrials").onclick = () => startSet(armTrialItems, "腕振り：本試行9曲");
$("startFreeMusic").onclick = () => startSet(realMusicItems, "自由運動：実音楽刺激");
$("startFreeTrials").onclick = () => startSet(freeTrialItems, "自由運動：本試行9曲");

/* ---------- セットの進行（コールバック連鎖） ---------- */
let setTitle = "";
async function startSet(build, title) {
  if (running || recording) return say("実行中です。完了または中断してから新しいセットを開始してください。");
  try {
    await preflight();
    const items = build();
    await ensureLoaded(items);
    queue = items; pos = -1; active = null; setTitle = title; interrupted = false; endNote = ""; running = true; sync();
    const lead = Math.max(0, Number($("leadIn").value) || 0);
    say(`${title}を開始します。`);
    countdown(lead, `${title}：1試行目の録画開始まで`, nextTrial);
  } catch (e) { say(e.message) }
}
function countdown(sec, label, done) {
  let left = sec;
  const tick = () => {
    waitTimer = null;
    if (interrupted) return;
    if (left <= 0) return done();
    progress(`${label}：あと ${left} 秒`); left--;
    waitTimer = setTimeout(tick, 1000);
  };
  tick();
}
function nextTrial() {
  if (interrupted) return;
  pos++;
  if (pos >= queue.length) return finishSet();
  active = { ...queue[pos], order: pos + 1 };
  beginRecording();
}
function finishSet() {
  clearTimeout(waitTimer); waitTimer = null; clearTimeout(frameGuard); frameToken++;
  running = false; sync();
  progress(`${setTitle}：` + (endNote || (interrupted ? "中断しました（ここまでの録画は保存済み）。" : "完了しました。休憩後、必要なら次のセットを開始してください。")));
  say(interrupted ? "中断しました。" : "課題セット完了。");
}
function fail(msg) {
  if (!running) return;
  interrupted = true; endNote = msg; frameToken++; clearTimeout(frameGuard); stopAudio();
  recording ? stopCurrent() : finishSet();
  say(msg);
}
$("stopPlayback").onclick = () => {
  if (!running) return;
  interrupted = true; frameToken++; clearTimeout(frameGuard); clearTimeout(waitTimer); waitTimer = null; stopAudio();
  if (recording) stopCurrent(); else finishSet();
  say("再生・録画を中断し、ここまでを保存します。");
};

/* ---------- 録画 ---------- */
function showRec(on, started) {
  clearInterval(clock); $("rec").hidden = !on;
  if (!on) return;
  const upd = () => { const s = Math.floor((Date.now() - started) / 1000); $("time").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0") };
  upd(); clock = setInterval(upd, 250);
}
function beginRecording() {
  const item = active, started = new Date(), chunks = [], tag = `試行 ${pos + 1}/${queue.length}`;
  const participant = $("participant").value.trim(), experimenter = $("experimenter").value.trim();
  try {
    const mime = ["video/mp4", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5000000 } : { videoBitsPerSecond: 5000000 });
    rec = r;
    let handled = false;
    const finished = () => {                       // onstop が来ない場合に備え、必ず1回だけ実行
      if (handled) return; handled = true;
      recording = false;
      onRecorded({ item, order: pos + 1, started, chunks, type: r.mimeType || mime || "video/mp4", participant, experimenter });
    };
    r.ondataavailable = e => { if (e.data.size) chunks.push(e.data) };
    r.onerror = e => fail("録画エラー: " + (e.error?.message || "不明"));
    r.onstop = finished;
    stopCurrent = () => { try { if (r.state === "recording") r.stop() } catch { } setTimeout(finished, 4000) };
    r.start(1000);
    recording = true; showRec(true, started); cue();
    progress(`${tag}：録画開始。${DELAY}フレーム後に再生します。`);
    waitFrames(DELAY, () => item.category === "calibration" ? playMetronome(item, tag) : playStimulus(item, tag))
  } catch (e) { recording = false; showRec(false); fail("録画を開始できません: " + e.message) }
}
function waitFrames(n, cb) {
  const token = ++frameToken, v = $("preview");
  const arm = () => { clearTimeout(frameGuard); frameGuard = setTimeout(() => { if (token === frameToken) fail("カメラフレームが停止したため録画を中止しました。") }, 8000) };
  arm();
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return void setTimeout(() => { if (token === frameToken) { clearTimeout(frameGuard); cb() } }, n / FPS * 1000);
  let i = 0;
  const f = () => v.requestVideoFrameCallback(() => {
    if (token !== frameToken) return;
    if (!liveCamera()) return fail("カメラ映像が停止しました。");
    arm();
    if (++i >= n) { clearTimeout(frameGuard); cb() } else f();
  });
  f();
}

/* ---------- 音 ---------- */
function stopAudio() {
  clearTimeout(metroTimer); metroTimer = null;
  if (src) { src.onended = null; try { src.stop() } catch { } src = null }
  nodes.forEach(o => { try { o.stop() } catch { } }); nodes = [];
}
function cue() {
  try {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.frequency.value = 1800;
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.3, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + .15);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .16);
  } catch (e) { console.warn(e) }
}
function playStimulus(item, tag) {
  try {
    const s = ctx.createBufferSource(); s.buffer = buffers[item.id].buffer;
    const g = ctx.createGain(); g.gain.value = .95; s.connect(g); g.connect(ctx.destination);
    s.onended = () => { src = null; if (recording) stopCurrent() };
    src = s; s.start();
    progress(`${tag}：再生中 ${item.name}`);
  } catch (e) { fail("音源を再生できません: " + e.message) }
}
function playMetronome(item, tag) {   // 録画開始から100フレーム目に開始
  progress(`${tag}：メトロノーム再生中（${item.bpm} BPM）`);
  const step = 60 / item.bpm, first = ctx.currentTime + .08;
  for (let b = 0; b < item.beats; b++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = first + b * step;
    o.frequency.value = b % 4 ? 880 : 1320;
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.25, t + .003); g.gain.exponentialRampToValueAtTime(.0001, t + .07);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .08); nodes.push(o);
  }
  metroTimer = setTimeout(() => { if (recording) stopCurrent() }, (first - ctx.currentTime + item.beats * step + .3) * 1000);
}

/* ---------- 保存 → 休憩 → 次へ ---------- */
async function onRecorded(s) {
  showRec(false); stopAudio(); clearTimeout(frameGuard);
  progress(`試行 ${s.order}/${queue.length}：保存しています…`);
  try { await saveRecord(s) } catch (e) { endNote = "保存に失敗したため中止しました。"; interrupted = true; say(e.message); return finishSet() }
  if (interrupted || pos >= queue.length - 1) return finishSet();
  const rest = Math.max(0, Number($("rest").value) || 0);
  countdown(rest, `試行 ${s.order}/${queue.length} を保存しました。次の試行まで休憩`, nextTrial);
}
async function saveRecord(s) {
  const { item } = s, end = new Date(), mime = (s.type || "video/mp4").split(";")[0];
  const ext = mime.includes("webm") ? "webm" : "mp4", p = s.participant;
  const name = `${safe(p)}_${safe(item.label)}_${stamp(s.started)}`;
  const meta = {
    category: item.category, presentation_order: s.order, experimenter_id: s.experimenter, participant_id: p, task: item.task,
    condition: item.condition || "", stimulus_id: item.id || "", stimulus_file: item.name || "", calibration_bpm: item.bpm || "",
    started_at: s.started.toISOString(), finished_at: end.toISOString(), audio_start_frame_offset: DELAY,
    camera_frame_rate: cameraFps, recording_includes_microphone_audio: true, recording_includes_stimulus_audio: false,
    interrupted: !!interrupted, archive_note: "", video_file: `${name}.${ext}`
  };
  try {
    await req(store("records", "readwrite").put({ id: crypto.randomUUID(), name, startedAt: +s.started, type: mime, video: new Blob(s.chunks, { type: mime }), metadata: meta }));
  } catch (e) { throw Error("iPad内へ保存できません: " + e.message) }
  await renderArchive().catch(() => { });
  say(`保存しました：${item.category} / ${item.name}`);
}

/* ---------- 記録一覧・書き出し ---------- */
const CSV_FIELDS = ["category", "presentation_order", "experimenter_id", "participant_id", "task", "condition", "stimulus_id", "stimulus_file", "calibration_bpm", "started_at", "finished_at", "audio_start_frame_offset", "camera_frame_rate", "recording_includes_microphone_audio", "recording_includes_stimulus_audio", "interrupted", "archive_note", "video_file"];
const csv = a => "\ufeff" + [CSV_FIELDS.join(","), ...a.map(r => CSV_FIELDS.map(k => `"${String(r.metadata[k] ?? "").replaceAll('"', '""')}"`).join(","))].join("\r\n");
async function renderArchive() {
  const data = await allRecords(), people = [...new Set(data.map(r => r.metadata.participant_id))].sort(), sel = $("exportParticipant"), old = sel.value;
  sel.innerHTML = people.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if (people.includes(old)) sel.value = old;
  $("export").disabled = !people.length;
  const box = $("archive"); box.innerHTML = data.length ? "" : '<p class="muted">保存済みデータはありません。</p>';
  data.forEach(row => {
    const item = document.createElement("div"); item.className = "row";
    item.innerHTML = `<b>${esc(row.name)}</b>${row.metadata.interrupted ? "（中断）" : ""}<br><span class="muted">${esc(row.metadata.participant_id)} / ${esc(row.metadata.category)} / ${esc(row.metadata.stimulus_file)}${row.metadata.archive_note ? " / メモ: " + esc(row.metadata.archive_note) : ""}</span><br>`;
    const edit = document.createElement("button"); edit.textContent = "メモを更新";
    edit.onclick = async () => { const n = prompt("アーカイブメモ", row.metadata.archive_note || ""); if (n !== null) { row.metadata.archive_note = n; await req(store("records", "readwrite").put(row)); renderArchive() } };
    const del = document.createElement("button"); del.textContent = "削除"; del.className = "danger";
    del.onclick = async () => { if (confirm(`${row.name} を削除しますか？`)) { await req(store("records", "readwrite").delete(row.id)); renderArchive() } };
    item.append(edit, del); box.append(item);
  });
}
const u16 = n => [n & 255, (n >>> 8) & 255], u32 = n => [...u16(n), ...u16(n >>> 16)];
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })();
function crc(a) { let c = 0xffffffff; for (const b of a) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
async function zip(files) {    // 無圧縮ZIP。ファイル名はUTF-8（フラグ bit11）
  const enc = new TextEncoder(), parts = [], dir = []; let offset = 0;
  const DATE = [33, 0];
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
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------- 設定の保存・復元（アプリを閉じても選択を保持） ---------- */
const SETTINGS_KEY = "groove-settings-v1";
const settingEls = () => [...document.querySelectorAll("main input[id], main select[id]")].filter(e => e.type !== "file" && e.id !== "exportParticipant");
function saveSettings() {
  try {
    const o = {};
    settingEls().forEach(e => { o[e.id] = e.type === "checkbox" ? e.checked : e.multiple ? [...e.selectedOptions].map(x => x.value) : e.value });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
  } catch { }
}
function restoreSettings() {
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    settingEls().forEach(e => {
      if (!(e.id in o)) return;
      if (e.type === "checkbox") e.checked = !!o[e.id];
      else if (e.multiple) [...e.options].forEach(x => x.selected = o[e.id].includes(x.value));
      else if (e.tagName === "SELECT") { if ([...e.options].some(x => x.value === o[e.id])) e.value = o[e.id] }
      else e.value = o[e.id];
    });
  } catch { }
}
document.addEventListener("input", saveSettings);
document.addEventListener("change", saveSettings);

/* ---------- 起動 ---------- */
sync();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").then(r => r.update()).catch(() => { });
openDb().then(async x => { db = x; await showLibrary(); restoreSettings(); await renderArchive() }).catch(e => say("iPad内ストレージを開けません: " + e.message));
