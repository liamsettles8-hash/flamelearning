const QUICK_SITES = [
  {name:"Google", desc:"Search the web", icon:"G", url:"https://www.google.com/"},
  {name:"YouTube", desc:"Watch videos", icon:"▶", url:"https://www.youtube.com/"},
  {name:"Wikipedia", desc:"Explore knowledge", icon:"W", url:"https://www.wikipedia.org/"},
  {name:"Reddit", desc:"Communities & posts", icon:"R", url:"https://www.reddit.com/"},
  {name:"GitHub", desc:"Code & projects", icon:"⌘", url:"https://github.com/"},
  {name:"Discord", desc:"Communities & chat", icon:"D", url:"https://discord.com/"},
  {name:"Twitch", desc:"Live streams", icon:"T", url:"https://www.twitch.tv/"},
  {name:"MDN", desc:"Web documentation", icon:"M", url:"https://developer.mozilla.org/"}
];

const $ = (s) => document.querySelector(s);
const home = $("#home");
const browser = $("#browser");
const viewport = $("#viewport");
const tabsEl = $("#tabs");
const address = $("#address");
const status = $("#status");

let controller;
let tabs = [];
let activeTab = -1;

// ---------- FlameLearning Firebase account + Firestore queue ----------
let currentUser = null;
let syncTimer = null;
let authMode = "login";
let firebaseReady = false;
let quotaPopupShown = false;

function firebase() { return window.FlameFirebase; }
function isFirestoreQuotaError(e) {
  const code = String(e?.code || "").toLowerCase();
  const msg = String(e?.message || "").toLowerCase();
  return code.includes("resource-exhausted") || code.includes("quota") || msg.includes("quota") || msg.includes("resource exhausted");
}
function showQuotaPopup() {
  if (quotaPopupShown) return;
  quotaPopupShown = true;
  let modal = document.getElementById("quotaPopup");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "quotaPopup";
    modal.className = "modal";
    modal.innerHTML = `<div class="auth-card quota-card"><button class="auth-close" id="quotaClose">×</button><h2>Firestore quota ran out</h2><p>Firestore quota is the daily amount of database reads, writes, and other operations Firebase allows for your project. The project has reached its available quota, so FlameLearning cannot complete Firestore requests right now.</p><p><b>Dev note:</b> this resets every day — too bad for the other peeps not getting time :sob:</p><button class="auth-submit" id="quotaOk">OK</button></div>`;
    document.body.appendChild(modal);
    const close = () => { modal.classList.add("hidden"); quotaPopupShown = false; };
    modal.querySelector("#quotaClose").onclick = close;
    modal.querySelector("#quotaOk").onclick = close;
  }
  modal.classList.remove("hidden");
}
function handleFirestoreError(e) {
  if (isFirestoreQuotaError(e)) showQuotaPopup();
  return e;
}

async function queueAgentRequest(payload) {
  const f = firebase();
  if (!f?.auth?.currentUser) throw new Error("Sign in is required for agent requests.");
  const id = crypto.randomUUID();
  try {
    await f.firestore.setDoc(f.firestore.doc(f.db, "agentRequests", id), {
      ...payload, id, uid: f.auth.currentUser.uid, status: "pending", createdAt: f.firestore.serverTimestamp()
    });
  } catch (e) { handleFirestoreError(e); throw e; }
  return id;
}

async function waitForAgentRequest(id, timeoutMs = 30000) {
  const f = firebase();
  const ref = f.firestore.doc(f.db, "agentRequests", id);
  return await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; unsub(); reject(new Error("Agent request timed out.")); } }, timeoutMs);
    const unsub = f.firestore.onSnapshot(ref, snap => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.status === "completed" || data.status === "error" || data.status === "quota") {
        done = true; clearTimeout(timer); unsub();
        if (data.status === "quota") showQuotaPopup();
        if (data.status === "error" || data.status === "quota") reject(new Error(data.error || "Agent request failed."));
        else resolve(data);
      }
    }, e => { if (!done) { done = true; clearTimeout(timer); unsub(); handleFirestoreError(e); reject(e); } });
  });
}

async function api(path, options = {}) {
  // Legacy local-agent endpoints are retained for health/config compatibility.
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && options.body !== null) headers["Content-Type"] = "application/json";
  else delete headers["Content-Type"];
  const res = await fetch(path, { credentials: "include", ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function localBookmarks() { try { return JSON.parse(localStorage.getItem("bookmarks") || "[]"); } catch { return []; } }
function saveLocalBookmarks(v) { localStorage.setItem("bookmarks", JSON.stringify(v)); }
function collectTabs() { return tabs.map(t => ({url:t.url, title:t.title || "New tab"})).slice(0, 100); }
async function saveCloud() {
  const f = firebase();
  if (!f?.auth?.currentUser) return;
  try {
    await f.firestore.setDoc(f.firestore.doc(f.db, "users", f.auth.currentUser.uid), {
      email: f.auth.currentUser.email || "", name: f.auth.currentUser.displayName || "", bookmarks: localBookmarks(), tabs: collectTabs(), settings: prefs(), updatedAt: f.firestore.serverTimestamp()
    }, { merge: true });
  } catch (e) { handleFirestoreError(e); console.warn("[FlameLearning] sync failed", e); }
}
function scheduleSync() { if (!currentUser) return; clearTimeout(syncTimer); syncTimer = setTimeout(saveCloud, 500); }
async function restoreCloudData() {
  const f = firebase();
  if (!f?.auth?.currentUser) return;
  try {
    const snap = await f.firestore.getDoc(f.firestore.doc(f.db, "users", f.auth.currentUser.uid));
    if (!snap.exists()) return;
    const data = snap.data();
    if (Array.isArray(data.bookmarks)) saveLocalBookmarks(data.bookmarks);
    if (data.settings && typeof data.settings === "object") { for (const [k,v] of Object.entries(data.settings)) localStorage.setItem(k, String(v)); loadSettingsUI(); }
    if (!window.__flameCloudTabsRestored && Array.isArray(data.tabs) && data.tabs.length && controller) {
      window.__flameCloudTabsRestored = true;
      for (const t of data.tabs) if (t?.url) createTab(normalize(t.url));
    }
  } catch (e) { handleFirestoreError(e); console.warn("[FlameLearning] restore failed", e); }
}
function setUserUI() {
  const btn = $("#accountBtn");
  if (!btn) return;
  btn.textContent = currentUser ? `👤 ${currentUser.displayName || currentUser.email}` : "Sign in";
}
function openAuth() { $("#authModal").classList.remove("hidden"); $("#authError").textContent = ""; $("#authNameWrap").classList.toggle("hidden", authMode === "login"); $("#authTitle").textContent = authMode === "login" ? "Sign in to FlameLearning" : "Create your FlameLearning account"; }
function closeAuth() { $("#authModal").classList.add("hidden"); }
function setAuthMode(mode) { authMode = mode; openAuth(); }
async function submitAuth(e) {
  e.preventDefault();
  try { await firebase().email($("#authEmail").value, $("#authPassword").value, authMode === "register", $("#authName").value); }
  catch(e) { $("#authError").textContent = e.message; }
}
async function signOut() { try { await firebase().signOut(); } catch(e) { console.warn(e); } }

async function setupGoogle() {
  const btn = $("#googleBtn");
  if (!btn) return;
  btn.innerHTML = `<button type="button" class="google-fallback" id="firebaseGoogleBtn">Continue with Google</button>`;
  $("#firebaseGoogleBtn").onclick = async () => {
    $("#authError").textContent = "";
    try { await firebase().google(); }
    catch(e) { $("#authError").textContent = e.message; }
  };
}

function bootAuth() {
  if (!window.FlameFirebase) { setTimeout(bootAuth, 100); return; }
  firebaseReady = true;
  firebase().onAuth(async user => {
    currentUser = user || null;
    window.__flameCloudTabsRestored = false;
    setUserUI();
    if (currentUser) { closeAuth(); await restoreCloudData(); setStatus(`Signed in as ${currentUser.displayName || currentUser.email}`); }
  });
  setupGoogle();
}

bootAuth();


function normalize(input) {
  const value = input.trim();
  if (!value) return "https://www.google.com/";
  try {
    return new URL(value).href;
  } catch {}
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function showHome() {
  home.classList.remove("hidden");
  browser.classList.add("hidden");
}

function showBrowser() {
  home.classList.add("hidden");
  browser.classList.remove("hidden");
}

function setStatus(text, loading = false) {
  $("#statusText").textContent = text;
  const bar = $("#progress");
  const enabled = localStorage.getItem("smoothLoading") !== "false";
  bar.classList.toggle("loading", loading && enabled);
  if (!loading) bar.style.width = "0";
}

function renderQuick() {
  $("#quickGrid").innerHTML = QUICK_SITES.map(site => `
    <button class="quick-card" data-url="${site.url}">
      <span class="quick-icon">${site.icon}</span>
      <strong>${site.name}</strong>
      <small>${site.desc}</small>
    </button>
  `).join("");

  document.querySelectorAll(".quick-card").forEach(card => {
    card.addEventListener("click", () => openBrowser(card.dataset.url));
  });
}

function renderTabs() {
  tabsEl.innerHTML = tabs.map((tab, i) => `
    <div class="tab ${i === activeTab ? "active" : ""}" data-i="${i}">
      <span>${escapeHtml(tab.title || "New tab")}</span>
      <button aria-label="Close tab" data-close="${i}">×</button>
    </div>
  `).join("");

  tabsEl.querySelectorAll(".tab").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.close !== undefined) return;
      activateTab(Number(el.dataset.i));
    });
  });

  tabsEl.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(Number(btn.dataset.close));
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}


const defaultPrefs = {
  proxy: "libcurl",
  startup: "home",
  smoothLoading: true,
  compactTabs: false
};

function prefs() {
  return {
    proxy: localStorage.getItem("proxy") || defaultPrefs.proxy,
    startup: localStorage.getItem("startup") || defaultPrefs.startup,
    smoothLoading: localStorage.getItem("smoothLoading") !== "false",
    compactTabs: localStorage.getItem("compactTabs") === "true"
  };
}

function loadSettingsUI() {
  const p = prefs();
  $("#proxySelect").value = p.proxy;
  $("#startupSelect").value = p.startup;
  $("#smoothLoading").checked = p.smoothLoading;
  $("#compactTabs").checked = p.compactTabs;
  document.body.classList.toggle("compact", p.compactTabs);
}

function saveSetting(key, value) {
  localStorage.setItem(key, String(value));
  loadSettingsUI();
}

function toggleSettings(force) {
  const el = $("#settings");
  el.classList.toggle("hidden", force === undefined ? !el.classList.contains("hidden") : !force);
}

async function bootScramjet() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers.");

  const registration = await navigator.serviceWorker.register("/sw.js", {scope:"/"});
  await navigator.serviceWorker.ready;

  const worker = navigator.serviceWorker.controller || registration.active;
  if (!worker) {
    await new Promise(resolve => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {once:true});
    });
  }

  const wispUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
  const selected = prefs().proxy;
  const modulePath = selected === "epoxy" ? "/epoxy/index.mjs" : "/libcurl/index.mjs";
  const { default: Transport } = await import(modulePath);
  const transport = new Transport({wisp: wispUrl});

  const { Controller } = window.$scramjetController;
  controller = new Controller({
    serviceworker: navigator.serviceWorker.controller || registration.active,
    transport,
    config: {
      prefix: "/~/sj/",
      scramjetPath: "/scram/scramjet.js",
      injectPath: "/controller/controller.inject.js",
      wasmPath: "/scram/scramjet.wasm",
      virtualWasmPath: "scramjet.wasm.js"
    },
    scramjetConfig: {
      flags: {
        allowFailedIntercepts: true,
        allowInvalidJs: true,
        encapsulateWorkers: true,
        destructureRewrites: true,
        sourcemaps: true
      }
    }
  });

  await controller.wait();
  console.info("[FlameBrowser] Scramjet controller ready", controller.config);
  setStatus("Scramjet ready");
}

function createTab(url) {
  const iframe = document.createElement("iframe");
  iframe.className = "frame";
  iframe.allow = "fullscreen; autoplay; clipboard-read; clipboard-write";
  viewport.appendChild(iframe);

  const utils = window.$scramjetUtils;
  const frame = controller.createFrame(iframe, {
    plugins: [
      new utils.HttpCachePlugin(),
      new utils.UrlWatcherPlugin((nextUrl) => {
        const idx = tabs.findIndex(t => t.frame === frame);
        if (idx !== -1) {
          tabs[idx].url = nextUrl;
          if (idx === activeTab) address.value = nextUrl;
          renderTabs();
        }
      })
    ]
  });

  const tab = {frame, iframe, url, title:"New tab"};
  tabs.push(tab);
  activeTab = tabs.length - 1;
  setStatus("Loading " + new URL(url).hostname + "…", true);
  frame.go(url);
  iframe.addEventListener("load", () => {
    try {
      tab.title = iframe.contentDocument?.title || new URL(tab.url).hostname;
    } catch {
      tab.title = new URL(tab.url).hostname;
    }
    renderTabs();
    setStatus("Ready");
  });

  iframe.addEventListener("error", (event) => {
    console.error("[FlameBrowser] iframe error", event);
    setStatus("The site reported a loading error");
  });

  renderTabs();
  activateTab(activeTab);
  scheduleSync();
}

function activateTab(index) {
  if (!tabs[index]) return;
  activeTab = index;
  tabs.forEach((tab, i) => tab.iframe.classList.toggle("active", i === index));
  address.value = tabs[index].url || "";
  renderTabs();
  setStatus(`Tab ${index + 1}`);
}

function closeTab(index) {
  if (!tabs[index]) return;
  tabs[index].iframe.remove();
  tabs.splice(index, 1);
  if (!tabs.length) {
    createTab("https://www.google.com/");
    return;
  }
  activeTab = Math.min(activeTab, tabs.length - 1);
  activateTab(activeTab);
  scheduleSync();
}

function openBrowser(url) {
  showBrowser();
  const target = normalize(url);
  if (!controller) {
    bootScramjet().then(() => createTab(target)).catch(err => {
      console.error(err);
      setStatus(`Proxy startup failed: ${err.message}`);
    });
  } else {
    createTab(target);
  }
}

$("#homeForm").addEventListener("submit", e => {
  e.preventDefault();
  openBrowser($("#homeAddress").value);
});

$("#addressForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!tabs[activeTab]) return;
  const target = normalize(address.value);
  tabs[activeTab].url = target;
  setStatus("Loading " + new URL(target).hostname + "…", true);
  tabs[activeTab].frame.go(target);
});

$("#openBrowser").addEventListener("click", () => openBrowser("https://www.google.com/"));
$("#homeBtn").addEventListener("click", showHome);

$("#backBtn").addEventListener("click", () => {
  tabs[activeTab]?.frame.back();
});
$("#forwardBtn").addEventListener("click", () => {
  tabs[activeTab]?.frame.forward();
});
$("#reloadBtn").addEventListener("click", () => {
  tabs[activeTab]?.frame.reload();
});
$("#newTabBtn").addEventListener("click", () => openBrowser("https://www.google.com/"));


$("#settingsBtn").addEventListener("click", () => toggleSettings());
$("#closeSettings").addEventListener("click", () => toggleSettings(false));
$("#proxySelect").addEventListener("change", e => {
  saveSetting("proxy", e.target.value);
  setStatus(`Transport: ${e.target.value}. Reload to apply.`);
});
$("#startupSelect").addEventListener("change", e => saveSetting("startup", e.target.value));
$("#smoothLoading").addEventListener("change", e => saveSetting("smoothLoading", e.target.checked));
$("#compactTabs").addEventListener("change", e => saveSetting("compactTabs", e.target.checked));
$("#clearPrefs").addEventListener("click", () => {
  Object.keys(defaultPrefs).forEach(k => localStorage.removeItem(k));
  loadSettingsUI();
  setStatus("Settings reset");
});

loadSettingsUI();

renderQuick();
showHome();

$("#accountBtn")?.addEventListener("click", () => currentUser ? $("#accountMenu").classList.toggle("hidden") : openAuth());
$("#authClose")?.addEventListener("click", closeAuth);
$("#authForm")?.addEventListener("submit", submitAuth);
$("#switchAuth")?.addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
$("#logoutBtn")?.addEventListener("click", signOut);
$("#settingsBtn")?.addEventListener("click", () => toggleSettings());
for (const key of ["proxy","startup","smoothLoading","compactTabs"]) {
  const el = document.getElementById(key === "proxy" ? "proxySelect" : key === "startup" ? "startupSelect" : key);
  el?.addEventListener("change", scheduleSync);
}

window.addEventListener("beforeunload", () => { if (currentUser) saveCloud(); });
