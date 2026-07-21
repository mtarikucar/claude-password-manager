/**
 * Content script: detect login forms, autofill saved credentials on focus, and
 * offer a one-click "Save" when you log in. Everything routes through the
 * background -> native host -> local vault; nothing is sent anywhere else.
 */
(() => {
  const api = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, res); } catch { res(null); } });
  const host = location.hostname;
  const focused = new WeakSet();

  const visible = (el) => el && el.type !== "hidden" && !el.disabled && el.offsetParent !== null;

  function findLogin(root) {
    root = root || document;
    const pw = [...root.querySelectorAll('input[type="password"]')].find(visible);
    if (!pw) return null;
    const scope = pw.form || root;
    const texts = [...scope.querySelectorAll("input")].filter(
      (i) => i !== pw && visible(i) && ["text", "email", "tel", ""].includes(i.type || ""),
    );
    let user = null;
    for (const t of texts) {
      if (pw.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING) user = t;
    }
    if (!user && texts.length) user = texts[texts.length - 1] || null;
    return { pw, user };
  }

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  let filled = false;
  async function autofill() {
    if (filled) return;
    const login = findLogin();
    if (!login) return;
    const q = await api({ type: "query", url: location.href });
    if (!q || !q.ok || !q.matches || q.matches.length === 0) return;
    const g = await api({ type: "get", id: q.matches[0].id });
    if (!g || !g.ok) return;
    filled = true;
    if (login.user && g.username) setValue(login.user, g.username);
    if (g.password) setValue(login.pw, g.password);
  }

  // ---- Save banner --------------------------------------------------------
  let banner = null;
  function bannerBox() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#0f2350;color:#fff;" +
      "font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;padding:12px 14px;border-radius:10px;" +
      "box-shadow:0 10px 34px rgba(0,0,0,.4);max-width:340px;display:flex;gap:10px;align-items:center;";
    return el;
  }
  function toast(text) {
    const t = bannerBox();
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }
  function offerSave(cred) {
    if (!cred || !cred.password) return;
    if (banner) banner.remove();
    banner = bannerBox();
    const span = document.createElement("span");
    span.style.flex = "1";
    span.textContent = `🔐 ${host} girişini kasaya kaydet?`;
    const save = document.createElement("button");
    save.textContent = "Kaydet";
    save.style.cssText = "background:#2458e6;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font-weight:600;";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText = "background:transparent;color:#9fb0d0;border:0;cursor:pointer;font-size:15px;line-height:1;";
    save.onclick = async () => {
      banner && banner.remove();
      banner = null;
      const r = await api({ type: "save", url: cred.url, username: cred.username, password: cred.password });
      await api({ __internal: "clearPending", host });
      toast(r && r.ok ? "Kasaya kaydedildi ✓" : `Kaydedilemedi: ${(r && r.error) || "?"}`);
    };
    close.onclick = () => { banner && banner.remove(); banner = null; };
    banner.append(span, save, close);
    document.documentElement.appendChild(banner);
    setTimeout(() => { if (banner) { banner.remove(); banner = null; } }, 20000);
  }

  function capture() {
    const login = findLogin();
    if (!login || !login.pw.value) return null;
    return { url: location.href, username: login.user ? login.user.value : "", password: login.pw.value };
  }

  async function captureAndOffer() {
    const cred = capture();
    if (!cred) return;
    await api({ __internal: "stashPending", host, cred }); // survive a navigation
    offerSave(cred);
  }

  // ---- Wire document-level events ONCE ------------------------------------
  document.addEventListener("submit", () => captureAndOffer(), true);
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest && e.target.closest('button,[type="submit"],[role="button"]');
      if (!btn) return;
      const cred = capture();
      if (cred) setTimeout(() => offerSave(cred), 300);
    },
    true,
  );
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") setTimeout(captureAndOffer, 0); }, true);

  // ---- Attach focus-autofill to login fields (idempotent) -----------------
  function wire() {
    const login = findLogin();
    if (!login) return;
    for (const f of [login.pw, login.user]) {
      if (f && !focused.has(f)) {
        focused.add(f);
        f.addEventListener("focus", autofill);
      }
    }
  }
  wire();
  new MutationObserver(() => wire()).observe(document.documentElement, { childList: true, subtree: true });

  // ---- Popup-triggered fill ----------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _s, resp) => {
    if (!msg || !msg.__fill) return undefined;
    (async () => {
      const login = findLogin();
      const g = await api({ type: "get", id: msg.id });
      if (login && g && g.ok) {
        if (login.user && g.username) setValue(login.user, g.username);
        if (g.password) setValue(login.pw, g.password);
      }
      resp({ ok: !!login });
    })();
    return true;
  });

  // ---- On load, re-offer a save that a navigation interrupted -------------
  (async () => {
    const p = await api({ __internal: "getPending", host });
    if (p && p.ok && p.cred) offerSave(p.cred);
  })();
})();
