// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PASSCODE_ALPHABET, PASSCODE_LENGTH, PASSCODE_TTL_MS,
    generatePasscode, normalizePasscode, isWellFormed,
    formatPasscode, hashPasscode, passcodeExpiresAtMs
} from '../src/features/passcodes.js';

test('alphabet has 32 unambiguous characters', () => {
    assert.equal(PASSCODE_ALPHABET.length, 32);
    for (const bad of '1OILi') assert.equal(PASSCODE_ALPHABET.includes(bad), false, bad);
    assert.equal(PASSCODE_ALPHABET.includes('0'), true);
});

test('generated codes are 10 characters from the alphabet', () => {
    for (let i = 0; i < 500; i++) {
        const code = generatePasscode();
        assert.equal(code.length, PASSCODE_LENGTH);
        assert.ok(isWellFormed(code), code);
    }
});

test('generation is roughly uniform across the alphabet', () => {
    const counts = {};
    const N = 64000;
    for (let i = 0; i < N / PASSCODE_LENGTH; i++) {
        for (const ch of generatePasscode()) counts[ch] = (counts[ch] ?? 0) + 1;
    }
    const expected = N / 32;
    for (const ch of PASSCODE_ALPHABET) {
        assert.ok(Math.abs(counts[ch] - expected) / expected < 0.15, `${ch}: ${counts[ch]}`);
    }
});

test('normalisation ignores case, spaces and dashes', () => {
    assert.equal(normalizePasscode(' k7q2d-9xm4t '), 'K7Q2D9XM4T');
    assert.equal(normalizePasscode('K7Q2D 9XM4T'), 'K7Q2D9XM4T');
});

test('display format is two groups of five', () => {
    assert.equal(formatPasscode('K7Q2D9XM4T'), 'K7Q2D-9XM4T');
});

test('hash is stable across formatting variants', async () => {
    const a = await hashPasscode('K7Q2D-9XM4T');
    const b = await hashPasscode('k7q2d9xm4t');
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, 'K7Q2D9XM4T');
});

test('hash matches a known SHA-256 vector', async () => {
    // SHA-256("ABCDEFGHJK") computed independently.
    const expected = (await import('node:crypto')).createHash('sha256').update('ABCDEFGHJK').digest('hex');
    assert.equal(await hashPasscode('abcdefghjk'), expected);
});

test('expiry is 35 minutes after creation', () => {
    assert.equal(PASSCODE_TTL_MS, 35 * 60 * 1000);
    assert.equal(passcodeExpiresAtMs(1000), 1000 + 2100000);
});
