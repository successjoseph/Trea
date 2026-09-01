/**
 * DOM helpers.
 *
 * The v1 code built rows with `innerHTML +=` and raw interpolation, which meant
 * a member named `<img onerror=...>` executed script in every admin's browser.
 * Everything here either escapes or builds real nodes; `html` is a tagged
 * template that escapes interpolations by default.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Marks a string as already-safe markup so `html` will not re-escape it. */
export class SafeHtml {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
}
export const raw = (value) => new SafeHtml(value);

/**
 * Tagged template that escapes every interpolation unless it is `raw(...)` or
 * an array of SafeHtml (so nested templates compose).
 */
export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        out += render(values[i]) + strings[i + 1];
    }
    return new SafeHtml(out);
}

function render(value) {
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(render).join('');
    if (value === null || value === undefined || value === false) return '';
    return escapeHtml(value);
}

/** Replace an element's contents with rendered template output. */
export function mount(target, content) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return null;
    el.innerHTML = content instanceof SafeHtml ? content.value : escapeHtml(content);
    return el;
}

export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export function show(target, visible = true) {
    const node = typeof target === 'string' ? $(target) : target;
    if (node) node.classList.toggle('hidden', !visible);
}

/**
 * Event delegation. Feature modules register `[data-action]` handlers instead of
 * attaching per-row listeners, which keeps large tables cheap to re-render and
 * removes the last reason to put `onclick="..."` in generated markup.
 */
const actionHandlers = new Map();

export function onAction(name, handler) {
    actionHandlers.set(name, handler);
}

export function initActionDelegation(root = document.body) {
    root.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-action]');
        if (!trigger || !root.contains(trigger)) return;
        const handler = actionHandlers.get(trigger.dataset.action);
        if (!handler) return;
        event.preventDefault();
        handler(trigger.dataset, trigger, event);
    });
}

/** Debounce, for search inputs and window resize driven chart redraws. */
export function debounce(fn, ms = 180) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}
