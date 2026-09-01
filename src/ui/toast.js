/**
 * Toasts, confirmations and prompts.
 *
 * v1 used `alert()` everywhere, which blocks the event loop, cannot be styled,
 * and on mobile hides the thing the user just did. These are non-blocking and
 * promise-based so call sites read the same as before.
 */
import { escapeHtml } from '../core/dom.js';

let host;

function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]';
    document.body.appendChild(host);
    return host;
}

const TONES = {
    success: 'bg-emerald-600 border-emerald-700',
    error: 'bg-rose-600 border-rose-700',
    warn: 'bg-amber-500 border-amber-600',
    info: 'bg-slate-800 border-slate-900'
};

export function toast(message, tone = 'info', ms = 3600) {
    const node = document.createElement('div');
    node.className = `text-white text-sm px-4 py-3 rounded-lg shadow-lg border-l-4 ${TONES[tone] ?? TONES.info} transition-all duration-200 opacity-0`;
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    node.textContent = message;
    ensureHost().appendChild(node);
    requestAnimationFrame(() => node.classList.remove('opacity-0'));

    const dismiss = () => {
        node.classList.add('opacity-0');
        setTimeout(() => node.remove(), 220);
    };
    node.addEventListener('click', dismiss);
    if (ms) setTimeout(dismiss, ms);
    return dismiss;
}

export const ok = (m) => toast(m, 'success');
export const err = (m) => toast(m, 'error', 6000);
export const warn = (m) => toast(m, 'warn', 5000);
export const info = (m) => toast(m, 'info');

/**
 * Modal confirmation. Resolves to true/false. Destructive actions pass
 * `tone: 'danger'` and, when `typeToConfirm` is set, the user must retype a
 * phrase - used for anything that permanently changes the ledger.
 */
export function confirmDialog({
    title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel',
    tone = 'default', typeToConfirm = null
} = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4';
        const confirmClass = tone === 'danger'
            ? 'bg-rose-600 hover:bg-rose-700'
            : 'bg-blue-600 hover:bg-blue-700';

        const phraseBlock = typeToConfirm
            ? '<label class="block text-xs font-semibold mb-1">Type <span class="font-mono text-rose-600">'
              + escapeHtml(typeToConfirm)
              + '</span> to continue</label><input id="confirm-phrase" class="w-full p-2 border rounded mb-4 dark:bg-slate-900 dark:border-slate-600" autocomplete="off">'
            : '';

        overlay.innerHTML = [
            '<div class="bg-white dark:bg-slate-800 dark:text-slate-100 rounded-xl shadow-2xl max-w-md w-full p-6" role="dialog" aria-modal="true">',
            '<h3 class="text-lg font-bold mb-2">', escapeHtml(title), '</h3>',
            '<div class="text-sm text-slate-600 dark:text-slate-300 mb-4">', escapeHtml(body), '</div>',
            phraseBlock,
            '<div class="flex justify-end gap-2">',
            '<button data-role="cancel" class="px-4 py-2 rounded border dark:border-slate-600">', escapeHtml(cancelLabel), '</button>',
            '<button data-role="confirm" class="px-4 py-2 rounded text-white ', confirmClass, '">', escapeHtml(confirmLabel), '</button>',
            '</div></div>'
        ].join('');

        const close = (value) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close(false);
        };

        const confirmBtn = overlay.querySelector('[data-role="confirm"]');
        const phrase = overlay.querySelector('#confirm-phrase');
        if (phrase) {
            confirmBtn.disabled = true;
            confirmBtn.classList.add('opacity-50');
            phrase.addEventListener('input', () => {
                const matches = phrase.value.trim() === typeToConfirm;
                confirmBtn.disabled = !matches;
                confirmBtn.classList.toggle('opacity-50', !matches);
            });
        }

        overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => close(false));
        confirmBtn.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        (phrase ?? confirmBtn).focus();
    });
}

/** Small form modal. `fields` is [{name,label,type,value,options,required}]. */
export function formDialog({ title, fields = [], submitLabel = 'Save' }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[110] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto';
        const base = 'w-full p-2 border rounded dark:bg-slate-900 dark:border-slate-600';

        const inputs = fields.map((f) => {
            const id = 'fd-' + f.name;
            let control;
            if (f.type === 'select') {
                const opts = (f.options ?? []).map((o) =>
                    '<option value="' + escapeHtml(o.value) + '"'
                    + (String(o.value) === String(f.value) ? ' selected' : '') + '>'
                    + escapeHtml(o.label) + '</option>').join('');
                control = '<select id="' + id + '" class="' + base + '">' + opts + '</select>';
            } else if (f.type === 'textarea') {
                control = '<textarea id="' + id + '" rows="3" class="' + base + '">' + escapeHtml(f.value ?? '') + '</textarea>';
            } else {
                control = '<input id="' + id + '" type="' + escapeHtml(f.type ?? 'text')
                    + '" value="' + escapeHtml(f.value ?? '') + '" class="' + base + '">';
            }
            const hint = f.hint ? '<p class="text-xs text-slate-500 mt-1">' + escapeHtml(f.hint) + '</p>' : '';
            return '<div class="mb-3"><label for="' + id + '" class="block text-xs font-semibold mb-1">'
                + escapeHtml(f.label) + (f.required ? ' *' : '') + '</label>' + control + hint + '</div>';
        }).join('');

        overlay.innerHTML = [
            '<div class="bg-white dark:bg-slate-800 dark:text-slate-100 rounded-xl shadow-2xl max-w-lg w-full p-6 my-8" role="dialog" aria-modal="true">',
            '<h3 class="text-lg font-bold mb-4">', escapeHtml(title), '</h3>',
            '<form id="fd-form">', inputs,
            '<div class="flex justify-end gap-2 mt-4">',
            '<button type="button" data-role="cancel" class="px-4 py-2 rounded border dark:border-slate-600">Cancel</button>',
            '<button type="submit" class="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">', escapeHtml(submitLabel), '</button>',
            '</div></form></div>'
        ].join('');

        const close = (value) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        };
        const onKey = (e) => { if (e.key === 'Escape') close(null); };

        overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => close(null));
        overlay.querySelector('#fd-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const values = {};
            for (const f of fields) values[f.name] = overlay.querySelector('#fd-' + f.name).value.trim();
            const missing = fields.find((f) => f.required && !values[f.name]);
            if (missing) return err(missing.label + ' is required.');
            close(values);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        overlay.querySelector('input,select,textarea')?.focus();
    });
}
