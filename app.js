const $ = (id) => document.getElementById(id);
const CONDITIONS = ["low", "medium", "high"];
const CONDITION_LABELS = { low: "低", medium: "中", high: "高" };

let database;
let stream;
let audioContext;
let audioBuffers = {};
let recorder;
let currentSource;
let trials = [];
let trialIndex = -1;
let currentTrial;
let chunks = [];
let trialStartedAt;
let elapsedTimer;
let frameTimeout;

function setStatus(message) {
  $("status").textContent = message;
}

function safeName(text) {
  return text.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fileTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function createSoundInputs() {
  $("soundInputs").innerHTML = CONDITIONS.map((condition) => {
    return [1, 2, 3].map((number) => {
      // accept属性を付けない。iPad Safariで音源がグレーアウトする問題を避けるため。
      return `<label>${CONDITION_LABELS[condition]}複雑性 ${number}<input id="${condition}${number}" type="file"></label>`;
    }).join("");
  }).join("");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("groove-experiment-archive-v1", 1);
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

  for (const condition of CONDITIONS) {
    for (let number = 1; number <= 3; number += 1) {
      files[`${condition}${number}`] = $(`${condition}${number}`).files[0];
    }
  }

  if (!experimenter || !participant) {
    setStatus("実験者IDと参加者IDを入力してください。");
    return;
  }
  if (Object.values(files).some((file) => !file)) {
    setStatus("低・中・高を各3つ、計9音源すべてを選択してください。");
    return;
  }

  try {
    audioContext ??= new AudioContext();
    audioBuffers = {};
    setStatus("9音源を読み込み、再生可能か確認しています…");

    for (const [key, file] of Object.entries(files)) {
      const data = await file.arrayBuffer();
      audioBuffers[key] = {
        buffer: await audioContext.decodeAudioData(data),
        name: file.name
      };
    }
  } catch (error) {
    setStatus(`音源を読み込めません。MP3/M4A/WAVをファイルアプリから選択してください: ${error.message}`);
    return;
  }

  const task = $("task").value;
  trials = [];
  CONDITIONS.forEach((condition) => {
    for (let number = 1; number <= 3; number += 1) {
      const stimulusId = `${condition}${number}`;
      trials.push({ task, condition, stimulusId, stimulusFile: audioBuffers[stimulusId].name });
    }
  });
  trials.sort(() => Math.random() - 0.5);
  trialIndex = -1;
  $("cameraButton").disabled = false;
  $("startButton").disabled = true;
  $("trialInfo").textContent = `「${task}」の9試行をランダム順で作成しました。`;
  setStatus("9音源を確認しました。カメラ・マイクを開始してください。");
}

async function startCamera() {
  try {
    stream?.getTracks().forEach((track) => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    $("preview").srcObject = stream;
    $("preview").style.display = "block";
    $("previewMessage").hidden = true;
    await $("preview").play();
    $("startButton").disabled = false;
    setStatus("カメラとマイクを開始しました。9試行を開始できます。");
  } catch (error) {
    setStatus(`カメラまたはマイクを開始できません: ${error.message}`);
  }
}

function cameraIsLive() {
  return Boolean(stream) &&
    stream.getVideoTracks().some((track) => track.readyState === "live") &&
    $("preview").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

async function preflightStart() {
  if (!cameraIsLive()) {
    throw new Error("カメラ映像を確認できません。カメラ・マイクを再起動してください。");
  }
  await audioContext.resume();
  if (audioContext.state !== "running") {
    throw new Error("音声出力を有効にできません。iPadの消音モード・音量を確認してください。");
  }
}

async function startExperiment() {
  try {
    await preflightStart();
  } catch (error) {
    setStatus(error.message);
    return;
  }

  $("startButton").disabled = true;
  startNextTrial();
}

function startNextTrial() {
  trialIndex += 1;

  if (trialIndex >= trials.length) {
    $("trialInfo").textContent = "9試行が完了しました。被験者別に一括保存してください。";
    setStatus("課題完了です。");
    renderArchive();
    return;
  }

  currentTrial = trials[trialIndex];
  startTrialRecording();
}

function startTrialRecording() {
  if (!cameraIsLive()) {
    setStatus("カメラ映像が停止しています。録画を開始しませんでした。");
    return;
  }

  chunks = [];
  trialStartedAt = new Date();
  const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";

  try {
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 })
      : new MediaRecorder(stream);
  } catch (error) {
    setStatus(`録画を開始できません: ${error.message}`);
    return;
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = (event) => stopWithFailure(`録画エラー: ${event.error?.message || "不明なエラー"}`);
  recorder.onstop = saveTrial;
  recorder.start(1000);

  if (recorder.state !== "recording") {
    setStatus("録画を開始できませんでした。");
    return;
  }

  $("recordingBadge").hidden = false;
  elapsedTimer = setInterval(updateElapsed, 250);
  $("trialInfo").textContent = `試行 ${trialIndex + 1}/9：${currentTrial.stimulusFile}。録画開始、200フレーム待機中。`;
  waitFor200Frames();
}

function updateElapsed() {
  const seconds = Math.floor((Date.now() - trialStartedAt) / 1000);
  $("elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function waitFor200Frames() {
  let frames = 0;
  const timeout = setTimeout(() => stopWithFailure("カメラフレームが停止したため、録画を中止しました。"), 20_000);
  frameTimeout = timeout;

  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    // 古いiPadOS向けの代替。30fps時の200フレーム相当として約6.7秒待つ。
    setTimeout(() => {
      clearTimeout(timeout);
      playStimulus();
    }, 6_700);
    return;
  }

  const nextFrame = () => {
    $("preview").requestVideoFrameCallback(() => {
      if (!cameraIsLive()) return stopWithFailure("カメラ映像が停止したため、録画を中止しました。");
      frames += 1;
      if (frames >= 200) {
        clearTimeout(timeout);
        playStimulus();
      } else {
        nextFrame();
      }
    });
  };
  nextFrame();
}

function playStimulus() {
  try {
    currentSource = audioContext.createBufferSource();
    currentSource.buffer = audioBuffers[currentTrial.stimulusId].buffer;
    currentSource.connect(audioContext.destination);
    currentSource.onended = () => {
      if (recorder?.state === "recording") recorder.stop();
    };
    currentSource.start();
    $("trialInfo").textContent = `試行 ${trialIndex + 1}/9：音源再生中 ${currentTrial.stimulusFile}`;
  } catch (error) {
    stopWithFailure(`音源を再生できません: ${error.message}`);
  }
}

function stopWithFailure(message) {
  clearTimeout(frameTimeout);
  clearInterval(elapsedTimer);
  if (currentSource) currentSource.onended = null;
  if (recorder?.state === "recording") recorder.stop();
  $("recordingBadge").hidden = true;
  setStatus(message);
}

async function saveTrial() {
  clearTimeout(frameTimeout);
  clearInterval(elapsedTimer);
  $("recordingBadge").hidden = true;

  const finishedAt = new Date();
  const type = recorder.mimeType || "video/mp4";
  const extension = type.includes("webm") ? "webm" : "mp4";
  const name = `${safeName($("participant").value)}_${currentTrial.task}_${currentTrial.stimulusId}_${fileTimestamp(trialStartedAt)}`;
  const metadata = {
    presentation_order: trialIndex + 1,
    block_trial_order: trialIndex + 1,
    experimenter_id: $("experimenter").value,
    participant_id: $("participant").value,
    task: currentTrial.task,
    condition: currentTrial.condition,
    stimulus_id: currentTrial.stimulusId,
    stimulus_file: currentTrial.stimulusFile,
    started_at: trialStartedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    audio_start_frame_offset: 200,
    video_file: `${name}.${extension}`,
    recording_includes_microphone_audio: true,
    archive_note: ""
  };

  try {
    await putRecord({ id: crypto.randomUUID(), name, startedAt: +trialStartedAt, type, video: new Blob(chunks, { type }), metadata });
    await renderArchive();
  } catch (error) {
    setStatus(`iPad内へ保存できません: ${error.message}`);
    return;
  }

  const pause = Math.max(0, Number($("breakSeconds").value) || 0);
  $("trialInfo").textContent = `試行 ${trialIndex + 1}/9を保存しました。${pause}秒後に次の試行を開始します。`;
  setStatus("休憩中です。");
  setTimeout(startNextTrial, pause * 1000);
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function makeCsv(records) {
  const keys = ["presentation_order", "block_trial_order", "experimenter_id", "participant_id", "task", "condition", "stimulus_id", "stimulus_file", "started_at", "finished_at", "audio_start_frame_offset", "video_file", "recording_includes_microphone_audio", "archive_note"];
  return [keys.join(","), ...records.map((record) => keys.map((key) => csvValue(record.metadata[key])).join(","))].join("\r\n");
}

function u16(number) { return [number & 255, (number >>> 8) & 255]; }
function u32(number) { return [...u16(number), ...u16(number >>> 16)]; }

const crcTable = (() => {
  const table = [];
  for (let number = 0; number < 256; number += 1) {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[number] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function createZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(data);
    const localHeader = new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0, ...u32(checksum), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0,0, ...name]);
    const centralHeader = new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0,0,0, ...u32(checksum), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0,0, 0,0, 0,0,0,0, 0,0,0,0, ...u32(offset), ...name]);
    parts.push(localHeader, data);
    directory.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const directorySize = directory.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array([80,75,5,6,0,0,0,0, ...u16(directory.length), ...u16(directory.length), ...u32(directorySize), ...u32(offset), 0,0]);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

async function exportParticipant() {
  const participant = $("participantExport").value;
  const records = (await getRecords()).filter((record) => record.metadata.participant_id === participant);
  if (!records.length) return setStatus("選択した被験者のデータはありません。");

  const files = records.map((record) => ({ name: record.metadata.video_file, blob: record.video }));
  files.push({ name: `${safeName(participant)}_metadata.csv`, blob: new Blob([await makeCsv(records)], { type: "text/csv;charset=utf-8" }) });
  const zip = new File([await createZip(files)], `${safeName(participant)}_groove_experiment.zip`, { type: "application/zip" });

  try {
    if (navigator.canShare?.({ files: [zip] })) {
      await navigator.share({ title: `${participant} Groove Experiment`, files: [zip] });
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(zip);
  link.download = zip.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function editArchive(record) {
  const note = prompt("アーカイブメモを更新", record.metadata.archive_note || "");
  if (note === null) return;
  record.metadata.archive_note = note;
  record.metadata.archived_at = new Date().toISOString();
  await putRecord(record);
  renderArchive();
}

async function renderArchive() {
  const records = await getRecords();
  const participants = [...new Set(records.map((record) => record.metadata.participant_id))].sort();
  const selector = $("participantExport");
  const previous = selector.value;
  selector.innerHTML = participants.map((participant) => `<option value="${participant}">${participant}</option>`).join("");
  if (participants.includes(previous)) selector.value = previous;
  $("exportButton").disabled = participants.length === 0;

  const list = $("archiveList");
  list.innerHTML = "";
  if (!records.length) {
    list.innerHTML = '<p class="hint">保存済み試行はありません。</p>';
    return;
  }

  records.forEach((record) => {
    const item = document.createElement("div");
    item.className = "archive-item";
    item.innerHTML = `<p><strong>${record.name}</strong></p><p class="hint">被験者 ${record.metadata.participant_id} / 提示順 ${record.metadata.presentation_order} / ${record.metadata.task} / ${record.metadata.stimulus_file}</p>`;
    const edit = document.createElement("button");
    edit.textContent = "アーカイブメモを更新";
    edit.onclick = () => editArchive(record);
    const remove = document.createElement("button");
    remove.textContent = "この試行を削除";
    remove.className = "danger";
    remove.onclick = async () => {
      if (confirm(`${record.name} を削除しますか？`)) {
        await deleteRecord(record.id);
        renderArchive();
      }
    };
    item.append(edit, remove);
    list.append(item);
  });
}

createSoundInputs();
$("prepareButton").onclick = prepareExperiment;
$("cameraButton").onclick = startCamera;
$("startButton").onclick = startExperiment;
$("exportButton").onclick = exportParticipant;
openDatabase().then((value) => { database = value; renderArchive(); }).catch((error) => setStatus(`iPad内ストレージを開けません: ${error.message}`));
