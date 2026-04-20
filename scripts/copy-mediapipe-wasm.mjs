import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = path.join(root, 'public', 'mediapipe-wasm');

if (!fs.existsSync(src)) {
    console.error('copy-mediapipe-wasm: не найдено', src, '— выполните npm install');
    process.exit(1);
}

fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log('copy-mediapipe-wasm: скопировано в public/mediapipe-wasm');
