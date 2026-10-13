/**
 * Главный поток ↔ RTM-worker. Кадры отправляются только когда worker свободен
 * (без очереди — иначе задержка растёт), результат забирается игровым циклом через takeResult().
 */
import { halpe26ToBlazePose } from './landmarks.js';

/** Модели лежат в public/models/rtm (см. scripts/fetch-rtm-models.mjs) */
export const RTM_MODELS = {
    det: 'yolox_tiny_8xb8-300e_humanart-6f3252f9.onnx',
    pose: {
        s: 'rtmpose-s_simcc-body7_pt-body7-halpe26_700e-256x192-7f134165_20230605.onnx',
        m: 'rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.onnx'
    }
};

/** Детектору хватает 416 px, кропам позы — с запасом; больший кадр только дороже читать из canvas */
const MAX_FRAME_WIDTH = 960;

export class RtmPoseClient {
    constructor({ maxPlayers = 2, poseModel = 's', baseUrl = import.meta.env.BASE_URL } = {}) {
        this.maxPlayers = maxPlayers;
        this.poseModel = RTM_MODELS.pose[poseModel] ? poseModel : 's';
        this.modelsUrl = new URL(`${baseUrl}models/rtm/`, location.href).href;
        this.worker = null;
        this.busy = false;
        this.latest = null;
        this.backend = '';
        this.lastPlayersSummary = '';
        this.submitMs = 0;
        this.resetStats();
    }

    async init() {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        const ready = new Promise((resolve, reject) => {
            this.worker.onmessage = (ev) => {
                const m = ev.data;
                if (m.type === 'ready') {
                    this.backend = m.backend;
                    this.worker.onmessage = (e) => this.onMessage(e.data);
                    resolve();
                } else if (m.type === 'error') {
                    reject(new Error(m.message));
                }
            };
            this.worker.onerror = (e) => reject(e.error || new Error(e.message || 'RTM worker error'));
        });
        this.worker.postMessage({
            type: 'init',
            detUrl: this.modelsUrl + RTM_MODELS.det,
            poseUrl: this.modelsUrl + RTM_MODELS.pose[this.poseModel],
            maxPlayers: this.maxPlayers
        });
        await ready;
    }

    onMessage(m) {
        if (m.type === 'result') {
            this.busy = false;
            this.latest = m;
            const st = this.stats;
            st.results++;
            st.latencyMs += performance.now() - this.submitMs;
            st.workerMs += m.timings.totalMs;
            st.modelMs += m.timings.modelMs;
            if (m.timings.detector) st.detectorFrames++;
            /** Для ?perf=1: слот → трек (смена trackId у слота = игрок потерял идентичность) */
            this.lastPlayersSummary = m.players
                .map((p) => `P${p.slot}=#${p.trackId}${p.predicted ? '(pred)' : ''}`)
                .join(' ');
        } else if (m.type === 'error') {
            this.busy = false;
            console.warn('[RTM] worker:', m.message);
        }
    }

    /** Отправить кадр, если worker свободен. Возвращает true, если кадр ушёл. */
    submit(video, ts) {
        if (!this.worker || this.busy || !video.videoWidth) return false;
        this.busy = true;
        this.submitMs = performance.now();
        const k = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
        const opts =
            k < 1
                ? { resizeWidth: Math.round(video.videoWidth * k), resizeHeight: Math.round(video.videoHeight * k) }
                : undefined;
        createImageBitmap(video, opts).then(
            (bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]),
            (e) => {
                this.busy = false;
                console.warn('[RTM] createImageBitmap:', e);
            }
        );
        return true;
    }

    /**
     * Новый результат (один раз) в формате игры: [{ key, lm (33 точки BlazePose, норм.), predicted }]
     * или null, если нового результата нет.
     */
    takeResult() {
        const r = this.latest;
        if (!r) return null;
        this.latest = null;
        return r.players.map((p) => ({
            key: `Pose#${p.slot}`,
            lm: halpe26ToBlazePose(p.keypoints, p.scores, r.width, r.height),
            predicted: p.predicted
        }));
    }

    resetStats() {
        this.stats = { sinceMs: performance.now(), results: 0, latencyMs: 0, workerMs: 0, modelMs: 0, detectorFrames: 0 };
    }

    /** Для ?perf=1: средние с прошлого вызова, затем сброс */
    takeStatsLine() {
        const st = this.stats;
        if (!st.results) return null;
        const n = st.results;
        const hz = (n * 1000) / Math.max(1, performance.now() - st.sinceMs);
        const line =
            `${hz.toFixed(1)} поз/с, задержка ${(st.latencyMs / n).toFixed(0)} ms ` +
            `(worker ${(st.workerMs / n).toFixed(0)}, из них модели ${(st.modelMs / n).toFixed(0)}), ` +
            `детектор в ${Math.round((st.detectorFrames / n) * 100)}% кадров; ${this.lastPlayersSummary}`;
        this.resetStats();
        return line;
    }

    setMaxPlayers(n) {
        this.maxPlayers = n;
        this.worker?.postMessage({ type: 'config', maxPlayers: n });
    }

    reset() {
        this.latest = null;
        this.worker?.postMessage({ type: 'reset' });
    }
}
