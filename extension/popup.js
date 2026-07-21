const api = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

async function main() {
  const st = await api({ type: "status" });
  if (!st || !st.ok) {
    statusEl.textContent = "Native host bulunamadı — `pm-cli browser-install` çalıştır.";
    return;
  }
  if (!st.unlocked) {
    statusEl.textContent = "Kasa kilitli (kurulum eksik veya farklı kullanıcı).";
    return;
  }
  statusEl.textContent = `Kasa açık • ${st.count} kayıt`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  const q = await api({ type: "query", url: tab.url });
  const matches = (q && q.ok && q.matches) || [];
  if (matches.length === 0) {
    listEl.innerHTML = `<div class="empty">Bu site için kayıtlı giriş yok.<br/>Giriş yaptığında "Kaydet"e basman yeterli.</div>`;
    return;
  }
  for (const m of matches) {
    const row = document.createElement("div");
    row.className = "item";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<div class="name"></div><div class="user"></div>`;
    meta.querySelector(".name").textContent = m.name;
    meta.querySelector(".user").textContent = m.username || "—";
    const btn = document.createElement("button");
    btn.textContent = "Doldur";
    btn.onclick = async () => {
      await chrome.tabs.sendMessage(tab.id, { __fill: true, id: m.id });
      window.close();
    };
    row.append(meta, btn);
    listEl.appendChild(row);
  }
}

main().catch((e) => (statusEl.textContent = "Hata: " + e));
