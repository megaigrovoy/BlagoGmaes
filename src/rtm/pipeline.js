/**
 * Top-down пайплайн: YOLOX (люди) → ByteTrack/OC-SORT (идентичность) → RTMPose (точки на кропах игроков).
 *
 * Модуль не зависит от браузера: картинку режет переданный адаптер `imageOps`,
 * модели запускает переданный `runModel` — так тот же код работает в Web Worker (OffscreenCanvas + ORT Web)
 * и в Node-тестах. Предобработка повторяет rtmlib/mmdeploy (см. pipeline.json моделей):
 * - YOLOX: letterbox в левый верхний угол, фон 114, BGR, без нормализации; NMS внутри ONNX;
 * - RTMPose: центр/масштаб бокса × 1.25, аспект 192:256, RGB, mean/std ImageNet; SimCC split 2.0.
 */
import { ByteTracker, boxIou } from './bytetrack.js';

const POSE_MEAN = [123.675, 116.28, 103.53];
const POSE_STD = [58.395, 57.12, 57.375];
const SIMCC_SPLIT_RATIO = 2;
const BBOX_PADDING = 1.25;
/** Средняя уверенность корпуса, ниже которой поза считается потерянной (нужен детектор) */
const MIN_POSE_QUALITY = 0.45;
const KEYPOINT_BOX_MIN_SCORE = 0.4;
/** Рамки игроков пересекаются — детектор на каждый кадр, иначе поза может «перепрыгнуть» на соседа */
const OVERLAP_FORCE_DETECT_IOU = 0.05;

/** RGBA (ImageData-подобный) → Float32 CHW в BGR 0..255 */
export function rgbaToDetTensor(rgba, size) {
    const plane = size * size;
    const out = new Float32Array(3 * plane);
    const d = rgba.data;
    for (let i = 0; i < plane; i++) {
        out[i] = d[i * 4 + 2];
        out[plane + i] = d[i * 4 + 1];
        out[2 * plane + i] = d[i * 4];
    }
    return out;
}

/** Несколько RGBA-кропов → один батч Float32 [N,3,H,W] в RGB с нормализацией */
export function rgbaCropsToPoseTensor(crops, w, h) {
    const plane = w * h;
    const out = new Float32Array(crops.length * 3 * plane);
    crops.forEach((rgba, n) => {
        const base = n * 3 * plane;
        const d = rgba.data;
        for (let i = 0; i < plane; i++) {
            out[base + i] = (d[i * 4] - POSE_MEAN[0]) / POSE_STD[0];
            out[base + plane + i] = (d[i * 4 + 1] - POSE_MEAN[1]) / POSE_STD[1];
            out[base + 2 * plane + i] = (d[i * 4 + 2] - POSE_MEAN[2]) / POSE_STD[2];
        }
    });
    return out;
}

/** bbox_xyxy2cs(padding=1.25) + приведение к аспекту входа модели (top_down_affine) */
export function bboxToCenterScale(box, inputW, inputH) {
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    let w = (box[2] - box[0]) * BBOX_PADDING;
    let h = (box[3] - box[1]) * BBOX_PADDING;
    const aspect = inputW / inputH;
    if (w > h * aspect) h = w / aspect;
    else w = h * aspect;
    return { cx, cy, w, h };
}

/** SimCC → точки в пикселях кадра + уверенность (среднее максимумов по осям, как rtmlib) */
export function decodeSimcc(simccX, simccY, n, k, inputW, inputH, regions) {
    const wx = simccX.length / (n * k);
    const wy = simccY.length / (n * k);
    const people = [];
    for (let p = 0; p < n; p++) {
        const { cx, cy, w, h } = regions[p];
        const keypoints = new Float32Array(k * 2);
        const scores = new Float32Array(k);
        for (let j = 0; j < k; j++) {
            const ox = (p * k + j) * wx;
            const oy = (p * k + j) * wy;
            let bx = 0;
            let vx = -Infinity;
            for (let i = 0; i < wx; i++) {
                const v = simccX[ox + i];
                if (v > vx) {
                    vx = v;
                    bx = i;
                }
            }
            let by = 0;
            let vy = -Infinity;
            for (let i = 0; i < wy; i++) {
                const v = simccY[oy + i];
                if (v > vy) {
                    vy = v;
                    by = i;
                }
            }
            const score = 0.5 * (vx + vy);
            scores[j] = score;
            keypoints[j * 2] = (bx / SIMCC_SPLIT_RATIO / inputW) * w + cx - w / 2;
            keypoints[j * 2 + 1] = (by / SIMCC_SPLIT_RATIO / inputH) * h + cy - h / 2;
        }
        people.push({ keypoints, scores });
    }
    return people;
}

/**
 * @typedef {object} RtmPipelineOptions
 * @property {(name: 'det'|'pose', data: Float32Array, dims: number[]) => Promise<Record<string, {data: Float32Array, dims: number[]}>>} runModel
 * @property {{ letterbox(size:number): {rgba:{data:Uint8ClampedArray}, ratio:number}, crop(x:number,y:number,w:number,h:number,outW:number,outH:number): {data:Uint8ClampedArray} }} imageOps
 * @property {number} [detSize=416]
 * @property {number} [poseW=192]
 * @property {number} [poseH=256]
 * @property {number} [maxPlayers=2]
 * @property {number} [holdFrames=12]  сколько кадров детектора показываем загороженного игрока по предсказанию
 * @property {number} [minPlayerHeight=0.2]  доля высоты кадра — дальние зрители не занимают слот игрока
 * @property {number} [detEvery=3]  детектор раз в N кадров, когда игроки видны и далеко друг от друга
 */
export class RtmPosePipeline {
    /** @param {RtmPipelineOptions} opts */
    constructor(opts) {
        /** Время чистого инференса за кадр — чтобы отличать модели от подготовки кадра */
        this.runModel = async (...args) => {
            const t = now();
            try {
                return await opts.runModel(...args);
            } finally {
                this.modelMs += now() - t;
            }
        };
        this.modelMs = 0;
        this.detEvery = opts.detEvery ?? 3;
        this.frameIndex = 0;
        this.forceDetect = true;
        this.detSize = opts.detSize ?? 416;
        this.poseW = opts.poseW ?? 192;
        this.poseH = opts.poseH ?? 256;
        this.maxPlayers = opts.maxPlayers ?? 2;
        this.holdFrames = opts.holdFrames ?? 12;
        this.minPlayerHeight = opts.minPlayerHeight ?? 0.2;
        this.tracker = new ByteTracker(opts.tracker);
        /** slot → trackId */
        this.slots = new Array(this.maxPlayers).fill(null);
        /** trackId → { keypoints, scores, box } последней измеренной позы */
        this.lastPose = new Map();
    }

    setMaxPlayers(n) {
        this.maxPlayers = n;
        this.slots = Array.from({ length: n }, (_, i) => this.slots[i] ?? null);
    }

    reset() {
        this.tracker.reset();
        this.slots.fill(null);
        this.lastPose.clear();
        this.frameIndex = 0;
        this.forceDetect = true;
    }

    async detect(imageOps, frameW, frameH) {
        const { rgba, ratio } = imageOps.letterbox(this.detSize);
        const out = await this.runModel('det', rgbaToDetTensor(rgba, this.detSize), [1, 3, this.detSize, this.detSize]);
        const dets = out.dets;
        const n = dets.dims[1];
        const res = [];
        for (let i = 0; i < n; i++) {
            const o = i * 5;
            const score = dets.data[o + 4];
            if (score < this.tracker.lowThresh) continue;
            const box = [
                Math.max(0, dets.data[o] / ratio),
                Math.max(0, dets.data[o + 1] / ratio),
                Math.min(frameW, dets.data[o + 2] / ratio),
                Math.min(frameH, dets.data[o + 3] / ratio)
            ];
            if (box[2] - box[0] < 4 || box[3] - box[1] < 4) continue;
            res.push({ box, score });
        }
        return res;
    }

    /**
     * Слоты игроков держатся за trackId. Свободный слот получает ближайшего (самого крупного) человека.
     * Слот загороженного игрока (его трек потерян) отдаётся новому треку рядом: после пересечения
     * трекер часто не узнаёт вышедшего из-за спины и заводит ему новый id — без передачи слот
     * держал бы «мёртвый» трек до trackBuffer кадров, и второй игрок пропадал на секунды.
     */
    assignSlots(tracks, frameH) {
        const alive = new Map(tracks.map((t) => [t.id, t]));
        for (let s = 0; s < this.slots.length; s++) {
            if (this.slots[s] !== null && !alive.has(this.slots[s])) this.slots[s] = null;
        }
        const taken = new Set(this.slots.filter((id) => id !== null));
        const candidates = tracks
            .filter(
                (t) =>
                    !taken.has(t.id) &&
                    t.isActivated &&
                    t.det &&
                    t.box[3] - t.box[1] >= this.minPlayerHeight * frameH
            )
            .sort((a, b) => (b.box[3] - b.box[1]) - (a.box[3] - a.box[1]));
        if (!candidates.length) return;

        const freeSlots = this.slots.map((id, s) => (id === null ? s : -1)).filter((s) => s >= 0);
        const chosen = candidates.slice(0, freeSlots.length).sort((a, b) => a.box[0] - b.box[0]);
        chosen.forEach((t, i) => {
            this.slots[freeSlots[i]] = t.id;
        });

        for (const c of candidates.slice(chosen.length)) {
            let best = -1;
            let bestDist = Infinity;
            for (let s = 0; s < this.slots.length; s++) {
                const t = alive.get(this.slots[s]);
                if (!t || t.state !== 'lost') continue;
                const d = Math.hypot(
                    (c.box[0] + c.box[2]) / 2 - (t.lastObsBox[0] + t.lastObsBox[2]) / 2,
                    (c.box[1] + c.box[3]) / 2 - (t.lastObsBox[1] + t.lastObsBox[3]) / 2
                );
                if (d < bestDist) {
                    bestDist = d;
                    best = s;
                }
            }
            if (best < 0) break;
            this.lastPose.delete(this.slots[best]);
            this.slots[best] = c.id;
        }
    }

    /**
     * Кадр без детектора: рамка каждого игрока — из его прошлой позы (как tracking-режим MediaPipe).
     * Возвращает рамки для RTMPose или null, если нужен детектор.
     */
    planPoseOnlyFrame(frameW, frameH) {
        if (this.forceDetect || this.frameIndex % this.detEvery === 0) return null;
        const plan = [];
        for (let s = 0; s < this.slots.length; s++) {
            const id = this.slots[s];
            if (id === null) continue;
            const last = this.lastPose.get(id);
            if (!last?.fresh) return null;
            const box = keypointsBox(last.keypoints, last.scores, frameW, frameH);
            if (!box) return null;
            plan.push({ slot: s, trackId: id, box });
        }
        if (!plan.length) return null;
        for (let i = 0; i < plan.length; i++) {
            for (let j = i + 1; j < plan.length; j++) {
                if (boxIou(plan[i].box, plan[j].box) > OVERLAP_FORCE_DETECT_IOU) return null;
            }
        }
        return plan;
    }

    async runPose(imageOps, boxes) {
        const regions = boxes.map((b) => bboxToCenterScale(b, this.poseW, this.poseH));
        const crops = regions.map((r) =>
            imageOps.crop(r.cx - r.w / 2, r.cy - r.h / 2, r.w, r.h, this.poseW, this.poseH)
        );
        const n = crops.length;
        const out = await this.runModel('pose', rgbaCropsToPoseTensor(crops, this.poseW, this.poseH), [
            n,
            3,
            this.poseH,
            this.poseW
        ]);
        const k = out.simcc_x.dims[1];
        return decodeSimcc(out.simcc_x.data, out.simcc_y.data, n, k, this.poseW, this.poseH, regions);
    }

    /**
     * Один кадр. Возвращает игроков: { slot, trackId, predicted, box, keypoints(px), scores }
     * predicted = игрока не видно (загорожен) — точки сдвинуты по Калману от последней позы.
     *
     * Детектор (самая дорогая часть) идёт раз в detEvery кадров и всегда, когда: есть потерянный
     * игрок, игроки сблизились, поза «развалилась». В остальных кадрах — только RTMPose по рамке
     * из прошлой позы; эти рамки подаются в трекер как детекции, так что Калман обновляется каждый кадр.
     */
    async process(imageOps, frameW, frameH) {
        this.modelMs = 0;
        const t0 = now();
        this.frameIndex++;
        const plan = this.planPoseOnlyFrame(frameW, frameH);
        this.forceDetect = false;

        let dets;
        if (plan) {
            const people = await this.runPose(imageOps, plan.map((p) => p.box));
            dets = [];
            for (const pose of people) {
                const box =
                    poseQuality(pose.scores) >= MIN_POSE_QUALITY
                        ? keypointsBox(pose.keypoints, pose.scores, frameW, frameH)
                        : null;
                if (!box) {
                    this.forceDetect = true;
                    continue;
                }
                dets.push({ box, score: 0.9, pose });
            }
        } else {
            dets = await this.detect(imageOps, frameW, frameH);
        }

        const tracks = this.tracker.update(dets);
        this.assignSlots(tracks, frameH);
        const byId = new Map(tracks.map((t) => [t.id, t]));

        /**
         * Новый трек ByteTrack подтверждается только на ВТОРОМ подряд кадре с детекцией, а в кадрах
         * без детектора неподтверждённый трек удаляется. Поэтому, пока есть свободный слот и детектор
         * видит кандидата в игроки, детектор работает каждый кадр — иначе вошедший позже не появится.
         */
        if (this.slots.includes(null)) {
            const slotted = new Set(this.slots);
            if (
                tracks.some(
                    (t) =>
                        !slotted.has(t.id) &&
                        t.det &&
                        t.box[3] - t.box[1] >= this.minPlayerHeight * frameH
                )
            ) {
                this.forceDetect = true;
            }
        }
        for (const v of this.lastPose.values()) v.fresh = false;

        const players = [];
        const needPose = [];
        for (let s = 0; s < this.slots.length; s++) {
            const t = byId.get(this.slots[s]);
            if (!t?.det) continue;
            if (t.det.pose) {
                this.lastPose.set(t.id, { ...t.det.pose, box: t.box, fresh: true });
                players.push({ slot: s, trackId: t.id, predicted: false, box: t.box, ...t.det.pose });
            } else {
                needPose.push({ slot: s, track: t });
            }
        }
        if (needPose.length) {
            const people = await this.runPose(imageOps, needPose.map((m) => m.track.det.box));
            people.forEach((p, i) => {
                const { slot, track } = needPose[i];
                this.lastPose.set(track.id, { ...p, box: track.box, fresh: true });
                players.push({ slot, trackId: track.id, predicted: false, box: track.box, ...p });
            });
        }

        // Загороженные игроки: слот ещё держит трек, но детекции нет — двигаем последнюю позу по Калману
        for (let s = 0; s < this.slots.length; s++) {
            const t = byId.get(this.slots[s]);
            if (!t || t.det) continue;
            this.forceDetect = true;
            if (t.framesLost > this.holdFrames) continue;
            const last = this.lastPose.get(t.id);
            if (!last) continue;
            const dx = (t.box[0] + t.box[2]) / 2 - (last.box[0] + last.box[2]) / 2;
            const dy = (t.box[1] + t.box[3]) / 2 - (last.box[1] + last.box[3]) / 2;
            const keypoints = last.keypoints.map((v, i) => v + (i % 2 ? dy : dx));
            players.push({ slot: s, trackId: t.id, predicted: true, box: t.box, keypoints, scores: last.scores });
        }

        for (const id of [...this.lastPose.keys()]) if (!byId.has(id)) this.lastPose.delete(id);

        players.sort((a, b) => a.slot - b.slot);
        return {
            players,
            detections: dets.length,
            timings: { totalMs: now() - t0, modelMs: this.modelMs, detector: !plan }
        };
    }
}

/** Средняя уверенность по корпусу (плечи, бёдра) — «развалилась» ли поза */
function poseQuality(scores) {
    return (scores[5] + scores[6] + scores[11] + scores[12]) / 4;
}

/** Рамка человека по уверенным точкам (у Halpe26 есть макушка и стопы — рамка близка к детекторной) */
export function keypointsBox(keypoints, scores, frameW, frameH) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let n = 0;
    for (let j = 0; j < scores.length; j++) {
        if (scores[j] < KEYPOINT_BOX_MIN_SCORE) continue;
        const x = keypoints[j * 2];
        const y = keypoints[j * 2 + 1];
        if (x < 0 || y < 0 || x > frameW || y > frameH) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        n++;
    }
    if (n < 6) return null;
    const padX = (x1 - x0) * 0.1;
    const padY = (y1 - y0) * 0.06;
    return [
        Math.max(0, x0 - padX),
        Math.max(0, y0 - padY),
        Math.min(frameW, x1 + padX),
        Math.min(frameH, y1 + padY)
    ];
}

function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
