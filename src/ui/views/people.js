/**
 * The roles console - owner-only.
 *
 * Shows the permission matrix as a grid rather than a list of role names,
 * because "what can a trustee actually do?" is the question owners ask, and a
 * role name alone never answers it. Per-person overrides are rendered against
 * the same grid so a granted extra reads as an exception, not a mystery.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmtDateTime } from '../../core/time.js';
import {
    ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, PERMISSIONS,
    basePermissions, effectivePermissions, can, isOwner
} from '../../core/rbac.js';
import {
    card, sectionHeader, pageTitle, button, table, row, badge, emptyState
} from '../components.js';

const ROLE_TONE = { owner: 'danger', admin: 'info', trustee: 'held', viewer: 'neutral' };

function matrixCard() {
    const roles = Object.values(ROLES);
    const header = ['Permission', ...roles.map((r) => ROLE_LABELS[r])];

    const rows = Object.entries(PERMISSIONS).map(([key, label]) => row([
        `<span class="text-sm">${escapeHtml(label)}</span>
         <p class="text-[11px] font-mono text-slate-400">${escapeHtml(key)}</p>`,
        ...roles.map((r) => {
            const has = basePermissions(r).includes(key);
            return `<span class="text-base ${has ? 'text-emerald-600' : 'text-slate-300 dark:text-slate-600'}"
                title="${escapeHtml(ROLE_LABELS[r])} ${has ? 'can' : 'cannot'} ${escapeHtml(label.toLowerCase())}">
                ${has ? '&#10003;' : '&middot;'}</span>`;
        })
    ]));

    const legend = Object.values(ROLES).map((r) => `
        <div class="flex-1 min-w-[12rem]">
            <p class="text-sm font-bold">${badge(ROLE_LABELS[r], ROLE_TONE[r])}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(ROLE_DESCRIPTIONS[r])}</p>
        </div>`).join('');

    return card(`
        ${sectionHeader('What each role can do',
            'This grid is the same matrix enforced in the Firestore security rules. The browser copy is convenience; the server copy is the one that counts.')}
        <div class="flex flex-wrap gap-4 mb-5">${legend}</div>
        ${table({ headers: header, rows })}`);
}

function overrideSummary(person) {
    const extra = (person.grants ?? []).filter((g) => PERMISSIONS[g]);
    const removed = (person.denies ?? []).filter((d) => PERMISSIONS[d]);
    if (extra.length === 0 && removed.length === 0) {
        return '<span class="text-xs text-slate-400">Role defaults</span>';
    }
    return [
        ...extra.map((g) => `<span class="inline-block text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 mr-1 mb-1">+ ${escapeHtml(PERMISSIONS[g])}</span>`),
        ...removed.map((d) => `<span class="inline-block text-[11px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 mr-1 mb-1">− ${escapeHtml(PERMISSIONS[d])}</span>`)
    ].join('');
}

function peopleCard() {
    const people = state.roles.slice().sort((a, b) => {
        const order = { owner: 0, admin: 1, trustee: 2, viewer: 3 };
        return (order[a.role] ?? 9) - (order[b.role] ?? 9)
            || String(a.name ?? a.email).localeCompare(String(b.name ?? b.email));
    });

    if (people.length === 0) {
        return card(`${sectionHeader('People with access')}
            ${emptyState('No role records yet. Anyone signing in resolves through their legacy user record until you add them here.',
                isOwner() ? button('Add the first person', { action: 'people:invite' }) : '')}`);
    }

    const rows = people.map((p) => {
        const email = p.email ?? p.id;
        const self = email === state.session?.email;
        const suspended = p.status === 'suspended';
        const count = effectivePermissions({ ...p, status: p.status }).size;

        return row([
            `<span class="font-medium">${escapeHtml(p.name ?? email)}${self ? ' <span class="text-xs text-slate-400">(you)</span>' : ''}</span>
             <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(email)}</p>`,
            badge(ROLE_LABELS[p.role] ?? p.role, ROLE_TONE[p.role] ?? 'neutral'),
            `<div class="max-w-xs">${overrideSummary(p)}</div>`,
            `<span class="text-xs text-slate-500 dark:text-slate-400">${count} permission${count === 1 ? '' : 's'}</span>`,
            suspended ? badge('Suspended', 'danger') : badge('Active', 'active'),
            `<span class="text-xs text-slate-400">${escapeHtml(p.invitedBy ? 'by ' + p.invitedBy : '')}<br>${escapeHtml(p.createdAtMs ? fmtDateTime(p.createdAtMs) : '')}</span>`,
            self || !isOwner() ? '<span class="text-xs text-slate-400">-</span>' : `
                <div class="flex gap-1 justify-end flex-wrap">
                    ${button('Role', { action: 'people:role', data: { email }, tone: 'ghost', size: 'sm' })}
                    ${button('Permissions', { action: 'people:perms', data: { email }, tone: 'ghost', size: 'sm' })}
                    ${button(suspended ? 'Reinstate' : 'Suspend', { action: 'people:suspend', data: { email, on: suspended ? '0' : '1' }, tone: 'ghost', size: 'sm' })}
                    ${button('Revoke', { action: 'people:revoke', data: { email }, tone: 'danger', size: 'sm' })}
                </div>`
        ], { className: suspended ? 'opacity-60' : '' });
    });

    return card(`
        ${sectionHeader('People with access',
            'Separate from members. Someone here can sign in and act; a member is simply someone whose money is tracked.',
            isOwner() ? button('Grant access', { action: 'people:invite', size: 'sm' }) : '')}
        ${table({ headers: ['Person', 'Role', 'Overrides', 'Effective', 'Status', 'Added', ''], rows })}`);
}

function selfCard() {
    const mine = Array.from(effectivePermissions());
    return card(`
        ${sectionHeader('Your access',
            `Signed in as ${state.session?.email} · ${ROLE_LABELS[state.session?.role] ?? 'unknown role'}`)}
        <div class="flex flex-wrap gap-1.5">
            ${mine.length === 0
                ? '<span class="text-sm text-slate-500 italic">Read-only - you can view but not change anything.</span>'
                : mine.map((p) => `<span class="text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700">${escapeHtml(PERMISSIONS[p] ?? p)}</span>`).join('')}
        </div>`);
}

export function render() {
    if (!can('roles.manage')) {
        return `${pageTitle('Access')}${selfCard()}<div class="mt-6">${matrixCard()}</div>`;
    }
    return `
        ${pageTitle('Access control', 'Who can sign in, and exactly what they may do.')}
        <div class="space-y-6">
            ${peopleCard()}
            ${selfCard()}
            ${matrixCard()}
        </div>`;
}

export const view = { id: 'access', label: 'Access', render };
