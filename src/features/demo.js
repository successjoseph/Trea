/**
 * Demo sandbox.
 *
 * v1 pointed the public "Try Live Demo" button at a real Firestore org that
 * anyone on the internet could write to without authenticating. That is an
 * unauthenticated write endpoint with a rolling-delete loop bolted on, and it
 * is the single worst hole in the original app: it burns quota, it lets a
 * stranger inject content that every visitor then renders, and it needs
 * Firestore rules permissive enough to be dangerous elsewhere.
 *
 * The demo now runs entirely in the browser. Nothing leaves the device, the
 * data is seeded fresh, and edits persist only in this tab's memory (plus
 * localStorage so a refresh does not wipe a demo mid-tour). No Firestore rule
 * needs to permit anonymous writes at all.
 */
import { state } from '../core/state.js';
import { emit, EVENTS } from '../core/bus.js';
import { monthKey, now, dayKey } from '../core/time.js';
import { STATUS } from '../data/ledger.js';

const STORAGE_KEY = 'trea:demo:v2';

const EVENT_FOR = {
    transactions: EVENTS.TX_CHANGED,
    members: EVENTS.MEMBERS_CHANGED,
    snapshots: EVENTS.SNAPSHOTS_CHANGED,
    roles: EVENTS.ROLES_CHANGED,
    budgets: EVENTS.BUDGETS_CHANGED,
    goals: EVENTS.GOALS_CHANGED,
    recurring: EVENTS.RECURRING_CHANGED,
    reconciliations: EVENTS.RECONCILE_CHANGED,
    auditLogs: EVENTS.AUDIT_CHANGED
};

let seq = 0;
const nextId = () => `demo-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            transactions: state.transactions,
            members: state.members,
            snapshots: state.snapshots,
            budgets: state.budgets,
            goals: state.goals,
            recurring: state.recurring,
            reconciliations: state.reconciliations,
            auditLogs: state.auditLogs.slice(0, 200)
        }));
    } catch {
        // Private browsing or a full quota - the demo simply becomes ephemeral.
    }
}

export function demoWrite(collectionName, payload) {
    const id = nextId();
    state[collectionName] = [{ id, ...stripServerFields(payload) }, ...state[collectionName]];
    emit(EVENT_FOR[collectionName] ?? EVENTS.TX_CHANGED, state[collectionName]);
    persist();
    return id;
}

export function demoSet(collectionName, id, payload) {
    const rest = state[collectionName].filter((d) => d.id !== id);
    state[collectionName] = [{ id, ...stripServerFields(payload) }, ...rest];
    emit(EVENT_FOR[collectionName] ?? EVENTS.TX_CHANGED, state[collectionName]);
    persist();
    return id;
}

export function demoUpdate(collectionName, id, patch) {
    state[collectionName] = state[collectionName].map(
        (d) => (d.id === id ? { ...d, ...stripServerFields(patch) } : d)
    );
    emit(EVENT_FOR[collectionName] ?? EVENTS.TX_CHANGED, state[collectionName]);
    persist();
}

export function demoDelete(collectionName, id) {
    state[collectionName] = state[collectionName].filter((d) => d.id !== id);
    emit(EVENT_FOR[collectionName] ?? EVENTS.TX_CHANGED, state[collectionName]);
    persist();
}

/** serverTimestamp() sentinels are meaningless offline; replace with real ms. */
function stripServerFields(payload) {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
        if (v && typeof v === 'object' && v._methodName) out[k] = null;
        else out[k] = v;
    }
    return out;
}

/** Restore a previous demo session, or build a fresh one. */
export function loadDemoData() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved?.transactions?.length) {
            Object.assign(state, saved);
            return;
        }
    } catch { /* fall through to a fresh seed */ }
    seedDemo();
}

export function resetDemo() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    seedDemo();
    for (const event of Object.values(EVENT_FOR)) emit(event, null);
}

/**
 * Seed roughly a year of plausible activity so the charts, snapshots and
 * variance reports have something real to say on first open.
 */
function seedDemo() {
    const people = [
        ['ada@example.org', 'Ada Nwosu'],
        ['bem@example.org', 'Bem Terkula'],
        ['chi@example.org', 'Chidera Okoro'],
        ['dami@example.org', 'Damilola Ade'],
        ['efe@example.org', 'Efe Ighodaro'],
        ['fola@example.org', 'Folake Bello']
    ];

    state.members = people.map(([email, name], i) => ({
        id: email, email, name,
        role: 'member',
        status: i === 5 ? 'archived' : 'active',
        duesMonthlyMinor: 500000,
        joinDateMs: now() - (400 - i * 30) * 86400000,
        tags: []
    }));

    const spendCategories = ['Supplies', 'Events', 'Transport', 'Utilities', 'Welfare'];
    const transactions = [];
    const today = new Date();

    for (let back = 11; back >= 0; back--) {
        const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
        const mk = monthKey(d);
        const activeMembers = state.members.filter((m) => m.status === 'active');

        activeMembers.forEach((m, idx) => {
            // A couple of members miss a month here and there, so the arrears
            // report has something to find.
            if ((back + idx) % 7 === 0) return;
            transactions.push(makeTx({
                type: 'credit', userId: m.email, amountMinor: 500000,
                category: 'Dues', reason: 'Monthly dues',
                date: new Date(d.getFullYear(), d.getMonth(), 3 + idx)
            }));
        });

        transactions.push(makeTx({
            type: 'income', userId: 'org', amountMinor: 800000 + ((back * 37) % 9) * 50000,
            category: 'Donation', source: 'donation', reason: 'Community donation',
            date: new Date(d.getFullYear(), d.getMonth(), 9)
        }));

        const spends = 2 + (back % 3);
        for (let s = 0; s < spends; s++) {
            transactions.push(makeTx({
                type: 'debit', userId: 'org',
                amountMinor: -(120000 + ((back * 13 + s * 29) % 11) * 45000),
                category: spendCategories[(back + s) % spendCategories.length],
                reason: ['Venue hire', 'Printing', 'Fuel', 'Data bundle', 'Refreshments'][(back + s) % 5],
                date: new Date(d.getFullYear(), d.getMonth(), 12 + s * 4)
            }));
        }
        void mk;
    }

    state.transactions = transactions;
    state.snapshots = [];
    state.auditLogs = [];
    state.budgets = [
        { id: 'b1', category: 'Events', limitMinor: 400000, active: true },
        { id: 'b2', category: 'Supplies', limitMinor: 250000, active: true },
        { id: 'b3', category: 'Transport', limitMinor: 150000, active: true }
    ];
    state.goals = [
        { id: 'g1', name: 'Annual retreat fund', targetMinor: 40000000, deadline: `${today.getFullYear()}-12-31`, status: 'active' },
        { id: 'g2', name: 'Emergency reserve', targetMinor: 90000000, deadline: `${today.getFullYear() + 1}-06-30`, status: 'active' }
    ];
    state.recurring = [
        { id: 'r1', label: 'Office internet', type: 'debit', amountMinor: -180000, category: 'Utilities', dayOfMonth: 5, active: true, lastRunMonthKey: null }
    ];
    state.reconciliations = [];
    persist();
}

function makeTx({ type, userId, amountMinor, category, reason, source = null, date }) {
    // Never seed a future date: the app rejects forward-dated entries, and demo
    // data that could not have been entered through the UI is misleading.
    const ms = Math.min(date.getTime(), Date.now());
    return {
        id: nextId(),
        type, userId, amountMinor, amount: amountMinor / 100,
        category, reason, source, tags: [],
        effectiveDate: dayKey(ms),
        monthKey: monthKey(ms),
        status: STATUS.ACTIVE,
        releaseAtMs: ms + 30000,
        approvalRequired: false,
        createdBy: 'demo@trea.app',
        adminEmail: 'demo@trea.app',
        createdAtMs: ms,
        editCount: 0
    };
}
