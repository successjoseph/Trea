/**
 * Organisation settings - owner only.
 *
 * Each control says what it costs as well as what it does. A longer correction
 * window means a longer period where the balance on screen is not the whole
 * truth; a lower approval threshold means more friction. Those are governance
 * decisions, so the trade-off belongs next to the input.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt, toMajor } from '../../core/money.js';
import { can } from '../../core/rbac.js';
import { currentPreference } from '../theme.js';
import { DEFAULT_SETTINGS } from '../../features/records.js';
import {
    card, sectionHeader, pageTitle, button, field, input, select, emptyState, badge
} from '../components.js';

export function render() {
    const org = { ...DEFAULT_SETTINGS, ...(state.org ?? {}) };

    if (!can('settings.manage')) {
        return `
            ${pageTitle('Settings')}
            ${card(`${sectionHeader('Organisation')}
                ${emptyState('Only an owner can change organisation settings.')}`)}
            ${appearanceCard()}`;
    }

    const identity = card(`
        ${sectionHeader('Identity', 'How the org is named and how money is displayed.')}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-5">
            ${field('Organisation name', input({ id: 'set-orgname', value: org.orgName }))}
            ${field('Currency symbol', input({ id: 'set-symbol', value: org.currencySymbol }), 'Shown before every amount.')}
            ${field('Currency code', input({ id: 'set-code', value: org.currencyCode }), 'Used in exports, e.g. NGN.')}
            ${field('Locale', input({ id: 'set-locale', value: org.locale }), 'Controls digit grouping, e.g. en-NG.')}
        </div>`);

    const controls = card(`
        ${sectionHeader('Controls', 'The rules that decide when money counts.')}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-5">
            ${field('Correction window (seconds)',
                input({ id: 'set-window', type: 'number', value: String(Math.round((org.correctionWindowMs ?? 30000) / 1000)), attrs: 'min="5" max="300"' }),
                'How long an entry stays correctable and out of the balance. Longer means more time to fix a typo, but a longer period where the displayed balance is incomplete. 5–300 seconds.')}
            ${field('Approval threshold',
                input({ id: 'set-threshold', type: 'number', value: String(toMajor(org.approvalThresholdMinor ?? 0)), attrs: 'min="0" step="0.01"' }),
                'Spending at or above this is held out of the balance until someone other than the person who recorded it approves it. Zero disables holds entirely.')}
            ${field('Idle sign-out (minutes)',
                input({ id: 'set-idle', type: 'number', value: String(Math.round((org.idleTimeoutMs ?? 1800000) / 60000)), attrs: 'min="1" max="240"' }),
                'A warning appears a minute before. 1–240 minutes.')}
            ${field('Seal missed months when the app opens',
                select({
                    id: 'set-backfill',
                    value: org.autoSnapshotOnOpen === false ? 'off' : 'on',
                    options: [{ value: 'on', label: 'Yes (recommended)' }, { value: 'off', label: 'No - only on the next entry' }]
                }),
                'A safety net for an org that goes quiet across a month boundary. It writes nothing when every closed month is already sealed.')}
        </div>
        <div class="mt-2">${button('Save settings', { action: 'settings:save', size: 'lg' })}</div>`);

    const summary = card(`
        ${sectionHeader('Current effect')}
        <ul class="text-sm space-y-2">
            <li>Entries are correctable for <strong>${Math.round((org.correctionWindowMs ?? 30000) / 1000)} seconds</strong>, then immutable.</li>
            <li>${org.approvalThresholdMinor
                ? `Spending of <strong>${escapeHtml(fmt(org.approvalThresholdMinor))}</strong> or more needs a second person to approve it.`
                : 'No approval threshold - every entry publishes on its own.'}</li>
            <li>Signed out after <strong>${Math.round((org.idleTimeoutMs ?? 1800000) / 60000)} minutes</strong> of inactivity.</li>
            <li>${state.snapshots.filter((s) => s.auto !== false).length} month${state.snapshots.filter((s) => s.auto !== false).length === 1 ? '' : 's'} sealed so far.</li>
        </ul>`);

    return `
        ${pageTitle('Settings', state.session?.demo ? 'Demo sandbox - changes stay in this browser.' : 'Organisation-wide, owner only.')}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            ${identity}${controls}${summary}${appearanceCard()}
        </div>`;
}

function appearanceCard() {
    const pref = currentPreference();
    return card(`
        ${sectionHeader('Appearance', 'Stored in this browser only - it is your preference, not the org’s.')}
        <div class="flex flex-wrap gap-2 items-center">
            ${['light', 'dark', 'system'].map((option) => `
                <button data-action="theme:set" data-pref="${option}"
                    class="px-4 py-2 rounded-lg text-sm font-semibold border transition
                        ${pref === option
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700'}">
                    ${option[0].toUpperCase() + option.slice(1)}
                </button>`).join('')}
            ${badge(`Currently ${state.ui.theme}`, 'info')}
        </div>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-3">
            Press <kbd class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700 font-mono text-[11px]">Ctrl</kbd> +
            <kbd class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700 font-mono text-[11px]">K</kbd> anywhere for the command palette.
        </p>`);
}

export const view = { id: 'settings', label: 'Settings', render };
