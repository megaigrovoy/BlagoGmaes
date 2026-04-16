import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvasElement = document.getElementById('game-canvas');
const canvasCtx = canvasElement.getContext('2d');
const scoreDisplay = document.getElementById('score-display');
const loadingElement = document.getElementById('loading');
const mainMenu = document.getElementById('main-menu');
const levelGrid = document.getElementById('level-grid');
const hudGame = document.getElementById('hud-game');
const levelDisplay = document.getElementById('level-display');
const btnBackMenu = document.getElementById('btn-back-menu');

let handLandmarker;
let poseLandmarker;
let lastVideoTime = -1;
let score = 0;
let fruits = [];
let particles = [];
let isPlaying = false;

/** maxConcurrent = unsliced fruits cap; spawnIntervalMs = try spawn at most this often */
const LEVELS = [
    { maxConcurrent: 1, spawnIntervalMs: 2200 },
    { maxConcurrent: 2, spawnIntervalMs: 1900 },
    { maxConcurrent: 3, spawnIntervalMs: 1550 },
    { maxConcurrent: 4, spawnIntervalMs: 1250 },
    { maxConcurrent: 5, spawnIntervalMs: 1050 },
    { maxConcurrent: 6, spawnIntervalMs: 950 }
];
/** Штраф за предмет, улетевший вниз несрезанным (симметрично +10 за рез) */
const MISS_PENALTY = 10;
let currentLevelIndex = 0;

function getCurrentLevelConfig() {
    return LEVELS[currentLevelIndex];
}

function pluralObjectsRu(n) {
    const n100 = n % 100;
    const n10 = n % 10;
    if (n100 >= 11 && n100 <= 14) return `${n} объектов`;
    if (n10 === 1) return `${n} объект`;
    if (n10 >= 2 && n10 <= 4) return `${n} объекта`;
    return `${n} объектов`;
}

function showMainMenu() {
    isPlaying = false;
    mainMenu.classList.remove('is-hidden');
    hudGame.classList.add('is-hidden');
    fruits.length = 0;
    particles.length = 0;
    prevFingertipsByKey.clear();
    handKeyLastSeenMs.clear();
    tipVelocityByKey.clear();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
}

function startLevel(levelIndex) {
    currentLevelIndex = Math.max(0, Math.min(LEVELS.length - 1, levelIndex));
    const cfg = getCurrentLevelConfig();
    score = 0;
    scoreDisplay.innerText = `Score: ${score}`;
    levelDisplay.textContent = `Уровень ${currentLevelIndex + 1} · одновременно ${pluralObjectsRu(cfg.maxConcurrent)}`;
    fruits.length = 0;
    particles.length = 0;
    lastSpawnTime = Date.now();
    lastFrameTime = performance.now();
    mainMenu.classList.add('is-hidden');
    hudGame.classList.remove('is-hidden');
    isPlaying = true;
    requestAnimationFrame(gameLoop);
}

LEVELS.forEach((cfg, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'level-btn';
    btn.innerHTML = `<span class="level-title">Уровень ${i + 1}</span><span class="level-sub">одновременно ${pluralObjectsRu(cfg.maxConcurrent)}</span>`;
    btn.addEventListener('click', () => startLevel(i));
    levelGrid.appendChild(btn);
});

btnBackMenu.addEventListener('click', () => showMainMenu());

// Geometry configuration
const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

// Resize canvas to match window completely
/** Logical game size (matches canvas buffer; avoids 100vh vs innerHeight stretch on mobile) */
let gameLayout = { w: 800, h: 600, minSide: 600 };

function readViewportSize() {
    const vv = window.visualViewport;
    const w = Math.max(1, Math.floor(vv?.width ?? window.innerWidth));
    const h = Math.max(1, Math.floor(vv?.height ?? window.innerHeight));
    return { w, h };
}

function resizeCanvas() {
    const { w, h } = readViewportSize();
    gameLayout.w = w;
    gameLayout.h = h;
    gameLayout.minSide = Math.min(w, h);

    canvasElement.width = w;
    canvasElement.height = h;
    canvasElement.style.width = `${w}px`;
    canvasElement.style.height = `${h}px`;

    const gc = document.getElementById('game-container');
    if (gc) {
        gc.style.width = `${w}px`;
        gc.style.height = `${h}px`;
    }
    document.documentElement.style.height = `${h}px`;
    document.body.style.height = `${h}px`;
    document.documentElement.style.width = `${w}px`;
    document.body.style.width = `${w}px`;
}

window.addEventListener('resize', resizeCanvas);
window.visualViewport?.addEventListener('resize', resizeCanvas);
window.visualViewport?.addEventListener('scroll', resizeCanvas);
resizeCanvas();

async function setupWebcam() {
    return new Promise((resolve, reject) => {
        const navigator = window.navigator;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            reject(new Error("Webcam not supported."));
        }
        navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "user"
            }
        }).then((stream) => {
            video.srcObject = stream;
            video.onloadedmetadata = () => {
                video.play().then(() => {
                    resolve();
                }).catch(e => {
                    console.error("Video play error:", e);
                    reject(e);
                });
            };
        }).catch((err) => {
            reject(err);
        });
    });
}

async function initializeModels() {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.35
    });

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
    });

    loadingElement.classList.remove('visible');
    showMainMenu();
}

// Game Objects
const fruitEmojiTextures = {};

function initFruitTextures() {
    const emojis = ['🍌', '🍎', '🍉', '🍊', '🍗', '🥩', '🥦', '🥬', '🍆'];
    const size = 600; // max size matching largest fruit radius
    for(let e of emojis) {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        ctx.font = `${size * 0.8}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e, size / 2, size / 2 + 10); // Slight vertical offset to center better
        fruitEmojiTextures[e] = { canvas: c, size: size };
    }
}
initFruitTextures();

class Fruit {
    constructor() {
        const { w, h, minSide } = gameLayout;
        this.x = Math.random() * w * 0.8 + w * 0.1;
        this.y = h + 50;
        const span = Math.min(w, h * 1.35);
        this.vx = (Math.random() - 0.5) * span * 0.009;
        this.gravity = 0.4;
        const maxRise = h * 0.88 + 48;
        const vyCap = Math.sqrt(2 * this.gravity * maxRise);
        const vyWant = Math.random() * 14 + 16;
        this.vy = -Math.min(vyWant, vyCap);
        const rLo = minSide * 0.068;
        const rHi = minSide * 0.108;
        this.radius = Math.min(160, Math.max(36, rLo + Math.random() * (rHi - rLo)));
        
        const fruitTypes = [
            { emoji: '🍌', color: '#ffe135' }, // Banana yellow
            { emoji: '🍎', color: '#ff0800' }, // Apple red
            { emoji: '🍉', color: '#fc3a52' }, // Watermelon pink/red
            { emoji: '🍊', color: '#ffa500' }, // Orange
            { emoji: '🍗', color: '#ffcc80' }, // Chicken leg beige
            { emoji: '🥩', color: '#d32f2f' }, // Steak red
            { emoji: '🥦', color: '#4caf50' }, // Broccoli green
            { emoji: '🥬', color: '#8bc34a' }, // Cabbage light green
            { emoji: '🍆', color: '#9c27b0' }  // Eggplant purple
        ];
        const type = fruitTypes[Math.floor(Math.random() * fruitTypes.length)];
        this.emoji = type.emoji;
        this.color = type.color;
        
        this.isSliced = false;
        this.sliceOffsetX = 0;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotationSpeed = (Math.random() - 0.5) * 0.1; // Random spin speed
        
        this.cutAngle = 0;
        this.rot1 = 0;
        this.rot2 = 0;
        this.rotSpeed1 = 0;
        this.rotSpeed2 = 0;
    }

    update(dt = 1) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.vy += this.gravity * dt;
        
        if (!this.isSliced) {
            this.rotation += this.rotationSpeed * dt;
        } else {
            this.sliceOffsetX += 6 * dt; // Separate halves physically
            // Independent tumbling
            this.rot1 += this.rotSpeed1 * dt;
            this.rot2 += this.rotSpeed2 * dt;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        
        const texture = fruitEmojiTextures[this.emoji].canvas;
        const texSize = fruitEmojiTextures[this.emoji].size;
        const drawSize = this.radius * 2;
        
        if (!this.isSliced) {
            ctx.rotate(this.rotation);
            ctx.drawImage(texture, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        } else {
            // Left half
            ctx.save();
            // Move along the fixed cut axis towards the local left
            ctx.translate(Math.cos(this.cutAngle + Math.PI) * this.sliceOffsetX, Math.sin(this.cutAngle + Math.PI) * this.sliceOffsetX);
            ctx.rotate(this.rot1);
            ctx.drawImage(
                texture,
                0, 0, texSize / 2, texSize,                         // source
                -drawSize / 2, -drawSize / 2,                       // destination x, y
                drawSize / 2, drawSize                              // destination width, height
            );
            ctx.restore();

            // Right half
            ctx.save();
            // Move along the fixed cut axis towards the local right
            ctx.translate(Math.cos(this.cutAngle) * this.sliceOffsetX, Math.sin(this.cutAngle) * this.sliceOffsetX);
            ctx.rotate(this.rot2);
            ctx.drawImage(
                texture,
                texSize / 2, 0, texSize / 2, texSize,               // source
                0, -drawSize / 2,                                   // destination x, y
                drawSize / 2, drawSize                              // destination width, height
            );
            ctx.restore();
        }
        ctx.restore();
    }
}

/** Radial “splash” at slice: rays + ring, decays quickly */
class SliceBurst {
    constructor(x, y, color) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.life = 1;
        this.rot = Math.random() * Math.PI * 2;
    }
    update(dt = 1) {
        this.life -= 0.1 * dt;
    }
    draw(ctx) {
        const t = Math.max(0, this.life);
        if (t <= 0) return;
        const u = 1 - t;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rot);
        const rays = 14;
        ctx.globalAlpha = t * 0.95;
        for (let r = 0; r < rays; r++) {
            const a = (r / rays) * Math.PI * 2;
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 2.2;
            ctx.shadowBlur = 16;
            ctx.shadowColor = '#00f3ff';
            ctx.beginPath();
            const inner = 10 + u * 28;
            const outer = 32 + u * 120;
            ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
            ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
            ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = t * 0.55;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 12 + u * 85, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = t * 0.35;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 8 + u * 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

/** kind: 'dot' — мягкое светящееся пятно; 'spark' — короткая яркая полоска-всплеск */
class Particle {
    constructor(x, y, color, kind = 'dot') {
        this.x = x;
        this.y = y;
        this.color = color;
        this.kind = kind;
        this.life = 1;
        const ang = Math.random() * Math.PI * 2;
        if (kind === 'spark') {
            const spd = 16 + Math.random() * 22;
            this.vx = Math.cos(ang) * spd;
            this.vy = Math.sin(ang) * spd;
            this.sparkAngle = ang;
            this.sparkLen = 14 + Math.random() * 20;
            this.drag = 0.9;
        } else {
            this.vx = Math.cos(ang) * (3 + Math.random() * 10);
            this.vy = Math.sin(ang) * (3 + Math.random() * 10);
            this.r = 3.5 + Math.random() * 6;
            this.drag = 0.985;
        }
    }
    update(dt = 1) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.vx *= this.drag;
        this.vy *= this.drag;
        this.life -= (this.kind === 'spark' ? 0.07 : 0.042) * dt;
    }
    draw(ctx) {
        const a = Math.max(0, this.life);
        if (a <= 0) return;
        ctx.save();
        if (this.kind === 'spark') {
            ctx.globalAlpha = a;
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 2.8;
            ctx.shadowBlur = 12;
            ctx.shadowColor = '#ffffff';
            const L = this.sparkLen * (0.4 + 0.6 * a);
            ctx.beginPath();
            ctx.moveTo(
                this.x - Math.cos(this.sparkAngle) * L * 0.35,
                this.y - Math.sin(this.sparkAngle) * L * 0.35
            );
            ctx.lineTo(this.x + Math.cos(this.sparkAngle) * L, this.y + Math.sin(this.sparkAngle) * L);
            ctx.stroke();
            ctx.restore();
            return;
        }
        const rad = this.r * (0.55 + 0.45 * a);
        const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.25, this.color);
        g.addColorStop(0.7, this.color);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(this.x, this.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 10;
        ctx.shadowColor = this.color;
        ctx.globalAlpha = a * 0.5;
        ctx.beginPath();
        ctx.arc(this.x, this.y, rad * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();
    }
}

// MediaPipe fingertip landmarks (index..pinky) — slice hitboxes + claw draw
const SLICE_FINGERTIP_INDICES = [8, 12, 16, 20];
/** DIP joint used as “base” to aim claw along the finger (toward tip) */
const TIP_CLAW_BASE = { 8: 7, 12: 11, 16: 15, 20: 19 };

// Intersect a line segment and a circle
function lineCircleCollide(a, b, circle) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    // Tip barely moved: treat as point vs circle (avoids div-by-zero)
    if (lenSq < 4) {
        const acx = circle.x - a.x;
        const acy = circle.y - a.y;
        return acx * acx + acy * acy < circle.radius * circle.radius;
    }
    const ab = { x: abx, y: aby };
    const ac = { x: circle.x - a.x, y: circle.y - a.y };

    // Project c onto ab, computing parameterized position d(t) = a + t*(b - a)
    let t = (ac.x * ab.x + ac.y * ab.y) / lenSq;
    t = Math.max(0, Math.min(1, t)); // Clamp to segment
    
    const closest = {
        x: a.x + t * ab.x,
        y: a.y + t * ab.y
    };
    
    const distanceSq = (closest.x - circle.x) * (closest.x - circle.x) + (closest.y - circle.y) * (closest.y - circle.y);
    return distanceSq < (circle.radius * circle.radius);
}

/** Three white claw prongs at the tip, pointing along the finger */
function drawFingertipClaw(ctx, tip, proximal) {
    let dx = tip.x - proximal.x;
    let dy = tip.y - proximal.y;
    const len = Math.hypot(dx, dy);
    if (len < 6) {
        dx = 1;
        dy = 0;
    } else {
        dx /= len;
        dy /= len;
    }
    const baseAng = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(tip.x, tip.y);
    ctx.rotate(baseAng);
    ctx.fillStyle = '#f4f6ff';
    ctx.strokeStyle = 'rgba(200, 215, 255, 0.92)';
    ctx.lineWidth = 1.2;
    ctx.shadowColor = 'rgba(0, 243, 255, 0.45)';
    ctx.shadowBlur = 6;
    const prongs = [
        { rot: -0.34, reach: 17, half: 4.2 },
        { rot: 0, reach: 23, half: 5 },
        { rot: 0.34, reach: 17, half: 4.2 }
    ];
    for (const p of prongs) {
        ctx.save();
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(0, -p.half);
        ctx.lineTo(p.reach, 0);
        ctx.lineTo(0, p.half);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.restore();
}

/**
 * Stable id per physical hand. `landmarks` array order from MediaPipe can swap
 * between frames; handedness + wrist order keeps prev/collision state consistent.
 */
function buildKeyedHands(handResults) {
    const landmarks = handResults?.landmarks;
    if (!landmarks?.length) return [];
    const handedness = handResults.handedness ?? handResults.handednesses ?? [];
    const items = landmarks.map((lm, i) => ({
        lm,
        label: (handedness[i]?.[0]?.categoryName || '').trim() || 'Hand',
        wristX: lm[0].x
    }));
    const labelCount = {};
    for (const it of items) {
        labelCount[it.label] = (labelCount[it.label] || 0) + 1;
    }
    items.sort((a, b) => a.wristX - b.wristX);
    const perLabelCounter = {};
    return items.map((it) => {
        let key = it.label;
        if (labelCount[it.label] > 1) {
            const n = perLabelCounter[it.label] || 0;
            perLabelCounter[it.label] = n + 1;
            key = `${it.label}#${n}`;
        }
        return { key, landmarks: it.lm };
    });
}

/** After hand drops from detection, keep extrapolating this long (ms) */
const HAND_LOST_GRACE_MS = 220;
/** Max px per collision sub-segment so fast swipes do not tunnel through fruits */
const COLLISION_SUBSTEP_PX = 72;
/** Low-pass on fingertip delta for velocity (ghost extrapolation) */
const TIP_VELOCITY_SMOOTH = 0.42;
/** Ignore velocity update on implausible one-frame jumps (lost track / teleport) */
const MAX_JUMP_FOR_VELOCITY_PX = 280;
/** Damp fingertip velocity each ghost frame */
const GHOST_VELOCITY_DAMP = 0.86;

/**
 * Append many short segments along [a→b] so lineCircleCollide cannot miss wide bodies
 * when the tip moves a large distance in one frame.
 */
function appendSweepCollisionSegments(segments, a, b, maxStepPx = COLLISION_SUBSTEP_PX) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const steps = Math.max(1, Math.ceil(len / maxStepPx));
    let x0 = a.x;
    let y0 = a.y;
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const x1 = a.x + dx * t;
        const y1 = a.y + dy * t;
        segments.push({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 } });
        x0 = x1;
        y0 = y1;
    }
}

let lastSpawnTime = Date.now();
let lastFrameTime = performance.now();
let currentHandResults = null;
let currentPoseResults = null;
/** Previous-frame fingertip positions: Map<handKey, { 8: {x,y}, ... }> */
let prevFingertipsByKey = new Map();
/** Last time this hand key was present in MediaPipe results (performance.now) */
let handKeyLastSeenMs = new Map();
/** Smoothed screen-space velocity per tip for short dropout extrapolation */
let tipVelocityByKey = new Map();

function gameLoop(nowTime) {
    if (!isPlaying) return;

    const levelCfg = getCurrentLevelConfig();

    if (!nowTime) nowTime = performance.now();
    let dt = (nowTime - lastFrameTime) / (1000 / 60); // Normalize to 60fps
    if (dt > 3) dt = 3; // Cap lag spikes
    if (dt < 0) dt = 0; // Prevent reverse time
    lastFrameTime = nowTime;

    let startTimeMs = performance.now();

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        let hRes = handLandmarker.detectForVideo(video, startTimeMs);
        let pRes = poseLandmarker.detectForVideo(video, startTimeMs);
        if (hRes) currentHandResults = hRes;
        if (pRes) currentPoseResults = pRes;
    }

    // --- DRAWING ---
    // 1. Draw Camera Frame to Canvas (Remember canvas is mirrored via CSS, so we just draw normal image, but coordinates will logically mirror for collisions? Wait, CSS mirroring only visually flips the content. Let's fix this!)
    // Wait, if canvas is CSS-scaled by -1, point (x,y) visually appears at (width-x, y). 
    // MediaPipe points are normalized 0-1 from left to right.
    // Let's just draw on the canvas normally, and calculate collisions in canvas coordinates. CSS scaleX(-1) handles the mirror visual!
    
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Calculate aspect ratio covering
    const vRatio = canvasElement.width / video.videoWidth;
    const hRatio = canvasElement.height / video.videoHeight;
    const ratio  = Math.max(vRatio, hRatio);
    const centerShift_x = (canvasElement.width - video.videoWidth*ratio) / 2;
    const centerShift_y = (canvasElement.height - video.videoHeight*ratio) / 2;  

    canvasCtx.drawImage(
        video, 0, 0, video.videoWidth, video.videoHeight,
        centerShift_x, centerShift_y, video.videoWidth*ratio, video.videoHeight*ratio
    );

    // Apply a dark tint
    canvasCtx.fillStyle = 'rgba(0,0,0,0.6)';
    canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);

    function getScreenPoint(landmark) {
        return {
            x: (landmark.x * video.videoWidth * ratio) + centerShift_x,
            y: (landmark.y * video.videoHeight * ratio) + centerShift_y
        };
    }

    // Prepare line segments for collision detection
    const handSegments = [];

    // Draw Pose
    if (currentPoseResults && currentPoseResults.landmarks) {
        for (const landmarks of currentPoseResults.landmarks) {
            canvasCtx.strokeStyle = 'rgba(0, 243, 255, 0.8)';
            canvasCtx.lineWidth = 6;
            canvasCtx.shadowColor = 'rgba(0, 243, 255, 1)';
            canvasCtx.shadowBlur = 15;
            
            for (const connection of POSE_CONNECTIONS) {
                // Skip drawing face lines to replace them with Ninja Mask 
                if (connection.start <= 10 && connection.end <= 10) continue;

                const a = getScreenPoint(landmarks[connection.start]);
                const b = getScreenPoint(landmarks[connection.end]);
                canvasCtx.beginPath();
                canvasCtx.moveTo(a.x, a.y);
                canvasCtx.lineTo(b.x, b.y);
                canvasCtx.stroke();
            }
            canvasCtx.shadowBlur = 0; // reset glow

            // Draw Ninja Mask using face landmarks (0 to 10)
            const nose = getScreenPoint(landmarks[0]);
            const eyeL = getScreenPoint(landmarks[2]);  // Left eye
            const eyeR = getScreenPoint(landmarks[5]);  // Right eye
            const earL = getScreenPoint(landmarks[7]);  // Left ear
            const earR = getScreenPoint(landmarks[8]);  // Right ear

            // Up vector on the face plane
            const eyeCenterX = (eyeL.x + eyeR.x) / 2;
            const eyeCenterY = (eyeL.y + eyeR.y) / 2;
            const upX = eyeCenterX - nose.x;
            const upY = eyeCenterY - nose.y;

            // Extrapolate key face bounds using the up vector
            const forehead = { x: eyeCenterX + upX * 1.5, y: eyeCenterY + upY * 1.5 };
            const chin = { x: nose.x - upX * 2.5, y: nose.y - upY * 2.5 };
            
            const faceWidth = Math.sqrt((earR.x - earL.x)**2 + (earR.y - earL.y)**2);
            const faceHeight = Math.sqrt(upX**2 + upY**2);
            // User's physical right ear (earR) is on the visual left of the mirrored view.
            // Vector from earR to earL points right. This keeps the angle ~0 and UP correct.
            const angle = Math.atan2(earL.y - earR.y, earL.x - earR.x);

            canvasCtx.save();
            // Transform canvas to center firmly between the eyes!
            canvasCtx.translate(eyeCenterX, eyeCenterY);
            canvasCtx.rotate(angle);
            
            // In these coordinates, X goes from Left to Right. 
            // Y goes from Eyes DOWN towards the chin. So negative Y is towards the top of the head.

            // Neon Wireframe Mask Style
            const W = faceWidth;
            const H = faceHeight;
            
            canvasCtx.strokeStyle = '#00f3ff';
            canvasCtx.lineWidth = 4; // Thick glowing neon lines
            canvasCtx.shadowColor = '#00f3ff';
            canvasCtx.shadowBlur = 20;
            canvasCtx.beginPath();
            
            // Outer Ellipse
            canvasCtx.ellipse(0, H * 0.5, W * 0.9, H * 3.5, 0, 0, Math.PI * 2);
            
            // Eye slit lower bounds
            canvasCtx.moveTo(-W * 0.8, H * 0.3);
            canvasCtx.lineTo(-W * 0.3, H * 0.6);
            canvasCtx.lineTo(W * 0.3, H * 0.6);
            canvasCtx.lineTo(W * 0.8, H * 0.3);
            
            // Eye slit upper curve
            canvasCtx.moveTo(-W * 0.8, H * 0.3);
            canvasCtx.quadraticCurveTo(0, -H * 0.2, W * 0.8, H * 0.3);
            
            // Lower face web (mouth/jaw)
            canvasCtx.moveTo(0, H * 0.6);
            canvasCtx.lineTo(0, H * 4.0);
            
            // Jaw V shape
            canvasCtx.moveTo(-W * 0.6, H * 3.0);
            canvasCtx.lineTo(0, H * 2.0);
            canvasCtx.lineTo(W * 0.6, H * 3.0);
            
            // Inner diamonds
            canvasCtx.moveTo(-W * 0.3, H * 0.6);
            canvasCtx.lineTo(0, H * 1.5);
            canvasCtx.lineTo(W * 0.3, H * 0.6);
            
            // Cheek lines
            canvasCtx.moveTo(-W * 0.9, H * 1.5);
            canvasCtx.lineTo(-W * 0.2, H * 1.8);
            canvasCtx.lineTo(0, H * 2.8);
            canvasCtx.lineTo(W * 0.2, H * 1.8);
            canvasCtx.lineTo(W * 0.9, H * 1.5);
            
            // Diagonal jaw connectors
            canvasCtx.moveTo(-W * 0.7, H * 2.5);
            canvasCtx.lineTo(0, H * 3.5);
            canvasCtx.lineTo(W * 0.7, H * 2.5);
            
            // Upper face web (forehead)
            canvasCtx.moveTo(0, -H * 1.8);
            canvasCtx.lineTo(0, -H * 3.0);
            
            canvasCtx.moveTo(-W * 0.35, -H * 1.5);
            canvasCtx.lineTo(-W * 0.6, -H * 2.8);
            canvasCtx.moveTo(W * 0.35, -H * 1.5);
            canvasCtx.lineTo(W * 0.6, -H * 2.8);
            
            canvasCtx.moveTo(-W * 0.7, -H * 1.2);
            canvasCtx.lineTo(-W * 0.85, -H * 1.8);
            canvasCtx.moveTo(W * 0.7, -H * 1.2);
            canvasCtx.lineTo(W * 0.85, -H * 1.8);
            
            // Draw Metal Plate
            const pW = W * 0.3;
            const pH = H * 0.9;
            const pY = -H * 1.8;
            canvasCtx.rect(-pW/2, pY, pW, pH);
            const bY = pY + pH/2;
            canvasCtx.moveTo(-pW*0.25 + 2, bY); canvasCtx.arc(-pW*0.25, bY, 2, 0, Math.PI*2);
            canvasCtx.moveTo(0 + 2, bY); canvasCtx.arc(0, bY, 2, 0, Math.PI*2);
            canvasCtx.moveTo(pW*0.25 + 2, bY); canvasCtx.arc(pW*0.25, bY, 2, 0, Math.PI*2);
            
            canvasCtx.stroke(); // Draw all cyan parts
            
            // Pink Wireframes (Ears & Headband)
            canvasCtx.strokeStyle = '#ff00ea';
            canvasCtx.shadowColor = '#ff00ea';
            canvasCtx.beginPath();
            
            const pBotY = pY + pH;
            // Left Headband
            canvasCtx.moveTo(-pW/2, pBotY); canvasCtx.lineTo(-W * 0.8, -H * 0.6); // bottom edge
            canvasCtx.moveTo(-pW/2, pY); canvasCtx.lineTo(-W * 0.8, -H * 1.0); // top edge
            canvasCtx.moveTo(-pW/2, pBotY); canvasCtx.lineTo(-W * 0.5, pY); canvasCtx.lineTo(-W * 0.6, pBotY); canvasCtx.lineTo(-W * 0.8, -H * 1.0); // zig-zag
            
            // Right Headband
            canvasCtx.moveTo(pW/2, pBotY); canvasCtx.lineTo(W * 0.8, -H * 0.6); // bottom
            canvasCtx.moveTo(pW/2, pY); canvasCtx.lineTo(W * 0.8, -H * 1.0); // top
            canvasCtx.moveTo(pW/2, pBotY); canvasCtx.lineTo(W * 0.5, pY); canvasCtx.lineTo(W * 0.6, pBotY); canvasCtx.lineTo(W * 0.8, -H * 1.0); // zig-zag
            
            // Left Ear
            canvasCtx.moveTo(-W * 0.4, -H * 1.8);
            canvasCtx.lineTo(-W * 0.75, -H * 4.2);
            canvasCtx.lineTo(-W * 0.85, -H * 1.3);
            canvasCtx.lineTo(-W * 0.4, -H * 1.8); // close
            canvasCtx.moveTo(-W * 0.6, -H * 2.5); canvasCtx.lineTo(-W * 0.75, -H * 4.2); // inner vertical
            canvasCtx.moveTo(-W * 0.5, -H * 3.2); canvasCtx.lineTo(-W * 0.72, -H * 2.9); // crosshatch
            
            // Right Ear
            canvasCtx.moveTo(W * 0.4, -H * 1.8);
            canvasCtx.lineTo(W * 0.75, -H * 4.2);
            canvasCtx.lineTo(W * 0.85, -H * 1.3);
            canvasCtx.lineTo(W * 0.4, -H * 1.8); // close
            canvasCtx.moveTo(W * 0.6, -H * 2.5); canvasCtx.lineTo(W * 0.75, -H * 4.2); // inner vertical
            canvasCtx.moveTo(W * 0.5, -H * 3.2); canvasCtx.lineTo(W * 0.72, -H * 2.9); // crosshatch
            
            canvasCtx.stroke();
            
            // Whiskers (Light cyan/white)
            canvasCtx.strokeStyle = '#e0ffff';
            canvasCtx.shadowColor = '#00f3ff';
            canvasCtx.beginPath();
            // Right
            canvasCtx.moveTo(W * 0.6, H * 1.2); canvasCtx.lineTo(W * 1.5, H * 1.3);
            canvasCtx.moveTo(W * 0.7, H * 1.8); canvasCtx.lineTo(W * 1.6, H * 1.8);
            canvasCtx.moveTo(W * 0.6, H * 2.4); canvasCtx.lineTo(W * 1.5, H * 2.3);
            // Left
            canvasCtx.moveTo(-W * 0.6, H * 1.2); canvasCtx.lineTo(-W * 1.5, H * 1.3);
            canvasCtx.moveTo(-W * 0.7, H * 1.8); canvasCtx.lineTo(-W * 1.6, H * 1.8);
            canvasCtx.moveTo(-W * 0.6, H * 2.4); canvasCtx.lineTo(-W * 1.5, H * 2.3);
            
            canvasCtx.stroke();

            canvasCtx.restore();
        }
    }

    const keyedHands =
        currentHandResults?.landmarks?.length > 0
            ? buildKeyedHands(currentHandResults)
            : [];

    const tPerf = performance.now();
    const activeKeys = new Set(keyedHands.map((h) => h.key));
    for (const { key } of keyedHands) {
        handKeyLastSeenMs.set(key, tPerf);
    }

    // Slice collision: fingertip motion with sub-steps + short grace when track drops
    for (const { key, landmarks } of keyedHands) {
        let prev = prevFingertipsByKey.get(key);
        if (!prev) {
            prev = {};
            prevFingertipsByKey.set(key, prev);
        }
        let velMap = tipVelocityByKey.get(key);
        if (!velMap) {
            velMap = {};
            tipVelocityByKey.set(key, velMap);
        }
        for (const tipIdx of SLICE_FINGERTIP_INDICES) {
            const tip = getScreenPoint(landmarks[tipIdx]);
            if (prev[tipIdx]) {
                appendSweepCollisionSegments(handSegments, prev[tipIdx], tip);
                const jx = tip.x - prev[tipIdx].x;
                const jy = tip.y - prev[tipIdx].y;
                const jump = Math.hypot(jx, jy);
                if (jump < MAX_JUMP_FOR_VELOCITY_PX) {
                    if (!velMap[tipIdx]) velMap[tipIdx] = { vx: 0, vy: 0 };
                    const sm = TIP_VELOCITY_SMOOTH;
                    velMap[tipIdx].vx = velMap[tipIdx].vx * (1 - sm) + jx * sm;
                    velMap[tipIdx].vy = velMap[tipIdx].vy * (1 - sm) + jy * sm;
                }
            }
            prev[tipIdx] = tip;
        }
    }

    for (const key of prevFingertipsByKey.keys()) {
        if (activeKeys.has(key)) continue;
        const lastSeen = handKeyLastSeenMs.get(key);
        if (lastSeen === undefined || tPerf - lastSeen > HAND_LOST_GRACE_MS) continue;

        const prev = prevFingertipsByKey.get(key);
        const velMap = tipVelocityByKey.get(key);
        if (!prev || !velMap) continue;

        for (const tipIdx of SLICE_FINGERTIP_INDICES) {
            if (!prev[tipIdx]) continue;
            const v = velMap[tipIdx];
            if (!v) continue;
            const tip = { x: prev[tipIdx].x + v.vx, y: prev[tipIdx].y + v.vy };
            v.vx *= GHOST_VELOCITY_DAMP;
            v.vy *= GHOST_VELOCITY_DAMP;
            appendSweepCollisionSegments(handSegments, prev[tipIdx], tip);
            prev[tipIdx] = tip;
        }
    }

    for (const key of [...prevFingertipsByKey.keys()]) {
        const lastSeen = handKeyLastSeenMs.get(key);
        if (lastSeen !== undefined && tPerf - lastSeen > HAND_LOST_GRACE_MS) {
            prevFingertipsByKey.delete(key);
            tipVelocityByKey.delete(key);
            handKeyLastSeenMs.delete(key);
        }
    }

    // Draw Hands (same order as keyedHands)
    if (keyedHands.length > 0) {
        for (const { key, landmarks } of keyedHands) {
            canvasCtx.strokeStyle = '#ff00ea';
            canvasCtx.lineWidth = 10;
            canvasCtx.shadowColor = '#ff00ea';
            canvasCtx.shadowBlur = 20;
            
            for (const connection of HAND_CONNECTIONS) {
                const a = getScreenPoint(landmarks[connection.start]);
                const b = getScreenPoint(landmarks[connection.end]);
                
                canvasCtx.beginPath();
                canvasCtx.moveTo(a.x, a.y);
                canvasCtx.lineTo(b.x, b.y);
                canvasCtx.stroke();
            }
            canvasCtx.shadowBlur = 0; // reset glow

            SLICE_FINGERTIP_INDICES.forEach((tipIndex) => {
                const tip = getScreenPoint(landmarks[tipIndex]);
                const baseIdx = TIP_CLAW_BASE[tipIndex];
                const proximal = getScreenPoint(landmarks[baseIdx]);
                drawFingertipClaw(canvasCtx, tip, proximal);
            });
        }
    }

    // Update and draw fruits
    const now = Date.now();
    const unslicedCount = fruits.filter((f) => !f.isSliced).length;
    if (now - lastSpawnTime >= levelCfg.spawnIntervalMs && unslicedCount < levelCfg.maxConcurrent) {
        fruits.push(new Fruit());
        lastSpawnTime = now;
    }

    for (let i = fruits.length - 1; i >= 0; i--) {
        let fruit = fruits[i];
        fruit.update(dt);
        fruit.draw(canvasCtx);

        // Check collision if not sliced
        if (!fruit.isSliced) {
            for (let seg of handSegments) {
                if (lineCircleCollide(seg.a, seg.b, fruit)) {
                    fruit.isSliced = true;
                    fruit.cutAngle = fruit.rotation;
                    fruit.rot1 = fruit.rotation;
                    fruit.rot2 = fruit.rotation;
                    fruit.rotSpeed1 = fruit.rotationSpeed - 0.05;
                    fruit.rotSpeed2 = fruit.rotationSpeed + 0.05;

                    score += 10;
                    scoreDisplay.innerText = `Score: ${score}`;
                    
                    particles.push(new SliceBurst(fruit.x, fruit.y, fruit.color));
                    for (let p = 0; p < 26; p++) {
                        particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'dot'));
                    }
                    for (let p = 0; p < 16; p++) {
                        particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'spark'));
                    }
                    break; // stop checking segments for this fruit
                }
            }
        }

        // Remove if out of bounds (bottom)
        if (fruit.y > gameLayout.h + 100) {
            if (!fruit.isSliced) {
                score = Math.max(0, score - MISS_PENALTY);
                scoreDisplay.innerText = `Score: ${score}`;
            }
            fruits.splice(i, 1);
        }
    }

    // Update and draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.update(dt);
        p.draw(canvasCtx);
        if (p.life <= 0) particles.splice(i, 1);
    }

    if (isPlaying) requestAnimationFrame(gameLoop);
}

// Start sequence
async function start() {
    try {
        await setupWebcam();
        await initializeModels();
    } catch (e) {
        console.error(e);
        loadingElement.innerHTML = "Error loading. Check camera permissions.";
    }
}

start();
