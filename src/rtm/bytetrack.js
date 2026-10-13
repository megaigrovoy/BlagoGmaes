/**
 * ByteTrack (Zhang et al., 2022) + наблюдение-центричное восстановление из OC-SORT (Cao et al., 2023).
 *
 * - Kalman в пространстве (cx, cy, aspect, h) как в оригинальном ByteTrack.
 * - Два этапа сопоставления: сначала уверенные детекции, затем слабые (0.1..trackThresh) —
 *   слабые как раз и дают частично загороженные люди.
 * - OCR (OC-SORT): потерянный трек дополнительно сравнивается по ПОСЛЕДНЕМУ НАБЛЮДЕНИЮ,
 *   а не по уплывшему предсказанию Калмана.
 * - ORU (OC-SORT): при возвращении трека после перерыва фильтр «перематывается»
 *   по виртуальной траектории между последним и новым наблюдением — скорость не копит ошибку.
 *
 * Время измеряется в кадрах детектора (frameId).
 */

const STD_WEIGHT_POSITION = 1 / 20;
const STD_WEIGHT_VELOCITY = 1 / 160;

// ---------- маленькая линейная алгебра (матрицы — массивы строк) ----------

function matMul(a, b) {
    const n = a.length;
    const m = b[0].length;
    const k = b.length;
    const out = [];
    for (let i = 0; i < n; i++) {
        const row = new Array(m).fill(0);
        for (let t = 0; t < k; t++) {
            const v = a[i][t];
            if (v === 0) continue;
            for (let j = 0; j < m; j++) row[j] += v * b[t][j];
        }
        out.push(row);
    }
    return out;
}

function transpose(a) {
    return a[0].map((_, j) => a.map((row) => row[j]));
}

function matAdd(a, b, sign = 1) {
    return a.map((row, i) => row.map((v, j) => v + sign * b[i][j]));
}

function diag(values) {
    return values.map((v, i) => values.map((_, j) => (i === j ? v : 0)));
}

function invert(m) {
    const n = m.length;
    const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
        [a[c], a[p]] = [a[p], a[c]];
        const pv = a[c][c] || 1e-12;
        for (let j = 0; j < 2 * n; j++) a[c][j] /= pv;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = a[r][c];
            if (f === 0) continue;
            for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
        }
    }
    return a.map((row) => row.slice(n));
}

const F = (() => {
    const f = diag([1, 1, 1, 1, 1, 1, 1, 1]);
    for (let i = 0; i < 4; i++) f[i][i + 4] = 1;
    return f;
})();
const FT = transpose(F);
const H = diag([1, 1, 1, 1, 1, 1, 1, 1]).slice(0, 4);
const HT = transpose(H);

export const kalman = {
    initiate(z) {
        const h = z[3];
        const std = [
            2 * STD_WEIGHT_POSITION * h,
            2 * STD_WEIGHT_POSITION * h,
            1e-2,
            2 * STD_WEIGHT_POSITION * h,
            10 * STD_WEIGHT_VELOCITY * h,
            10 * STD_WEIGHT_VELOCITY * h,
            1e-5,
            10 * STD_WEIGHT_VELOCITY * h
        ];
        return { mean: [...z, 0, 0, 0, 0], cov: diag(std.map((s) => s * s)) };
    },
    predict({ mean, cov }) {
        const h = mean[3];
        const std = [
            STD_WEIGHT_POSITION * h,
            STD_WEIGHT_POSITION * h,
            1e-2,
            STD_WEIGHT_POSITION * h,
            STD_WEIGHT_VELOCITY * h,
            STD_WEIGHT_VELOCITY * h,
            1e-5,
            STD_WEIGHT_VELOCITY * h
        ];
        const m = mean.slice();
        for (let i = 0; i < 4; i++) m[i] += mean[i + 4];
        const c = matAdd(matMul(matMul(F, cov), FT), diag(std.map((s) => s * s)));
        return { mean: m, cov: c };
    },
    update({ mean, cov }, z) {
        const h = mean[3];
        const std = [STD_WEIGHT_POSITION * h, STD_WEIGHT_POSITION * h, 1e-1, STD_WEIGHT_POSITION * h];
        const PHt = matMul(cov, HT);
        const S = matAdd(matMul(H, PHt), diag(std.map((s) => s * s)));
        const K = matMul(PHt, invert(S));
        const y = z.map((v, i) => v - mean[i]);
        const m = mean.map((v, i) => v + K[i].reduce((acc, k, j) => acc + k * y[j], 0));
        const c = matAdd(cov, matMul(matMul(K, S), transpose(K)), -1);
        return { mean: m, cov: c };
    }
};

// ---------- боксы ----------

function xyxyToXyah([x1, y1, x2, y2]) {
    const w = x2 - x1;
    const h = Math.max(1e-6, y2 - y1);
    return [x1 + w / 2, y1 + h / 2, w / h, h];
}

function xyahToXyxy([cx, cy, a, h]) {
    const w = a * h;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

export function boxIou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return ua > 0 ? inter / ua : 0;
}

// ---------- назначение ----------

/**
 * Минимальное по сумме назначение строк к столбцам; пары с cost > thresh запрещены.
 * m — число столбцов (нужно явно: при n = 0 из матрицы его не узнать).
 * Людей в кадре единицы — точный перебор с отсечением; при большом числе — жадно.
 */
export function linearAssignment(cost, thresh, m) {
    const n = cost.length;
    const matches = [];
    if (!n || !m) {
        return { matches, unmatchedA: [...Array(n).keys()], unmatchedB: [...Array(m).keys()] };
    }
    let bestPairs = [];
    if (n <= 6 && m <= 6) {
        // Сначала максимум пар, затем минимальная стоимость
        let bestCount = -1;
        let bestCost = Infinity;
        const used = new Array(m).fill(false);
        const cur = [];
        const rec = (i, acc) => {
            if (i === n) {
                if (cur.length > bestCount || (cur.length === bestCount && acc < bestCost)) {
                    bestCount = cur.length;
                    bestCost = acc;
                    bestPairs = cur.slice();
                }
                return;
            }
            if (cur.length + (n - i) < bestCount) return;
            for (let j = 0; j < m; j++) {
                if (used[j] || cost[i][j] > thresh) continue;
                used[j] = true;
                cur.push([i, j]);
                rec(i + 1, acc + cost[i][j]);
                cur.pop();
                used[j] = false;
            }
            rec(i + 1, acc);
        };
        rec(0, 0);
    } else {
        const cells = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if (cost[i][j] <= thresh) cells.push([cost[i][j], i, j]);
        cells.sort((a, b) => a[0] - b[0]);
        const ua = new Set();
        const ub = new Set();
        for (const [, i, j] of cells) {
            if (ua.has(i) || ub.has(j)) continue;
            ua.add(i);
            ub.add(j);
            bestPairs.push([i, j]);
        }
    }
    const ma = new Set(bestPairs.map((p) => p[0]));
    const mb = new Set(bestPairs.map((p) => p[1]));
    return {
        matches: bestPairs,
        unmatchedA: [...Array(n).keys()].filter((i) => !ma.has(i)),
        unmatchedB: [...Array(m).keys()].filter((j) => !mb.has(j))
    };
}

function iouDistance(tracks, dets, useLastObservation = false) {
    return tracks.map((t) => {
        const tb = useLastObservation ? t.lastObs.box : t.box;
        return dets.map((d) => 1 - boxIou(tb, d.box));
    });
}

/** ByteTrack fuse_score: уверенность детекции снижает «стоимость» */
function fuseScore(cost, dets) {
    return cost.map((row) => row.map((c, j) => 1 - (1 - c) * dets[j].score));
}

// ---------- трек ----------

const STATE_TRACKED = 'tracked';
const STATE_LOST = 'lost';
const STATE_REMOVED = 'removed';

class STrack {
    constructor(det, frameId, id, activated) {
        this.id = id;
        this.kf = kalman.initiate(xyxyToXyah(det.box));
        this.score = det.score;
        this.det = det;
        this.state = STATE_TRACKED;
        this.isActivated = activated;
        this.startFrame = frameId;
        this.frameId = frameId;
        this.lastObs = { box: det.box.slice(), frameId, kf: this.kf };
    }

    get box() {
        return xyahToXyxy(this.kf.mean.slice(0, 4));
    }

    predict() {
        const kf = { mean: this.kf.mean.slice(), cov: this.kf.cov };
        // Потерянному треку не даём «расти» по высоте/аспекту — как в ByteTrack
        if (this.state !== STATE_TRACKED) kf.mean[7] = 0;
        this.kf = kalman.predict(kf);
    }

    update(det, frameId) {
        const gap = frameId - this.lastObs.frameId;
        if (this.state !== STATE_TRACKED && gap > 1) {
            this.kf = observationCentricReUpdate(this.lastObs, det.box, gap);
        } else {
            this.kf = kalman.update(this.kf, xyxyToXyah(det.box));
        }
        this.state = STATE_TRACKED;
        this.isActivated = true;
        this.score = det.score;
        this.det = det;
        this.frameId = frameId;
        this.lastObs = { box: det.box.slice(), frameId, kf: this.kf };
    }
}

/** ORU из OC-SORT: перематываем фильтр от последнего наблюдения по линейной виртуальной траектории */
function observationCentricReUpdate(lastObs, newBox, gap) {
    const z0 = xyxyToXyah(lastObs.box);
    const z1 = xyxyToXyah(newBox);
    let kf = lastObs.kf;
    for (let s = 1; s <= gap; s++) {
        const t = s / gap;
        kf = kalman.predict(kf);
        kf = kalman.update(kf, z0.map((v, i) => v + (z1[i] - v) * t));
    }
    return kf;
}

export class ByteTracker {
    /**
     * @param {object} opts
     * @param {number} [opts.trackThresh=0.5]  уверенные детекции
     * @param {number} [opts.lowThresh=0.1]    нижняя граница «слабых» детекций
     * @param {number} [opts.newTrackThresh=0.6]
     * @param {number} [opts.matchThresh=0.8]  IoU-дистанция первого этапа
     * @param {number} [opts.ocrThresh=0.7]    IoU-дистанция OCR по последнему наблюдению
     * @param {number} [opts.trackBuffer=45]   сколько кадров держим потерянный трек
     */
    constructor(opts = {}) {
        this.trackThresh = opts.trackThresh ?? 0.5;
        this.lowThresh = opts.lowThresh ?? 0.1;
        this.newTrackThresh = opts.newTrackThresh ?? this.trackThresh + 0.1;
        this.matchThresh = opts.matchThresh ?? 0.8;
        this.ocrThresh = opts.ocrThresh ?? 0.7;
        this.trackBuffer = opts.trackBuffer ?? 45;
        this.reset();
    }

    reset() {
        this.frameId = 0;
        this.nextId = 1;
        this.tracked = [];
        this.lost = [];
    }

    /** @param {{box:number[], score:number}[]} dets  box = [x1,y1,x2,y2] в пикселях кадра */
    update(dets) {
        this.frameId++;
        const frameId = this.frameId;
        const high = dets.filter((d) => d.score >= this.trackThresh);
        const low = dets.filter((d) => d.score >= this.lowThresh && d.score < this.trackThresh);

        const unconfirmed = this.tracked.filter((t) => !t.isActivated);
        const confirmed = this.tracked.filter((t) => t.isActivated);
        const pool = [...confirmed, ...this.lost];
        for (const t of pool) t.predict();

        const activated = [];
        const lostNow = [];

        // 1) уверенные детекции ↔ все активные и потерянные треки
        const a1 = linearAssignment(fuseScore(iouDistance(pool, high), high), this.matchThresh, high.length);
        for (const [ti, di] of a1.matches) {
            pool[ti].update(high[di], frameId);
            activated.push(pool[ti]);
        }
        let remainHigh = a1.unmatchedB.map((j) => high[j]);
        const remainPool = a1.unmatchedA.map((i) => pool[i]);

        // 2) слабые детекции ↔ оставшиеся сопровождаемые треки (частичные перекрытия)
        const rTracked = remainPool.filter((t) => t.state === STATE_TRACKED);
        const a2 = linearAssignment(iouDistance(rTracked, low), 0.5, low.length);
        for (const [ti, di] of a2.matches) {
            rTracked[ti].update(low[di], frameId);
            activated.push(rTracked[ti]);
        }
        const leftover = [
            ...a2.unmatchedA.map((i) => rTracked[i]),
            ...remainPool.filter((t) => t.state !== STATE_TRACKED)
        ];

        // 3) OC-SORT OCR: по последнему наблюдению, а не по уплывшему предсказанию
        const a3 = linearAssignment(iouDistance(leftover, remainHigh, true), this.ocrThresh, remainHigh.length);
        for (const [ti, di] of a3.matches) {
            leftover[ti].update(remainHigh[di], frameId);
            activated.push(leftover[ti]);
        }
        remainHigh = a3.unmatchedB.map((j) => remainHigh[j]);

        // 3b) игрок «выныривает» из-за спины: слабая детекция у последнего наблюдения потерянного трека
        const stillLeft = a3.unmatchedA.map((i) => leftover[i]);
        const remainLow = a2.unmatchedB.map((j) => low[j]);
        const a3b = linearAssignment(iouDistance(stillLeft, remainLow, true), 0.5, remainLow.length);
        for (const [ti, di] of a3b.matches) {
            stillLeft[ti].update(remainLow[di], frameId);
            activated.push(stillLeft[ti]);
        }
        for (const i of a3b.unmatchedA) {
            const t = stillLeft[i];
            if (t.state === STATE_TRACKED) t.state = STATE_LOST;
            lostNow.push(t);
        }

        // 4) неподтверждённые (родились на прошлом кадре) ↔ остаток уверенных
        const a4 = linearAssignment(fuseScore(iouDistance(unconfirmed, remainHigh), remainHigh), 0.7, remainHigh.length);
        for (const [ti, di] of a4.matches) {
            unconfirmed[ti].update(remainHigh[di], frameId);
            activated.push(unconfirmed[ti]);
        }
        for (const i of a4.unmatchedA) unconfirmed[i].state = STATE_REMOVED;
        remainHigh = a4.unmatchedB.map((j) => remainHigh[j]);

        // 5) новые треки
        for (const d of remainHigh) {
            if (d.score < this.newTrackThresh) continue;
            activated.push(new STrack(d, frameId, this.nextId++, frameId === 1));
        }

        this.tracked = activated;
        this.lost = lostNow.filter((t) => frameId - t.frameId <= this.trackBuffer);
        for (const t of lostNow) if (frameId - t.frameId > this.trackBuffer) t.state = STATE_REMOVED;
        // remove_duplicate_stracks из ByteTrack намеренно НЕ делаем: полностью загороженный игрок
        // как раз и есть «потерянный трек под активным» — его нельзя удалять.
        return this.tracks();
    }

    /** Все живые треки: { id, box, score, state, isActivated, framesLost, det } */
    tracks() {
        const out = [];
        for (const t of [...this.tracked, ...this.lost]) {
            out.push({
                id: t.id,
                box: t.box,
                score: t.score,
                state: t.state,
                isActivated: t.isActivated,
                framesLost: this.frameId - t.frameId,
                det: t.state === STATE_TRACKED && t.frameId === this.frameId ? t.det : null,
                lastObsBox: t.lastObs.box
            });
        }
        return out;
    }
}
