// An instrument: one mechanic — a point in space, wherever it comes from
// (pointer, touch or the arrow keys) — drives everything else. Moving it
// sings; letting it sit still lets the tone fade like dew; a tap or the
// space bar bursts a bubble; moving it fast cracks like lightning. The
// six-as-ifs of the Diamond Sūtra's closing line supply the vocabulary for
// what one continuous gesture sounds and looks like, not six separate toys.

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
if (!canvas) throw new Error("missing #stage canvas");
const stage = canvas;
const ink = stage.getContext("2d");
if (!ink) throw new Error("2d context unavailable");
const draw = ink;

interface Point {
  x: number;
  y: number;
}

interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  voiceGain: GainNode;
  noiseBuffer: AudioBuffer;
}

interface Bubble {
  x: number;
  y: number;
  bornAt: number;
  hue: number;
}

interface Flash {
  x: number;
  y: number;
  bornAt: number;
  angle: number;
}

interface TrailPoint {
  x: number;
  y: number;
  bornAt: number;
  hue: number;
}

const MIN_FREQ = 90;
const MAX_FREQ = 720;
const MIN_CUTOFF = 250;
const MAX_CUTOFF = 5200;
const BASE_VOICE_LEVEL = 0.22;
const PRESENCE_TAU_UP = 0.06;
const PRESENCE_TAU_DOWN = 2.4;
const MOVE_WINDOW_MS = 150;
const LIGHTNING_SPEED = 3.2; // normalised units per second
const LIGHTNING_COOLDOWN_MS = 260;
const BUBBLE_LIFE_MS = 750;
const FLASH_LIFE_MS = 140;
const KEY_SPEED = 0.7; // normalised units per second
const TRAIL_LIFE_MS = 380; // how long a drift smear lingers
const MAX_TRAIL_POINTS = 48;

// The six as-ifs aren't six toys — they're names for the states the one
// point signal (position, speed, presence) already passes through. Naming
// them on screen is the only new thing here; the mechanic underneath is
// unchanged.
const MOOD_LABELS = {
  dream: { glyph: "夢", gloss: "dream" },
  illusion: { glyph: "幻", gloss: "illusion" },
  shadow: { glyph: "影", gloss: "shadow" },
  bubble: { glyph: "泡", gloss: "bubble" },
  dew: { glyph: "露", gloss: "dew" },
  lightning: { glyph: "電", gloss: "lightning" },
} as const;
type Mood = keyof typeof MOOD_LABELS;

const LIGHTNING_LABEL_MS = 480;
const BUBBLE_LABEL_MS = 560;
const SHADOW_SPEED = LIGHTNING_SPEED * 0.42; // below this while moving: illusion; above: shadow
const MOOD_CROSSFADE_MS = 220;

// The typing keyboard as a second playing surface: each row of keys maps to
// a row of the stage, each key in it to a column — pressing one is the same
// gesture as clicking that spot, just addressed by name instead of by hand.
const KEY_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEY_POSITIONS = new Map<string, Point>();
KEY_ROWS.forEach((row, rowIndex) => {
  const y = 0.16 + (rowIndex / (KEY_ROWS.length - 1)) * 0.68;
  for (let col = 0; col < row.length; col++) {
    const x = 0.06 + (col / (row.length - 1)) * 0.88;
    KEY_POSITIONS.set(row[col]!, { x, y });
  }
});

const pointer: Point = { x: 0.5, y: 0.42 };
let lastMoveAt = -Infinity;
let lastLightningAt = 0;
let lastPluckAt = -Infinity;
let lastKeyAt = -Infinity;
let lastSpeed = 0;
let presence = 0;
let lastFrameAt = 0;
let mood: Mood = "dream";
let prevMood: Mood | null = null;
let moodSince = 0;

const bubbles: Bubble[] = [];
const flashes: Flash[] = [];
const trail: TrailPoint[] = [];
const heldKeys = new Set<string>();

let audio: AudioGraph | null = null;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = ctx.sampleRate; // one second
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function ensureAudio(): AudioGraph {
  if (audio) {
    void audio.ctx.resume();
    return audio;
  }
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 0;

  osc.connect(filter);
  filter.connect(voiceGain);
  voiceGain.connect(master);

  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.22;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  voiceGain.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(master);

  osc.start();

  audio = { ctx, master, osc, filter, voiceGain, noiseBuffer: buildNoiseBuffer(ctx) };
  return audio;
}

function currentFrequency(): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, 1 - pointer.y);
}

function pluckBubble(): void {
  const graph = ensureAudio();
  const { ctx, master } = graph;
  const now = ctx.currentTime;
  const freq = currentFrequency() * (0.94 + Math.random() * 0.28);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * 1.5, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.85), now + 0.32);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

  osc.connect(gain);
  gain.connect(master);
  osc.start(now);
  osc.stop(now + 0.55);

  bubbles.push({ x: pointer.x, y: pointer.y, bornAt: performance.now(), hue: hueFor(pointer.y) });
  lastPluckAt = performance.now();
}

function lightningCrack(): void {
  const graph = ensureAudio();
  const { ctx, master, noiseBuffer } = graph;
  const now = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1800 + Math.random() * 3200;
  bandpass.Q.value = 5.5;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.45, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  source.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(master);
  source.start(now);
  source.stop(now + 0.15);

  flashes.push({ x: pointer.x, y: pointer.y, bornAt: performance.now(), angle: Math.random() * Math.PI * 2 });
}

function setPointer(x: number, y: number, now: number): void {
  const elapsedMs = Math.max(4, now - (lastMoveAt || now));
  const dx = x - pointer.x;
  const dy = y - pointer.y;
  const speed = Math.hypot(dx, dy) / (elapsedMs / 1000);

  pointer.x = clamp01(x);
  pointer.y = clamp01(y);
  lastMoveAt = now;
  lastSpeed = speed;

  trail.push({ x: pointer.x, y: pointer.y, bornAt: now, hue: hueFor(pointer.y) });
  if (trail.length > MAX_TRAIL_POINTS) trail.shift();

  if (audio && speed > LIGHTNING_SPEED && now - lastLightningAt > LIGHTNING_COOLDOWN_MS) {
    lastLightningAt = now;
    lightningCrack();
  }
}

function jumpPointer(x: number, y: number, now: number): void {
  pointer.x = clamp01(x);
  pointer.y = clamp01(y);
  lastMoveAt = now;
  lastSpeed = 0;
}

function normalisePointer(event: PointerEvent): Point {
  const rect = stage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function updateKeyboardMovement(dt: number, now: number): void {
  if (heldKeys.size === 0) return;
  let dx = 0;
  let dy = 0;
  if (heldKeys.has("ArrowLeft")) dx -= 1;
  if (heldKeys.has("ArrowRight")) dx += 1;
  if (heldKeys.has("ArrowUp")) dy -= 1;
  if (heldKeys.has("ArrowDown")) dy += 1;
  if (dx === 0 && dy === 0) return;
  const length = Math.hypot(dx, dy) || 1;
  setPointer(pointer.x + (dx / length) * KEY_SPEED * dt, pointer.y + (dy / length) * KEY_SPEED * dt, now);
}

function updatePresence(dt: number, now: number): void {
  const target = now - lastMoveAt < MOVE_WINDOW_MS ? 1 : 0;
  const tau = target > presence ? PRESENCE_TAU_UP : PRESENCE_TAU_DOWN;
  presence += (target - presence) * (1 - Math.exp(-dt / tau));
}

function updateAudioParams(): void {
  if (!audio) return;
  const { ctx, osc, filter, voiceGain } = audio;
  const now = ctx.currentTime;
  osc.frequency.setTargetAtTime(currentFrequency(), now, 0.03);
  filter.frequency.setTargetAtTime(MIN_CUTOFF * Math.pow(MAX_CUTOFF / MIN_CUTOFF, pointer.x), now, 0.05);
  voiceGain.gain.setTargetAtTime(presence * BASE_VOICE_LEVEL, now, 0.09);
}

function computeMood(now: number): Mood {
  if (now - lastLightningAt < LIGHTNING_LABEL_MS) return "lightning";
  if (now - lastPluckAt < BUBBLE_LABEL_MS) return "bubble";
  const moving = now - lastMoveAt < MOVE_WINDOW_MS;
  if (!moving) return presence > 0.04 ? "dew" : "dream";
  return lastSpeed > SHADOW_SPEED ? "shadow" : "illusion";
}

function updateMood(now: number): void {
  const next = computeMood(now);
  if (next !== mood) {
    prevMood = mood;
    mood = next;
    moodSince = now;
  }
}

function drawMoodLabel(now: number, width: number, height: number): void {
  const px = pointer.x * width;
  const py = pointer.y * height;
  const glowRadius = 24 + presence * 70;
  const above = py - glowRadius - 34 > 28;
  const labelY = above ? py - glowRadius - 18 : py + glowRadius + 34;
  const hue = hueFor(pointer.y);

  const sinceSwap = now - moodSince;
  const inAlpha = Math.min(1, sinceSwap / MOOD_CROSSFADE_MS);

  const paint = (name: Mood, alpha: number) => {
    if (alpha <= 0.01) return;
    const { glyph, gloss } = MOOD_LABELS[name];
    draw.textAlign = "center";
    draw.font = "600 30px 'Noto Sans SC', system-ui, sans-serif";
    draw.fillStyle = `hsla(${hue}, 85%, 88%, ${alpha * 0.92})`;
    draw.fillText(glyph, px, labelY);
    draw.font = "11px system-ui, sans-serif";
    draw.fillStyle = `hsla(${hue}, 40%, 82%, ${alpha * 0.6})`;
    draw.fillText(gloss, px, labelY + (above ? 16 : -24));
  };

  paint(mood, inAlpha);
  if (prevMood && sinceSwap < MOOD_CROSSFADE_MS) paint(prevMood, 1 - inAlpha);
}

function hueFor(y: number): number {
  return 260 - y * 140; // low notes toward violet, high notes toward gold
}

function resizeStage(): void {
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(stage.clientWidth * dpr);
  stage.height = Math.round(stage.clientHeight * dpr);
  draw.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render(now: number): void {
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  draw.fillStyle = "rgba(5, 4, 10, 0.16)";
  draw.fillRect(0, 0, width, height);

  // The keyboard grid: a faint constellation showing where each key lands,
  // fading further out the less recently a key has been used.
  const keyFade = clamp01(1 - (now - lastKeyAt) / 4000) * 0.35 + 0.05;
  draw.textAlign = "center";
  draw.textBaseline = "middle";
  draw.font = "10px system-ui, sans-serif";
  draw.fillStyle = `rgba(207, 201, 232, ${keyFade})`;
  for (const [key, pos] of KEY_POSITIONS) {
    draw.fillText(key, pos.x * width, pos.y * height);
  }
  draw.textBaseline = "alphabetic";

  // Dream: slow drifting glow, always present, inviting the first touch.
  const t = now / 1000;
  for (let i = 0; i < 3; i++) {
    const phase = t * 0.08 + i * 2.1;
    const bx = width * (0.5 + 0.32 * Math.sin(phase));
    const by = height * (0.5 + 0.28 * Math.cos(phase * 0.8));
    const gradient = draw.createRadialGradient(bx, by, 0, bx, by, Math.min(width, height) * 0.35);
    gradient.addColorStop(0, `hsla(${250 + i * 40}, 70%, 55%, 0.05)`);
    gradient.addColorStop(1, "hsla(250, 70%, 55%, 0)");
    draw.fillStyle = gradient;
    draw.fillRect(0, 0, width, height);
  }

  // Shadow: a smear left by drifting, each segment fading with its own age.
  while (trail.length && now - trail[0]!.bornAt > TRAIL_LIFE_MS) trail.shift();
  draw.lineCap = "round";
  for (let i = 1; i < trail.length; i++) {
    const from = trail[i - 1]!;
    const to = trail[i]!;
    const age = now - to.bornAt;
    const alpha = Math.max(0, 1 - age / TRAIL_LIFE_MS) * 0.4;
    if (alpha <= 0.01) continue;
    draw.strokeStyle = `hsla(${to.hue}, 80%, 70%, ${alpha})`;
    draw.lineWidth = 1 + alpha * 14;
    draw.beginPath();
    draw.moveTo(from.x * width, from.y * height);
    draw.lineTo(to.x * width, to.y * height);
    draw.stroke();
  }

  // The point itself: brighter and larger the more it is singing.
  const px = pointer.x * width;
  const py = pointer.y * height;
  const glowRadius = 24 + presence * 70;
  const glow = draw.createRadialGradient(px, py, 0, px, py, glowRadius);
  const hue = hueFor(pointer.y);
  glow.addColorStop(0, `hsla(${hue}, 90%, 75%, ${0.15 + presence * 0.55})`);
  glow.addColorStop(1, `hsla(${hue}, 90%, 65%, 0)`);
  draw.fillStyle = glow;
  draw.beginPath();
  draw.arc(px, py, glowRadius, 0, Math.PI * 2);
  draw.fill();

  // Bubble: a tap or a space-press, rising and popping.
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const bubble = bubbles[i];
    if (!bubble) continue;
    const age = now - bubble.bornAt;
    if (age > BUBBLE_LIFE_MS) {
      bubbles.splice(i, 1);
      continue;
    }
    const progress = age / BUBBLE_LIFE_MS;
    const radius = 6 + progress * 42;
    const rise = progress * 46;
    const alpha = (1 - progress) * 0.6;
    draw.beginPath();
    draw.arc(bubble.x * width, bubble.y * height - rise, radius, 0, Math.PI * 2);
    draw.strokeStyle = `hsla(${bubble.hue}, 85%, 80%, ${alpha})`;
    draw.lineWidth = 2;
    draw.stroke();
  }

  // Lightning: a fast gesture, cracking bright then gone.
  for (let i = flashes.length - 1; i >= 0; i--) {
    const flash = flashes[i];
    if (!flash) continue;
    const age = now - flash.bornAt;
    if (age > FLASH_LIFE_MS) {
      flashes.splice(i, 1);
      continue;
    }
    const alpha = 1 - age / FLASH_LIFE_MS;
    const fx = flash.x * width;
    const fy = flash.y * height;
    draw.strokeStyle = `hsla(200, 100%, 92%, ${alpha})`;
    draw.lineWidth = 1.5;
    draw.beginPath();
    let x = fx;
    let y = fy;
    let angle = flash.angle;
    draw.moveTo(x, y);
    for (let seg = 0; seg < 4; seg++) {
      angle += (Math.random() - 0.5) * 1.4;
      x += Math.cos(angle) * 18;
      y += Math.sin(angle) * 18;
      draw.lineTo(x, y);
    }
    draw.stroke();
  }

  drawMoodLabel(now, width, height);
}

function frame(now: number): void {
  const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;
  updateKeyboardMovement(dt, now);
  updatePresence(dt, now);
  updateMood(now);
  updateAudioParams();
  render(now);
  requestAnimationFrame(frame);
}

stage.addEventListener("pointerdown", (event) => {
  ensureAudio();
  stage.setPointerCapture(event.pointerId);
  const { x, y } = normalisePointer(event);
  setPointer(x, y, performance.now());
  pluckBubble();
});

stage.addEventListener("pointermove", (event) => {
  const { x, y } = normalisePointer(event);
  setPointer(x, y, performance.now());
});

stage.addEventListener("pointerup", (event) => {
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
});

window.addEventListener("keydown", (event) => {
  if (event.key.startsWith("Arrow")) {
    heldKeys.add(event.key);
    event.preventDefault();
    return;
  }
  if (event.key === " " && !event.repeat) {
    ensureAudio();
    pluckBubble();
    event.preventDefault();
    return;
  }
  const gridPos = event.key.length === 1 ? KEY_POSITIONS.get(event.key.toLowerCase()) : undefined;
  if (gridPos && !event.repeat) {
    ensureAudio();
    lastKeyAt = performance.now();
    jumpPointer(gridPos.x, gridPos.y, lastKeyAt);
    pluckBubble();
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.key);
});

window.addEventListener("resize", resizeStage);

resizeStage();
requestAnimationFrame(frame);
