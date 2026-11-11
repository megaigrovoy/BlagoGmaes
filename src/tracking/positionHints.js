/**
 * Подсказки игроку о положении перед камерой: «отойди назад», «вернись в центр», «встань перед камерой».
 * Модуль только решает, КОГДА и ЧТО подсказать; озвучку и надпись показывает игра.
 *
 * Точки — в раскладке BlazePose, координаты в долях кадра (0…1), за кадром — вне этого диапазона.
 */

/** Ширина плеч в долях ширины кадра, с которой игрок слишком близко (≈ меньше метра до камеры) */
const TOO_CLOSE_SHOULDER_WIDTH = 0.36;
/**
 * Высота корпуса (плечи → бёдра) в долях высоты кадра, с которой игрок слишком близко.
 * Нужна вместе с шириной плеч: вполоборота плечи узкие, а корпус всё равно занимает полкадра.
 */
const TOO_CLOSE_TORSO_HEIGHT = 0.36;
/** Корпус ближе этого к боковому краю — игрок выходит из кадра */
const SIDE_EDGE = 0.07;

/** Условие должно держаться столько, прежде чем подсказка прозвучит (прыжок/взмах её не вызывают) */
const HOLD_MS = { too_close: 1500, out_of_frame: 1500, no_player: 4000 };
/** Пауза перед повтором той же подсказки; с каждым повтором растёт вдвое до REPEAT_MAX_MS */
const REPEAT_MS = 9000;
const REPEAT_MAX_MS = 36000;
/** Минимум между любыми двумя подсказками */
const GLOBAL_GAP_MS = 6000;
/** Условие исчезло на столько — счётчик повторов сбрасывается */
const CLEAR_RESET_MS = 3000;

export const HINT_KINDS = ['too_close', 'out_of_frame', 'no_player'];

/**
 * Что не так с положением одного игрока.
 * @param {Array<{x:number,y:number,visibility?:number}>} lm
 * @param {{ needFeet?: boolean }} [opts] needFeet — режим, где бьют ногами: стопы должны быть в кадре
 * @returns {'too_close' | 'out_of_frame' | null}
 */
export function evaluatePlayerPosition(lm, opts = {}) {
    const ls = lm[11];
    const rs = lm[12];
    if (!ls || !rs) return null;
    const lh = lm[23];
    const rh = lm[24];
    const shoulderW = Math.abs(ls.x - rs.x);
    const shoulderY = (ls.y + rs.y) / 2;
    const hipsBelowFrame = !!lh && !!rh && lh.y > 1.02 && rh.y > 1.02;
    const torsoH = lh && rh ? (lh.y + rh.y) / 2 - shoulderY : 0;
    const headAboveFrame = !!lm[0] && lm[0].y < -0.02 && shoulderY > 0;
    const feetBelowFrame =
        !!opts.needFeet && !!lm[27] && !!lm[28] && lm[27].y > 1.02 && lm[28].y > 1.02 && !hipsBelowFrame;
    if (
        shoulderW > TOO_CLOSE_SHOULDER_WIDTH ||
        torsoH > TOO_CLOSE_TORSO_HEIGHT ||
        hipsBelowFrame ||
        headAboveFrame ||
        feetBelowFrame
    ) {
        return 'too_close';
    }
    const cx = (ls.x + rs.x) / 2;
    if (cx < SIDE_EDGE || cx > 1 - SIDE_EDGE || Math.min(ls.x, rs.x) < 0 || Math.max(ls.x, rs.x) > 1) {
        return 'out_of_frame';
    }
    return null;
}

export class PositionHintScheduler {
    constructor() {
        this.reset();
    }

    reset() {
        /** kind → { sinceMs, lastSeenMs, lastSpokenMs, repeats } */
        this.state = new Map();
        this.lastAnySpokenMs = -Infinity;
        this.noPlayerSinceMs = null;
    }

    /**
     * @param {Array<'too_close'|'out_of_frame'|null>} playerIssues по одному на видимого игрока
     * @param {number} nowMs
     * @returns {{ speak: string|null, show: string|null }}
     *          speak — подсказку пора озвучить; show — подсказка активна (держать надпись на экране)
     */
    update(playerIssues, nowMs) {
        const active = new Set();
        if (playerIssues.length === 0) active.add('no_player');
        for (const issue of playerIssues) if (issue) active.add(issue);

        for (const kind of HINT_KINDS) {
            const s = this.state.get(kind);
            if (active.has(kind)) {
                if (!s || nowMs - s.lastSeenMs > CLEAR_RESET_MS) {
                    this.state.set(kind, { sinceMs: nowMs, lastSeenMs: nowMs, lastSpokenMs: -Infinity, repeats: 0 });
                } else {
                    // Короткий разрыв (кадр без условия) не сбрасывает ни отсчёт, ни счётчик повторов
                    if (nowMs - s.lastSeenMs > 400) s.sinceMs = nowMs;
                    s.lastSeenMs = nowMs;
                }
            }
        }

        // Приоритет: слишком близко → за краем → никого нет
        let show = null;
        let speak = null;
        for (const kind of HINT_KINDS) {
            if (!active.has(kind)) continue;
            const s = this.state.get(kind);
            if (nowMs - s.sinceMs < HOLD_MS[kind]) continue;
            show = kind;
            const repeatGap = Math.min(REPEAT_MAX_MS, REPEAT_MS * 2 ** Math.max(0, s.repeats - 1));
            if (nowMs - s.lastSpokenMs >= repeatGap && nowMs - this.lastAnySpokenMs >= GLOBAL_GAP_MS) {
                speak = kind;
                s.lastSpokenMs = nowMs;
                s.repeats += 1;
                this.lastAnySpokenMs = nowMs;
            }
            break;
        }
        return { speak, show };
    }
}
