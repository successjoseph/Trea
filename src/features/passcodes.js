/**
 * One-time join passcodes.
 *
 * A passcode is 10 characters drawn from a 32-character alphabet with the
 * look-alikes (0, O, 1, I, L) removed, so it can be read aloud or copied by
 * hand without mistakes. It is shown to the creator once, never stored in
 * plain text: the `passcodes/{sha256}` document is keyed by a SHA-256 of the
 * normalised code, so a leaked database does not reveal usable codes.
 *
 * Lifetime, single use and email binding are enforced by Firestore rules and a
 * transaction (see docs/foundation-plan.md), not by this module. This file only
 * generates, normalises, hashes and formats.
 */

// 23 letters (no I, L, O) and 9 digits (0 and 2-9, no 1): 32 characters.
// 0 stays because O is already excluded, so it cannot be confused with a letter.
export const PASSCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ023456789';
export const PASSCODE_LENGTH = 10;
export const PASSCODE_TTL_MS = 35 * 60 * 1000;

const VALID = new RegExp(`^[${PASSCODE_ALPHABET}]{${PASSCODE_LENGTH}}$`);

/**
 * Uniform generation. 256 is an exact multiple of 32, so masking each random
 * byte with 31 selects every alphabet character with equal probability.
 */
export function generatePasscode(cryptoImpl = globalThis.crypto) {
    const bytes = new Uint8Array(PASSCODE_LENGTH);
    cryptoImpl.getRandomValues(bytes);
    let code = '';
    for (const b of bytes) code += PASSCODE_ALPHABET[b & 31];
    return code;
}

/** Uppercase and strip everything outside the alphabet, so spaces, dashes and case never matter. */
export function normalizePasscode(input) {
    return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isWellFormed(normalized) {
    return VALID.test(normalized);
}

/** Display form for showing a new code: two groups of five, e.g. K7Q2D-9XM4T. */
export function formatPasscode(code) {
    const c = normalizePasscode(code);
    return c.length === PASSCODE_LENGTH ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** Hex SHA-256 of the normalised code. This hex string is the Firestore document ID. */
export async function hashPasscode(input, cryptoImpl = globalThis.crypto) {
    const normalized = normalizePasscode(input);
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function passcodeExpiresAtMs(createdAtMs) {
    return createdAtMs + PASSCODE_TTL_MS;
}
