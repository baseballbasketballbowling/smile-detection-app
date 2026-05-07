// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  BATCH_SIZE:        6,
  CAPTURE_INTERVAL:  500,
  SMILE_THRESHOLD:   0.72,
  COOLDOWN_MS:       3000,
  CAPTURE_W:         640,
  CAPTURE_H:         480,
  API_W:             320,
  API_H:             240,
  API_QUALITY:       0.75,
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
let frameBuffer    = [];
let shotHistory    = [];

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

const capCanvas = $('capture-canvas');
const capCtx    = capCanvas.getContext('2d');
const apiCanvas = $('api-canvas');
const apiCtx    = apiCanvas.getContext('2d');

capCanvas.width  = CONFIG.CAPTURE_W;
capCanvas.height = CONFIG.CAPTURE_H;
apiCanvas.width  = CONFIG.API_W;
apiCanvas.height = CONFIG.API_H;

// ============================================================
// CAMERA
// ============================================================
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:      { ideal: CONFIG.CAPTURE_W },
      height:     { ideal: CONFIG.CAPTURE_H },
      facingMode: facingMode,
    },
    audio: false,
  });
  video.srcObject = stream;
  video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';
  return new Promise(resolve => { video.onloadedmetadata = resolve; });
}

function stopCamera() {
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

async function switchCamera() {
  if (!isRunning || cameraSwitchBtn.disabled) return;
  cameraSwitchBtn.disabled = true;
  const prev = facingMode;
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  stopCamera();
  frameBuffer  = [];
  batchPending = false;
  try {
    await startCamera();
    setStatus('カメラを切り替えました');
  } catch {
    facingMode = prev;
    try { await startCamera(); } catch (_) {}
    setStatus('カメラが1つしかありません', 'error');
  } finally {
    cameraSwitchBtn.disabled = false;
  }
}

// ============================================================
// FRAME CAPTURE
// ============================================================
function captureFrame() {
  if (!isRunning || isInCooldown) return;

  const frameId = frameIdCounter++;

  capCtx.drawImage(video, 0, 0, CONFIG.CAPTURE_W, CONFIG.CAPTURE_H);
  const fullDataUrl = capCanvas.toDataURL('image/jpeg', 0.92);

  apiCtx.drawImage(video, 0, 0, CONFIG.API_W, CONFIG.API_H);
  const apiBase64 = apiCanvas.toDataURL('image/jpeg', CONFIG.API_QUALITY).split(',')[1];

  frameBuffer.push({ id: frameId, fullDataUrl, apiBase64, ts: Date.now() });
  if (frameBuffer.length > CONFIG.BATCH_SIZE * 2) frameBuffer.shift();

  updateFrameCounter();

  if (!batchPending && frameBuffer.length >= CONFIG.BATCH_SIZE) {
    const batch = frameBuffer.splice(0, CONFIG.BATCH_SIZE);
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
      `  (2) "smiling": count of people clearly smiling (smile score > 0.5)`,
      `Reply ONLY with valid JSON — no markdown, no explanation:`,
      `{"scores":[${Array(batch.length).fill('0.0').join(',')}],"smiling":[${Array(batch.length).fill('0').join(',')}]}`,
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
    const smiling = Array.isArray(parsed.smiling)
      ? parsed.smiling.map(n => Math.max(0, parseInt(n) || 0))
      : scores.map(() => 0);

    onBatchResult(scores, smiling, batch);

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
function onBatchResult(scores, smilingCounts, batch) {
  if (!isRunning || scores.length === 0) return;

  let bestScore = 0, bestIndex = 0, bestSmiling = 0;
  scores.forEach((s, i) => {
    if (s > bestScore) {
      bestScore   = s;
      bestIndex   = i;
      bestSmiling = smilingCounts[i] ?? 0;
    }
  });

  updateSmileBar(bestScore, bestSmiling);

  if (!isInCooldown && bestScore >= CONFIG.SMILE_THRESHOLD) {
    triggerShutter(batch[bestIndex].fullDataUrl, bestScore, Math.max(1, bestSmiling));
  }
}

// ============================================================
// SHUTTER
// ============================================================
function triggerShutter(dataUrl, score, smiling = 1) {
  if (isInCooldown) return;
  isInCooldown = true;
  frameBuffer  = [];

  triggerFlash();
  cameraWrapper.classList.add('pulse');
  setTimeout(() => cameraWrapper.classList.remove('pulse'), 600);

  addToGallery(dataUrl, score, smiling);

  shotHistory.unshift({ dataUrl, score, smiling, ts: Date.now() });
  if (shotHistory.length > 10) shotHistory.pop();
  updateBestShot();

  setBadge('cooldown');
  const smilingLabel = smiling > 1 ? ` / ${smiling}人笑顔` : '';
  setStatus(`撮影完了！ ${Math.round(score * 100)}%${smilingLabel}  — ${(CONFIG.COOLDOWN_MS / 1000).toFixed(1)}秒後に再開`);

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
    <span class="best-shot-people">${best.smiling > 1 ? `笑顔 ${best.smiling}人` : ''}</span>`;
  bestShotCard.append(img, badge, info);
}

// ============================================================
// GALLERY
// ============================================================
function addToGallery(dataUrl, score, smiling) {
  galleryEmpty.style.display = 'none';
  const item = document.createElement('div');
  item.className = 'gallery-item';
  const img = Object.assign(document.createElement('img'), { src: dataUrl, loading: 'lazy', alt: '笑顔写真' });
  const info = document.createElement('div');
  info.className = 'gallery-item-info';
  const ts = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const smilingTxt = smiling > 1 ? `<span class="gallery-smiling">${smiling}人</span>` : '';
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
function updateSmileBar(score, smiling = 0) {
  smileFill.style.width = `${Math.round(score * 100)}%`;
  const suf = smiling > 1 ? ` / ${smiling}人` : '';
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

updateThresholdMarker();
