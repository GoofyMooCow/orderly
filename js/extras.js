// ============================================================
// Orderly extras (loaded after app.js, uses its globals)
//   tags + filtering · comments + activity · search · board view · drag and drop
//   bulk actions · quick add · keyboard shortcuts · push notifications · installable app
// ============================================================
"use strict";

// ---------- small helpers ----------
const X_ICONS = {
    comment: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z"/></svg>',
    search: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    grip: '<svg class="icon-svg icon-fill" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    board: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="10.5" y="4" width="5" height="10" rx="1.5"/><rect x="17.5" y="4" width="3.5" height="13" rx="1.5"/></svg>',
    tag: '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9Z"/><circle cx="8" cy="8" r="1.3"/></svg>',
};

function xIcon(name) {
    return X_ICONS[name] || "";
}

function xTagColor(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
    return h;
}

function xTagChip(tag, extra = "") {
    return `<button type="button" class="tag-chip ${extra}" data-tag="${escapeHtml(tag)}" style="--h:${xTagColor(tag)}" title="Show tasks tagged #${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
}

function xNormalizeTag(raw) {
    return String(raw || "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 24);
}

function xDebounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function xAllLists() {
    const out = [];
    dashboard.projects.forEach((p) => p.lists.forEach((l) => out.push({id: l.id, name: l.name, project: p.name})));
    dashboard.standalone_lists.forEach((l) => out.push({id: l.id, name: l.name, project: null}));
    return out;
}

function xTypingInField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function xOverlayOpen() {
    return modalOverlay.classList.contains("visible") || dlgOverlay.classList.contains("visible");
}

// ---------- per-list view preference (list or board) ----------
let viewPrefs = {};
try {
    viewPrefs = JSON.parse(getCookie("viewPrefs") || "{}");
} catch (e) {
    viewPrefs = {};
}

function xIsBoard() {
    return !!(currentList && viewPrefs[currentList.id] === "board");
}

function xSetBoard(on) {
    if (!currentList) return;
    if (on) viewPrefs[currentList.id] = "board";
    else delete viewPrefs[currentList.id];
    setCookie("viewPrefs", JSON.stringify(viewPrefs), 31536000);
    xExitSelectMode(true);
    renderListHeader();
    renderTasks();
}

// ---------- filter (text + tags), only affects what you see ----------
let listFilter = {text: "", tags: new Set()};
let filterListId = null;
let filterBarKey = "";

function xFilterActive() {
    return !!(listFilter.text.trim() || listFilter.tags.size);
}

function xTaskMatchesFilter(t) {
    if (listFilter.tags.size && ![...listFilter.tags].every((g) => (t.tags || []).includes(g))) return false;
    const words = listFilter.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [t.name, t.notes || "", ...(t.tags || []), ...(t.subtasks || []).map((s) => s.name),
        t.assignee ? t.assignee.username : ""].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
}

// Called whenever a list is opened: a new list starts with no filter and no selection.
function xOnListOpened(listId) {
    lastListId = listId;
    if (filterListId !== listId) {
        filterListId = listId;
        listFilter = {text: "", tags: new Set()};
        filterBarKey = "";
        xExitSelectMode(true);
        kbTaskId = null;
    }
}

let lastListId = null;

function xListTags() {
    const counts = {};
    (currentList ? currentList.tasks : []).forEach((t) => (t.tags || []).forEach((g) => {
        counts[g] = (counts[g] || 0) + 1;
    }));
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
}

function xRenderFilterBar() {
    const bar = document.getElementById("filterBar");
    if (!bar) return;
    if (!currentList || !currentList.tasks.length) {
        bar.style.display = "none";
        bar.innerHTML = "";
        filterBarKey = "";
        return;
    }
    const tags = xListTags();
    const key = [currentList.id, tags.join(","), [...listFilter.tags].sort().join(",")].join("|");
    bar.style.display = "";
    if (key === filterBarKey) {
        const clear = bar.querySelector(".filter-clear");
        if (clear) clear.style.display = xFilterActive() ? "" : "none";
        return;
    }
    filterBarKey = key;
    const input = bar.querySelector(".filter-input");
    const hadFocus = input && document.activeElement === input;
    const value = input ? input.value : listFilter.text;
    bar.innerHTML = `
        <input type="search" class="filter-input" placeholder="Filter this list…" aria-label="Filter this list" autocomplete="off" value="${escapeHtml(value)}">
        <div class="filter-tags">${tags.map((g) => xTagChip(g, listFilter.tags.has(g) ? "active" : "")).join("")}</div>
        <button type="button" class="btn btn-secondary btn-small filter-clear" style="${xFilterActive() ? "" : "display:none"}">Clear</button>`;
    const inp = bar.querySelector(".filter-input");
    inp.addEventListener("input", () => {
        listFilter.text = inp.value;
        bar.querySelector(".filter-clear").style.display = xFilterActive() ? "" : "none";
        renderTasks();
    });
    bar.querySelectorAll(".tag-chip").forEach((chip) => chip.addEventListener("click", () => xToggleFilterTag(chip.dataset.tag)));
    bar.querySelector(".filter-clear").addEventListener("click", () => {
        listFilter = {text: "", tags: new Set()};
        filterBarKey = "";
        renderTasks();
    });
    if (hadFocus) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
    }
}

function xToggleFilterTag(tag) {
    if (listFilter.tags.has(tag)) listFilter.tags.delete(tag);
    else listFilter.tags.add(tag);
    renderTasks();
}

// ---------- pieces that renderTaskItem() / renderMyTasks() use ----------
function xRowLead(t) {
    if (selectMode) {
        return `<input type="checkbox" class="sel-box" data-task="${t.id}" ${selectedIds.has(t.id) ? "checked" : ""} aria-label="Select task">`;
    }
    if (can("edit_tasks") && !t.completed && getSortPref(currentList.id) === "default") {
        return `<span class="drag-handle" data-task="${t.id}" title="Drag to reorder" aria-label="Drag to reorder">${xIcon("grip")}</span>`;
    }
    return `<span class="drag-spacer"></span>`;
}

function xTagChips(t) {
    return (t.tags || []).map((g) => xTagChip(g)).join("");
}

function xCommentBadge(t) {
    return t.comment_count
        ? `<button type="button" class="comment-badge" data-task="${t.id}" title="Open comments">${xIcon("comment")} ${t.comment_count}</button>`
        : "";
}

function xCommentAction(t) {
    return `<button type="button" class="icon-btn task-comment" data-task="${t.id}" title="Comments &amp; activity" aria-label="Comments and activity">${xIcon("comment")}</button>`;
}

function xBindTaskChips(root) {
    root.querySelectorAll(".tag-chip[data-tag]").forEach((chip) => {
        if (chip.closest("#filterBar")) return;
        chip.addEventListener("click", (e) => {
            e.stopPropagation();
            if (currentView === "list" && currentList) xToggleFilterTag(chip.dataset.tag);
            else xOpenSearch("#" + chip.dataset.tag);
        });
    });
}

// After the list is drawn: wire up everything this file added to the rows.
function xBindTaskList(listEl) {
    xBindTaskChips(listEl);
    listEl.querySelectorAll(".comment-badge, .task-comment").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            xOpenTaskDetail(Number(btn.dataset.task), "comments");
        });
    });
    listEl.querySelectorAll(".task-name.readonly").forEach((el) => {
        el.addEventListener("click", () => xOpenTaskDetail(Number(el.dataset.task), "comments"));
    });
    listEl.querySelectorAll(".sel-box").forEach((box) => {
        box.addEventListener("change", () => {
            const id = Number(box.dataset.task);
            if (box.checked) selectedIds.add(id);
            else selectedIds.delete(id);
            xRenderBulkBar();
        });
    });
    listEl.querySelectorAll(".drag-handle").forEach((h) => {
        h.addEventListener("pointerdown", (e) => {
            const li = h.closest(".task-item");
            xStartDrag(e, {
                el: li, containerSel: "#taskList", itemSel: ".task-item:not(.completed)",
                targetSel: ".list-link[data-list]", canTarget: (el) => Number(el.dataset.list) !== currentList.id && can("edit_tasks"),
                onSort: xOnListSort, onTarget: (el) => xMoveTaskToList(Number(li.dataset.task), Number(el.dataset.list), el.textContent.trim()),
            });
        });
    });
    xApplyKbFocus();
}

function xApplyTask(task) {
    if (!currentList || currentList.id !== task.list_id) return;
    const i = currentList.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) currentList.tasks[i] = task;
    else currentList.tasks.push(task);
    resortCurrentTasks();
    renderTasks();
}

function xApplyOrders(listId, orders) {
    if (!currentList || currentList.id !== listId || !orders) return;
    currentList.tasks.forEach((t) => {
        if (orders[t.id] !== undefined) t.sort_order = orders[t.id];
    });
    resortCurrentTasks();
    renderTasks();
}

// ---------- live events from the server (called from handleLiveEvent) ----------
function xOnLiveEvent(msg) {
    switch (msg.event) {
        case "tasks_reordered":
            xApplyOrders(msg.list_id, msg.orders);
            return true;
        case "comment_added":
        case "comment_updated":
        case "comment_deleted":
            xOnCommentEvent(msg);
            return true;
    }
    return false;
}

// ============================================================
// Drag and drop (mouse, touch and pen, all with pointer events)
// Rows are dragged by their grip, cards by their body. While a drag is on, redraws wait until it ends.
// ============================================================
const dnd = {active: null, pendingRender: false};

function xDragging() {
    return !!dnd.active;
}

function xScrollParent(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement || document.documentElement;
}

function xStartDrag(e, cfg) {
    if (xDragging() || (e.pointerType === "mouse" && e.button !== 0)) return;
    const pid = e.pointerId, sx = e.clientX, sy = e.clientY;
    let started = false;
    const onMove = (ev) => {
        if (ev.pointerId !== pid) return;
        if (!started) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < (cfg.threshold ?? 4)) return;
            started = true;
            xBeginDrag(ev, cfg, cleanup);
        }
        ev.preventDefault();
        if (dnd.active) {
            dnd.active.x = ev.clientX;
            dnd.active.y = ev.clientY;
            xTickDrag();
        }
    };
    const onUp = (ev) => {
        if (ev.pointerId !== pid) return;
        cleanup();
        if (started && dnd.active) xEndDrag(false);
    };
    function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove, {passive: false});
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
}

function xBeginDrag(ev, cfg, cleanup) {
    const el = cfg.el, rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add("dnd-ghost");
    ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    el.classList.add("dnd-placeholder");
    document.body.classList.add("dnd-on");
    dnd.active = {
        cfg, el, ghost, cleanup, x: ev.clientX, y: ev.clientY, offX: ev.clientX - rect.left, offY: ev.clientY - rect.top,
        origParent: el.parentNode, origNext: el.nextSibling, overTarget: null, scroller: xScrollParent(el),
    };
    dnd.timer = setInterval(xTickDrag, 30);
    xTickDrag();
}

function xTickDrag() {
    const a = dnd.active;
    if (!a) return;
    a.ghost.style.left = (a.x - a.offX) + "px";
    a.ghost.style.top = (a.y - a.offY) + "px";
    // scroll when held near the top or bottom edge
    const edge = 70, speed = 14;
    if (a.y < edge) a.scroller.scrollTop -= speed;
    else if (a.y > window.innerHeight - edge) a.scroller.scrollTop += speed;

    const under = document.elementFromPoint(a.x, a.y);
    const cfg = a.cfg;
    const target = under && cfg.targetSel ? under.closest(cfg.targetSel) : null;
    const okTarget = target && (!cfg.canTarget || cfg.canTarget(target)) ? target : null;
    if (a.overTarget !== okTarget) {
        if (a.overTarget) a.overTarget.classList.remove("drop-hover");
        if (okTarget) okTarget.classList.add("drop-hover");
        a.overTarget = okTarget;
    }
    if (okTarget || !under || !cfg.containerSel) return;
    const container = under.closest(cfg.containerSel);
    if (!container) return;
    const items = Array.from(container.querySelectorAll(cfg.itemSel)).filter((i) => i !== a.el && !i.classList.contains("dnd-ghost"));
    let ref = null;
    for (const it of items) {
        const r = it.getBoundingClientRect();
        if (a.y < r.top + r.height / 2) {
            ref = it;
            break;
        }
    }
    if (ref) {
        if (a.el.nextElementSibling !== ref || a.el.parentNode !== ref.parentNode) ref.parentNode.insertBefore(a.el, ref);
    } else if (items.length) {
        const last = items[items.length - 1];
        if (last.nextElementSibling !== a.el) last.parentNode.insertBefore(a.el, last.nextSibling);
    } else if (a.el.parentNode !== container) {
        container.appendChild(a.el);
    }
}

function xEndDrag(cancelled) {
    const a = dnd.active;
    if (!a) return;
    clearInterval(dnd.timer);
    a.cleanup();
    a.ghost.remove();
    a.el.classList.remove("dnd-placeholder");
    document.body.classList.remove("dnd-on");
    if (a.overTarget) a.overTarget.classList.remove("drop-hover");
    const moved = a.el.parentNode !== a.origParent || a.el.nextSibling !== a.origNext;
    const target = a.overTarget;
    dnd.active = null;
    if (cancelled || target) {
        a.origParent.insertBefore(a.el, a.origNext);   // put it back; the server's update redraws it properly
    }
    if (!cancelled && target && a.cfg.onTarget) a.cfg.onTarget(target);
    else if (!cancelled && moved && a.cfg.onSort) a.cfg.onSort(a.el);
    if (dnd.pendingRender) {
        dnd.pendingRender = false;
        if (currentView === "list" && currentList) renderTasks();
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dnd.active) {
        e.preventDefault();
        xEndDrag(true);
    }
}, true);

async function xOnListSort(li) {
    const container = li.parentNode;
    const ids = Array.from(container.querySelectorAll(":scope > .task-item:not(.completed)")).map((x) => Number(x.dataset.task));
    try {
        const res = await call("reorder_tasks", {list_id: currentList.id, ordered_ids: ids});
        xApplyOrders(currentList.id, res.orders);
    } catch (err) {
        renderTasks();
        reportError(err, "Couldn't reorder the tasks");
    }
}

async function xMoveTaskToList(taskId, listId, listName) {
    try {
        await call("move_task", {task_id: taskId, list_id: listId});
        showToast(`Moved to ${listName}`);
    } catch (err) {
        renderTasks();
        reportError(err, "Couldn't move the task");
    }
}

// ============================================================
// Board view: To do · In progress · Done
// ============================================================
const BOARD_COLUMNS = [["todo", "To do"], ["doing", "In progress"], ["done", "Done"]];

function xBoardCardHtml(t) {
    const d = formatDeadline(t.deadline, t.deadline_time, t.completed);
    const subs = t.subtasks || [], subsDone = subs.filter((s) => s.completed).length;
    const meta =
        (d ? `<span class="deadline-badge ${d.overdue ? "overdue" : ""} ${d.label === "Today" ? "dueToday" : ""}">${escapeHtml(d.label)}</span>` : "") +
        repeatBadgeHtml(t) +
        (subs.length ? `<span class="subtask-badge static">${iconSvg("subtasks")} ${subsDone}/${subs.length}</span>` : "") +
        xCommentBadge(t) +
        (t.assignee ? `<span class="assignee-chip">${avatarHtml(t.assignee.username, 18)}${escapeHtml(t.assignee.username)}</span>` : "");
    const draggable = can("complete_tasks");
    return `
        <div class="board-card prio-${t.priority} ${t.completed ? "completed" : ""} ${draggable ? "draggable" : ""}" data-task="${t.id}">
            <div class="board-card-name"><span class="priority-dot priority-${t.priority}"></span><span>${escapeHtml(t.name)}</span></div>
            ${(t.tags || []).length ? `<div class="board-card-tags">${xTagChips(t)}</div>` : ""}
            ${meta ? `<div class="board-card-meta">${meta}</div>` : ""}
        </div>`;
}

function renderBoard() {
    const board = document.getElementById("boardView");
    board.style.display = "";
    const tasks = currentList.tasks.filter(xTaskMatchesFilter);
    const cols = {todo: [], doing: [], done: []};
    tasks.forEach((t) => (cols[t.status] || cols.todo).push(t));
    cols.done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    const doneShown = cols.done.slice(0, 40);
    board.innerHTML = BOARD_COLUMNS.map(([status, label]) => {
        const list = status === "done" ? doneShown : cols[status];
        const more = status === "done" && cols.done.length > doneShown.length ? `<div class="board-more">+${cols.done.length - doneShown.length} older</div>` : "";
        return `
            <div class="board-col" data-status="${status}">
                <div class="board-col-head"><span>${label}</span><span class="board-count">${cols[status].length}</span></div>
                <div class="board-col-body" data-status="${status}">${list.map(xBoardCardHtml).join("")}${more}</div>
            </div>`;
    }).join("");
    xBindTaskChips(board);
    board.querySelectorAll(".comment-badge").forEach((btn) => btn.addEventListener("click", (e) => {
        e.stopPropagation();
        xOpenTaskDetail(Number(btn.dataset.task), "comments");
    }));
    board.querySelectorAll(".board-card").forEach((card) => {
        const id = Number(card.dataset.task);
        card.addEventListener("click", () => {
            if (can("edit_tasks") || can("assign_tasks")) openEditTaskModal(id);
            else xOpenTaskDetail(id, "comments");
        });
        if (card.classList.contains("draggable")) {
            card.addEventListener("pointerdown", (e) => {
                if (e.target.closest("button, a, input")) return;
                xStartDrag(e, {
                    el: card, containerSel: ".board-col-body", itemSel: ".board-card", threshold: e.pointerType === "mouse" ? 5 : 8,
                    targetSel: ".list-link[data-list]", canTarget: (el) => Number(el.dataset.list) !== currentList.id && can("edit_tasks"),
                    onSort: xOnBoardDrop, onTarget: (el) => xMoveTaskToList(id, Number(el.dataset.list), el.textContent.trim()),
                });
            });
        }
    });
    xApplyKbFocus();
}

async function xOnBoardDrop(card) {
    const col = card.closest(".board-col-body");
    if (!col) return renderTasks();
    const status = col.dataset.status, id = Number(card.dataset.task);
    const task = currentList.tasks.find((t) => t.id === id);
    if (!task) return renderTasks();
    const ids = Array.from(col.querySelectorAll(".board-card")).map((c) => Number(c.dataset.task));
    try {
        if (status === task.status) {
            if (status === "done") return renderTasks();
            const res = await call("reorder_tasks", {list_id: currentList.id, ordered_ids: ids});
            xApplyOrders(currentList.id, res.orders);
        } else {
            const res = await call("set_task_status", {
                task_id: id, status, today: todayStr(), ordered_ids: status === "done" ? undefined : ids,
            });
            if (res.rolled) {
                const next = formatDeadline(res.task.deadline, res.task.deadline_time, false);
                showToast(`Done! Next due ${next.label}`);
            }
            xApplyTask(res.task);
            if (res.orders) xApplyOrders(currentList.id, res.orders);
        }
    } catch (err) {
        renderTasks();
        reportError(err, "Couldn't move the task");
    }
}

// ============================================================
// Select mode + bulk actions
// ============================================================
let selectMode = false;
const selectedIds = new Set();

function xExitSelectMode(silent) {
    selectMode = false;
    selectedIds.clear();
    if (!silent && currentView === "list" && currentList) {
        renderListHeader();
        renderTasks();
    }
}

function xToggleSelectMode() {
    if (!currentList || xIsBoard()) return;
    selectMode = !selectMode;
    selectedIds.clear();
    renderListHeader();
    renderTasks();
}

function xVisibleTaskIds() {
    return currentList ? getSortedTasksForDisplay().map((t) => t.id) : [];
}

function xRenderBulkBar() {
    const bar = document.getElementById("bulkBar");
    if (!bar) return;
    if (!selectMode || !currentList || currentView !== "list") {
        bar.style.display = "none";
        bar.innerHTML = "";
        return;
    }
    const visible = new Set(xVisibleTaskIds());
    Array.from(selectedIds).forEach((id) => {
        if (!visible.has(id)) selectedIds.delete(id);   // a filter or a live update took it off the screen
    });
    const n = selectedIds.size, off = n ? "" : "disabled";
    bar.style.display = "";
    bar.innerHTML = `
        <span class="bulk-count">${n ? `${n} selected` : "Select tasks"}</span>
        <button type="button" class="btn btn-secondary btn-small" data-bulk="all">${n && n === xVisibleTaskIds().length ? "Select none" : "Select all"}</button>
        <button type="button" class="btn btn-secondary btn-small" data-bulk="complete" ${off}>Complete</button>
        <button type="button" class="btn btn-secondary btn-small" data-bulk="reopen" ${off}>Reopen</button>
        <button type="button" class="btn btn-secondary btn-small" data-bulk="edit" ${off}>Change…</button>
        <button type="button" class="btn btn-danger btn-small" data-bulk="delete" ${off}>Delete</button>
        <button type="button" class="btn btn-primary btn-small" data-bulk="done">Done</button>`;
    bar.querySelectorAll("[data-bulk]").forEach((b) => b.addEventListener("click", () => xBulkClick(b.dataset.bulk)));
}

async function xBulkClick(what) {
    if (what === "done") return xExitSelectMode();
    if (what === "all") {
        const all = xVisibleTaskIds();
        if (selectedIds.size === all.length) selectedIds.clear();
        else all.forEach((id) => selectedIds.add(id));
        renderTasks();
        return;
    }
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    if (what === "edit") return xOpenBulkEdit(ids);
    if (what === "delete") {
        const ok = await confirmDialog({
            title: `Delete ${ids.length} task${ids.length === 1 ? "" : "s"}?`,
            message: "They'll be deleted for everyone who can see this list, including their comments. This can't be undone.",
            confirmLabel: "Delete", danger: true,
        });
        if (!ok) return;
    }
    await xRunBulk(ids, what);
}

async function xRunBulk(ids, op, value) {
    try {
        const res = await call("bulk_tasks", {task_ids: ids, op, value, today: todayStr()});
        let msg = `${res.updated} task${res.updated === 1 ? "" : "s"} updated`;
        if (res.skipped) msg += `, ${res.skipped} skipped` + (res.reasons.length ? ` (${res.reasons.join("; ")})` : "");
        showToast(msg);
        selectedIds.clear();
        renderTasks();
        return res;
    } catch (err) {
        reportError(err, "Couldn't update the tasks");
    }
}

function xOpenBulkEdit(ids) {
    const wrap = document.createElement("div");
    const lists = xAllLists().filter((l) => !currentList || l.id !== currentList.id);
    const known = xKnownTags.map((t) => t.tag);
    wrap.innerHTML = `
        <label class="resched-label" for="bulkWhat">Change</label>
        <select id="bulkWhat">
            <option value="priority">Priority</option>
            <option value="assign">Assigned to</option>
            <option value="deadline">Due date</option>
            <option value="add_tag">Add a tag</option>
            <option value="remove_tag">Remove a tag</option>
            <option value="move">Move to another list</option>
        </select>
        <div id="bulkValue" style="margin-top:12px"></div>`;
    const what = wrap.querySelector("#bulkWhat"), holder = wrap.querySelector("#bulkValue");
    const draw = () => {
        const k = what.value;
        if (k === "priority") holder.innerHTML = `<select id="bulkVal"><option value="high">High</option><option value="normal" selected>Normal</option><option value="low">Low</option></select>`;
        else if (k === "assign") holder.innerHTML = `<select id="bulkVal"><option value="">Unassigned</option>${currentList.members.map((m) => `<option value="${m.id}">${escapeHtml(m.username)}</option>`).join("")}</select>`;
        else if (k === "deadline") holder.innerHTML = `<input type="date" id="bulkVal" value="${todayStr()}"><div class="resched-hint">Leave empty to clear the date. Repeating tasks are skipped.</div>`;
        else if (k === "move") holder.innerHTML = lists.length ? `<select id="bulkVal">${lists.map((l) => `<option value="${l.id}">${escapeHtml(l.project ? l.project + " › " + l.name : l.name)}</option>`).join("")}</select>` : `<div class="resched-hint">You have no other lists.</div>`;
        else holder.innerHTML = `<input type="text" id="bulkVal" maxlength="24" placeholder="tag" list="xTagSuggest" autocomplete="off">`;
        xFillTagSuggest(known);
    };
    what.addEventListener("change", draw);
    draw();
    openModal({
        title: `Change ${ids.length} task${ids.length === 1 ? "" : "s"}`,
        fields: [{id: "x", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        submitLabel: "Apply",
        onSubmit: async () => {
            const k = what.value, el = wrap.querySelector("#bulkVal");
            let value = el ? el.value : null;
            if (k === "assign") value = value ? Number(value) : null;
            else if (k === "move") value = Number(value);
            else if (k === "deadline") value = value || null;
            else if (k === "add_tag" || k === "remove_tag") {
                value = xNormalizeTag(value);
                if (!value) throw new Error("Type a tag");
            }
            if (k === "move" && !value) throw new Error("Pick a list");
            await xRunBulk(ids, k, value);
        },
    });
}

// ============================================================
// Tag suggestions (a <datalist> shared by every tag box)
// ============================================================
let xKnownTags = [];

function xFillTagSuggest(tags) {
    let dl = document.getElementById("xTagSuggest");
    if (!dl) {
        dl = document.createElement("datalist");
        dl.id = "xTagSuggest";
        document.body.appendChild(dl);
    }
    dl.innerHTML = tags.map((t) => `<option value="${escapeHtml(t)}"></option>`).join("");
}

async function xLoadKnownTags() {
    try {
        xKnownTags = (await call("get_tags")).tags;
        xFillTagSuggest(xKnownTags.map((t) => t.tag));
    } catch (e) {
    }
}

function xBuildTagInput(initial) {
    const tags = (initial || []).slice();
    const wrap = document.createElement("div");
    wrap.className = "tag-input";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add a tag and press Enter";
    input.maxLength = 24;
    input.setAttribute("list", "xTagSuggest");
    input.autocomplete = "off";
    const draw = () => {
        wrap.querySelectorAll(".tag-pill").forEach((n) => n.remove());
        tags.forEach((g) => {
            const pill = document.createElement("span");
            pill.className = "tag-pill";
            pill.style.setProperty("--h", xTagColor(g));
            pill.innerHTML = `#${escapeHtml(g)} <button type="button" aria-label="Remove tag ${escapeHtml(g)}">×</button>`;
            pill.querySelector("button").addEventListener("click", () => {
                tags.splice(tags.indexOf(g), 1);
                draw();
            });
            wrap.insertBefore(pill, input);
        });
    };
    const add = () => {
        input.value.split(/[,\s]+/).map(xNormalizeTag).filter(Boolean).forEach((g) => {
            if (!tags.includes(g) && tags.length < 10) tags.push(g);
        });
        input.value = "";
        draw();
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            e.stopImmediatePropagation();   // Enter here adds a tag; it must not also save the whole window
            add();
        } else if (e.key === "Backspace" && !input.value && tags.length) {
            tags.pop();
            draw();
        }
    });
    input.addEventListener("blur", add);
    wrap.appendChild(input);
    draw();
    xLoadKnownTags();
    return {el: wrap, getValue: () => {
        add();
        return tags.slice();
    }};
}

function xBuildNotesField(initial) {
    const ta = document.createElement("textarea");
    ta.className = "notes-input";
    ta.rows = 3;
    ta.maxLength = 5000;
    ta.placeholder = "Details, links, anything worth remembering";
    ta.value = initial || "";
    return {el: ta, getValue: () => ta.value.trim()};
}

// What the Edit Task window adds (see openEditTaskModal in app.js).
function xEditFields(task) {
    return [
        {id: "tags", label: "Tags", type: "custom", build: () => xBuildTagInput(task.tags)},
        {id: "notes", label: "Notes", type: "custom", build: () => xBuildNotesField(task.notes)},
        {
            id: "_thread", label: "", type: "custom", build: () => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "btn btn-secondary btn-small";
                b.innerHTML = `${xIcon("comment")} Comments &amp; activity${task.comment_count ? ` (${task.comment_count})` : ""}`;
                b.addEventListener("click", () => {
                    closeModal();
                    xOpenTaskDetail(task.id, "comments");
                });
                return {el: b, getValue: () => null};
            },
        },
    ];
}

// ============================================================
// Task details: comments and activity history
// ============================================================
let detail = null;   // {taskId, tab, comments, activity, canComment, root}

function xFindTask(id) {
    return currentList ? currentList.tasks.find((t) => t.id === id) : null;
}

function xRichText(text) {
    let h = escapeHtml(text);
    h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    h = h.replace(/(^|[\s(])@([\w.\-]+)/g, '$1<span class="mention">@$2</span>');
    return h.replace(/\n/g, "<br>");
}

function xActivityText(a) {
    const d = a.detail || {};
    const when = (v) => {
        if (!v) return "no date";
        const [date, time] = v.split(" ");
        return formatDeadline(date, time || null, false).label;
    };
    const pr = {low: "low", normal: "normal", high: "high"};
    switch (a.action) {
        case "created": return "created this task";
        case "completed": return d.next ? `completed it (next due ${when(d.next)})` : "completed it";
        case "reopened": return "reopened it";
        case "renamed": return `renamed it from “${d.from}” to “${d.to}”`;
        case "due": return d.to ? `changed the due date from ${when(d.from)} to ${when(d.to)}` : "removed the due date";
        case "priority": return `changed the priority from ${pr[d.from] || d.from} to ${pr[d.to] || d.to}`;
        case "repeat": return d.to ? `set it to repeat: ${d.to}` : "stopped it repeating";
        case "assigned": return d.to ? `assigned it to ${d.to}` : `unassigned it${d.from ? " from " + d.from : ""}`;
        case "notes": return "edited the notes";
        case "tags": {
            const parts = [];
            if ((d.added || []).length) parts.push("added " + d.added.map((t) => "#" + t).join(", "));
            if ((d.removed || []).length) parts.push("removed " + d.removed.map((t) => "#" + t).join(", "));
            return parts.join(" and ") || "changed the tags";
        }
        case "status": return `moved it to ${d.to === "doing" ? "In progress" : "To do"}`;
        case "moved": return `moved it from “${d.from}” to “${d.to}”`;
        case "commented": return "commented";
        case "subtask_added": return `added the subtask “${d.name}”`;
        case "subtask_done": return `finished the subtask “${d.name}”`;
        case "subtask_undone": return `reopened the subtask “${d.name}”`;
        case "subtask_removed": return `removed the subtask “${d.name}”`;
    }
    return a.action;
}

function xOpenTaskDetail(taskId, tab = "comments") {
    const task = xFindTask(taskId);
    if (!task) return;
    const root = document.createElement("div");
    root.className = "td";
    detail = {taskId, tab, comments: null, activity: null, canComment: can("add_tasks") || can("complete_tasks") || can("edit_tasks"), root};
    root.innerHTML = `
        <div class="td-head"><div class="td-name"></div><div class="td-meta"></div></div>
        <div class="td-tabs" role="tablist">
            <button type="button" role="tab" data-tab="comments">Comments <span class="td-count"></span></button>
            <button type="button" role="tab" data-tab="activity">Activity</button>
        </div>
        <div class="td-body" aria-live="polite"></div>
        <div class="td-composer">
            <textarea rows="2" maxlength="2000" placeholder="Write a comment… use @name to mention someone"></textarea>
            <button type="button" class="btn btn-primary btn-small td-send">Send</button>
        </div>`;
    root.querySelectorAll(".td-tabs button").forEach((b) => b.addEventListener("click", () => {
        detail.tab = b.dataset.tab;
        xRenderDetail();
        if (detail.tab === "activity") xLoadActivity();
    }));
    const ta = root.querySelector("textarea"), send = root.querySelector(".td-send");
    const submit = async () => {
        const body = ta.value.trim();
        if (!body) return;
        send.disabled = true;
        try {
            await call("add_comment", {task_id: taskId, body});
            ta.value = "";
        } catch (err) {
            showToast(err.message);
        } finally {
            send.disabled = false;
            ta.focus();
        }
    };
    send.addEventListener("click", submit);
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
        }
    });
    openModal({
        title: "Task", wide: true, hideSubmit: true, cancelLabel: "Close",
        fields: [{id: "x", label: "", type: "custom", build: () => ({el: root, getValue: () => null})}],
        onSubmit: async () => {
        },
    });
    xRenderDetail();
    xLoadComments(true);
    if (tab === "activity") {
        detail.tab = "activity";
        xRenderDetail();
        xLoadActivity();
    }
}

function xDetailOpen() {
    return detail && detail.root.isConnected && modalOverlay.classList.contains("visible");
}

function xRenderDetail() {
    if (!detail) return;
    const root = detail.root, task = xFindTask(detail.taskId);
    if (task) {
        const d = formatDeadline(task.deadline, task.deadline_time, task.completed);
        root.querySelector(".td-name").textContent = task.name;
        root.querySelector(".td-meta").innerHTML =
            (d ? `<span class="deadline-badge ${d.overdue ? "overdue" : ""}">${escapeHtml(d.label)}</span>` : "") +
            (task.assignee ? `<span class="assignee-chip">${avatarHtml(task.assignee.username, 18)}${escapeHtml(task.assignee.username)}</span>` : "") +
            xTagChips(task);
        xBindTaskChips(root.querySelector(".td-meta"));
        root.querySelectorAll(".td-meta .tag-chip").forEach((c) => c.addEventListener("click", () => closeModal()));
    }
    root.querySelectorAll(".td-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === detail.tab));
    root.querySelector(".td-count").textContent = detail.comments ? `(${detail.comments.length})` : "";
    root.querySelector(".td-composer").style.display = detail.tab === "comments" && detail.canComment ? "" : "none";
    const body = root.querySelector(".td-body");
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    if (detail.tab === "comments") {
        if (!detail.comments) body.innerHTML = `<div class="td-empty">Loading…</div>`;
        else if (!detail.comments.length) body.innerHTML = `<div class="td-empty">No comments yet.${detail.canComment ? " Start the conversation below." : ""}</div>`;
        else body.innerHTML = detail.comments.map(xCommentHtml).join("");
        body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => xCommentAct(b.dataset.act, Number(b.closest(".td-comment").dataset.id))));
        if (atBottom) body.scrollTop = body.scrollHeight;
    } else if (!detail.activity) {
        body.innerHTML = `<div class="td-empty">Loading…</div>`;
    } else if (!detail.activity.length) {
        body.innerHTML = `<div class="td-empty">Nothing yet.</div>`;
    } else {
        body.innerHTML = detail.activity.map((a) => `
            <div class="td-act"><span class="td-act-who">${escapeHtml(a.user ? a.user.username : "Someone")}</span> ${escapeHtml(xActivityText(a))}
            <span class="td-time" title="${escapeHtml(new Date(a.created_at + "Z").toLocaleString())}">${escapeHtml(relativeTime(a.created_at))}</span></div>`).join("");
    }
}

function xCommentHtml(c) {
    const mine = c.user && c.user.id === currentUser.id;
    const canDel = mine || can("delete_tasks");
    return `
        <div class="td-comment" data-id="${c.id}">
            ${avatarHtml(c.user ? c.user.username : "?", 28)}
            <div class="td-comment-main">
                <div class="td-comment-top"><strong>${escapeHtml(c.user ? c.user.username : "Someone")}</strong>
                    <span class="td-time" title="${escapeHtml(new Date(c.created_at + "Z").toLocaleString())}">${escapeHtml(relativeTime(c.created_at))}</span>${c.edited_at ? `<span class="td-time"> · edited</span>` : ""}</div>
                <div class="td-text">${xRichText(c.body)}</div>
                ${mine || canDel ? `<div class="td-actions">${mine ? `<button type="button" data-act="edit">Edit</button>` : ""}${canDel ? `<button type="button" data-act="delete">Delete</button>` : ""}</div>` : ""}
            </div>
        </div>`;
}

async function xCommentAct(act, id) {
    const c = detail && detail.comments.find((x) => x.id === id);
    if (!c) return;
    const row = detail.root.querySelector(`.td-comment[data-id="${id}"]`);
    if (act === "delete") {
        const ok = await confirmDialog({title: "Delete this comment?", message: "This can't be undone.", confirmLabel: "Delete", danger: true});
        if (!ok) return;
        try {
            await call("delete_comment", {comment_id: id});
        } catch (err) {
            showToast(err.message);
        }
        return;
    }
    const text = row.querySelector(".td-text");
    text.innerHTML = `<textarea rows="3" maxlength="2000"></textarea><div class="td-actions"><button type="button" data-save>Save</button><button type="button" data-cancel>Cancel</button></div>`;
    const ta = text.querySelector("textarea");
    ta.value = c.body;
    ta.focus();
    row.querySelector(".td-comment-main > .td-actions").style.display = "none";
    text.querySelector("[data-cancel]").addEventListener("click", xRenderDetail);
    text.querySelector("[data-save]").addEventListener("click", async () => {
        try {
            await call("edit_comment", {comment_id: id, body: ta.value});
        } catch (err) {
            showToast(err.message);
        }
    });
}

async function xLoadComments(initial) {
    const id = detail && detail.taskId;
    try {
        const res = await call("get_comments", {task_id: id});
        if (!detail || detail.taskId !== id) return;
        detail.comments = res.comments;
        detail.canComment = res.can_comment;
        xRenderDetail();
        if (initial) {
            const ta = detail.root.querySelector("textarea");
            if (ta && detail.tab === "comments" && detail.canComment && !res.comments.length) ta.focus();
        }
    } catch (err) {
        showToast(err.message);
    }
}

async function xLoadActivity() {
    const id = detail && detail.taskId;
    try {
        const res = await call("get_task_activity", {task_id: id});
        if (!detail || detail.taskId !== id) return;
        detail.activity = res.activity;
        xRenderDetail();
    } catch (err) {
        showToast(err.message);
    }
}

function xOnCommentEvent(msg) {
    if (currentList && currentList.id === msg.list_id) {
        const t = xFindTask(msg.task_id);
        if (t && msg.comment_count !== undefined && t.comment_count !== msg.comment_count) {
            t.comment_count = msg.comment_count;
            renderTasks();
        }
    }
    if (!xDetailOpen() || detail.taskId !== msg.task_id || !detail.comments) return;
    if (msg.event === "comment_added") {
        if (!detail.comments.some((c) => c.id === msg.comment.id)) detail.comments.push(msg.comment);
        if (msg.comment.user && msg.comment.user.id !== currentUser.id && detail.root.querySelector(".td-composer textarea") !== document.activeElement) {
            const body = detail.root.querySelector(".td-body");
            body.scrollTop = body.scrollHeight;
        }
    } else if (msg.event === "comment_updated") {
        detail.comments = detail.comments.map((c) => (c.id === msg.comment.id ? msg.comment : c));
    } else {
        detail.comments = detail.comments.filter((c) => c.id !== msg.comment_id);
    }
    if (detail.activity) detail.activity = null;
    xRenderDetail();
    if (detail.tab === "activity") xLoadActivity();
}

// ============================================================
// Search (Ctrl/Cmd+K or "/")
// ============================================================
function xOpenSearch(initial = "") {
    const root = document.createElement("div");
    root.className = "sr";
    root.innerHTML = `
        <div class="sr-box">${xIcon("search")}<input type="search" class="sr-input" placeholder="Search tasks, notes, comments, lists… (#tag to filter)" autocomplete="off" aria-label="Search"></div>
        <div class="sr-results" role="listbox"></div>`;
    const input = root.querySelector(".sr-input"), results = root.querySelector(".sr-results");
    let items = [], active = -1, seq = 0;

    const paint = () => items.forEach((el, i) => el.classList.toggle("active", i === active));
    const hint = (t) => {
        results.innerHTML = `<div class="td-empty">${t}</div>`;
        items = [];
        active = -1;
    };
    const run = async () => {
        const q = input.value.trim();
        if (!q) return hint("Search across every list you can open.");
        const mine = ++seq;
        let res;
        try {
            res = await call("search_all", {q});
        } catch (err) {
            return hint(escapeHtml(err.message));
        }
        if (mine !== seq) return;
        if (!res.tasks.length && !res.lists.length) return hint("Nothing found.");
        const label = {notes: "in notes", comment: "in a comment", subtask: "in a subtask", tag: "by tag"};
        results.innerHTML =
            (res.lists.length ? `<div class="sr-head">Lists</div>` + res.lists.map((l) => `
                <div class="sr-item" role="option" data-list="${l.id}"><span class="sr-title">${escapeHtml(l.name)}</span><span class="sr-sub">${escapeHtml(l.project_name ? "Project: " + l.project_name : "List")}</span></div>`).join("") : "") +
            (res.tasks.length ? `<div class="sr-head">Tasks</div>` + res.tasks.map((t) => `
                <div class="sr-item ${t.completed ? "done" : ""}" role="option" data-list="${t.list_id}" data-task="${t.id}" data-matched="${t.matched}">
                    <span class="sr-title">${escapeHtml(t.name)}</span>
                    <span class="sr-sub">${escapeHtml(t.project_name ? t.project_name + " › " : "")}${escapeHtml(t.list_name)}${t.matched !== "name" ? ` · ${label[t.matched] || ""}` : ""}${t.completed ? " · done" : ""}</span>
                    ${t.snippet ? `<span class="sr-snippet">${escapeHtml(t.snippet)}</span>` : ""}
                </div>`).join("") : "");
        items = Array.from(results.querySelectorAll(".sr-item"));
        active = items.length ? 0 : -1;
        paint();
        items.forEach((el) => el.addEventListener("click", () => pick(el)));
    };
    const pick = (el) => {
        closeModal();
        if (el.dataset.task) xGoToTask(Number(el.dataset.list), Number(el.dataset.task), el.dataset.matched);
        else openList(Number(el.dataset.list));
    };
    input.addEventListener("input", xDebounce(run, 180));
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!items.length) return;
            active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            paint();
            items[active].scrollIntoView({block: "nearest"});
        } else if (e.key === "Enter" && items[active]) {
            e.preventDefault();
            pick(items[active]);
        }
    });
    openModal({
        title: "Search", wide: true, hideSubmit: true, cancelLabel: "Close",
        fields: [{id: "x", label: "", type: "custom", build: () => ({el: root, getValue: () => null})}],
        onSubmit: async () => {
        },
    });
    hint("Search across every list you can open.");
    input.value = initial;
    setTimeout(() => {
        input.focus();
        if (initial) run();
    }, 30);
}

async function xGoToTask(listId, taskId, matched) {
    try {
        await openList(listId);
    } catch (err) {
        return reportError(err, "Couldn't open that list");
    }
    const task = xFindTask(taskId);
    if (!task) return;
    if (matched === "subtask") {
        expandedTasks.add(taskId);
        renderTasks();
    }
    if (xFilterActive()) {
        listFilter = {text: "", tags: new Set()};
        filterBarKey = "";
        renderTasks();
    }
    if (task.completed && !appSettings.show_completed_tasks) showToast("That task is done. Completed tasks are hidden in Settings.");
    requestAnimationFrame(() => {
        const el = document.querySelector(`#taskList .task-item[data-task="${taskId}"], #boardView .board-card[data-task="${taskId}"]`);
        if (!el) return;
        el.scrollIntoView({block: "center", behavior: "smooth"});
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 2200);
    });
    if (matched === "comment") xOpenTaskDetail(taskId, "comments");
}

// ============================================================
// Quick add: type "call dentist tomorrow 3pm #health !high @sam" and see what it'll do before you add it
// ============================================================
let keepAsTyped = false;

function xKeepAsTyped() {
    return keepAsTyped;
}

function xResetQuick() {
    keepAsTyped = false;
    const p = document.getElementById("quickPreview");
    if (p) {
        p.innerHTML = "";
        p.style.display = "none";
    }
}

function xQuickChips(p) {
    const chips = [];
    if (p.deadline) {
        const d = formatDeadline(p.deadline, p.deadline_time || null, false);
        chips.push(`<span class="q-chip">${iconSvg("calendar")} ${escapeHtml(d.label)}</span>`);
    }
    if (p.repeat) chips.push(`<span class="q-chip">${iconSvg("repeat")} ${escapeHtml(p.repeat)}</span>`);
    if (p.priority) chips.push(`<span class="q-chip">${escapeHtml(p.priority[0].toUpperCase() + p.priority.slice(1))} priority</span>`);
    (p.tags || []).forEach((g) => chips.push(`<span class="q-chip">#${escapeHtml(g)}</span>`));
    if (p.assignee) chips.push(`<span class="q-chip">${iconSvg("user")} ${escapeHtml(p.assignee)}</span>`);
    return chips;
}

// Wires a text box to a preview line. getListId() says which list the task will go into.
function xBindQuickPreview(input, preview, getListId) {
    let seq = 0;
    const update = xDebounce(async () => {
        const text = input.value.trim();
        const mine = ++seq;
        if (!text || keepAsTyped) {
            preview.style.display = "none";
            return;
        }
        try {
            const res = await call("parse_quick_add", {text, list_id: getListId(), today: todayStr()});
            if (mine !== seq) return;
            const chips = xQuickChips(res.parsed);
            if (!chips.length) {
                preview.style.display = "none";
                return;
            }
            preview.style.display = "";
            preview.innerHTML = `<span class="q-name">${escapeHtml(res.parsed.name)}</span>${chips.join("")}<button type="button" class="q-keep">Keep as typed</button>`;
            preview.querySelector(".q-keep").addEventListener("click", () => {
                keepAsTyped = true;
                preview.style.display = "none";
                input.focus();
            });
        } catch (e) {
            preview.style.display = "none";
        }
    }, 250);
    input.addEventListener("input", () => {
        keepAsTyped = false;
        update();
    });
}

function xOpenQuickAdd() {
    const lists = xAllLists();
    if (!lists.length) return showToast("Make a list first.");
    const wrap = document.createElement("div");
    const start = lists.some((l) => l.id === lastListId) ? lastListId : lists[0].id;
    wrap.innerHTML = `
        <input type="text" class="qa-input" placeholder="What needs doing? e.g. pay rent every month #bills !high" maxlength="300" autocomplete="off">
        <div class="quick-preview" style="display:none"></div>
        <label class="resched-label" for="qaList">Add to</label>
        <select id="qaList">${lists.map((l) => `<option value="${l.id}" ${l.id === start ? "selected" : ""}>${escapeHtml(l.project ? l.project + " › " + l.name : l.name)}</option>`).join("")}</select>`;
    const input = wrap.querySelector(".qa-input"), sel = wrap.querySelector("#qaList");
    xBindQuickPreview(input, wrap.querySelector(".quick-preview"), () => Number(sel.value));
    sel.addEventListener("change", () => input.dispatchEvent(new Event("input")));
    openModal({
        title: "Quick add",
        fields: [{id: "x", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        submitLabel: "Add task",
        onSubmit: async () => {
            const name = input.value.trim();
            if (!name) throw new Error("Type a task first");
            const listId = Number(sel.value);
            await call("add_task", {list_id: listId, name, quick: !keepAsTyped, today: todayStr()});
            lastListId = listId;
            xResetQuick();
            const l = lists.find((x) => x.id === listId);
            showToast(`Added to ${l ? l.name : "your list"}`);
        },
    });
    setTimeout(() => input.focus(), 30);
}

// ============================================================
// List header buttons (Board / Select)
// ============================================================
function xHeaderButtonsHtml() {
    return `<button class="btn btn-secondary btn-small" id="xViewBtn" title="Switch between list and board (B)">${xIcon("board")} ${xIsBoard() ? "List view" : "Board view"}</button>` +
        (xIsBoard() ? "" : `<button class="btn btn-secondary btn-small ${selectMode ? "is-on" : ""}" id="xSelectBtn" title="Select several tasks (S)">${selectMode ? "Cancel selecting" : "Select"}</button>`);
}

function xBindHeader() {
    const v = document.getElementById("xViewBtn");
    if (v) v.onclick = () => xSetBoard(!xIsBoard());
    const s = document.getElementById("xSelectBtn");
    if (s) s.onclick = xToggleSelectMode;
}

// ============================================================
// Calendar: drag a task chip onto another day to reschedule it (desktop)
// ============================================================
function xBindCalendarDrag() {
    document.querySelectorAll(".calendar-task-chip[data-task]").forEach((chip) => {
        const id = Number(chip.dataset.task);
        const t = calendarTasks.find((x) => x.id === id);
        if (!t || chip.dataset.future === "1" || t.completed || t.can_reschedule === false) return;
        chip.classList.add("draggable");
        chip.addEventListener("pointerdown", (e) => {
            if (e.pointerType !== "mouse") return;
            xStartDrag(e, {
                el: chip, threshold: 6, targetSel: ".calendar-cell:not(.empty)",
                canTarget: (cell) => cell.dataset.date !== chip.dataset.date && cell.dataset.date >= todayStr(),
                onTarget: async (cell) => {
                    const suppress = (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                    };
                    window.addEventListener("click", suppress, {capture: true, once: true});   // the drop shouldn't also "open the list"
                    setTimeout(() => window.removeEventListener("click", suppress, true), 50);
                    try {
                        await call("reschedule_task", {task_id: id, deadline: cell.dataset.date, deadline_time: t.deadline_time || null, today: todayStr()});
                        showToast(`Moved to ${formatDeadline(cell.dataset.date, t.deadline_time || null, false).label}`);
                        await loadCalendar();
                    } catch (err) {
                        reportError(err, "Couldn't reschedule the task");
                    }
                },
            });
        });
    });
}

// ============================================================
// Keyboard shortcuts
// ============================================================
let kbTaskId = null;

function xKbItems() {
    return Array.from(document.querySelectorAll("#taskList > .task-item"));
}

function xApplyKbFocus() {
    document.querySelectorAll(".kb-focus").forEach((e) => e.classList.remove("kb-focus"));
    if (kbTaskId == null) return;
    const el = document.querySelector(`#taskList > .task-item[data-task="${kbTaskId}"], #boardView .board-card[data-task="${kbTaskId}"]`);
    if (el) el.classList.add("kb-focus");
}

function xKbMove(dir) {
    const items = xKbItems();
    if (!items.length) return;
    let i = items.findIndex((li) => Number(li.dataset.task) === kbTaskId);
    i = i < 0 ? (dir > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, i + dir));
    kbTaskId = Number(items[i].dataset.task);
    xApplyKbFocus();
    items[i].scrollIntoView({block: "nearest"});
}

const SHORTCUTS = [
    ["Search everything", "/ or Ctrl/⌘ K"],
    ["Add a task (quick add)", "N"],
    ["Go to My Tasks / Calendar / Settings", "G then M / C / S"],
    ["Move between tasks", "J / K or ↓ / ↑"],
    ["Complete the highlighted task", "Space"],
    ["Edit it", "Enter or E"],
    ["Comments and activity", "C"],
    ["Switch between list and board", "B"],
    ["Select several tasks", "S"],
    ["Show this help", "?"],
];

function xOpenHelp() {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<table class="kb-table">${SHORTCUTS.map(([a, k]) => `<tr><td>${escapeHtml(a)}</td><td>${k.split(" ").map((p) => ["or", "then", "/"].includes(p) ? ` ${p} ` : `<kbd>${escapeHtml(p)}</kbd>`).join("")}</td></tr>`).join("")}</table>
        <div class="resched-hint">Shortcuts work when you're not typing in a box.</div>`;
    openModal({
        title: "Keyboard shortcuts", wide: true, hideSubmit: true, cancelLabel: "Close",
        fields: [{id: "x", label: "", type: "custom", build: () => ({el: wrap, getValue: () => null})}],
        onSubmit: async () => {
        },
    });
}

let gPending = false, gTimer = null;
document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || !sessionActive) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        if (xOverlayOpen()) return;
        e.preventDefault();
        xOpenSearch();
        return;
    }
    if (mod || e.altKey || xOverlayOpen() || xDragging()) return;
    if (e.key === "Escape") {
        if (selectMode) xExitSelectMode();
        else if (kbTaskId != null) {
            kbTaskId = null;
            xApplyKbFocus();
        }
        return;
    }
    if (xTypingInField(document.activeElement)) return;
    const onButton = document.activeElement && /^(BUTTON|A|SUMMARY)$/.test(document.activeElement.tagName);
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (gPending) {
        gPending = false;
        clearTimeout(gTimer);
        const sel = {m: ".my-tasks-link", c: ".calendar-link", s: ".settings-link"}[key];
        if (sel) {
            e.preventDefault();
            document.querySelector(sel).click();
        }
        return;
    }
    const inList = currentView === "list" && currentList;
    const task = inList && kbTaskId != null ? xFindTask(kbTaskId) : null;
    switch (key) {
        case "/":
            e.preventDefault();
            xOpenSearch();
            break;
        case "?":
            e.preventDefault();
            xOpenHelp();
            break;
        case "n": {
            e.preventDefault();
            const bar = document.getElementById("addTaskBar");
            if (inList && bar && bar.style.display !== "none") document.getElementById("newTaskName").focus();
            else xOpenQuickAdd();
            break;
        }
        case "g":
            gPending = true;
            gTimer = setTimeout(() => {
                gPending = false;
            }, 1200);
            break;
        case "b":
            if (inList) xSetBoard(!xIsBoard());
            break;
        case "s":
            if (inList) xToggleSelectMode();
            break;
        case "j":
        case "ArrowDown":
            if (inList && !xIsBoard()) {
                e.preventDefault();
                xKbMove(1);
            }
            break;
        case "k":
        case "ArrowUp":
            if (inList && !xIsBoard()) {
                e.preventDefault();
                xKbMove(-1);
            }
            break;
        case " ":
        case "x":
            if (!task || onButton) break;
            e.preventDefault();
            if (selectMode) {
                const box = document.querySelector(`#taskList .sel-box[data-task="${task.id}"]`);
                if (box) box.click();
            } else {
                const cb = document.querySelector(`#taskList .task-checkbox[data-task="${task.id}"]`);
                if (cb && !cb.disabled) cb.click();
            }
            break;
        case "Enter":
        case "e":
            if (!task || onButton) break;
            e.preventDefault();
            if (can("edit_tasks") || can("assign_tasks")) openEditTaskModal(task.id);
            else xOpenTaskDetail(task.id, "comments");
            break;
        case "c":
            if (task) {
                e.preventDefault();
                xOpenTaskDetail(task.id, "comments");
            }
            break;
    }
});

// ============================================================
// Push notifications + installable app
// ============================================================
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (currentView === "settings") renderSettingsPage();
});
window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    if (currentView === "settings") renderSettingsPage();
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("../sw.js").catch(() => {
        });
    });
}

function xIsInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function xPushBrowserSupport() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function xDeviceLabel() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${browser} on ${os}` : browser;
}

function xKeyToBytes(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// The page's service worker, or null if it isn't running (never wait forever for it).
async function xServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
        return await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
    } catch (e) {
        return null;
    }
}

async function xCurrentSubscription() {
    if (!xPushBrowserSupport()) return null;
    try {
        const reg = await xServiceWorker();
        return reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) {
        return null;
    }
}

async function xEnablePush() {
    const push = settingsData.push;
    if (!push || !push.supported) throw new Error("Push notifications aren't set up on this server yet.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications are blocked. Allow them for this site in your browser's settings, then try again.");
    const reg = await xServiceWorker();
    if (!reg) throw new Error("Orderly's background service isn't running yet. Reload the page and try again. (It needs https, or localhost.)");
    const opts = {userVisibleOnly: true, applicationServerKey: xKeyToBytes(push.public_key)};
    let sub;
    try {
        sub = await reg.pushManager.subscribe(opts);
    } catch (err) {   // an old subscription made with a different server key
        const old = await reg.pushManager.getSubscription();
        if (!old) throw err;
        await old.unsubscribe();
        sub = await reg.pushManager.subscribe(opts);
    }
    settingsData.push = await call("save_push_subscription", {subscription: sub.toJSON(), label: xDeviceLabel()});
}

async function xDisablePush() {
    const sub = await xCurrentSubscription();
    if (sub) {
        try {
            settingsData.push = await call("remove_push_subscription", {endpoint: sub.endpoint});
        } finally {
            await sub.unsubscribe().catch(() => {
            });
        }
    }
}

// Keeps the server's copy of this device's subscription current (browsers sometimes replace it).
async function xAfterSettingsLoaded() {
    try {
        if (!settingsData || !settingsData.push || !settingsData.push.supported || !xPushBrowserSupport()) return;
        if (Notification.permission !== "granted") return;
        const sub = await xCurrentSubscription();
        if (sub && !settingsData.push.devices.some((d) => d.endpoint === sub.endpoint)) {
            settingsData.push = await call("save_push_subscription", {subscription: sub.toJSON(), label: xDeviceLabel()});
        }
    } catch (e) {
    }
}

function xPushCardHtml() {
    const push = settingsData.push || {supported: false, devices: []};
    const callout = (t) => `<div class="settings-callout">${t}</div>`;
    let note = "";
    if (!push.supported) note = callout("Push notifications aren't set up on this server yet. The server needs the <code>pywebpush</code> package (<code>pip install pywebpush</code>), then a restart.");
    else if (!xPushBrowserSupport()) note = callout("This browser can't receive push notifications. On an iPhone or iPad, add Orderly to your Home Screen first (Share, then Add to Home Screen) and open it from there.");
    else if (Notification.permission === "denied") note = callout("Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.");
    const device = push.supported && xPushBrowserSupport()
        ? `<div class="settings-row"><div class="settings-label"><div>This device</div><div class="settings-hint" id="pushDeviceState">Checking…</div></div>
            <div class="settings-control link-buttons"><button type="button" class="btn btn-primary btn-small" id="pushToggleBtn" disabled>…</button>
            <button type="button" class="btn btn-secondary btn-small" id="pushTestBtn" style="display:none">Send a test</button></div></div>` : "";
    const others = push.devices.length
        ? `<div class="settings-row stack"><div class="settings-label"><div>Devices that get push notifications</div></div>
            <div class="push-devices">${push.devices.map((d) => `<div class="push-device"><span>${escapeHtml(d.label || "Device")} <span class="settings-hint">· added ${escapeHtml(relativeTime(d.created_at))}</span></span>
            <button type="button" class="btn btn-secondary btn-small" data-push-remove="${escapeHtml(d.endpoint)}">Remove</button></div>`).join("")}</div></div>` : "";
    const installRow = xIsInstalled()
        ? `<div class="settings-row"><div class="settings-label"><div>Installed as an app</div><div class="settings-hint">You're using Orderly from your home screen or desktop.</div></div></div>`
        : `<div class="settings-row"><div class="settings-label"><div>Install Orderly</div><div class="settings-hint">${deferredInstall ? "Add it to your home screen or desktop so it opens like any other app." : "In your browser's menu, choose Install app or Add to Home Screen."}</div></div>
            <div class="settings-control">${deferredInstall ? `<button type="button" class="btn btn-secondary btn-small" id="installBtn">Install</button>` : ""}</div></div>`;
    const prefs = !push.supported ? "" :
        settingRow({label: "Which tasks should reminders cover?", hint: "Used for due-date reminders.", control: selectControl("push_scope", SCOPE_OPTIONS)}) +
        settingRow({
            label: "Reminder when a task is due", hint: "Tasks with a date but no time count as 9:00 AM.",
            control: selectControl("push_due_reminder", [["off", "Off"], ["0", "When it's due"], ["15", "15 minutes before"], ["60", "1 hour before"], ["180", "3 hours before"], ["1440", "1 day before"]])
        }) +
        settingRow({label: "When someone assigns me a task", toggle: true, control: toggleControl("push_task_assigned")}) +
        settingRow({label: "When someone comments on my task or mentions me", toggle: true, control: toggleControl("push_comments")}) +
        settingRow({label: "When I'm invited to a project or list", toggle: true, control: toggleControl("push_invites")});
    return cardHtml("settingsPushCard", "Push notifications & app", "Reminders that reach you even when Orderly isn't open.", note + device + others + prefs + installRow);
}

async function xWirePushCard() {
    const $ = (id) => document.getElementById(id);
    document.querySelectorAll("[data-push-remove]").forEach((b) => b.addEventListener("click", () => withBusy(b, async () => {
        settingsData.push = await call("remove_push_subscription", {endpoint: b.dataset.pushRemove});
        const mine = await xCurrentSubscription();
        if (mine && mine.endpoint === b.dataset.pushRemove) await mine.unsubscribe().catch(() => {
        });
        renderSettingsPage();
    })));
    const install = $("installBtn");
    if (install) install.addEventListener("click", async () => {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        await deferredInstall.userChoice.catch(() => null);
        deferredInstall = null;
        renderSettingsPage();
    });
    const btn = $("pushToggleBtn");
    if (!btn) return;
    const state = $("pushDeviceState"), test = $("pushTestBtn");
    const sub = await xCurrentSubscription();
    if (!$("pushToggleBtn")) return;
    const on = !!sub && settingsData.push.devices.some((d) => d.endpoint === sub.endpoint);
    state.textContent = on ? "Push notifications are on for this device." : "Off. Turn them on to get reminders here.";
    btn.textContent = on ? "Turn off" : "Turn on";
    btn.className = `btn ${on ? "btn-secondary" : "btn-primary"} btn-small`;
    btn.disabled = false;
    test.style.display = on ? "" : "none";
    btn.addEventListener("click", () => withBusy(btn, async () => {
        if (on) await xDisablePush();
        else await xEnablePush();
        renderSettingsPage();
        showToast(on ? "Push notifications turned off here." : "Push notifications are on.");
    }));
    test.addEventListener("click", () => withBusy(test, async () => {
        await call("send_test_push");
        showToast("Test sent. It should show up in a moment.");
    }));
}

// ---------- wiring that runs once ----------
(function () {
    const input = document.getElementById("newTaskName"), preview = document.getElementById("quickPreview");
    if (input && preview) xBindQuickPreview(input, preview, () => (currentList ? currentList.id : null));
    const sb = document.getElementById("sidebarSearch");
    if (sb) sb.addEventListener("click", () => {
        if (typeof closeSidebar === "function") closeSidebar();
        xOpenSearch();
    });
})();
