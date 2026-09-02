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

// ---------- FlameBrowser account + cloud sync ----------
let currentUser = null;
let syncTimer = null;
let authMode = "login";

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && options.body !== null) headers["Content-Type"] = "application/json";
  else delete headers["Content-Type"];
  const res = await fetch(path, { credentials: "include", ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function localBookmarks() {
  try { return JSON.parse(localStorage.getItem("bookmarks") || "[]"); } catch { return []; }
}
function saveLocalBookmarks(v) { localStorage.setItem("bookmarks", JSON.stringify(v)); }
function collectTabs() {
  return tabs.map(t => ({url:t.url, title:t.title || "New tab"})).slice(0, 100);
}
function scheduleSync() {
  if (!currentUser) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 500);
}
async function syncNow() {
  if (!currentUser) return;
  try {
    await api("/api/sync", {method:"PUT", body:JSON.stringify({
      bookmarks: localBookmarks(),
      tabs: collectTabs(),
      settings: {
        proxy: localStorage.getItem("proxy") || defaultPrefs.proxy,
        startup: localStorage.getItem("startup") || defaultPrefs.startup,
        smoothLoading: localStorage.getItem("smoothLoading") !== "false",
        compactTabs: localStorage.getItem("compactTabs") === "true"
      }
    })});
  } catch(e) { console.warn("[FlameBrowser] sync failed", e); }
}
async function restoreCloudData() {
  if (!currentUser) return;
  const data = await api("/api/sync");
  if (Array.isArray(data.bookmarks)) saveLocalBookmarks(data.bookmarks);
  if (data.settings && typeof data.settings === "object") {
    for (const [k,v] of Object.entries(data.settings)) localStorage.setItem(k, String(v));
    loadSettingsUI();
  }
  if (!window.__flameCloudTabsRestored && Array.isArray(data.tabs) && data.tabs.length && controller) {
    window.__flameCloudTabsRestored = true;
    for (const t of data.tabs) if (t && t.url) createTab(normalize(t.url));
  }
}
function setUserUI() {
  const btn = $("#accountBtn");
  if (!btn) return;
  btn.textContent = currentUser ? `👤 ${currentUser.name || currentUser.email}` : "Sign in";
}
function openAuth() {
  $("#authModal").classList.remove("hidden");
  $("#authError").textContent = "";
  $("#authNameWrap").classList.toggle("hidden", authMode === "login");
  $("#authTitle").textContent = authMode === "login" ? "Sign in to FlameBrowser" : "Create your FlameBrowser account";
}
function closeAuth() { $("#authModal").classList.add("hidden"); }
function setAuthMode(mode) { authMode = mode; openAuth(); }
async function submitAuth(e) {
  e.preventDefault();
  const email = $("#authEmail").value;
  const password = $("#authPassword").value;
  const name = $("#authName").value;
  $("#authError").textContent = "";
  try {
    const data = await api(authMode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method:"POST", body:JSON.stringify({email,password,name})
    });
    currentUser = data.user;
    closeAuth(); setUserUI();
    await restoreCloudData();
    setStatus(`Signed in as ${currentUser.name || currentUser.email}`);
  } catch(e) { $("#authError").textContent = e.message; }
}
async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    currentUser = null;
    window.__flameCloudTabsRestored = false;
    setUserUI();
    localStorage.removeItem("bookmarks");
    for (const key of ["proxy", "startup", "smoothLoading", "compactTabs"]) localStorage.removeItem(key);
    setStatus("Signed out");
  }
}
async function bootAuth() {
  // Authentication is NEVER restored from localStorage/sessionStorage.
  // Only the server-side HttpOnly flame_session cookie can sign the user in.
  currentUser = null;
  window.__flameCloudTabsRestored = false;
  setUserUI();
  try {
    const data = await api("/api/me");
    currentUser = data.user || null;
    setUserUI();
    if (currentUser) await restoreCloudData();
  } catch (e) {
    currentUser = null;
    setUserUI();
    console.warn("[FlameBrowser] account check failed:", e);
  }
}
async function loadGoogleIdentityServices() {
  if (window.google?.accounts?.id) return true;
  return await new Promise((resolve) => {
    const existing = document.querySelector('script[data-google-gis]');
    if (existing) {
      existing.addEventListener('load', () => resolve(!!window.google?.accounts?.id), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleGis = '1';
    script.onload = () => resolve(!!window.google?.accounts?.id);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

async function setupGoogle() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  const container = $('#googleBtn');
  if (!container) return;
  container.innerHTML = '';

  if (!cfg.googleClientId) {
    container.innerHTML = '<div class="google-config-error">Google Sign-In is not configured.</div>';
    return;
  }

  const loaded = await loadGoogleIdentityServices();
  if (!loaded) {
    container.innerHTML = '<button type="button" class="google-fallback" id="googleRetry">Continue with Google</button>';
    $('#googleRetry')?.addEventListener('click', () => setupGoogle());
    return;
  }

  window.google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: async (response) => {
      try {
        const data = await api('/api/auth/google', {method:'POST', body:JSON.stringify({credential:response.credential})});
        currentUser = data.user;
        closeAuth();
        setUserUI();
        await restoreCloudData();
        setStatus(`Signed in as ${currentUser.name || currentUser.email}`);
      } catch(e) {
        $('#authError').textContent = e.message;
      }
    }
  });

  window.google.accounts.id.renderButton(container, {
    theme: 'filled_black',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
    width: 320
  });
}


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
bootAuth().then(() => setupGoogle()).catch(console.error);
window.addEventListener("beforeunload", () => { if (currentUser) syncNow(); });
