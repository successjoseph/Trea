import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, serverTimestamp, onSnapshot, query, orderBy, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyAiKCUqdl71v9QiW9HBnfZrljp588H9Csc",
    authDomain: "trea-pro.firebaseapp.com",
    projectId: "trea-pro",
    storageBucket: "trea-pro.firebasestorage.app",
    messagingSenderId: "696745136893",
    appId: "1:696745136893:web:6fd6e1fad336e59a996494"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentAdmin = null;
let currentOrg = null;
let allTransactions = []; 
let logoutTimer;

// --- SESSION MANAGEMENT ---
function resetLogoutTimer() {
    clearTimeout(logoutTimer);
    logoutTimer = setTimeout(() => {
        signOut(auth);
        alert("Session expired due to 1 hour of inactivity.");
    }, 3600000); // 1 hour
}
window.addEventListener('mousemove', resetLogoutTimer);
window.addEventListener('keypress', resetLogoutTimer);

document.getElementById('signout-btn').addEventListener('click', () => {
    signOut(auth);
    location.reload();
});

// --- AUTHENTICATION & GATEKEEPER ---
const loginBtn = document.getElementById('login-btn');
const loadingText = document.getElementById('loading-text');

onAuthStateChanged(auth, async (user) => {
    if (user) {
        loadingText.classList.remove('hidden');
        loginBtn.classList.add('hidden');

        try {
            const userDoc = await getDoc(doc(db, "users", user.email));
            if (userDoc.exists() && userDoc.data().role === 'admin') {
            currentOrg = userDoc.data().orgId;
            if (!currentOrg) return alert("Access Denied: No organization assigned to this admin.");

            currentAdmin = { email: user.email, name: userDoc.data().name || 'Admin', orgId: currentOrg };
            document.getElementById('welcome-msg').innerText = `Welcome, ${currentAdmin.name} (${currentOrg})`;
            document.getElementById('auth-guard').style.display = 'none';
            document.getElementById('app-container').classList.remove('hidden');
            
            resetLogoutTimer();
            initDataFetch();
        } else {
                loadingText.classList.add('hidden');
                document.getElementById('rejected-text').classList.remove('hidden');
            }
        } catch (error) {
            console.error("Firestore Error:", error);
            loadingText.classList.add('hidden');
            document.getElementById('rejected-text').innerText = "Database connection error.";
            document.getElementById('rejected-text').classList.remove('hidden');
        }
    } else {
        document.getElementById('auth-guard').style.display = 'flex';
        document.getElementById('app-container').classList.add('hidden');
        loadingText.classList.add('hidden');
        loginBtn.classList.remove('hidden');
    }
});

loginBtn.addEventListener('click', () => {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider).catch(err => console.error("Auth failed:", err));
});

// --- PUBLIC DEMO ENTRY HANDLER ---
document.getElementById('demo-btn').addEventListener('click', () => {
    currentOrg = 'demo_org';
    currentAdmin = { 
        email: `visitor_${Math.floor(Math.random() * 1000)}@demo.com`, 
        name: 'Demo Visitor', 
        orgId: currentOrg 
    };
    
    document.getElementById('welcome-msg').innerText = `Demo Mode (Public Sandbox)`;
    document.getElementById('auth-guard').style.display = 'none';
    document.getElementById('app-container').classList.remove('hidden');
    
    initDataFetch();
});

// --- REAL-TIME DATA FETCHING & MATH ---
function initDataFetch() {
    onSnapshot(collection(db, `orgs/${currentOrg}/transactions`), (snapshot) => {        
        allTransactions = [];
        let totalBal = 0, totalInc = 0, totalDeb = 0;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            allTransactions.push({ id: doc.id, ...data });
            
            if (data.type === 'credit') totalBal += data.amount;
            if (data.type === 'income') { totalBal += data.amount; totalInc += data.amount; }
            if (data.type === 'debit') { totalBal += data.amount; totalDeb += Math.abs(data.amount); }
        });
        
        document.querySelectorAll('.total-balance-display').forEach(el => {el.innerText = `₦${totalBal.toLocaleString()}`;});
        document.getElementById('total-income').innerText = `₦${totalInc.toLocaleString()}`;
        document.getElementById('total-debits').innerText = `₦${totalDeb.toLocaleString()}`;
        
        // Refresh detail view if it's open
        const activeEmail = document.getElementById('member-detail').getAttribute('data-active-user');
        if (activeEmail) window.showMemberDetails(activeEmail, document.getElementById('member-name-display').innerText.replace("'s Ledger", ""));
    });

    const auditQuery = query(collection(db, `orgs/${currentOrg}/audit_logs`), orderBy("timestamp", "desc"));
    onSnapshot(auditQuery, (snapshot) => {
        const tbody = document.getElementById('audit-table-body');
        tbody.innerHTML = '';
        snapshot.forEach(doc => {
            const data = doc.data();
            const dateStr = data.timestamp ? data.timestamp.toDate().toLocaleString() : 'Just now';
            tbody.innerHTML += `<tr class="border-b"><td class="p-3">${dateStr}</td><td class="p-3">${data.admin_email}</td><td class="p-3">${data.action}</td></tr>`;
        });
    });

    const snapshotQuery = query(collection(db, `orgs/${currentOrg}/snapshots`), orderBy("timestamp", "desc"));
    onSnapshot(snapshotQuery, (snapshot) => {
        const snapList = document.getElementById('snapshot-list');
        if (!snapList) return;
        
        snapList.innerHTML = '';
        
        if (snapshot.empty) {
            snapList.innerHTML = '<p class="text-gray-500 italic">No snapshots saved yet.</p>';
            return;
        }

        snapshot.forEach(doc => {
            const data = doc.data();
            const dateStr = data.timestamp ? data.timestamp.toDate().toLocaleDateString() : 'Just now';
            
            snapList.innerHTML += `
                <div class="p-4 border rounded bg-blue-50 border-l-4 border-blue-500">
                    <p class="text-sm font-bold text-gray-700">${data.monthYear}</p>
                    <p class="text-xl font-bold text-blue-900">₦${data.total_balance.toLocaleString()}</p>
                    <p class="text-xs text-gray-500">Saved on: ${dateStr}</p>
                </div>
            `;
        });
    });

    onSnapshot(collection(db, `orgs/${currentOrg}/members`), (snapshot) => {
        document.getElementById('total-members').innerText = snapshot.size;
        
        const creditSelect = document.getElementById('credit-user');
        const membersList = document.getElementById('members-list');
        
        creditSelect.innerHTML = '<option value="">Select Member</option>';
        membersList.innerHTML = '';

        snapshot.forEach(doc => {
            const data = doc.data();
            const displayName = data.name || doc.id;
            
            creditSelect.innerHTML += `<option value="${doc.id}">${displayName}</option>`;
            
            // Attach click listener for the ledger
            membersList.innerHTML += `
                <div onclick="showMemberDetails('${doc.id}', '${displayName}')" class="flex justify-between items-center p-3 border-b hover:bg-gray-50 cursor-pointer">
                    <span class="font-semibold">${displayName}</span>
                    <span class="text-xs px-2 py-1 rounded bg-gray-200">${data.role || 'member'}</span>
                </div>
            `;
        });
    });
}

// --- ADD NEW USER HANDLER ---
document.getElementById('btn-add-user').addEventListener('click', async () => {
    const email = document.getElementById('new-user-email').value.trim().toLowerCase();
    const name = document.getElementById('new-user-name').value.trim();
    if (!email || !name) return alert("Enter both email and name.");

    try {
        await setDoc(doc(db, `orgs/${currentOrg}/members`, email), {
            name: name,
            role: "member",
            joinDate: serverTimestamp()
        });
        await logAudit(`Added new member: ${name} (${email})`);
        alert("Member added!");
        document.getElementById('new-user-email').value = '';
        document.getElementById('new-user-name').value = '';
    } catch (e) {
        console.error("Error adding user:", e);
        alert("Failed to add member. Check console.");
    }
});

// --- INDIVIDUAL LEDGER HANDLER ---
window.showMemberDetails = function(email, name) {
    const detailView = document.getElementById('member-detail');
    detailView.classList.remove('hidden');
    detailView.setAttribute('data-active-user', email);
    document.getElementById('member-name-display').innerText = `${name}'s Ledger`;
    
    const userTx = allTransactions.filter(tx => tx.userId === email);
    const grid = document.getElementById('monthly-grid');
    grid.innerHTML = '';
    
    if (userTx.length === 0) {
        grid.innerHTML = '<p class="col-span-full text-gray-500 italic">No records found for this member.</p>';
        return;
    }

    userTx.sort((a, b) => b.timestamp - a.timestamp).forEach(tx => {
        const dateStr = tx.timestamp ? tx.timestamp.toDate().toLocaleDateString() : 'Pending';
        grid.innerHTML += `
            <div class="p-3 border rounded bg-gray-50 border-l-4 ${tx.type === 'credit' ? 'border-blue-500' : 'border-green-500'}">
                <p class="text-xs font-bold text-gray-500">${dateStr}</p>
                <p class="text-lg font-semibold text-gray-800">₦${tx.amount.toLocaleString()}</p>
                <p class="text-xs capitalize text-gray-600">${tx.type} ${tx.source ? '('+tx.source+')' : ''}</p>
            </div>
        `;
    });
}

// --- UI NAVIGATION & TOGGLES ---
const sidebar = document.getElementById('sidebar');
document.getElementById('hamburger-btn').addEventListener('click', () => sidebar.classList.remove('-translate-x-full'));
document.getElementById('close-sidebar-btn').addEventListener('click', () => sidebar.classList.add('-translate-x-full'));

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const target = e.target.getAttribute('data-target');
        document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
        document.getElementById('view-' + target).classList.remove('hidden');
        if(window.innerWidth < 768) sidebar.classList.add('-translate-x-full');
    });
});

const incomeSource = document.getElementById('income-source');
const incomeReason = document.getElementById('income-reason');
incomeSource.addEventListener('change', () => {
    if (incomeSource.value === 'other') incomeReason.classList.remove('hidden');
    else incomeReason.classList.add('hidden');
});

// --- HELPER LOGIC FOR FIRESTORE ---
async function logAudit(actionString) {
    await addDoc(collection(db, `orgs/${currentOrg}/audit_logs`), {
        action: actionString,
        admin_email: currentAdmin.email,
        timestamp: serverTimestamp()
    });
}

// --- TRANSACTION HANDLERS ---
document.getElementById('btn-process-credit').addEventListener('click', async () => {
    const user = document.getElementById('credit-user').value;
    const amount = Number(document.getElementById('credit-amount').value);
    if (!user || !amount) return alert("Fill all fields");

    try {
        await addDoc(collection(db, `orgs/${currentOrg}/transactions`), {
            userId: user,
            amount: amount,
            type: "credit",
            timestamp: serverTimestamp(),
            adminEmail: currentAdmin.email
        });
        await logAudit(`Added ₦${amount} credit to ${user}`);
        alert("Credit processed!");
        enforceRollingLimit();
        document.getElementById('credit-amount').value = '';
    } catch (e) {
        console.error("Error adding credit: ", e);
    }
});

document.getElementById('btn-process-debit').addEventListener('click', async () => {
    const amount = Number(document.getElementById('debit-amount').value);
    const reason = document.getElementById('debit-reason').value;
    if (!amount || !reason) return alert("Fill all fields");

    try {
        // Ensure this points to the exact org transactions path
        await addDoc(collection(db, `orgs/${currentOrg}/transactions`), {
            userId: "org",
            amount: -amount, // Stored as negative to balance the math naturally
            type: "debit",
            reason: reason,
            timestamp: serverTimestamp(),
            adminEmail: currentAdmin.email
        });
        
        await logAudit(`Debited ₦${amount} for: ${reason}`);
        
        alert("Debit processed!");
        document.getElementById('debit-amount').value = '';
        document.getElementById('debit-reason').value = '';
        enforceRollingLimit();
    } catch (e) {
        console.error("Error adding debit: ", e);
        alert("Failed to process debit. Check console.");
    }
});

document.getElementById('btn-process-income').addEventListener('click', async () => {
    const amount = Number(document.getElementById('income-amount').value);
    const source = document.getElementById('income-source').value;
    const reason = document.getElementById('income-reason').value;
    if (!amount) return alert("Enter an amount");

    try {
        // Updated path to point to the current org's transactions
        await addDoc(collection(db, `orgs/${currentOrg}/transactions`), {
            userId: "org",
            amount: amount,
            type: "income",
            source: source,
            reason: source === 'other' ? reason : source,
            timestamp: serverTimestamp(),
            adminEmail: currentAdmin.email
        });
        
        await logAudit(`Added ₦${amount} income from ${source}`);
        
        alert("Income processed!");
        document.getElementById('income-amount').value = '';
        document.getElementById('income-reason').value = '';
        enforceRollingLimit();
    } catch (e) {
        console.error("Error adding income: ", e);
        alert("Failed to process income. Check console.");
    }
});

// --- EXCEL EXPORT HANDLER ---
document.getElementById('export-btn').addEventListener('click', () => {
    if (allTransactions.length === 0) return alert("No data to export.");
    
    // Format data for Excel
    const exportData = allTransactions.map(tx => ({
        Date: tx.timestamp ? tx.timestamp.toDate().toLocaleDateString() : 'Pending',
        Type: tx.type.toUpperCase(),
        Amount: tx.amount,
        User_or_Source: tx.userId === 'org' ? tx.source : tx.userId,
        Reason: tx.reason || 'N/A',
        Processed_By: tx.adminEmail
    }));

    // Generate and download Excel file
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Transactions");
    XLSX.writeFile(wb, `${currentOrg}_Treasury_Export.xlsx`);
    
    logAudit("Exported transactions to Excel");
});

// --- SNAPSHOT HANDLER ---
document.getElementById('snapshot-btn').addEventListener('click', async () => {
    // Grab the current balance text from the first element with the class
    const totalBalText = document.querySelector('.total-balance-display').innerText;
    const totalBalNumber = Number(totalBalText.replace(/[^0-9.-]+/g,""));

    const now = new Date();
    const monthYear = now.toLocaleString('default', { month: 'long', year: 'numeric' });

    try {
        await addDoc(collection(db, `orgs/${currentOrg}/snapshots`), {
            monthYear: monthYear,
            total_balance: totalBalNumber,
            timestamp: serverTimestamp(),
            adminEmail: currentAdmin.email
        });
        
        await logAudit(`Created balance snapshot for ${monthYear}`);
        alert(`Snapshot for ${monthYear} saved successfully!`);
    } catch (e) {
        console.error("Error saving snapshot: ", e);
        alert("Failed to save snapshot. Check console.");
    }
});

// --- ROLLING 20 DELETION LOGIC ---
async function enforceRollingLimit() {
    if (currentOrg !== 'demo_org') return; // Only apply this rule to the demo
    
    const q = query(collection(db, `orgs/${currentOrg}/transactions`), orderBy("timestamp", "asc"));
    const snapshot = await getDocs(q);
    
    if (snapshot.size > 20) {
        // Calculate how many documents need to be removed
        const overflow = snapshot.size - 20;
        const docsToDelete = snapshot.docs.slice(0, overflow);
        
        docsToDelete.forEach(async (docSnapshot) => {
            await deleteDoc(doc(db, `orgs/${currentOrg}/transactions`, docSnapshot.id));
        });
    }
}