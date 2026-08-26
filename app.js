/* Groove iPad Recorder: v5 hotfix
 * 次ブロックも、初回開始と同じ preflightStart() を必ず通す。
 */
const $ = (id) => document.getElementById(id);

let stream;
let audioContext;
let currentSource;
let recorder;
let currentTrial;
let trialIndex = -1;
let trials = [];
let chunks = [];
let database;

function status(message) {
  $("status").textContent = message;
}

function cameraIsLive() {
  return Boolean(stream) && stream.getVideoTracks().some((track) => track.readyState === "live") && $("preview").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

async function preflightStart() {
  if (!stream || !stream.getTracks().some((track) => track.readyState === "live")) {
    status("カメラ接続を復旧しています…");
    await startCamera();
  }

  if (!cameraIsLive()) {
    throw new Error("カメラ映像を確認できません。カメラ・マイクを再起動してから開始してください。");
  }

  await audioContext.resume();
  if (audioContext.state !== "running") {
    throw new Error("iPadの音声出力を再開できません。消音モード・音量を確認してください。");
  }
}

async function startNextBlock() {
  $("nextBlockButton").disabled = true;

  try {
    await preflightStart();
  } catch (error) {
    $("nextBlockButton").disabled = false;
    status(error.message);
    return;
  }

  // 前ブロック終了時は trialIndex が 8。ここで次の試行 9 に一度だけ進める。
  trialIndex += 1;
  if (trialIndex >= trials.length) {
    status("全試行が完了しています。");
    return;
  }

  currentTrial = trials[trialIndex];
  startTrialRecording();
}

function startTrialRecording() {
  if (!cameraIsLive()) {
    status("カメラ映像が停止しています。録画は開始しませんでした。");
    $("nextBlockButton").disabled = false;
    return;
  }

  chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
  recorder = mimeType ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 }) : new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onerror = (event) => stopWithFailure(`録画エラー: ${event.error?.message || "不明なエラー"}`);
  recorder.onstop = saveTrial;
  recorder.start(1000);

  if (recorder.state !== "recording") {
    status("録画を開始できませんでした。");
    return;
  }

  $("trialInfo").textContent = `試行 ${trialIndex + 1}/18：録画開始。200フレーム待機中。`;
  waitFor200Frames();
}

function waitFor200Frames() {
  let frames = 0;
  const nextFrame = () => {
    $("preview").requestVideoFrameCallback(() => {
      if (!cameraIsLive()) return stopWithFailure("カメラ映像が停止したため録画を中止しました。");
      frames += 1;
      if (frames >= 200) playStimulus();
      else nextFrame();
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
    $("trialInfo").textContent = `試行 ${trialIndex + 1}/18：音源再生中 ${currentTrial.stimulusFile}`;
  } catch (error) {
    stopWithFailure(`音源再生を開始できません: ${error.message}`);
  }
}

function stopWithFailure(message) {
  status(message);
  if (currentSource) currentSource.onended = null;
  if (recorder?.state === "recording") recorder.stop();
}

function getRecords() {
  return new Promise((resolve, reject) => {
    const request = database.transaction("records").objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function selectedParticipantRecords(records) {
  const participant = $("participantExport").value;
  return records.filter((record) => record.metadata.participant_id === participant);
}

async function renderParticipantExports() {
  const records = await getRecords();
  const participants = [...new Set(records.map((record) => record.metadata.participant_id))].sort();
  const select = $("participantExport");
  const previous = select.value;
  select.innerHTML = participants.map((participant) => `<option value="${participant}">${participant}</option>`).join("");
  if (participants.includes(previous)) select.value = previous;
  $("exportParticipantButton").disabled = participants.length === 0;
}

async function exportSelectedParticipant() {
  const records = selectedParticipantRecords(await getRecords());
  if (!records.length) return status("選択した被験者のデータはありません。");

  const participant = $("participantExport").value;
  const files = records.map((record) => ({ name: record.metadata.video_file, blob: record.video }));
  files.push({
    name: `${participant}_metadata.csv`,
    blob: new Blob([await makeCsv(records)], { type: "text/csv;charset=utf-8" })
  });

  const zipFile = new File([await createZip(files)], `${participant}_groove_experiment.zip`, { type: "application/zip" });
  try {
    if (navigator.canShare?.({ files: [zipFile] })) {
      await navigator.share({ title: `${participant} Groove Experiment`, files: [zipFile] });
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(zipFile);
  link.download = zipFile.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* 既存の app.js にある以下のイベント設定を置換する。
 * $("nextBlockButton").onclick = startNextBlock;
 * $("exportParticipantButton").onclick = exportSelectedParticipant;
 */
