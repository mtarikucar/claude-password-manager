/**
 * Background service worker — the only part that talks to the native host.
 * Keeps ONE persistent connection so the vault's OS key is resolved once, and
 * correlates requests/responses by id. Passwords flow browser <-> vault only.
 */
const HOST = "com.mtarikucar.ccpm";

let port = null;
let seq = 0;
const pending = new Map();

function getPort() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    return null;
  }
  port.onMessage.addListener((resp) => {
    const id = resp && resp.id;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(resp);
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "disconnected";
    for (const resolve of pending.values()) resolve({ ok: false, error: err });
    pending.clear();
    port = null;
  });
  return port;
}

function nativeRequest(message) {
  return new Promise((resolve) => {
    const p = getPort();
    if (!p) return resolve({ ok: false, error: "native host not reachable — run `pm-cli browser-install`" });
    const id = ++seq;
    pending.set(id, resolve);
    try {
      p.postMessage({ ...message, id });
    } catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: String(e) });
    }
    // Safety timeout so a stuck host doesn't hang the popup/content script.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, error: "timeout" });
      }
    }, 8000);
  });
}

// Extension-internal state (a login capture that must survive a page
// navigation) is kept in session storage, never sent to the native host.
async function handleInternal(msg) {
  const key = "pending:" + msg.host;
  if (msg.__internal === "stashPending") {
    await chrome.storage.session.set({ [key]: msg.cred });
    return { ok: true };
  }
  if (msg.__internal === "getPending") {
    const o = await chrome.storage.session.get(key);
    return { ok: true, cred: o[key] || null };
  }
  if (msg.__internal === "clearPending") {
    await chrome.storage.session.remove(key);
    return { ok: true };
  }
  return { ok: false, error: "unknown-internal" };
}

// Content script and popup funnel their requests through here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.__internal) handleInternal(msg).then(sendResponse);
  else nativeRequest(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});
