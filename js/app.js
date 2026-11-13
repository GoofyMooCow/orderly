// ============================================================
// Cookie helpers
// ============================================================
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(";").shift();
    return null;
}

function setCookie(name, value, maxAgeSeconds) {
    document.cookie = `${name}=${value}; path=/; max-age=${maxAgeSeconds}`;
}

function clearCookie(name) {
    document.cookie = `${name}=; path=/; max-age=0`;
}

let authToken = getCookie("authToken") || null;

const WS_BASE = "wss://scaling-fidgeting-blooming.ngrok-free.dev";
// Where to send people who aren't signed in (or whose session is no longer valid).
const LOGIN_URL = "../login";

const appEl = document.getElementById("app");
const bootMsg = document.getElementById("bootMsg");

function goToLogin(notice) {
    loggingOut = true;
    clearCookie("authToken");
    try {
        if (notice) sessionStorage.setItem("authNotice", notice);
    } catch (e) {
    }
    location.replace(LOGIN_URL);
}

// Keep the invite token so login can show the banner and the app can handle it afterwards.
let pendingInvite = null;
(function captureInviteToken() {
    let token = null;
    try {
        const fromQuery = new URLSearchParams(location.search).get("invite");
        const fromHash = /[#&]invite=([^&]+)/.exec(location.hash);
        token = fromQuery || (fromHash ? decodeURIComponent(fromHash[1]) : null);
        if (token) {
            sessionStorage.setItem("pendingInvite", token);
            const url = new URL(location.href);
            url.searchParams.delete("invite");
            if (fromHash) url.hash = "";
            history.replaceState(history.state, "", url.pathname + url.search + url.hash);
        } else {
            token = sessionStorage.getItem("pendingInvite");
        }
    } catch (e) {
    }
    pendingInvite = token ? String(token).slice(0, 200) : null;
})();

function clearPendingInvite() {
    pendingInvite = null;
    try {
        sessionStorage.removeItem("pendingInvite");
    } catch (e) {
    }
}

// ============================================================
// Theme preference
// ============================================================
function applyThemePreference(isDark) {
    document.body.classList.toggle("dark", isDark);
    setCookie("theme", isDark ? "dark" : "light", 31536000);
    const themeSetting = document.getElementById("themeSettingToggle");
    if (themeSetting) themeSetting.checked = isDark;
}

if (getCookie("theme") === "dark") applyThemePreference(true);

// ============================================================
// Mobile detection + sidebar toggle
// ============================================================
const MOBILE_BREAKPOINT = 768;

function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
}

const sidebarEl = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const mobileMenuBtn = document.getElementById("mobileMenuBtn");

function openSidebar() {
    sidebarEl.classList.add("mobile-open");
    sidebarOverlay.style.display = "block";
    updateBottomNav();
}

function closeSidebar() {
    sidebarEl.classList.remove("mobile-open");
    sidebarOverlay.style.display = "none";
    updateBottomNav();
}

function toggleSidebar() {
    if (sidebarEl.classList.contains("mobile-open")) closeSidebar();
    else openSidebar();
}

if (mobileMenuBtn) mobileMenuBtn.addEventListener("click", toggleSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

// Close the mobile sidebar automatically after navigating somewhere
function closeSidebarIfMobile() {
    if (isMobile()) closeSidebar();
}

window.addEventListener("resize", () => {
    if (!isMobile()) closeSidebar();
});

// ============================================================
// App state
// ============================================================
let ws = null;
let currentUser = null;
let pending = new Map();
let reqCounter = 0;
let dashboard = {projects: [], standalone_lists: []};
let currentList = null;
let currentView = "welcome";
let collapsedProjects = new Set();
let expandedTasks = new Set();   // tasks whose subtask list is open
let notifications = [];

// ---------- User settings (loaded from the server; see the Settings page) ----------
let appSettings
    = {week_start: "sun", time_format: "12h", default_priority: "normal", show_completed_tasks: true, timezone: ""};
let settingsData = null;
let pendingEmailNotice = false;
try {
    pendingEmailNotice = sessionStorage.getItem("emailPending") === "1";
    sessionStorage.removeItem("emailPending");
} catch (e) {
}

// ---------- Sort preferences ----------
const SORT_OPTIONS = [
    {value: "default", label: "Default order"},
    {value: "name", label: "Name (A–Z)"},
    {value: "priority", label: "Priority (High first)"},
    {value: "deadline", label: "Deadline (Soonest)"},
    {value: "created", label: "Date added (Newest)"},
];

let sortPrefs = {};
try {
    sortPrefs = JSON.parse(getCookie("sortPrefs") || "{}");
} catch (e) {
    sortPrefs = {};
}

function getSortPref(listId) {
    return sortPrefs[listId] || "default";
}

function setSortPref(listId, value) {
    sortPrefs[listId] = value;
    setCookie("sortPrefs", JSON.stringify(sortPrefs), 31536000);
}

const PRIORITY_RANK = {high: 0, normal: 1, low: 2};

function sortTaskGroup(tasks, sortBy) {
    const arr = tasks.slice();
    switch (sortBy) {
        case "name":
            arr.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case "priority":
            arr.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
            break;
        case "deadline":
            arr.sort((a, b) => {
                if (!a.deadline && !b.deadline) return 0;
                if (!a.deadline) return 1;
                if (!b.deadline) return -1;
                const da = deadlineDateTime(a.deadline, a.deadline_time).getTime();
                const db = deadlineDateTime(b.deadline, b.deadline_time).getTime();
                return da - db;
            });
            break;
        case "created":
            arr.sort((a, b) => b.id - a.id);
            break;
        default:
            arr.sort((a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || (a.id - b.id));
    }
    return arr;
}

function getSortedTasksForDisplay() {
    if (!currentList) return [];
    const sortBy = getSortPref(currentList.id);
    const visible = xFilterActive() ? currentList.tasks.filter(xTaskMatchesFilter) : currentList.tasks;
    const incomplete = visible.filter((t) => !t.completed);
    const completed = appSettings.show_completed_tasks
        ? visible.filter((t) => t.completed)
            .sort((a, b) => (a.completed_at || "").localeCompare(b.completed_at || ""))
        : [];
    return sortTaskGroup(incomplete, sortBy).concat(completed);
}

// ---------- Repeating tasks ----------
// Repeats are typed as a phrase ("every mon, fri", "every! 3 days"), Todoist-style.
// The server parses it, sets the first due date if none was given, and when the task
// is completed moves it to its next future date instead of closing it.
function repeatBadgeHtml(task) {
    return task.repeat
        ? `<span class="repeat-badge" title="Repeats: ${escapeHtml(task.repeat)}">${iconSvg("repeat")} ${escapeHtml(task.repeat)}</span>`
        : "";
}

// ============================================================
// Live connection, with automatic reconnect
//
// If the connection drops (server restart, flaky mobile signal, phone asleep, laptop lid closed) the page
// keeps trying again in the background, backing off from 1s up to ~15s. A small banner shows while
// it's down. When it comes back, everything is reloaded so nothing missed in the meantime is lost.
// ============================================================
const REQUEST_TIMEOUT_MS = 20000;
let socketReady = false; // the server accepted our token on the current socket
let synced = false; // the dashboard etc. have been (re)loaded on the current socket
let sessionActive = false; // set once we've entered the app
let loggingOut = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let reconnecting = false;
let heartbeatTimer = null;
let bannerTimer = null;
let offlineShown = false;

const connBanner = document.getElementById("connBanner");
const connBannerText = document.getElementById("connBannerText");

function updateBannerText() {
    connBannerText.textContent = navigator.onLine === false
        ? "You're offline. We'll reconnect when you're back."
        : "Connection lost. Reconnecting…";
}

function setOffline(isOffline) {
    if (isOffline) {
        if (offlineShown || bannerTimer) return;
        // A very short blip (like a phone waking up) shouldn't flash a banner.
        bannerTimer = setTimeout(() => {
            bannerTimer = null;
            offlineShown = true;
            updateBannerText();
            connBanner.classList.add("visible");
        }, 900);
    } else {
        clearTimeout(bannerTimer);
        bannerTimer = null;
        if (offlineShown) {
            offlineShown = false;
            connBanner.classList.remove("visible");
            showToast("Back online");
        }
    }
}

function makeOfflineError(message) {
    const e = new Error(message);
    e.offline = true;
    return e;
}

function rejectPending(err) {
    pending.forEach((p) => p.reject(err));
    pending.clear();
}

function handleAuthFailure(err) {
    goToLogin(/password was changed/.test(err.message) ? err.message : "Please sign in again.");
}

function onSocketClosed(ev, sock) {
    socketReady = false;
    synced = false;
    stopHeartbeat();
    rejectPending(makeOfflineError("The connection dropped. Please try again."));
    if (loggingOut || !sessionActive || sock.authFailed) return;
    if (ev && ev.code === 4001 && currentUser) {
        handleAuthFailure(new Error("Your password was changed. Please sign in again."));
        return;
    }
    setOffline(true);
    scheduleReconnect();
}

function scheduleReconnect(immediate) {
    if (loggingOut) return;
    if (reconnectTimer && !immediate) return;
    clearTimeout(reconnectTimer);
    const base = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
    const delay = immediate ? 0 : base * (0.75 + Math.random() * 0.5);
    reconnectTimer = setTimeout(attemptReconnect, delay);
}

async function attemptReconnect() {
    reconnectTimer = null;
    if (reconnecting || loggingOut) return;
    if (socketReady && synced) return;
    reconnecting = true;
    try {
        if (!(socketReady && ws && ws.readyState === WebSocket.OPEN)) await connectAppSocket();
        await loadEverything();
        synced = true;
        reconnectAttempt = 0;
        startHeartbeat();
        setOffline(false);
        handlePendingInvite().catch(() => {
        });
    } catch (err) {
        if (err && err.authFailed) {
            handleAuthFailure(err);
            return;
        }
        // A connection that opens but never answers is as good as dead: throw it away and start fresh next time.
        if (err && err.offline && socketReady && ws) dropSocket(ws);
        reconnectAttempt++;
        scheduleReconnect();
    } finally {
        reconnecting = false;
    }
}

function reconnectNow() {
    reconnectAttempt = 0;
    if (reconnecting && ws && ws.readyState === WebSocket.CONNECTING) {
        try {
            ws.close();
        } catch (e) {
        }
        return;
    }
    scheduleReconnect(true);
}

// Phones often leave a socket "open" that is really dead. A small ping every so often finds out.
function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(pingServer, 25000);
}

function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function dropSocket(sock) {
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    try {
        sock.close();
    } catch (e) {
    }
    onSocketClosed({code: 4000}, sock);
}

async function pingServer() {
    if (!socketReady) return;
    const sock = ws;
    try {
        await Promise.race([
            call("ping"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
    } catch (e) {
        if (sock === ws && socketReady) dropSocket(sock);
    }
}

function checkConnectionSoon() {
    if (!sessionActive || loggingOut) return;
    if (socketReady) pingServer();
    else {
        reconnectAttempt = 0;
        scheduleReconnect(true);
    }
}

document.addEventListener("visibilitychange", ()=> {
    if (document.visibilityState === "visible") checkConnectionSoon();
});
window.addEventListener("online", checkConnectionSoon);
window.addEventListener("offline", () => {
    if (offlineShown) updateBannerText();
});
document.getElementById("connRetryBtn").addEventListener("click", reconnectNow);

// Everything the page shows that comes from the server. Also used to catch up after a reconnect.
async function loadEverything() {
    renderProfile();
    await Promise.all([loadDashboard(), refreshNotifications(), loadSettings()]);
    await refreshCurrentView();
}

async function refreshCurrentView() {
    try {
        if (currentView === "list" && currentList) await openList(currentList.id);
        else if (currentView === "myTasks") await openMyTasks();
        else if (currentView === "calendar") await loadCalendar();
    } catch (err) {
        if (err && err.offline) throw err;
        if (currentView === "list") {
            currentList = null;
            switchView("welcome", {replace: true});
            renderSidebar();
            showToast("That list isn't available any more.");
        }
    }
}

// The loading screen stays up for at least this long (counted from page load) so it never just flashes,
// then fades out into the app.
const BOOT_MIN_MS = 900;
let appRevealed = false;

function revealApp() {
    if (appRevealed) return;
    appRevealed = true;
    const show = () => {
        if (bootMsg) bootMsg.remove();
        appEl.classList.add("visible");
        document.body.style.background = "#f8f9fb";
        document.body.style.display = "block";
    };
    if (!bootMsg) {
        show();
        return;
    }
    const wait = Math.max(0, BOOT_MIN_MS - performance.now());
    setTimeout(() => {
        bootMsg.classList.add("boot-out");
        setTimeout(show, 250);
    }, wait);
}

function enterApp() {
    sessionActive = true;
    navInit();
    connectAppSocket()
        .then(() => loadEverything())
        .then(() => {
            // Show the app only once its data is in, so the sidebar never appears empty.
            revealApp();
            synced = true;
            startHeartbeat();
            handlePendingInvite().catch(() => {
            });
            const e = settingsData && settingsData.email;
            if (!e || !e.address || e.verified) {
                pendingEmailNotice = false;
                return;
            }
            if (pendingEmailNotice && settingsData.email_service) {
                openSettings("settingsEmailCard");
                showToast("We emailed you a code. Enter it below to verify your email.");
            } else if (!pendingEmailNotice) {
                showToast("Your email isn't verified yet. Verify it in Settings to get emails.");
            }
            pendingEmailNotice = false;
        })
        .catch((err) => {
            // Bad or expired credentials: back to the login page.
            if (err && err.authFailed) {
                handleAuthFailure(err);
                return;
            }
            // Server just unreachable: show the app with the offline banner and keep retrying.
            revealApp();
            setOffline(true);
            scheduleReconnect();
        });
}

function connectAppSocket() {
    return new Promise((resolve, reject) => {
        const sock = new WebSocket(WS_BASE + "/ws/app");
        ws = sock;
        socketReady = false;
        let settled = false;
        const fail = (e) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(e);
            }
        };
        const timer = setTimeout(() => {
            fail(makeOfflineError("Connection timed out"));
            try {
                sock.close();
            } catch (e) {
            }
        }, 10000);
        sock.onopen = () => sock.send(JSON.stringify({token: authToken}));
        sock.onmessage = (evt) => {
            if (sock !== ws) return;
            let msg;
            try {
                msg = JSON.parse(evt.data);
            } catch (e) {
                return;
            }
            if (msg.type === "auth") {
                if (msg.ok) {
                    currentUser = msg.user;
                    socketReady = true;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve();
                    }
                } else {
                    sock.authFailed = true;
                    const e = new Error(msg.error || "auth failed");
                    e.authFailed = true;
                    fail(e);
                }
                return;
            }
            if (msg.type === "response") {
                const p = pending.get(msg.id);
                if (!p) return;
                pending.delete(msg.id);
                if (msg.ok) p.resolve(msg.data);
                else p.reject(new Error(msg.error || "request failed"));
                return;
            }
            if (msg.type === "event") handleLiveEvent(msg);
        };
        sock.onerror = () => fail(makeOfflineError("could not connect"));
        sock.onclose = (ev) => {
            clearTimeout(timer);
            fail(makeOfflineError("could not connect"));
            if (sock === ws) onSocketClosed(ev, sock);
        };
    });
}

function call(action, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN || !socketReady) {
            reject(makeOfflineError("You're offline right now. Reconnecting…"));
            return;
        }
        const id = "r" + (++reqCounter);
        // If the server never answers, give up on this request and check whether the connection is still alive.
        const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(makeOfflineError("The server isn't responding. Please try again."));
            checkConnectionSoon();
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
            resolve: (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            reject: (e) => {
                clearTimeout(timer);
                reject(e);
            },
        });
        try {
            ws.send(JSON.stringify({id, action, payload}));
        } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            reject(makeOfflineError("Couldn't send that. Please try again."));
        }
    });
}

document.getElementById("logoutLink").addEventListener("click", (e) => {
    e.preventDefault();
    loggingOut = true;
    try {
        if (ws) ws.close();
    } catch (err) {
    }
    clearCookie("authToken");
    location.replace(LOGIN_URL);
});

// ============================================================
// Back button (the phone's back arrow, the browser's back button, a swipe back)
// Every screen you open (a list, My Tasks, Calendar, Settings) is one history entry, so back returns
// to the screen before it. Anything open on top (a window, a confirm box, the notifications, the Lists
// sheet) is closed first, and you stay on the screen you were on. Back from the first screen leaves the
// page, as usual. The address never changes, so invite links and reloads are unaffected.
// ============================================================
let navReady = false;
let navRestoring = 0;

function navState() {
    return {orderly: 1, view: currentView, listId: currentView === "list" && currentList ? currentList.id : null};
}

function navInit() {
    if (navReady) return;
    try {
        history.replaceState({orderly: 1, base: true}, "");   // a stop below the first screen, so back can close windows there too
        history.pushState(navState(), "");
        navReady = true;
    } catch (e) {
        navReady = false;
    }
}

function navSync(replace) {
    if (!navReady || navRestoring) return;
    const next = navState();
    const cur = history.state;
    if (cur && cur.orderly && !cur.base && cur.view === next.view && cur.listId === next.listId) return;   // same screen refreshed
    try {
        if (replace && cur && cur.orderly && !cur.base) history.replaceState(next, "");
        else history.pushState(next, "");
    } catch (e) {
    }
}

// Closes the top-most thing sitting over the screen. Returns false when there was nothing to close.
function closeTopLayer() {
    if (dlgOverlay.classList.contains("visible")) {
        closeDialog(false);
        return true;
    }
    if (modalOverlay.classList.contains("visible")) {
        closeModal();
        return true;
    }
    if (notifPanel.classList.contains("visible")) {
        notifPanel.classList.remove("visible");
        return true;
    }
    const sortMenu = document.getElementById("sortMenu");
    if (sortMenu && sortMenu.classList.contains("visible")) {
        sortMenu.classList.remove("visible");
        return true;
    }
    if (sidebarEl.classList.contains("mobile-open")) {
        closeSidebar();
        return true;
    }
    return false;
}

async function showNavState(s) {
    try {
        if (s.view === "list" && s.listId) await openList(s.listId);
        else if (s.view === "myTasks") await openMyTasks();
        else if (s.view === "calendar") await openCalendar();
        else if (s.view === "settings") await openSettings();
        else {
            currentList = null;
            switchView("welcome");
            renderSidebar();
        }
    } catch (err) {
        // Couldn't get there (the list is gone, or the connection is down): stay on what's showing.
        if (!(err && err.offline) && s.view === "list") {
            currentList = null;
            switchView("welcome");
            renderSidebar();
            showToast("That list isn't available any more.");
        } else if (err && err.offline) {
            showToast(err.message);
        }
        try {
            history.replaceState(navState(), "");
        } catch (e) {
        }
    }
}

window.addEventListener("popstate", async (e) => {
    if (!navReady) return;
    const s = e.state;
    if (!s || !s.orderly) return;
    if (closeTopLayer()) {
        try {
            history.pushState(navState(), "");
        } catch (err) {
        }   // put the screen back; only the window closed
        return;
    }
    if (s.base) {
        history.back();
        return;
    }   // nothing earlier in the app: let the browser or phone take it
    navRestoring++;
    try {
        await showNavState(s);
    } finally {
        navRestoring--;
    }
});

if (authToken) enterApp();
else goToLogin();

// ============================================================
// Utilities
// ============================================================
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
}

function iconSvg(name) {
    const icons = {
        userPlus: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1"/><circle cx="10" cy="7" r="3.5"/><path d="M18 8v6"/><path d="M15 11h6"/></svg>',
        trash: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
        list: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
        checkCircle: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M8 12.5l2.8 2.8 5.7-5.8"/></svg>',
        calendar: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
        bell: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
        user: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
        settings: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/></svg>',
        moon: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
        logout: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
        sparkles: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.4 4.6L18 8l-4.6 1.4L12 14l-1.4-4.6L6 8l4.6-1.4L12 2Z"/><path d="m18.5 14 0.8 2.7L22 17.5l-2.7.8L18.5 21l-.8-2.7L15 17.5l2.7-.8L18.5 14Z"/><path d="m5.5 14 0.8 2.7L9 17.5l-2.7.8L5.5 21l-.8-2.7L2 17.5l2.7-.8L5.5 14Z"/></svg>',
        check: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5"/></svg>',
        warn: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.5"/><path d="M12 17.5h.01"/></svg>',
        question: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4.2"/><path d="M12 17.8h.01"/></svg>',
        users: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="8" r="3.5"/><path d="M21 20v-1a4 4 0 0 0-3-3.9"/><path d="M15.5 4.3a3.5 3.5 0 0 1 0 7.4"/></svg>',
        repeat: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.1-6.1"/><path d="M18 4h2v4"/><path d="M20 12a8 8 0 0 1-13.1 6.1"/><path d="M6 20H4v-4"/></svg>',
        reschedule: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><circle cx="17.5" cy="17.5" r="4.5"/><path d="M17.5 15.5v2l1.2 1"/></svg>',
        subtasks: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="m3 6 1.2 1.2L6.5 5"/><path d="m3 12 1.2 1.2L6.5 11"/><path d="m3 18 1.2 1.2L6.5 17"/></svg>',
        plus: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'
    };
    return icons[name] || "";
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function dateToStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStr() {
    return dateToStr(new Date());
}

function offsetDayStr(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return dateToStr(d);
}

const AVATAR_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899"];

function avatarColor(name) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % AVATAR_COLORS.length;
    return AVATAR_COLORS[Math.abs(hash)];
}

function avatarHtml(username, size) {
    const initial = (username || "?")[0].toUpperCase();
    const style = size ? `width:${size}px;height:${size}px;font-size:${size * 0.4}px;` : "";
    return `<div class="avatar" style="background:${avatarColor(username)};${style}" title="${escapeHtml(username)}">${escapeHtml(initial)}</div>`;
}

function renderProfile() {
    if (!currentUser) return;
    document.getElementById("profileAvatar").innerHTML = avatarHtml(currentUser.username, 28);
    document.getElementById("profileName").textContent = currentUser.username;
}

function showToast(text, {icon} = {}) {
    const container = document.getElementById("toastContainer");
    const el = document.createElement("div");
    el.className = "toast";
    const safeText = escapeHtml(String(text ?? ""));
    el.innerHTML = `${safeText}${icon ? ` ${iconSvg(icon)}` : ""}`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

// {replace: true} is for being sent away from a screen (it was deleted, you left): the back button
// should skip over it instead of returning to it.
function switchView(view, opts) {
    currentView = view;
    updateBottomNav();
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(view + "View").classList.add("active");
    document.querySelectorAll(".list-link, .my-tasks-link, .calendar-link, .settings-link").forEach((a) => a.classList.remove("active"));
    navSync(!!(opts && opts.replace));
}

// ---------- Relative time (for notifications) ----------
function relativeTime(isoStr) {
    const then = new Date(isoStr + (isoStr.endsWith("Z") ? "" : "Z"));
    const now = new Date();
    let diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 0) diffSec = 0;

    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    const diffWeek = Math.floor(diffDay / 7);
    if (diffWeek < 5) return `${diffWeek}w ago`;

    const sameYear = then.getFullYear() === now.getFullYear();
    const opts = sameYear ? {month: "short", day: "numeric"} : {month: "short", day: "numeric", year: "numeric"};
    return then.toLocaleDateString(undefined, opts);
}

// ---------- Smart deadline formatting ----------
function formatClock(t) {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    if (appSettings.time_format === "24h") return `${pad2(h)}:${pad2(m)}`;
    const period = h >= 12 ? "PM" : "AM";
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${pad2(m)} ${period}`;
}

function deadlineDateTime(deadline, time) {
    return new Date(`${deadline}T${time || "23:59"}:00`);
}

function isOverdue(deadline, time, completed) {
    if (completed || !deadline) return false;
    return deadlineDateTime(deadline, time).getTime() < Date.now();
}

function formatDeadline(deadline, time, completed) {
    if (!deadline) return null;
    let label;
    if (deadline === todayStr()) label = "Today";
    else if (deadline === offsetDayStr(1)) label = "Tomorrow";
    else if (deadline === offsetDayStr(-1)) label = "Yesterday";
    else {
        const d = new Date(deadline + "T00:00:00");
        const sameYear = d.getFullYear() === new Date().getFullYear();
        label = d.toLocaleDateString(undefined, sameYear ? {month: "short", day: "numeric"} : {
            month: "short",
            day: "numeric",
            year: "numeric"
        });
    }
    if (time) label += ` at ${formatClock(time)}`;
    const overdue = isOverdue(deadline, time, completed);
    if (overdue) label += " · Overdue";
    return {label, overdue};
}

// ============================================================
// Modal helper
// ============================================================
const modalOverlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");

let modalReturnFocus = null;

function openModal({title, fields, submitLabel, cancelLabel, hideSubmit, wide, intro, onSubmit}) {
    modalReturnFocus = document.activeElement;
    modalBox.classList.toggle("wide", !!wide);
    const mobileSheet = isMobile();
    const showCancel = !mobileSheet && (cancelLabel !== undefined && cancelLabel !== null && cancelLabel !== false);
    const showSubmit = !hideSubmit;
    const actions = [];
    if (showCancel) actions.push(`<button class="btn btn-secondary" id="modalCancel">${escapeHtml(cancelLabel || "Cancel")}</button>`);
    if (showSubmit) actions.push(`<button class="btn btn-primary" id="modalSubmit">${escapeHtml(submitLabel || "Save")}</button>`);
    modalBox.innerHTML = `
            <h3 id="modalTitle">${escapeHtml(title)}</h3>
            ${intro ? `<p class="people-note">${escapeHtml(intro)}</p>` : ""}
            <div class="modal-scroll">
                <div id="modalFields"></div>
                <div class="modal-error" id="modalError" role="alert"></div>
            </div>
            <div class="modal-actions" ${actions.length ? "" : "hidden"}>
                ${actions.join("")}
            </div>
        `;
    const fieldsEl = modalBox.querySelector("#modalFields");
    const getters = {};
    fields.forEach((f) => {
        const wrap = document.createElement("div");
        wrap.className = "field";
        const label = document.createElement("label");
        label.textContent = f.label;
        if (f.label) wrap.appendChild(label);

        if (f.type === "custom") {
            const built = f.build();
            wrap.appendChild(built.el);
            getters[f.id] = built.getValue;
            fieldsEl.appendChild(wrap);
            return;
        }

        let input;
        if (f.type === "select") {
            input = document.createElement("select");
            (f.options || []).forEach((opt) => {
                const o = document.createElement("option");
                o.value = opt.value;
                o.textContent = opt.label;
                if (String(opt.value) === String(f.value)) o.selected = true;
                input.appendChild(o);
            });
        } else {
            input = document.createElement("input");
            input.type = f.type || "text";
            if (f.value !== undefined && f.value !== null) input.value = f.value;
            if (f.placeholder) input.placeholder = f.placeholder;
        }
        input.id = "field_" + f.id;
        wrap.appendChild(input);
        fieldsEl.appendChild(wrap);
    });

    modalOverlay.classList.add("visible");
    const cancelBtn = modalBox.querySelector("#modalCancel");
    if (cancelBtn) cancelBtn.onclick = closeModal;
    const submitBtn = modalBox.querySelector("#modalSubmit");
    if (submitBtn) submitBtn.onclick = async () => {
        if (submitBtn.disabled) return;
        const values = {};
        fields.forEach((f) => {
            values[f.id] = getters[f.id] ? getters[f.id]() : document.getElementById("field_" + f.id).value.trim();
        });
        submitBtn.disabled = true;
        try {
            await onSubmit(values);
            closeModal();
        } catch (err) {
            const box = modalBox.querySelector("#modalError");
            if (box) box.textContent = err.message;
            submitBtn.disabled = false;
        }
    };
    // Enter submits from a text box; focus starts on the first field.
    modalBox.querySelectorAll(".field input:not([type=checkbox])").forEach((el) => {
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && submitBtn) {
                e.preventDefault();
                submitBtn.click();
            }
        });
    });
    const firstField = modalBox.querySelector(".field input, .field select");
    if (firstField && !isMobile()) firstField.focus();
}

function closeModal() {
    modalOverlay.classList.remove("visible");
    modalBox.innerHTML = "";
    if (modalReturnFocus && modalReturnFocus.focus && document.contains(modalReturnFocus)) {
        try {
            modalReturnFocus.focus({preventScroll: true});
        } catch (e) {
        }
    }
    modalReturnFocus = null;
}

modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay.classList.contains("visible") && !dlgOverlay.classList.contains("visible")) closeModal();
});

// ============================================================
// Confirm / message dialogs (these replace the browser's own popups)
// Centered card on desktop, bottom sheet on phones. Escape or tapping outside cancels.
// ============================================================
const dlgOverlay = document.getElementById("dlgOverlay");
const dlgBox = document.getElementById("dlgBox");
let dlgResolve = null;
let dlgReturnFocus = null;

function showDialog({title, message, okLabel, cancelLabel, danger, icon}) {
    return new Promise((resolve) => {
        if (dlgResolve) dlgResolve(false);
        dlgReturnFocus = document.activeElement;
        dlgBox.className = "dlg" + (danger ? " danger" : "");
        dlgBox.innerHTML = `
                <div class="dlg-icon">${iconSvg(icon || (danger ? "warn" : "question"))}</div>
                <h3 id="dlgTitle">${escapeHtml(title)}</h3>
                <p id="dlgMsg">${escapeHtml(message || "")}</p>
                <div class="dlg-actions">
                    ${cancelLabel ? `<button type="button" class="btn btn-secondary" id="dlgCancel">${escapeHtml(cancelLabel)}</button>` : ""}
                    <button type="button" class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" id="dlgOk">${escapeHtml(okLabel || "OK")}</button>
                </div>`;
        dlgResolve = resolve;
        dlgBox.querySelector("#dlgOk").onclick = () => closeDialog(true);
        const cancel = dlgBox.querySelector("#dlgCancel");
        if (cancel) cancel.onclick = () => closeDialog(false);
        dlgOverlay.classList.add("visible");
        // For anything destructive the safe button gets focus, so a stray Enter can't delete things.
        (danger && cancel ? cancel : dlgBox.querySelector("#dlgOk")).focus();
    });
}

function closeDialog(result) {
    const r = dlgResolve;
    dlgResolve = null;
    dlgOverlay.classList.remove("visible");
    if (dlgReturnFocus && dlgReturnFocus.focus && document.contains(dlgReturnFocus)) {
        try {
            dlgReturnFocus.focus({preventScroll: true});
        } catch (e) {
        }
    }
    dlgReturnFocus = null;
    if (r) r(result);
}

dlgOverlay.addEventListener("click", (e) => {
    if (e.target === dlgOverlay) closeDialog(false);
});
document.addEventListener("keydown", (e) => {
    if (!dlgOverlay.classList.contains("visible")) return;
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeDialog(false);
        return;
    }
    if (e.key === "Tab") {   // keep keyboard focus inside the dialog
        const buttons = Array.from(dlgBox.querySelectorAll("button"));
        const i = buttons.indexOf(document.activeElement);
        e.preventDefault();
        buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
    }
}, true);

function confirmDialog({title, message, confirmLabel, cancelLabel, danger}) {
    return showDialog({
        title,
        message,
        okLabel: confirmLabel || "Confirm",
        cancelLabel: cancelLabel || "Cancel",
        danger
    });
}

function alertDialog({title, message, okLabel}) {
    return showDialog({
        title: title || "Something went wrong",
        message,
        okLabel: okLabel || "OK",
        icon: "warn",
        danger: true
    });
}

// Errors from a button press: offline blips get a quiet toast, real refusals ("you can't do that") get a dialog.
function reportError(err, title) {
    if (err && err.offline) {
        showToast(err.message);
        return Promise.resolve();
    }
    return alertDialog({title, message: err && err.message ? err.message : "Please try again."});
}

// ============================================================
// Notifications
// ============================================================
const bellBtn = document.getElementById("bellBtn");
const mobileBellBtn = document.getElementById("mobileBellBtn");
const bellBadge = document.getElementById("bellBadge");
const mobileBellBadge = document.getElementById("mobileBellBadge");
const bellTriggers = [bellBtn, mobileBellBtn].filter(Boolean);
const notifPanel = document.createElement("div");
notifPanel.id = "notifPanel";
notifPanel.className = "notif-panel";
notifPanel.innerHTML = '<div class="notif-panel-header"> Notifications </div><div id="notifList"></div>';
document.body.appendChild(notifPanel);
const notifList = notifPanel.querySelector("#notifList");

async function refreshNotifications() {
    const data = await call("get_notifications");
    notifications = data.notifications;
    const pendingCount = notifications.filter((n) => n.status === "pending").length;
    [bellBadge, mobileBellBadge, document.getElementById("navBellBadge")].forEach((badge) => {
        if (!badge) return;
        if (pendingCount > 0) {
            badge.style.display = "flex";
            badge.textContent = pendingCount > 9 ? "9+" : String(pendingCount);
        } else {
            badge.style.display = "none";
        }
    });
    if (notifPanel.classList.contains("visible")) renderNotifPanel();
}

function notifText(n) {
    const who = n.inviter ? n.inviter.username : "Someone";
    if (n.type === "project_invite") {
        const name = n.project ? n.project.name : "a project";
        if (n.status === "pending") return `${escapeHtml(who)} invited you to the project "${escapeHtml(name)}"`;
        if (n.status === "accepted") return `You joined the project "${escapeHtml(name)}"`;
        return `You declined the invite to "${escapeHtml(name)}"`;
    }
    const name = n.list ? n.list.name : "a list";
    if (n.status === "pending") return `${escapeHtml(who)} shared the list "${escapeHtml(name)}" with you`;
    if (n.status === "accepted") return `You joined the list "${escapeHtml(name)}"`;
    return `You declined the share for "${escapeHtml(name)}"`;
}

function renderNotifPanel() {
    if (!notifications.length) {
        notifList.innerHTML = `<div class="notif-empty">No notifications yet</div>`;
        return;
    }
    notifList.innerHTML = notifications.map((n) => `
            <div class="notif-item" data-id="${n.id}">
                <div class="notif-text">${notifText(n)}</div>
                ${n.status === "pending" && n.access ? `<div class="notif-access">You'd get: ${escapeHtml(describeAccess(n.access.role, n.access.perms, n.type === "project_invite" ? "project" : "list"))}</div>` : ""}
                <div class="notif-time">${relativeTime(n.created_at)}</div>
                ${n.status === "pending" ? `
                    <div class="notif-actions">
                        <button class="btn btn-primary btn-small notif-accept" data-id="${n.id}">Accept</button>
                        <button class="btn btn-secondary btn-small notif-deny" data-id="${n.id}">Deny</button>
                    </div>
                ` : `<div class="notif-status ${n.status}">${n.status === "accepted" ? "Accepted" : "Denied"}</div>`}
            </div>
        `).join("");

    notifList.querySelectorAll(".notif-accept").forEach((btn) => {
        btn.addEventListener("click", () => respondToNotification(Number(btn.dataset.id), true));
    });
    notifList.querySelectorAll(".notif-deny").forEach((btn) => {
        btn.addEventListener("click", () => respondToNotification(Number(btn.dataset.id), false));
    });
}

async function respondToNotification(notificationId, accept) {
    try {
        await call("respond_notification", {notification_id: notificationId, accept});
        await refreshNotifications();
        showToast(accept ? "Invite accepted" : "Invite denied");
    } catch (err) {
        reportError(err, "Couldn't answer that invite");
    }
}

function positionNotifPanel(force = false) {
    if (!force && !notifPanel.classList.contains("visible")) return;

    const anchor = window.innerWidth <= 768 && mobileBellBtn ? mobileBellBtn : bellBtn;
    if (window.innerWidth <= 768) {
        const rect = anchor.getBoundingClientRect();
        const pad = 12;
        const panelWidth = Math.min(notifPanel.offsetWidth || 300, window.innerWidth - pad * 2);
        const panelHeight = Math.min(notifPanel.offsetHeight || 300, window.innerHeight - pad * 2);
        const left = Math.max(pad, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - pad));
        const top = Math.min(Math.max(pad + 8, rect.bottom + 10), window.innerHeight - panelHeight - pad);
        notifPanel.style.position = "fixed";
        notifPanel.style.left = `${left}px`;
        notifPanel.style.right = "auto";
        notifPanel.style.top = `${top}px`;
        notifPanel.style.bottom = "auto";
        notifPanel.style.width = `${panelWidth}px`;
        notifPanel.style.maxWidth = "none";
        notifPanel.style.minWidth = "0";
        return;
    }

    const rect = anchor.getBoundingClientRect();
    const pad = 12;
    const panelWidth = Math.min(notifPanel.offsetWidth || 320, window.innerWidth - pad * 2);
    const panelHeight = Math.min(notifPanel.offsetHeight || 300, window.innerHeight - pad * 2);
    let left = rect.right - panelWidth + 6;
    let top = rect.bottom + 8;
    if (left < pad) left = pad;
    if (left + panelWidth > window.innerWidth - pad) left = window.innerWidth - panelWidth - pad;
    if (top + panelHeight > window.innerHeight - pad) top = window.innerHeight - panelHeight - pad;
    notifPanel.style.left = `${left}px`;
    notifPanel.style.top = `${top}px`;
    notifPanel.style.right = "auto";
    notifPanel.style.width = `${panelWidth}px`;
    notifPanel.style.maxWidth = "none";
    notifPanel.style.minWidth = "0";
    notifPanel.style.bottom = "auto";
}

async function toggleNotifPanel() {
    const willOpen = !notifPanel.classList.contains("visible");
    if (willOpen) {
        renderNotifPanel();
        positionNotifPanel(true);
        notifPanel.classList.add("visible");
        await refreshNotifications();
        requestAnimationFrame(() => positionNotifPanel(true));
    } else {
        notifPanel.classList.remove("visible");
    }
}

bellTriggers.forEach((btn) => {
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleNotifPanel().catch(() => {
        });
    });
});
document.addEventListener("click", (e) => {
    const clickedBell = bellTriggers.some((btn) => btn === e.target || btn.contains(e.target));
    if (!notifPanel.contains(e.target) && !clickedBell && !e.target.closest('[data-nav="alerts"]')) notifPanel.classList.remove("visible");
});

// ============================================================
// Phone bottom bar
// Lists opens the sidebar as a sheet; My Tasks and Calendar switch pages; Alerts shows notifications;
// Account opens a small window with Settings, dark mode and Log out.
// ============================================================
document.querySelectorAll("#bottomNav .nav-ico").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", iconSvg(el.dataset.icon));
});

function updateBottomNav() {
    const sheetOpen = sidebarEl.classList.contains("mobile-open");
    const map = {myTasks: "myTasks", calendar: "calendar", list: "lists", settings: "account"};
    const active = sheetOpen ? "lists" : map[currentView];
    document.querySelectorAll("#bottomNav [data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === active));
}

document.getElementById("bottomNav").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-nav]");
    if (!btn) return;
    const which = btn.dataset.nav;
    if (which === "lists") {
        toggleSidebar();
        return;
    }
    closeSidebar();
    try {
        if (which === "alerts") await toggleNotifPanel();
        else if (which === "myTasks") await openMyTasks();
        else if (which === "calendar") await openCalendar();
        else if (which === "account") openAccountSheet();
    } catch (err) {
        reportError(err, "Couldn't open that");
    }
});

function openAccountSheet() {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
            <div class="acct-head">
                ${avatarHtml(currentUser.username, 44)}
                <div><div class="acct-name">${escapeHtml(currentUser.username)}</div><div class="acct-sub">Signed in</div></div>
            </div>
            <button type="button" class="acct-row" data-act="settings">${iconSvg("settings")}<span class="grow">Settings</span></button>
            <label class="acct-row">${iconSvg("moon")}<span class="grow">Dark mode</span>
                <span class="switch"><input type="checkbox" id="acctDarkToggle" ${document.body.classList.contains("dark") ? "checked" : ""}><span class="slider"></span></span>
            </label>
            <button type="button" class="acct-row danger" data-act="logout">${iconSvg("logout")}<span class="grow">Log out</span></button>`;
    wrap.querySelector("#acctDarkToggle").addEventListener("change", (ev) => applyThemePreference(ev.target.checked));
    wrap.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-act]");
        if (!b) return;
        closeModal();
        if (b.dataset.act === "settings") {
            try {
                await openSettings();
            } catch (err) {
                reportError(err, "Couldn't open settings");
            }
        } else if (b.dataset.act === "logout") {
            const ok = await confirmDialog({
                title: "Log out?",
                message: "You'll need to sign in again on this device.",
                confirmLabel: "Log out",
            });
            if (ok) document.getElementById("logoutLink").click();
        }
    });
    openModal({
        title: "Account",
        fields: [{id: "acct", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        cancelLabel: "Close",
        hideSubmit: true,
        onSubmit: async () => {
        },
    });
}

window.addEventListener("resize", () => {
    if (notifPanel.classList.contains("visible")) positionNotifPanel();
});

// ============================================================
// Dashboard / sidebar
// ============================================================
async function loadDashboard() {
    dashboard = await call("get_dashboard");
    renderSidebar();
}

function findProject(id) {
    return dashboard.projects.find((p) => p.id === id);
}

function findStandaloneList(id) {
    return dashboard.standalone_lists.find((l) => l.id === id);
}

function renderSidebar() {
    const projectsTree = document.getElementById("projectsTree");
    projectsTree.innerHTML = dashboard.projects.map((p) => `
            <div class="proj-item ${collapsedProjects.has(p.id) ? "collapsed" : ""}" data-project-item="${p.id}">
                <div class="proj-header">
                    <button class="collapse-btn" data-collapse="${p.id}" title="Collapse/expand">▾</button>
                    <span class="proj-name">${escapeHtml(p.name)}</span>
                    <button class="member-count" data-members-project="${p.id}" title="People and permissions" aria-label="${p.members.length} ${p.members.length === 1 ? "person" : "people"}. Open people and permissions">${iconSvg("users")} ${p.members.length}</button>
                    ${p.is_owner ? `<button class="icon-btn invite-btn" data-project="${p.id}" title="Invite a teammate">${iconSvg("userPlus")}</button>` : ""}
                    ${p.is_owner ? `<button class="icon-btn danger delete-project-btn" data-project="${p.id}" title="Delete project">${iconSvg("trash")}</button>` : ""}
                    ${p.is_owner ? "" : `<button class="icon-btn danger leave-project-btn" data-project="${p.id}" title="Leave project" aria-label="Leave project">${iconSvg("logout")}</button>`}
                </div>
                <div class="proj-lists">
                    ${p.lists.map((l) => `<a href="#" class="list-link" data-list="${l.id}">${escapeHtml(l.name)}</a>`).join("")}
                    ${(p.my_perms || []).includes("create_lists") ? `<a href="#" class="add-list-link" data-project="${p.id}">+ Add list</a>` : ""}
                </div>
            </div>
        `).join("") || `<div class="empty-state" style="padding:10px;font-size:12.5px;">No projects yet</div>`;

    const standaloneTree = document.getElementById("standaloneTree");
    standaloneTree.innerHTML = dashboard.standalone_lists.map((l) => `
            <a href="#" class="list-link" data-list="${l.id}">
                ${escapeHtml(l.name)}${l.is_owner ? "" : `<span class="shared-tag">shared</span>`}
            </a>
        `).join("") || `<div class="empty-state" style="padding:10px;font-size:12.5px;">No lists yet</div>`;

    if (currentList) {
        document.querySelectorAll(`.list-link[data-list="${currentList.id}"]`).forEach((a) => a.classList.add("active"));
    }
    if (currentView === "myTasks") {
        document.querySelector(".my-tasks-link").classList.add("active");
    }
    if (currentView === "calendar") {
        document.querySelector(".calendar-link").classList.add("active");
    }
    if (currentView === "settings") {
        document.querySelector(".settings-link").classList.add("active");
    }
}

document.getElementById("sidebarNav").addEventListener("click", async (e) => {
    const myTasksLink = e.target.closest(".my-tasks-link");
    if (myTasksLink) {
        e.preventDefault();
        await openMyTasks();
        closeSidebarIfMobile();
        return;
    }

    const calendarLink = e.target.closest(".calendar-link");
    if (calendarLink) {
        e.preventDefault();
        await openCalendar();
        closeSidebarIfMobile();
        return;
    }

    const settingsLink = e.target.closest(".settings-link");
    if (settingsLink) {
        e.preventDefault();
        await openSettings();
        closeSidebarIfMobile();
        return;
    }

    const collapseBtn = e.target.closest(".collapse-btn");
    if (collapseBtn) {
        e.preventDefault();
        const pid = Number(collapseBtn.dataset.collapse);
        if (collapsedProjects.has(pid)) collapsedProjects.delete(pid);
        else collapsedProjects.add(pid);
        renderSidebar();
        return;
    }

    const membersBtn = e.target.closest(".member-count");
    if (membersBtn) {
        e.preventDefault();
        closeSidebarIfMobile();
        openMembersModal("project", Number(membersBtn.dataset.membersProject));
        return;
    }

    const inviteBtn = e.target.closest(".invite-btn");
    if (inviteBtn) {
        e.preventDefault();
        closeSidebarIfMobile();
        openInviteProjectModal(Number(inviteBtn.dataset.project));
        return;
    }

    const leaveProjectBtn = e.target.closest(".leave-project-btn");
    if (leaveProjectBtn) {
        e.preventDefault();
        await leaveProject(Number(leaveProjectBtn.dataset.project));
        return;
    }

    const deleteProjectBtn = e.target.closest(".delete-project-btn");
    if (deleteProjectBtn) {
        e.preventDefault();
        await deleteProject(Number(deleteProjectBtn.dataset.project));
        return;
    }

    const addListLink = e.target.closest(".add-list-link");
    if (addListLink) {
        e.preventDefault();
        openNewListModal(Number(addListLink.dataset.project));
        return;
    }

    const listLink = e.target.closest(".list-link");
    if (listLink) {
        e.preventDefault();
        await openList(Number(listLink.dataset.list));
        closeSidebarIfMobile();
    }
});

async function deleteProject(projectId) {
    const p = findProject(projectId);
    const name = p ? p.name : "this project";
    const ok = await confirmDialog({
        title: `Delete "${name}"?`,
        message: "This permanently deletes the project, all of its lists and every task in them, for everyone on it. This can't be undone.",
        confirmLabel: "Delete project",
        danger: true,
    });
    if (!ok) return;
    try {
        await call("delete_project", {project_id: projectId});
        dashboard.projects = dashboard.projects.filter((x) => x.id !== projectId);
        if (currentList && currentList.project && currentList.project.id === projectId) {
            currentList = null;
            switchView("welcome", {replace: true});
        }
        renderSidebar();
        showToast(`"${name}" deleted`);
    } catch (err) {
        reportError(err, "Couldn't delete the project");
    }
}

// Take a project off this screen (after leaving it, being removed from it, or the owner deleting it).
function removeProjectLocally(projectId) {
    dashboard.projects = dashboard.projects.filter((p) => p.id !== projectId);
    if (currentList && currentList.project && currentList.project.id === projectId) {
        currentList = null;
        switchView("welcome", {replace: true});
    }
    renderSidebar();
    if (currentView === "myTasks" || currentView === "calendar") refreshCurrentView().catch(() => {
    });
}

async function leaveProject(projectId) {
    const p = findProject(projectId);
    const name = p ? p.name : "this project";
    const ok = await confirmDialog({
        title: `Leave "${name}"?`,
        message: "You'll lose access to the project and all of its lists unless the owner invites you again. Tasks assigned to you will become unassigned.",
        confirmLabel: "Leave project",
        danger: true,
    });
    if (!ok) return;
    try {
        await call("leave_project", {project_id: projectId});
        removeProjectLocally(projectId);
        showToast(`Left "${name}"`);
    } catch (err) {
        reportError(err, "Couldn't leave the project");
    }
}

document.getElementById("newProjectBtn").addEventListener("click", openNewProjectModal);
document.getElementById("welcomeNewProjectBtn").addEventListener("click", openNewProjectModal);

function openNewProjectModal() {
    closeSidebarIfMobile();
    openModal({
        title: "New Project",
        fields: [{id: "name", label: "Project name", placeholder: "e.g. Website Relaunch"}],
        submitLabel: "Create",
        onSubmit: async (v) => {
            if (!v.name) throw new Error("Name is required");
            const data = await call("create_project", {name: v.name});
            dashboard.projects.push(data.project);
            renderSidebar();
            showToast(`Project "${data.project.name}" created`);
        },
    });
}

document.getElementById("newListBtn").addEventListener("click", () => openNewListModal(null));
document.getElementById("welcomeNewListBtn").addEventListener("click", () => openNewListModal(null));

function openNewListModal(projectId) {
    closeSidebarIfMobile();
    const allowed = dashboard.projects.filter((p) => (p.my_perms || []).includes("create_lists"));
    if (projectId && !allowed.some((p) => p.id === projectId)) projectId = null;
    const options = [{value: "", label: "No project (standalone list)"}].concat(
        allowed.map((p) => ({value: String(p.id), label: p.name}))
    );
    openModal({
        title: "New List",
        fields: [
            {id: "name", label: "List name", placeholder: "e.g. Groceries"},
            {id: "project_id", label: "Project", type: "select", options, value: projectId ? String(projectId) : ""},
        ],
        submitLabel: "Create",
        onSubmit: async (v) => {
            if (!v.name) throw new Error("Name is required");
            const pid = v.project_id ? Number(v.project_id) : null;
            const data = await call("create_list", {name: v.name, project_id: pid});
            if (!pid) {
                // Standalone lists aren't broadcast anywhere else, so add it here.
                dashboard.standalone_lists.push({
                    id: data.list.id, name: data.list.name, owner_id: currentUser.id,
                    is_owner: true, members: data.list.members, my_perms: data.list.my_perms,
                });
                renderSidebar();
            }
            // For project lists, the "list_created" broadcast (which this connection
            // is already subscribed to) is what adds it to the sidebar — avoids
            // adding it twice.
            await openList(data.list.id);
        },
    });
}

// ============================================================
// Access levels and permissions
// The server owns the list of permissions and the presets (dashboard.catalog); this just draws them.
// ============================================================
function catalog() {
    return dashboard.catalog || {permissions: [], roles: [], default_role: "contributor"};
}

function scopePerms(scope) {
    return catalog().permissions.filter((p) => p.scopes.includes(scope));
}

function sameSet(a, b) {
    const x = new Set(a), y = new Set(b);
    return x.size === y.size && [...x].every((k) => y.has(k));
}

function presetKeys(role, scope) {
    const allowed = new Set(scopePerms(scope).map((p) => p.key));
    return role.perms.filter((k) => allowed.has(k));
}

function roleLabel(role) {
    if (role === "owner") return "Owner";
    if (role === "custom") return "Custom";
    const r = catalog().roles.find((x) => x.key === role);
    return r ? r.label : role;
}

function describeAccess(role, perms, scope) {
    if (role === "owner") return "Owner. Can do everything.";
    const r = catalog().roles.find((x) => x.key === role);
    if (r) return `${r.label}. ${r.hint}.`;
    const labels = scopePerms(scope).filter((p) => (perms || []).includes(p.key)).map((p) => p.label.toLowerCase());
    return labels.length ? `Custom. Can ${labels.join(", ")}.` : "Custom. View only.";
}

// A dropdown of presets plus a "fine-tune" checklist. Changing either keeps the other in step, and
// the dropdown flips to "Custom" when the ticked boxes don't match a preset.
function accessPicker({scope, role, perms}) {
    const roles = catalog().roles;
    const list = scopePerms(scope);
    const wrap = document.createElement("div");
    wrap.className = "access-picker";

    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Access level");
    roles.forEach((r) => {
        const o = document.createElement("option");
        o.value = r.key;
        o.textContent = r.label;
        sel.appendChild(o);
    });
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = "Custom";
    sel.appendChild(customOpt);
    wrap.appendChild(sel);

    const hint = document.createElement("div");
    hint.className = "ap-hint";
    wrap.appendChild(hint);

    const details = document.createElement("details");
    details.className = "ap-details";
    details.innerHTML = `<summary>Fine-tune permissions</summary>`;
    const boxes = {};
    list.forEach((p) => {
        const row = document.createElement("label");
        row.className = "ap-check";
        row.innerHTML = `<input type="checkbox"><span><b>${escapeHtml(p.label)}</b><small>${escapeHtml(p.hint)}</small></span>`;
        boxes[p.key] = row.querySelector("input");
        details.appendChild(row);
    });
    wrap.appendChild(details);

    const checked = () => list.filter((p) => boxes[p.key].checked).map((p) => p.key);
    const setChecks = (keys) => list.forEach((p) => {
        boxes[p.key].checked = keys.includes(p.key);
    });
    const updateHint = () => {
        const r = roles.find((x) => x.key === sel.value);
        hint.textContent = r ? r.hint + "." : "Choose exactly what this person can do.";
    };

    sel.addEventListener("change", () => {
        const r = roles.find((x) => x.key === sel.value);
        if (r) setChecks(presetKeys(r, scope));
        else details.open = true;
        updateHint();
    });
    list.forEach((p) => boxes[p.key].addEventListener("change", () => {
        const now = checked();
        const match = roles.find((r) => sameSet(presetKeys(r, scope), now));
        sel.value = match ? match.key : "custom";
        updateHint();
    }));

    const start = role || catalog().default_role;
    const startRole = roles.find((x) => x.key === start);
    if (startRole) {
        sel.value = start;
        setChecks(presetKeys(startRole, scope));
    } else {
        sel.value = "custom";
        setChecks(perms || []);
    }
    updateHint();

    return {el: wrap, getValue: () => ({role: sel.value, perms: checked()})};
}

function openInviteProjectModal(projectId) {
    openModal({
        title: "Invite to Project",
        fields: [
            {id: "username", label: "Username", placeholder: "their account username"},
            {id: "access", label: "What can they do?", type: "custom", build: () => accessPicker({scope: "project"})},
            {id: "viaLink", label: "", type: "custom", build: () => inviteLinkSwitch("project", projectId)},
        ],
        submitLabel: "Send Invite",
        onSubmit: async (v) => {
            if (!v.username) throw new Error("Username is required");
            await call("invite_project_member", {
                project_id: projectId,
                username: v.username,
                role: v.access.role,
                perms: v.access.perms
            });
            showToast(`Invite sent to ${v.username}`);
        },
    });
}

function openShareListModal(listId) {
    openModal({
        title: "Share List",
        fields: [
            {id: "username", label: "Username", placeholder: "their account username"},
            {id: "access", label: "What can they do?", type: "custom", build: () => accessPicker({scope: "list"})},
            {id: "viaLink", label: "", type: "custom", build: () => inviteLinkSwitch("list", listId)},
        ],
        submitLabel: "Send Invite",
        onSubmit: async (v) => {
            if (!v.username) throw new Error("Username is required");
            await call("share_list", {
                list_id: listId,
                username: v.username,
                role: v.access.role,
                perms: v.access.perms
            });
            showToast(`Invite sent to ${v.username}`);
        },
    });
}

function inviteLinkSwitch(scope, id) {
    const el = document.createElement("div");
    el.className = "invite-switch";
    el.innerHTML = `<span>Don't know their username?</span><button type="button" class="link-btn">Invite with a link instead</button>`;
    el.querySelector("button").onclick = () => {
        closeModal();
        openInviteLinkModal(scope, id);
    };
    return {el, getValue: () => null};
}

async function copyText(text, input) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            if (input) {
                input.focus();
                input.select();
            }
            return document.execCommand("copy");
        } catch (e2) {
            return false;
        }
    }
}

function expiryText(iso) {
    if (!iso) return "doesn't expire";
    const ms = new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime() - Date.now();
    if (ms <= 0) return "expired";
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return "expires in under an hour";
    if (hours < 48) return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
    return `expires in ${Math.floor(hours / 24)} days`;
}

// Make, copy and turn off the invite links of a project (or a standalone list).
async function openInviteLinkModal(scope, id) {
    const key = scope === "project" ? {project_id: id} : {list_id: id};
    let links;
    try {
        links = (await call("list_invite_links", key)).links;
    } catch (err) {
        reportError(err, "Couldn't load invite links");
        return;
    }

    const picker = accessPicker({scope});
    const wrap = document.createElement("div");
    const accessField = document.createElement("div");
    accessField.className = "field";
    accessField.innerHTML = `<label>What can people who join do?</label>`;
    accessField.appendChild(picker.el);
    const expiryField = document.createElement("div");
    expiryField.className = "field";
    expiryField.innerHTML = `<label>How long does the link work?</label>
            <select aria-label="Link expiry">
                <option value="1">1 day</option>
                <option value="7" selected>7 days</option>
                <option value="30">30 days</option>
                <option value="never">Until I turn it off</option>
            </select>`;
    const makeBtn = document.createElement("button");
    makeBtn.type = "button";
    makeBtn.className = "btn btn-primary link-make";
    makeBtn.textContent = "Create link";
    const title = document.createElement("div");
    title.className = "link-section-title";
    title.textContent = "Active links";
    const listEl = document.createElement("div");
    wrap.append(accessField, expiryField, makeBtn, title, listEl);

    function renderLinks() {
        listEl.innerHTML = "";
        if (!links.length) {
            listEl.innerHTML = `<div class="link-empty">No active links yet.</div>`;
            return;
        }
        links.forEach((lk) => {
            const row = document.createElement("div");
            row.className = "link-row";
            row.innerHTML = `<div class="copy-row"><input type="text" readonly aria-label="Invite link"><button type="button" class="btn btn-secondary btn-small" data-act="copy">Copy</button></div>
                    <div class="link-meta"></div>
                    <div class="link-actions"></div>`;
            const input = row.querySelector("input");
            input.value = lk.url;
            input.addEventListener("focus", () => input.select());
            row.querySelector(".link-meta").textContent = `${roleLabel(lk.access.role)} · ${expiryText(lk.expires_at)}`;
            row.querySelector('[data-act="copy"]').onclick = async () => {
                showToast((await copyText(lk.url, input)) ? "Link copied" : "Press and hold the link to copy it");
            };
            const actions = row.querySelector(".link-actions");
            if (navigator.share) {
                const share = document.createElement("button");
                share.type = "button";
                share.className = "btn btn-secondary btn-small";
                share.textContent = "Share…";
                share.onclick = () => {
                    navigator.share({title: "Join me on Orderly", url: lk.url}).catch(() => {
                    });
                };
                actions.appendChild(share);
            }
            const off = document.createElement("button");
            off.type = "button";
            off.className = "btn btn-danger btn-small";
            off.textContent = "Turn off";
            off.onclick = async () => {
                const ok = await confirmDialog({
                    title: "Turn off this link?",
                    message: "Nobody will be able to join with it any more. People who already joined stay.",
                    confirmLabel: "Turn off",
                    danger: true,
                });
                if (!ok) return;
                try {
                    await call("revoke_invite_link", {link_id: lk.id});
                    links = links.filter((x) => x.id !== lk.id);
                    renderLinks();
                } catch (err) {
                    reportError(err, "Couldn't turn off the link");
                }
            };
            actions.appendChild(off);
            listEl.appendChild(row);
        });
    }

    renderLinks();

    makeBtn.onclick = async () => {
        if (makeBtn.disabled) return;
        makeBtn.disabled = true;
        try {
            const a = picker.getValue();
            const days = expiryField.querySelector("select").value;
            const data = await call("create_invite_link", {
                ...key,
                role: a.role,
                perms: a.perms,
                expires_days: days === "never" ? null : Number(days)
            });
            links.unshift(data.link);
            renderLinks();
            const copied = await copyText(data.link.url, listEl.querySelector("input"));
            showToast(copied ? "Link created and copied" : "Link created. Tap Copy to copy it.");
        } catch (err) {
            reportError(err, "Couldn't create the link");
        } finally {
            makeBtn.disabled = false;
        }
    };

    openModal({
        title: "Invite link",
        intro: "Anyone who opens the link can accept or decline. If they aren't signed in, they can sign in or sign up first.",
        wide: true,
        fields: [{id: "links", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        cancelLabel: "Close",
        hideSubmit: true,
        onSubmit: async () => {
        },
    });
}

// Someone opened an invite link: show who invited them and let them accept or decline.
async function handlePendingInvite() {
    const token = pendingInvite;
    if (!token || !currentUser) return;
    let info;
    try {
        info = await call("preview_invite_link", {token});
    } catch (err) {
        if (err && err.offline) return;   // try again when the connection is back; the link is still kept
        clearPendingInvite();
        await alertDialog({
            title: "Invite link",
            message: err && err.message ? err.message : "This invite link isn't valid any more."
        });
        return;
    }
    clearPendingInvite();
    if (info.already_member) {
        showToast(`You're already part of “${info.name}”.`);
        return;
    }
    const scope = info.kind === "project" ? "project" : "list";
    const accept = await showDialog({
        title: `Join “${info.name}”?`,
        message: `${info.inviter || "Someone"} invited you to join the ${scope} “${info.name}”.\n\nYour access: ${describeAccess(info.access.role, info.access.perms, scope)}`,
        okLabel: "Accept",
        cancelLabel: "Decline",
        icon: "users",
    });
    if (!accept) {
        showToast("Invite declined");
        return;
    }
    try {
        const res = await call("respond_invite_link", {token, accept: true});
        await loadDashboard();
        refreshNotifications().catch(() => {
        });
        showToast(`You joined “${info.name}”`);
        if (currentView === "welcome") {
            let listId = res.list_id;
            if (!listId && res.project_id) {
                const p = findProject(res.project_id);
                listId = p && p.lists.length ? p.lists[0].id : null;
            }
            if (listId) await openList(listId);
        }
    } catch (err) {
        reportError(err, "Couldn't join");
    }
}

// Everyone on a project or a shared list, with what each person may do. The owner can change it here, any time.
async function openMembersModal(scope, id) {
    try {
        await loadDashboard();
    } catch (err) { /* fall back to what we already have */
    }
    const box = scope === "project" ? findProject(id) : findStandaloneList(id);
    if (!box) {
        showToast("Couldn't load that. Please try again.");
        return;
    }
    const canEdit = !!box.is_owner;
    const members = box.members.slice().sort((a, b) =>
        (b.is_owner - a.is_owner) || a.username.localeCompare(b.username));
    const originals = new Map();
    const pickers = new Map();

    const list = document.createElement("div");
    list.className = "people-list";
    members.forEach((m) => {
        const row = document.createElement("div");
        row.className = "person-row";
        const tag = m.is_owner ? "Owner" : (m.id === currentUser.id ? "You" : "");
        row.innerHTML = `<div class="person-head">${avatarHtml(m.username, 30)}<span class="person-name">${escapeHtml(m.username)}</span>${tag ? `<span class="person-tag">${tag}</span>` : ""}${canEdit && !m.is_owner ? `<button type="button" class="btn btn-danger btn-small person-remove">Remove</button>` : ""}</div>`;
        const removeBtn = row.querySelector(".person-remove");
        if (removeBtn) removeBtn.onclick = async () => {
            const ok = await confirmDialog({
                title: `Remove ${m.username}?`,
                message: scope === "project"
                    ? `${m.username} will lose access to "${box.name}" and every list in it. Tasks assigned to them will become unassigned.`
                    : `${m.username} will lose access to "${box.name}". Tasks assigned to them will become unassigned.`,
                confirmLabel: "Remove",
                danger: true,
            });
            if (!ok) return;
            try {
                await call("remove_member", scope === "project" ? {project_id: id, user_id: m.id} : {
                    list_id: id,
                    user_id: m.id
                });
                pickers.delete(m.id);      // so "Save changes" doesn't try to update someone who's gone
                originals.delete(m.id);
                row.remove();
                showToast(`${m.username} removed`);
            } catch (err) {
                reportError(err, "Couldn't remove that person");
            }
        };
        if (m.is_owner) {
            row.insertAdjacentHTML("beforeend", `<div class="person-access">Full control</div>`);
        } else if (canEdit) {
            originals.set(m.id, m.perms || []);
            const picker = accessPicker({scope, role: m.role, perms: m.perms});
            pickers.set(m.id, picker);
            row.appendChild(picker.el);
        } else {
            row.insertAdjacentHTML("beforeend", `<div class="person-access">${escapeHtml(describeAccess(m.role, m.perms, scope))}</div>`);
        }
        list.appendChild(row);
    });

    const me = members.find((m) => m.id === currentUser.id);
    if (!canEdit && me) {
        const foot = document.createElement("div");
        foot.className = "people-foot";
        foot.innerHTML = `<button type="button" class="btn btn-danger btn-small">${scope === "project" ? "Leave project" : "Leave list"}</button>`;
        foot.querySelector("button").onclick = () => {
            closeModal();
            if (scope === "project") leaveProject(id);
            else leaveList(id, box.name);
        };
        list.appendChild(foot);
    }
    let intro;
    if (canEdit) {
        intro = members.length > 1
            ? `Choose what each person can do.${scope === "project" ? " This applies to every list in the project." : ""}`
            : "Nobody else is here yet. Invite someone, then you can set what they're allowed to do.";
    } else {
        intro = me ? `Your access: ${describeAccess(me.role, me.perms, scope)}` : "";
    }

    openModal({
        title: scope === "project" ? `People in "${box.name}"` : `People on "${box.name}"`,
        intro,
        wide: true,
        fields: [{id: "people", label: "", type: "custom", build: () => ({el: list, getValue: () => null})}],
        submitLabel: "Save changes",
        cancelLabel: canEdit && pickers.size ? "Cancel" : "Close",
        hideSubmit: !(canEdit && pickers.size),
        onSubmit: async () => {
            const changes = [];
            pickers.forEach((picker, uid) => {
                const v = picker.getValue();
                if (!sameSet(v.perms, originals.get(uid))) changes.push({user_id: uid, role: v.role, perms: v.perms});
            });
            if (!changes.length) return;
            await call("set_member_permissions", scope === "project"
                ? {project_id: id, members: changes}
                : {list_id: id, members: changes});
            await refreshAccess();
            showToast("Permissions updated");
        },
    });
}

// Reload the dashboard and the open list, and say so if the person's own access just changed.
let accessRefreshTimer = null;

function scheduleAccessRefresh() {
    clearTimeout(accessRefreshTimer);
    accessRefreshTimer = setTimeout(() => refreshAccess(true).catch(() => {
    }), 150);
}

async function refreshAccess(announce) {
    const before = currentList ? (currentList.my_perms || []).join(",") : null;
    await loadDashboard();
    if (currentList && currentView === "list") {
        await openList(currentList.id);
        if (announce && before !== null && before !== (currentList.my_perms || []).join(",")) {
            showToast("Your permissions on this list were updated");
        }
    }
}

async function leaveList(listId, listName) {
    const ok = await confirmDialog({
        title: `Leave "${listName}"?`,
        message: "You'll lose access to this list unless someone shares it with you again. Tasks assigned to you will become unassigned.",
        confirmLabel: "Leave list",
        danger: true,
    });
    if (!ok) return;
    try {
        await call("leave_list", {list_id: listId});
        dashboard.standalone_lists = dashboard.standalone_lists.filter((l) => l.id !== listId);
        currentList = null;
        switchView("welcome", {replace: true});
        renderSidebar();
        showToast(`Left "${listName}"`);
    } catch (err) {
        reportError(err, "Couldn't leave the list");
    }
}

// ============================================================
// My Tasks view
// ============================================================
async function openMyTasks() {
    switchView("myTasks");
    document.querySelector(".my-tasks-link").classList.add("active");
    const data = await call("get_my_tasks");
    renderMyTasks(data.tasks);
}

function renderMyTasks(tasks) {
    const container = document.getElementById("myTasksContainer");
    if (!tasks.length) {
        container.innerHTML = `<div class="empty-state">Nothing assigned to you right now ${iconSvg("sparkles")}</div>`;
        return;
    }
    container.innerHTML = tasks.map((t) => {
        const d = formatDeadline(t.deadline, t.deadline_time, t.completed);
        return `
            <div class="mytask-row" data-list="${t.list_id}">
                <span class="priority-dot priority-${t.priority}"></span>
                <span class="mytask-name">${escapeHtml(t.name)}</span>
                ${xTagChips(t)}
                <span class="mytask-list-tag">${escapeHtml(t.list_name)}</span>
                ${d ? `<span class="deadline-badge ${d.overdue ? "overdue" : ""} ${d.label === "Today" ? "dueToday" : ""}">${escapeHtml(d.label)}</span>` : ""}
                ${repeatBadgeHtml(t)}
                ${t.can_reschedule && t.deadline && t.deadline <= todayStr() ? `<button type="button" class="icon-btn task-resched mytask-resched" data-task="${t.id}" title="Reschedule" aria-label="Reschedule task">${iconSvg("reschedule")}</button>` : ""}
            </div>
        `;
    }).join("");
    xBindTaskChips(container);
    container.querySelectorAll(".mytask-row").forEach((row) => {
        row.addEventListener("click", () => openList(Number(row.dataset.list)));
    });
    container.querySelectorAll(".mytask-resched").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const task = tasks.find((t) => t.id === Number(btn.dataset.task));
            if (task) openRescheduleModal(task);
        });
    });
}

// ============================================================
// Calendar view
// ============================================================
let calendarTasks = [];
let calViewDate = new Date();

async function openCalendar() {
    switchView("calendar");
    document.querySelector(".calendar-link").classList.add("active");
    await loadCalendar();
}

// Fetch the tasks for the month on screen. The server also returns, for repeating tasks,
// every other date in that month they'll come up on (future_dates).
async function loadCalendar() {
    const y = calViewDate.getFullYear(), mo = calViewDate.getMonth();
    const data = await call("get_calendar", {
        range_start: `${y}-${pad2(mo + 1)}-01`,
        range_end: `${y}-${pad2(mo + 1)}-${pad2(new Date(y, mo + 1, 0).getDate())}`,
        today: todayStr(),
    });
    calendarTasks = data.tasks.filter((t) => t.deadline);
    renderCalendar();
}

document.getElementById("calPrevBtn").addEventListener("click", () => {
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
    loadCalendar();
});
document.getElementById("calNextBtn").addEventListener("click", () => {
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
    loadCalendar();
});
document.getElementById("calTodayBtn").addEventListener("click", () => {
    calViewDate = new Date();
    loadCalendar();
});
document.getElementById("calLinkBtn").addEventListener("click", () => openSettings("settingsCalendarCard"));

function tasksForDateInCalendar(dateStr) {
    const list = [];
    const seen = new Set();
    const entries = window.__calendarTasksByDate?.[dateStr] || [];
    entries.forEach(({t}) => {
        if (!t || seen.has(t.id)) return;
        seen.add(t.id);
        list.push(t);
    });
    if (list.length) return list;
    calendarTasks.forEach((t) => {
        if ((t.deadline === dateStr || (t.future_dates || []).includes(dateStr)) && !seen.has(t.id)) {
            seen.add(t.id);
            list.push(t);
        }
    });
    return list;
}

function relativeDayLabel(dateStr) {
    const a = new Date(`${dateStr}T00:00:00`);
    const b = new Date(`${todayStr()}T00:00:00`);
    const diff = Math.round((a - b) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    return diff > 0 ? `In ${diff} days` : `${-diff} days ago`;
}

function sortedDayTasks(dateStr) {
    return tasksForDateInCalendar(dateStr).slice().sort((a, b) => {
        if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
        const ta = a.deadline_time || "", tb = b.deadline_time || "";
        if (ta !== tb) return ta.localeCompare(tb);          // all-day first, then by time
        return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    });
}

function dayItemHtml(t, dateStr) {
    const isFirst = t.deadline === dateStr;
    const pills = [];
    pills.push(`<span class="day-pill time">${t.deadline_time ? escapeHtml(formatClock(t.deadline_time)) : "All day"}</span>`);
    if (isFirst && isOverdue(t.deadline, t.deadline_time, t.completed)) pills.push(`<span class="day-pill overdue">Overdue</span>`);
    if (!isFirst) pills.push(`<span class="day-pill upcoming">Upcoming repeat</span>`);
    if (t.list_name) pills.push(`<span class="day-pill" title="List">${escapeHtml(t.list_name)}</span>`);
    if (t.assignee) pills.push(`<span class="assignee-chip">${avatarHtml(t.assignee.username, 18)}${escapeHtml(t.assignee.username)}</span>`);
    if (t.repeat) pills.push(`<span class="repeat-badge" title="Repeats: ${escapeHtml(t.repeat)}">${iconSvg("repeat")} ${escapeHtml(t.repeat)}</span>`);
    return `
            <button type="button" class="day-item p-${t.priority || "normal"} ${t.completed ? "done" : ""}" data-list="${t.list_id}" data-task="${t.id}">
                <span class="day-item-bar"></span>
                <span class="day-item-main">
                    <span class="day-item-name">${escapeHtml(t.name)}</span>
                    <span class="day-item-meta">${pills.join("")}</span>
                </span>
                <span class="day-item-go" aria-hidden="true">›</span>
            </button>`;
}

function openCalendarDayModal(dateStr) {
    let current = dateStr;
    let busy = false;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
            <div class="day-nav">
                <button type="button" class="btn btn-secondary" data-step="-1" aria-label="Previous day">‹</button>
                <div class="day-sum" id="daySum" aria-live="polite"></div>
                <button type="button" class="btn btn-secondary" data-step="1" aria-label="Next day">›</button>
            </div>
            <div class="day-list" id="dayList"></div>`;
    const sumEl = wrap.querySelector("#daySum");
    const listEl = wrap.querySelector("#dayList");

    function render() {
        const date = new Date(`${current}T00:00:00`);
        const titleEl = document.getElementById("modalTitle");
        if (titleEl) titleEl.textContent = date.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric"
        });
        const tasks = sortedDayTasks(current);
        const done = tasks.filter((t) => t.completed).length;
        const rel = relativeDayLabel(current);
        const summary = !tasks.length ? "Nothing scheduled"
            : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}${done ? ` · ${done} done` : ""}`;
        sumEl.innerHTML = `<span class="day-rel ${rel === "Today" ? "is-today" : ""}">${escapeHtml(rel)}</span><b>${escapeHtml(summary)}</b>`;
        listEl.innerHTML = tasks.length
            ? tasks.map((t) => dayItemHtml(t, current)).join("")
            : `<div class="day-empty"><b>Nothing due ${iconSvg("sparkles")}</b>Enjoy the free day.</div>`;
    }

    async function step(delta) {
        if (busy) return;
        const d = new Date(`${current}T00:00:00`);
        d.setDate(d.getDate() + delta);
        const next = dateToStr(d);
        busy = true;
        try {
            // Tasks are only loaded for the month on screen, so crossing a month boundary loads the new month first.
            if (d.getMonth() !== calViewDate.getMonth() || d.getFullYear() !== calViewDate.getFullYear()) {
                calViewDate = new Date(d.getFullYear(), d.getMonth(), 1);
                await loadCalendar();
            }
            current = next;
            render();
        } catch (err) {
            reportError(err, "Couldn't load that day");
        } finally {
            busy = false;
        }
    }

    wrap.addEventListener("click", async (e) => {
        const nav = e.target.closest("[data-step]");
        if (nav) {
            step(Number(nav.dataset.step));
            return;
        }
        const item = e.target.closest(".day-item");
        if (item) {
            closeModal();
            try {
                await openList(Number(item.dataset.list));
            } catch (err) {
                reportError(err, "Couldn't open that list");
            }
        }
    });

    // Swipe left/right inside the sheet to move between days.
    let sx = 0, sy = 0;
    wrap.addEventListener("touchstart", (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, {passive: true});
    wrap.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 60 && Math.abs(dy) < 40) step(dx < 0 ? 1 : -1);
    }, {passive: true});

    openModal({
        title: " ",
        wide: true,
        fields: [{id: "calendarDay", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        cancelLabel: "Close",
        hideSubmit: true,
        onSubmit: async () => {
        },
    });
    render();
}

let calLastCompact = null;

function renderCalendar() {
    const year = calViewDate.getFullYear();
    const month = calViewDate.getMonth();
    document.getElementById("calMonthLabel").textContent =
        calViewDate.toLocaleDateString(undefined, {month: "long", year: "numeric"});

    const firstDay = new Date(year, month, 1);
    const weekStart = appSettings.week_start === "mon" ? 1 : 0;
    const startOffset = (firstDay.getDay() - weekStart + 7) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const tasksByDate = {};
    calendarTasks.forEach((t) => {
        (tasksByDate[t.deadline] = tasksByDate[t.deadline] || []).push({t, future: false});
        (t.future_dates || []).forEach((d) => {
            (tasksByDate[d] = tasksByDate[d] || []).push({t, future: true});
        });
    });
    window.__calendarTasksByDate = tasksByDate;

    const allDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekdayLabels = allDays.slice(weekStart).concat(allDays.slice(0, weekStart));
    const compactMode = window.innerWidth <= 768;
    calLastCompact = compactMode;
    const today = todayStr();
    let html = weekdayLabels.map((d) => `<div class="calendar-weekday">${compactMode ? d.slice(0, 3) : d}</div>`).join("");

    for (let i = 0; i < startOffset; i++) html += `<div class="calendar-cell empty"></div>`;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`;
        const dayTasks = tasksByDate[dateStr] || [];
        const isToday = dateStr === today;
        const cls = `${isToday ? "today" : ""} ${dateStr < today ? "past" : ""} ${dayTasks.length ? "has-tasks" : ""}`;
        if (compactMode) {
            // Phones: day number plus up to 3 priority-coloured dots and a "+N"; tapping opens the day sheet.
            const dots = dayTasks.slice().sort((a, b) =>
                (!!a.t.completed - !!b.t.completed) || ((PRIORITY_RANK[a.t.priority] ?? 1) - (PRIORITY_RANK[b.t.priority] ?? 1)));
            const shown = dots.slice(0, 3);
            const extra = dots.length - shown.length;
            html += `
                <div class="calendar-cell ${cls}" data-date="${dateStr}" role="button" tabindex="0" aria-label="${dayTasks.length} tasks on ${dateStr}">
                    <div class="calendar-daynum">${day}</div>
                    <div class="calendar-dots">
                        ${shown.map(({
                                                                                                                                                                                                                                                                           t,
                                                                                                                                                                                                                                                                           future
                                                                                                                                                                                                                                                                       }) => `<i class="cal-dot p-${t.priority || "normal"} ${t.completed ? "done" : ""} ${future ? "future" : ""}"></i>`).join("")}
                        ${extra > 0 ? `<span class="cal-count">+${extra}</span>` : ""}
                    </div>
                </div>`;
            continue;
        }
        html += `
            <div class="calendar-cell ${cls}" data-date="${dateStr}">
                <div class="calendar-daynum">${day}</div>
                <div class="calendar-tasks">
                    ${dayTasks.slice(0, 3).map(({t, future}) => `
                        <div class="calendar-task-chip calendar-priority-${t.priority} ${future ? "calendar-future" : ""} ${t.completed ? "calendar-done" : ""}" data-list="${t.list_id}" data-task="${t.id}" data-date="${dateStr}" data-future="${future ? 1 : 0}" title="${escapeHtml(t.name)}${t.assignee ? " · " + escapeHtml(t.assignee.username) : ""}${t.repeat ? " (repeats: " + escapeHtml(t.repeat) + ")" : ""}">
                            ${t.repeat ? iconSvg("repeat") + " " : ""}${escapeHtml(t.name)}
                        </div>
                    `).join("")}
                    ${dayTasks.length > 3 ? `<div class="calendar-more">+${dayTasks.length - 3} more</div>` : ""}
                </div>
            </div>
        `;
    }

    document.getElementById("calendarGrid").innerHTML = html;
    document.querySelectorAll(".calendar-cell:not(.empty)").forEach((cell) => {
        cell.addEventListener("click", (e) => {
            if (e.target.closest(".calendar-task-chip")) return;
            openCalendarDayModal(cell.dataset.date);
        });
        cell.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openCalendarDayModal(cell.dataset.date);
            }
        });
    });
    document.querySelectorAll(".calendar-task-chip").forEach((chip) => {
        chip.addEventListener("click", (e) => {
            e.stopPropagation();
            openList(Number(chip.dataset.list));
        });
    });
    xBindCalendarDrag();
}

// Phones: swipe the month grid left/right to change month.
(function () {
    const grid = document.getElementById("calendarGrid");
    let sx = 0, sy = 0;
    grid.addEventListener("touchstart", (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, {passive: true});
    grid.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) < 70 || Math.abs(dy) > 45) return;
        document.getElementById(dx < 0 ? "calNextBtn" : "calPrevBtn").click();
    }, {passive: true});
})();
// Re-draw when crossing the phone/desktop breakpoint (rotating, resizing).
window.addEventListener("resize", () => {
    if (currentView === "calendar" && calLastCompact !== null && calLastCompact !== (window.innerWidth <= 768)) renderCalendar();
});

// ============================================================
// List view
// ============================================================
async function openList(listId) {
    const data = await call("get_list", {list_id: listId});
    currentList = data.list;
    xOnListOpened(listId);
    switchView("list");
    document.querySelectorAll(`.list-link[data-list="${listId}"]`).forEach((a) => a.classList.add("active"));
    renderListHeader();
    renderAssigneeOptions();
    applyAccessToListUi();
    renderTasks();
}

// What the person may do in the open list (the server sends the keys, and re-checks every action itself).
function can(perm) {
    return !!(currentList && currentList.my_perms && currentList.my_perms.includes(perm));
}

function myRoleHere() {
    const me = currentList && currentList.members.find((m) => m.id === currentUser.id);
    return me ? me.role : "viewer";
}

function applyAccessToListUi() {
    const canAdd = can("add_tasks");
    document.getElementById("addTaskBar").style.display = canAdd ? "" : "none";
    document.getElementById("newTaskAssignee").style.display = can("assign_tasks") ? "" : "none";
    const note = document.getElementById("accessNote");
    if (canAdd) {
        note.style.display = "none";
        return;
    }
    const scope = currentList.project ? "project" : "list";
    const me = currentList.members.find((m) => m.id === currentUser.id);
    note.style.display = "";
    note.textContent = `You can't add tasks here. Your access: ${me ? describeAccess(me.role, me.perms, scope) : "view only."}`;
}

function renderListHeader() {
    document.getElementById("listTitle").textContent = currentList.name;
    document.getElementById("listBreadcrumb").textContent = currentList.project
        ? `Project: ${currentList.project.name}`
        : "Standalone list";
    const membersRow = document.getElementById("listMembers");
    membersRow.innerHTML = currentList.members.map((m) => avatarHtml(m.username, 30)).join("");
    membersRow.classList.add("clickable");
    membersRow.title = "See who has access";
    membersRow.onclick = openPeopleForCurrentList;

    const actions = document.getElementById("listHeaderActions");
    const sortBy = getSortPref(currentList.id);
    let html = `
            <div class="sort-wrap" id="sortWrap">
                <button class="sort-btn" id="sortBtn" title="Sort tasks">⋮</button>
                <div class="sort-menu" id="sortMenu">
                    <div class="sort-menu-label">Sort by</div>
                    ${SORT_OPTIONS.map((opt) => `
                        <div class="sort-option ${opt.value === sortBy ? "active" : ""}" data-sort="${opt.value}">
                            <span>${escapeHtml(opt.label)}</span>
                            <span class="check">${iconSvg("check")}</span>
                        </div>
                    `).join("")}
                </div>
            </div>
        `;
    html += xHeaderButtonsHtml();
    html += `<button class="btn btn-secondary btn-small" id="peopleBtn">People</button>`;
    if (currentList.is_owner && !currentList.project) {
        html += `<button class="btn btn-secondary btn-small" id="shareListBtn">Share</button>`;
    }
    // The list's creator can delete it, and so can the owner of the project it belongs to.
    if (currentList.can_delete) {
        html += `<button class="btn btn-danger btn-small" id="deleteListBtn">Delete List</button>`;
    } else if (!currentList.is_owner && !currentList.project) {
        html += `<button class="btn btn-danger btn-small" id="leaveListBtn">Leave List</button>`;
    }
    if (currentList.project && !currentList.project.is_owner) {
        html += `<button class="btn btn-danger btn-small" id="leaveProjectBtn">Leave Project</button>`;
    }
    actions.innerHTML = html;

    const sortBtn = document.getElementById("sortBtn");
    const sortMenu = document.getElementById("sortMenu");
    sortBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sortMenu.classList.toggle("visible");
    });
    sortMenu.querySelectorAll(".sort-option").forEach((opt) => {
        opt.addEventListener("click", () => {
            setSortPref(currentList.id, opt.dataset.sort);
            sortMenu.classList.remove("visible");
            renderListHeader();
            renderTasks();
        });
    });

    xBindHeader();
    const peopleBtn = document.getElementById("peopleBtn");
    if (peopleBtn) peopleBtn.onclick = openPeopleForCurrentList;

    const shareBtn = document.getElementById("shareListBtn");
    if (shareBtn) shareBtn.onclick = () => openShareListModal(currentList.id);

    const leaveProjectBtn = document.getElementById("leaveProjectBtn");
    if (leaveProjectBtn) leaveProjectBtn.onclick = () => leaveProject(currentList.project.id);

    const leaveBtn = document.getElementById("leaveListBtn");
    if (leaveBtn) leaveBtn.onclick = () => leaveList(currentList.id, currentList.name);

    const deleteBtn = document.getElementById("deleteListBtn");
    if (deleteBtn) deleteBtn.onclick = async () => {
        const list = currentList;
        const creator = list.members.find((m) => m.id === list.owner_id);
        const others = !list.is_owner && creator ? ` It was created by ${creator.username}.` : "";
        const ok = await confirmDialog({
            title: `Delete "${list.name}"?`,
            message: `This permanently deletes the list and all of its tasks, for everyone who can see it.${others} This can't be undone.`,
            confirmLabel: "Delete list",
            danger: true,
        });
        if (!ok) return;
        try {
            await call("delete_list", {list_id: list.id});
            removeListFromDashboard(list.id);
            if (currentList && currentList.id === list.id) {
                currentList = null;
                switchView("welcome", {replace: true});
            }
            renderSidebar();
        } catch (err) {
            reportError(err, "Couldn't delete the list");
        }
    };
}

function openPeopleForCurrentList() {
    if (!currentList) return;
    if (currentList.project) openMembersModal("project", currentList.project.id);
    else openMembersModal("list", currentList.id);
}

document.addEventListener("click", (e) => {
    const sortMenu = document.getElementById("sortMenu");
    const sortWrap = document.getElementById("sortWrap");
    if (sortMenu && sortMenu.classList.contains("visible") && sortWrap && !sortWrap.contains(e.target)) {
        sortMenu.classList.remove("visible");
    }
});

function renderAssigneeOptions() {
    const select = document.getElementById("newTaskAssignee");
    select.innerHTML = `<option value="">Unassigned</option>` +
        currentList.members.map((m) => `<option value="${m.id}">${escapeHtml(m.username)}</option>`).join("");
}

function renderTasks() {
    if (xDragging()) {   // don't redraw under someone's finger; it happens when they let go
        dnd.pendingRender = true;
        return;
    }
    const listEl = document.getElementById("taskList");
    const boardEl = document.getElementById("boardView");
    xRenderFilterBar();
    xRenderBulkBar();
    if (xIsBoard()) {
        listEl.style.display = "none";
        if (!currentList.tasks.length) {
            boardEl.style.display = "";
            boardEl.innerHTML = `<div class="empty-state">No tasks yet. Add one above!</div>`;
        } else {
            renderBoard();
        }
        return;
    }
    boardEl.style.display = "none";
    listEl.style.display = "";
    listEl.classList.toggle("select-mode", selectMode);
    if (!currentList.tasks.length) {
        listEl.innerHTML = `<div class="empty-state">No tasks yet. Add one above!</div>`;
        return;
    }
    const sortedTasks = getSortedTasksForDisplay();
    if (!sortedTasks.length) {
        listEl.innerHTML = xFilterActive()
            ? `<div class="empty-state">No tasks match your filter.</div>`
            : `<div class="empty-state">Everything here is done ${iconSvg("sparkles")} Completed tasks are hidden (change this in Settings).</div>`;
        return;
    }

    // A live update redraws the list; keep whatever is half-typed in a subtask box.
    const typed = {};
    listEl.querySelectorAll(".subtask-input").forEach((i) => {
        if (i.value) typed[i.dataset.task] = i.value;
    });
    const active = document.activeElement;
    const focusedTask = active && active.classList && active.classList.contains("subtask-input") ? active.dataset.task : null;

    listEl.innerHTML = sortedTasks.map(renderTaskItem).join("");

    listEl.querySelectorAll(".subtask-input").forEach((i) => {
        if (typed[i.dataset.task]) i.value = typed[i.dataset.task];
        if (focusedTask === i.dataset.task) {
            i.focus();
            i.setSelectionRange(i.value.length, i.value.length);
        }
    });

    listEl.querySelectorAll(".task-checkbox").forEach((cb) => {
        cb.addEventListener("change", async () => {
            try {
                // Send the user's local date so "next occurrence" isn't thrown off by the server's UTC clock.
                const res = await call("toggle_task", {task_id: Number(cb.dataset.task), today: todayStr()});
                if (res.rolled) {
                    const next = formatDeadline(res.task.deadline, res.task.deadline_time, false);
                    showToast(`Done! Next due ${next.label}`);
                } else if (res.task.repeat && res.task.completed) {
                    showToast("That was the last one. This repeat has ended.");
                }
            } catch (err) {
                renderTasks();
                reportError(err, "Couldn't update the task");
            }
        });
    });
    listEl.querySelectorAll(".task-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await call("delete_task", {task_id: Number(btn.dataset.task)});
            } catch (err) {
                reportError(err, "Couldn't delete the task");
            }
        });
    });
    listEl.querySelectorAll(".task-name:not(.readonly)").forEach((el) => {
        el.addEventListener("click", () => openEditTaskModal(Number(el.dataset.task)));
    });

    // ----- reschedule -----
    listEl.querySelectorAll(".task-resched").forEach((btn) => {
        btn.addEventListener("click", () => {
            const task = currentList.tasks.find((t) => t.id === Number(btn.dataset.task));
            if (task) openRescheduleModal(task);
        });
    });

    // ----- subtasks -----
    listEl.querySelectorAll(".subtask-badge").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = Number(btn.dataset.expand);
            if (expandedTasks.has(id)) expandedTasks.delete(id);
            else expandedTasks.add(id);
            renderTasks();
        });
    });
    listEl.querySelectorAll(".task-addsub").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = Number(btn.dataset.task);
            const isOpen = expandedTasks.has(id);
            if (isOpen) {
                expandedTasks.delete(id);
                renderTasks();
                return;
            }
            expandedTasks.add(id);
            renderTasks();
            const input = listEl.querySelector(`.subtask-input[data-task="${id}"]`);
            if (input) input.focus();
        });
    });
    listEl.querySelectorAll(".subtask-checkbox").forEach((cb) => {
        cb.addEventListener("change", async () => {
            try {
                await call("toggle_subtask", {subtask_id: Number(cb.dataset.sub)});
            } catch (err) {
                renderTasks();
                reportError(err, "Couldn't update the subtask");
            }
        });
    });
    listEl.querySelectorAll(".subtask-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await call("delete_subtask", {subtask_id: Number(btn.dataset.sub)});
            } catch (err) {
                reportError(err, "Couldn't delete the subtask");
            }
        });
    });
    listEl.querySelectorAll(".subtask-name:not(.readonly)").forEach((el) => {
        el.addEventListener("click", () => openRenameSubtaskModal(Number(el.dataset.sub), el.textContent));
    });
    listEl.querySelectorAll(".subtask-add-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const input = listEl.querySelector(`.subtask-input[data-task="${btn.dataset.task}"]`);
            if (input) addSubtask(Number(btn.dataset.task), input);
        });
    });
    listEl.querySelectorAll(".subtask-input").forEach((input) => {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                addSubtask(Number(input.dataset.task), input);
            }
        });
    });
    xBindTaskList(listEl);
}

async function addSubtask(taskId, input) {
    const name = input.value.trim();
    if (!name) return;
    input.value = "";   // clear first, so the redraw that follows doesn't bring the text back
    try {
        await call("add_subtask", {task_id: taskId, name});
        const next = document.querySelector(`#taskList .subtask-input[data-task="${taskId}"]`);
        if (next) next.focus();   // ready for the next one
    } catch (err) {
        const back = document.querySelector(`#taskList .subtask-input[data-task="${taskId}"]`);
        if (back) back.value = name;
        reportError(err, "Couldn't add the subtask");
    }
}

function openRenameSubtaskModal(subtaskId, currentName) {
    openModal({
        title: "Edit Subtask",
        fields: [{id: "name", label: "Subtask name", value: currentName}],
        submitLabel: "Save",
        onSubmit: async (v) => {
            if (!v.name) throw new Error("Name is required");
            await call("rename_subtask", {subtask_id: subtaskId, name: v.name});
        },
    });
}

function renderSubtasksHtml(t) {
    const subs = t.subtasks || [];
    const canAdd = can("add_tasks");
    if (!subs.length && !canAdd) return "";
    const canDo = can("complete_tasks"), canEdit = can("edit_tasks"), canDel = can("delete_tasks");
    const rows = subs.map((s) => `
                <li class="subtask ${s.completed ? "completed" : ""}">
                    <input type="checkbox" class="subtask-checkbox" data-sub="${s.id}" ${s.completed ? "checked" : ""} ${canDo ? "" : "disabled"} aria-label="Done">
                    <span class="subtask-name ${canEdit ? "" : "readonly"}" data-sub="${s.id}">${escapeHtml(s.name)}</span>
                    ${canDel ? `<button type="button" class="icon-btn subtask-delete" data-sub="${s.id}" title="Delete subtask" aria-label="Delete subtask">${iconSvg("trash")}</button>` : ""}
                </li>`).join("");
    return `
            <div class="subtasks">
                ${subs.length ? `<ul class="subtask-list">${rows}</ul>` : ""}
                ${canAdd ? `<div class="subtask-add"><input type="text" class="subtask-input" data-task="${t.id}" placeholder="Add a subtask…" maxlength="200" autocomplete="off" enterkeyhint="done" aria-label="New subtask"><button type="button" class="btn btn-secondary btn-small subtask-add-btn" data-task="${t.id}">Add</button></div>` : ""}
            </div>`;
}

function renderTaskItem(t) {
    const d = formatDeadline(t.deadline, t.deadline_time, t.completed);
    const subs = t.subtasks || [];
    const subsDone = subs.filter((s) => s.completed).length;
    const open = expandedTasks.has(t.id);
    const meta =
        (d ? `<span class="deadline-badge ${d.overdue ? "overdue" : ""} ${d.label === "Today" ? "dueToday" : ""}">${escapeHtml(d.label)}</span>` : "") +
        repeatBadgeHtml(t) +
        (subs.length ? `<button type="button" class="subtask-badge ${open ? "open" : ""}" data-expand="${t.id}" aria-expanded="${open}" title="${open ? "Hide" : "Show"} subtasks">${iconSvg("subtasks")} ${subsDone}/${subs.length}</button>` : "") +
        (t.assignee ? `<span class="assignee-chip">${avatarHtml(t.assignee.username, 18)}${escapeHtml(t.assignee.username)}</span>` : "");
    const editable = can("edit_tasks") || can("assign_tasks");
    const due = t.deadline && !t.completed && t.deadline <= todayStr();
    const actions =
        xCommentAction(t) +
        (due && can("edit_tasks") ? `<button type="button" class="icon-btn task-resched" data-task="${t.id}" title="Reschedule" aria-label="Reschedule task">${iconSvg("reschedule")}</button>` : "") +
        (can("add_tasks") ? `<button type="button" class="icon-btn task-addsub ${open ? "open" : ""}" data-task="${t.id}" title="${open ? "Close add subtask" : "Add a subtask"}" aria-label="${open ? "Close add subtask" : "Add a subtask"}">${iconSvg("plus")}</button>` : "") +
        (can("delete_tasks") ? `<button class="icon-btn task-delete" data-task="${t.id}" title="Delete" aria-label="Delete task">${iconSvg("trash")}</button>` : "");
    return `
            <li class="task-item prio-${t.priority} ${t.completed ? "completed" : ""} ${selectedIds.has(t.id) ? "selected" : ""}" data-task="${t.id}">
                <div class="task-row">
                    ${xRowLead(t)}
                    <input type="checkbox" class="task-checkbox" data-task="${t.id}" ${t.completed ? "checked" : ""} ${can("complete_tasks") ? "" : "disabled"} aria-label="Done">
                    <span class="priority-dot priority-${t.priority}"></span>
                    <span class="task-name ${editable ? "" : "readonly"}" data-task="${t.id}">${escapeHtml(t.name)}</span>
                    ${meta || (t.tags || []).length || t.comment_count ? `<div class="task-meta">${meta}${xTagChips(t)}${xCommentBadge(t)}</div>` : ""}
                    ${actions ? `<div class="task-actions">${actions}</div>` : ""}
                </div>
                ${open ? renderSubtasksHtml(t) : ""}
            </li>
        `;
}

// ---------- Reschedule (postpone) ----------
// Moves only this due date. For repeating tasks the server leaves the repeat schedule alone, so the next
// repeat stays on its usual day. ("every!" repeats count from completion, so for those the new date carries on.)
function openRescheduleModal(task) {
    const today = todayStr();
    const wrap = document.createElement("div");
    const options = [["Today", today], ["Tomorrow", offsetDayStr(1)], ["In 3 days", offsetDayStr(3)], ["Next week", offsetDayStr(7)]]
        .filter(([, date]) => date !== task.deadline);
    let hint = "";
    if (task.repeat) {
        hint = /^every!/i.test(task.repeat)
            ? "This repeat counts from the day you finish it, so the next ones will follow the new date."
            : "Only this one moves. The next repeat stays on its usual day.";
    }
    wrap.innerHTML = `
            <div class="resched-chips">${options.map(([label, date]) =>
        `<button type="button" class="btn btn-secondary resched-chip" data-date="${date}">${escapeHtml(label)}</button>`).join("")}</div>
            <div class="resched-row">
                <div><label class="resched-label" for="reschedDate">Or pick a date</label>
                    <input type="date" id="reschedDate" min="${today}" value="${task.deadline && task.deadline >= today ? task.deadline : today}"></div>
                <div><label class="resched-label" for="reschedTime">Time</label>
                    <input type="time" id="reschedTime" value="${escapeHtml(task.deadline_time || "")}"></div>
            </div>
            ${hint ? `<div class="resched-hint">${escapeHtml(hint)}</div>` : ""}`;
    const dateInput = wrap.querySelector("#reschedDate");
    const timeInput = wrap.querySelector("#reschedTime");
    wrap.querySelectorAll(".resched-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            dateInput.value = chip.dataset.date;
            const submit = document.getElementById("modalSubmit");
            if (submit) submit.click();   // one tap: pick and apply
        });
    });
    openModal({
        title: "Reschedule",
        intro: task.name,
        fields: [{
            id: "when", label: "", type: "custom",
            build: () => ({el: wrap, getValue: () => ({deadline: dateInput.value, deadline_time: timeInput.value || null})}),
        }],
        submitLabel: "Reschedule",
        cancelLabel: "Cancel",
        onSubmit: async (v) => {
            if (!v.when.deadline) throw new Error("Pick a date");
            await call("reschedule_task", {
                task_id: task.id,
                deadline: v.when.deadline,
                deadline_time: v.when.deadline_time,
                today: todayStr(),
            });
            const moved = formatDeadline(v.when.deadline, v.when.deadline_time, false);
            showToast(`Moved to ${moved.label}`);
        },
    });
}

document.getElementById("addTaskBtn").addEventListener("click", async () => {
    const nameInput = document.getElementById("newTaskName");
    const name = nameInput.value.trim();
    if (!name) return;
    const deadline = document.getElementById("newTaskDeadline").value || null;
    const deadline_time = deadline ? (document.getElementById("newTaskDeadlineTime").value || null) : null;
    const priority = document.getElementById("newTaskPriority").value;
    const repeat = document.getElementById("newTaskRepeat").value.trim() || null;
    const assignedRaw = document.getElementById("newTaskAssignee").value;
    const assigned_to = assignedRaw ? Number(assignedRaw) : null;
    try {
        await call("add_task", {
            list_id: currentList.id,
            name,
            deadline,
            deadline_time,
            priority,
            repeat,
            assigned_to,
            quick: !xKeepAsTyped(),
            today: todayStr()
        });
        nameInput.value = "";
        xResetQuick();
        document.getElementById("newTaskDeadline").value = "";
        document.getElementById("newTaskDeadlineTime").value = "";
        document.getElementById("newTaskRepeat").value = "";
        nameInput.focus();
    } catch (err) {
        reportError(err, "Couldn't add the task");
    }
});
document.getElementById("addOptsToggle").addEventListener("click", () => {
    const bar = document.getElementById("addTaskBar");
    const open = bar.classList.toggle("show-opts");
    document.getElementById("addOptsToggle").setAttribute("aria-expanded", String(open));
});
document.getElementById("newTaskName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("addTaskBtn").click();
});

function openEditTaskModal(taskId) {
    const task = currentList.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const canEdit = can("edit_tasks");
    const canAssign = can("assign_tasks");
    if (!canEdit && !canAssign) return;
    const fields = [];
    if (canEdit) {
        fields.push(
            {id: "name", label: "Task name", value: task.name},
            {id: "deadline", label: "Deadline date", type: "date", value: task.deadline || ""},
            {id: "deadline_time", label: "Deadline time (optional)", type: "time", value: task.deadline_time || ""},
            {
                id: "priority", label: "Priority", type: "select", value: task.priority,
                options: [{value: "low", label: "Low"}, {value: "normal", label: "Normal"}, {
                    value: "high",
                    label: "High"
                }]
            },
            {
                id: "repeat",
                label: "Repeat (e.g. every mon, fri · every! 3 days)",
                type: "text",
                value: task.repeat || "",
                placeholder: "Leave empty for no repeat"
            },
            ...xEditFields(task),
        );
    }
    if (canAssign) {
        fields.push({
            id: "assigned_to", label: "Assigned to", type: "select",
            value: task.assignee ? String(task.assignee.id) : "",
            options: [{value: "", label: "Unassigned"}].concat(
                currentList.members.map((m) => ({value: String(m.id), label: m.username}))
            )
        });
    }
    openModal({
        title: canEdit ? "Edit Task" : "Assign Task",
        fields,
        submitLabel: "Save",
        onSubmit: async (v) => {
            const payload = {task_id: taskId, today: todayStr()};
            if (canEdit) {
                if (!v.name) throw new Error("Name is required");
                Object.assign(payload, {
                    name: v.name,
                    deadline: v.deadline || null,
                    deadline_time: v.deadline ? (v.deadline_time || null) : null,
                    priority: v.priority,
                    repeat: v.repeat || null,
                    tags: v.tags,
                    notes: v.notes || null,
                });
            }
            if (canAssign) payload.assigned_to = v.assigned_to ? Number(v.assigned_to) : null;
            await call("edit_task", payload);
        },
    });
}

// ============================================================
// Settings page
// Every control saves the moment it changes. The server validates each value.
// ============================================================
const SCOPE_OPTIONS = [
    ["assigned", "Only tasks assigned to me"],
    ["assigned_unassigned", "Mine, plus tasks no one is assigned to"],
    ["all", "Every task in my lists and projects"],
];

function applySettings() {
    const pri = document.getElementById("newTaskPriority");
    if (pri && appSettings.default_priority) pri.value = appSettings.default_priority;
    if (currentView === "calendar") renderCalendar();
    if (currentView === "list" && currentList) renderTasks();
}

async function loadSettings() {
    settingsData = await call("get_settings");
    appSettings = {...appSettings, ...settingsData.settings};
    applySettings();
    xAfterSettingsLoaded();
    // First time: remember this browser's time zone, so the daily digest and calendar times line up.
    if (!settingsData.settings.timezone) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) {
            call("update_settings", {settings: {timezone: tz}})
                .then((d) => {
                    settingsData = d;
                    appSettings.timezone = d.settings.timezone;
                })
                .catch(() => {
                });
        }
    }
}

async function openSettings(scrollToId) {
    switchView("settings");
    document.querySelector(".settings-link").classList.add("active");
    try {
        settingsData = await call("get_settings");
        appSettings = {...appSettings, ...settingsData.settings};
    } catch (err) {
        showToast(err.message);
        return;
    }
    renderSettingsPage();
    if (scrollToId) {
        const el = document.getElementById(scrollToId);
        if (el) el.scrollIntoView({behavior: "smooth", block: "start"});
    }
}

let savedTimer = null;

function flashSaved() {
    const el = document.getElementById("settingsSaved");
    if (!el) return;
    el.innerHTML = `Saved ${iconSvg("check")}`;
    el.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function saveSetting(key, value) {
    const previous = appSettings[key];
    appSettings[key] = value;
    applySettings();
    syncSettingsDisabled();
    try {
        settingsData = await call("update_settings", {settings: {[key]: value}});
        appSettings[key] = settingsData.settings[key];
        flashSaved();
    } catch (err) {
        appSettings[key] = previous;
        showToast(err.message);
        syncSettingsControls();
        syncSettingsDisabled();
        applySettings();
    }
}

// Put the current values back into the controls (used after a failed save or an update from another tab).
function syncSettingsControls() {
    document.querySelectorAll("#settingsContainer [data-setting]").forEach((el) => {
        const value = appSettings[el.dataset.setting];
        if (el.type === "checkbox") el.checked = !!value;
        else el.value = value;
    });
}

// Grey out controls that don't apply yet (no verified email, or the digest is off).
function syncSettingsDisabled() {
    const verified = !!(settingsData && settingsData.email.verified);
    document.querySelectorAll("#settingsContainer .settings-row[data-needs-email], #settingsContainer .settings-row[data-needs]").forEach((row) => {
        const emailOk = !row.hasAttribute("data-needs-email") || verified;
        const flagOk = !row.dataset.needs || !!appSettings[row.dataset.needs];
        const on = emailOk && flagOk;
        row.classList.toggle("is-disabled", !on);
        row.querySelectorAll("input, select").forEach((i) => {
            i.disabled = !on;
        });
    });
}

function settingRow({label, hint, control, needs, email, toggle}) {
    return `
            <div class="settings-row ${toggle ? "row-toggle" : ""}" ${needs ? `data-needs="${needs}"` : ""} ${email ? "data-needs-email" : ""}>
                <div class="settings-label">
                    <div>${escapeHtml(label)}</div>
                    ${hint ? `<div class="settings-hint">${escapeHtml(hint)}</div>` : ""}
                </div>
                <div class="settings-control">${control}</div>
            </div>`;
}

function toggleControl(key) {
    return `<label class="switch"><input type="checkbox" data-setting="${key}" ${appSettings[key] ? "checked" : ""}><span class="slider"></span></label>`;
}

function themeToggleControl() {
    return `<label class="switch"><input type="checkbox" id="themeSettingToggle" ${document.body.classList.contains("dark") ? "checked" : ""}><span class="slider"></span></label>`;
}

function selectControl(key, options) {
    return `<select data-setting="${key}">` + options.map(([v, l]) =>
        `<option value="${escapeHtml(v)}" ${String(appSettings[key]) === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("") + `</select>`;
}

function timeControl(key) {
    return `<input type="time" data-setting="${key}" value="${escapeHtml(appSettings[key])}">`;
}

function cardHtml(id, title, sub, body) {
    return `<section class="settings-card" id="${id}"><div class="settings-title">${escapeHtml(title)}</div>` +
        `${sub ? `<div class="settings-sub">${escapeHtml(sub)}</div>` : ""}${body}</section>`;
}

function timeZoneOptions() {
    let zones = [];
    try {
        zones = Intl.supportedValuesOf("timeZone");
    } catch (e) {
        zones = [];
    }
    const set = new Set(zones);
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    [appSettings.timezone, detected].forEach((z) => {
        if (z) set.add(z);
    });
    const opts = [...set].sort().map((z) => [z, z.replace(/_/g, " ")]);
    return appSettings.timezone ? opts : [["", "Choose your time zone…"]].concat(opts);
}

function emailCardHtml() {
    const e = settingsData.email;
    const status = !e.address ? "" : e.verified
        ? `<span class="pill pill-ok">Verified</span>`
        : `<span class="pill pill-warn">Not verified</span>`;
    let body = "";
    if (!settingsData.email_service) {
        body += `<div class="settings-callout">Emails aren't set up on this server yet, so Orderly can't send any right now.</div>`;
    }
    body += `
            <div class="settings-row stack">
                <div class="settings-label">
                    <div>Email address ${status}</div>
                    <div class="settings-hint">Optional. We use it only for the emails you choose below.</div>
                </div>
                <div class="settings-control">
                    <input type="email" id="emailInput" placeholder="you@example.com" autocomplete="email" value="${escapeHtml(e.address || "")}">
                    <button class="btn btn-primary btn-small" id="emailSaveBtn">${e.address ? "Change" : "Save"}</button>
                </div>
            </div>`;
    if (e.address && !e.verified) {
        body += `
            <div class="settings-row stack">
                <div class="settings-label">
                    <div>Enter the 6-digit code we emailed to ${escapeHtml(e.address)}</div>
                    <div class="settings-hint">It expires in 15 minutes. Check your spam folder if it doesn't show up.</div>
                </div>
                <div class="settings-control">
                    <input type="text" id="emailCodeInput" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456">
                    <button class="btn btn-primary btn-small" id="emailVerifyBtn">Verify</button>
                    <button class="btn btn-secondary btn-small" id="emailResendBtn">Send a new code</button>
                </div>
            </div>`;
    }
    if (e.address && e.verified) {
        body += `
            <div class="settings-row">
                <div class="settings-label"><div>Check that it works</div></div>
                <div class="settings-control">
                    <button class="btn btn-secondary btn-small" id="emailTestBtn">Send a test email</button>
                    <button class="btn btn-danger btn-small" id="emailRemoveBtn">Remove email</button>
                </div>
            </div>`;
    }
    return cardHtml("settingsEmailCard", "Email", "Add an email to get reminders and updates.", body);
}

function notificationsCardHtml() {
    const needsVerified = !(settingsData.email && settingsData.email.verified);
    const body =
        (needsVerified ? `<div class="settings-callout">Verify your email above to turn these on.</div>` : "") +
        settingRow({
            label: "Which tasks should emails cover?",
            hint: "Used by the daily digest and due-date reminders.",
            email: true,
            control: selectControl("email_scope", SCOPE_OPTIONS)
        }) +
        settingRow({
            label: "Daily digest", hint: "A morning email with what's on your plate today.", email: true, toggle: true,
            control: toggleControl("email_daily_digest")
        }) +
        settingRow({
            label: "Send it at", needs: "email_daily_digest", email: true,
            control: timeControl("digest_time")
        }) +
        settingRow({
            label: "Include overdue tasks", needs: "email_daily_digest", email: true, toggle: true,
            control: toggleControl("digest_include_overdue")
        }) +
        settingRow({
            label: "Also show what's coming up", needs: "email_daily_digest", email: true,
            control: selectControl("digest_upcoming_days", [["0", "Just today"], ["1", "Tomorrow too"], ["3", "The next 3 days"], ["7", "The next 7 days"]])
        }) +
        settingRow({
            label: "Skip it when nothing is due", needs: "email_daily_digest", email: true, toggle: true,
            control: toggleControl("digest_skip_empty")
        }) +
        settingRow({
            label: "Reminder before a task is due",
            hint: "Tasks with a date but no time count as 9:00 AM.",
            email: true,
            control: selectControl("email_due_reminder", [["off", "Off"], ["15", "15 minutes before"], ["60", "1 hour before"], ["180", "3 hours before"], ["1440", "1 day before"]])
        }) +
        settingRow({
            label: "When someone assigns me a task", email: true, toggle: true,
            control: toggleControl("email_task_assigned")
        }) +
        settingRow({
            label: "When I'm invited to a project or list", email: true, toggle: true,
            control: toggleControl("email_invites")
        });
    return cardHtml("settingsNotifCard", "Email notifications", "Choose what Orderly emails you about.", body);
}

function calendarCardHtml() {
    const f = settingsData.feed;
    let host = "";
    try {
        host = new URL(f.url).host;
    } catch (e) {
        host = f.url;
    }
    let warn = "";
    if (!f.public) {
        warn = `<div class="settings-callout">This server's address (${escapeHtml(host)}) can't be reached from the internet, so Google and Microsoft can't read the link below yet. It will work once the server is online at a public address.</div>`;
    } else if (!f.https) {
        warn = `<div class="settings-callout">This link starts with http://. Google and Outlook may refuse it. Use an https:// address if you can.</div>`;
    }
    const durations = [["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["90", "1½ hours"], ["120", "2 hours"]];
    const alarms = [["none", "No reminder"], ["0", "At the time"], ["5", "5 minutes before"], ["10", "10 minutes before"],
        ["15", "15 minutes before"], ["30", "30 minutes before"], ["60", "1 hour before"], ["120", "2 hours before"], ["1440", "1 day before"]];
    const body =
        settingRow({
            label: "Which tasks go on the calendar?",
            hint: "Applies to the Calendar page and to the Google / Outlook link.",
            control: selectControl("calendar_scope", SCOPE_OPTIONS)
        }) +
        settingRow({label: "Show completed tasks", toggle: true, control: toggleControl("calendar_show_completed")}) +
        settingRow({
            label: "Show repeating tasks on every day they come up",
            toggle: true,
            control: toggleControl("calendar_show_repeats")
        }) +
        `<div class="settings-subhead">Connect your calendar</div>
             <div class="settings-hint">Orderly puts your tasks on a separate &quot;Orderly&quot; calendar in your own account and keeps it up to date. Changes show up within seconds and reminders work.</div>
             <div id="integCalendarBlock">${integCalendarBlockHtml()}</div>
             <div class="settings-subhead">Or subscribe by link (read-only, slow to refresh)</div>
             ${warn}
             <div class="link-buttons">
                <a class="btn btn-primary btn-small" href="${escapeHtml(f.google)}" target="_blank" rel="noopener">Add to Google Calendar</a>
                <a class="btn btn-primary btn-small" href="${escapeHtml(f.outlook)}" target="_blank" rel="noopener">Add to Outlook.com</a>
                <a class="btn btn-primary btn-small" href="${escapeHtml(f.outlook_work)}" target="_blank" rel="noopener">Microsoft 365 (work or school)</a>
                <a class="btn btn-secondary btn-small" href="${escapeHtml(f.webcal)}">Apple Calendar</a>
             </div>
             <div class="copy-row">
                <input type="text" id="feedUrl" readonly value="${escapeHtml(f.url)}">
                <button class="btn btn-secondary btn-small" id="feedCopyBtn">Copy link</button>
             </div>
             <div class="settings-hint">Doing it by hand? In Google Calendar choose Other calendars → From URL. In Outlook choose Add calendar → Subscribe from web. Then paste the link.</div>
             <div class="settings-hint" style="margin-top:6px;">Anyone with this link can see your task names, so keep it private. <button class="link-btn" id="feedResetBtn">Make a new link</button> to stop the old one working.</div>
             <div class="settings-hint" style="margin-top:6px;">Google and Microsoft refresh linked calendars on their own schedule (Google can take several hours), so new changes may be slow to appear there.</div>` +
        settingRow({
            label: "Event length for tasks with a time",
            control: selectControl("calendar_event_minutes", durations)
        }) +
        settingRow({
            label: "Reminder on linked events",
            hint: "Some apps ignore this for linked calendars (Google does). All-day tasks count from 9:00 AM.",
            control: selectControl("calendar_alarm", alarms)
        }) +
        settingRow({
            label: "Put the list name in the event title",
            toggle: true,
            control: toggleControl("calendar_include_list_name")
        });
    return cardHtml("settingsCalendarCard", "Calendar", "Choose what shows up, and link it to your calendar app.", body);
}

function displayCardHtml() {
    const body =
        settingRow({label: "Dark mode", toggle: true, control: themeToggleControl()}) +
        settingRow({
            label: "Time zone",
            hint: "Used for the daily digest, reminders and calendar times.",
            control: selectControl("timezone", timeZoneOptions())
        }) +
        settingRow({
            label: "Time format",
            control: selectControl("time_format", [["12h", "12-hour (3:30 PM)"], ["24h", "24-hour (15:30)"]])
        }) +
        settingRow({
            label: "Week starts on",
            control: selectControl("week_start", [["sun", "Sunday"], ["mon", "Monday"]])
        }) +
        settingRow({
            label: "Priority for new tasks",
            control: selectControl("default_priority", [["low", "Low"], ["normal", "Normal"], ["high", "High"]])
        }) +
        settingRow({
            label: "Show completed tasks in lists",
            toggle: true,
            control: toggleControl("show_completed_tasks")
        });
    return cardHtml("settingsDisplayCard", "Display", "", body);
}

function renderSettingsPage() {
    if (!settingsData) return;
    const container = document.getElementById("settingsContainer");
    container.innerHTML = emailCardHtml() + notificationsCardHtml() + xPushCardHtml() + calendarCardHtml() + importCardHtml() + displayCardHtml();

    const themeSetting = document.getElementById("themeSettingToggle");
    if (themeSetting) {
        themeSetting.addEventListener("change", () => applyThemePreference(themeSetting.checked));
    }

    container.querySelectorAll("[data-setting]").forEach((el) => {
        el.addEventListener("change", () => {
            const key = el.dataset.setting;
            if (el.type === "checkbox") return saveSetting(key, el.checked);
            if (!el.value) {
                syncSettingsControls();
                return;
            } // e.g. a cleared time box
            saveSetting(key, el.value);
        });
    });
    wireEmailCard();
    wireCalendarCard();
    xWirePushCard();
    syncSettingsDisabled();
}

async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try {
        await fn();
    } catch (err) {
        showToast(err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function takePayload(res) {
    settingsData = res;
    appSettings = {...appSettings, ...res.settings};
    applySettings();
    renderSettingsPage();
}

function wireEmailCard() {
    const $ = (id) => document.getElementById(id);
    const on = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener("click", () => withBusy(el, fn));
    };
    const enter = (id, btnId) => {
        const el = $(id);
        if (el) el.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") $(btnId).click();
        });
    };

    on("emailSaveBtn", async () => {
        const address = $("emailInput").value.trim();
        if (!address) throw new Error("Enter an email address");
        const res = await call("set_email", {email: address});
        takePayload(res);
        if (res.sent) showToast("We emailed you a 6-digit code.");
        else if (res.error) showToast("Saved, but the code couldn't be sent: " + res.error);
    });
    on("emailVerifyBtn", async () => {
        takePayload(await call("verify_email", {code: $("emailCodeInput").value}));
        showToast("Email verified", {icon: "check"});
    });
    on("emailResendBtn", async () => {
        takePayload(await call("resend_email_code"));
        showToast("New code sent.");
    });
    on("emailTestBtn", async () => {
        await call("send_test_email");
        showToast("Test email sent. Check your inbox.");
    });
    on("emailRemoveBtn", async () => takePayload(await call("remove_email")));
    enter("emailInput", "emailSaveBtn");
    enter("emailCodeInput", "emailVerifyBtn");
}

function wireCalendarCard() {
    const copyBtn = document.getElementById("feedCopyBtn");
    copyBtn.addEventListener("click", async () => {
        const input = document.getElementById("feedUrl");
        try {
            await navigator.clipboard.writeText(input.value);
        } catch (e) {
            input.select();
            document.execCommand("copy");
        }
        showToast("Link copied");
    });
    document.getElementById("feedResetBtn").addEventListener("click", async () => {
        const ok = await confirmDialog({
            title: "Make a new calendar link?",
            message: "The old link will stop working, so you'll need to add the new one to your calendar app.",
            confirmLabel: "Make new link",
        });
        if (!ok) return;
        withBusy(null, async () => {
            takePayload(await call("reset_calendar_link"));
            showToast("New link made.");
        });
    });
}

// ============================================================
// Connected calendars (Google / Outlook) and importing tasks (Todoist)
// The server does the talking to Google and Microsoft; this is just the buttons and pickers.
// ============================================================
function integStatusHtml(i) {
    if (!i.configured) return "Not set up on this server yet. Add its client ID and secret on the server first (see the setup guide).";
    if (!i.connected) return i.kind === "calendar" ? "Not connected." : "Not connected. Connect it to choose lists to import.";
    let line = "Connected" + (i.account ? ` as ${escapeHtml(i.account)}` : "") + ".";
    if (i.last_error) line += ` <strong>${escapeHtml(i.last_error)}</strong>`;
    else if (i.kind === "calendar") line += i.last_sync ? ` Last synced ${escapeHtml(relativeTime(i.last_sync))}.` : " Syncing…";
    return line;
}

function integRowHtml(key, extraButtons) {
    const i = (settingsData.integrations || {})[key];
    if (!i) return "";
    const needsReconnect = !!(i.last_error && /reconnect/i.test(i.last_error));
    const btn = (act, label, primary) =>
        `<button type="button" class="btn ${primary ? "btn-primary" : "btn-secondary"} btn-small" data-integ="${act}" data-key="${key}">${label}</button>`;
    let buttons = "";
    if (i.configured) {
        if (!i.connected) buttons = btn("connect", "Connect", true);
        else {
            if (needsReconnect) buttons += btn("connect", "Reconnect", true);
            else if (i.kind === "calendar") buttons += btn("sync", "Sync now");
            else buttons += extraButtons || "";
            buttons += btn("disconnect", "Disconnect");
        }
    }
    return `<div class="settings-row"><div class="settings-label"><div>${escapeHtml(i.label)}</div>` +
        `<div class="settings-hint">${integStatusHtml(i)}</div></div>` +
        `<div class="settings-control link-buttons">${buttons}</div></div>`;
}

function integCalendarBlockHtml() {
    return integRowHtml("google_calendar") + integRowHtml("microsoft_calendar");
}

function integImportBlockHtml() {
    return `<div class="settings-row"><div class="settings-label"><div>Todoist</div>` +
        `<div class="settings-hint">Uses your personal API token for this one import. The token is not saved.</div></div>` +
        `<div class="settings-control link-buttons"><button type="button" class="btn btn-primary btn-small" data-integ="import-todoist" data-key="todoist">Import…</button></div></div>`;
}

function importCardHtml() {
    return cardHtml("settingsImportCard", "Import tasks",
        "Bring your tasks in from other apps. Run it again any time: tasks that were already imported are skipped.",
        `<div id="integImportBlock">${integImportBlockHtml()}</div>`);
}

function refreshIntegrationBlocks() {
    if (!settingsData) return;
    const a = document.getElementById("integCalendarBlock");
    if (a) a.innerHTML = integCalendarBlockHtml();
    const b = document.getElementById("integImportBlock");
    if (b) b.innerHTML = integImportBlockHtml();
}

function takeIntegrations(res) {
    settingsData.integrations = res.integrations;
    refreshIntegrationBlocks();
}

async function connectIntegration(key) {
    // Open the window right away (pop-up blockers only allow it inside the click), then point it at the sign-in page.
    const w = window.open("", "_blank");
    try {
        const {url} = await call("connect_integration", {provider: key});
        if (w) {
            w.location.href = url;
            showToast("Finish signing in in the new window.");
        } else {
            location.href = url;
        }
    } catch (err) {
        if (w) w.close();
        throw err;
    }
}

async function finishImport(res) {
    const added = res.results.reduce((n, r) => n + r.added, 0);
    const skipped = res.results.reduce((n, r) => n + r.skipped, 0);
    await loadDashboard();
    let text = added ? `Imported ${added} task${added === 1 ? "" : "s"}` : "Nothing new to import";
    if (skipped) text += ` (${skipped} already imported)`;
    showToast(text, {icon: added ? "check" : undefined});
}

function openImportPicker({title, intro, groups, onImport}) {
    openModal({
        title, intro, submitLabel: "Import", cancelLabel: "Cancel",
        fields: [{
            id: "ids", label: "", type: "custom",
            build() {
                const el = document.createElement("div");
                el.innerHTML = groups.map(g => `
                <label class="group-row">
                    <input type="checkbox" value="${escapeHtml(g.id)}" checked style="width: 10px;">
                    <div class="group-name">${escapeHtml(g.name)}</div>
                    <div class="settings-hint">
                        ${g.count} task${g.count === 1 ? "" : "s"}
                    </div>
                </label>
                `).join("");
                return {el, getValue: () => [...el.querySelectorAll("input:checked")].map((i) => i.value)};
            }
        }],
        async onSubmit(values) {
            if (!values.ids.length) throw new Error("Pick at least one.");
            await finishImport(await onImport(values.ids));
        }
    });
}

function openTodoistImport() {
    openModal({
        title: "Import from Todoist",
        intro: "In Todoist open Settings → Integrations → Developer, copy your API token and paste it below. It is used for this import only and is not saved.",
        submitLabel: "Continue", cancelLabel: "Cancel",
        fields: [{id: "token", label: "Todoist API token", type: "password", placeholder: "Paste your token"}],
        async onSubmit({token}) {
            if (!token) throw new Error("Paste your API token first.");
            const {groups} = await call("import_todoist_preview", {token});
            if (!groups.length) throw new Error("No active tasks were found in that Todoist account.");
            // The first window closes when this returns, so open the picker just after.
            setTimeout(() => openImportPicker({
                title: "Choose Todoist projects",
                intro: "Each project becomes a new list in Orderly, with the tasks assigned to you. Repeating tasks keep their schedule. Only active tasks are imported.",
                groups,
                onImport: (ids) => call("import_todoist", {token, ids})
            }), 0);
        }
    });
}

async function integAction(act, key) {
    if (act === "connect") return connectIntegration(key);
    if (act === "sync") {
        takeIntegrations(await call("sync_integration_now", {provider: key}));
        showToast("Calendar is up to date.");
    } else if (act === "disconnect") {
        const i = settingsData.integrations[key];
        const ok = await confirmDialog({
            title: `Disconnect ${i.label}?`,
            message: i.kind === "calendar"
                ? `Orderly will remove its "Orderly" calendar, and the events in it, from your account. Your Orderly tasks are not affected.`
                : "Orderly will forget this connection. Tasks you already imported stay where they are.",
            confirmLabel: "Disconnect", danger: true
        });
        if (!ok) return;
        takeIntegrations(await call("disconnect_integration", {provider: key}));
    } else if (act === "import-todoist") {
        openTodoistImport();
    }
}

document.getElementById("settingsContainer").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-integ]");
    if (b) withBusy(b, () => integAction(b.dataset.integ, b.dataset.key));
});

// ============================================================
// Live events
// ============================================================
function removeListFromDashboard(listId) {
    dashboard.standalone_lists = dashboard.standalone_lists.filter((l) => l.id !== listId);
    dashboard.projects.forEach((p) => {
        p.lists = p.lists.filter((l) => l.id !== listId);
    });
}

function resortCurrentTasks() {
    currentList.tasks.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (!a.completed) return ((a.sort_order || 0) - (b.sort_order || 0)) || (a.id - b.id);
        return (a.completed_at || "").localeCompare(b.completed_at || "");
    });
}

function handleLiveEvent(msg) {
    if (xOnLiveEvent(msg)) return;
    switch (msg.event) {
        case "task_added":
            if (currentList && currentList.id === msg.list_id && !currentList.tasks.some((t) => t.id === msg.task.id)) {
                currentList.tasks.push(msg.task);
                resortCurrentTasks();
                renderTasks();
            }
            if (currentView === "myTasks" && msg.task.assignee && msg.task.assignee.id === currentUser.id) openMyTasks();
            break;

        case "task_updated":
            if (currentList && currentList.id === msg.list_id) {
                const idx = currentList.tasks.findIndex((t) => t.id === msg.task.id);
                if (idx >= 0) currentList.tasks[idx] = msg.task;
                else currentList.tasks.push(msg.task);
                resortCurrentTasks();
                renderTasks();
            }
            if (currentView === "myTasks") openMyTasks();
            break;

        case "task_deleted":
            if (currentList && currentList.id === msg.list_id) {
                currentList.tasks = currentList.tasks.filter((t) => t.id !== msg.task_id);
                renderTasks();
            }
            if (currentView === "myTasks") openMyTasks();
            break;

        case "list_created": {
            const p = findProject(msg.project_id);
            if (p && !p.lists.some((l) => l.id === msg.list.id)) {
                p.lists.push(msg.list);
                renderSidebar();
            }
            break;
        }

        case "list_deleted":
            removeListFromDashboard(msg.list_id);
            if (currentList && currentList.id === msg.list_id) {
                showToast("This list was deleted.");
                currentList = null;
                switchView("welcome", {replace: true});
            }
            renderSidebar();
            break;

        case "list_member_added":
            if (currentList && currentList.id === msg.list_id) {
                currentList.members = msg.members;
                renderListHeader();
                renderAssigneeOptions();
            }
        {
            const sl = findStandaloneList(msg.list_id);
            if (sl) sl.members = msg.members;
        }
            break;

        case "list_left":
            removeListFromDashboard(msg.list_id);
            if (currentList && currentList.id === msg.list_id) {
                currentList = null;
                switchView("welcome", {replace: true});
            }
            renderSidebar();
            if (msg.reason === "removed") showToast(`You were removed from "${msg.name}".`);
            break;

        case "project_left":
            removeProjectLocally(msg.project_id);
            if (msg.reason === "removed") showToast(`You were removed from "${msg.name}".`);
            break;

        case "list_invite_accepted":
            if (!findStandaloneList(msg.list.id)) {
                dashboard.standalone_lists.push(msg.list);
                renderSidebar();
            }
            break;

        case "project_member_added": {
            const p = findProject(msg.project_id);
            if (p) {
                p.members = msg.members;
                renderSidebar();
            }
            if (currentList && currentList.project && currentList.project.id === msg.project_id) {
                openList(currentList.id);
            }
            break;
        }

        case "project_invite_accepted":
            if (!findProject(msg.project.id)) {
                dashboard.projects.push(msg.project);
                renderSidebar();
            }
            break;

        case "project_deleted":
            dashboard.projects = dashboard.projects.filter((p) => p.id !== msg.project_id);
            if (currentList && currentList.project && currentList.project.id === msg.project_id) {
                showToast("This project was deleted.");
                currentList = null;
                switchView("welcome", {replace: true});
            }
            renderSidebar();
            break;

        case "permissions_changed":
            scheduleAccessRefresh();
            break;

        case "settings_updated":
            appSettings = {...appSettings, ...msg.settings};
            if (settingsData) settingsData.settings = msg.settings;
            applySettings();
            if (currentView === "settings") {
                syncSettingsControls();
                syncSettingsDisabled();
            }
            break;

        case "integration_updated":
            if (msg.message) showToast(msg.message);
            call("get_settings").then((d) => {
                settingsData = d;
                refreshIntegrationBlocks();
            }).catch(() => {
            });
            break;

        case "notification_created":
            refreshNotifications();
            showToast("You have a new notification");
            break;
    }
}
