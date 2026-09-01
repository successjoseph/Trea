/**
 * Planning: budgets, savings goals and recurring entries.
 *
 * Grouped together because they answer the same question from three angles -
 * what should we not exceed, what are we saving towards, and what happens every
 * month whether or not anyone remembers.
 */
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/dom.js';
import { fmt } from '../../core/money.js';
import { monthLabel, monthKey } from '../../core/time.js';
import { can } from '../../core/rbac.js';
import { budgetUtilisation, goalProgress } from '../../features/analytics.js';
import { dueRecurring } from '../../features/records.js';
import { progressBar } from '../charts.js';
import {
    card, sectionHeader, pageTitle, button, table, row, badge, emptyState
} from '../components.js';

function budgetsCard() {
    const budgets = budgetUtilisation();
    const rows = budgets.map((b) => row([
        `<span class="font-medium">${escapeHtml(b.category)}</span>`,
        `<div class="min-w-[8rem]">
            ${progressBar(b.ratio)}
            <p class="text-xs mt-1 tabular-nums ${b.breached ? 'text-rose-600 font-semibold' : 'text-slate-500 dark:text-slate-400'}">
                ${escapeHtml(fmt(b.spentMinor))} of ${escapeHtml(fmt(b.limitMinor))} · ${Math.round(b.ratio * 100)}%
            </p>
        </div>`,
        b.breached
            ? badge(`Over by ${fmt(-b.remainingMinor)}`, 'danger')
            : badge(`${fmt(b.remainingMinor)} left`, b.ratio >= 0.85 ? 'pending' : 'active'),
        `<div class="flex gap-1 justify-end">
            ${can('budget.manage') ? button('Edit', { action: 'budget:edit', data: { id: b.id }, tone: 'ghost', size: 'sm' }) : ''}
            ${can('budget.manage') ? button('Delete', { action: 'budget:delete', data: { id: b.id }, tone: 'danger', size: 'sm' }) : ''}
        </div>`
    ]));

    return card(`
        ${sectionHeader(`Budgets · ${monthLabel(monthKey())}`,
            'Compared against this month’s published spending in each category.',
            can('budget.manage') ? button('New budget', { action: 'budget:new', size: 'sm' }) : '')}
        ${rows.length === 0
            ? emptyState('No budgets yet. A budget turns overspending into a warning instead of a surprise.')
            : table({ headers: ['Category', 'Used', 'Remaining', ''], rows })}`);
}

function goalsCard() {
    const goals = goalProgress();
    const rows = goals.map((g) => {
        const overdue = g.daysLeft !== null && g.daysLeft < 0 && g.ratio < 1;
        return row([
            `<span class="font-medium">${escapeHtml(g.name)}</span>
             ${g.note ? `<p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(g.note)}</p>` : ''}`,
            `<div class="min-w-[8rem]">
                ${progressBar(Math.min(1, g.ratio), { warn: 2, danger: 3 })}
                <p class="text-xs mt-1 tabular-nums text-slate-500 dark:text-slate-400">
                    ${Math.round(g.ratio * 100)}% of ${escapeHtml(fmt(g.targetMinor))}
                </p>
            </div>`,
            g.ratio >= 1
                ? badge('Funded', 'active')
                : badge(`${fmt(g.shortfall)} short`, overdue ? 'danger' : 'pending'),
            `<span class="text-xs text-slate-500 dark:text-slate-400">
                ${g.deadline ? escapeHtml(g.deadline) : 'No deadline'}
                ${g.daysLeft !== null ? `<br>${g.daysLeft >= 0 ? `${g.daysLeft} days left` : `${Math.abs(g.daysLeft)} days overdue`}` : ''}
                ${g.ratio < 1 && g.daysLeft > 0 ? `<br>${escapeHtml(fmt(g.monthlyNeededMinor))}/month needed` : ''}
             </span>`,
            `<div class="flex gap-1 justify-end">
                ${can('goal.manage') ? button('Edit', { action: 'goal:edit', data: { id: g.id }, tone: 'ghost', size: 'sm' }) : ''}
                ${can('goal.manage') ? button('Archive', { action: 'goal:archive', data: { id: g.id }, tone: 'danger', size: 'sm' }) : ''}
            </div>`
        ]);
    });

    return card(`
        ${sectionHeader('Savings goals',
            'Progress is measured against the current total balance.',
            can('goal.manage') ? button('New goal', { action: 'goal:new', size: 'sm' }) : '')}
        ${rows.length === 0
            ? emptyState('No goals set.')
            : table({ headers: ['Goal', 'Progress', 'Status', 'Deadline', ''], rows })}`);
}

function recurringCard() {
    const due = new Set(dueRecurring().map((r) => r.id));
    const rows = state.recurring.map((r) => row([
        `<span class="font-medium">${escapeHtml(r.label)}</span>
         <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.category ?? '')}${r.userId && r.userId !== 'org' ? ' · ' + escapeHtml(r.userId) : ''}</p>`,
        `<span class="tabular-nums font-semibold ${(r.amountMinor ?? 0) < 0 ? 'text-rose-600' : 'text-emerald-700'}">${escapeHtml(fmt(r.amountMinor ?? 0, { showSign: true }))}</span>`,
        `<span class="text-xs">Day ${escapeHtml(String(r.dayOfMonth ?? 1))}</span>`,
        r.active === false
            ? badge('Paused', 'void')
            : due.has(r.id) ? badge('Due now', 'pending') : badge(
                r.lastRunMonthKey ? `Ran ${monthLabel(r.lastRunMonthKey)}` : 'Not run yet', 'active'),
        `<div class="flex gap-1 justify-end flex-wrap">
            ${can('recurring.manage') ? button(r.active === false ? 'Resume' : 'Pause', { action: 'recurring:toggle', data: { id: r.id, active: r.active === false ? '1' : '0' }, tone: 'ghost', size: 'sm' }) : ''}
            ${can('recurring.manage') ? button('Edit', { action: 'recurring:edit', data: { id: r.id }, tone: 'ghost', size: 'sm' }) : ''}
            ${can('recurring.manage') ? button('Delete', { action: 'recurring:delete', data: { id: r.id }, tone: 'danger', size: 'sm' }) : ''}
        </div>`
    ]));

    return card(`
        ${sectionHeader('Recurring entries',
            'These are templates, not background jobs. Each one materialises the first time the dashboard is opened on or after its day of the month, exactly once per month.',
            [
                due.size && can('tx.create') ? button(`Run ${due.size} due now`, { action: 'recurring:run', tone: 'success', size: 'sm' }) : '',
                can('recurring.manage') ? button('New recurring', { action: 'recurring:new', size: 'sm' }) : ''
            ].join(''))}
        ${rows.length === 0
            ? emptyState('Nothing recurring yet. Good for rent, subscriptions or standing dues.')
            : table({ headers: ['Label', 'Amount', 'Runs on', 'Last run', ''], rows })}`);
}

export function render() {
    return `
        ${pageTitle('Planning', 'Budgets, goals and anything that repeats.')}
        <div class="space-y-6">
            ${budgetsCard()}
            ${goalsCard()}
            ${recurringCard()}
        </div>`;
}

export const view = { id: 'planning', label: 'Planning', render };
