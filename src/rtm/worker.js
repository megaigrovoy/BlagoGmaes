/**
 * Web Worker: YOLOX + ByteTrack/OC-SORT + RTMPose на ONNX Runtime Web.
 * Всё тяжёлое (нарезка кадра, инференс, трекинг) — вне главного потока, чтобы не ронять FPS игры.
 *
 * Протокол:
 *   → { type:'init', detUrl, poseUrl, detSize, maxPlayers }   ← { type:'ready', backend } | { type:'error', message }
 *   → { type:'frame', bitmap, ts }                            ← { type:'result', ts, width, height, players, timings }
 *   → { type:'config', maxPlayers } / { type:'reset' }
 */
import * as ort from 'onnxruntime-web/webgpu';
import { RtmPosePipeline } from './pipeline.js';

/**
 * wasm-рантайм ORT (26–28 МБ) берём с jsDelivr той же версии: Cloudflare Pages не принимает файлы > 25 МБ.
 * Без COOP/COEP потоков нет — ORT сам откатится на 1 поток; основной счёт всё равно на WebGPU.
 */
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;

let pipeline = null;
let sessions = null;
let backend = 'wasm';

const detCanvas = new OffscreenCanvas(1, 1);
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
const cropCanvas = new OffscreenCanvas(1, 1);
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

function makeImageOps(bitmap) {
    const W = bitmap.width;
    const H = bitmap.height;
    return {
        letterbox(size) {
            if (detCanvas.width !== size) {
                detCanvas.width = size;
                detCanvas.height = size;
            }
            const ratio = Math.min(size / H, size / W);
            detCtx.fillStyle = 'rgb(114,114,114)';
            detCtx.fillRect(0, 0, size, size);
            detCtx.drawImage(bitmap, 0, 0, Math.floor(W * ratio), Math.floor(H * ratio));
            return { rgba: detCtx.getImageData(0, 0, size, size), ratio };
        },
        /** Аффинный кроп без поворота: [x, x+w]×[y, y+h] → outW×outH, вне кадра — чёрный (как warpAffine) */
        crop(x, y, w, h, outW, outH) {
            if (cropCanvas.width !== outW || cropCanvas.height !== outH) {
                cropCanvas.width = outW;
                cropCanvas.height = outH;
            }
            cropCtx.fillStyle = '#000';
            cropCtx.fillRect(0, 0, outW, outH);
            // Обрезаем исходный прямоугольник по кадру вручную и пропорционально сдвигаем приёмник
            const sx0 = Math.max(0, x);
            const sy0 = Math.max(0, y);
            const sx1 = Math.min(W, x + w);
            const sy1 = Math.min(H, y + h);
            if (sx1 > sx0 && sy1 > sy0) {
                const kx = outW / w;
                const ky = outH / h;
                cropCtx.drawImage(
                    bitmap,
                    sx0,
                    sy0,
                    sx1 - sx0,
                    sy1 - sy0,
                    (sx0 - x) * kx,
                    (sy0 - y) * ky,
                    (sx1 - sx0) * kx,
                    (sy1 - sy0) * ky
                );
            }
            return cropCtx.getImageData(0, 0, outW, outH);
        }
    };
}

async function createSession(url) {
    const providers = typeof navigator !== 'undefined' && navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    for (const ep of providers) {
        try {
            const s = await ort.InferenceSession.create(url, {
                executionProviders: [ep],
                graphOptimizationLevel: 'all'
            });
            return { session: s, ep };
        } catch (e) {
            console.warn(`[rtm-worker] ${ep} не поднялся для ${url}:`, e);
        }
    }
    throw new Error(`Не удалось загрузить модель ${url}`);
}

async function runModel(name, data, dims) {
    const s = sessions[name];
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    const res = {};
    for (const k of Object.keys(out)) res[k] = { data: out[k].data, dims: out[k].dims };
    return res;
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            const det = await createSession(msg.detUrl);
            const pose = await createSession(msg.poseUrl);
            sessions = { det: det.session, pose: pose.session };
            backend = `det:${det.ep} pose:${pose.ep}`;
            pipeline = new RtmPosePipeline({
                runModel,
                detSize: msg.detSize ?? 416,
                maxPlayers: msg.maxPlayers ?? 2
            });
            self.postMessage({ type: 'ready', backend });
        } else if (msg.type === 'frame') {
            const bitmap = msg.bitmap;
            try {
                const res = await pipeline.process(makeImageOps(bitmap), bitmap.width, bitmap.height);
                self.postMessage({
                    type: 'result',
                    ts: msg.ts,
                    width: bitmap.width,
                    height: bitmap.height,
                    players: res.players,
                    detections: res.detections,
                    timings: res.timings
                });
            } finally {
                bitmap.close();
            }
        } else if (msg.type === 'config') {
            pipeline?.setMaxPlayers(msg.maxPlayers);
        } else if (msg.type === 'reset') {
            pipeline?.reset();
        }
    } catch (e) {
        self.postMessage({ type: 'error', message: String(e?.message || e), during: msg.type });
    }
};
