/**
 * Command palette and keyboard shortcuts.
 *
 * A treasurer entering thirty rows should never have to reach for the mouse to
 * change screens. Ctrl/Cmd-K opens a fuzzy-matched command list; single letters
 * jump between views when no field has focus.
 */
import { escapeHtml } from '../core/dom.js';
import { can } from '../core/rbac.js';

const commands = [];

export function registerCommand({ id, label, hint, run, perm = null, keys = null }) {
    commands.push({ id, label, hint, run, perm, keys });
}

function available() {
    return commands.filter((c) => !c.perm || can(c.perm));
}

/**
 * Subsequence match, so "adm" finds "Add member" and "rec cr" finds
 * "Record credit". Scored so earlier and tighter matches sort first.
 */
function score(query, text) {
    if (!query) return 1;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (t.includes(q)) return 1000 - t.indexOf(q);

    let qi = 0, points = 0, lastHit = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            points += lastHit === ti - 1 ? 3 : 1;
            lastHit = ti;
            qi++;
        }
    }
    return qi === q.length ? points : 0;
}

let paletteOpen = false;

export function openPalette() {
    if (paletteOpen) return;
    paletteOpen = true;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[120] bg-slate-900/50 backdrop-blur-sm flex items-start justify-center pt-[12vh] p-4';
    overlay.innerHTML = `
        <div class="bg-white dark:bg-slate-800 dark:text-slate-100 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden" role="dialog" aria-modal="true" aria-label="Command palette">
            <input id="palette-input" class="w-full px-4 py-3 text-base outline-none bg-transparent border-b dark:border-slate-700"
                placeholder="Type a command…" autocomplete="off" spellcheck="false">
            <ul id="palette-list" class="max-h-80 overflow-y-auto py-1"></ul>
            <div class="px-4 py-2 text-[11px] text-slate-400 border-t dark:border-slate-700">↑↓ to move · Enter to run · Esc to close</div>
        </div>`;

    const input = overlay.querySelector('#palette-input');
    const list = overlay.querySelector('#palette-list');
    let matches = [];
    let cursor = 0;

    const draw = () => {
        const query = input.value.trim();
        matches = available()
            .map((c) => ({ ...c, score: score(query, c.label + ' ' + (c.hint ?? '')) }))
            .filter((c) => c.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 12);
        cursor = Math.min(cursor, Math.max(0, matches.length - 1));

        list.innerHTML = matches.length === 0
            ? '<li class="px-4 py-6 text-center text-sm text-slate-400">No matching command.</li>'
            : matches.map((c, i) => `
                <li data-index="${i}" class="px-4 py-2 cursor-pointer flex items-center justify-between gap-3 ${i === cursor ? 'bg-blue-50 dark:bg-slate-700' : ''}">
                    <span class="text-sm">${escapeHtml(c.label)}</span>
                    <span class="text-[11px] text-slate-400">${escapeHtml(c.keys ?? c.hint ?? '')}</span>
                </li>`).join('');
    };

    const close = () => {
        paletteOpen = false;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
    };

    const runAt = (index) => {
        const command = matches[index];
        if (!command) return;
        close();
        // Defer so the palette is gone before a dialog opens in its place.
        setTimeout(() => command.run(), 0);
    };

    const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); cursor = (cursor + 1) % Math.max(1, matches.length); draw(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); cursor = (cursor - 1 + matches.length) % Math.max(1, matches.length); draw(); }
        else if (event.key === 'Enter') { event.preventDefault(); runAt(cursor); }
    };

    input.addEventListener('input', () => { cursor = 0; draw(); });
    list.addEventListener('click', (e) => {
        const row = e.target.closest('[data-index]');
        if (row) runAt(Number(row.dataset.index));
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    draw();
    input.focus();
}

function isTyping(target) {
    return target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export function initShortcuts(bindings = {}) {
    document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            openPalette();
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTyping(event.target)) return;

        if (event.key === '?') {
            event.preventDefault();
            openPalette();
            return;
        }
        const handler = bindings[event.key.toLowerCase()];
        if (handler) {
            event.preventDefault();
            handler();
        }
    });
}
