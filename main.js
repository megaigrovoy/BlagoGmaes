import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

/** Совпадает с dependencies в package.json — не @latest, стабильнее кэш CDN */
const MEDIAPIPE_TASKS_VISION_WASM_VER = '0.10.34';

const STORAGE_SFX_OFF = 'neon-ninja-sfx-off';
const STORAGE_MUSIC_OFF = 'neon-ninja-music-off';

/** Добавьте ?perf=1 к URL — в консоли раз в ~2.5 с среднее время кадра (поиск фризов на проде) */
const DEBUG_FRAME_PERF =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1';

/** Звуки резов / металлических ударов по роботу */
let soundEffectsEnabled = true;
/** Фоновая музыка в меню и в игре */
let musicEnabled = true;

function loadPersistedAudioSettings() {
    soundEffectsEnabled = localStorage.getItem(STORAGE_SFX_OFF) !== '1';
    musicEnabled = localStorage.getItem(STORAGE_MUSIC_OFF) !== '1';
    const sfxCb = document.getElementById('opt-sound-off');
    const musicCb = document.getElementById('opt-music-off');
    if (sfxCb) sfxCb.checked = !soundEffectsEnabled;
    if (musicCb) musicCb.checked = !musicEnabled;
}

/** URL звука разреза на каждый эмодзи (6 файлов на 9 типов — часть клипов переиспользуется). */
const sliceSoundUrlByEmoji = {
    '🍌': new URL('./src/assets/sounds/Sound Of Fruit Slice.mp3', import.meta.url).href,
    '🍎': new URL('./src/assets/sounds/Sound Of Fruit Slice 2.mp3', import.meta.url).href,
    '🍉': new URL('./src/assets/sounds/Sound Of Fruit Slice 3.mp3', import.meta.url).href,
    '🍊': new URL('./src/assets/sounds/Sound Of Fruit Slice 4.mp3', import.meta.url).href,
    '🍗': new URL('./src/assets/sounds/Sound Of Meat Slice.mp3', import.meta.url).href,
    '🥩': new URL('./src/assets/sounds/Sound Of Meat Slice2.mp3', import.meta.url).href,
    '🥦': new URL('./src/assets/sounds/Sound Of Fruit Slice 2.mp3', import.meta.url).href,
    '🥬': new URL('./src/assets/sounds/Sound Of Fruit Slice.mp3', import.meta.url).href,
    '🍆': new URL('./src/assets/sounds/Sound Of Fruit Slice 3.mp3', import.meta.url).href,
    '🤖': new URL('./src/assets/sounds/Sound Of Fruit Slice 4.mp3', import.meta.url).href
};

const METAL_HIT_URL_1 = new URL('./src/assets/sounds/Sound Of Metal Box Hit1.mp3', import.meta.url).href;
const METAL_HIT_URL_2 = new URL('./src/assets/sounds/Sound Of Metal Box Hit2.mp3', import.meta.url).href;

function playSliceSound(emoji) {
    if (!soundEffectsEnabled) return;
    playOneShotSfx(sliceSoundUrlByEmoji[emoji], 0.88);
}

function playRobotMetalHit(which) {
    if (!soundEffectsEnabled) return;
    playOneShotSfx(which === 1 ? METAL_HIT_URL_1 : METAL_HIT_URL_2, 0.9);
}

const MENU_MUSIC_URL = new URL('./src/assets/sounds/menu.mp3', import.meta.url).href;
/** Фоновые треки в игре — все .mp3 из src/assets/sounds/OST */
const GAME_BG_TRACKS = Object.values(
    import.meta.glob('./src/assets/sounds/OST/*.mp3', { eager: true, query: '?url', import: 'default' })
);

/** Декодированные буферы для SFX: на iPad/WebKit второй HTMLAudio часто молчит, пока играет музыка */
const sfxAudioBufferByUrl = new Map();
const sfxAudioBufferPromiseByUrl = new Map();

function getOrCreateSfxContext() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        if (!window.__ninjaAudioCtx) window.__ninjaAudioCtx = new AC();
        return window.__ninjaAudioCtx;
    } catch (_) {
        return null;
    }
}

function ensureSfxAudioBuffer(ctx, url) {
    if (!url || !ctx) return Promise.reject(new Error('no ctx/url'));
    const hit = sfxAudioBufferByUrl.get(url);
    if (hit) return Promise.resolve(hit);
    const inflight = sfxAudioBufferPromiseByUrl.get(url);
    if (inflight) return inflight;
    const p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => {
            sfxAudioBufferByUrl.set(url, buf);
            sfxAudioBufferPromiseByUrl.delete(url);
            return buf;
        })
        .catch((e) => {
            sfxAudioBufferPromiseByUrl.delete(url);
            throw e;
        });
    sfxAudioBufferPromiseByUrl.set(url, p);
    return p;
}

function playDecodedSfx(ctx, buffer, volume) {
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0);
}

function playOneShotSfx(url, volume) {
    if (!soundEffectsEnabled || !url) return;
    const ctx = window.__ninjaAudioCtx || getOrCreateSfxContext();
    const ready = ctx && sfxAudioBufferByUrl.get(url);
    if (ctx && ready) {
        try {
            playDecodedSfx(ctx, ready, volume);
        } catch (_) {
            fallbackHtmlOneShot(url, volume);
        }
        return;
    }
    if (ctx) {
        void ensureSfxAudioBuffer(ctx, url)
            .then((buf) => {
                if (!soundEffectsEnabled) return;
                try {
                    playDecodedSfx(ctx, buf, volume);
                } catch (_) {
                    fallbackHtmlOneShot(url, volume);
                }
            })
            .catch(() => fallbackHtmlOneShot(url, volume));
        return;
    }
    fallbackHtmlOneShot(url, volume);
}

function fallbackHtmlOneShot(url, volume) {
    const a = new Audio(url);
    a.volume = volume;
    void a.play().catch(() => {});
}

/**
 * На проде (CDN, холодный кэш) одновременная подгрузка всех OST + параллельный decodeAudioData для SFX
 * даёт рывки главного потока; локально кэш/диск маскирует это.
 */
function preloadHtmlAudioUrl(url) {
    if (!url) return;
    const a = new Audio();
    a.preload = 'auto';
    a.src = url;
    void a.load();
}

function scheduleStaggeredOstPreload() {
    const tracks = GAME_BG_TRACKS.filter(Boolean);
    if (!tracks.length) return;
    let i = 0;
    const step = () => {
        if (i >= tracks.length) return;
        preloadHtmlAudioUrl(tracks[i++]);
        setTimeout(step, 120);
    };
    const kick = () => step();
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(kick, { timeout: 1800 });
    } else {
        setTimeout(kick, 400);
    }
}

function warmSfxAudioBuffersYielding() {
    const ctx = getOrCreateSfxContext();
    if (!ctx) return;
    const sfxOnly = [
        ...new Set([...Object.values(sliceSoundUrlByEmoji), METAL_HIT_URL_1, METAL_HIT_URL_2])
    ].filter(Boolean);
    void (async () => {
        for (const u of sfxOnly) {
            try {
                await ensureSfxAudioBuffer(ctx, u);
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 16));
        }
    })();
}

/** Ранняя загрузка/декод mp3 — иначе первый рез на проде ждёт сеть/декодер */
function preloadGameAudio() {
    if (soundEffectsEnabled) {
        const sfxUrls = [
            ...new Set([...Object.values(sliceSoundUrlByEmoji), METAL_HIT_URL_1, METAL_HIT_URL_2])
        ].filter(Boolean);
        for (const u of sfxUrls) preloadHtmlAudioUrl(u);
        warmSfxAudioBuffersYielding();
    }
    if (musicEnabled) {
        preloadHtmlAudioUrl(MENU_MUSIC_URL);
        scheduleStaggeredOstPreload();
    }
}

/** База WASM с того же origin, что и страница (npm run prepare:wasm → public/mediapipe-wasm) */
function getMediapipeWasmUrl() {
    let base = import.meta.env.BASE_URL || '/';
    if (!base.endsWith('/')) base += '/';
    return new URL('mediapipe-wasm', window.location.origin + base).href;
}

/**
 * iOS / iPad Chrome (WebKit): нужен реальный play() по жесту; data:-WAV часто молчит.
 * Цепочка mp3 с того же origin + сброс AudioContext.
 */
let htmlAudioUnlocked = false;
let audioUnlockBusy = false;

function resumeSharedAudioContext() {
    const ctx = getOrCreateSfxContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
}

function tryUnlockAudioOnUserGesture() {
    if (htmlAudioUnlocked || audioUnlockBusy) return;
    audioUnlockBusy = true;
    resumeSharedAudioContext();

    const srcs = [sliceSoundUrlByEmoji['🍌'], sliceSoundUrlByEmoji['🍎'], MENU_MUSIC_URL];

    const playSrcAt = (i) => {
        if (i >= srcs.length) return Promise.reject(new Error('no unlock src'));
        const a = new Audio();
        a.preload = 'auto';
        a.src = srcs[i];
        a.volume = 0.04;
        try {
            a.load();
        } catch (_) {}
        return a
            .play()
            .then(() => {
                try {
                    a.pause();
                    a.src = '';
                } catch (_) {}
            })
            .catch(() => playSrcAt(i + 1));
    };

    const busyTimer = setTimeout(() => {
        audioUnlockBusy = false;
    }, 3000);
    void playSrcAt(0)
        .then(() => {
            htmlAudioUnlocked = true;
        })
        .catch(() => {})
        .finally(() => {
            clearTimeout(busyTimer);
            audioUnlockBusy = false;
        });
}

let menuMusicAudio = null;
let gameMusicAudio = null;
let gameMusicOnEnded = null;
/** Перемешанный порядок OST на сессию игры */
let gameMusicPlaylist = [];
let gameMusicPlaylistIndex = 0;

function shuffleArrayInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function getMenuMusicAudio() {
    if (!menuMusicAudio) {
        menuMusicAudio = new Audio(MENU_MUSIC_URL);
        menuMusicAudio.loop = true;
        menuMusicAudio.volume = 0.52;
    }
    return menuMusicAudio;
}

function playMenuMusic() {
    if (!musicEnabled) return;
    void getMenuMusicAudio().play().catch(() => {});
}

function pauseMenuMusic() {
    if (menuMusicAudio) {
        menuMusicAudio.pause();
        menuMusicAudio.currentTime = 0;
    }
}

function stopGameMusic() {
    if (gameMusicAudio && gameMusicOnEnded) {
        gameMusicAudio.removeEventListener('ended', gameMusicOnEnded);
    }
    if (gameMusicAudio) {
        gameMusicAudio.pause();
        gameMusicAudio = null;
    }
    gameMusicOnEnded = null;
}

function playGameMusicTrackAt(index) {
    if (!musicEnabled) {
        stopGameMusic();
        return;
    }
    stopGameMusic();
    if (!gameMusicPlaylist.length) return;
    gameMusicPlaylistIndex = ((index % gameMusicPlaylist.length) + gameMusicPlaylist.length) % gameMusicPlaylist.length;
    const url = gameMusicPlaylist[gameMusicPlaylistIndex];
    const a = new Audio(url);
    a.volume = 0.46;
    gameMusicOnEnded = () => {
        gameMusicPlaylistIndex = (gameMusicPlaylistIndex + 1) % gameMusicPlaylist.length;
        playGameMusicTrackAt(gameMusicPlaylistIndex);
    };
    a.addEventListener('ended', gameMusicOnEnded);
    gameMusicAudio = a;
    void a.play().catch(() => {});
}

function startGameMusicPlaylist() {
    pauseMenuMusic();
    if (!musicEnabled || !GAME_BG_TRACKS.length) return;
    gameMusicPlaylist = [...GAME_BG_TRACKS];
    shuffleArrayInPlace(gameMusicPlaylist);
    gameMusicPlaylistIndex = 0;
    playGameMusicTrackAt(0);
}

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

/** maxConcurrent = unsliced fruits cap; spawnIntervalMs = try spawn at most this often; onlyRobots = тестовый режим */
const LEVELS = [
    { maxConcurrent: 1, spawnIntervalMs: 2200 },
    { maxConcurrent: 2, spawnIntervalMs: 1900 },
    { maxConcurrent: 3, spawnIntervalMs: 1550 },
    { maxConcurrent: 4, spawnIntervalMs: 1250 },
    { maxConcurrent: 5, spawnIntervalMs: 1050 },
    { maxConcurrent: 4, spawnIntervalMs: 1000, onlyRobots: true }
];
/** Кадров подряд без пересечения с предметом, чтобы снова считать «новый вход» (трекинг мерцает на границе круга) */
const CONTACT_EXIT_DEBOUNCE_FRAMES = 7;
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
    stopGameMusic();
    mainMenu.classList.remove('is-hidden');
    hudGame.classList.add('is-hidden');
    fruits.length = 0;
    particles.length = 0;
    prevFingertipsByKey.clear();
    handKeyLastSeenMs.clear();
    tipVelocityByKey.clear();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    /** Полноэкранный canvas под меню всё равно участвует в композитинге — убираем из дерева отрисовки */
    canvasElement.style.visibility = "hidden";
    /** В меню кадр камеры не нужен — меньше декодер/GPU, плавнее CSS */
    void video.pause();
    playMenuMusic();
}

function startLevel(levelIndex) {
    tryUnlockAudioOnUserGesture();
    currentLevelIndex = Math.max(0, Math.min(LEVELS.length - 1, levelIndex));
    const cfg = getCurrentLevelConfig();
    score = 0;
    scoreDisplay.innerText = `Score: ${score}`;
    levelDisplay.textContent = cfg.onlyRobots
        ? `Уровень ${currentLevelIndex + 1} · тест · только роботы`
        : `Уровень ${currentLevelIndex + 1} · одновременно ${pluralObjectsRu(cfg.maxConcurrent)}`;
    fruits.length = 0;
    particles.length = 0;
    lastSpawnTime = Date.now();
    lastFrameTime = performance.now();
    mainMenu.classList.add('is-hidden');
    hudGame.classList.remove('is-hidden');
    canvasElement.style.visibility = "";
    isPlaying = true;
    void video.play().catch(() => {});
    /** Музыка и первый кадр — в microtask после unlock play(), иначе iOS Chrome иногда глушит первый HTMLAudio */
    queueMicrotask(() => {
        startGameMusicPlaylist();
        requestAnimationFrame(gameLoop);
    });
}

LEVELS.forEach((cfg, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'level-btn';
    const sub = cfg.onlyRobots ? 'тест · только роботы' : `одновременно ${pluralObjectsRu(cfg.maxConcurrent)}`;
    btn.innerHTML = `<span class="level-title">Уровень ${i + 1}</span><span class="level-sub">${sub}</span>`;
    btn.addEventListener('click', () => startLevel(i));
    levelGrid.appendChild(btn);
});

btnBackMenu.addEventListener('click', () => showMainMenu());

/** Автозапуск после загрузки часто блокируется — тап по панели (не по кнопке уровня) включает меню */
mainMenu.addEventListener(
    'pointerdown',
    (e) => {
        if (isPlaying) return;
        tryUnlockAudioOnUserGesture();
        if (e.target?.closest?.('.level-btn')) return;
        if (e.target?.closest?.('.menu-options')) return;
        playMenuMusic();
    },
    { capture: true }
);

/** iPad / iOS Chrome: touchstart + touchend — часть сборок открывает аудио только на одном из них */
mainMenu.addEventListener(
    'touchstart',
    () => {
        if (!isPlaying) tryUnlockAudioOnUserGesture();
    },
    { capture: true, passive: true }
);
mainMenu.addEventListener(
    'touchend',
    () => {
        if (!isPlaying) tryUnlockAudioOnUserGesture();
    },
    { capture: true, passive: true }
);

const optSoundOff = document.getElementById('opt-sound-off');
const optMusicOff = document.getElementById('opt-music-off');
if (optSoundOff) {
    optSoundOff.addEventListener('change', () => {
        soundEffectsEnabled = !optSoundOff.checked;
        if (soundEffectsEnabled) localStorage.removeItem(STORAGE_SFX_OFF);
        else localStorage.setItem(STORAGE_SFX_OFF, '1');
    });
}
if (optMusicOff) {
    optMusicOff.addEventListener('change', () => {
        musicEnabled = !optMusicOff.checked;
        if (musicEnabled) {
            localStorage.removeItem(STORAGE_MUSIC_OFF);
            if (!isPlaying) playMenuMusic();
        } else {
            localStorage.setItem(STORAGE_MUSIC_OFF, '1');
            pauseMenuMusic();
            stopGameMusic();
        }
    });
}
loadPersistedAudioSettings();

// Geometry configuration
const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

/**
 * Короткий «каркас кисти» у BlazePose (запястье + пальцевые точки) — рисуется голубым
 * рядом с рукой MediaPipe и даёт лишний треугольник. Линии предплечья 13–15 / 14–16 оставляем.
 */
function isPoseWristHandStubConnection(start, end) {
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    return (
        (a === 15 && (b === 17 || b === 19 || b === 21)) ||
        (a === 17 && b === 19) ||
        (a === 16 && (b === 18 || b === 20 || b === 22)) ||
        (a === 18 && b === 20)
    );
}

// Resize canvas to match window completely
/** Logical game size (matches canvas buffer; avoids 100vh vs innerHeight stretch on mobile) */
let gameLayout = { w: 800, h: 600, minSide: 600 };

function readViewportSize() {
    const vv = window.visualViewport;
    const w = Math.max(1, Math.floor(vv?.width ?? window.innerWidth));
    const h = Math.max(1, Math.floor(vv?.height ?? window.innerHeight));
    return { w, h };
}

/** Последние применённые размеры — без лишнего сброса canvas */
let lastResizeW = 0;
let lastResizeH = 0;

function resizeCanvas() {
    const { w, h } = readViewportSize();
    if (w === lastResizeW && h === lastResizeH) return;
    lastResizeW = w;
    lastResizeH = h;
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

/** Частые события visualViewport (адресная строка, зум) иначе десятки раз сбрасывают canvas */
let resizeCanvasDebounce = 0;
function scheduleResizeCanvas() {
    /** Во время игры отложенный ресайз ломает попадание координат → «пропадают» кисти */
    if (isPlaying) {
        clearTimeout(resizeCanvasDebounce);
        resizeCanvasDebounce = 0;
        resizeCanvas();
        return;
    }
    clearTimeout(resizeCanvasDebounce);
    resizeCanvasDebounce = setTimeout(() => {
        resizeCanvasDebounce = 0;
        resizeCanvas();
    }, 110);
}

window.addEventListener('resize', scheduleResizeCanvas);
window.visualViewport?.addEventListener('resize', scheduleResizeCanvas);
resizeCanvas();

function stopVideoTracks() {
    const s = video.srcObject;
    if (s && typeof s.getTracks === "function") {
        s.getTracks().forEach((t) => t.stop());
    }
    video.srcObject = null;
}

/** Дождаться готовности video: размеры/кадр (иначе Chrome может дать Timeout starting video source). */
function waitForVideoReady(el, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        if (el.readyState >= 2 && el.videoWidth > 0) {
            resolve();
            return;
        }
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            el.removeEventListener("loadedmetadata", onMeta);
            el.removeEventListener("loadeddata", onData);
            el.removeEventListener("canplay", onPlay);
            if (ok) resolve();
            else reject(new Error("Video metadata timeout"));
        };
        const onMeta = () => {
            if (el.videoWidth > 0) finish(true);
        };
        const onData = () => finish(true);
        const onPlay = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("loadeddata", onData);
        el.addEventListener("canplay", onPlay);
    });
}

async function setupWebcam() {
    const nav = window.navigator;
    if (!nav.mediaDevices?.getUserMedia) {
        throw new Error("Webcam not supported.");
    }

    video.muted = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("autoplay", "");

    const constraintSets = [
        { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } },
        { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } },
        { video: { facingMode: "user" } },
        { video: true }
    ];

    let lastErr;
    for (const constraints of constraintSets) {
        try {
            stopVideoTracks();
            const stream = await nav.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            await waitForVideoReady(video, 25000);
            await video.play();
            return;
        } catch (e) {
            lastErr = e;
            console.warn("Webcam attempt failed:", constraints, e);
            stopVideoTracks();
        }
    }
    throw lastErr ?? new Error("Could not open webcam");
}

/** В консоли видно, не ушли ли оба лендмаркера на CPU (тогда FPS падает сильно) */
let mediapipeHandDelegate = 'CPU';
let mediapipePoseDelegate = 'CPU';

async function initializeModels() {
    let vision;
    const wasmLocal = getMediapipeWasmUrl();
    let visionWasmSource = 'same-origin';
    try {
        vision = await FilesetResolver.forVisionTasks(wasmLocal);
    } catch (e) {
        console.warn('MediaPipe wasm с этого сайта не открылся, fallback CDN:', e);
        visionWasmSource = 'jsdelivr-fallback';
        vision = await FilesetResolver.forVisionTasks(
            `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_WASM_VER}/wasm`
        );
    }
    console.info(`[NeonNinjaCat] MediaPipe WASM: ${visionWasmSource} ← ${wasmLocal}`);

    const handOpts = (delegate) => ({
        baseOptions: {
            modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.35
    });

    const poseOpts = (delegate) => ({
        baseOptions: {
            modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
            delegate
        },
        runningMode: "VIDEO"
    });

    try {
        handLandmarker = await HandLandmarker.createFromOptions(vision, handOpts("GPU"));
        mediapipeHandDelegate = 'GPU';
    } catch (e) {
        console.warn("HandLandmarker GPU failed, using CPU:", e);
        handLandmarker = await HandLandmarker.createFromOptions(vision, handOpts("CPU"));
        mediapipeHandDelegate = 'CPU';
    }

    try {
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOpts("GPU"));
        mediapipePoseDelegate = 'GPU';
    } catch (e) {
        console.warn("PoseLandmarker GPU failed, using CPU:", e);
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOpts("CPU"));
        mediapipePoseDelegate = 'CPU';
    }

    console.info(
        `[MediaPipe] hand: ${mediapipeHandDelegate}, pose: ${mediapipePoseDelegate} — если оба CPU, игра тяжелее; в DevTools отключите throttling.`
    );

    preloadGameAudio();

    loadingElement.classList.remove('visible');
    showMainMenu();
}

// Game Objects
const fruitEmojiTextures = {};

function initFruitTextures() {
    const emojis = ['🍌', '🍎', '🍉', '🍊', '🍗', '🥩', '🥦', '🥬', '🍆', '🤖'];
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
            { emoji: '🍆', color: '#9c27b0' }, // Eggplant purple
            { emoji: '🤖', color: '#90caf9' } // Robot (металл / неон)
        ];
        const levelCfg = getCurrentLevelConfig();
        const type = levelCfg.onlyRobots
            ? fruitTypes.find((t) => t.emoji === '🤖')
            : fruitTypes[Math.floor(Math.random() * fruitTypes.length)];
        this.emoji = type.emoji;
        this.color = type.color;
        if (this.emoji === '🤖') {
            this.radius = Math.min(240, this.radius * 1.5);
        }

        this.isSliced = false;
        this.isRobotQuad = false;
        this.sliceOffsetX = 0;
        this.robotHits = 0;
        this.hitFlash = 0;
        /** Путь «вошёл в предмет» vs «ещё внутри» — один рез на один проход руки */
        this._wasTouchingHand = false;
        /** Сколько кадров подряд нет пересечения (сброс _wasTouchingHand только после дебаунса) */
        this._noContactFrames = 0;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotationSpeed = (Math.random() - 0.5) * 0.1; // Random spin speed
        
        this.cutAngle = 0;
        this.rot1 = 0;
        this.rot2 = 0;
        this.rot3 = 0;
        this.rot4 = 0;
        this.rotSpeed1 = 0;
        this.rotSpeed2 = 0;
        this.rotSpeed3 = 0;
        this.rotSpeed4 = 0;
    }

    update(dt = 1) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.vy += this.gravity * dt;
        
        if (this.hitFlash > 0) this.hitFlash -= 0.35 * dt;

        if (!this.isSliced) {
            this.rotation += this.rotationSpeed * dt;
        } else {
            // Робот на 4 части: чуть сильнее обычного резa, без «ядреного» разлёта
            this.sliceOffsetX += (this.isRobotQuad ? 12 : 6) * dt;
            this.rot1 += this.rotSpeed1 * dt;
            this.rot2 += this.rotSpeed2 * dt;
            if (this.isRobotQuad) {
                this.rot3 += this.rotSpeed3 * dt;
                this.rot4 += this.rotSpeed4 * dt;
            }
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
            if (this.hitFlash > 0) {
                ctx.shadowColor = '#00f3ff';
                ctx.shadowBlur = 18 + this.hitFlash * 2;
            }
            ctx.drawImage(texture, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
            ctx.shadowBlur = 0;
        } else if (this.isRobotQuad) {
            const hs = texSize / 2;
            const dw = drawSize / 2;
            const spread = this.sliceOffsetX * 0.82;
            const quads = [
                { sx: 0, sy: 0, rot: this.rot1, ang: 0 },
                { sx: hs, sy: 0, rot: this.rot2, ang: Math.PI / 2 },
                { sx: 0, sy: hs, rot: this.rot3, ang: Math.PI },
                { sx: hs, sy: hs, rot: this.rot4, ang: (3 * Math.PI) / 2 }
            ];
            for (const q of quads) {
                ctx.save();
                const a = this.cutAngle + q.ang;
                ctx.translate(Math.cos(a) * spread, Math.sin(a) * spread);
                ctx.rotate(q.rot);
                ctx.drawImage(texture, q.sx, q.sy, hs, hs, -dw / 2, -dw / 2, dw, dw);
                ctx.restore();
            }
        } else {
            ctx.save();
            ctx.translate(Math.cos(this.cutAngle + Math.PI) * this.sliceOffsetX, Math.sin(this.cutAngle + Math.PI) * this.sliceOffsetX);
            ctx.rotate(this.rot1);
            ctx.drawImage(
                texture,
                0, 0, texSize / 2, texSize,
                -drawSize / 2, -drawSize / 2,
                drawSize / 2, drawSize
            );
            ctx.restore();

            ctx.save();
            ctx.translate(Math.cos(this.cutAngle) * this.sliceOffsetX, Math.sin(this.cutAngle) * this.sliceOffsetX);
            ctx.rotate(this.rot2);
            ctx.drawImage(
                texture,
                texSize / 2, 0, texSize / 2, texSize,
                0, -drawSize / 2,
                drawSize / 2, drawSize
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

/** Визуальный взрыв при уничтожении робота: вспышка, расходящиеся кольца, крест */
class RobotExplosionFx {
    constructor(x, y, radius) {
        this.x = x;
        this.y = y;
        this.radius = Math.max(40, radius);
        this.life = 1;
        this.rot = Math.random() * Math.PI * 2;
    }
    update(dt = 1) {
        this.life -= 0.052 * dt;
    }
    draw(ctx) {
        const t = Math.max(0, this.life);
        if (t <= 0) return;
        const u = 1 - t;
        const maxR = this.radius;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.globalCompositeOperation = 'lighter';

        const coreR = maxR * (0.35 + u * 2.1);
        ctx.globalAlpha = t * t * 0.75;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.28, 'rgba(0,243,255,0.5)');
        g.addColorStop(0.65, 'rgba(255,0,234,0.22)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, coreR, 0, Math.PI * 2);
        ctx.fill();

        for (let k = 0; k < 3; k++) {
            const phase = Math.min(1, u * 1.4 - k * 0.16);
            if (phase <= 0) continue;
            const rad = maxR * (0.55 + phase * 3.8);
            const a = (1 - phase) * 0.55 * t;
            ctx.globalAlpha = a;
            ctx.strokeStyle = k % 2 === 0 ? '#00f3ff' : '#ff00ea';
            ctx.lineWidth = 2.2 + (1 - phase) * 4.5;
            ctx.shadowBlur = 20;
            ctx.shadowColor = ctx.strokeStyle;
            ctx.beginPath();
            ctx.arc(0, 0, rad, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.rotate(this.rot + u * 1.1);
        ctx.globalAlpha = t * 0.45 * (1 - u * 0.75);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 14;
        ctx.shadowColor = '#00f3ff';
        const L = maxR * (1.15 + u * 2.8);
        ctx.beginPath();
        ctx.moveTo(-L, 0);
        ctx.lineTo(L, 0);
        ctx.moveTo(0, -L);
        ctx.lineTo(0, L);
        ctx.stroke();

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

/** Поза для маски реже рук — меньше нагрузка на главный поток при продакшен-сборке */
const POSE_INFER_EVERY_N_VIDEO_FRAMES = 3;
let poseVideoFrameTick = 0;

let perfFrameSumMs = 0;
let perfFrameCount = 0;
let perfLastLogMs = 0;

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
        /** Время кадра видео (мс) — стабильнее для VIDEO mode, чем performance.now() */
        const frameTsMs = Number.isFinite(video.currentTime) ? video.currentTime * 1000 : startTimeMs;
        try {
            const hRes = handLandmarker.detectForVideo(video, frameTsMs);
            if (hRes) currentHandResults = hRes;
        } catch (err) {
            console.warn("HandLandmarker detectForVideo:", err);
        }
        poseVideoFrameTick += 1;
        if (poseVideoFrameTick >= POSE_INFER_EVERY_N_VIDEO_FRAMES) {
            poseVideoFrameTick = 0;
            try {
                const pRes = poseLandmarker.detectForVideo(video, frameTsMs);
                if (pRes) currentPoseResults = pRes;
            } catch (err) {
                console.warn("PoseLandmarker detectForVideo:", err);
            }
        }
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
                if (isPoseWristHandStubConnection(connection.start, connection.end)) continue;

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

        // Рез: путь кончиков пересёк круг предмета (любой сегмент), но засчёт — на «входе» в контакт, не каждый кадр
        if (!fruit.isSliced) {
            let pathIntersectsFruit = false;
            for (const seg of handSegments) {
                if (lineCircleCollide(seg.a, seg.b, fruit)) {
                    pathIntersectsFruit = true;
                    break;
                }
            }
            if (pathIntersectsFruit) {
                fruit._noContactFrames = 0;
            } else {
                fruit._noContactFrames += 1;
                if (fruit._noContactFrames >= CONTACT_EXIT_DEBOUNCE_FRAMES) {
                    fruit._wasTouchingHand = false;
                }
            }
            const cutStroke = pathIntersectsFruit && !fruit._wasTouchingHand;
            if (pathIntersectsFruit) {
                fruit._wasTouchingHand = true;
            }

            if (cutStroke) {
                if (fruit.emoji === '🤖') {
                    fruit.robotHits += 1;
                    if (fruit.robotHits === 1) {
                        playRobotMetalHit(1);
                        fruit.hitFlash = 12;
                    } else if (fruit.robotHits === 2) {
                        playRobotMetalHit(2);
                        fruit.hitFlash = 12;
                    } else {
                        fruit.isSliced = true;
                        fruit.isRobotQuad = true;
                        fruit.cutAngle = fruit.rotation;
                        fruit.rot1 = fruit.rotation + (Math.random() - 0.5) * 0.45;
                        fruit.rot2 = fruit.rotation + (Math.random() - 0.5) * 0.45;
                        fruit.rot3 = fruit.rotation + (Math.random() - 0.5) * 0.45;
                        fruit.rot4 = fruit.rotation + (Math.random() - 0.5) * 0.45;
                        const rs = fruit.rotationSpeed;
                        const wobble = () => (Math.random() - 0.5) * 0.22;
                        fruit.rotSpeed1 = rs * 2.2 + wobble();
                        fruit.rotSpeed2 = rs * -2.0 + wobble();
                        fruit.rotSpeed3 = rs * 1.85 + wobble();
                        fruit.rotSpeed4 = rs * -2.05 + wobble();
                        const blast = Math.min(72, gameLayout.minSide * 0.055);
                        fruit.vy -= blast * 0.72;
                        fruit.vx += (Math.random() - 0.5) * blast * 0.42;

                        score += 10;
                        scoreDisplay.innerText = `Score: ${score}`;
                        playSliceSound(fruit.emoji);

                        particles.push(new SliceBurst(fruit.x, fruit.y, fruit.color));
                        particles.push(new RobotExplosionFx(fruit.x, fruit.y, fruit.radius));
                        for (let p = 0; p < 34; p++) {
                            particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'dot'));
                        }
                        for (let p = 0; p < 28; p++) {
                            particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'spark'));
                        }
                    }
                } else {
                    fruit.isSliced = true;
                    fruit.cutAngle = fruit.rotation;
                    fruit.rot1 = fruit.rotation;
                    fruit.rot2 = fruit.rotation;
                    fruit.rotSpeed1 = fruit.rotationSpeed - 0.05;
                    fruit.rotSpeed2 = fruit.rotationSpeed + 0.05;

                    score += 10;
                    scoreDisplay.innerText = `Score: ${score}`;
                    playSliceSound(fruit.emoji);

                    particles.push(new SliceBurst(fruit.x, fruit.y, fruit.color));
                    for (let p = 0; p < 26; p++) {
                        particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'dot'));
                    }
                    for (let p = 0; p < 16; p++) {
                        particles.push(new Particle(fruit.x, fruit.y, fruit.color, 'spark'));
                    }
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

    if (DEBUG_FRAME_PERF) {
        const elapsed = performance.now() - startTimeMs;
        perfFrameSumMs += elapsed;
        perfFrameCount += 1;
        const t = performance.now();
        if (t - perfLastLogMs >= 2500) {
            perfLastLogMs = t;
            const avg = perfFrameSumMs / perfFrameCount;
            console.info(
                `[perf] среднее за кадр ${avg.toFixed(1)} ms (n=${perfFrameCount}). >22 ms — риск фризов; вкладка Performance.`
            );
            perfFrameSumMs = 0;
            perfFrameCount = 0;
        }
    }

    if (isPlaying) requestAnimationFrame(gameLoop);
}

function showStartError(e) {
    console.error(e);
    const name = e?.name || "";
    const msg = e?.message || String(e);
    let hint =
        "Откройте консоль браузера (F12 → Console) и при необходимости пришлите текст ошибки.";
    if (name === "NotAllowedError" || /Permission/i.test(msg)) {
        hint =
            "Браузер заблокировал камеру для этого сайта. Нажмите на значок замка слева от адреса → разрешите камеру, обновите страницу.";
    } else if (name === "NotFoundError" || /DevicesNotFound/i.test(msg)) {
        hint = "Камера не найдена. Проверьте, что она подключена и не занята другим приложением.";
    } else if (
        name === "AbortError" ||
        /Timeout starting video source|metadata timeout/i.test(msg)
    ) {
        hint =
            "Камера не успела запуститься. Отключите режим эмуляции устройства в DevTools (или выберите реальное устройство с камерой), закройте другие программы, использующие камеру, и обновите страницу.";
    }
    loadingElement.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "max-width:28rem;margin:0 auto;text-align:left;line-height:1.45;font-size:0.95rem;";
    const t = document.createElement("p");
    t.textContent = "Не удалось запустить игру.";
    t.style.fontWeight = "700";
    t.style.marginBottom = "0.5rem";
    wrap.appendChild(t);
    const d = document.createElement("p");
    d.style.opacity = "0.9";
    d.style.fontSize = "0.85rem";
    d.style.wordBreak = "break-word";
    d.textContent = msg ? `${name ? `[${name}] ` : ""}${msg}` : hint;
    wrap.appendChild(d);
    const h = document.createElement("p");
    h.style.marginTop = "0.75rem";
    h.style.fontSize = "0.82rem";
    h.style.opacity = "0.75";
    h.textContent = hint;
    wrap.appendChild(h);
    loadingElement.appendChild(wrap);
    loadingElement.classList.add("visible");
}

// Start sequence
async function start() {
    try {
        await setupWebcam();
        await initializeModels();
    } catch (e) {
        showStartError(e);
    }
}

start();
