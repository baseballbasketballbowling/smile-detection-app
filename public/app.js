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

const capCanvas = $('capture-canvas');
const capCtx    = capCanvas.getContext('2d');
const apiCanvas = $('api-canvas');
const apiCtx    = apiCanvas.getContext('2d');

// Canvas dimensions are set dynamically when camera starts (video.onloadedmetadata)

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
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      capCanvas.width  = vw;
      capCanvas.height = vh;
      const scale = Math.min(CONFIG.API_W / vw, CONFIG.API_H / vh);
      apiCanvas.width  = Math.round(vw * scale);
      apiCanvas.height = Math.round(vh * scale);
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

  const frameId  = frameIdCounter++;
  const bFilter  = CONFIG.EXPOSURE !== 0
    ? `brightness(${Math.round(Math.pow(2, CONFIG.EXPOSURE) * 100)}%)`
    : 'none';

  capCtx.filter = bFilter;
  capCtx.drawImage(video, 0, 0, capCanvas.width, capCanvas.height);
  capCtx.filter = 'none';
  const fullDataUrl = capCanvas.toDataURL('image/jpeg', CONFIG.PHOTO_QUALITY);

  apiCtx.filter = bFilter;
  apiCtx.drawImage(video, 0, 0, apiCanvas.width, apiCanvas.height);
  apiCtx.filter = 'none';
  const apiBase64 = apiCanvas.toDataURL('image/jpeg', CONFIG.API_QUALITY).split(',')[1];

  frameBuffer.push({ id: frameId, fullDataUrl, apiBase64, ts: Date.now() });
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
      `Reply ONLY with valid JSON — no markdown, no explanation:`,
      `{"scores":[${Array(batch.length).fill('0.0').join(',')}],"faces":[${Array(batch.length).fill('0').join(',')}],"smiling":[${Array(batch.length).fill('0').join(',')}],"kanpai":[${Array(batch.length).fill('false').join(',')}]}`,
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

    // Haikuが前後にテキストを足してもJSONブロックだけ抽出する
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
      ? parsed.smiling.map(n => Math.max(0, parseInt(n) || 0))
      : scores.map(() => 0);
    const kanpai  = Array.isArray(parsed.kanpai)
      ? parsed.kanpai.map(k => k === true || k === 'true')
      : scores.map(() => false);

    onBatchResult(scores, smiling, faces, kanpai, batch);

  } catch (e) {
    errorOccurred = true;
    console.error('[analyzeBatch]', e.message);   // DevToolsで確認できる
    if (isRunning) setStatus(`エラー: ${e.message}`, 'error');
  } finally {
    batchPending = false;
    apiIndicator.textContent = '';
    if (isRunning && !isInCooldown && frameBuffer.length >= CONFIG.BATCH_SIZE) {
      const next = frameBuffer.splice(0, CONFIG.BATCH_SIZE);
      analyzeBatch(next);
    } else if (isRunning && !isInCooldown && !errorOccurred) {
      // エラー時はメッセージを上書きせず残す
      setStatus('笑顔を検出中...');
    }
  }
}

// ============================================================
// BATCH RESULT
// ============================================================
function onBatchResult(scores, smilingCounts, faceCounts, kanpaiFlags, batch) {
  if (!isRunning || scores.length === 0) return;

  // ── 既存のスマイル判定（変更なし）──────────────────────────
  let bestScore = 0, bestIndex = 0, bestSmiling = 0, bestFaces = 0;
  scores.forEach((s, i) => {
    if (s > bestScore) {
      bestScore   = s;
      bestIndex   = i;
      bestSmiling = smilingCounts[i] ?? 0;
      bestFaces   = faceCounts[i] ?? 0;
    }
  });

  updateSmileBar(bestScore, bestSmiling, bestFaces);

  if (!isInCooldown && bestScore >= CONFIG.SMILE_THRESHOLD) {
    triggerShutter(batch[bestIndex].fullDataUrl, bestScore, Math.max(1, bestSmiling), bestFaces);
  }
  // ────────────────────────────────────────────────────────────

  // 乾杯検知（既存処理とは独立。エラーが出ても既存処理に影響しない）
  try {
    const kanpaiIdx = Array.isArray(kanpaiFlags)
      ? kanpaiFlags.findIndex(k => k === true)
      : -1;
    if (!isInCooldown && kanpaiIdx >= 0) {
      const kScore   = scores[kanpaiIdx]        ?? bestScore;
      const kSmiling = smilingCounts[kanpaiIdx] ?? bestSmiling;
      const kFaces   = faceCounts[kanpaiIdx]    ?? bestFaces;
      triggerShutter(batch[kanpaiIdx].fullDataUrl, kScore, Math.max(1, kSmiling), kFaces, 'kanpai');
    }
  } catch (e) {
    console.warn('[kanpai]', e.message);
  }
}

// ============================================================
// SHUTTER
// ============================================================
function triggerShutter(dataUrl, score, smiling = 1, faces = 0, reason = 'smile') {
  if (isInCooldown) return;
  isInCooldown = true;
  frameBuffer  = [];

  triggerFlash();
  cameraWrapper.classList.add('pulse');
  setTimeout(() => cameraWrapper.classList.remove('pulse'), 600);

  addToGallery(dataUrl, score, smiling, faces);

  shotHistory.unshift({ dataUrl, score, smiling, faces, ts: Date.now() });
  if (shotHistory.length > 10) shotHistory.pop();
  updateBestShot();
  if (downloadBtn) downloadBtn.disabled = false;

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

  const best = [...shotHistory].sort((a, b) =>
    b.smiling !== a.smiling ? b.smiling - a.smiling : b.score - a.score
  )[0];

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
  frameIdCounter = 0; frameBuffer = [];
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
  frameBuffer = []; batchPending = false;
  setBadge('idle');
  setStatus('停止しました');
  updateSmileBar(0);
  smileScoreTxt.textContent = '--';
  apiIndicator.textContent  = '';
}

// ============================================================
// EVENT LISTENERS
// ============================================================
startBtn.addEventListener('click', startDetection);
stopBtn.addEventListener('click', stopDetection);
cameraSwitchBtn.addEventListener('click', switchCamera);

manualBtn.addEventListener('click', () => {
  if (!isRunning || isInCooldown) return;
  capCtx.drawImage(video, 0, 0, CONFIG.CAPTURE_W, CONFIG.CAPTURE_H);
  triggerShutter(capCanvas.toDataURL('image/jpeg', 0.92), 1.0, 1);
});

clearBtn.addEventListener('click', () => {
  galleryGrid.innerHTML = '';
  galleryEmpty.style.display = '';
  shotHistory = [];
  bestShotSection.style.display = 'none';
  bestShotCard.innerHTML = '';
  if (downloadBtn) downloadBtn.disabled = true;
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
  // CSS filter: video preview
  video.style.filter = CONFIG.EXPOSURE !== 0
    ? `brightness(${Math.round(Math.pow(2, CONFIG.EXPOSURE) * 100)}%)`
    : '';
});

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
      // Fallback: JSON summary only (JSZip not loaded)
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
