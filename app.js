const $ = (id) => document.getElementById(id);
const CONDITIONS = ["low", "medium", "high"];
const LABELS = { low: "低", medium: "中", high: "高" };

let database;
let stream;
let recorder;
let audioContext;
let audioBuffers = {};
let trials = [];
let trialIndex = -1;
let currentTrial;
let chunks = [];
let trialStartedAt;
let elapsedTimer;

function setStatus(text) { $("status").textContent = text; }
function safeName(text) { return text.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function timestamp(date) { return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z"); }

function createSoundInputs() {
  $("soundInputs").innerHTML = CONDITIONS.map((condition) =>
    [1, 2, 3].map((number) =>
      `<label>${LABELS[condition]}複雑性 ${number}<input id="${condition}${number}" type="file"></label>`
    ).join("")
  ).join("");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("groove-experiment-archive", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRecord(record) {
  return new Promise((resolve, reject) => {
    const request = database.transaction("records", "readwrite").objectStore("records").put(record);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function getRecords() {
  return new Promise((resolve, reject) => {
    const request = database.transaction("records").objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.startedAt - b.startedAt));
    request.onerror = () => reject(request.error);
  });
}

function deleteRecord(id) {
  return new Promise((resolve, reject) => {
    const request = database.transaction("records", "readwrite").objectStore("records").delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

async function prepareExperiment() {
  const experimenter = $("experimenter").value.trim();
  const participant = $("participant").value.trim();
  const files = {};
  for (const condition of CONDITIONS) for (let number = 1; number <= 3; number += 1) files[`${condition}${number}`] = $(`${condition}${number}`).files[0];
  if (!experimenter || !participant) return setStatus("実験者IDと参加者IDを入力してください。");
  if (Object.values(files).some((file) => !file)) return setStatus("低・中・高を各3つ、計9音源すべてを選択してください。");
  try {
    audioContext ??= new AudioContext();
    audioBuffers = {};
    setStatus("9音源を読み込み、再生可能か確認しています…");
    for (const [key, file] of Object.entries(files)) {
      audioBuffers[key] = { buffer: await audioContext.decodeAudioData(await file.arrayBuffer()), name: file.name };
    }
  } catch (error) {
    return setStatus(`音源を読み込めません。MP3/M4A/WAVをファイルアプリから選択してください: ${error.message}`);
  }
  const taskOrder = $("taskOrder").value === "arm-first" ? ["腕振り", "自由身体運動"] : ["自由身体運動", "腕振り"];
  trials = [];
  taskOrder.forEach((task) => {
    const block = [];
    CONDITIONS.forEach((condition) => { for (let number = 1; number <= 3; number += 1) block.push({ task, condition, stimulusId: `${condition}${number}`, stimulusFile: audioBuffers[`${condition}${number}`].name }); });
    block.sort(() => Math.random() - 0.5);
    trials.push(...block);
  });
  trialIndex = -1;
  $("cameraButton").disabled = false;
  $("trialInfo").textContent = `18試行を作成しました。最初の課題は${taskOrder[0]}です。`;
  setStatus("9音源を確認しました。カメラ・マイクを開始してください。");
}

async function startCamera() {
  try {
    stream?.getTracks().forEach((track) => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    $("preview").srcObject = stream;
    $("preview").style.display = "block";
    $("previewMessage").hidden = true;
    $("startButton").disabled = false;
    setStatus("カメラとマイクを開始しました。実験を開始できます。");
  } catch (error) {
    setStatus(`カメラまたはマイクを開始できません: ${error.message}`);
  }
}

async function startExperiment() {
  try {
    await audioContext.resume();
    if (audioContext.state !== "running") throw new Error("音声出力を有効にできませんでした。");
    advanceTrial();
  } catch (error) { setStatus(`音源出力を開始できません: ${error.message}`); }
}

function advanceTrial() {
  trialIndex += 1;
  if (trialIndex >= trials.length) { $("trialInfo").textContent = "全18試行が完了しました。一括保存してください。"; return setStatus("実験完了です。"); }
  const previous = trials[trialIndex - 1];
  if (previous && previous.task !== trials[trialIndex].task) {
    trialIndex -= 1;
    $("nextBlockButton").disabled = false;
    $("nextBlockButton").textContent = `「${trials[trialIndex + 1].task}」ブロックを開始`;
    $("trialInfo").textContent = `${previous.task}ブロックが終了しました。`;
    return setStatus("課題ブロック間です。次のブロックを手動で開始してください。");
  }
  currentTrial = trials[trialIndex];
  startTrialRecording();
}

function startNextBlock() {
  $("nextBlockButton").disabled = true;
  trialIndex += 1;
  if (trialIndex >= trials.length) return;
  currentTrial = trials[trialIndex];
  startTrialRecording();
}

function startTrialRecording() {
  chunks = [];
  trialStartedAt = new Date();
  const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
  try { recorder = mimeType ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 }) : new MediaRecorder(stream); }
  catch (error) { return setStatus(`録画を開始できません: ${error.message}`); }
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = (event) => setStatus(`録画エラー: ${event.error?.message || "不明なエラー"}`);
  recorder.onstop = saveTrial;
  recorder.start(1000);
  if (recorder.state !== "recording") return setStatus("録画を開始できませんでした。");
  $("recordingBadge").hidden = false;
  elapsedTimer = setInterval(() => { const seconds = Math.floor((Date.now() - trialStartedAt) / 1000); $("elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }, 250);
  $("trialInfo").textContent = `試行 ${trialIndex + 1}/18：${currentTrial.task}・${currentTrial.stimulusFile}。200フレーム待機中。`;
  waitFor200Frames();
}

function waitFor200Frames() {
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    let frames = 0;
    const nextFrame = () => $("preview").requestVideoFrameCallback(() => { if (++frames >= 200) playStimulus(); else nextFrame(); });
    nextFrame();
  } else { setTimeout(playStimulus, 6700); }
}

function playStimulus() {
  if (recorder?.state !== "recording") return;
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffers[currentTrial.stimulusId].buffer;
  source.connect(audioContext.destination);
  source.onended = () => { if (recorder?.state === "recording") recorder.stop(); };
  try { source.start(); $("trialInfo").textContent = `試行 ${trialIndex + 1}/18：音源再生中 ${currentTrial.stimulusFile}`; }
  catch (error) { setStatus(`音源を再生できません: ${error.message}`); recorder.stop(); }
}

async function saveTrial() {
  clearInterval(elapsedTimer);
  $("recordingBadge").hidden = true;
  const finishedAt = new Date();
  const type = recorder.mimeType || "video/mp4";
  const extension = type.includes("webm") ? "webm" : "mp4";
  const name = `${safeName($("participant").value)}_${currentTrial.task}_${currentTrial.stimulusId}_${timestamp(trialStartedAt)}`;
  const metadata = { presentation_order: trialIndex + 1, block_trial_order: (trialIndex % 9) + 1, experimenter_id: $("experimenter").value, participant_id: $("participant").value, task: currentTrial.task, condition: currentTrial.condition, stimulus_id: currentTrial.stimulusId, stimulus_file: currentTrial.stimulusFile, started_at: trialStartedAt.toISOString(), finished_at: finishedAt.toISOString(), audio_start_frame_offset: 200, video_file: `${name}.${extension}`, recording_includes_microphone_audio: true, archive_note: "" };
  try { await putRecord({ id: crypto.randomUUID(), name, startedAt: +trialStartedAt, type, video: new Blob(chunks, { type }), metadata }); await renderArchive(); }
  catch (error) { return setStatus(`iPad内へ保存できません: ${error.message}`); }
  const pause = Math.max(0, Number($("breakSeconds").value) || 0);
  $("trialInfo").textContent = `試行 ${trialIndex + 1}/18を保存しました。${pause}秒後に次の試行を開始します。`;
  setStatus("休憩中です。");
  setTimeout(advanceTrial, pause * 1000);
}

function csvValue(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
async function makeCsv(records) {
  const keys = ["presentation_order", "block_trial_order", "experimenter_id", "participant_id", "task", "condition", "stimulus_id", "stimulus_file", "started_at", "finished_at", "audio_start_frame_offset", "video_file", "recording_includes_microphone_audio", "archive_note"];
  return [keys.join(","), ...records.map((record) => keys.map((key) => csvValue(record.metadata[key])).join(","))].join("\r\n");
}

function u16(n) { return [n & 255, (n >>> 8) & 255]; }
function u32(n) { return [...u16(n), ...u16(n >>> 16)]; }
const crcTable = (() => { const table = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function createZip(files) {
  const encoder = new TextEncoder(); const parts = []; const directory = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const data = new Uint8Array(await file.blob.arrayBuffer()); const checksum = crc32(data);
    const local = new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0,...u32(checksum),...u32(data.length),...u32(data.length),...u16(name.length),0,0,...name]);
    const central = new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0,0,0,...u32(checksum),...u32(data.length),...u32(data.length),...u16(name.length),0,0,0,0,0,0,0,0,0,0,0,0,...u32(offset),...name]);
    parts.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const directorySize = directory.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array([80,75,5,6,0,0,0,0,...u16(directory.length),...u16(directory.length),...u32(directorySize),...u32(offset),0,0]);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

async function exportAll() {
  const records = await getRecords();
  if (!records.length) return setStatus("書き出す試行がありません。");
  const files = records.map((record) => ({ name: record.metadata.video_file, blob: record.video }));
  files.push({ name: `${safeName($("participant").value)}_metadata.csv`, blob: new Blob([await makeCsv(records)], { type: "text/csv;charset=utf-8" }) });
  const zip = new File([await createZip(files)], `${safeName($("participant").value)}_groove_experiment.zip`, { type: "application/zip" });
  try { if (navigator.canShare?.({ files: [zip] })) { await navigator.share({ title: "Groove Experiment", files: [zip] }); return; } }
  catch (error) { if (error.name === "AbortError") return; }
  const link = document.createElement("a"); link.href = URL.createObjectURL(zip); link.download = zip.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function editArchive(record) {
  const note = prompt("アーカイブメモを更新", record.metadata.archive_note || "");
  if (note === null) return;
  record.metadata.archive_note = note;
  record.metadata.archived_at = new Date().toISOString();
  await putRecord(record); renderArchive();
}

async function renderArchive() {
  const records = await getRecords(); const list = $("archiveList"); list.innerHTML = "";
  if (!records.length) { list.innerHTML = '<p class="hint">保存済み試行はありません。</p>'; return; }
  records.forEach((record) => {
    const item = document.createElement("div"); item.className = "archive-item";
    item.innerHTML = `<p><strong>${record.name}</strong></p><p class="hint">提示順 ${record.metadata.presentation_order} / ${record.metadata.task} / ${record.metadata.stimulus_file}</p>`;
    const edit = document.createElement("button"); edit.textContent = "アーカイブメモを更新"; edit.onclick = () => editArchive(record);
    const remove = document.createElement("button"); remove.textContent = "この試行を削除"; remove.className = "danger"; remove.onclick = async () => { if (confirm(`${record.name} を削除しますか？`)) { await deleteRecord(record.id); renderArchive(); } };
    item.append(edit, remove); list.append(item);
  });
}

createSoundInputs();
$("prepareButton").onclick = prepareExperiment;
$("cameraButton").onclick = startCamera;
$("startButton").onclick = startExperiment;
$("nextBlockButton").onclick = startNextBlock;
$("exportAllButton").onclick = exportAll;
openDatabase().then((value) => { database = value; renderArchive(); }).catch((error) => setStatus(`iPad内ストレージを開けません: ${error.message}`));
