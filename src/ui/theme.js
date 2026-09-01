/**
 * Dark mode.
 *
 * Three states, not two: light, dark, and "follow the system". Storing a hard
 * light/dark choice for someone who never expressed one is why apps look wrong
 * at night.
 */
import { state } from '../core/state.js';

const KEY = 'trea:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function currentPreference() {
    try {
        return localStorage.getItem(KEY) ?? 'system';
    } catch {
        return 'system';
    }
}

export function resolvedTheme(pref = currentPreference()) {
    if (pref === 'system') return media.matches ? 'dark' : 'light';
    return pref;
}

export function applyTheme(pref = currentPreference()) {
    const resolved = resolvedTheme(pref);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.style.colorScheme = resolved;
    state.ui.theme = resolved;
    return resolved;
}

export function setPreference(pref) {
    try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
    } catch { /* storage disabled; the choice lasts for this page only */ }
    return applyTheme(pref);
}

/** Cycle light → dark → system, which is the order people expect from a toggle. */
export function cycleTheme() {
    const order = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(currentPreference()) + 1) % order.length];
    setPreference(next);
    return next;
}

export function initTheme() {
    applyTheme();
    media.addEventListener('change', () => {
        if (currentPreference() === 'system') applyTheme('system');
    });
}
