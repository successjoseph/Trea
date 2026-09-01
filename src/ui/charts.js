/**
 * Charts, hand-rolled as inline SVG.
 *
 * A charting library would add 60–200KB over the network for four chart types.
 * These are a few hundred lines, render as static markup with no runtime, scale
 * with the container, and inherit theme colours from CSS variables - which
 * matters because a canvas-based library would need re-rendering on every
 * dark-mode toggle.
 */
import { escapeHtml } from '../core/dom.js';
import { fmt } from '../core/money.js';
import { monthShortLabel } from '../core/time.js';

const PALETTE = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

function svg(width, height, body, extra = '') {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="w-full h-full" role="img" ${extra}>${body}</svg>`;
}

function niceBounds(values) {
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    if (min === max) return { min: min - 1, max: max + 1 };
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
}

function emptyState(message) {
    return `<div class="h-full w-full flex items-center justify-center text-sm text-slate-400 italic">${escapeHtml(message)}</div>`;
}

/**
 * Line chart of closing balance over time. Sealed months get a solid marker,
 * the live month a hollow one, so it is obvious which figures are final.
 */
export function balanceLineChart(series, { height = 220 } = {}) {
    if (!series || series.length < 2) return emptyState('Two months of activity needed to draw a trend.');

    const W = 720, H = height, padL = 8, padR = 8, padT = 14, padB = 26;
    const values = series.map((p) => p.closingMinor);
    const { min, max } = niceBounds(values);
    const span = max - min || 1;

    const x = (i) => padL + (i * (W - padL - padR)) / (series.length - 1);
    const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);

    const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.closingMinor).toFixed(1)}`).join(' ');
    const area = `${line} L${x(series.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;

    const zeroLine = min < 0 && max > 0
        ? `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="4 4"/>`
        : '';

    const dots = series.map((p, i) => {
        const title = `${monthShortLabel(p.monthKey)}: ${fmt(p.closingMinor)}${p.sealed ? ' (sealed)' : ''}`;
        return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.closingMinor).toFixed(1)}" r="3.5"
            fill="${p.sealed ? '#2563eb' : 'var(--surface,#fff)'}" stroke="#2563eb" stroke-width="2">
            <title>${escapeHtml(title)}</title></circle>`;
    }).join('');

    // Label at most eight ticks so the axis stays readable on a phone.
    const step = Math.max(1, Math.ceil(series.length / 8));
    const labels = series.map((p, i) => (i % step === 0 || i === series.length - 1)
        ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.6">${escapeHtml(monthShortLabel(p.monthKey))}</text>`
        : '').join('');

    return svg(W, H, `
        <defs><linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2563eb" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#balFill)"/>
        ${zeroLine}
        <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}${labels}`, 'aria-label="Closing balance by month" style="overflow:visible"');
}

/** Grouped bars: money in versus money out, per month. */
export function inOutBarChart(series, { height = 220 } = {}) {
    if (!series || series.length === 0) return emptyState('No activity yet.');

    const W = 720, H = height, padT = 14, padB = 26;
    const max = Math.max(1, ...series.map((p) => Math.max(p.inMinor, p.outMinor)));
    const slot = W / series.length;
    const barW = Math.max(3, Math.min(18, slot / 3));
    const y = (v) => padT + (1 - v / max) * (H - padT - padB);
    const base = H - padB;

    const bars = series.map((p, i) => {
        const cx = i * slot + slot / 2;
        const inH = Math.max(1, base - y(p.inMinor));
        const outH = Math.max(1, base - y(p.outMinor));
        return `
            <rect x="${(cx - barW - 1).toFixed(1)}" y="${y(p.inMinor).toFixed(1)}" width="${barW}" height="${inH.toFixed(1)}" rx="2" fill="#059669">
                <title>${escapeHtml(monthShortLabel(p.monthKey))} in: ${escapeHtml(fmt(p.inMinor))}</title></rect>
            <rect x="${(cx + 1).toFixed(1)}" y="${y(p.outMinor).toFixed(1)}" width="${barW}" height="${outH.toFixed(1)}" rx="2" fill="#dc2626">
                <title>${escapeHtml(monthShortLabel(p.monthKey))} out: ${escapeHtml(fmt(p.outMinor))}</title></rect>`;
    }).join('');

    const step = Math.max(1, Math.ceil(series.length / 8));
    const labels = series.map((p, i) => (i % step === 0 || i === series.length - 1)
        ? `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.6">${escapeHtml(monthShortLabel(p.monthKey))}</text>`
        : '').join('');

    return svg(W, H, `<line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="currentColor" stroke-opacity="0.2"/>${bars}${labels}`,
        'aria-label="Money in versus money out by month" style="overflow:visible"');
}

/** Donut of spend by category, with a centred total. */
export function categoryDonut(rows, { size = 200, centreLabel = 'Spend' } = {}) {
    const data = (rows ?? []).filter((r) => r.totalMinor > 0).slice(0, 8);
    if (data.length === 0) return emptyState('No spending recorded for this period.');

    const total = data.reduce((s, r) => s + r.totalMinor, 0);
    const R = size / 2, r = R * 0.62, cx = R, cy = R;
    let angle = -Math.PI / 2;

    const slices = data.map((row, i) => {
        const sweep = (row.totalMinor / total) * Math.PI * 2;
        const end = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const p = (rad, radius) => `${(cx + Math.cos(rad) * radius).toFixed(2)},${(cy + Math.sin(rad) * radius).toFixed(2)}`;
        const d = `M${p(angle, R)} A${R},${R} 0 ${large} 1 ${p(end, R)} L${p(end, r)} A${r},${r} 0 ${large} 0 ${p(angle, r)} Z`;
        angle = end;
        return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}">
            <title>${escapeHtml(row.category)}: ${escapeHtml(fmt(row.totalMinor))} (${((row.totalMinor / total) * 100).toFixed(1)}%)</title></path>`;
    }).join('');

    const chart = `<svg viewBox="0 0 ${size} ${size}" class="w-full max-w-[220px] mx-auto" role="img" aria-label="Spend by category">
        ${slices}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.6">${escapeHtml(centreLabel)}</text>
        <text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">${escapeHtml(fmt(total, { compact: true }))}</text>
    </svg>`;

    const legend = data.map((row, i) => `
        <li class="flex items-center justify-between gap-2 text-xs py-1">
            <span class="flex items-center gap-2 min-w-0">
                <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${PALETTE[i % PALETTE.length]}"></span>
                <span class="truncate">${escapeHtml(row.category)}</span>
            </span>
            <span class="font-semibold tabular-nums shrink-0">${escapeHtml(fmt(row.totalMinor, { compact: true }))}</span>
        </li>`).join('');

    return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">${chart}<ul class="min-w-0">${legend}</ul></div>`;
}

/** Tiny inline trend line for KPI tiles. */
export function sparkline(values, { width = 120, height = 32, color = '#2563eb' } = {}) {
    if (!values || values.length < 2) return '';
    const { min, max } = niceBounds(values);
    const span = max - min || 1;
    const pts = values.map((v, i) => {
        const x = (i * width) / (values.length - 1);
        const y = (1 - (v - min) / span) * (height - 4) + 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" class="w-full h-8" aria-hidden="true">
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

/** Horizontal progress bar used by budgets and goals. */
export function progressBar(ratio, { danger = 1, warn = 0.85 } = {}) {
    const clamped = Math.max(0, Math.min(1.25, ratio || 0));
    const colour = clamped >= danger ? 'bg-rose-500' : clamped >= warn ? 'bg-amber-500' : 'bg-emerald-500';
    return `<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div class="h-full ${colour} transition-all duration-500" style="width:${Math.min(100, clamped * 100).toFixed(1)}%"></div>
    </div>`;
}

export { PALETTE };
