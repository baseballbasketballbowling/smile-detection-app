// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  BATCH_SIZE:        6,
  CAPTURE_INTERVAL:  250,
  SMILE_THRESHOLD:   0.72,
  COOLDOWN_MS:       3000,
  API_W:             320,
  API_H:             240,
  API_QUALITY:       0.75,
  PHOTO_QUALITY:     0.95,
  EXPOSURE:          0,     // EV: -2.0 〜 +2.0
};

// Peak detection constants
const PEAK_CONFIRM = 2;    // ピーク後に何フレーム下降すれば確定とするか
const PEAK_DROP    = 0.08; // ピークからこの値以上下がれば下降とみなす
const HISTORY_MAX  = 20;   // scoreHistory の最大保持フレーム数

// ============================================================
// STATE
// ============================================================
let facingMode     = 'user';
let isRunning      = false;
let captureTimer   = null;
let isInCooldown   = false;
let batchPending   = false;
let frameIdCounter = 0;
let frameBuffer        = [];
let scoreHistory       = []; // {score, smiling, faces, dataUrl} のリスト
let shotHistory        = [];
let deviceList         = [];
let activeDeviceId     = null;
let currentDeviceIndex = -1;

// ============================================================
// DOM
// ============================================================
const $ = id => document.getElementById(id);

const video            = $('video');
const flashOverlay     = $('flash-overlay');
const smileFill        = $('smile-meter-fill');
const smileThresholdEl = $('smile-meter-threshold');
const smileScoreTxt    = $('smile-score-text');
const statusTxt        = $('status-text');
const apiIndicator     = $('api-indicator');
const statusBadge      = $('status-badge');
const galleryGrid      = $('gallery-grid');
const galleryEmpty     = $('gallery-empty');
const cameraWrapper    = $('camera-wrapper');
const bestShotSection  = $('best-shot-section');
const bestShotCard     = $('best-shot-card');

const startBtn        = $('start-btn');
const stopBtn         = $('stop-btn');
const manualBtn       = $('manual-btn');
const clearBtn        = $('clear-btn');
const cameraSwitchBtn = $('camera-switch-btn');
const thresholdRange  = $('threshold-range');
const thresholdVal    = $('threshold-val');
const intervalRange   = $('interval-range');
const intervalVal     = $('interval-val');
const cooldownRange   = $('cooldown-range');
const cooldownVal     = $('cooldown-val');
const exposureRange   = $('exposure-range');
const exposureVal     = $('exposure-val');
const downloadBtn     = $('download-btn');
const sendEmailBtn    = $('send-email-btn');

const capCanvas = $('capture-canvas');
const capCtx    = capCanvas.getContext('2d');
const apiCanvas = $('api-canvas');
const apiCtx    = apiCanvas.getContext('2d');

// ============================================================
// ORIENTATION HELPERS
// iOS Safari は getUserMedia の videoWidth/Height が端末回転しても
// 変わらないため、向きを判定して canvas 側で回転する。
// window.orientation は物理的なデバイス回転を返す（ページがロックされていても）。
// screen.orientation.angle は iOS ではポートレートロック中常に 0 になるため、
// window.orientation を優先する。
// ============================================================
function getOrientationAngle() {
  if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
  if (typeof screen.orientation?.angle === 'number') return screen.orientation.angle;
  return 0;
}

// canvas サイズを現在の向きに同期し、横持ち回転が必要なら true を返す。
// 縦持ち（angle=0/180）のときは回転しない：縦写真のままが正しい。
function syncCanvasDimensions() {
  const vw    = video.videoWidth;
  const vh    = video.videoHeight;
  const angle = getOrientationAngle();
  const rotated = (angle === 90 || angle === 270) && vw < vh;
  const cw = rotated ? vh : vw;
  const ch = rotated ? vw : vh;
  if (capCanvas.width !== cw || capCanvas.height !== ch) {
    capCanvas.width  = cw;
    capCanvas.height = ch;
  }
  const scale = Math.min(CONFIG.API_W / cw, CONFIG.API_H / ch);
  const aw = Math.round(cw * scale);
  const ah = Math.round(ch * scale);
  if (apiCanvas.width !== aw || apiCanvas.height !== ah) {
    apiCanvas.width  = aw;
    apiCanvas.height = ah;
  }
  return rotated;
}

// ============================================================
// CAMERA
// ============================================================
async function startCamera() {
  const videoConstraints = (currentDeviceIndex >= 0 && deviceList[currentDeviceIndex])
    ? { deviceId: { exact: deviceList[currentDeviceIndex].deviceId } }
    : { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } };

  const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  video.srcObject = stream;

  const track    = stream.getVideoTracks()[0];
  activeDeviceId = track?.getSettings()?.deviceId ?? null;
  const facing   = track?.getSettings()?.facingMode ?? (facingMode === 'user' ? 'user' : 'environment');
  video.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';

  return new Promise(resolve => {
    video.onloadedmetadata = () => {
      syncCanvasDimensions();
      resolve();
    };
  });
}

function stopCamera() {
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

async function switchCamera() {
  if (!isRunning || cameraSwitchBtn.disabled) return;
  cameraSwitchBtn.disabled = true;
  stopCamera();
  frameBuffer  = [];
  batchPending = false;

  if (deviceList.length === 0) {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      deviceList = all.filter(d => d.kind === 'videoinput');
    } catch (_) {}
  }

  if (deviceList.length <= 1) {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    currentDeviceIndex = -1;
  } else {
    const cur = activeDeviceId ? deviceList.findIndex(d => d.deviceId === activeDeviceId) : -1;
    currentDeviceIndex = (cur + 1) % deviceList.length;
  }

  try {
    await startCamera();
    const label = deviceList[currentDeviceIndex]?.label || 'カメラを切り替えました';
    setStatus(label);
  } catch {
    setStatus('カメラが切り替えられませんでした', 'error');
    currentDeviceIndex = -1;
    facingMode = 'user';
    try { await startCamera(); } catch (_) {}
  } finally {
    cameraSwitchBtn.disabled = false;
  }
}

// ============================================================
// FRAME CAPTURE
// ============================================================
function captureFrame() {
  if (!isRunning || isInCooldown) return;

  // 毎フレームで canvas サイズを同期（端末回転時にも対応）
  const rotated = syncCanvasDimensions();
  const vw      = video.videoWidth;
  const vh      = video.videoHeight;
  const angle   = rotated ? getOrientationAngle() : 0;
  const rot     = angle === 270 ? Math.PI / 2 : -Math.PI / 2;

  const bFilter = CONFIG.EXPOSURE !== 0
    ? `brightness(${Math.round(Math.pow(2, CONFIG.EXPOSURE) * 100)}%)`
    : 'none';

  // 横持ち回転時は canvas 中心で回転して描画、通常時はそのまま描画
  function drawToCanvas(ctx, cw, ch) {
    if (rotated) {
      const s = cw / vh; // canvas 横幅 / 元ビデオ縦幅 = 尺度ファクター
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rot);
      ctx.filter = bFilter;
      ctx.drawImage(video, -(vw * s) / 2, -(vh * s) / 2, vw * s, vh * s);
      ctx.filter = 'none';
      ctx.restore();
    } else {
      ctx.filter = bFilter;
      ctx.drawImage(video, 0, 0, cw, ch);
      ctx.filter = 'none';
    }
  }

  drawToCanvas(capCtx, capCanvas.width, capCanvas.height);
  const fullDataUrl = capCanvas.toDataURL('image/jpeg', CONFIG.PHOTO_QUALITY);

  drawToCanvas(apiCtx, apiCanvas.width, apiCanvas.height);
  const apiBase64 = apiCanvas.toDataURL('image/jpeg', CONFIG.API_QUALITY).split(',')[1];

  frameBuffer.push({ id: frameIdCounter++, fullDataUrl, apiBase64, ts: Date.now() });
  if (frameBuffer.length > CONFIG.BATCH_SIZE * 2) frameBuffer.shift();

  updateFrameCounter();

  if (!batchPending && frameBuffer.length >= CONFIG.BATCH_SIZE) {
    const batch = frameBuffer.slice(0, CONFIG.BATCH_SIZE);
    frameBuffer.splice(0, Math.ceil(CONFIG.BATCH_SIZE / 2));
    analyzeBatch(batch);
  }
}

// ============================================================
// BATCH API CALL  (/api/analyze → Vercel serverless → Anthropic)
// APIキーはサーバー側環境変数に格納。ブラウザには渡さない。
// ============================================================
async function analyzeBatch(batch) {
  batchPending = true;
  setStatus(`${batch.length}フレームを分析中...`);
  apiIndicator.textContent = '🔍 分析中';

  const content = batch.map(f => ({
    type:   'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.apiBase64 },
  }));

  content.push({
    type: 'text',
    text: [
      `These are ${batch.length} frames captured 0.5s apart. Each frame may contain multiple people.`,
      `For EACH frame:`,
      `  (1) "scores": highest smile score among all faces (0.0=no smile, 1.0=big genuine smile, no faces=0.0)`,
      `  (2) "faces": total number of faces detected (0 if none)`,
      `  (3) "smiling": count of people clearly smiling (smile score > 0.5)`,
      `  (4) "kanpai": true if people appear to be raising glasses or cups for a toast, false otherwise`,
      `  (5) "obstructed": true if a hand, arm, or object is directly blocking/covering faces or the camera lens in this frame, false otherwise`,
      `Reply ONLY with valid JSON — no markdown, no explanation:`,
      `{"scores":[${Array(batch.length).fill('0.0').join(',')}],"faces":[${Array(batch.length).fill('0').join(',')}],"smiling":[${Array(batch.length).fill('0').join(',')}],"kanpai":[${Array(batch.length).fill('false').join(',')}],"obstructed":[${Array(batch.length).fill('false').join(',')}]}`,
    ].join('\n'),
  });

  let errorOccurred = false;

  try {
    const res = await fetch('/api/analyze', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ content }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const raw  = data.content?.[0]?.text?.trim() ?? '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`想定外のレスポンス: ${raw.slice(0, 80)}`);

    const parsed  = JSON.parse(jsonMatch[0]);
    const scores  = Array.isArray(parsed.scores)
      ? parsed.scores.map(s => Math.min(1, Math.max(0, parseFloat(s) || 0)))
      : [];
    const faces   = Array.isArray(parsed.faces)
      ? parsed.faces.map(n => Math.max(0, parseInt(n) || 0))
      : scores.map(() => 0);
    const smiling = Array.isArray(parsed.smiling)
      ? parsed.smiling.map((n, i) => Math.min(Math.max(0, parseInt(n) || 0), faces[i] ?? 0))
      : scores.map(() => 0);
    const kanpai  = Array.isArray(parsed.kanpai)
      ? parsed.kanpai.map(k => k === true || k === 'true')
      : scores.map(() => false);
    const obstructed = Array.isArray(parsed.obstructed)
      ? parsed.obstructed.map(o => o === true || o === 'true')
      : scores.map(() => false);

    onBatchResult(scores, smiling, faces, kanpai, obstructed, batch);

  } catch (e) {
    errorOccurred = true;
    console.error('[analyzeBatch]', e.message);
    if (isRunning) setStatus(`エラー: ${e.message}`, 'error');
  } finally {
    batchPending = false;
    apiIndicator.textContent = '';
    if (isRunning && !isInCooldown && frameBuffer.length >= CONFIG.BATCH_SIZE) {
      const next = frameBuffer.splice(0, CONFIG.BATCH_SIZE);
      analyzeBatch(next);
    } else if (isRunning && !isInCooldown && !errorOccurred) {
      setStatus('笑顔を検出中...');
    }
  }
}

// ============================================================
// BATCH RESULT
// ============================================================
function onBatchResult(scores, smilingCounts, faceCounts, kanpaiFlags, obstructedFlags, batch) {
  if (!isRunning || scores.length === 0) return;

  scores.forEach((s, i) => {
    if (!(obstructedFlags[i] ?? false)) {
      scoreHistory.push({
        score:   s,
        smiling: smilingCounts[i] ?? 0,
        faces:   faceCounts[i]    ?? 0,
        dataUrl: batch[i].fullDataUrl,
      });
    }
  });
  if (scoreHistory.length > HISTORY_MAX) {
    scoreHistory.splice(0, scoreHistory.length - HISTORY_MAX);
  }

  let dispScore = 0, dispIdx = 0;
  scores.forEach((s, i) => { if (s > dispScore) { dispScore = s; dispIdx = i; } });
  updateSmileBar(dispScore, smilingCounts[dispIdx] ?? 0, faceCounts[dispIdx] ?? 0);

  if (!isInCooldown) tryPeakShutter();

  try {
    const kanpaiIdx = Array.isArray(kanpaiFlags)
      ? kanpaiFlags.findIndex(k => k === true)
      : -1;
    if (!isInCooldown && kanpaiIdx >= 0) {
      const kScore   = scores[kanpaiIdx]        ?? dispScore;
      const kSmiling = smilingCounts[kanpaiIdx] ?? 0;
      const kFaces   = faceCounts[kanpaiIdx]    ?? 0;
      triggerShutter(batch[kanpaiIdx].fullDataUrl, kScore, Math.max(1, kSmiling), kFaces, 'kanpai');
    }
  } catch (e) {
    console.warn('[kanpai]', e.message);
  }
}

// ============================================================
// PEAK DETECTION
// 複合スコア = score + min(smiling人数, 5) × 0.1 でピーク選択。
// シャッター作動の閾値判定は必ず生スコアで行う（複数人ボーナスによる誤作動を防ぐ）。
// ============================================================
function peakMetric(entry) {
  return entry.score + Math.min(entry.smiling, 5) * 0.1;
}

function tryPeakShutter() {
  const h = scoreHistory;
  if (h.length < PEAK_CONFIRM + 2) return;

  const searchEnd = h.length - PEAK_CONFIRM;
  let peakIdx = 0, peakVal = 0;
  for (let i = 0; i < searchEnd; i++) {
    const m = peakMetric(h[i]);
    if (m > peakVal) { peakVal = m; peakIdx = i; }
  }

  if (h[peakIdx].score < CONFIG.SMILE_THRESHOLD) return;

  for (let i = peakIdx + 1; i < h.length; i++) {
    if (peakMetric(h[i]) >= peakVal - PEAK_DROP) return;
  }

  const peak    = h[peakIdx];
  const smiling = peak.smiling > 0 ? peak.smiling : 1;
  triggerShutter(peak.dataUrl, peak.score, smiling, peak.faces);
  scoreHistory = [];
}

// ============================================================
// SHUTTER
// ============================================================
function triggerShutter(dataUrl, score, smiling = 1, faces = 0, reason = 'smile') {
  if (isInCooldown) return;
  isInCooldown = true;
  frameBuffer  = [];
  scoreHistory = [];

  triggerFlash();
  cameraWrapper.classList.add('pulse');
  setTimeout(() => cameraWrapper.classList.remove('pulse'), 600);

  addToGallery(dataUrl, score, smiling, faces);

  shotHistory.unshift({ dataUrl, score, smiling, faces, ts: Date.now() });
  if (shotHistory.length > 10) shotHistory.pop();
  updateBestShot();
  if (downloadBtn)  downloadBtn.disabled  = false;
  if (sendEmailBtn) sendEmailBtn.disabled = false;

  setBadge('cooldown');
  const cooldownSec  = `${(CONFIG.COOLDOWN_MS / 1000).toFixed(1)}秒後に再開`;
  const smilingLabel = faces > 1 ? ` / ${smiling}人笑顔` : '';
  const statusMsg    = reason === 'kanpai'
    ? `🥂 乾杯を検知しました！  — ${cooldownSec}`
    : `撮影完了！ ${Math.round(score * 100)}%${smilingLabel}  — ${cooldownSec}`;
  setStatus(statusMsg);

  setTimeout(() => {
    if (!isRunning) return;
    isInCooldown = false;
    scoreHistory = [];
    setBadge('running');
    setStatus('笑顔を検出中...');
  }, CONFIG.COOLDOWN_MS);
}

function triggerFlash() {
  flashOverlay.classList.add('flashing');
  setTimeout(() => flashOverlay.classList.remove('flashing'), 120);
}

// ============================================================
// BEST SHOT
// ============================================================
function updateBestShot() {
  if (shotHistory.length === 0) { bestShotSection.style.display = 'none'; return; }
  bestShotSection.style.display = '';

  const best = [...shotHistory].sort((a, b) => {
    if (b.smiling !== a.smiling) return b.smiling - a.smiling;
    if ((b.faces ?? 0) !== (a.faces ?? 0)) return (b.faces ?? 0) - (a.faces ?? 0);
    return b.score - a.score;
  })[0];

  bestShotCard.innerHTML = '';
  const img   = Object.assign(document.createElement('img'), { src: best.dataUrl, alt: 'ベストショット' });
  const badge = Object.assign(document.createElement('div'), { className: 'best-shot-badge', textContent: 'BEST' });
  const info  = document.createElement('div');
  info.className = 'best-shot-info';
  info.innerHTML = `<span class="best-shot-score">${Math.round(best.score * 100)}%</span>
    <span class="best-shot-people">${(best.faces ?? 0) > 1 ? `笑顔 ${best.smiling}人` : ''}</span>`;
  bestShotCard.append(img, badge, info);
}

// ============================================================
// GALLERY
// ============================================================
function addToGallery(dataUrl, score, smiling, faces = 0) {
  galleryEmpty.style.display = 'none';
  const item = document.createElement('div');
  item.className = 'gallery-item';
  const img = Object.assign(document.createElement('img'), { src: dataUrl, loading: 'lazy', alt: '笑顔写真' });
  const info = document.createElement('div');
  info.className = 'gallery-item-info';
  const ts = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const smilingTxt = faces > 1 ? `<span class="gallery-smiling">${smiling}人</span>` : '';
  info.innerHTML = `<span class="gallery-time">${ts}</span>${smilingTxt}<span class="gallery-score">${Math.round(score * 100)}%</span>`;
  const dlBtn = Object.assign(document.createElement('button'), { className: 'dl-btn', textContent: '⬇ 保存' });
  dlBtn.onclick = e => {
    e.stopPropagation();
    Object.assign(document.createElement('a'), { href: dataUrl, download: `smile_${Date.now()}.jpg` }).click();
  };
  item.append(img, info, dlBtn);
  galleryGrid.prepend(item);
}

// ============================================================
// UI HELPERS
// ============================================================
function updateSmileBar(score, smiling = 0, faces = 0) {
  smileFill.style.width = `${Math.round(score * 100)}%`;
  const suf = faces > 1 ? ` / ${smiling}人` : '';
  smileScoreTxt.textContent = `${Math.round(score * 100)}%${suf}`;
  smileScoreTxt.style.color =
    score >= CONFIG.SMILE_THRESHOLD        ? 'var(--accent)' :
    score >= CONFIG.SMILE_THRESHOLD * 0.75 ? 'var(--warn)'   : '#fff';
}

function updateFrameCounter() {
  if (!batchPending) apiIndicator.textContent = `🎞 ${frameBuffer.length}/${CONFIG.BATCH_SIZE}`;
}

function updateThresholdMarker() {
  smileThresholdEl.style.left = `${CONFIG.SMILE_THRESHOLD * 100}%`;
}

function setStatus(text, type = '') {
  statusTxt.textContent = text;
  statusTxt.style.color = type === 'error' ? 'var(--danger)' : '';
}

function setBadge(state) {
  statusBadge.className   = `badge badge-${state}`;
  statusBadge.textContent = { idle: '待機中', running: '検出中', cooldown: 'クールダウン' }[state] ?? state;
}

// ============================================================
// START / STOP
// ============================================================
async function startDetection() {
  startBtn.disabled = true;
  setStatus('カメラを起動中...');
  try {
    await startCamera();
  } catch (e) {
    setStatus(`カメラエラー: ${e.message}`, 'error');
    startBtn.disabled = false;
    return;
  }
  isRunning = true; isInCooldown = false; batchPending = false;
  frameIdCounter = 0; frameBuffer = []; scoreHistory = [];
  startBtn.style.display        = 'none';
  stopBtn.style.display         = '';
  manualBtn.disabled            = false;
  cameraSwitchBtn.style.display = '';
  setBadge('running');
  setStatus('笑顔を検出中...');
  updateThresholdMarker();
  captureTimer = setInterval(captureFrame, CONFIG.CAPTURE_INTERVAL);
}

function stopDetection() {
  isRunning = false;
  clearInterval(captureTimer); captureTimer = null;
  video.style.filter = '';
  stopCamera();
  startBtn.style.display        = '';
  startBtn.disabled             = false;
  stopBtn.style.display         = 'none';
  manualBtn.disabled            = true;
  cameraSwitchBtn.style.display = 'none';
  frameBuffer = []; batchPending = false; scoreHistory = [];
  setBadge('idle');
  setStatus('停止しました');
  updateSmileBar(0);
  smileScoreTxt.textContent = '--';
  apiIndicator.textContent  = '';
}

// ============================================================
// EMAIL
// ============================================================
function resizeForEmail(dataUrl, maxWidth = 800) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale  = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrl;
  });
}

async function sendEmail() {
  if (shotHistory.length === 0 || !sendEmailBtn) return;
  const origText = sendEmailBtn.textContent;
  sendEmailBtn.disabled = true;
  sendEmailBtn.textContent = '⏳ 送信中...';

  try {
    const shots = await Promise.all(
      shotHistory.map(async s => ({
        dataUrl: await resizeForEmail(s.dataUrl),
        score:   s.score,
        smiling: s.smiling,
        faces:   s.faces ?? 0,
      }))
    );

    const res = await fetch('/api/send-email', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ shots }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    sendEmailBtn.textContent = '✓ 送信済み';
    setTimeout(() => {
      sendEmailBtn.textContent = origText;
      sendEmailBtn.disabled = shotHistory.length === 0;
    }, 3000);
  } catch (e) {
    console.error('[sendEmail]', e.message);
    sendEmailBtn.textContent = '✗ 送信失敗';
    setStatus(`メール送信エラー: ${e.message}`, 'error');
    setTimeout(() => {
      sendEmailBtn.textContent = origText;
      sendEmailBtn.disabled = false;
    }, 3000);
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================
startBtn.addEventListener('click', startDetection);
stopBtn.addEventListener('click', stopDetection);
cameraSwitchBtn.addEventListener('click', switchCamera);

manualBtn.addEventListener('click', () => {
  if (!isRunning || isInCooldown) return;
  capCtx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);
  triggerShutter(capCanvas.toDataURL('image/jpeg', 0.92), 1.0, 1);
});

clearBtn.addEventListener('click', () => {
  galleryGrid.innerHTML = '';
  galleryEmpty.style.display = '';
  shotHistory = [];
  bestShotSection.style.display = 'none';
  bestShotCard.innerHTML = '';
  if (downloadBtn)  downloadBtn.disabled  = true;
  if (sendEmailBtn) sendEmailBtn.disabled = true;
});

thresholdRange.addEventListener('input', () => {
  const v = parseInt(thresholdRange.value);
  CONFIG.SMILE_THRESHOLD = v / 100;
  thresholdVal.textContent = `${v}%`;
  updateThresholdMarker();
});

intervalRange.addEventListener('input', () => {
  const v = parseInt(intervalRange.value);
  CONFIG.CAPTURE_INTERVAL = v;
  intervalVal.textContent = `${v}ms`;
  if (isRunning) { clearInterval(captureTimer); captureTimer = setInterval(captureFrame, v); }
});

cooldownRange.addEventListener('input', () => {
  const v = parseInt(cooldownRange.value);
  CONFIG.COOLDOWN_MS = v;
  cooldownVal.textContent = `${(v / 1000).toFixed(1)}s`;
});

if (exposureRange) exposureRange.addEventListener('input', () => {
  CONFIG.EXPOSURE = parseFloat(exposureRange.value);
  const sign = CONFIG.EXPOSURE > 0 ? '+' : '';
  exposureVal.textContent = `${sign}${CONFIG.EXPOSURE.toFixed(1)}`;
  video.style.filter = CONFIG.EXPOSURE !== 0
    ? `brightness(${Math.round(Math.pow(2, CONFIG.EXPOSURE) * 100)}%)`
    : '';
});

if (sendEmailBtn) sendEmailBtn.addEventListener('click', sendEmail);

// ============================================================
// DOWNLOAD SESSION
// ============================================================
if (downloadBtn) downloadBtn.addEventListener('click', async () => {
  if (shotHistory.length === 0) return;

  const origText     = downloadBtn.textContent;
  if (downloadBtn) downloadBtn.disabled = true;
  downloadBtn.textContent = '⏳ 準備中';

  const now     = new Date();
  const summary = {
    exportedAt: now.toISOString(),
    totalShots: shotHistory.length,
    bestScore:  parseFloat(Math.max(...shotHistory.map(s => s.score)).toFixed(3)),
    avgScore:   parseFloat(
      (shotHistory.reduce((a, s) => a + s.score, 0) / shotHistory.length).toFixed(3)
    ),
    shots: shotHistory.map((s, i) => ({
      index:     i + 1,
      timestamp: new Date(s.ts).toISOString(),
      score:     parseFloat(s.score.toFixed(3)),
      smiling:   s.smiling,
      faces:     s.faces ?? 0,
    })),
  };

  try {
    if (typeof JSZip !== 'undefined') {
      const zip = new JSZip();
      zip.file('summary.json', JSON.stringify(summary, null, 2));
      shotHistory.forEach((shot, i) => {
        const b64  = shot.dataUrl.split(',')[1];
        const name = `shot_${String(i + 1).padStart(2, '0')}_${Math.round(shot.score * 100)}pct.jpg`;
        zip.file(name, b64, { base64: true });
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href:     url,
        download: `smile-session-${Date.now()}.zip`,
      }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } else {
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href:     url,
        download: `smile-summary-${Date.now()}.json`,
      }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } finally {
    downloadBtn.disabled    = false;
    downloadBtn.textContent = origText;
  }
});

updateThresholdMarker();
