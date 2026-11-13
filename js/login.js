// ============================================================
// Config + helpers
// ============================================================
const WS_BASE = "wss://scaling-fidgeting-blooming.ngrok-free.dev";
const APP_URL = "../app";
const HOME_URL = "../";

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(";").shift();
    return null;
}
function setCookie(name, value, maxAgeSeconds) {
    document.cookie = `${name}=${value}; path=/; max-age=${maxAgeSeconds}`;
}

// Theme: the saved choice from the app wins, otherwise follow the device.
(function applyTheme() {
    const saved = getCookie("theme");
    const dark = saved ? saved === "dark" : window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
})();

// Already signed in? Go straight to the app (replace, so Back doesn't bounce here).
if (getCookie("authToken")) location.replace(APP_URL);

const $ = (id) => document.getElementById(id);
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4"/><path d="M6.6 6.7C3.9 8.5 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
document.querySelectorAll(".eye").forEach((b) => { b.innerHTML = EYE; });

const title = $("formTitle"), sub = $("formSub"), message = $("message");
const usernameInput = $("username"), passwordInput = $("password"), password2 = $("password2");
const emailInput = $("email"), codeInput = $("resetCode");
const submitBtn = $("submitBtn"), submitLabel = $("submitLabel");

let authMode = "signin";   // signin | signup | forgot | reset
let resetIdentifier = "";
let busy = false;

function say(text, kind) {
    message.textContent = text || "";
    message.className = "message" + (text && kind ? " " + kind : "");
}

function setBusy(on) {
    busy = on;
    submitBtn.disabled = on;
    submitBtn.classList.toggle("loading", on);
}

const COPY = {
    signin: ["Welcome back", "Sign in to pick up where you left off.", "Sign in"],
    signup: ["Create your account", "It only takes a few seconds.", "Sign up"],
    forgot: ["Forgot password?", "Enter your username or email and we'll send you a 6-digit code.", "Send reset code"],
    reset:  ["New password", "Enter the code from your email and choose a new password.", "Reset password"],
};

function setMode(mode, keepMessage) {
    authMode = mode;
    const forgot = mode === "forgot", reset = mode === "reset", signup = mode === "signup";
    const c = COPY[mode];
    title.textContent = c[0];
    sub.textContent = c[1];
    submitLabel.textContent = c[2];
    document.title = "Orderly – " + (signup ? "Sign up" : forgot || reset ? "Reset password" : "Sign in");

    $("fUsername").hidden = reset;
    usernameInput.placeholder = forgot ? "Username or email" : "Username";
    $("fCode").hidden = !reset;
    $("fEmail").hidden = !signup;
    $("fPassword").hidden = forgot;
    passwordInput.placeholder = reset ? "New password" : "Password";
    passwordInput.autocomplete = mode === "signin" ? "current-password" : "new-password";
    $("fPassword2").hidden = !(signup || reset);
    password2.placeholder = reset ? "Verify new password" : "Verify password";
    $("in").hidden = mode === "signup";
    $("up").hidden = mode !== "signup";

    $("switchRow").hidden = forgot || reset;
    $("switchText").textContent = signup ? "Already have an account?" : "New here?";
    $("switchBtn").textContent = signup ? "Sign in" : "Sign up";
    $("forgotLink").hidden = mode !== "signin";
    $("resendLink").hidden = !reset;
    $("backToSignin").hidden = !(forgot || reset);

    if (!keepMessage) say("");
    if (reset) codeInput.focus();

    // Keep the address in step so a refresh or a shared link lands in the same place.
    if (mode === "signin" || mode === "signup") {
        try {
            const url = new URL(location.href);
            if (mode === "signup") url.searchParams.set("mode", "signup");
            else url.searchParams.delete("mode");
            history.replaceState(history.state, "", url.pathname + url.search + url.hash);
        } catch (e) {}
    }
}

$("switchBtn").onclick = () => setMode(authMode === "signup" ? "signin" : "signup");
$("forgotLink").onclick = () => setMode("forgot");
$("backToSignin").onclick = () => { resetIdentifier = ""; setMode("signin"); };

document.querySelectorAll(".eye").forEach((btn) => {
    btn.onclick = () => {
        const input = $(btn.dataset.eye);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    };
});

// The back button on the page, and the logo, always go home.
$("backLink").addEventListener("click", (e) => { e.preventDefault(); location.href = HOME_URL; });

// Start in sign-up when the address says ?mode=signup
const startMode = new URLSearchParams(location.search).get("mode");
setMode(startMode === "signup" ? "signup" : "signin");

try {
    const notice = sessionStorage.getItem("authNotice");
    if (notice) { sessionStorage.removeItem("authNotice"); say(notice, "error"); }
} catch (e) {}

// ============================================================
// Server calls
// ============================================================
function wsRequestOnce(url, payload) {
    return new Promise((resolve, reject) => {
        let done = false;
        const sock = new WebSocket(url);
        const timer = setTimeout(() => { if (!done) { done = true; try { sock.close(); } catch (e) {} reject(new Error("timeout")); } }, 15000);
        sock.onopen = () => sock.send(JSON.stringify(payload));
        sock.onerror = (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } };
        sock.onmessage = (event) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { resolve(JSON.parse(event.data)); } catch (e) { reject(e); }
            sock.close();
        };
    });
}

// ============================================================
// Invite links: keep the token for this tab so the app can pick it up after signing in.
// ============================================================
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
    } catch (e) {}
    pendingInvite = token ? String(token).slice(0, 200) : null;
})();

(async function showInviteBanner() {
    if (!pendingInvite) return;
    const banner = document.createElement("div");
    banner.className = "invite-banner";
    banner.textContent = "You've been invited to join something on Orderly. Sign in or sign up to see the invite.";
    $("inviteSlot").appendChild(banner);
    try {
        const r = await wsRequestOnce(WS_BASE + "/invites/preview", { token: pendingInvite });
        if (r.status === "ok") {
            const who = r.inviter ? r.inviter : "Someone";
            banner.textContent = `${who} invited you to join the ${r.kind} “${r.name}”. Sign in or sign up to accept or decline.`;
        } else {
            banner.textContent = r.message || "That invite link isn't valid any more.";
            try { sessionStorage.removeItem("pendingInvite"); } catch (e) {}
            pendingInvite = null;
        }
    } catch (e) { /* keep the generic text; the link is still kept */ }
})();

// ============================================================
// Submit
// ============================================================
function finish(token, extra) {
    setCookie("authToken", token, 2592000);
    if (extra && extra.email_pending) { try { sessionStorage.setItem("emailPending", "1"); } catch (e) {} }
    // replace(), so the Back button from the app doesn't land on a login form while signed in
    setTimeout(() => location.replace(APP_URL), 400);
}

async function sendResetCode(identifier) {
    setBusy(true);
    say("Sending…");
    try {
        const r = await wsRequestOnce(WS_BASE + "/accounts/forgot", { identifier });
        if (r.status !== "ok") { say(r.message, "error"); return; }
        resetIdentifier = identifier;
        setMode("reset", true);
        say(r.message + " Codes expire in 15 minutes.", "ok");
    } catch (err) {
        say("Connection error. Please try again.", "error");
    } finally {
        setBusy(false);
    }
}
$("resendLink").onclick = () => { if (!busy) sendResetCode(resetIdentifier); };

$("authForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;

    if (authMode === "forgot") {
        const identifier = usernameInput.value.trim();
        if (!identifier) { say("Enter your username or email.", "error"); return; }
        sendResetCode(identifier);
        return;
    }

    if (authMode === "reset") {
        const code = codeInput.value.replace(/\s+/g, "");
        const np = passwordInput.value.trim();
        if (!/^\d{6}$/.test(code)) { say("Enter the 6-digit code from the email.", "error"); return; }
        if (!np) { say("Enter a new password.", "error"); return; }
        if (np !== password2.value.trim()) { say("Passwords do not match.", "error"); return; }
        setBusy(true);
        say("Processing…");
        try {
            const r = await wsRequestOnce(WS_BASE + "/accounts/reset", { identifier: resetIdentifier, code, password: np });
            if (r.status === "ok") { say("Password changed! Signing you in…", "ok"); finish(r.token); }
            else { say(r.message, "error"); setBusy(false); }
        } catch (err) { say("Connection error. Please try again.", "error"); setBusy(false); }
        return;
    }

    const signup = authMode === "signup";
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const verify = password2.value.trim();

    if (!username || !password || (signup && !verify)) { say("Please fill out all fields.", "error"); return; }
    if (signup && password !== verify) { say("Passwords do not match.", "error"); return; }

    const email = signup ? emailInput.value.trim() : "";
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say("That email address doesn't look right.", "error"); return; }

    setBusy(true);
    say("Processing…");
    try {
        const r = await wsRequestOnce(
            WS_BASE + (signup ? "/accounts/create" : "/accounts/login"),
            signup ? { username, password, email } : { username, password }
        );
        if (r.status === "ok") { say("Success! Redirecting…", "ok"); finish(r.token, r); }
        else { say(r.message, "error"); setBusy(false); }
    } catch (err) {
        say("Connection error. Please try again.", "error");
        setBusy(false);
    }
});