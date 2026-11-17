const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let width = window.innerWidth;
let height = window.innerHeight;
let dpr = 1;
let lastFrameTime = performance.now();
let wavePhase = 0;
let animationId;

// Live Settings Controlled by LivelyProperties.json
const settings = {
  waveMultiplier: 1.0,
  stormSensitivity: 1.0,
  showClock: true,
  showHorizonDetails: true
};

const THEME = {
  bgTop: '#0b0c0e',
  bgBottom: '#16181d',
  ribbons: [
    { top: 'rgba(113, 113, 122, 0.36)', bottom: 'rgba(11, 12, 14, 0.0)', rim: 'rgba(244, 244, 245, 0.30)' },
    { top: 'rgba(161, 161, 170, 0.38)', bottom: 'rgba(11, 12, 14, 0.0)', rim: 'rgba(255, 255, 255, 0.38)' },
    { top: 'rgba(212, 212, 216, 0.34)', bottom: 'rgba(22, 24, 29, 0.0)', rim: 'rgba(255, 255, 255, 0.48)' },
    { top: 'rgba(63, 63, 70, 0.72)',    bottom: 'rgba(9, 10, 12, 0.96)', rim: 'rgba(228, 228, 231, 0.25)' }
  ],
  boatGlow: 'rgba(255, 255, 255, 0.16)'
};

let cachedBgGrad = null;
let cachedRibbonGrads = [];
let cachedDateStr = '';
let cachedTimeStr = '';
let lastMinute = -1;

const mouse = {
  x: 0.5,
  y: 0.5,
  targetX: 0.5,
  targetY: 0.5,
  px: width * 0.5,
  py: height * 0.5,
  lastPx: width * 0.5,
  lastPy: height * 0.5,
  windSwipeX: 0,
  active: false
};

const audio = {
  bands: new Array(64).fill(0),
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
  smoothBass: 0,
  smoothMid: 0,
  smoothTreble: 0,
  smoothEnergy: 0,
  lastAudioPacket: 0,
  peakTracker: 0.05
};

const weather = {
  stormLevel: 0,
  lightningAlpha: 0,
  lightningBolt: [],
  lightningBranch: [],
  lightningImpact: null,
  raindrops: [],
  sprayParticles: [],
  windStreaks: [],
  sparkles: [],
  birds: []
};

const boat = {
  worldDistance: 0,
  baseSpeed: 1.4,
  screenX: width * 0.46,
  screenY: height * 0.62,
  vy: 0,
  angle: 0,
  prevAngle: 0,
  lanternAngle: 0,
  lanternVel: 0,
  inAir: false,
  initialized: false,
  hovered: false
};

// 3-Mode Lyrics State: 0 = Off | 1 = Apple Music Floating | 2 = Wave-Curved
const lyricsState = {
  mode: 0,
  fadeAlpha: 0,
  trackKey: '',
  title: '',
  artist: '',
  lines: [],
  isSynced: false,
  statusText: 'Waiting for Spotify track info...',
  positionSec: 0,
  lastSyncTime: 0,
  isPlaying: false,
  reportedPlaying: true,
  smoothActiveIdx: 0
};

function rebuildGradients() {
  cachedBgGrad = ctx.createLinearGradient(0, 0, width * 0.3, height);
  cachedBgGrad.addColorStop(0, THEME.bgTop);
  cachedBgGrad.addColorStop(1, THEME.bgBottom);

  cachedRibbonGrads = THEME.ribbons.map(function (ribbon, idx) {
    const baseY = height * (0.34 + idx * 0.14);
    const amp = height * (0.11 - idx * 0.012);
    const grad = ctx.createLinearGradient(0, baseY - amp * 1.5, 0, height);
    grad.addColorStop(0, ribbon.top);
    grad.addColorStop(1, ribbon.bottom);
    return grad;
  });
}

function fitToScreen() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  width = window.innerWidth || document.documentElement.clientWidth || 1920;
  height = window.innerHeight || document.documentElement.clientHeight || 1080;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  rebuildGradients();
  initAtmosphere();
}

window.addEventListener('resize', fitToScreen);

// --- Lively Properties Listener ---
function livelyPropertyListener(name, val) {
  if (name === 'waveScale') {
    settings.waveMultiplier = Number(val) / 100;
  } else if (name === 'stormSensitivity') {
    settings.stormSensitivity = Number(val) / 100;
  } else if (name === 'showClock') {
    settings.showClock = Boolean(val);
  } else if (name === 'showHorizonDetails') {
    settings.showHorizonDetails = Boolean(val);
  }
}
window.livelyPropertyListener = livelyPropertyListener;

// --- Lively Audio Listener ---
function livelyAudioListener(audioData) {
  let arr = audioData;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (e) { return; }
  }
  if (!arr || !arr.length) return;

  let frameMax = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]) || 0;
    if (v > frameMax) frameMax = v;
  }

  if (frameMax > 0.0005) {
    audio.lastAudioPacket = performance.now();
    audio.peakTracker = Math.max(frameMax, audio.peakTracker * 0.992);
  }

  const gain = frameMax > 0.0005 ? (1 / Math.max(0.02, audio.peakTracker)) : 1;
  const step = Math.max(1, Math.floor(arr.length / 64));

  for (let i = 0; i < 64; i++) {
    const raw = Number(arr[i * step]) || 0;
    audio.bands[i] = Math.min(1, raw * gain);
  }

  computeAudioLevels();
}
window.livelyAudioListener = livelyAudioListener;

function parsePositionSeconds(pos) {
  if (typeof pos === 'number') {
    return pos > 3600 ? pos / 1000 : pos;
  }
  if (typeof pos === 'string' && pos.indexOf(':') !== -1) {
    const parts = pos.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return Number(pos) || 0;
}

function getCurrentLyricTime() {
  if (lyricsState.isPlaying && lyricsState.lastSyncTime > 0) {
    return lyricsState.positionSec + (performance.now() - lyricsState.lastSyncTime) / 1000;
  }
  return lyricsState.positionSec;
}

function setLyricPlaybackState(shouldPlay) {
  if (lyricsState.isPlaying === shouldPlay) return;
  if (shouldPlay) {
    lyricsState.lastSyncTime = performance.now();
    lyricsState.isPlaying = true;
  } else {
    lyricsState.positionSec = getCurrentLyricTime();
    lyricsState.isPlaying = false;
  }
}

function livelyCurrentTrack(data) {
  let info = data;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch (e) { return; }
  }
  if (!info) return;

  const title = String(info.Title || '').trim();
  const artist = String(info.Artist || '').trim();
  if (!title) return;

  const newKey = title + ' - ' + artist;

  if (info.PlaybackState !== undefined && info.PlaybackState !== null) {
    const st = String(info.PlaybackState).toLowerCase();
    const isPaused = st === 'paused' || st === 'stopped' || st === 'closed' || st === '2' || st === '4' || st === '5' || info.PlaybackState === false;
    lyricsState.reportedPlaying = !isPaused;
    setLyricPlaybackState(!isPaused);
  }

  if (info.Position !== undefined && info.Position !== null) {
    const parsedPos = parsePositionSeconds(info.Position);
    if (parsedPos > 0 || newKey !== lyricsState.trackKey) {
      lyricsState.positionSec = parsedPos;
      lyricsState.lastSyncTime = performance.now();
    }
  }

  if (newKey !== lyricsState.trackKey) {
    lyricsState.trackKey = newKey;
    lyricsState.title = title;
    lyricsState.artist = artist;
    lyricsState.lines = [];
    lyricsState.isSynced = false;
    lyricsState.smoothActiveIdx = 0;
    lyricsState.positionSec = parsePositionSeconds(info.Position);
    lyricsState.lastSyncTime = performance.now();
    lyricsState.statusText = 'Fetching lyrics for ' + title + '...';
    fetchLyricsForTrack(title, artist);
  }
}
window.livelyCurrentTrack = livelyCurrentTrack;

function parseLRC(lrcText) {
  const result = [];
  const rows = lrcText.split('\n');
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/;

  for (let i = 0; i < rows.length; i++) {
    const match = timeRegex.exec(rows[i]);
    if (match) {
      const mins = parseInt(match[1], 10) || 0;
      const secs = parseInt(match[2], 10) || 0;
      const msStr = match[3] ? match[3].padEnd(3, '0') : '0';
      const ms = parseInt(msStr, 10) || 0;
      const text = rows[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
      if (text) {
        result.push({ time: mins * 60 + secs + ms / 1000, text: text });
      }
    }
  }
  result.sort(function (a, b) { return a.time - b.time; });
  return result;
}

function cleanTrackName(rawTitle) {
  return rawTitle
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .trim();
}

async function fetchLyricsForTrack(title, artist) {
  const cleanedTitle = cleanTrackName(title);
  const primaryArtist = artist.split(',')[0].trim();

  try {
    let res = await fetch(
      'https://lrclib.net/api/get?track_name=' + encodeURIComponent(cleanedTitle) +
      '&artist_name=' + encodeURIComponent(primaryArtist)
    );
    let trackData = res.ok ? await res.json() : null;

    if (!trackData || (!trackData.syncedLyrics && !trackData.plainLyrics)) {
      const searchRes = await fetch(
        'https://lrclib.net/api/search?q=' + encodeURIComponent(cleanedTitle + ' ' + primaryArtist)
      );
      if (searchRes.ok) {
        const list = await searchRes.json();
        if (Array.isArray(list) && list.length > 0) {
          trackData = list.find(function (item) { return item.syncedLyrics; }) || list[0];
        }
      }
    }

    if (trackData && trackData.syncedLyrics) {
      lyricsState.lines = parseLRC(trackData.syncedLyrics);
      lyricsState.isSynced = true;
      lyricsState.statusText = '';
    } else if (trackData && trackData.plainLyrics) {
      lyricsState.lines = trackData.plainLyrics.split('\n').filter(Boolean).map(function (line, idx) {
        return { time: idx * 3.5, text: line.trim() };
      });
      lyricsState.isSynced = false;
      lyricsState.statusText = '';
    } else {
      lyricsState.statusText = 'No lyrics found for ' + title;
    }
  } catch (err) {
    lyricsState.statusText = title + ' — ' + artist;
  }
}

function registerWallpaperEngineAudio() {
  if (window.wallpaperRegisterAudioListener) {
    window.wallpaperRegisterAudioListener(function (arr) {
      if (arr && arr.length) livelyAudioListener(arr);
    });
  }
}
registerWallpaperEngineAudio();
window.addEventListener('load', registerWallpaperEngineAudio);

function computeAudioLevels() {
  let b = 0, m = 0, t = 0;
  for (let i = 0; i < 6; i++) b += audio.bands[i];
  for (let i = 6; i < 28; i++) m += audio.bands[i];
  for (let i = 28; i < 64; i++) t += audio.bands[i];
  const sens = settings.stormSensitivity;

  audio.bass = Math.min(1, (b / 6) * 1.35 * sens);
  audio.mid = Math.min(1, (m / 22) * sens);
  audio.treble = Math.min(1, (t / 36) * sens);
  audio.energy = Math.min(1, audio.bass * 0.70 + audio.mid * 0.20 + audio.treble - 0.10);
}

function decayAudioWhenSilent() {
  const silentMs = performance.now() - audio.lastAudioPacket;
  if (silentMs > 250) {
    audio.bass *= 0.92;
    audio.mid *= 0.92;
    audio.treble *= 0.92;
    audio.energy *= 0.92;
  }
  if (audio.lastAudioPacket > 0) {
    if (silentMs > 650) {
      setLyricPlaybackState(false);
    } else if (lyricsState.reportedPlaying) {
      setLyricPlaybackState(true);
    }
  }
}

function isMouseOverBoat(mx, my) {
  const dx = mx - boat.screenX;
  const dy = my - (boat.screenY - 14);
  return Math.abs(dx) < 38 && Math.abs(dy) < 34;
}

window.addEventListener('mousemove', function (e) {
  const dx = e.clientX - mouse.lastPx;
  mouse.lastPx = e.clientX;
  mouse.lastPy = e.clientY;

  if (mouse.active && Math.abs(dx) > 18) {
    mouse.windSwipeX = Math.max(-12, Math.min(12, mouse.windSwipeX + dx * 0.18));
    if (weather.windStreaks.length < 18) {
      weather.windStreaks.push({
        x: e.clientX,
        y: e.clientY + (Math.random() - 0.5) * 40,
        vx: dx * 0.45,
        length: 45 + Math.min(90, Math.abs(dx) * 1.8),
        alpha: 0.35
      });
    }
  }
  mouse.targetX = e.clientX / width;
  mouse.targetY = e.clientY / height;
  mouse.active = true;
  boat.hovered = isMouseOverBoat(e.clientX, e.clientY);
  canvas.style.cursor = boat.hovered ? 'pointer' : 'default';
});

window.addEventListener('mousedown', function (e) {
  if (isMouseOverBoat(e.clientX, e.clientY)) {
    lyricsState.mode = (lyricsState.mode + 1) % 3;
  }
});

window.addEventListener('mouseout', function () {
  mouse.active = false;
  boat.hovered = false;
});

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    cancelAnimationFrame(animationId);
  } else {
    lastFrameTime = performance.now();
    animate();
  }
});

function initAtmosphere() {
  weather.raindrops = [];
  for (let i = 0; i < 220; i++) {
    weather.raindrops.push({
      x: Math.random() * (width + 300) - 150,
      y: Math.random() * height,
      speed: 14 + Math.random() * 12,
      length: 14 + Math.random() * 18
    });
  }

  weather.sparkles = [];
  for (let i = 0; i < 42; i++) {
    weather.sparkles.push({
      nx: Math.random(),
      layer: Math.random() < 0.65 ? 2 : 3,
      phase: Math.random() * Math.PI * 2,
      size: 1.1 + Math.random() * 1.2
    });
  }

  weather.birds = [];
  for (let i = 0; i < 5; i++) {
    weather.birds.push({
      x: width * (0.15 + Math.random() * 0.7),
      y: height * (0.14 + Math.random() * 0.16),
      speed: 0.35 + Math.random() * 0.25,
      wingPhase: Math.random() * Math.PI * 2,
      scale: 0.7 + Math.random() * 0.4
    });
  }
}

function triggerLightning() {
  weather.lightningAlpha = 0.65 + Math.random() * 0.30;
  weather.lightningBolt = [];
  weather.lightningBranch = [];
  const safeMargin = 170;
  const strikeLeft = Math.random() < 0.5;
  let strikeX;

  if (strikeLeft && boat.screenX - safeMargin > 80) {
    strikeX = 60 + Math.random() * (boat.screenX - safeMargin - 60);
  } else if (boat.screenX + safeMargin < width - 80) {
    strikeX = (boat.screenX + safeMargin) + Math.random() * (width - 80 - (boat.screenX + safeMargin));
  } else {
    strikeX = 80;
  }

  const targetLayer = Math.random() < 0.45 ? 2 : 3;
  const strikeY = getWaveY(strikeX, targetLayer);
  let lx = strikeX + (Math.random() - 0.5) * 140;
  const segments = 14;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const guideX = lx + (strikeX - lx) * t;
    const jitterX = (i === 0 || i === segments) ? 0 : (Math.random() - 0.5) * 46;
    const curX = guideX + jitterX;
    const curY = strikeY * t;
    weather.lightningBolt.push({ x: curX, y: curY });

    if (i === 6) {
      let bx = curX;
      let by = curY;
      const branchDir = strikeLeft ? -1 : 1;
      for (let b = 0; b < 5; b++) {
        weather.lightningBranch.push({ x: bx, y: by });
        bx += branchDir * (12 + Math.random() * 18);
        by += 18 + Math.random() * 20;
      }
    }
  }

  weather.lightningImpact = { x: strikeX, layer: targetLayer, radius: 8, alpha: 0.95 };
  for (let s = 0; s < 18; s++) {
    weather.sprayParticles.push({
      x: strikeX + (Math.random() - 0.5) * 16,
      y: strikeY,
      vx: (Math.random() - 0.5) * 6.5,
      vy: -3.5 - Math.random() * 6.5,
      size: 1.4 + Math.random() * 1.8,
      alpha: 0.75 + Math.random() * 0.25
    });
  }
}

function spawnBowSpray(x, y, intensity, countOverride) {
  if (weather.sprayParticles.length > 110) return;
  const count = countOverride || Math.ceil(intensity * 3);
  for (let i = 0; i < count; i++) {
    weather.sprayParticles.push({
      x: x + (Math.random() - 0.5) * 14,
      y: y + (Math.random() - 0.5) * 4,
      vx: (Math.random() - 0.65) * (3 + intensity * 4.5),
      vy: -1.8 - Math.random() * (2.8 + intensity * 3.8),
      size: 1.1 + Math.random() * 1.5,
      alpha: 0.5 + Math.random() * 0.4
    });
  }
}

function updateAndDrawSpray(dtScale) {
  for (let i = weather.sprayParticles.length - 1; i >= 0; i--) {
    const p = weather.sprayParticles[i];
    p.x += p.vx * dtScale;
    p.y += p.vy * dtScale;
    p.vy += 0.22 * dtScale;
    p.alpha -= 0.022 * dtScale;
    if (p.alpha <= 0.02) {
      weather.sprayParticles.splice(i, 1);
      continue;
    }
    ctx.fillStyle = 'rgba(244, 244, 245, ' + p.alpha + ')';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMacClock() {
  if (!settings.showClock) return;
  const now = new Date();
  const min = now.getMinutes();
  if (min !== lastMinute) {
    lastMinute = min;
    cachedTimeStr = String(now.getHours()).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    cachedDateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  const clockX = width * 0.5 + (mouse.x - 0.5) * 14;
  const clockY = height * 0.16 + (mouse.y - 0.5) * 8;

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(228, 228, 231, 0.55)';
  ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  ctx.fillText(cachedDateStr, clockX, clockY - 58);

  ctx.fillStyle = 'rgba(244, 244, 245, 0.78)';
  ctx.font = '200 84px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  ctx.fillText(cachedTimeStr, clockX, clockY + 12);
}

function drawHorizonAtmosphere(dtScale) {
  if (!settings.showHorizonDetails) return;
  const stormFade = Math.max(0.15, 1 - weather.stormLevel * 1.1);

  // Crescent Moon
  const moonX = width * 0.82 - (mouse.x - 0.5) * 12;
  const moonY = height * 0.17 - (mouse.y - 0.5) * 8;
  ctx.save();
  ctx.globalAlpha = 0.75 * stormFade;
  const moonGlow = ctx.createRadialGradient(moonX, moonY, 6, moonX, moonY, 130);
  moonGlow.addColorStop(0, 'rgba(244, 244, 245, 0.22)');
  moonGlow.addColorStop(1, 'rgba(244, 244, 245, 0)');
  ctx.fillStyle = moonGlow;
  ctx.beginPath();
  ctx.arc(moonX, moonY, 130, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f4f4f5';
  ctx.beginPath();
  ctx.arc(moonX, moonY, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = THEME.bgTop;
  ctx.beginPath();
  ctx.arc(moonX - 7, moonY - 5, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();





  // Minimalist Birds
  const birdAlpha = Math.max(0, 0.38 - weather.stormLevel * 0.85);
  if (birdAlpha > 0.02) {
    ctx.save();
    ctx.strokeStyle = 'rgba(228, 228, 231, ' + birdAlpha + ')';
    ctx.lineWidth = 1.2;
    for (let b = 0; b < weather.birds.length; b++) {
      const bird = weather.birds[b];
      bird.x += bird.speed * dtScale;
      bird.wingPhase += 0.08 * dtScale;
      if (bird.x > width + 40) bird.x = -40;
      const bx = bird.x - (mouse.x - 0.5) * 16;
      const by = bird.y + Math.sin(bird.wingPhase * 0.5) * 4 - (mouse.y - 0.5) * 10;
      const flap = Math.sin(bird.wingPhase) * 4 * bird.scale;
      const span = 8 * bird.scale;
      ctx.beginPath();
      ctx.moveTo(bx - span, by - flap);
      ctx.quadraticCurveTo(bx - span * 0.4, by - 4, bx, by);
      ctx.quadraticCurveTo(bx + span * 0.4, by - 4, bx + span, by - flap);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawWaveSparkles(layerIndex, dtScale) {
  const trebleBoost = audio.smoothTreble;
  if (trebleBoost < 0.04 && weather.stormLevel > 0.4) return;
  for (let i = 0; i < weather.sparkles.length; i++) {
    const sp = weather.sparkles[i];
    if (sp.layer !== layerIndex) continue;
    sp.phase += (0.04 + trebleBoost * 0.08) * dtScale;
    const twinkle = Math.max(0, Math.sin(sp.phase));
    const alpha = twinkle * (0.14 + trebleBoost * 0.55);
    if (alpha > 0.03) {
      const sx = sp.nx * width;
      const sy = getWaveY(sx, layerIndex) + 2;
      ctx.fillStyle = 'rgba(255, 255, 255, ' + alpha + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, sp.size * (0.8 + trebleBoost * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function wrapLyricLines(text, maxWidth) {
  const words = text.split(' ');
  const wrapped = [];
  let currentLine = '';
  for (let i = 0; i < words.length; i++) {
    const testLine = currentLine ? currentLine + ' ' + words[i] : words[i];
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      wrapped.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) wrapped.push(currentLine);
  return wrapped;
}

function drawTextAlongWave(text, centerX, layerIndex, yOffset, fontStr, fillStyle) {
  ctx.save();
  ctx.font = fontStr;
  ctx.fillStyle = fillStyle;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const totalWidth = ctx.measureText(text).width;
  let cursorX = centerX - totalWidth * 0.5;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const chW = ctx.measureText(ch).width;
    const midX = cursorX + chW * 0.5;
    if (midX > -40 && midX < width + 40) {
      const waveY = getWaveY(midX, layerIndex) + yOffset;
      const y1 = getWaveY(midX - 8, layerIndex);
      const y2 = getWaveY(midX + 8, layerIndex);
      const slopeAngle = Math.atan2(y2 - y1, 16);
      ctx.save();
      ctx.translate(midX, waveY);
      ctx.rotate(slopeAngle);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    }
    cursorX += chW;
  }
  ctx.restore();
}

function drawLyricsOverlay(dtScale) {
  const targetAlpha = lyricsState.mode > 0 ? 1 : 0;
  lyricsState.fadeAlpha += (targetAlpha - lyricsState.fadeAlpha) * 0.10 * dtScale;
  if (lyricsState.fadeAlpha <= 0.01) return;

  const currentTime = getCurrentLyricTime();
  let activeIndex = 0;
  for (let i = 0; i < lyricsState.lines.length; i++) {
    if (currentTime >= lyricsState.lines[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  lyricsState.smoothActiveIdx += (activeIndex - lyricsState.smoothActiveIdx) * 0.14 * dtScale;
  ctx.save();
  ctx.globalAlpha = lyricsState.fadeAlpha;

  if (lyricsState.mode === 2) {
    const activeText = lyricsState.lines.length > 0 ? lyricsState.lines[activeIndex].text : lyricsState.statusText;
    const nextText = (lyricsState.lines.length > 0 && activeIndex + 1 < lyricsState.lines.length) ? lyricsState.lines[activeIndex + 1].text : '';
    const waveCenterX = width * 0.5 + (mouse.x - 0.5) * 30;

    drawTextAlongWave(
      activeText, waveCenterX, 3, 36,
      '700 26px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      lyricsState.isPlaying ? 'rgba(255, 255, 255, 0.94)' : 'rgba(255, 255, 255, 0.55)'
    );
    if (nextText) {
      drawTextAlongWave(
        nextText, waveCenterX, 3, 74,
        '500 18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        'rgba(228, 228, 231, 0.36)'
      );
    }
    ctx.restore();
    return;
  }

  ctx.textAlign = 'left';
  const anchorX = Math.max(48, width * 0.06);
  const maxTextWidth = Math.min(460, width * 0.34);
  const headerY = height * 0.27;

  if (lyricsState.title) {
    ctx.fillStyle = 'rgba(244, 244, 245, 0.48)';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    let headerText = lyricsState.title.toUpperCase() + (lyricsState.artist ? ' • ' + lyricsState.artist.toUpperCase() : '');
    if (!lyricsState.isPlaying) headerText += ' (PAUSED)';

    while (ctx.measureText(headerText).width > maxTextWidth && headerText.length > 10) {
      headerText = headerText.slice(0, -4) + '...';
    }
    ctx.fillText(headerText, anchorX, headerY);
  }

  const lyricsStartY = headerY + 56;
  if (lyricsState.lines.length === 0) {
    ctx.fillStyle = 'rgba(244, 244, 245, 0.78)';
    ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const statusWrapped = wrapLyricLines(lyricsState.statusText, maxTextWidth);
    for (let s = 0; s < statusWrapped.length; s++) {
      ctx.fillText(statusWrapped[s], anchorX, lyricsStartY + s * 32);
    }
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.rect(anchorX - 10, lyricsStartY - 30, maxTextWidth + 20, height * 0.56);
  ctx.clip();

  const scrollFrac = lyricsState.smoothActiveIdx - activeIndex;
  let cursorY = lyricsStartY - scrollFrac * 52;
  const startIdx = Math.max(0, activeIndex - 1);
  const endIdx = Math.min(lyricsState.lines.length - 1, activeIndex + 3);

  for (let i = startIdx; i <= endIdx; i++) {
    const isCurrent = i === activeIndex;
    const offsetIndex = i - activeIndex;

    if (isCurrent) {
      ctx.fillStyle = lyricsState.isPlaying ? 'rgba(255, 255, 255, 0.96)' : 'rgba(255, 255, 255, 0.60)';
      ctx.font = '700 26px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    } else {
      const distAlpha = Math.max(0.16, 0.44 - Math.abs(offsetIndex) * 0.12);
      ctx.fillStyle = 'rgba(228, 228, 231, ' + distAlpha + ')';
      ctx.font = '600 20px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    }

    const wrapped = wrapLyricLines(lyricsState.lines[i].text, maxTextWidth);
    const subLineHeight = isCurrent ? 33 : 26;
    for (let w = 0; w < wrapped.length; w++) {
      ctx.fillText(wrapped[w], anchorX, cursorY);
      cursorY += subLineHeight;
    }
    cursorY += 16;
  }
  ctx.restore();
}

function getWaveY(screenX, layerIndex) {
  const baseY = height * (0.34 + layerIndex * 0.14);
  const stormWaveScale = (1 + weather.stormLevel * 1.15 + audio.smoothBass * 0.30) * settings.waveMultiplier;
  const amplitude = height * (0.11 - layerIndex * 0.012) * stormWaveScale;

  const parallaxX = (mouse.x - 0.5) * (35 + layerIndex * 28);
  const parallaxY = (mouse.y - 0.5) * (20 + layerIndex * 18);
  const depthFactor = 0.35 + layerIndex * 0.32;
  const cameraScroll = boat.worldDistance * depthFactor;
  const ambientSwell = wavePhase * (1 + layerIndex * 0.22);
  const worldX = screenX + cameraScroll - parallaxX;
  const nx = worldX / (width + 160);

  const wave1 = Math.sin(nx * Math.PI * 2.1 + ambientSwell) * amplitude;
  const wave2 = Math.cos(nx * Math.PI * 1.3 - ambientSwell * 0.7) * (amplitude * 0.55);
  const chop = weather.stormLevel > 0.04 ? Math.sin(nx * Math.PI * 6.5 + ambientSwell * 2.2) * (amplitude * 0.16 * weather.stormLevel) : 0;

  const dx = screenX - mouse.px;
  const dist = Math.abs(dx);
  const cursorLift = mouse.active && dist < 360 ? Math.cos((dist / 360) * (Math.PI * 0.5)) * ((mouse.py - baseY) * 0.24) : 0;

  return baseY + wave1 + wave2 + chop + parallaxY + cursorLift;
}

function drawTrackedBoat(layerIndex, dtScale) {
  mouse.windSwipeX *= Math.pow(0.92, dtScale);
  const stormSpeedBoost = weather.stormLevel * 3.0 + Math.max(0, mouse.windSwipeX * 0.35);
  const currentSpeed = (boat.baseSpeed + stormSpeedBoost) * dtScale;
  boat.worldDistance += currentSpeed;

  const targetScreenX = width * 0.46 + stormSpeedBoost * 10 + (mouse.x - 0.5) * 40;
  boat.screenX += (targetScreenX - boat.screenX) * 0.08 * dtScale;

  const waterSurfaceY = getWaveY(boat.screenX, layerIndex);
  const yAhead = getWaveY(boat.screenX + 14, layerIndex);
  const yBehind = getWaveY(boat.screenX - 14, layerIndex);
  const waveSlopeAngle = Math.atan2(yAhead - yBehind, 28);

  if (!boat.initialized) {
    boat.screenY = waterSurfaceY;
    boat.angle = waveSlopeAngle;
    boat.prevAngle = waveSlopeAngle;
    boat.initialized = true;
  }

  boat.vy += 0.34 * dtScale;
  boat.screenY += boat.vy * dtScale;

  if (boat.screenY >= waterSurfaceY) {
    if (boat.inAir && boat.vy > 2.2) {
      const splashStrength = Math.min(1, boat.vy / 8);
      spawnBowSpray(boat.screenX, waterSurfaceY, splashStrength, Math.ceil(splashStrength * 12));
    }
    const penetration = boat.screenY - waterSurfaceY;
    boat.vy -= penetration * 0.42 * dtScale;
    boat.vy *= Math.pow(0.68, dtScale);
    if (boat.screenY > waterSurfaceY + 5) {
      boat.screenY = waterSurfaceY + 5;
    }
    boat.inAir = false;
  } else {
    boat.inAir = true;
  }

  const gustPitch = -stormSpeedBoost * 0.015;
  const targetAngle = boat.inAir ? Math.max(-0.55, Math.min(0.55, boat.vy * 0.045)) : (waveSlopeAngle + gustPitch);
  boat.prevAngle = boat.angle;
  boat.angle += (targetAngle - boat.angle) * 0.16 * dtScale;

  const angularAccel = (boat.angle - boat.prevAngle) * 1.4;
  boat.lanternVel += (-boat.lanternAngle * 0.14 - angularAccel) * dtScale;
  boat.lanternVel *= Math.pow(0.88, dtScale);
  boat.lanternAngle = Math.max(-0.65, Math.min(0.65, boat.lanternAngle + boat.lanternVel * dtScale));

  if (!boat.inAir) {
    const bowX = boat.screenX + Math.cos(boat.angle) * 18;
    const bowY = boat.screenY + Math.sin(boat.angle) * 18;
    const sprayIntensity = Math.min(1, weather.stormLevel * 0.95 + Math.max(0, waveSlopeAngle) * 1.2);

    if (sprayIntensity > 0.12 && Math.random() < sprayIntensity * 0.85) {
      spawnBowSpray(bowX, bowY, sprayIntensity);
    }

    const wakeLen = 55 + stormSpeedBoost * 16;
    const wakeGrad = ctx.createLinearGradient(boat.screenX - wakeLen, waterSurfaceY, boat.screenX - 14, waterSurfaceY);
    wakeGrad.addColorStop(0, 'rgba(244, 244, 245, 0)');
    wakeGrad.addColorStop(1, 'rgba(244, 244, 245, ' + (0.35 + weather.stormLevel * 0.25) + ')');

    ctx.strokeStyle = wakeGrad;
    ctx.lineWidth = 1.6 + weather.stormLevel * 0.8;
    ctx.beginPath();
    for (let wx = boat.screenX - wakeLen; wx <= boat.screenX - 14; wx += 8) {
      const wy = getWaveY(wx, layerIndex);
      if (wx === boat.screenX - wakeLen) ctx.moveTo(wx, wy);
      else ctx.lineTo(wx, wy);
    }
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(boat.screenX, boat.screenY);
  ctx.rotate(boat.angle);

  if (boat.hovered || lyricsState.mode > 0) {
    ctx.strokeStyle = lyricsState.mode === 2 ? 'rgba(255, 255, 255, 0.50)' : (lyricsState.mode === 1 ? 'rgba(255, 255, 255, 0.30)' : 'rgba(255, 255, 255, 0.18)');
    ctx.lineWidth = lyricsState.mode === 2 ? 1.4 : 1;
    ctx.beginPath();
    ctx.arc(0, -14, 28, 0, Math.PI * 2);
    ctx.stroke();
  }

  const heightAboveWater = Math.max(0, waterSurfaceY - boat.screenY);
  const reflectionAlpha = Math.max(0, 0.20 - heightAboveWater * 0.003);
  if (reflectionAlpha > 0.01) {
    ctx.save();
    ctx.translate(0, heightAboveWater * 1.6);
    ctx.scale(1, -0.55);
    ctx.globalAlpha = reflectionAlpha;
    ctx.fillStyle = '#e4e4e7';
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.lineTo(20, 0);
    ctx.lineTo(13, 8);
    ctx.lineTo(-14, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Hull
  ctx.fillStyle = '#18181b';
  ctx.strokeStyle = 'rgba(244, 244, 245, 0.85)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-20, -1);
  ctx.lineTo(21, -1);
  ctx.lineTo(13, 7);
  ctx.lineTo(-14, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Mast
  ctx.strokeStyle = 'rgba(244, 244, 245, 0.9)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-1, -1);
  ctx.lineTo(-1, -36);
  ctx.stroke();

  // Main Sail
  const billow = 12 + stormSpeedBoost * 1.3;
  ctx.fillStyle = 'rgba(244, 244, 245, 0.9)';
  ctx.beginPath();
  ctx.moveTo(-2, -34);
  ctx.quadraticCurveTo(-billow, -18, -16, -4);
  ctx.lineTo(-2, -4);
  ctx.closePath();
  ctx.fill();

  // Front Jib Sail
  ctx.fillStyle = 'rgba(212, 212, 216, 0.68)';
  ctx.beginPath();
  ctx.moveTo(0, -29);
  ctx.quadraticCurveTo(9 + stormSpeedBoost * 0.7, -15, 16, -4);
  ctx.lineTo(0, -4);
  ctx.closePath();
  ctx.fill();

  // Swinging Lantern
  ctx.save();
  ctx.translate(18, -2);
  ctx.rotate(boat.lanternAngle - boat.angle * 0.5);
  const lanternGlow = ctx.createRadialGradient(0, 2, 0.5, 0, 2.5, 8);
  lanternGlow.addColorStop(0, 'rgba(255, 251, 235, 0.75)');
  lanternGlow.addColorStop(1, 'rgba(255, 251, 235, 0)');
  ctx.fillStyle = lanternGlow;
  ctx.beginPath();
  ctx.arc(0, 5, 16, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(244, 244, 245, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 4);
  ctx.stroke();

  ctx.fillStyle = '#fffbeb';
  ctx.beginPath();
  ctx.arc(0, 5, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
  updateAndDrawSpray(dtScale);
}

function drawWeatherEffects(dtScale) {
  for (let w = weather.windStreaks.length - 1; w >= 0; w--) {
    const ws = weather.windStreaks[w];
    ws.x += ws.vx * dtScale;
    ws.alpha -= 0.016 * dtScale;
    if (ws.alpha <= 0.01) {
      weather.windStreaks.splice(w, 1);
      continue;
    }
    ctx.strokeStyle = 'rgba(244, 244, 245, ' + ws.alpha + ')';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ws.x, ws.y);
    ctx.lineTo(ws.x - ws.length * Math.sign(ws.vx || 1), ws.y);
    ctx.stroke();
  }

  // Lightning Flash & Jagged Sky Bolt
  if (weather.lightningAlpha > 0.01) {
    ctx.fillStyle = 'rgba(228, 228, 231, ' + (weather.lightningAlpha * 0.22) + ')';
    ctx.fillRect(0, 0, width, height);

    if (weather.lightningBolt.length > 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, ' + (weather.lightningAlpha * 0.35) + ')';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(weather.lightningBolt[0].x, weather.lightningBolt[0].y);
      for (let i = 1; i < weather.lightningBolt.length; i++) {
        ctx.lineTo(weather.lightningBolt[i].x, weather.lightningBolt[i].y);
      }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, ' + weather.lightningAlpha + ')';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    if (weather.lightningBranch.length > 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, ' + (weather.lightningAlpha * 0.65) + ')';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(weather.lightningBranch[0].x, weather.lightningBranch[0].y);
      for (let i = 1; i < weather.lightningBranch.length; i++) {
        ctx.lineTo(weather.lightningBranch[i].x, weather.lightningBranch[i].y);
      }
      ctx.stroke();
    }
    weather.lightningAlpha *= Math.pow(0.86, dtScale);
  }

  // Ocean Strike Impact Flash & Ripples
  if (weather.lightningImpact && weather.lightningImpact.alpha > 0.02) {
    const imp = weather.lightningImpact;
    const surfaceY = getWaveY(imp.x, imp.layer);
    const flashRadius = 65 + imp.radius * 0.6;
    const flashGrad = ctx.createRadialGradient(imp.x, surfaceY, 2, imp.x, surfaceY, flashRadius);
    flashGrad.addColorStop(0, 'rgba(255, 255, 255, ' + (imp.alpha * 0.85) + ')');
    flashGrad.addColorStop(0.4, 'rgba(212, 212, 216, ' + (imp.alpha * 0.35) + ')');
    flashGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = flashGrad;
    ctx.beginPath();
    ctx.arc(imp.x, surfaceY, flashRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, ' + (imp.alpha * 0.65) + ')';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(imp.x, surfaceY, imp.radius, imp.radius * 0.24, 0, 0, Math.PI * 2);
    ctx.stroke();

    imp.radius += 3.2 * dtScale;
    imp.alpha *= Math.pow(0.91, dtScale);
  }

  // Wind-Driven Rain
  if (weather.stormLevel <= 0.05) return;
  const rainIntensity = Math.min(1, (weather.stormLevel - 0.05) / 0.55);
  const activeDrops = Math.floor(weather.raindrops.length * rainIntensity);
  const windSlantX = -4 - weather.stormLevel * 9 + mouse.windSwipeX * 0.6;

  ctx.strokeStyle = 'rgba(228, 228, 231, ' + (0.18 + rainIntensity * 0.30) + ')';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let i = 0; i < activeDrops; i++) {
    const drop = weather.raindrops[i];
    const fallSpeed = drop.speed * (0.8 + weather.stormLevel * 0.75) * dtScale;
    drop.x += windSlantX * dtScale;
    drop.y += fallSpeed;

    if (drop.y > height) {
      drop.y = -20;
      drop.x = Math.random() * (width + 300) - 50;
    }
    if (drop.x < -150) {
      drop.x = width + 100;
    } else if (drop.x > width + 150) {
      drop.x = -100;
    }

    ctx.moveTo(drop.x, drop.y);
    ctx.lineTo(drop.x + windSlantX * 0.7, drop.y + drop.length);
  }
  ctx.stroke();
}

function drawSilkRibbon(layerIndex, ribbonStyle) {
  const steps = 64;
  const stepWidth = (width + 160) / steps;

  ctx.beginPath();
  ctx.moveTo(-120, height + 100);
  for (let i = 0; i <= steps; i++) {
    const x = -80 + i * stepWidth;
    const y = getWaveY(x, layerIndex);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width + 120, height + 100);
  ctx.closePath();
  ctx.fillStyle = cachedRibbonGrads[layerIndex];
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const x = -80 + i * stepWidth;
    const y = getWaveY(x, layerIndex);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = ribbonStyle.rim;
  ctx.lineWidth = 1.5 + weather.stormLevel * 0.5;
  ctx.stroke();

  if (layerIndex === 2 || layerIndex === 3) {
    drawWaveSparkles(layerIndex, 1);
  }
}

// --- Main Animation Render Loop ---
function animate(now) {
  now = now || performance.now();
  const rawDt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  const dtScale = rawDt * 60;

  decayAudioWhenSilent();

  const bassLerp = audio.bass > audio.smoothBass ? 0.14 : 0.05;
  audio.smoothBass += (audio.bass - audio.smoothBass) * bassLerp * dtScale;

  const midLerp = audio.mid > audio.smoothMid ? 0.12 : 0.05;
  audio.smoothMid += (audio.mid - audio.smoothMid) * midLerp * dtScale;

  const trebleLerp = audio.treble > audio.smoothTreble ? 0.14 : 0.06;
  audio.smoothTreble += (audio.treble - audio.smoothTreble) * trebleLerp * dtScale;

  const energyLerp = audio.energy > audio.smoothEnergy ? 0.10 : 0.04;
  audio.smoothEnergy += (audio.energy - audio.smoothEnergy) * energyLerp * dtScale;

  weather.stormLevel += (audio.smoothEnergy - weather.stormLevel) * 0.04 * dtScale;
  wavePhase += rawDt * (0.35 + weather.stormLevel * 0.85);

  if (weather.stormLevel > 0.18 && audio.bass > 0.42 && weather.lightningAlpha < 0.08 && Math.random() < 0.45) {
    triggerLightning();
  }

  mouse.x += (mouse.targetX - mouse.x) * 0.06 * dtScale;
  mouse.y += (mouse.targetY - mouse.y) * 0.06 * dtScale;
  mouse.px = mouse.x * width;
  mouse.py = mouse.y * height;

  ctx.fillStyle = cachedBgGrad;
  ctx.fillRect(0, 0, width, height);

  drawHorizonAtmosphere(dtScale);
  drawMacClock();

  const lightX = boat.screenX;
  const lightY = boat.screenY - 16;
  const bloomRadius = 360 + audio.smoothBass * 95 + weather.lightningAlpha * 140;
  const bloom = ctx.createRadialGradient(lightX, lightY, 8, lightX, lightY, bloomRadius);
  bloom.addColorStop(0, THEME.boatGlow);
  bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < THEME.ribbons.length; i++) {
    drawSilkRibbon(i, THEME.ribbons[i]);
    if (i === 2) {
      drawTrackedBoat(2, dtScale);
    }
  }

  drawWeatherEffects(dtScale);
  drawLyricsOverlay(dtScale);

  animationId = requestAnimationFrame(animate);
}

fitToScreen();
animate();