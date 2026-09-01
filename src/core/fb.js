/**
 * Firebase bootstrap.
 *
 * Everything Firestore-related is funnelled through this module so the rest of
 * the app never imports the CDN URLs directly. That keeps the SDK version in
 * one place and lets us swap the persistence strategy without touching
 * feature code.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import {
    getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
    setPersistence, browserSessionPersistence, reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
    collection, collectionGroup, query, where, orderBy, limit, startAfter,
    onSnapshot, serverTimestamp, runTransaction, writeBatch, increment,
    Timestamp, documentId
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// Firebase web config values are public client identifiers by design. They are
// not secrets: all real access control lives in firestore.rules.
const firebaseConfig = {
    apiKey: "AIzaSyAiKCUqdl71v9QiW9HBnfZrljp588H9Csc",
    authDomain: "trea-pro.firebaseapp.com",
    projectId: "trea-pro",
    storageBucket: "trea-pro.firebasestorage.app",
    messagingSenderId: "696745136893",
    appId: "1:696745136893:web:6fd6e1fad336e59a996494"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// A persistent local cache means repeat visits and offline use are served from
// IndexedDB instead of the network. That is the single biggest lever we have on
// Firestore read cost, and it is what makes the app usable with no connection.
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export {
    onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
    setPersistence, browserSessionPersistence, reauthenticateWithPopup,
    doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
    collection, collectionGroup, query, where, orderBy, limit, startAfter,
    onSnapshot, serverTimestamp, runTransaction, writeBatch, increment,
    Timestamp, documentId
};

/** Path helpers - every read/write is org-scoped, so build paths in one place. */
export const paths = {
    user: (email) => `users/${email}`,
    org: (org) => `orgs/${org}`,
    roles: (org) => `orgs/${org}/roles`,
    role: (org, email) => `orgs/${org}/roles/${email}`,
    members: (org) => `orgs/${org}/members`,
    member: (org, email) => `orgs/${org}/members/${email}`,
    transactions: (org) => `orgs/${org}/transactions`,
    transaction: (org, id) => `orgs/${org}/transactions/${id}`,
    snapshots: (org) => `orgs/${org}/snapshots`,
    snapshot: (org, monthKey) => `orgs/${org}/snapshots/${monthKey}`,
    auditLogs: (org) => `orgs/${org}/audit_logs`,
    budgets: (org) => `orgs/${org}/budgets`,
    goals: (org) => `orgs/${org}/goals`,
    recurring: (org) => `orgs/${org}/recurring`,
    reconciliations: (org) => `orgs/${org}/reconciliations`,
    settings: (org) => `orgs/${org}/meta/settings`
};
