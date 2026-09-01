/**
 * Shared presentational pieces.
 *
 * Every view builds from these so spacing, borders and dark-mode colours are
 * defined once. All of them return escaped HTML strings.
 */
import { escapeHtml } from '../core/dom.js';
import { fmt } from '../core/money.js';
import { relative } from '../core/time.js';
import { sparkline } from './charts.js';
import { STATUS } from '../data/ledger.js';

export const SURFACE = 'bg-white dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700';

export function card(inner, { className = '' } = {}) {
    return `<section class="${SURFACE} rounded-xl shadow-sm p-5 ${className}">${inner}</section>`;
}

export function sectionHeader(title, subtitle = '', actions = '') {
    return `<div class="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
            <h3 class="font-bold text-base">${escapeHtml(title)}</h3>
            ${subtitle ? `<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        ${actions ? `<div class="flex gap-2 flex-wrap">${actions}</div>` : ''}
    </div>`;
}

export function pageTitle(title, subtitle = '', actions = '') {
    return `<div class="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
            <h2 class="text-2xl font-bold tracking-tight">${escapeHtml(title)}</h2>
            ${subtitle ? `<p class="text-sm text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        ${actions ? `<div class="flex gap-2 flex-wrap">${actions}</div>` : ''}
    </div>`;
}

const TILE_ACCENT = {
    blue: 'border-blue-500', green: 'border-emerald-500', red: 'border-rose-500',
    purple: 'border-purple-500', amber: 'border-amber-500', slate: 'border-slate-400'
};

export function statTile({ label, value, hint = '', accent = 'blue', trend = null, id = null }) {
    return `<div class="${SURFACE} rounded-xl shadow-sm p-4 border-l-4 ${TILE_ACCENT[accent] ?? TILE_ACCENT.blue}">
        <p class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">${escapeHtml(label)}</p>
        <h3 class="text-xl font-bold mt-1 tabular-nums"${id ? ` id="${escapeHtml(id)}"` : ''}>${escapeHtml(value)}</h3>
        ${hint ? `<p class="text-xs text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(hint)}</p>` : ''}
        ${trend?.length ? sparkline(trend) : ''}
    </div>`;
}

export function button(label, { action = '', data = {}, tone = 'primary', perm = null, size = 'md', title = '' } = {}) {
    const tones = {
        primary: 'bg-blue-600 hover:bg-blue-700 text-white',
        success: 'bg-emerald-600 hover:bg-emerald-700 text-white',
        danger: 'bg-rose-600 hover:bg-rose-700 text-white',
        neutral: 'bg-slate-600 hover:bg-slate-700 text-white',
        ghost: 'border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700'
    };
    const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
    const attrs = Object.entries(data)
        .map(([k, v]) => ` data-${escapeHtml(k)}="${escapeHtml(v)}"`).join('');
    return `<button data-action="${escapeHtml(action)}"${attrs}${perm ? ` data-perm="${escapeHtml(perm)}"` : ''}
        ${title ? ` title="${escapeHtml(title)}"` : ''}
        class="rounded-lg font-semibold transition ${tones[tone] ?? tones.primary} ${sizes[size] ?? sizes.md}">${escapeHtml(label)}</button>`;
}

const BADGE_TONES = {
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    held: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
    void: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    danger: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
};

export function badge(text, tone = 'neutral') {
    return `<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${BADGE_TONES[tone] ?? BADGE_TONES.neutral}">${escapeHtml(text)}</span>`;
}

export function statusBadge(status) {
    const labels = {
        [STATUS.PENDING]: 'Correctable',
        [STATUS.ACTIVE]: 'Published',
        [STATUS.HELD]: 'Awaiting approval',
        [STATUS.VOID]: 'Void'
    };
    return badge(labels[status] ?? status, status);
}

export function emptyState(message, action = '') {
    return `<div class="text-center py-10 px-4">
        <p class="text-sm text-slate-500 dark:text-slate-400 italic">${escapeHtml(message)}</p>
        ${action ? `<div class="mt-3">${action}</div>` : ''}
    </div>`;
}

export function amountCell(minor, { muted = false } = {}) {
    const tone = muted
        ? 'text-slate-400'
        : minor < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400';
    return `<span class="font-semibold tabular-nums ${tone}">${escapeHtml(fmt(minor, { showSign: true }))}</span>`;
}

export function table({ headers, rows, empty = 'Nothing here yet.' }) {
    if (!rows.length) return emptyState(empty);
    return `<div class="overflow-x-auto -mx-5 px-5">
        <table class="w-full text-left text-sm border-collapse">
            <thead><tr class="border-b border-slate-200 dark:border-slate-700 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                ${headers.map((h) => `<th class="p-2.5 font-semibold whitespace-nowrap">${escapeHtml(h)}</th>`).join('')}
            </tr></thead>
            <tbody>${rows.join('')}</tbody>
        </table>
    </div>`;
}

export function row(cells, { className = '' } = {}) {
    return `<tr class="border-b border-slate-100 dark:border-slate-700/60 ${className}">
        ${cells.map((c) => `<td class="p-2.5 align-top">${c}</td>`).join('')}
    </tr>`;
}

export function relativeTime(ms) {
    return `<span title="${escapeHtml(ms ? new Date(ms).toLocaleString() : '')}">${escapeHtml(relative(ms))}</span>`;
}

export function field(label, control, hint = '') {
    return `<label class="block mb-3">
        <span class="block text-xs font-semibold mb-1 text-slate-600 dark:text-slate-300">${escapeHtml(label)}</span>
        ${control}
        ${hint ? `<span class="block text-xs text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(hint)}</span>` : ''}
    </label>`;
}

export const INPUT_CLASS = 'w-full p-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500';

export function input({ id, type = 'text', placeholder = '', value = '', attrs = '' }) {
    return `<input id="${escapeHtml(id)}" type="${escapeHtml(type)}" placeholder="${escapeHtml(placeholder)}"
        value="${escapeHtml(value)}" class="${INPUT_CLASS}" ${attrs}>`;
}

export function select({ id, options, value = '', attrs = '' }) {
    return `<select id="${escapeHtml(id)}" class="${INPUT_CLASS}" ${attrs}>
        ${options.map((o) => `<option value="${escapeHtml(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
    </select>`;
}

export { fmt, escapeHtml };
