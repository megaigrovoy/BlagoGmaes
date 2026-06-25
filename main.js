import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

/** Совпадает с dependencies в package.json — не @latest, стабильнее кэш CDN */
const MEDIAPIPE_TASKS_VISION_WASM_VER = '0.10.34';

const STORAGE_SFX_OFF = 'neon-ninja-sfx-off';
const STORAGE_MUSIC_OFF = 'neon-ninja-music-off';
const STORAGE_PLAYER_COUNT = 'neon-ninja-player-count';
const STORAGE_UI_LANG = 'neon-ninja-ui-lang';

function loadUiLangPreference() {
    const raw = localStorage.getItem(STORAGE_UI_LANG);
    return raw === 'en' ? 'en' : 'ru';
}

function loadPlayerCountPreference() {
    const raw = localStorage.getItem(STORAGE_PLAYER_COUNT);
    return raw === '1' ? 1 : 2;
}

/** ru | en — сохраняется в localStorage при переключении языка */
let uiLang = loadUiLangPreference();

/** 1 или 2 — как numPoses у PoseLandmarker */
let playerModeCount = loadPlayerCountPreference();

/** Добавьте ?perf=1 к URL — в консоли раз в ~2.5 с среднее время кадра (поиск фризов на проде) */
const DEBUG_FRAME_PERF =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1';

/** Профиль трекинга: Android — CPU-делегат, интерполяция 30→120 Гц, мягче пороги (см. mobile-tracking-fix.md) */
function detectTrackTuning() {
    const ua = navigator.userAgent || '';
    const android = /Android/i.test(ua);
    const iphone = /iPhone|iPod/i.test(ua);
    const mobile =
        android ||
        iphone ||
        (navigator.maxTouchPoints > 0 &&
            Math.min(window.screen?.width ?? 9999, window.screen?.height ?? 9999) < 820);
    return {
        android,
        mobile,
        /** Интерполяция display-landmarks между кадрами камеры на высокочастотных экранах */
        interpolatePose: android || iphone
    };
}
const trackTuning = detectTrackTuning();

/** Звуки резов */
let soundEffectsEnabled = true;
/** Фоновая музыка в меню и в игре */
let musicEnabled = true;

function loadPersistedSettings() {
    soundEffectsEnabled = localStorage.getItem(STORAGE_SFX_OFF) !== '1';
    musicEnabled = localStorage.getItem(STORAGE_MUSIC_OFF) !== '1';
    const sfxCb = document.getElementById('opt-sound-off');
    const musicCb = document.getElementById('opt-music-off');
    if (sfxCb) sfxCb.checked = !soundEffectsEnabled;
    if (musicCb) musicCb.checked = !musicEnabled;
}

/** URL звука разреза на каждый эмодзи (6 файлов на 10 типов — часть клипов переиспользуется). */
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
    '🍅': new URL('./src/assets/sounds/Sound Of Fruit Slice 3.mp3', import.meta.url).href
};

const SLICE_SFX_FALLBACK_POOL = [...new Set(Object.values(sliceSoundUrlByEmoji))].filter(Boolean);
let sliceSfxRot = 0;

function playSliceSoundForTarget(fruit) {
    if (fruit.levelMode === 'fruit' && fruit.emoji && sliceSoundUrlByEmoji[fruit.emoji]) {
        playSliceSound(fruit.emoji);
        return;
    }
    if (!SLICE_SFX_FALLBACK_POOL.length) return;
    const url = SLICE_SFX_FALLBACK_POOL[sliceSfxRot++ % SLICE_SFX_FALLBACK_POOL.length];
    playOneShotSfx(url, 0.88);
}

function playSliceSound(emoji) {
    if (!soundEffectsEnabled) return;
    playOneShotSfx(sliceSoundUrlByEmoji[emoji], 0.88);
}

/** Голос при вылете продукта: ru — stuff/*.MP3; en — «stuff en»/*.MP3 (см. стемы и fallback ниже) */
const spawnVoiceUrlByEmoji = {
    '🍌': new URL('./src/assets/sounds/stuff/banana.MP3', import.meta.url).href,
    '🍎': new URL('./src/assets/sounds/stuff/apple.MP3', import.meta.url).href,
    '🍉': new URL('./src/assets/sounds/stuff/watermelon.MP3', import.meta.url).href,
    '🍊': new URL('./src/assets/sounds/stuff/orange.MP3', import.meta.url).href,
    '🍗': new URL('./src/assets/sounds/stuff/chicken.MP3', import.meta.url).href,
    '🥩': new URL('./src/assets/sounds/stuff/meat.MP3', import.meta.url).href,
    '🥦': new URL('./src/assets/sounds/stuff/broccoli.MP3', import.meta.url).href,
    '🥬': new URL('./src/assets/sounds/stuff/cabbage.MP3', import.meta.url).href,
    '🍆': new URL('./src/assets/sounds/stuff/eggplant.MP3', import.meta.url).href,
    '🍅': new URL('./src/assets/sounds/stuff/tomat.MP3', import.meta.url).href
};

/** Совпадает с именами в stuff/*.MP3 — для «stuff en» подбирается файл по стему / fallback */
const SPAWN_VOICE_STEM_BY_EMOJI = {
    '🍌': 'banana',
    '🍎': 'apple',
    '🍉': 'watermelon',
    '🍊': 'orange',
    '🍗': 'chicken',
    '🥩': 'meat',
    '🥦': 'broccoli',
    '🥬': 'cabbage',
    '🍆': 'eggplant',
    '🍅': 'tomat'
};

/** Если в «stuff en» другое имя файла (tomato вместо tomat, steak вместо meat) */
const SPAWN_VOICE_EN_STEM_FALLBACK = {
    tomat: 'tomato',
    meat: 'steak'
};

const enSpawnVoiceUrlByStem = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/stuff en/*.MP3', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => {
        const file = path.replace(/^.*\//, '').replace(/\.MP3$/i, '');
        return [file.toLowerCase(), href];
    })
);

function spawnVoiceUrlResolve(emoji) {
    const ruUrl = spawnVoiceUrlByEmoji[emoji];
    if (uiLang !== 'en') return ruUrl;
    const stem = SPAWN_VOICE_STEM_BY_EMOJI[emoji];
    if (!stem) return ruUrl;
    const low = stem.toLowerCase();
    let url = enSpawnVoiceUrlByStem[low];
    if (!url) {
        const alt = SPAWN_VOICE_EN_STEM_FALLBACK[low];
        if (alt) url = enSpawnVoiceUrlByStem[alt.toLowerCase()];
    }
    return url || ruUrl;
}

/** Имя файла = строчная кириллица (а.MP3 … я.MP3); ключ — lowercase для lookup с буквы алфавита UI */
const ruLetterSpawnUrlByLower = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/letters/ru/*.MP3', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => {
        const file = path.replace(/^.*\//, '').replace(/\.MP3$/i, '');
        return [file.toLowerCase(), href];
    })
);

/** Латиница a.MP3 … z.MP3 для английского UI */
const enLetterSpawnUrlByLower = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/letters/en/*.MP3', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => {
        const file = path.replace(/^.*\//, '').replace(/\.MP3$/i, '');
        return [file.toLowerCase(), href];
    })
);

/** Имя файла = число 1 … 10 (.MP3); ключ строкой для совпадения с label */
const ruNumberSpawnUrlByKey = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/numbers/ru/*.MP3', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => {
        const file = path.replace(/^.*\//, '').replace(/\.MP3$/i, '');
        return [file, href];
    })
);

const enNumberSpawnUrlByKey = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/numbers/en/*.MP3', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => {
        const file = path.replace(/^.*\//, '').replace(/\.MP3$/i, '');
        return [file, href];
    })
);

/** Числовые уровни: по кругу только 1 … NUMBER_SPAWN_CYCLE_MAX (озвучка — sounds/numbers/ru|en) */
const NUMBER_SPAWN_CYCLE_MAX = 10;

/**
 * Похвала за серию (комбо) — случайная фраза текущего языка.
 * Папки sounds/praise/ru|en; файлы можно называть как угодно — проигрывается случайный.
 */
const ruPraiseUrls = Object.values(
    import.meta.glob('./src/assets/sounds/praise/ru/*.MP3', { eager: true, query: '?url', import: 'default' })
);
const enPraiseUrls = Object.values(
    import.meta.glob('./src/assets/sounds/praise/en/*.MP3', { eager: true, query: '?url', import: 'default' })
);

/** Фанфары/«ты победил» на экране победы — sounds/win/ru|en (любые имена, случайный) */
const ruWinUrls = Object.values(
    import.meta.glob('./src/assets/sounds/win/ru/*.MP3', { eager: true, query: '?url', import: 'default' })
);
const enWinUrls = Object.values(
    import.meta.glob('./src/assets/sounds/win/en/*.MP3', { eager: true, query: '?url', import: 'default' })
);

/** Озвучка слова целиком (режим слов) — имя файла = слово: кот.MP3 / cat.MP3 (sounds/words/ru|en) */
const ruWordUrlByText = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/words/ru/*.MP3', { eager: true, query: '?url', import: 'default' })
    ).map(([path, href]) => [path.replace(/^.*\//, '').replace(/\.MP3$/i, '').toLowerCase(), href])
);
const enWordUrlByText = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/sounds/words/en/*.MP3', { eager: true, query: '?url', import: 'default' })
    ).map(([path, href]) => [path.replace(/^.*\//, '').replace(/\.MP3$/i, '').toLowerCase(), href])
);

/** Картинка слова (режим слов) — имя файла = слово: кот.png / cat.png (images/words/ru|en, png|jpg|jpeg|webp) */
const ruWordImageByText = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/images/words/ru/*.{png,jpg,jpeg,webp,PNG,JPG,JPEG,WEBP}', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => [path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase(), href])
);
const enWordImageByText = Object.fromEntries(
    Object.entries(
        import.meta.glob('./src/assets/images/words/en/*.{png,jpg,jpeg,webp,PNG,JPG,JPEG,WEBP}', {
            eager: true,
            query: '?url',
            import: 'default'
        })
    ).map(([path, href]) => [path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase(), href])
);

function wordImageUrl(word) {
    if (!word) return null;
    const map = uiLang === 'en' ? enWordImageByText : ruWordImageByText;
    return map[String(word).toLowerCase()] || null;
}

/** Прогрев картинок слов текущего языка — чтобы первый показ был без задержки */
function preloadWordImages() {
    const map = uiLang === 'en' ? enWordImageByText : ruWordImageByText;
    for (const u of Object.values(map)) {
        const im = new Image();
        im.src = u;
    }
}

function pickRandomUrl(arr) {
    return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

/** Голосовая похвала на серию — рандом из набора текущего языка */
function playPraiseSound() {
    if (!soundEffectsEnabled) return;
    const u = pickRandomUrl(uiLang === 'en' ? enPraiseUrls : ruPraiseUrls);
    if (u) playOneShotSfx(u, 1.0);
}

/** Фанфары на экране победы */
function playWinSound() {
    if (!soundEffectsEnabled) return;
    const u = pickRandomUrl(uiLang === 'en' ? enWinUrls : ruWinUrls);
    if (u) playOneShotSfx(u, 1.0);
}

/** Озвучка собранного слова целиком */
function playWordSound(word) {
    if (!soundEffectsEnabled || !word) return;
    const map = uiLang === 'en' ? enWordUrlByText : ruWordUrlByText;
    const u = map[String(word).toLowerCase()];
    if (u) playOneShotSfx(u, 1.0);
}

function playSpawnVoice(emoji) {
    if (!soundEffectsEnabled) return;
    const url = spawnVoiceUrlResolve(emoji);
    if (!url) return;
    playOneShotSfx(url, 0.95);
}

/** Озвучка буквы при появлении — ru/en по языку UI (папки sounds/letters/ru|en) */
function playLetterSpawnSound(char) {
    if (!soundEffectsEnabled || !char) return;
    const key = char.toLowerCase();
    const url =
        uiLang === 'ru' ? ruLetterSpawnUrlByLower[key] : uiLang === 'en' ? enLetterSpawnUrlByLower[key] : null;
    if (!url) return;
    playOneShotSfx(url, 0.95);
}

/** Озвучка цифры при появлении — ru/en (файлы 1.MP3 … 10.MP3) */
function playNumberSpawnSound(n) {
    if (!soundEffectsEnabled || !Number.isFinite(n)) return;
    const key = String(Math.floor(n));
    const url =
        uiLang === 'ru' ? ruNumberSpawnUrlByKey[key] : uiLang === 'en' ? enNumberSpawnUrlByKey[key] : null;
    if (!url) return;
    playOneShotSfx(url, 0.95);
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

/**
 * Декодирует набор URL в буферы параллельно с ограничением «в полёте».
 * Параллель (вместо строго серийного 16 мс) на iPad готовит озвучку в разы быстрее,
 * а лимит concurrency не даёт decodeAudioData «забить» главный поток.
 * ensureSfxAudioBuffer дедуплицирует — повторные вызовы по тем же URL дешёвые.
 */
function warmSfxBuffers(urls, concurrency = 6) {
    const ctx = getOrCreateSfxContext();
    if (!ctx) return Promise.resolve();
    const queue = [...new Set(urls)].filter((u) => u && !sfxAudioBufferByUrl.has(u));
    if (!queue.length) return Promise.resolve();
    let idx = 0;
    const worker = async () => {
        while (idx < queue.length) {
            const u = queue[idx++];
            try {
                await ensureSfxAudioBuffer(ctx, u);
            } catch (_) {}
        }
    };
    const n = Math.max(1, Math.min(concurrency, queue.length));
    return Promise.all(Array.from({ length: n }, () => worker()));
}

/** Звуки, нужные конкретному уровню в текущем языке (срезы + озвучка режима) — для приоритетного прогрева */
function currentLevelSfxUrls(cfg) {
    const urls = [...SLICE_SFX_FALLBACK_POOL];
    /** Похвала и фанфары нужны в любом режиме */
    urls.push(...(uiLang === 'en' ? enPraiseUrls : ruPraiseUrls));
    urls.push(...(uiLang === 'en' ? enWinUrls : ruWinUrls));
    if (cfg?.mode === 'fruit') {
        for (const e of Object.keys(spawnVoiceUrlByEmoji)) {
            urls.push(spawnVoiceUrlResolve(e));
        }
    } else if (cfg?.mode === 'letter') {
        const map = uiLang === 'en' ? enLetterSpawnUrlByLower : ruLetterSpawnUrlByLower;
        urls.push(...Object.values(map));
    } else if (cfg?.mode === 'number') {
        const map = uiLang === 'en' ? enNumberSpawnUrlByKey : ruNumberSpawnUrlByKey;
        urls.push(...Object.values(map));
    } else if (cfg?.mode === 'word') {
        const letters = uiLang === 'en' ? enLetterSpawnUrlByLower : ruLetterSpawnUrlByLower;
        urls.push(...Object.values(letters));
        urls.push(...Object.values(uiLang === 'en' ? enWordUrlByText : ruWordUrlByText));
    }
    return urls.filter(Boolean);
}

/** Все sfx, но с текущим языком первым — фоновой прогрев на загрузке */
function allSfxUrlsCurrentLangFirst() {
    const curLang =
        uiLang === 'en'
            ? [
                  ...Object.values(enLetterSpawnUrlByLower),
                  ...Object.values(enNumberSpawnUrlByKey),
                  ...Object.values(enSpawnVoiceUrlByStem)
              ]
            : [
                  ...Object.values(ruLetterSpawnUrlByLower),
                  ...Object.values(ruNumberSpawnUrlByKey),
                  ...Object.values(spawnVoiceUrlByEmoji)
              ];
    const praiseWin = [...ruPraiseUrls, ...enPraiseUrls, ...ruWinUrls, ...enWinUrls];
    const rest = [
        ...Object.values(spawnVoiceUrlByEmoji),
        ...Object.values(enSpawnVoiceUrlByStem),
        ...Object.values(ruLetterSpawnUrlByLower),
        ...Object.values(enLetterSpawnUrlByLower),
        ...Object.values(ruNumberSpawnUrlByKey),
        ...Object.values(enNumberSpawnUrlByKey),
        ...Object.values(ruWordUrlByText),
        ...Object.values(enWordUrlByText)
    ];
    return [...new Set([...SLICE_SFX_FALLBACK_POOL, ...praiseWin, ...curLang, ...rest])].filter(Boolean);
}

function warmSfxAudioBuffersYielding() {
    /** Срезы и звуки текущего языка — первыми; общий список идёт скромной параллелью, чтобы не дёргать загрузку */
    void warmSfxBuffers(allSfxUrlsCurrentLangFirst(), 4);
}

/** Ранняя загрузка/декод mp3 — иначе первый рез/озвучка на проде ждёт сеть/декодер */
function preloadGameAudio() {
    if (soundEffectsEnabled) {
        /** Декодируем сразу в буферы (fetch внутри ensureSfxAudioBuffer прогреет и HTTP-кэш).
         *  Сотни new Audio() на iOS не плодим — там лимит на медиа-элементы. */
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
const comboDisplay = document.getElementById('combo-display');
const wordProgressEl = document.getElementById('word-progress');
const wordRevealEl = document.getElementById('word-reveal');
const wordRevealImg = document.getElementById('word-reveal-img');
const wordRevealEmoji = document.getElementById('word-reveal-emoji');
const wordRevealText = document.getElementById('word-reveal-text');
const winOverlay = document.getElementById('win-overlay');
const winStarsEl = document.getElementById('win-stars');
const winTitleEl = document.getElementById('win-title');
const winScoreEl = document.getElementById('win-score');
const btnWinNext = document.getElementById('btn-win-next');
const btnWinMenu = document.getElementById('btn-win-menu');

let poseLandmarker;
let visionTasksResolver = null;
let mediapipePoseDelegate = 'CPU';
let currentPoseResults = null;
let lastVideoTime = -1;
/** Монотонный timestamp для detectForVideo (Android иногда откатывает video.currentTime) */
let lastDetectTsMs = -1;
/** Интерполяция display-landmarks между кадрами камеры (~30 fps → 120 Hz rAF) */
const posePrevTargetByKey = new Map();
const poseTargetByKey = new Map();
const poseDisplayByKey = new Map();
const displayPersonOrder = [];
let poseFrameTsPrev = -1;
let poseFrameTsCurr = -1;
let poseFrameIntervalMs = 33.33;
/** performance.now() в момент последнего commitPoseTargetsFromFrame — для lerp между кадрами камеры */
let poseFrameCommitPerfMs = 0;
let score = 0;
let fruits = [];
let particles = [];
let isPlaying = false;

/** Серия (комбо): растёт за каждый успешный рез, обнуляется на промах */
let comboStreak = 0;
let comboBest = 0;
/** Прогресс уровня и точность для звёзд */
let levelGoodHits = 0;
let levelBadEvents = 0;
let levelComplete = false;
/** Всплывающие надписи («Серия x3», «Молодец!») и кратковременная вспышка экрана */
let floatingTexts = [];
let screenFlash = 0;
/** Салют на экране победы */
let winBurstTimer = 0;

/** Очко за каждый множитель серии (растёт по мере серии) */
function comboMultiplier() {
    return Math.min(5, 1 + Math.floor(comboStreak / 5));
}

/** Детские слова по языку UI (3–4 буквы). Имя звукового файла = слово в нижнем регистре. */
const WORD_LIST_RU = [
    'КОТ', 'ДОМ', 'МАМА', 'СОК', 'МЯЧ', 'СЫР',
    'ПАПА', 'ЛИСА', 'РЫБА', 'СОВА', 'ГРИБ', 'ШАР',
    'ЛЕВ', 'ТИГР', 'ВОЛК', 'ЗАЯЦ', 'УТКА', 'СЛОН',
    'КИТ', 'ЗМЕЯ', 'ПЧЕЛА', 'КОЗА', 'ОВЦА', 'КРАБ',
    'АКУЛА', 'ЛУНА', 'ВОДА', 'СНЕГ', 'РОЗА', 'ЛИМОН',
    'БАНАН', 'АРБУЗ', 'ТОРТ', 'ХЛЕБ', 'ПИЦЦА', 'МАШИНА',
    'ПОЕЗД', 'ЛОДКА', 'РАКЕТА', 'КЛЮЧ', 'КНИГА', 'ЦВЕТОК',
    'ПАУК', 'МЫШЬ', 'СОБАКА', 'ПТИЦА', 'КОРОВА', 'МЕДВЕДЬ',
    'ЛОШАДЬ', 'КУРИЦА', 'НОС', 'РОТ', 'ГЛАЗ', 'УХО',
    'РУКА', 'НОГА', 'СОЛНЦЕ', 'ДОЖДЬ', 'ОБЛАКО', 'ЗВЕЗДА',
    'ОГОНЬ', 'РАДУГА', 'СТУЛ', 'ОКНО', 'САМОЛЁТ', 'ЗОНТ',
    'МОЛОКО', 'ЯЙЦО', 'МЁД', 'МОРЕ', 'РЕКА', 'ЗАМОК',
    'МОСТ', 'ДЕРЕВО', 'ЯБЛОКО', 'ГРУША', 'МОРКОВЬ', 'СУП',
    'САХАР', 'ЧАШКА', 'ТАРЕЛКА', 'ЛОЖКА', 'ВИЛКА', 'НОЖ'
];
const WORD_LIST_EN = [
    'CAT', 'DOG', 'SUN', 'MOM', 'CUP', 'BED',
    'PIG', 'COW', 'BUS', 'HAT', 'FOX', 'FISH',
    'LION', 'TIGER', 'WOLF', 'BEAR', 'DUCK', 'FROG',
    'BEE', 'ANT', 'OWL', 'HEN', 'GOAT', 'LAMB',
    'CRAB', 'WHALE', 'SNAKE', 'STAR', 'MOON', 'RAIN',
    'SNOW', 'TREE', 'ROSE', 'APPLE', 'BANANA', 'LEMON',
    'CAKE', 'PIZZA', 'CAR', 'BOAT', 'KEY', 'BOOK',
    'MOUSE', 'HORSE', 'CHICK', 'SPIDER', 'EAGLE', 'DEER',
    'CLOUD', 'FIRE', 'HEART', 'HAND', 'FOOT', 'NOSE',
    'EAR', 'EYE', 'PLANE', 'TRAIN', 'BIKE', 'TRUCK',
    'SHIP', 'MILK', 'EGG', 'HONEY', 'SOUP', 'CORN',
    'BEAN', 'CHAIR', 'DOOR', 'LAMP', 'BELL', 'BALL',
    'DOLL', 'SEA', 'HILL', 'SAND', 'ROCK', 'LEAF',
    'WIND', 'JUICE', 'ICE', 'TOYS', 'SOCK', 'SHOE'
];

/** Эмодзи для показа собранного слова (как у фруктов). Ключ — слово в верхнем регистре. */
const WORD_EMOJI = {
    // RU
    'КОТ': '🐱', 'ДОМ': '🏠', 'МАМА': '👩', 'СОК': '🧃', 'МЯЧ': '⚽', 'СЫР': '🧀',
    'ПАПА': '👨', 'ЛИСА': '🦊', 'РЫБА': '🐟', 'СОВА': '🦉', 'ГРИБ': '🍄', 'ШАР': '🎈',
    'ЛЕВ': '🦁', 'ТИГР': '🐯', 'ВОЛК': '🐺', 'ЗАЯЦ': '🐰', 'УТКА': '🦆', 'СЛОН': '🐘',
    'КИТ': '🐳', 'ЗМЕЯ': '🐍', 'ПЧЕЛА': '🐝', 'КОЗА': '🐐', 'ОВЦА': '🐑', 'КРАБ': '🦀',
    'АКУЛА': '🦈', 'ЛУНА': '🌙', 'ВОДА': '💧', 'СНЕГ': '❄️', 'РОЗА': '🌹', 'ЛИМОН': '🍋',
    'БАНАН': '🍌', 'АРБУЗ': '🍉', 'ТОРТ': '🎂', 'ХЛЕБ': '🍞', 'ПИЦЦА': '🍕', 'МАШИНА': '🚗',
    'ПОЕЗД': '🚆', 'ЛОДКА': '⛵', 'РАКЕТА': '🚀', 'КЛЮЧ': '🔑', 'КНИГА': '📚', 'ЦВЕТОК': '🌸',
    'ПАУК': '🕷️', 'МЫШЬ': '🐭', 'СОБАКА': '🐶', 'ПТИЦА': '🐦', 'КОРОВА': '🐄', 'МЕДВЕДЬ': '🐻',
    'ЛОШАДЬ': '🐴', 'КУРИЦА': '🐔', 'НОС': '👃', 'РОТ': '👄', 'ГЛАЗ': '👁️', 'УХО': '👂',
    'РУКА': '✋', 'НОГА': '🦵', 'СОЛНЦЕ': '☀️', 'ДОЖДЬ': '🌧️', 'ОБЛАКО': '☁️', 'ЗВЕЗДА': '⭐',
    'ОГОНЬ': '🔥', 'РАДУГА': '🌈', 'СТУЛ': '🪑', 'ОКНО': '🪟', 'САМОЛЁТ': '✈️', 'ЗОНТ': '☂️',
    'МОЛОКО': '🥛', 'ЯЙЦО': '🥚', 'МЁД': '🍯', 'МОРЕ': '🌊', 'РЕКА': '🏞️', 'ЗАМОК': '🏰',
    'МОСТ': '🌉', 'ДЕРЕВО': '🌳', 'ЯБЛОКО': '🍎', 'ГРУША': '🍐', 'МОРКОВЬ': '🥕', 'СУП': '🍲',
    'САХАР': '🍬', 'ЧАШКА': '☕', 'ТАРЕЛКА': '🍽️', 'ЛОЖКА': '🥄', 'ВИЛКА': '🍴', 'НОЖ': '🔪',
    // EN
    'CAT': '🐱', 'DOG': '🐶', 'SUN': '☀️', 'MOM': '👩', 'CUP': '☕', 'BED': '🛏️',
    'PIG': '🐷', 'COW': '🐮', 'BUS': '🚌', 'HAT': '🎩', 'FOX': '🦊', 'FISH': '🐟',
    'LION': '🦁', 'TIGER': '🐯', 'WOLF': '🐺', 'BEAR': '🐻', 'DUCK': '🦆', 'FROG': '🐸',
    'BEE': '🐝', 'ANT': '🐜', 'OWL': '🦉', 'HEN': '🐔', 'GOAT': '🐐', 'LAMB': '🐑',
    'CRAB': '🦀', 'WHALE': '🐳', 'SNAKE': '🐍', 'STAR': '⭐', 'MOON': '🌙', 'RAIN': '🌧️',
    'SNOW': '❄️', 'TREE': '🌳', 'ROSE': '🌹', 'APPLE': '🍎', 'BANANA': '🍌', 'LEMON': '🍋',
    'CAKE': '🎂', 'PIZZA': '🍕', 'CAR': '🚗', 'BOAT': '⛵', 'KEY': '🔑', 'BOOK': '📚',
    'MOUSE': '🐭', 'HORSE': '🐴', 'CHICK': '🐤', 'SPIDER': '🕷️', 'EAGLE': '🦅', 'DEER': '🦌',
    'CLOUD': '☁️', 'FIRE': '🔥', 'HEART': '❤️', 'HAND': '✋', 'FOOT': '🦶', 'NOSE': '👃',
    'EAR': '👂', 'EYE': '👁️', 'PLANE': '✈️', 'TRAIN': '🚂', 'BIKE': '🚲', 'TRUCK': '🚚',
    'SHIP': '🚢', 'MILK': '🥛', 'EGG': '🥚', 'HONEY': '🍯', 'SOUP': '🍲', 'CORN': '🌽',
    'BEAN': '🫘', 'CHAIR': '🪑', 'DOOR': '🚪', 'LAMP': '💡', 'BELL': '🔔', 'BALL': '⚽',
    'DOLL': '🪆', 'SEA': '🌊', 'HILL': '⛰️', 'SAND': '🏖️', 'ROCK': '🪨', 'LEAF': '🍃',
    'WIND': '💨', 'JUICE': '🧃', 'ICE': '🧊', 'TOYS': '🧸', 'SOCK': '🧦', 'SHOE': '👟'
};

function wordEmoji(word) {
    return word ? WORD_EMOJI[String(word).toUpperCase()] || null : null;
}

function wordListForUiLang() {
    return uiLang === 'en' ? WORD_LIST_EN : WORD_LIST_RU;
}

/** Состояние режима слов */
let wordQueue = [];
let wordQueueIndex = 0;
let currentWord = '';
let wordProgress = 0;
let wordsCompleted = 0;
/** Пауза с показом картинки собранного слова */
let wordRevealActive = false;
let wordRevealTimer = 0;
const WORD_REVEAL_MS = 2000;

function resetWordState() {
    wordQueue = [...wordListForUiLang()];
    shuffleArrayInPlace(wordQueue);
    wordQueueIndex = 0;
    wordProgress = 0;
    wordsCompleted = 0;
    currentWord = wordQueue[0] || '';
}

function advanceToNextWord() {
    wordQueueIndex = (wordQueueIndex + 1) % Math.max(1, wordQueue.length);
    currentWord = wordQueue[wordQueueIndex] || '';
    wordProgress = 0;
}

/** В режиме слов выпадает только следующая нужная буква — без отвлекающих, чтобы не путать детей */
function pickWordSpawnChar() {
    const need = currentWord[wordProgress];
    if (need) return need;
    const alphabet = letterAlphabetForUiLang();
    return alphabet[Math.floor(Math.random() * alphabet.length)];
}

/** Всплывающая надпись, поднимается и затухает; компенсирует CSS-зеркало canvas (как буквы) */
class FloatingText {
    constructor(x, y, text, color) {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color || '#00f3ff';
        this.life = 1;
        this.vy = -1.4;
        this.scale = 0.6;
    }
    update(dt = 1) {
        this.y += this.vy * dt;
        this.vy *= 0.96;
        this.scale += (1 - this.scale) * 0.18 * dt;
        this.life -= 0.018 * dt;
    }
    draw(ctx) {
        const a = Math.max(0, this.life);
        if (a <= 0) return;
        const { minSide } = gameLayout;
        const fontPx = Math.max(26, minSide * 0.06) * this.scale;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.scale(-1, 1); // компенсация CSS scaleX(-1)
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `900 ${fontPx}px "Outfit", "Segoe UI", system-ui, sans-serif`;
        ctx.globalAlpha = a;
        ctx.lineWidth = Math.max(4, fontPx * 0.14);
        ctx.strokeStyle = 'rgba(8,10,20,0.8)';
        ctx.strokeText(this.text, 0, 0);
        ctx.shadowColor = this.color;
        ctx.shadowBlur = fontPx * 0.5;
        ctx.fillStyle = this.color;
        ctx.fillText(this.text, 0, 0);
        ctx.restore();
    }
}

function spawnComboText(x, y, color) {
    const mult = comboMultiplier();
    let label;
    if (comboStreak > 0 && comboStreak % 5 === 0) {
        label = `${t('praiseCombo')} x${mult}!`;
    } else if (mult > 1) {
        label = `x${mult}`;
    } else {
        return;
    }
    floatingTexts.push(new FloatingText(x, y, label, color));
}

function juiceBurst(x, y, color, dots, sparks) {
    particles.push(new SliceBurst(x, y, color));
    for (let p = 0; p < dots; p++) particles.push(new Particle(x, y, color, 'dot'));
    for (let p = 0; p < sparks; p++) particles.push(new Particle(x, y, color, 'spark'));
}

function updateComboHud() {
    if (!comboDisplay) return;
    if (comboStreak >= 2) {
        comboDisplay.textContent = `${t('comboLabel')} x${comboMultiplier()} · ${comboStreak}`;
        comboDisplay.classList.remove('is-hidden');
        comboDisplay.classList.remove('combo-pop');
        void comboDisplay.offsetWidth; // перезапуск CSS-анимации
        comboDisplay.classList.add('combo-pop');
    } else {
        comboDisplay.classList.add('is-hidden');
    }
}

function registerGoodHit(fruit, points) {
    comboStreak += 1;
    if (comboStreak > comboBest) comboBest = comboStreak;
    levelGoodHits += 1;
    score += points * comboMultiplier();
    scoreDisplay.innerText = formatScore(score);
    updateComboHud();
    spawnComboText(fruit.x, fruit.y - fruit.radius * 0.6, fruit.color);
    if (comboStreak > 0 && comboStreak % 5 === 0) {
        playPraiseSound();
        screenFlash = Math.max(screenFlash, 0.22);
    } else {
        screenFlash = Math.max(screenFlash, 0.1);
    }
}

function breakCombo() {
    if (comboStreak > 0) {
        comboStreak = 0;
        updateComboHud();
    }
}

function updateWordHud() {
    if (!wordProgressEl) return;
    if (getCurrentLevelConfig().mode !== 'word') {
        wordProgressEl.classList.add('is-hidden');
        return;
    }
    wordProgressEl.classList.remove('is-hidden');
    wordProgressEl.innerHTML = '';
    const prompt = document.createElement('span');
    prompt.className = 'word-prompt';
    prompt.textContent = `${t('wordPrompt')}:`;
    wordProgressEl.appendChild(prompt);
    for (let i = 0; i < currentWord.length; i++) {
        const slot = document.createElement('span');
        slot.className = 'word-slot' + (i < wordProgress ? ' is-filled' : '');
        slot.textContent = currentWord[i];
        wordProgressEl.appendChild(slot);
    }
}

function showWordReveal(word) {
    if (!wordRevealEl) return;
    /** Приоритет — картинка (если положили файл), иначе подходящий эмодзи */
    const url = wordImageUrl(word);
    const emoji = url ? null : wordEmoji(word);
    if (wordRevealImg) {
        if (url) {
            wordRevealImg.src = url;
            wordRevealImg.alt = word;
            wordRevealImg.classList.remove('is-hidden');
        } else {
            wordRevealImg.removeAttribute('src');
            wordRevealImg.classList.add('is-hidden');
        }
    }
    if (wordRevealEmoji) {
        if (emoji) {
            wordRevealEmoji.textContent = emoji;
            wordRevealEmoji.classList.remove('is-hidden');
        } else {
            wordRevealEmoji.textContent = '';
            wordRevealEmoji.classList.add('is-hidden');
        }
    }
    if (wordRevealText) wordRevealText.textContent = word;
    wordRevealEl.classList.remove('is-hidden');
}

function hideWordReveal() {
    wordRevealEl?.classList.add('is-hidden');
}

function clearWordReveal() {
    if (wordRevealTimer) {
        clearTimeout(wordRevealTimer);
        wordRevealTimer = 0;
    }
    wordRevealActive = false;
    hideWordReveal();
}

function onWordCompleted(fruit) {
    wordsCompleted += 1;
    playWordSound(currentWord);
    floatingTexts.push(new FloatingText(fruit.x, fruit.y - fruit.radius, currentWord, '#76ff03'));
    score += 50 * comboMultiplier();
    scoreDisplay.innerText = formatScore(score);
    screenFlash = Math.max(screenFlash, 0.28);

    /** Пауза: показываем картинку собранного слова, спавн/рез на это время выключены */
    const cfg = getCurrentLevelConfig();
    const isLast = wordsCompleted >= (cfg.wordGoal || 3);
    const finishedWord = currentWord;
    wordRevealActive = true;
    showWordReveal(finishedWord);
    if (wordRevealTimer) clearTimeout(wordRevealTimer);
    wordRevealTimer = setTimeout(() => {
        wordRevealTimer = 0;
        wordRevealActive = false;
        hideWordReveal();
        if (isLast) {
            completeLevel();
            return;
        }
        /** Чистим оставшиеся буквы предыдущего слова — следующее начинаем «с нуля» */
        fruits.length = 0;
        advanceToNextWord();
        updateWordHud();
        lastSpawnTime = Date.now();
    }, WORD_REVEAL_MS);
}

function checkLevelGoal() {
    const cfg = getCurrentLevelConfig();
    if (cfg.mode === 'word') return;
    if (!levelComplete && cfg.goal && levelGoodHits >= cfg.goal) {
        completeLevel();
    }
}

/** Рез засчитан: комбо, очки, режим слов, «сок» */
function handleSliceScoring(fruit) {
    playSliceSoundForTarget(fruit);
    if (fruit.levelMode === 'word') {
        const need = currentWord[wordProgress];
        if (need && fruit.glyphChar === need) {
            wordProgress += 1;
            registerGoodHit(fruit, 10);
            juiceBurst(fruit.x, fruit.y, fruit.color, 26 + comboMultiplier() * 6, 16);
            updateWordHud();
            if (wordProgress >= currentWord.length) onWordCompleted(fruit);
        } else {
            /** Неверная буква — мягко: без штрафа и без сброса серии (детский режим) */
            juiceBurst(fruit.x, fruit.y, 'rgba(185,195,215,1)', 8, 4);
        }
        return;
    }
    registerGoodHit(fruit, 10);
    const extra = Math.min(18, comboMultiplier() * 4);
    juiceBurst(fruit.x, fruit.y, fruit.color, 26 + extra, 16);
    checkLevelGoal();
}

/** Предмет улетел вниз несрезанным */
function handleMiss() {
    if (getCurrentLevelConfig().mode === 'word') return; // букв много — не штрафуем
    levelBadEvents += 1;
    breakCombo();
    score = Math.max(0, score - MISS_PENALTY);
    scoreDisplay.innerText = formatScore(score);
}

function computeStars() {
    const attempts = levelGoodHits + levelBadEvents;
    const acc = attempts > 0 ? levelGoodHits / attempts : 1;
    if (acc >= 0.9) return 3;
    if (acc >= 0.7) return 2;
    return 1;
}

function completeLevel() {
    if (levelComplete) return;
    levelComplete = true;
    comboDisplay?.classList.add('is-hidden');
    playWinSound();
    winBurstTimer = 0;
    showWinOverlay(computeStars());
}

function showWinOverlay(stars) {
    if (winStarsEl) {
        winStarsEl.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const s = document.createElement('span');
            s.className = 'win-star' + (i < stars ? ' is-on' : '');
            s.textContent = '⭐';
            winStarsEl.appendChild(s);
        }
    }
    if (winTitleEl) winTitleEl.textContent = t('winTitle');
    if (winScoreEl) winScoreEl.textContent = `${t('winScoreLabel')}: ${score} · ${t('comboMax')}: ${comboBest}`;
    const hasNext = currentLevelIndex < LEVELS.length - 1;
    if (btnWinNext) {
        btnWinNext.textContent = hasNext ? t('winNextLevel') : t('winReplay');
        btnWinNext.classList.remove('is-hidden');
    }
    if (btnWinMenu) btnWinMenu.textContent = t('winToMenu');
    winOverlay?.classList.remove('is-hidden');
}

function hideWinOverlay() {
    winOverlay?.classList.add('is-hidden');
}

/**
 * mode: fruit — эмодзи; letter — кириллица/латиница по языку UI; number — 1–10 по кругу; word — собрать слово.
 * goal — сколько объектов нужно срезать, чтобы пройти уровень; word: wordGoal — сколько слов собрать.
 */
const LEVELS = [
    { mode: 'fruit', maxConcurrent: 1, spawnIntervalMs: 2200, goal: 10 },
    { mode: 'fruit', maxConcurrent: 2, spawnIntervalMs: 1900, goal: 14 },
    { mode: 'fruit', maxConcurrent: 3, spawnIntervalMs: 1550, goal: 18 },
    { mode: 'number', maxConcurrent: 1, spawnIntervalMs: 2200, goal: 10 },
    { mode: 'number', maxConcurrent: 2, spawnIntervalMs: 1900, goal: 14 },
    { mode: 'number', maxConcurrent: 3, spawnIntervalMs: 1550, goal: 18 },
    { mode: 'word', maxConcurrent: 3, spawnIntervalMs: 1500, wordGoal: 10 },
    { mode: 'word', maxConcurrent: 4, spawnIntervalMs: 1350, wordGoal: 14 },
    { mode: 'word', maxConcurrent: 4, spawnIntervalMs: 1200, wordGoal: 18 }
];

/** Кадров подряд без пересечения с предметом, чтобы снова считать «новый вход» (трекинг мерцает на границе круга) */
const CONTACT_EXIT_DEBOUNCE_FRAMES = 7;
/** Штраф за предмет, улетевший вниз несрезанным (симметрично +10 за рез) */
const MISS_PENALTY = 10;
let currentLevelIndex = 0;

function getCurrentLevelConfig() {
    return LEVELS[currentLevelIndex];
}

const I18N = {
    ru: {
        tierProducts: 'Продукты',
        tierLetters: 'Буквы',
        tierNumbers: 'Цифры',
        tierWords: 'Слова',
        hudAtOnce: '',
        comboLabel: 'Серия',
        comboMax: 'Макс. серия',
        wordPrompt: 'Собери слово',
        winTitle: 'Уровень пройден!',
        winScoreLabel: 'Счёт',
        winNextLevel: 'Дальше',
        winReplay: 'Ещё раз',
        winToMenu: 'Меню',
        praiseGreat: 'Молодец!',
        praiseSuper: 'Супер!',
        praiseWow: 'Вот это да!',
        praiseCombo: 'Серия',
        hudGoal: 'Цель',
        scorePrefix: 'Счёт: ',
        menuHeading: 'Выберите уровень',
        menuHint: 'Чем выше уровень в категории (1→3), тем больше предметов одновременно на экране.',
        quickSettingsAria: 'Язык, звук, музыка и число игроков',
        langLabel: 'Язык',
        playersOnCamera: 'Количество игроков',
        gamesGallery: 'Галерея игр',
        gamesGalleryAria: 'Перейти в галерею игр Blago Games',
        playersOneAria: 'Один игрок',
        playersTwoAria: 'Два игрока',
        soundInGame: 'Звуки в игре',
        soundOffAria: 'Отключить звуки в игре',
        musicTitle: 'Музыка',
        musicDesc: 'Меню и игра',
        musicOffAria: 'Отключить музыку',
        fullscreenEnter: 'На весь экран',
        fullscreenExit: 'Свернуть',
        fullscreenEnterAria: 'Развернуть на весь экран',
        fullscreenExitAria: 'Выйти из полноэкранного режима',
        backToMenu: 'Меню',
        loadingModels: 'Загрузка моделей…',
        errorTitle: 'Не удалось запустить игру.',
        errorHintGeneric:
            'Откройте консоль браузера (F12 → Console) и при необходимости пришлите текст ошибки.',
        errorHintCameraBlocked:
            'Браузер заблокировал камеру для этого сайта. Нажмите на значок замка слева от адреса → разрешите камеру, обновите страницу.',
        errorHintNoCamera:
            'Камера не найдена. Проверьте, что она подключена и не занята другим приложением.',
        errorHintTimeout:
            'Камера не успела запуститься. Отключите режим эмуляции устройства в DevTools (или выберите реальное устройство с камерой), закройте другие программы, использующие камеру, и обновите страницу.'
    },
    en: {
        tierProducts: 'Products',
        tierLetters: 'Letters',
        tierNumbers: 'Numbers',
        tierWords: 'Words',
        hudAtOnce: 'at once',
        comboLabel: 'Combo',
        comboMax: 'Best combo',
        wordPrompt: 'Spell the word',
        winTitle: 'Level complete!',
        winScoreLabel: 'Score',
        winNextLevel: 'Next',
        winReplay: 'Replay',
        winToMenu: 'Menu',
        praiseGreat: 'Great!',
        praiseSuper: 'Super!',
        praiseWow: 'Wow!',
        praiseCombo: 'Combo',
        hudGoal: 'Goal',
        scorePrefix: 'Score: ',
        menuHeading: 'Choose a level',
        menuHint: 'Within each category (1→3), higher tiers mean more objects at once.',
        quickSettingsAria: 'Language, sound, music and number of players',
        langLabel: 'Language',
        playersOnCamera: 'Number of players',
        gamesGallery: 'Game gallery',
        gamesGalleryAria: 'Go to Blago Games gallery',
        playersOneAria: 'One player',
        playersTwoAria: 'Two players',
        soundInGame: 'Game sounds',
        soundOffAria: 'Mute game sounds',
        musicTitle: 'Music',
        musicDesc: 'Menu and game',
        musicOffAria: 'Mute music',
        fullscreenEnter: 'Fullscreen',
        fullscreenExit: 'Exit fullscreen',
        fullscreenEnterAria: 'Enter fullscreen',
        fullscreenExitAria: 'Exit fullscreen',
        backToMenu: 'Menu',
        loadingModels: 'Loading models…',
        errorTitle: 'Could not start the game.',
        errorHintGeneric: 'Open the browser console (F12 → Console) and send the error text if needed.',
        errorHintCameraBlocked:
            'The browser blocked camera access for this site. Use the lock icon next to the address bar → allow camera, then refresh.',
        errorHintNoCamera: 'No camera found. Check that it is connected and not used by another app.',
        errorHintTimeout:
            'The camera did not start in time. Turn off device emulation in DevTools (or pick a real camera), close other apps using the camera, and refresh.'
    }
};

function t(key) {
    const pack = I18N[uiLang];
    if (pack && Object.prototype.hasOwnProperty.call(pack, key)) return pack[key];
    return I18N.en[key] ?? key;
}

function pluralSimultaneousRu(n) {
    const n100 = n % 100;
    const n10 = n % 10;
    if (n100 >= 11 && n100 <= 14) return `${n} объектов`;
    if (n10 === 1) return `${n} объект`;
    if (n10 >= 2 && n10 <= 4) return `${n} объекта`;
    return `${n} объектов`;
}

function pluralSimultaneousEn(n) {
    return n === 1 ? `${n} object` : `${n} objects`;
}

function levelTierTitle(levelIndex) {
    const cfg = LEVELS[levelIndex];
    if (!cfg) return '';
    /** Порядковый номер внутри своей категории — не зависит от состава LEVELS */
    let sub = 0;
    for (let i = 0; i <= levelIndex; i++) {
        if (LEVELS[i].mode === cfg.mode) sub++;
    }
    const name =
        cfg.mode === 'fruit'
            ? t('tierProducts')
            : cfg.mode === 'letter'
            ? t('tierLetters')
            : cfg.mode === 'number'
            ? t('tierNumbers')
            : t('tierWords');
    return `${name} ${sub}`;
}

function formatHudLevelLine(levelIndex, maxConcurrent) {
    const title = levelTierTitle(levelIndex);
    const cfg = LEVELS[levelIndex];
    if (cfg?.mode === 'word') return title;
    if (uiLang === 'en') {
        return `${title} · ${pluralSimultaneousEn(maxConcurrent)} ${t('hudAtOnce')}`.trim();
    }
    return `${title} · одновременно ${pluralSimultaneousRu(maxConcurrent)}`;
}

function formatScore(n) {
    return `${t('scorePrefix')}${n}`;
}

function buildLevelGrid() {
    if (!levelGrid) return;
    levelGrid.innerHTML = '';
    LEVELS.forEach((cfg, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'level-btn';
        btn.innerHTML = `<span class="level-title">${levelTierTitle(i)}</span>`;
        btn.addEventListener('click', () => startLevel(i));
        levelGrid.appendChild(btn);
    });
}

function setUiLang(lang) {
    if (lang !== 'ru' && lang !== 'en') return;
    uiLang = lang;
    localStorage.setItem(STORAGE_UI_LANG, lang);
    document.documentElement.lang = lang;
    applyUiTranslations();
}

function applyUiTranslations() {
    const mh = document.getElementById('menu-heading');
    if (mh) mh.textContent = t('menuHeading');
    const hint = document.getElementById('menu-hint');
    if (hint) hint.textContent = t('menuHint');
    const mq = document.getElementById('menu-quick-settings');
    if (mq) mq.setAttribute('aria-label', t('quickSettingsAria'));
    const ml = document.getElementById('menu-lang-label');
    if (ml) ml.textContent = t('langLabel');
    const mpl = document.getElementById('menu-player-label');
    if (mpl) mpl.textContent = t('playersOnCamera');
    const wpl = document.getElementById('wrap-opt-players-1');
    const wpr = document.getElementById('wrap-opt-players-2');
    if (wpl) wpl.setAttribute('aria-label', t('playersOneAria'));
    if (wpr) wpr.setAttribute('aria-label', t('playersTwoAria'));
    const mgl = document.getElementById('menu-games-gallery-label');
    const mga = document.getElementById('menu-games-gallery');
    if (mgl) mgl.textContent = t('gamesGallery');
    if (mga) mga.setAttribute('aria-label', t('gamesGalleryAria'));
    const st = document.getElementById('menu-opt-sound-title');
    if (st) st.textContent = t('soundInGame');
    const mt = document.getElementById('menu-opt-music-title');
    if (mt) mt.textContent = t('musicTitle');
    const md = document.getElementById('menu-opt-music-desc');
    if (md) md.textContent = t('musicDesc');
    const sfx = document.getElementById('opt-sound-off');
    if (sfx) sfx.setAttribute('aria-label', t('soundOffAria'));
    const mus = document.getElementById('opt-music-off');
    if (mus) mus.setAttribute('aria-label', t('musicOffAria'));
    const lt = document.getElementById('loading-text');
    if (lt) lt.textContent = t('loadingModels');
    if (btnBackMenu) btnBackMenu.textContent = t('backToMenu');
    const olru = document.getElementById('opt-lang-ru');
    const olen = document.getElementById('opt-lang-en');
    if (olru) olru.checked = uiLang === 'ru';
    if (olen) olen.checked = uiLang === 'en';
    syncFullscreenButton();
    buildLevelGrid();
    if (scoreDisplay) scoreDisplay.innerText = formatScore(isPlaying ? score : 0);
    if (isPlaying) {
        const cfg = getCurrentLevelConfig();
        if (levelDisplay) levelDisplay.textContent = formatHudLevelLine(currentLevelIndex, cfg.maxConcurrent);
        if (scoreDisplay) scoreDisplay.innerText = formatScore(score);
    }
}

function showMainMenu() {
    isPlaying = false;
    levelComplete = false;
    stopGameMusic();
    clearWordReveal();
    hideWinOverlay();
    comboDisplay?.classList.add('is-hidden');
    wordProgressEl?.classList.add('is-hidden');
    mainMenu.classList.remove('is-hidden');
    hudGame.classList.add('is-hidden');
    fruits.length = 0;
    particles.length = 0;
    floatingTexts = [];
    screenFlash = 0;
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
    /** Приоритетно декодируем озвучку именно этого уровня и языка — чтобы звук был с первого спавна */
    if (soundEffectsEnabled) void warmSfxBuffers(currentLevelSfxUrls(cfg), 8);
    score = 0;
    scoreDisplay.innerText = formatScore(score);
    levelDisplay.textContent = formatHudLevelLine(currentLevelIndex, cfg.maxConcurrent);
    fruits.length = 0;
    particles.length = 0;
    floatingTexts = [];
    screenFlash = 0;
    comboStreak = 0;
    comboBest = 0;
    levelGoodHits = 0;
    levelBadEvents = 0;
    levelComplete = false;
    winBurstTimer = 0;
    clearWordReveal();
    hideWinOverlay();
    comboDisplay?.classList.add('is-hidden');
    if (cfg.mode === 'number') sequentialSpawnNumber = 1;
    if (cfg.mode === 'letter') sequentialLetterIndex = 0;
    if (cfg.mode === 'word') {
        resetWordState();
        updateWordHud();
        preloadWordImages();
    } else {
        wordProgressEl?.classList.add('is-hidden');
    }
    lastSpawnTime = Date.now();
    lastFrameTime = performance.now();
    resetPoseDisplayState();
    mainMenu.classList.add('is-hidden');
    hudGame.classList.remove('is-hidden');
    canvasElement.style.visibility = "";
    isPlaying = true;
    void video.play().catch(() => {});
    /** Музыка и первый кадр — в microtask после unlock play(), иначе iOS Chrome иногда глушит первый HTMLAudio */
    queueMicrotask(() => {
        startGameMusicPlaylist();
        ensureGameLoop();
    });
}

btnBackMenu.addEventListener('click', () => showMainMenu());

btnWinNext?.addEventListener('click', () => {
    tryUnlockAudioOnUserGesture();
    hideWinOverlay();
    const hasNext = currentLevelIndex < LEVELS.length - 1;
    startLevel(hasNext ? currentLevelIndex + 1 : currentLevelIndex);
});

btnWinMenu?.addEventListener('click', () => {
    hideWinOverlay();
    showMainMenu();
});

/**
 * Fullscreen API: на ПК и iPad/Android Chrome работает; на iPhone Safari — нет (там путь через PWA).
 * Кнопка показывается только в меню; во время игры она лишний раз отвлекает.
 */
const gameContainer = document.getElementById('game-container');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnFullscreenLabel = btnFullscreen?.querySelector('.btn-fullscreen-label');

function isFullscreenSupported() {
    const el = gameContainer || document.documentElement;
    return !!(
        document.fullscreenEnabled ||
        document.webkitFullscreenEnabled ||
        el.requestFullscreen ||
        el.webkitRequestFullscreen
    );
}

function getCurrentFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function enterFullscreen() {
    const el = gameContainer || document.documentElement;
    try {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch (_) {}
}

async function exitFullscreen() {
    try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (_) {}
}

function syncFullscreenButton() {
    if (!btnFullscreen) return;
    const isFs = !!getCurrentFullscreenElement();
    btnFullscreen.classList.toggle('is-active', isFs);
    if (btnFullscreenLabel) {
        btnFullscreenLabel.textContent = isFs ? t('fullscreenExit') : t('fullscreenEnter');
    }
    btnFullscreen.setAttribute('aria-label', isFs ? t('fullscreenExitAria') : t('fullscreenEnterAria'));
}

if (btnFullscreen) {
    if (isFullscreenSupported()) btnFullscreen.hidden = false;
    btnFullscreen.addEventListener('click', () => {
        if (getCurrentFullscreenElement()) void exitFullscreen();
        else void enterFullscreen();
    });
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
    syncFullscreenButton();
}

/** Автозапуск после загрузки часто блокируется — тап по панели (не по кнопке уровня) включает меню */
mainMenu.addEventListener(
    'pointerdown',
    (e) => {
        if (isPlaying) return;
        tryUnlockAudioOnUserGesture();
        if (e.target?.closest?.('.menu-main-controls')) return;
        if (e.target?.closest?.('.level-btn')) return;
        if (e.target?.closest?.('.menu-player-row')) return;
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

const optPlayers1 = document.getElementById('opt-players-1');
const optPlayers2 = document.getElementById('opt-players-2');

function syncPlayerCountRadios() {
    if (!optPlayers1 || !optPlayers2) return;
    optPlayers1.checked = playerModeCount === 1;
    optPlayers2.checked = playerModeCount === 2;
}

async function createPoseLandmarkerInstance() {
    const vision = visionTasksResolver;
    if (!vision) {
        console.warn('[NeonNinjaCat] createPoseLandmarkerInstance: vision resolver not ready');
        return;
    }
    const np = playerModeCount === 1 ? 1 : 2;
    const poseOpts = (delegate) => ({
        baseOptions: {
            modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
            delegate
        },
        runningMode: 'VIDEO',
        numPoses: np
    });

    const delegateOrder = trackTuning.mobile ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
    let lastErr;
    for (const delegate of delegateOrder) {
        try {
            poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOpts(delegate));
            mediapipePoseDelegate = delegate;
            console.info(
                `[MediaPipe] pose: ${mediapipePoseDelegate}, numPoses=${np}, mobile=${trackTuning.mobile} — если CPU, игра тяжелее; в DevTools отключите throttling.`
            );
            return;
        } catch (e) {
            lastErr = e;
            console.warn(`PoseLandmarker ${delegate} failed:`, e);
        }
    }
    throw lastErr ?? new Error('PoseLandmarker init failed');
}

function resetPoseDisplayState() {
    posePrevTargetByKey.clear();
    poseTargetByKey.clear();
    poseDisplayByKey.clear();
    displayPersonOrder.length = 0;
    lastDetectTsMs = -1;
    poseFrameTsPrev = -1;
    poseFrameTsCurr = -1;
    poseFrameIntervalMs = 33.33;
    poseFrameCommitPerfMs = 0;
}

async function recreatePoseLandmarker() {
    if (!visionTasksResolver) return;
    if (poseLandmarker) {
        try {
            poseLandmarker.close();
        } catch (_) {}
        poseLandmarker = null;
    }
    lastVideoTime = -1;
    currentPoseResults = null;
    resetPoseDisplayState();
    await createPoseLandmarkerInstance();
}

function applyPlayerModeFromUi(userInitiated) {
    const next = optPlayers1?.checked ? 1 : 2;
    if (userInitiated && next === playerModeCount) return;
    playerModeCount = next;
    localStorage.setItem(STORAGE_PLAYER_COUNT, String(playerModeCount));
    syncPlayerCountRadios();
    if (userInitiated) void recreatePoseLandmarker();
}

optPlayers1?.addEventListener('change', () => {
    if (optPlayers1.checked) applyPlayerModeFromUi(true);
});
optPlayers2?.addEventListener('change', () => {
    if (optPlayers2.checked) applyPlayerModeFromUi(true);
});

const optLangRu = document.getElementById('opt-lang-ru');
const optLangEn = document.getElementById('opt-lang-en');
optLangRu?.addEventListener('change', () => {
    if (optLangRu.checked) setUiLang('ru');
});
optLangEn?.addEventListener('change', () => {
    if (optLangEn.checked) setUiLang('en');
});

loadPersistedSettings();
syncPlayerCountRadios();
applyUiTranslations();

// Geometry configuration
const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

// Resize canvas to match window completely
/** Logical game size (matches canvas buffer; avoids 100vh vs innerHeight stretch on mobile) */
let gameLayout = { w: 800, h: 600, minSide: 600 };

/**
 * Потолок длинной стороны **буфера** canvas (не CSS). На широком мониторе / Responsive DevTools
 * иначе 2000+ px → тяжёлый fill+тени и заметные фризы при hand на CPU.
 */
const MAX_CANVAS_LONG_EDGE_PX = 1280;
let loggedCanvasBufferCap = false;

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
    const { w: vw, h: vh } = readViewportSize();
    if (vw === lastResizeW && vh === lastResizeH) return;
    lastResizeW = vw;
    lastResizeH = vh;

    let iw = vw;
    let ih = vh;
    const longEdge = Math.max(iw, ih);
    if (longEdge > MAX_CANVAS_LONG_EDGE_PX) {
        const s = MAX_CANVAS_LONG_EDGE_PX / longEdge;
        iw = Math.max(1, Math.floor(vw * s));
        ih = Math.max(1, Math.floor(vh * s));
    }

    if ((iw < vw || ih < vh) && !loggedCanvasBufferCap) {
        loggedCanvasBufferCap = true;
        console.info(
            `[NeonNinjaCat] буфер canvas ограничен ${iw}×${ih} px (окно ${vw}×${vh}) — иначе полный размер сильно грузит GPU/CPU`
        );
    }

    gameLayout.w = iw;
    gameLayout.h = ih;
    gameLayout.minSide = Math.min(iw, ih);

    canvasElement.width = iw;
    canvasElement.height = ih;
    canvasElement.style.width = `${vw}px`;
    canvasElement.style.height = `${vh}px`;

    const gc = document.getElementById('game-container');
    if (gc) {
        gc.style.width = `${vw}px`;
        gc.style.height = `${vh}px`;
    }
    document.documentElement.style.height = `${vh}px`;
    document.body.style.height = `${vh}px`;
    document.documentElement.style.width = `${vw}px`;
    document.body.style.width = `${vw}px`;
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

    const constraintSets = [];
    if (trackTuning.android) {
        constraintSets.push({
            video: {
                width: { ideal: 640, max: 640 },
                height: { ideal: 480, max: 480 },
                frameRate: { ideal: 30, max: 30 },
                facingMode: 'user'
            }
        });
    }
    constraintSets.push(
        { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } },
        { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } },
        { video: { facingMode: 'user' } },
        { video: true }
    );

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

    visionTasksResolver = vision;
    await createPoseLandmarkerInstance();

    preloadGameAudio();

    loadingElement.classList.remove('visible');
    showMainMenu();
}

// Game Objects
const fruitEmojiTextures = {};

function initFruitTextures() {
    const emojis = ['🍌', '🍎', '🍉', '🍊', '🍗', '🥩', '🥦', '🥬', '🍆', '🍅'];
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

/** Русский алфавит для уровней 4–6 (озвучка при вылете — sounds/letters/ru) */
const CYRILLIC_LETTERS = [
    'А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ё', 'Ж', 'З', 'И', 'Й', 'К', 'Л', 'М', 'Н', 'О', 'П',
    'Р', 'С', 'Т', 'У', 'Ф', 'Х', 'Ц', 'Ч', 'Ш', 'Щ', 'Ъ', 'Ы', 'Ь', 'Э', 'Ю', 'Я'
];

/** Латиница для буквенных уровней при английском UI */
const LATIN_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

function letterAlphabetForUiLang() {
    return uiLang === 'en' ? LATIN_LETTERS : CYRILLIC_LETTERS;
}

const GLYPH_NEON_COLORS = [
    '#ffe135', '#ff0800', '#fc3a52', '#ffa500', '#ffcc80', '#76ff03', '#00e5ff',
    '#651fff', '#ff00ea', '#00f3ff', '#e53935', '#8bc34a', '#9c27b0'
];

const glyphTextureCache = new Map();

/** Буквы/цифры на экране крупнее продуктов */
const GLYPH_RADIUS_SCALE = 1.5;
const GLYPH_RADIUS_CAP_PX = 240;

function glyphFontPx(label, canvasSize) {
    const len = label.length;
    if (len >= 3) return canvasSize * 0.37;
    if (len === 2) return canvasSize * 0.46;
    return canvasSize * 0.58;
}

/** Числовые уровни: следующее число по порядку 1 → NUMBER_SPAWN_CYCLE_MAX → 1 … */
let sequentialSpawnNumber = 1;
/** Буквенные уровни: следующая буква по алфавиту (кириллица или A–Z по языку UI) */
let sequentialLetterIndex = 0;

/** Буквы и цифры: только небольшой наклон и лёгкое качание (без полного оборота и «нечитаемых» углов) */
const GLYPH_MAX_TILT_RAD = (14 * Math.PI) / 180;
const GLYPH_ROT_SPEED_RANGE = 0.008;

function parseGlyphHex(hex) {
    const h = (hex || '#00f3ff').replace('#', '');
    if (h.length === 3) {
        return {
            r: parseInt(h[0] + h[0], 16),
            g: parseInt(h[1] + h[1], 16),
            b: parseInt(h[2] + h[2], 16)
        };
    }
    if (h.length === 6) {
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }
    return { r: 0, g: 243, b: 255 };
}

function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function getOrCreateGlyphTexture(cacheKey, label, color) {
    const versionedKey = `g3:${cacheKey}`;
    let hit = glyphTextureCache.get(versionedKey);
    if (hit) return hit;
    const size = 600;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const fp = glyphFontPx(label, size);
    ctx.font = `900 ${fp}px "Outfit", "Segoe UI", system-ui, sans-serif`;
    const dy = 10;
    const cx = size / 2;
    const cy = size / 2 + dy;
    const rgb = parseGlyphHex(color);

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.092;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillText(label, cx, cy);
    ctx.restore();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(8,10,20,0.78)';
    ctx.lineWidth = Math.max(6, size * 0.028);
    ctx.strokeText(label, cx, cy);

    const grad = ctx.createLinearGradient(cx - fp * 0.38, cy - fp * 0.42, cx + fp * 0.34, cy + fp * 0.48);
    grad.addColorStop(
        0,
        `rgb(${clampByte(rgb.r * 1.28)},${clampByte(rgb.g * 1.28)},${clampByte(rgb.b * 1.28)})`
    );
    grad.addColorStop(0.5, color);
    grad.addColorStop(
        1,
        `rgb(${clampByte(rgb.r * 0.5)},${clampByte(rgb.g * 0.5)},${clampByte(rgb.b * 0.5)})`
    );
    ctx.fillStyle = grad;
    ctx.fillText(label, cx, cy);

    hit = { canvas: c, size };
    glyphTextureCache.set(versionedKey, hit);
    return hit;
}

class Fruit {
    constructor() {
        const { w, h, minSide } = gameLayout;
        const levelCfg = getCurrentLevelConfig();
        this.levelMode = levelCfg.mode || 'fruit';

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
        let r = Math.min(160, Math.max(36, rLo + Math.random() * (rHi - rLo)));
        if (this.levelMode !== 'fruit') {
            r = Math.min(GLYPH_RADIUS_CAP_PX, Math.max(54, r * GLYPH_RADIUS_SCALE));
        }
        this.radius = r;

        if (this.levelMode === 'fruit') {
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
                { emoji: '🍅', color: '#e53935' }  // Tomato red
            ];
            const type = fruitTypes[Math.floor(Math.random() * fruitTypes.length)];
            this.emoji = type.emoji;
            this.color = type.color;
            this.textureRef = fruitEmojiTextures[this.emoji];
            playSpawnVoice(this.emoji);
        } else if (this.levelMode === 'letter') {
            this.emoji = null;
            const alphabet = letterAlphabetForUiLang();
            const ch = alphabet[sequentialLetterIndex];
            sequentialLetterIndex = (sequentialLetterIndex + 1) % alphabet.length;
            this.glyphChar = ch;
            this.color = GLYPH_NEON_COLORS[Math.floor(Math.random() * GLYPH_NEON_COLORS.length)];
            const cacheKey = `ltr:${ch}:${this.color}`;
            this.textureRef = getOrCreateGlyphTexture(cacheKey, ch, this.color);
            playLetterSpawnSound(ch);
        } else if (this.levelMode === 'word') {
            this.emoji = null;
            const ch = pickWordSpawnChar();
            this.glyphChar = ch;
            this.color = GLYPH_NEON_COLORS[Math.floor(Math.random() * GLYPH_NEON_COLORS.length)];
            const cacheKey = `ltr:${ch}:${this.color}`;
            this.textureRef = getOrCreateGlyphTexture(cacheKey, ch, this.color);
            playLetterSpawnSound(ch);
        } else {
            this.emoji = null;
            const n = sequentialSpawnNumber;
            sequentialSpawnNumber =
                sequentialSpawnNumber >= NUMBER_SPAWN_CYCLE_MAX ? 1 : sequentialSpawnNumber + 1;
            const label = String(n);
            this.color = GLYPH_NEON_COLORS[Math.floor(Math.random() * GLYPH_NEON_COLORS.length)];
            const cacheKey = `num:${n}:${this.color}`;
            this.textureRef = getOrCreateGlyphTexture(cacheKey, label, this.color);
            playNumberSpawnSound(n);
        }

        this.isSliced = false;
        this.sliceOffsetX = 0;
        this.hitFlash = 0;
        /** Путь «вошёл в предмет» vs «ещё внутри» — один рез на один проход руки */
        this._wasTouchingHand = false;
        /** Сколько кадров подряд нет пересечения (сброс _wasTouchingHand только после дебаунса) */
        this._noContactFrames = 0;

        if (this.levelMode === 'fruit') {
            this.rotation = Math.random() * Math.PI * 2;
            this.rotationSpeed = (Math.random() - 0.5) * 0.1;
        } else {
            this.rotation = (Math.random() * 2 - 1) * GLYPH_MAX_TILT_RAD * 0.9;
            this.rotationSpeed = (Math.random() * 2 - 1) * GLYPH_ROT_SPEED_RANGE;
        }

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
        
        if (this.hitFlash > 0) this.hitFlash -= 0.35 * dt;

        if (!this.isSliced) {
            this.rotation += this.rotationSpeed * dt;
            if (this.levelMode !== 'fruit') {
                if (this.rotation > GLYPH_MAX_TILT_RAD) {
                    this.rotation = GLYPH_MAX_TILT_RAD;
                    this.rotationSpeed = -Math.abs(this.rotationSpeed);
                } else if (this.rotation < -GLYPH_MAX_TILT_RAD) {
                    this.rotation = -GLYPH_MAX_TILT_RAD;
                    this.rotationSpeed = Math.abs(this.rotationSpeed);
                }
            }
        } else {
            this.sliceOffsetX += 6 * dt;
            this.rot1 += this.rotSpeed1 * dt;
            this.rot2 += this.rotSpeed2 * dt;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        /** Canvas на экране зеркалится через CSS scaleX(-1) — компенсируем только текст/буквы, чтобы читалось нормально */
        const compensateCssMirror = this.levelMode !== 'fruit';
        if (compensateCssMirror) ctx.scale(-1, 1);

        const texture = this.textureRef.canvas;
        const texSize = this.textureRef.size;
        const drawSize = this.radius * 2;
        
        if (!this.isSliced) {
            ctx.rotate(this.rotation);
            if (this.hitFlash > 0) {
                ctx.shadowColor = '#00f3ff';
                const blurBase = this.levelMode === 'fruit' ? 18 : 26;
                ctx.shadowBlur = blurBase + this.hitFlash * 2;
            }
            ctx.drawImage(texture, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
            ctx.shadowBlur = 0;
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

/** DIP joint used as “base” to aim claw along the finger (toward tip) */
const TIP_CLAW_BASE = { 8: 7, 20: 19 };

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

/** Three white claw prongs at the tip, pointing along the finger.
 *  handSpanPx — экранная длина «руки» (запястье→кончик), чтобы когти росли вместе с кистью. */
function drawFingertipClaw(ctx, tip, proximal, handSpanPx) {
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
    /** База ~120 px ≈ обычная рука перед камерой; clamp, чтобы на близком/далёком плане не уезжало в крайности */
    const scale = Math.max(0.7, Math.min(3.5, (handSpanPx || 120) / 120));
    ctx.save();
    ctx.translate(tip.x, tip.y);
    ctx.rotate(baseAng);
    ctx.fillStyle = '#f4f6ff';
    ctx.strokeStyle = 'rgba(200, 215, 255, 0.92)';
    ctx.lineWidth = 1.4 * scale;
    ctx.shadowColor = 'rgba(0, 243, 255, 0.6)';
    ctx.shadowBlur = 9 * scale;
    const prongs = [
        { rot: -0.34, reach: 28 * scale, half: 6.5 * scale },
        { rot: 0,     reach: 38 * scale, half: 8.0 * scale },
        { rot: 0.34,  reach: 28 * scale, half: 6.5 * scale }
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
 * Из BlazePose (33 точки) собираем «псевдо-кисть» (21 точка),
 * чтобы дальше работал тот же конвейер слайс-сегментов и клешней.
 * Заполняем только нужное: 0 (запястье), 4 (большой), 7 (PIP индекса), 8 (индекс), 19 (DIP мизинца), 20 (мизинец).
 * Остальные индексы дублируем валидными значениями, чтобы getScreenPoint никогда не падал.
 */
const POSE_BODY_HANDS = [
    { key: 'PoseLeft',  wristIdx: 15, indexIdx: 19, pinkyIdx: 17, thumbIdx: 21 },
    { key: 'PoseRight', wristIdx: 16, indexIdx: 20, pinkyIdx: 18, thumbIdx: 22 }
];
/** В режиме pose-hands сегменты считаем только по индексу + мизинцу: они стабильнее всего у BlazePose */
const POSE_HAND_TIP_INDICES = [8, 20];
/** Минимальная видимость запястья BlazePose, ниже которой кисть не используем */
const POSE_HAND_MIN_VISIBILITY = 0.55;

function midpoint(a, b) {
    return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function buildSyntheticHandFromPose(poseLandmarks, def) {
    const wrist = poseLandmarks[def.wristIdx];
    const indexT = poseLandmarks[def.indexIdx];
    const pinkyT = poseLandmarks[def.pinkyIdx];
    const thumbT = poseLandmarks[def.thumbIdx];
    if (!wrist || !indexT || !pinkyT) return null;
    const vis = wrist.visibility ?? 1;
    if (vis < POSE_HAND_MIN_VISIBILITY) return null;

    const indexPip = midpoint(wrist, indexT);
    const pinkyDip = midpoint(wrist, pinkyT);
    const middleT = midpoint(indexT, pinkyT);
    const middlePip = midpoint(wrist, middleT);
    const ringT = midpoint(middleT, pinkyT);
    const ringPip = midpoint(wrist, ringT);
    const thumb = thumbT || midpoint(wrist, indexT);

    const lm = new Array(21);
    for (let i = 0; i < 21; i++) lm[i] = wrist;
    lm[0] = wrist;
    lm[1] = midpoint(wrist, thumb);
    lm[2] = midpoint(wrist, thumb);
    lm[3] = midpoint(wrist, thumb);
    lm[4] = thumb;
    lm[5] = midpoint(wrist, indexT);
    lm[6] = midpoint(wrist, indexT);
    lm[7] = indexPip;
    lm[8] = indexT;
    lm[9]  = middlePip;
    lm[10] = middlePip;
    lm[11] = middlePip;
    lm[12] = middleT;
    lm[13] = ringPip;
    lm[14] = ringPip;
    lm[15] = ringPip;
    lm[16] = ringT;
    lm[17] = pinkyDip;
    lm[18] = pinkyDip;
    lm[19] = pinkyDip;
    lm[20] = pinkyT;
    return lm;
}

/**
 * Порядок persons между кадрами у MediaPipe не гарантирован, поэтому сортируем
 * по средней X запястий (15+16) — левый игрок всегда #0, правый #1.
 * Это держит prevFingertipsByKey / tipVelocityByKey стабильными для двух игроков.
 */
function getOrderedPersons(poseResults) {
    const persons = poseResults?.landmarks;
    if (!persons?.length) return [];
    return persons
        .map((lm, idx) => {
            const lw = lm[15];
            const rw = lm[16];
            const xs = [];
            if (lw) xs.push(lw.x);
            if (rw) xs.push(rw.x);
            return { lm, idx, sortX: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : idx };
        })
        .sort((a, b) => a.sortX - b.sortX)
        .map((p, i) => ({ lm: p.lm, key: `Pose#${i}` }));
}

/**
 * BlazePose у второго человека (вторичный детект) даёт заметно более шумные точки кистей
 * (15..22) — клешни «дёргаются». Делаем лёгкое EMA-сглаживание именно ВХОДНЫХ точек кисти,
 * per-person, до построения синтетической кисти. Высокий alpha = маленькая задержка
 * (1–2 кадра), но достаточно, чтобы убрать пиксельный jitter.
 */
const HAND_INPUT_INDICES = [15, 16, 17, 18, 19, 20, 21, 22];
const HAND_INPUT_ALPHA = 0.55;
const HAND_INPUT_TELEPORT = 0.20;
const HAND_INPUT_TTL_MS = 600;
const handInputSmoothByKey = new Map();

function smoothHandInputLm(personKey, rawLm, nowMs) {
    let state = handInputSmoothByKey.get(personKey);
    if (!state) {
        state = { lm: {}, lastSeenMs: nowMs };
        handInputSmoothByKey.set(personKey, state);
    }
    state.lastSeenMs = nowMs;
    const out = rawLm.slice();
    for (const i of HAND_INPUT_INDICES) {
        const r = rawLm[i];
        if (!r) continue;
        const prev = state.lm[i];
        if (!prev || Math.hypot(r.x - prev.x, r.y - prev.y) > HAND_INPUT_TELEPORT) {
            state.lm[i] = { x: r.x, y: r.y, z: r.z, visibility: r.visibility };
        } else {
            const a = HAND_INPUT_ALPHA;
            state.lm[i] = {
                x: prev.x * (1 - a) + r.x * a,
                y: prev.y * (1 - a) + r.y * a,
                z: (prev.z ?? 0) * (1 - a) + (r.z ?? 0) * a,
                visibility: r.visibility
            };
        }
        out[i] = state.lm[i];
    }
    return out;
}

function pruneHandInputSmoothState(activeKeys, nowMs) {
    for (const k of [...handInputSmoothByKey.keys()]) {
        if (activeKeys.has(k)) continue;
        const s = handInputSmoothByKey.get(k);
        if (!s || nowMs - s.lastSeenMs > HAND_INPUT_TTL_MS) {
            handInputSmoothByKey.delete(k);
        }
    }
}

function buildKeyedHandsFromPose(displayPersons) {
    const ordered = displayPersons ?? getDisplayOrderedPersons();
    if (!ordered.length) return [];
    const nowMs = performance.now();
    const activeKeys = new Set(ordered.map((p) => p.key));
    pruneHandInputSmoothState(activeKeys, nowMs);
    const out = [];
    for (let p = 0; p < ordered.length; p++) {
        const suffix = ordered.length > 1 ? `#${p}` : '';
        /** При интерполяции display уже сглажен между кадрами — лишний EMA на каждом rAF даёт «30 fps» */
        const stableLm = trackTuning.interpolatePose
            ? ordered[p].lm
            : smoothHandInputLm(ordered[p].key, ordered[p].lm, nowMs);
        for (const def of POSE_BODY_HANDS) {
            const lm = buildSyntheticHandFromPose(stableLm, def);
            if (!lm) continue;
            out.push({ key: `${def.key}${suffix}`, landmarks: lm });
        }
    }
    return out;
}

/**
 * BlazePose выдаёт лендмарки с заметным шумом — особенно лицо (0..10) и кисти-«огрызки» (17..22).
 * Для **отрисовки** скелета и маски используем экспоненциально сглаженные точки
 * (per-person, в нормализованных координатах, до проекции на canvas).
 * Для построения кистей под коллизию остаются СЫРЫЕ лендмарки —
 * иначе появляется заметная задержка между взмахом и резом.
 *
 * Лицу нужно тише (маска маленькая, шум виден), телу — чуть резче, чтобы не «уезжало».
 * При телепорте (резкий скачок) стейт сбрасываем, чтобы не «ползло».
 */
const FACE_LM_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const POSE_FACE_ALPHA = 0.28;
const POSE_BODY_ALPHA = 0.40;
const POSE_TELEPORT_THRESHOLD = 0.22;
const POSE_STATE_TTL_MS = 600;
/** Map<personKey, { lm: { [idx]: {x, y, z, visibility} }, lastSeenMs }> */
const poseSmoothByKey = new Map();

function smoothPoseLandmarks(personKey, rawLm, nowMs) {
    let state = poseSmoothByKey.get(personKey);
    if (!state) {
        state = { lm: {}, lastSeenMs: nowMs };
        poseSmoothByKey.set(personKey, state);
    }
    state.lastSeenMs = nowMs;
    const out = new Array(rawLm.length);
    for (let i = 0; i < rawLm.length; i++) {
        const r = rawLm[i];
        if (!r) {
            out[i] = r;
            continue;
        }
        const prev = state.lm[i];
        const alpha = FACE_LM_INDICES.has(i) ? POSE_FACE_ALPHA : POSE_BODY_ALPHA;
        if (!prev || Math.hypot(r.x - prev.x, r.y - prev.y) > POSE_TELEPORT_THRESHOLD) {
            state.lm[i] = { x: r.x, y: r.y, z: r.z, visibility: r.visibility };
        } else {
            state.lm[i] = {
                x: prev.x * (1 - alpha) + r.x * alpha,
                y: prev.y * (1 - alpha) + r.y * alpha,
                z: (prev.z ?? 0) * (1 - alpha) + (r.z ?? 0) * alpha,
                visibility: r.visibility
            };
        }
        out[i] = state.lm[i];
    }
    return out;
}

function prunePoseSmoothState(activeKeys, nowMs) {
    for (const k of [...poseSmoothByKey.keys()]) {
        if (activeKeys.has(k)) continue;
        const s = poseSmoothByKey.get(k);
        if (!s || nowMs - s.lastSeenMs > POSE_STATE_TTL_MS) {
            poseSmoothByKey.delete(k);
        }
    }
}

function cloneLandmarks(lm) {
    return lm.map((p) => (p ? { x: p.x, y: p.y, z: p.z, visibility: p.visibility } : p));
}

function lerpLandmarks(lmA, lmB, t) {
    const n = Math.max(lmA.length, lmB.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = lmA[i];
        const b = lmB[i];
        if (!a && !b) {
            out[i] = undefined;
            continue;
        }
        if (!a) {
            out[i] = cloneLandmarks([b])[0];
            continue;
        }
        if (!b) {
            out[i] = cloneLandmarks([a])[0];
            continue;
        }
        out[i] = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * t,
            visibility: a.visibility ?? b.visibility
        };
    }
    return out;
}

function poseSmoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

/** Сглаживание только на новом кадре камеры; prev/target — для интерполяции на rAF */
function commitPoseTargetsFromFrame(orderedPersons, nowMs) {
    const activeKeys = new Set();
    displayPersonOrder.length = 0;

    const frameTsMs = Number.isFinite(video.currentTime) ? video.currentTime * 1000 : nowMs;
    if (poseFrameTsCurr >= 0 && frameTsMs > poseFrameTsCurr) {
        poseFrameIntervalMs = Math.max(16, Math.min(120, frameTsMs - poseFrameTsCurr));
    }
    if (poseFrameTsCurr >= 0) poseFrameTsPrev = poseFrameTsCurr;
    else poseFrameTsPrev = frameTsMs;
    poseFrameTsCurr = frameTsMs;

    for (const { lm: rawLm, key } of orderedPersons) {
        activeKeys.add(key);
        displayPersonOrder.push(key);
        const smoothed = smoothPoseLandmarks(key, rawLm, nowMs);
        const prevTarget = poseTargetByKey.get(key);
        if (prevTarget) posePrevTargetByKey.set(key, cloneLandmarks(prevTarget));
        else posePrevTargetByKey.set(key, cloneLandmarks(smoothed));
        poseTargetByKey.set(key, cloneLandmarks(smoothed));
        if (!poseDisplayByKey.has(key) || !trackTuning.interpolatePose) {
            poseDisplayByKey.set(key, cloneLandmarks(smoothed));
        }
    }

    prunePoseSmoothState(activeKeys, nowMs);

    for (const k of [...poseDisplayByKey.keys()]) {
        if (activeKeys.has(k)) continue;
        const s = poseSmoothByKey.get(k);
        if (!s || nowMs - s.lastSeenMs > POSE_STATE_TTL_MS) {
            poseDisplayByKey.delete(k);
            poseTargetByKey.delete(k);
            posePrevTargetByKey.delete(k);
            const idx = displayPersonOrder.indexOf(k);
            if (idx >= 0) displayPersonOrder.splice(idx, 1);
        }
    }

    poseFrameCommitPerfMs = performance.now();
}

function updatePoseDisplayLandmarks(nowMs) {
    if (!trackTuning.interpolatePose) {
        for (const [key, target] of poseTargetByKey) {
            poseDisplayByKey.set(key, cloneLandmarks(target));
        }
        return;
    }

    if (!poseFrameCommitPerfMs || !displayPersonOrder.length) return;

    /** video.currentTime на Android меняется только с новым кадром (~30 fps) — t по wall clock после commit */
    const wallNow = performance.now();
    const interval = Math.max(20, poseFrameIntervalMs || 33.33);
    let t = (wallNow - poseFrameCommitPerfMs) / interval;
    t = Math.max(0, Math.min(1, t));
    const te = poseSmoothstep(t);

    for (const key of displayPersonOrder) {
        const prev = posePrevTargetByKey.get(key);
        const target = poseTargetByKey.get(key);
        if (!target) continue;
        if (!prev || te >= 1) {
            poseDisplayByKey.set(key, cloneLandmarks(target));
        } else {
            poseDisplayByKey.set(key, lerpLandmarks(prev, target, te));
        }
    }
}

function getDisplayOrderedPersons() {
    return displayPersonOrder
        .map((key) => {
            const lm = poseDisplayByKey.get(key);
            return lm ? { key, lm } : null;
        })
        .filter(Boolean);
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
/** Previous-frame fingertip positions: Map<handKey, { 8: {x,y}, ... }> */
let prevFingertipsByKey = new Map();
/** Last time this hand key was present in MediaPipe results (performance.now) */
let handKeyLastSeenMs = new Map();
/** Smoothed screen-space velocity per tip for short dropout extrapolation */
let tipVelocityByKey = new Map();

let perfFrameSumMs = 0;
let perfFrameCount = 0;
let perfLastLogMs = 0;

/** Единственный владелец rAF-цикла: на экране победы цикл продолжается (салют), не плодим второй */
let rafActive = false;

function ensureGameLoop() {
    if (!rafActive) {
        rafActive = true;
        requestAnimationFrame(gameLoop);
    }
}

function gameLoop(nowTime) {
    if (!isPlaying) {
        rafActive = false;
        return;
    }

    const levelCfg = getCurrentLevelConfig();

    if (!nowTime) nowTime = performance.now();
    let dt = (nowTime - lastFrameTime) / (1000 / 60); // Normalize to 60fps
    if (dt > 3) dt = 3; // Cap lag spikes
    if (dt < 0) dt = 0; // Prevent reverse time
    lastFrameTime = nowTime;

    let startTimeMs = performance.now();
    let gotNewVideoFrame = false;

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        gotNewVideoFrame = true;
        /** Время кадра видео (мс) — строго монотонное для VIDEO mode */
        let frameTsMs = Number.isFinite(video.currentTime) ? video.currentTime * 1000 : startTimeMs;
        if (frameTsMs <= lastDetectTsMs) frameTsMs = lastDetectTsMs + 1;
        lastDetectTsMs = frameTsMs;
        try {
            const pRes = poseLandmarker.detectForVideo(video, frameTsMs);
            if (pRes) currentPoseResults = pRes;
        } catch (err) {
            console.warn("PoseLandmarker detectForVideo:", err);
        }
    }

    if (gotNewVideoFrame && currentPoseResults?.landmarks?.length) {
        commitPoseTargetsFromFrame(getOrderedPersons(currentPoseResults), nowTime);
    } else if (gotNewVideoFrame) {
        const activeKeys = new Set();
        prunePoseSmoothState(activeKeys, nowTime);
        for (const k of [...poseDisplayByKey.keys()]) {
            const s = poseSmoothByKey.get(k);
            if (!s || nowTime - s.lastSeenMs > POSE_STATE_TTL_MS) {
                poseDisplayByKey.delete(k);
                poseTargetByKey.delete(k);
                posePrevTargetByKey.delete(k);
            }
        }
        for (let i = displayPersonOrder.length - 1; i >= 0; i--) {
            if (!poseDisplayByKey.has(displayPersonOrder[i])) displayPersonOrder.splice(i, 1);
        }
    }
    updatePoseDisplayLandmarks(nowTime);

    const displayPersons = getDisplayOrderedPersons();

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

    // Draw Pose (display-landmarks: сглажены на кадре камеры + интерполяция на rAF)
    if (displayPersons.length > 0) {
        for (const { lm: landmarks } of displayPersons) {
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

    const keyedHands = buildKeyedHandsFromPose(displayPersons);
    /** Из BlazePose валидные только два «кончика» — индекс и мизинец */
    const activeTipIndices = POSE_HAND_TIP_INDICES;

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
        for (const tipIdx of activeTipIndices) {
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

        for (const tipIdx of activeTipIndices) {
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
        for (const { landmarks } of keyedHands) {
            const wristScreen = getScreenPoint(landmarks[0]);
            activeTipIndices.forEach((tipIndex) => {
                const tip = getScreenPoint(landmarks[tipIndex]);
                const baseIdx = TIP_CLAW_BASE[tipIndex];
                const proximal = getScreenPoint(landmarks[baseIdx]);
                const handSpanPx = Math.hypot(tip.x - wristScreen.x, tip.y - wristScreen.y);
                drawFingertipClaw(canvasCtx, tip, proximal, handSpanPx);
            });
        }
    }

    // Update and draw fruits
    const now = Date.now();
    const unslicedCount = fruits.filter((f) => !f.isSliced).length;
    /** В режиме слов — строго одна нужная буква на экране, чтобы ребёнок видел ровно ту, что нужна */
    const effectiveMaxConcurrent = levelCfg.mode === 'word' ? 1 : levelCfg.maxConcurrent;
    if (!levelComplete && !wordRevealActive && now - lastSpawnTime >= levelCfg.spawnIntervalMs && unslicedCount < effectiveMaxConcurrent) {
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
            const cutStroke = !levelComplete && !wordRevealActive && pathIntersectsFruit && !fruit._wasTouchingHand;
            if (pathIntersectsFruit) {
                fruit._wasTouchingHand = true;
            }

            if (cutStroke) {
                fruit.isSliced = true;
                fruit.cutAngle = fruit.rotation;
                fruit.rot1 = fruit.rotation;
                fruit.rot2 = fruit.rotation;
                if (fruit.levelMode === 'fruit') {
                    fruit.rotSpeed1 = fruit.rotationSpeed - 0.05;
                    fruit.rotSpeed2 = fruit.rotationSpeed + 0.05;
                } else {
                    fruit.rotSpeed1 = fruit.rotationSpeed - 0.014;
                    fruit.rotSpeed2 = fruit.rotationSpeed + 0.014;
                }

                handleSliceScoring(fruit);
            }
        }

        // Remove if out of bounds (bottom)
        if (fruit.y > gameLayout.h + 100) {
            if (!fruit.isSliced && !levelComplete) handleMiss();
            fruits.splice(i, 1);
        }
    }

    /** Салют на экране победы */
    if (levelComplete) {
        winBurstTimer -= dt;
        if (winBurstTimer <= 0) {
            winBurstTimer = 16 + Math.random() * 12;
            const fx = gameLayout.w * (0.18 + Math.random() * 0.64);
            const fy = gameLayout.h * (0.18 + Math.random() * 0.42);
            const col = GLYPH_NEON_COLORS[Math.floor(Math.random() * GLYPH_NEON_COLORS.length)];
            juiceBurst(fx, fy, col, 30, 18);
        }
    }

    // Update and draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.update(dt);
        p.draw(canvasCtx);
        if (p.life <= 0) particles.splice(i, 1);
    }

    // Всплывающие надписи (серия / похвала / собранное слово)
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.update(dt);
        ft.draw(canvasCtx);
        if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    // Мягкая вспышка-«сок» на удачный рез
    if (screenFlash > 0) {
        canvasCtx.save();
        canvasCtx.globalAlpha = Math.min(0.22, screenFlash);
        canvasCtx.fillStyle = '#ffffff';
        canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);
        canvasCtx.restore();
        screenFlash -= 0.05 * dt;
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

    if (isPlaying) {
        requestAnimationFrame(gameLoop);
    } else {
        rafActive = false;
    }
}

function showStartError(e) {
    console.error(e);
    const name = e?.name || "";
    const msg = e?.message || String(e);
    let hint = t("errorHintGeneric");
    if (name === "NotAllowedError" || /Permission/i.test(msg)) {
        hint = t("errorHintCameraBlocked");
    } else if (name === "NotFoundError" || /DevicesNotFound/i.test(msg)) {
        hint = t("errorHintNoCamera");
    } else if (
        name === "AbortError" ||
        /Timeout starting video source|metadata timeout/i.test(msg)
    ) {
        hint = t("errorHintTimeout");
    }
    loadingElement.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "max-width:28rem;margin:0 auto;text-align:left;line-height:1.45;font-size:0.95rem;";
    const titleP = document.createElement("p");
    titleP.textContent = t("errorTitle");
    titleP.style.fontWeight = "700";
    titleP.style.marginBottom = "0.5rem";
    wrap.appendChild(titleP);
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
