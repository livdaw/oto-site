// oto-crypto.js: end-to-end encryption for thoughts.
// The same file ships in oto-extension/, oto-mcp/ and oto-site/; keep the copies identical.
//
// How it works
// - Each person has one random 256-bit "notebook key". Thoughts (text and tag together) are
//   encrypted with it on the device, with AES-256-GCM, before they are sent to Supabase.
// - The notebook key is locked with a key derived from the person's notebook passphrase
//   (PBKDF2-SHA256, 600,000 rounds). Only the locked copy (the "lock") is stored in Supabase,
//   in the note_keys table. Neither the passphrase nor the notebook key ever leaves the device.
// - Changing the passphrase re-locks the same notebook key, so thoughts are not re-encrypted.
// - There is no recovery: without the passphrase, nobody (including oto) can read the thoughts.
//
// Stored form of an encrypted thought, in notes.text (notes.tag is null):
//   "oto:e1:" + base64(12-byte IV) + ":" + base64(AES-GCM ciphertext of JSON {"t": text, "g": tag})
(function (root) {
  "use strict";
  const subtle = root.crypto.subtle;
  const PREFIX = "oto:e1:";
  const ITERATIONS = 600000;
  const LOCK_AAD = new TextEncoder().encode("oto-notebook-key-v1");
  const NOTE_AAD = new TextEncoder().encode("oto-thought-v1");
  const enc = new TextEncoder(), dec = new TextDecoder();

  function toB64(bytes) {
    const a = new Uint8Array(bytes); let s = "";
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
  function random(n) { return root.crypto.getRandomValues(new Uint8Array(n)); }

  async function passKey(passphrase, salt, iterations) {
    const base = await subtle.importKey("raw", enc.encode(String(passphrase).normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  const keyCache = new Map();
  async function aesKey(keyB64) {
    if (!keyCache.has(keyB64)) keyCache.set(keyB64, subtle.importKey("raw", fromB64(keyB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
    return keyCache.get(keyB64);
  }

  // Lock a notebook key (base64) with a passphrase. Returns the object stored in note_keys.lock.
  async function lockKey(keyB64, passphrase) {
    if (!passphrase || String(passphrase).length < 8) throw new Error("Use a passphrase of at least 8 characters.");
    const salt = random(16), iv = random(12);
    const wrapped = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: LOCK_AAD }, await passKey(passphrase, salt, ITERATIONS), fromB64(keyB64));
    return { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt), iv: toB64(iv), key: toB64(wrapped) };
  }

  // A new notebook key, locked with the passphrase. Returns { keyB64, lock }.
  async function createKey(passphrase) {
    const keyB64 = toB64(random(32));
    return { keyB64, lock: await lockKey(keyB64, passphrase) };
  }

  // Open a lock with the passphrase. Returns the notebook key (base64), or throws if the passphrase is wrong.
  async function unlockKey(lock, passphrase) {
    if (!lock || lock.v !== 1) throw new Error("This notebook was locked by a newer version of oto. Update oto and try again.");
    try {
      const raw = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(lock.iv), additionalData: LOCK_AAD },
        await passKey(passphrase, fromB64(lock.salt), lock.iterations), fromB64(lock.key));
      return toB64(raw);
    } catch (e) {
      throw new Error("That passphrase doesn't open this notebook.");
    }
  }

  function isEncrypted(text) { return typeof text === "string" && text.startsWith(PREFIX); }

  async function encryptThought(keyB64, text, tag) {
    const iv = random(12);
    const body = enc.encode(JSON.stringify({ t: String(text), g: tag || null }));
    const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: NOTE_AAD }, await aesKey(keyB64), body);
    return PREFIX + toB64(iv) + ":" + toB64(ct);
  }

  // Returns { text, tag }. Throws if the thought can't be opened with this key.
  async function decryptThought(keyB64, stored) {
    if (!isEncrypted(stored)) return null;
    const [ivB64, ctB64] = stored.slice(PREFIX.length).split(":");
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64), additionalData: NOTE_AAD }, await aesKey(keyB64), fromB64(ctB64));
    const o = JSON.parse(dec.decode(plain));
    return { text: o.t, tag: o.g || null };
  }

  root.otoCrypto = { PREFIX, createKey, lockKey, unlockKey, isEncrypted, encryptThought, decryptThought };
})(typeof self !== "undefined" ? self : globalThis);
