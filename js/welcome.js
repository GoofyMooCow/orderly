// Landing page (welcome): if the visitor is already signed in, offer "Open Orderly" instead of sign in / sign up.
(function () {
    let signedIn = false;
    try { signedIn = /(?:^|;\s*)authToken=[^;]+/.test(document.cookie); } catch (e) {}
    if (!signedIn) return;
    document.querySelectorAll("[data-signed-out]").forEach((el) => { el.hidden = true; });
    document.querySelectorAll("[data-signed-in]").forEach((el) => { el.hidden = false; });
})();
