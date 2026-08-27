const $ = id => document.getElementById(id);
const CONDITIONS = ["low", "medium", "high"];
const LABEL = { low: "低", medium: "中", high: "高" };
let db, stream, ctx, recorder, source, recording = false, trials = [], position = -1, active, started, timer, frameTimer, chunks = [], sounds = {};

function status(text) { $("status").textContent = text; }
function safe(text) { return text.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function stamp(date) { return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z"); }
function liveCamera() { return stream?.getVideoTracks().some(track => track.readyState === "live") && $("preview").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA; }

$("sounds").innerHTML = CONDITIONS.map(condition => [1, 2, 3].map(number =>
  `<label>${LABEL[condition]}複雑性 ${number}<input id="${condition}${number}" type="file"></label>`
).join("")).join("");

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("groove-calibration-archive", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function put(record) { return new Promise((resolve, reject) => { const r = db.transaction("records", "readwrite").objectStore("records").put(record); r.onsuccess = resolve; r.onerror = () => reject(r.error); }); }
function records() { return new Promise((resolve, reject) => { const r = db.transaction("records").objectStore("records").getAll(); r.onsuccess = () => resolve(r.result.sort((a,b) => a.startedAt - b.startedAt)); r.onerror = () => reject(r.error); }); }
function remove(id) { return new Promise((resolve, reject) => { const r = db.transaction("records", "readwrite").objectStore("records").delete(id); r.onsuccess = resolve; r.onerror = () => reject(r.error); }); }

$("prepare").onclick = async () => {
  const files = {};
  for (const condition of CONDITIONS) for (let n = 1; n <= 3; n += 1) files[condition + n] = $(condition + n).files[0];
  if (!$("experimenter").value.trim() || !$("participant").value.trim()) return status("実験者IDと参加者IDを入力してください。");
  if (Object.values(files).some(file => !file)) return status("9音源すべてを選択してください。");
  try {
    ctx ??= new AudioContext();
    sounds = {};
    status("9音源を読み込み、再生可能か確認しています…");
    for (const [id, file] of Object.entries(files)) sounds[id] = { buffer: await ctx.decodeAudioData(await file.arrayBuffer()), name: file.name };
  } catch (error) { return status("音源を読み込めません。MP3/M4A/WAVを選んでください: " + error.message); }
  trials = CONDITIONS.flatMap(condition => [1,2,3].map(n => ({ category:"trial", task:$("task").value, condition, stimulusId:condition+n, stimulusFile:sounds[condition+n].name })));
  trials.sort(() => Math.random() - .5);
  position = -1;
  $("camera").disabled = false;
  $("progress").textContent = `「${$("task").value}」の9試行をランダム順で作成しました。`;
  status("音源を確認しました。カメラ・マイクを開始してください。");
};

$("camera").onclick = async () => {
  try {
    stream?.getTracks().forEach(track => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:"environment" }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:true });
    $("preview").srcObject = stream;
    $("preview").style.display = "block";
    $("previewText").hidden = true;
    await $("preview").play();
    $("start").disabled = false;
    $("calibrate").disabled = false;
    status("カメラとマイクを開始しました。");
  } catch (error) { status("カメラまたはマイクを開始できません: " + error.message); }
};

async function preflight() {
  if (!liveCamera()) throw new Error("カメラ映像を確認できません。カメラ・マイクを再起動してください。");
  ctx ??= new AudioContext();
  await ctx.resume();
  if (ctx.state !== "running") throw new Error("音声出力を有効にできません。iPadの消音モード・音量を確認してください。");
}

$("calibrate").onclick = async () => {
  if (!$("experimenter").value.trim() || !$("participant").value.trim()) return status("実験者IDと参加者IDを入力してください。");
  const bpm = Number($("bpm").value);
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) return status("BPMは30〜240で設定してください。");
  try { await preflight(); } catch (error) { return status(error.message); }
  active = { category:"calibration", task:"キャリブレーション", bpm, bars:8, beats:32 };
  beginRecording("キャリブレーション：録画開始、200フレーム待機中。", () => metronome(bpm, 32));
};

$("start").onclick = async () => {
  try { await preflight(); } catch (error) { return status(error.message); }
  $("start").disabled = true;
  nextTrial();
};

function nextTrial() {
  position += 1;
  if (position >= trials.length) {
    $("progress").textContent = "9試行が完了しました。参加者別に一括保存してください。";
    $("calibrate").disabled = false;
    return status("課題完了。");
  }
  active = { ...trials[position], presentationOrder:position + 1 };
  beginRecording(`試行 ${position + 1}/9：${active.stimulusFile}。録画開始、200フレーム待機中。`, playStimulus);
}

function beginRecording(message, afterFrames) {
  if (recording) return status("すでに録画中です。");
  chunks = [];
  started = new Date();
  const mime = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "";
  try { recorder = mime ? new MediaRecorder(stream, { mimeType:mime, videoBitsPerSecond:3000000 }) : new MediaRecorder(stream); }
  catch (error) { return status("録画を開始できません: " + error.message); }
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = event => fail("録画エラー: " + (event.error?.message || "不明なエラー"));
  recorder.onstop = () => { recording = false; save(); };
  recorder.start(1000);
  if (recorder.state !== "recording") return status("録画を開始できませんでした。");
  recording = true;
  $("start").disabled = true;
  $("calibrate").disabled = true;
  $("rec").hidden = false;
  timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); $("time").textContent = String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0"); }, 250);
  $("progress").textContent = message;
  wait200(afterFrames);
}

function wait200(callback) {
  frameTimer = setTimeout(() => fail("カメラフレームが停止したため、録画を中止しました。"), 20000);
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return setTimeout(() => { clearTimeout(frameTimer); callback(); }, 6700);
  let frames = 0;
  const next = () => $("preview").requestVideoFrameCallback(() => {
    if (!liveCamera()) return fail("カメラ映像が停止したため、録画を中止しました。");
    if (++frames >= 200) { clearTimeout(frameTimer); callback(); } else next();
  });
  next();
}

function playStimulus() {
  try {
    source = ctx.createBufferSource();
    source.buffer = sounds[active.stimulusId].buffer;
    source.connect(ctx.destination);
    source.onended = () => { if (recorder?.state === "recording") recorder.stop(); };
    source.start();
    $("progress").textContent = `試行 ${position + 1}/9：音源再生中 ${active.stimulusFile}`;
  } catch (error) { fail("音源を再生できません: " + error.message); }
}

function metronome(bpm, beats) {
  const first = ctx.currentTime + .08;
  const interval = 60 / bpm;
  for (let beat = 0; beat < beats; beat += 1) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = beat % 4 === 0 ? 1320 : 880;
    gain.gain.setValueAtTime(.0001, first + beat * interval);
    gain.gain.exponentialRampToValueAtTime(.25, first + beat * interval + .003);
    gain.gain.exponentialRampToValueAtTime(.0001, first + beat * interval + .07);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(first + beat * interval);
    oscillator.stop(first + beat * interval + .08);
  }
  setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, (beats * interval + .25) * 1000);
  $("progress").textContent = `キャリブレーション：${bpm} BPM、8小節（32拍）を再生中。`;
}

function fail(message) {
  clearTimeout(frameTimer);
  clearInterval(timer);
  if (source) source.onended = null;
  if (recorder?.state === "recording") recorder.stop();
  $("rec").hidden = true;
  status(message);
}

async function save() {
  clearTimeout(frameTimer);
  clearInterval(timer);
  $("rec").hidden = true;
  const ended = new Date();
  const type = recorder.mimeType || "video/mp4";
  const ext = type.includes("webm") ? "webm" : "mp4";
  const participant = $("participant").value;
  // 通常試行は「a101_腕振り_high1_2026-08-26T20-42-22Z.mp4」の形式。
  const middle = active.category === "calibration" ? "calibration" : `${active.task}_${active.stimulusId}`;
  const name = `${safe(participant)}_${middle}_${stamp(started)}`;
  const meta = {
    category:active.category, presentation_order:active.presentationOrder || "", experimenter_id:$("experimenter").value,
    participant_id:participant, task:active.task, condition:active.condition || "", stimulus_id:active.stimulusId || "",
    stimulus_file:active.stimulusFile || "metronome", calibration_bpm:active.bpm || "", calibration_bars:active.bars || "",
    calibration_beats:active.beats || "", started_at:started.toISOString(), finished_at:ended.toISOString(),
    audio_start_frame_offset:200, video_file:`${name}.${ext}`, recording_includes_microphone_audio:true, archive_note:""
  };
  try { await put({ id:crypto.randomUUID(), name, startedAt:+started, type, video:new Blob(chunks,{type}), metadata:meta }); await renderArchive(); }
  catch (error) { return status("iPad内へ保存できません: " + error.message); }
  if (active.category === "calibration") {
    $("progress").textContent = "キャリブレーションを保存しました。試行を開始できます。";
    $("calibrate").disabled = false;
    $("start").disabled = false;
    return status("キャリブレーション完了です。");
  }
  const pause = Math.max(0, Number($("rest").value) || 0);
  $("progress").textContent = `試行 ${position + 1}/9を保存しました。${pause}秒後に次の試行を開始します。`;
  status("休憩中です。");
  setTimeout(nextTrial, pause * 1000);
}

function csvValue(value) { return `"${String(value ?? "").replaceAll('"','""')}"`; }
async function csv(data) {
  const fields = ["category","presentation_order","experimenter_id","participant_id","task","condition","stimulus_id","stimulus_file","calibration_bpm","calibration_bars","calibration_beats","started_at","finished_at","audio_start_frame_offset","video_file","recording_includes_microphone_audio","archive_note"];
  return [fields.join(","), ...data.map(row => fields.map(field => csvValue(row.metadata[field])).join(","))].join("\r\n");
}

function u16(n) { return [n&255,(n>>>8)&255]; }
function u32(n) { return [...u16(n),...u16(n>>>16)]; }
const table = (() => { const t=[]; for(let n=0;n<256;n+=1){let c=n;for(let b=0;b<8;b+=1)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t; })();
function crc(bytes) { let c=0xffffffff; for(const b of bytes)c=table[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
async function zip(files) {
  const encoder=new TextEncoder(), parts=[], directory=[]; let offset=0;
  for(const file of files){const name=encoder.encode(file.name), data=new Uint8Array(await file.blob.arrayBuffer()), sum=crc(data);
    const local=new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0,...u32(sum),...u32(data.length),...u32(data.length),...u16(name.length),0,0,...name]);
    const central=new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0,0,0,...u32(sum),...u32(data.length),...u32(data.length),...u16(name.length),0,0,0,0,0,0,0,0,0,0,0,0,...u32(offset),...name]);
    parts.push(local,data);directory.push(central);offset+=local.length+data.length;
  }
  const size=directory.reduce((n,item)=>n+item.length,0);
  return new Blob([...parts,...directory,new Uint8Array([80,75,5,6,0,0,0,0,...u16(directory.length),...u16(directory.length),...u32(size),...u32(offset),0,0])],{type:"application/zip"});
}

$("export").onclick = async () => {
  const participant=$("exportParticipant").value;
  const data=(await records()).filter(row=>row.metadata.participant_id===participant);
  if(!data.length)return status("選択した参加者のデータはありません。");
  const files=data.map(row=>({name:row.metadata.video_file,blob:row.video}));
  files.push({name:`${safe(participant)}_metadata.csv`,blob:new Blob([await csv(data)],{type:"text/csv;charset=utf-8"})});
  const file=new File([await zip(files)],`${safe(participant)}_groove_experiment.zip`,{type:"application/zip"});
  try{if(navigator.canShare?.({files:[file]})){await navigator.share({title:`${participant} Groove Experiment`,files:[file]});return;}}catch(error){if(error.name==="AbortError")return;}
  const link=document.createElement("a");link.href=URL.createObjectURL(file);link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
};

async function renderArchive() {
  const data=await records(), participants=[...new Set(data.map(row=>row.metadata.participant_id))].sort(), selector=$("exportParticipant"), old=selector.value;
  selector.innerHTML=participants.map(value=>`<option value="${value}">${value}</option>`).join("");
  if(participants.includes(old))selector.value=old;
  $("export").disabled=!participants.length;
  const archive=$("archive");archive.innerHTML=data.length?"":'<p class="muted">保存済みデータはありません。</p>';
  data.forEach(row=>{const item=document.createElement("div");item.className="row";const label=row.metadata.category==="calibration"?`キャリブレーション ${row.metadata.calibration_bpm} BPM`:`${row.metadata.task} / 提示順 ${row.metadata.presentation_order} / ${row.metadata.stimulus_file}`;
    item.innerHTML=`<b>${row.name}</b><br><span class="muted">${row.metadata.participant_id} / ${label}</span>`;
    const edit=document.createElement("button");edit.textContent="メモを更新";edit.onclick=async()=>{const note=prompt("アーカイブメモ",row.metadata.archive_note||"");if(note!==null){row.metadata.archive_note=note;await put(row);renderArchive();}};
    const del=document.createElement("button");del.textContent="削除";del.className="danger";del.onclick=async()=>{if(confirm(`${row.name} を削除しますか？`)){await remove(row.id);renderArchive();}};item.append(edit,del);archive.append(item);
  });
}

openDb().then(value=>{db=value;renderArchive();}).catch(error=>status("iPad内ストレージを開けません: "+error.message));
