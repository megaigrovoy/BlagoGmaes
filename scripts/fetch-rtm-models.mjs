/**
 * Скачивает ONNX-модели для RTM-пайплайна (?pose=rtm) в public/models/rtm.
 * Источник — onnx_sdk OpenMMLab (те же файлы, что использует rtmlib), лицензия Apache-2.0.
 *
 *   node scripts/fetch-rtm-models.mjs        # YOLOX-tiny + RTMPose-s (по умолчанию)
 *   node scripts/fetch-rtm-models.mjs m      # дополнительно RTMPose-m (55 МБ, > лимита Cloudflare Pages 25 МБ)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(__dirname, '..', 'public', 'models', 'rtm');
const BASE = 'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/';

const MODELS = {
    det: 'yolox_tiny_8xb8-300e_humanart-6f3252f9',
    s: 'rtmpose-s_simcc-body7_pt-body7-halpe26_700e-256x192-7f134165_20230605',
    m: 'rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605'
};

/** Достаёт файл из zip по центральному каталогу (deflate/store) — без внешних зависимостей */
function extractFromZip(buf, wantedSuffix) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('zip: не найден EOCD');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: битый центральный каталог');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (!name.endsWith(wantedSuffix)) continue;
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`zip: метод сжатия ${method} не поддерживается`);
    }
    throw new Error(`zip: нет файла *${wantedSuffix}`);
}

async function fetchModel(name) {
    const out = path.join(dest, `${name}.onnx`);
    if (fs.existsSync(out)) {
        console.log(`fetch-rtm-models: уже есть ${path.basename(out)}`);
        return;
    }
    const url = `${BASE}${name}.zip`;
    console.log(`fetch-rtm-models: качаю ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(out, extractFromZip(zip, '/end2end.onnx'));
    console.log(`fetch-rtm-models: → public/models/rtm/${path.basename(out)}`);
}

fs.mkdirSync(dest, { recursive: true });
const wanted = ['det', 's', ...(process.argv.includes('m') ? ['m'] : [])];
for (const key of wanted) await fetchModel(MODELS[key]);
