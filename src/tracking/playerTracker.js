/**
 * Трекер игроков поверх детектора поз (MediaPipe): кто из людей в кадре — игрок №0, а кто №1.
 *
 * Порядок поз между кадрами у детектора не гарантирован, а при пересечении игроков позы могут
 * «перепрыгнуть» с одного человека на другого. Идентичность держим по двум признакам:
 *  - положение КОРПУСА (плечи + бёдра) относительно предсказанного с прошлого кадра;
 *  - ВНЕШНОСТЬ — гистограмма цвета одежды на корпусе. В момент пересечения положение у игроков
 *    почти одинаковое, и различает их только она; пока игроки рядом, внешность не обновляется,
 *    чтобы цвета не смешались. По ней же игрок узнаётся после возвращения в кадр.
 *
 * Пропавший игрок «доезжает» по инерции (predicted): дольше, если его загородил второй,
 * и совсем коротко, если он сам вышел за край кадра.
 *
 * Модуль не зависит от браузера — кадр для гистограммы передаётся как { data, width, height } (RGBA).
 */

const TORSO = [11, 12, 23, 24];
/** Точки тела для сравнения двух поз на «дубль» */
const COMPARE = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

/** Видимость, с которой точка корпуса считается надёжной */
const RELIABLE_VISIBILITY = 0.5;
/** Вес ненадёжной точки корпуса в опорной точке: не 0, иначе центр «прыгает», когда плечо уходит за кадр */
const UNRELIABLE_WEIGHT = 0.25;
/** Насколько точка может выйти за кадр (в долях), прежде чем считаться невидимой */
const FRAME_MARGIN = 0.02;

/** Средняя разница поз (в масштабах корпуса), ниже которой это один и тот же человек */
const DUPLICATE_POSE_DIST = 0.35;
/** Максимальный сдвиг корпуса между кадрами (в масштабах корпуса) для сопоставления с треком */
const MATCH_GATE = 2.0;
/** Вес различия внешности (0…1) относительно сдвига в масштабах корпуса */
const APPEARANCE_WEIGHT = 1.6;
/**
 * Внешность учитываем, только если игроки действительно различаются: при различии гистограмм
 * треков ниже LOW вес нулевой (одинаковая одежда — шум гистограмм не должен перевешивать положение),
 * выше HIGH — полный.
 */
const APPEARANCE_DISTINCT_LOW = 0.3;
const APPEARANCE_DISTINCT_HIGH = 0.6;
/**
 * Штраф (в масштабах корпуса) треку-«призраку» при сопоставлении: пока загороженный игрок доезжает
 * по инерции рядом с видимым, единственная видимая поза из-за дрожания может оказаться ближе
 * к призраку — и номера поменяются. Действующий трек держит своего игрока, если внешность не против.
 */
const COAST_PENALTY = 0.7;
/** Потерянный трек забирает человека далеко от предсказания, только если одежда похожа не хуже этого */
const TELEPORT_MAX_APPEARANCE_DIST = 0.45;
/** Игроки ближе этого (в масштабах корпуса) — «рядом»: внешность не обновляем */
const CROWDED_DIST = 1.3;
/** Скорость обучения внешности */
const APPEARANCE_ALPHA = 0.08;
const HIST_BINS = 4;

/** Удержание пропавшего игрока по предсказанию, мс */
const HOLD_MS = 500;
/** …если его загородил другой игрок — дольше: он скоро выйдет из-за спины */
const HOLD_OCCLUDED_MS = 900;
/** …если он сам ушёл за край кадра — «призрак» не нужен */
const HOLD_EXITED_MS = 120;
/** Зона у бокового края кадра, где пропажу считаем выходом из кадра */
const EDGE_ZONE = 0.1;

const VELOCITY_SMOOTH = 0.5;
const COAST_DAMP = 0.8;
/** Предел скорости корпуса (доли кадра / мс) — защита от выбросов */
const MAX_SPEED = 0.004;
/** Сколько помним внешность ушедшего игрока, чтобы вернуть ему тот же номер */
const MEMORY_MS = 60000;
/** Сколько после выхода игрока через край считаем, что он «ушёл из кадра» (для подсказки вернуться) */
const EXITED_REMIND_MS = 45000;

function inFrame(p) {
    return p.x >= -FRAME_MARGIN && p.x <= 1 + FRAME_MARGIN && p.y >= -FRAME_MARGIN && p.y <= 1 + FRAME_MARGIN;
}

/** Точки за пределами кадра детектор «угадывает» — помечаем их невидимыми (не рисуются и не бьют) */
export function sanitizeLandmarks(lm) {
    return lm.map((p) => (p && !inFrame(p) && (p.visibility ?? 1) > 0 ? { ...p, visibility: 0 } : p));
}

function reliable(p) {
    return !!p && (p.visibility ?? 1) >= RELIABLE_VISIBILITY && inFrame(p);
}

/**
 * Опорная точка корпуса: взвешенный центр плеч и бёдер + масштаб (размер корпуса).
 * scaleReliable = false, когда масштаб оценён по ненадёжным точкам (игрок частично за кадром).
 */
export function torsoAnchor(lm) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const i of TORSO) {
        const p = lm[i];
        if (!p) continue;
        const w = reliable(p) ? 1 : UNRELIABLE_WEIGHT;
        sx += p.x * w;
        sy += p.y * w;
        sw += w;
    }
    if (!sw) return null;
    const [ls, rs, lh, rh] = TORSO.map((i) => lm[i]);
    const shouldersOk = reliable(ls) && reliable(rs);
    const hipsOk = reliable(lh) && reliable(rh);
    const shoulderW = ls && rs ? Math.hypot(ls.x - rs.x, ls.y - rs.y) : 0;
    const torsoH =
        ls && rs && lh && rh
            ? Math.hypot((ls.x + rs.x - lh.x - rh.x) * 0.5, (ls.y + rs.y - lh.y - rh.y) * 0.5)
            : 0;
    let scale;
    if (shouldersOk && hipsOk) scale = Math.max(shoulderW, torsoH * 0.6);
    else if (shouldersOk) scale = shoulderW;
    else scale = Math.max(shoulderW, torsoH * 0.6);
    return { x: sx / sw, y: sy / sw, scale: Math.max(scale, 0.05), scaleReliable: shouldersOk };
}

function meanVisibility(lm) {
    let s = 0;
    for (const i of COMPARE) s += lm[i]?.visibility ?? 0;
    return s / COMPARE.length;
}

function areDuplicate(a, b) {
    const scale = Math.max(a.anchor.scale, b.anchor.scale);
    let sum = 0;
    let n = 0;
    for (const i of COMPARE) {
        const pa = a.lm[i];
        const pb = b.lm[i];
        if (!pa || !pb) continue;
        sum += Math.hypot(pa.x - pb.x, pa.y - pb.y);
        n++;
    }
    return n > 0 && sum / n / scale < DUPLICATE_POSE_DIST;
}

/**
 * Гистограмма цвета одежды на корпусе (RGB, HIST_BINS³ корзин, сумма = 1) или null,
 * если корпус не виден надёжно. Плечи обязательны; если бёдра за кадром (игрок близко) —
 * берём полосу под плечами.
 * @param {{x:number,y:number,visibility?:number}[]} lm
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} frame RGBA
 */
export function torsoHistogram(lm, frame) {
    if (!frame) return null;
    const [ls, rs, lh, rh] = TORSO.map((i) => lm[i]);
    if (!reliable(ls) || !reliable(rs)) return null;
    let hl = lh;
    let hr = rh;
    if (!reliable(lh) || !reliable(rh)) {
        // «Вниз» от плеч: перпендикуляр к линии плеч в пикселях, длиной ~1.2 ширины плеч
        const aspect = frame.width / frame.height;
        const dx = (rs.x - ls.x) * aspect;
        const dy = rs.y - ls.y;
        const len = Math.hypot(dx, dy) * 1.2;
        const n = Math.hypot(dx, dy) || 1;
        let px = -dy / n;
        let py = dx / n;
        if (py < 0) {
            px = -px;
            py = -py;
        }
        hl = { x: ls.x + (px * len) / aspect, y: ls.y + py * len };
        hr = { x: rs.x + (px * len) / aspect, y: rs.y + py * len };
    }
    const hist = new Float32Array(HIST_BINS ** 3);
    const step = 256 / HIST_BINS;
    let n = 0;
    const GRID = 8;
    for (let iv = 0; iv < GRID; iv++) {
        // Середина корпуса: без краёв (фон, руки) и без самого низа
        const v = 0.15 + (0.6 * iv) / (GRID - 1);
        for (let iu = 0; iu < GRID; iu++) {
            const u = 0.22 + (0.56 * iu) / (GRID - 1);
            const tx = ls.x + (rs.x - ls.x) * u;
            const ty = ls.y + (rs.y - ls.y) * u;
            const bx = hl.x + (hr.x - hl.x) * u;
            const by = hl.y + (hr.y - hl.y) * u;
            const x = Math.floor((tx + (bx - tx) * v) * frame.width);
            const y = Math.floor((ty + (by - ty) * v) * frame.height);
            if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
            const o = (y * frame.width + x) * 4;
            // Мягкое (трилинейное) распределение по соседним корзинам: цвет на границе корзин
            // иначе «прыгает» между ними от шума камеры, и одинаковая одежда выглядит разной
            const r = softBin(frame.data[o], step);
            const g = softBin(frame.data[o + 1], step);
            const bl = softBin(frame.data[o + 2], step);
            for (let ri = 0; ri < 2; ri++) {
                for (let gi = 0; gi < 2; gi++) {
                    for (let bi = 0; bi < 2; bi++) {
                        const w = r.w[ri] * g.w[gi] * bl.w[bi];
                        if (w > 0) hist[(r.i[ri] * HIST_BINS + g.i[gi]) * HIST_BINS + bl.i[bi]] += w;
                    }
                }
            }
            n++;
        }
    }
    if (n < 16) return null;
    for (let i = 0; i < hist.length; i++) hist[i] /= n;
    return hist;
}

/** Значение канала → две соседние корзины и их веса */
function softBin(value, step) {
    const p = value / step - 0.5;
    const lo = Math.floor(p);
    const f = p - lo;
    const i0 = Math.max(0, lo);
    const i1 = Math.min(HIST_BINS - 1, lo + 1);
    return { i: [i0, i1], w: i0 === i1 ? [1, 0] : [1 - f, f] };
}

/** Различие гистограмм: 0 — одинаковые, 1 — ничего общего */
export function histogramDistance(a, b) {
    let inter = 0;
    for (let i = 0; i < a.length; i++) inter += Math.min(a[i], b[i]);
    return 1 - inter;
}

/** Перебор назначений строк к столбцам (их единицы) с минимальной суммой; Infinity — запрет */
function bestAssignment(cost, nCols, unmatchedCost) {
    const n = cost.length;
    let best = new Array(n).fill(-1);
    let bestCost = Infinity;
    const cur = new Array(n).fill(-1);
    const used = new Array(nCols).fill(false);
    (function rec(i, acc) {
        if (acc >= bestCost) return;
        if (i === n) {
            const total = acc + used.filter((u) => !u).length * unmatchedCost;
            if (total < bestCost) {
                bestCost = total;
                best = cur.slice();
            }
            return;
        }
        cur[i] = -1;
        rec(i + 1, acc + unmatchedCost);
        for (let j = 0; j < nCols; j++) {
            if (used[j] || cost[i][j] === Infinity) continue;
            used[j] = true;
            cur[i] = j;
            rec(i + 1, acc + cost[i][j]);
            used[j] = false;
            cur[i] = -1;
        }
    })(0, 0);
    return best;
}

function shiftLandmarks(lm, dx, dy) {
    return lm.map((p) => (p ? { ...p, x: p.x + dx, y: p.y + dy } : p));
}

function clampSpeed(v) {
    return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
}

export class PlayerTracker {
    constructor() {
        /** Map<id, track> */
        this.tracks = new Map();
        /** Map<id, { app, x, ms }> — внешность ушедших игроков */
        this.memory = new Map();
        /** Map<id, ms> — игроки, вышедшие через край кадра и пока не вернувшиеся */
        this.exited = new Map();
    }

    reset() {
        this.tracks.clear();
        this.memory.clear();
        this.exited.clear();
    }

    /**
     * Есть ли игрок, который ушёл за край кадра и не вернулся. Пропажа в середине кадра
     * (загородили, детектор потерял) сюда не попадает — иначе подсказка звучала бы зря.
     */
    hasExitedPlayer(nowMs) {
        for (const [id, ms] of this.exited) {
            if (nowMs - ms > EXITED_REMIND_MS) this.exited.delete(id);
        }
        return this.exited.size > 0;
    }

    /**
     * @param {Array<Array<{x:number,y:number,z?:number,visibility?:number}>>} rawPersons позы детектора
     * @param {number} nowMs
     * @param {{ maxPlayers?: number, frame?: {data:Uint8ClampedArray,width:number,height:number}|null }} [opts]
     *        frame — уменьшенный кадр камеры для сравнения по одежде (можно не передавать)
     * @returns {{ id:number, key:string, lm:Array, predicted:boolean }[]} по возрастанию id
     */
    update(rawPersons, nowMs, opts = {}) {
        const maxPlayers = opts.maxPlayers ?? 2;
        const frame = opts.frame ?? null;

        // --- кандидаты: без дублей, с опорной точкой и внешностью ---
        let cands = [];
        for (const raw of rawPersons ?? []) {
            const anchor = torsoAnchor(raw);
            if (!anchor) continue;
            cands.push({ lm: sanitizeLandmarks(raw), anchor, vis: meanVisibility(raw), app: null, crowded: false });
        }
        cands.sort((a, b) => b.vis - a.vis);
        const unique = [];
        for (const c of cands) if (!unique.some((u) => areDuplicate(u, c))) unique.push(c);
        cands = unique.slice(0, maxPlayers);
        for (let i = 0; i < cands.length; i++) {
            for (let j = i + 1; j < cands.length; j++) {
                const a = cands[i].anchor;
                const b = cands[j].anchor;
                if (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(a.scale, b.scale) < CROWDED_DIST) {
                    cands[i].crowded = true;
                    cands[j].crowded = true;
                }
            }
        }
        if (frame && maxPlayers > 1) for (const c of cands) c.app = torsoHistogram(c.lm, frame);

        // --- сопоставление с треками: положение + внешность ---
        const tracks = [...this.tracks.values()];
        const appWeight = APPEARANCE_WEIGHT * this.appearanceTrust(tracks);
        const cost = tracks.map((t) => {
            const dt = Math.min(nowMs - t.lastUpdateMs, 200);
            const px = t.anchor.x + t.vx * dt;
            const py = t.anchor.y + t.vy * dt;
            return cands.map((c) => {
                const d = Math.hypot(c.anchor.x - px, c.anchor.y - py) / Math.max(t.anchor.scale, c.anchor.scale);
                if (d > MATCH_GATE) return Infinity;
                const app = t.app && c.app ? histogramDistance(t.app, c.app) : 0;
                return d + appWeight * app + (t.predicted ? COAST_PENALTY : 0);
            });
        });
        const assignment = bestAssignment(cost, cands.length, MATCH_GATE);
        const usedCands = new Set(assignment.filter((ci) => ci >= 0));

        // Потерянный трек и «лишний» человек в кадре при занятых номерах — это тот же игрок,
        // просто далеко от предсказания (вышел из-за спины с другой стороны)
        const freeCount = () => maxPlayers - this.tracks.size;
        if (freeCount() <= 0) {
            const lostIdx = tracks.map((_, ti) => ti).filter((ti) => assignment[ti] < 0);
            const spare = cands.map((_, ci) => ci).filter((ci) => !usedCands.has(ci));
            if (lostIdx.length && spare.length) {
                // …но только если одежда не говорит обратное: иначе номер перепрыгнет на другого человека
                const c2 = lostIdx.map((ti) =>
                    spare.map((ci) => {
                        if (!tracks[ti].app || !cands[ci].app) return TELEPORT_MAX_APPEARANCE_DIST * 0.8;
                        const d = histogramDistance(tracks[ti].app, cands[ci].app);
                        return d <= TELEPORT_MAX_APPEARANCE_DIST ? d : Infinity;
                    })
                );
                const a2 = bestAssignment(c2, spare.length, TELEPORT_MAX_APPEARANCE_DIST);
                a2.forEach((sj, k) => {
                    if (sj < 0) return;
                    assignment[lostIdx[k]] = spare[sj];
                    usedCands.add(spare[sj]);
                    tracks[lostIdx[k]].teleported = true;
                });
            }
        }

        const matchedAnchors = assignment.filter((ci) => ci >= 0).map((ci) => cands[ci].anchor);

        tracks.forEach((t, ti) => {
            const ci = assignment[ti];
            const dt = Math.max(1, nowMs - t.lastUpdateMs);
            if (ci >= 0) {
                const c = cands[ci];
                if (t.teleported) {
                    t.vx = 0;
                    t.vy = 0;
                    t.teleported = false;
                } else {
                    const sm = VELOCITY_SMOOTH;
                    t.vx = clampSpeed(t.vx * (1 - sm) + ((c.anchor.x - t.anchor.x) / dt) * sm);
                    t.vy = clampSpeed(t.vy * (1 - sm) + ((c.anchor.y - t.anchor.y) / dt) * sm);
                }
                const scale = c.anchor.scaleReliable ? c.anchor.scale : t.anchor.scale;
                t.anchor = { x: c.anchor.x, y: c.anchor.y, scale };
                t.lm = c.lm;
                t.lastSeenMs = nowMs;
                t.predicted = false;
                if (c.app && !c.crowded) {
                    if (!t.app) t.app = c.app;
                    else for (let i = 0; i < t.app.length; i++) t.app[i] += (c.app[i] - t.app[i]) * APPEARANCE_ALPHA;
                }
            } else if (nowMs - t.lastSeenMs <= this.holdMsFor(t, matchedAnchors)) {
                t.vx *= COAST_DAMP;
                t.vy *= COAST_DAMP;
                const dx = t.vx * dt;
                const dy = t.vy * dt;
                t.anchor = { x: t.anchor.x + dx, y: t.anchor.y + dy, scale: t.anchor.scale };
                t.lm = shiftLandmarks(t.lm, dx, dy);
                t.predicted = true;
            } else {
                if (t.app) this.memory.set(t.id, { app: t.app, x: t.anchor.x, ms: nowMs });
                if (this.isExiting(t)) this.exited.set(t.id, nowMs);
                this.tracks.delete(t.id);
                return;
            }
            t.lastUpdateMs = nowMs;
        });

        // --- новые игроки: номер по памяти о внешности, иначе слева направо ---
        const fresh = cands.filter((_, ci) => !usedCands.has(ci)).slice(0, Math.max(0, freeCount()));
        if (fresh.length) {
            const freeIds = [];
            for (let id = 0; id < maxPlayers; id++) if (!this.tracks.has(id)) freeIds.push(id);
            for (const [id, m] of this.memory) if (nowMs - m.ms > MEMORY_MS) this.memory.delete(id);
            const knows = freeIds.some((id) => this.memory.has(id)) && fresh.some((c) => c.app);
            let order;
            if (knows) {
                const c3 = fresh.map((c) =>
                    freeIds.map((id) => {
                        const m = this.memory.get(id);
                        return m && c.app ? histogramDistance(m.app, c.app) : 0.5;
                    })
                );
                order = bestAssignment(c3, freeIds.length, 2);
            } else {
                const byX = fresh.map((c, i) => [c.anchor.x, i]).sort((a, b) => a[0] - b[0]);
                order = new Array(fresh.length).fill(-1);
                byX.forEach(([, i], k) => {
                    order[i] = k < freeIds.length ? k : -1;
                });
            }
            fresh.forEach((c, i) => {
                if (order[i] < 0) return;
                const id = freeIds[order[i]];
                this.exited.delete(id);
                const remembered = this.memory.get(id)?.app;
                this.tracks.set(id, {
                    id,
                    anchor: { x: c.anchor.x, y: c.anchor.y, scale: c.anchor.scale },
                    vx: 0,
                    vy: 0,
                    lm: c.lm,
                    lastSeenMs: nowMs,
                    lastUpdateMs: nowMs,
                    predicted: false,
                    teleported: false,
                    // Вернувшемуся игроку оставляем прежнюю внешность — она выучена дольше
                    app: remembered && c.app && histogramDistance(remembered, c.app) < 0.5 ? remembered : c.app
                });
            });
        }

        return [...this.tracks.values()]
            .sort((a, b) => a.id - b.id)
            .map((t) => ({ id: t.id, key: `Pose#${t.id}`, lm: t.lm, predicted: t.predicted }));
    }

    /** 0…1: насколько игроков можно различить по одежде (один трек — средне, сравнивать не с кем) */
    appearanceTrust(tracks) {
        const withApp = tracks.filter((t) => t.app);
        if (withApp.length < 2) return 0.5;
        let minDist = 1;
        for (let i = 0; i < withApp.length; i++) {
            for (let j = i + 1; j < withApp.length; j++) {
                minDist = Math.min(minDist, histogramDistance(withApp[i].app, withApp[j].app));
            }
        }
        const k = (minDist - APPEARANCE_DISTINCT_LOW) / (APPEARANCE_DISTINCT_HIGH - APPEARANCE_DISTINCT_LOW);
        return Math.max(0, Math.min(1, k));
    }

    /** Трек у бокового края и движется наружу (или уже за кадром) */
    isExiting(t) {
        const x = t.anchor.x;
        return x < 0 || x > 1 || (x < EDGE_ZONE && t.vx <= 0) || (x > 1 - EDGE_ZONE && t.vx >= 0);
    }

    /** Сколько держим пропавшего игрока: вышел за край — почти не держим, загорожен — дольше */
    holdMsFor(t, matchedAnchors) {
        const { x, scale } = t.anchor;
        if (this.isExiting(t)) return HOLD_EXITED_MS;
        const occluded = matchedAnchors.some(
            (a) => Math.hypot(a.x - x, a.y - t.anchor.y) / Math.max(a.scale, scale) < CROWDED_DIST * 1.2
        );
        return occluded ? HOLD_OCCLUDED_MS : HOLD_MS;
    }
}
