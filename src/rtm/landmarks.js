/**
 * Halpe26 (RTMPose body7-halpe26) → 33 точки в раскладке BlazePose, чтобы вся игра
 * (скелет, маска, «кисти»-клешни, удары ногами) работала без изменений.
 *
 * Halpe26: 0 нос, 1/2 глаза, 3/4 уши, 5/6 плечи, 7/8 локти, 9/10 запястья, 11/12 бёдра,
 * 13/14 колени, 15/16 лодыжки, 17 макушка, 18 шея, 19 таз, 20/21 большие пальцы стоп,
 * 22/23 мизинцы стоп, 24/25 пятки. Везде L — левая сторона человека, как в BlazePose.
 *
 * Пальцев рук у Halpe26 нет — кисть (17..22) достраиваем продолжением предплечья.
 */

/** BlazePose-индекс ← Halpe26-индекс для точек, которые есть напрямую */
const DIRECT = [
    [0, 0],
    [1, 1], [2, 1], [3, 1],
    [4, 2], [5, 2], [6, 2],
    [7, 3], [8, 4],
    [11, 5], [12, 6], [13, 7], [14, 8], [15, 9], [16, 10],
    [23, 11], [24, 12], [25, 13], [26, 14], [27, 15], [28, 16],
    [29, 24], [30, 25], [31, 20], [32, 21]
];

/** Насколько точка может выйти за кадр (в долях), прежде чем считаться невидимой */
const OUTSIDE_MARGIN = 0.01;

/**
 * Уверенность SimCC ≠ вероятность: у видимых точек обычно 0.6–1.0, у загороженных 0.3–0.5.
 * Переводим в visibility BlazePose так, чтобы пороги игры (0.5–0.55) отсекали загороженные.
 */
function scoreToVisibility(s) {
    return Math.max(0, Math.min(1, (s - 0.3) / 0.4));
}

/** Кисть: «ладонь» — продолжение предплечья на 40% его длины, кончики раздвинуты поперёк */
function synthHand(lm, elbow, wrist, pinkyIdx, indexIdx, thumbIdx, aspect) {
    const w = lm[wrist];
    const e = lm[elbow];
    // В пикселях (aspect = W/H), иначе на широком кадре кисть «сплющивается»
    let dx = (w.x - e.x) * aspect;
    let dy = w.y - e.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
        lm[pinkyIdx] = { ...w };
        lm[indexIdx] = { ...w };
        lm[thumbIdx] = { ...w };
        return;
    }
    dx /= len;
    dy /= len;
    const px = -dy;
    const py = dx;
    const at = (along, across) => ({
        x: w.x + ((dx * along + px * across) * len) / aspect,
        y: w.y + (dy * along + py * across) * len,
        z: 0,
        visibility: w.visibility
    });
    lm[indexIdx] = at(0.4, 0.12);
    lm[pinkyIdx] = at(0.4, -0.12);
    lm[thumbIdx] = at(0.22, 0.2);
}

/**
 * @param {Float32Array|number[]} keypoints  [x0,y0,x1,y1,...] в пикселях кадра
 * @param {Float32Array|number[]} scores
 * @param {number} width  ширина кадра, к которому относятся пиксели
 * @param {number} height
 */
export function halpe26ToBlazePose(keypoints, scores, width, height) {
    const lm = new Array(33);
    for (const [b, h] of DIRECT) {
        const x = keypoints[h * 2] / width;
        const y = keypoints[h * 2 + 1] / height;
        /** RTMPose выдаёт все точки всегда — за кадром это догадка, которая «скачет»: гасим её */
        const outside = x < -OUTSIDE_MARGIN || x > 1 + OUTSIDE_MARGIN || y < -OUTSIDE_MARGIN || y > 1 + OUTSIDE_MARGIN;
        lm[b] = { x, y, z: 0, visibility: outside ? 0 : scoreToVisibility(scores[h]) };
    }
    // Уголки рта: чуть ниже носа по оси «глаза → нос»
    const nose = lm[0];
    const eyeMx = (lm[2].x + lm[5].x) / 2;
    const eyeMy = (lm[2].y + lm[5].y) / 2;
    const downX = (nose.x - eyeMx) * 0.6;
    const downY = (nose.y - eyeMy) * 0.6;
    const halfMouthX = (lm[2].x - lm[5].x) * 0.25;
    const halfMouthY = (lm[2].y - lm[5].y) * 0.25;
    lm[9] = { x: nose.x + downX + halfMouthX, y: nose.y + downY + halfMouthY, z: 0, visibility: nose.visibility };
    lm[10] = { x: nose.x + downX - halfMouthX, y: nose.y + downY - halfMouthY, z: 0, visibility: nose.visibility };

    const aspect = width / height;
    synthHand(lm, 13, 15, 17, 19, 21, aspect);
    synthHand(lm, 14, 16, 18, 20, 22, aspect);
    return lm;
}
