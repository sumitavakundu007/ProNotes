// ===== Config =====
const CLIENT_ID = window.APP_CONFIG?.GOOGLE_CLIENT_ID || "";
const ENABLE_DRIVE_SYNC = !!window.APP_CONFIG?.ENABLE_DRIVE_SYNC;
const SCOPES = [
  "https://www.googleapis.com/auth/drive.appdata",
  "openid",
  "email",
  "profile"
].join(" ");

// ===== State =====
let accessToken = null;
let currentUser = null; // { sub, email, name, picture }
let notes = [];         // in-memory notes
let activeNoteId = null;
let tokenClient = null;

// ===== Elements =====
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const userInfo = document.getElementById("userInfo");
const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");

const searchInput = document.getElementById("searchInput");
const tagListEl = document.getElementById("tagList");
const noteListEl = document.getElementById("noteList");
const noteCountEl = document.getElementById("noteCount");

const editorEl = document.getElementById("editor");
const blockFormatSel = document.getElementById("blockFormat");
const linkBtn = document.getElementById("linkBtn");
const clearBtn = document.getElementById("clearBtn");
const deleteNoteBtn = document.getElementById("deleteNoteBtn");

const noteTitleEl = document.getElementById("noteTitle");
const noteTagsEl = document.getElementById("noteTags");
const newNoteBtn = document.getElementById("newNoteBtn");

const syncSection = document.getElementById("syncSection");
const loadFromDriveBtn = document.getElementById("loadFromDriveBtn");
const saveToDriveBtn = document.getElementById("saveToDriveBtn");

// ===== Utilities =====
const qs = (s, el=document) => el.querySelector(s);

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11)
    .replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function nowISO() { return new Date().toISOString(); }

function getStorageKey() {
  if (!currentUser?.sub) return "notes_guest";
  return `notes_${currentUser.sub}`;
}

function getDriveFileIdKey() {
  if (!currentUser?.sub) return "driveFileId_guest";
  return `driveFileId_${currentUser.sub}`;
}

function htmlToText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || div.innerText || "").trim();
}

// ===== Auth =====
function initAuth() {
  if (!CLIENT_ID) {
    console.warn("Missing GOOGLE_CLIENT_ID. Sign-in will be disabled.");
    signInBtn.disabled = true;
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: ENABLE_DRIVE_SYNC ? SCOPES : "openid email profile",
    callback: async (tokenResponse) => {
      accessToken = tokenResponse.access_token;
      await fetchUserInfo();
      afterSignIn();
    }
  });
}

async function fetchUserInfo() {
  if (!accessToken) return;
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.ok) {
    const u = await res.json();
    currentUser = {
      sub: u.sub,
      email: u.email,
      name: u.name || u.email,
      picture: u.picture
    };
  }
}

function signIn() {
  tokenClient.requestAccessToken({ prompt: "consent" });
}

function signOut() {
  accessToken = null;
  currentUser = null;
  activeNoteId = null;
  notes = [];
  localStorage.removeItem("lastUser");
  renderUser();
  renderAll();
  // Optional: disable sync section visibility
  syncSection.style.display = ENABLE_DRIVE_SYNC ? "none" : "none";
}

function afterSignIn() {
  localStorage.setItem("lastUser", JSON.stringify(currentUser));
  renderUser();
  loadLocalNotes();
  renderAll();
  if (ENABLE_DRIVE_SYNC) {
    syncSection.style.display = "block";
  }
}

function renderUser() {
  if (currentUser) {
    userInfo.classList.remove("hidden");
    userName.textContent = currentUser.name || currentUser.email;
    if (currentUser.picture) {
      userAvatar.src = currentUser.picture;
      userAvatar.style.display = "block";
    } else {
      userAvatar.style.display = "none";
    }
    signInBtn.style.display = "none";
    signOutBtn.style.display = "inline-flex";
  } else {
    userInfo.classList.add("hidden");
    userAvatar.removeAttribute("src");
    signInBtn.style.display = "inline-flex";
    signOutBtn.style.display = "none";
  }
}

// ===== Notes CRUD =====
function blankNote() {
  return {
    id: uuid(),
    title: "",
    tags: [],
    contentHTML: "",
    contentText: "",
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

function loadLocalNotes() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    notes = raw ? JSON.parse(raw) : [];
  } catch {
    notes = [];
  }
  if (notes.length > 0 && !activeNoteId) {
    activeNoteId = notes[0].id;
  }
}

function saveLocalNotes() {
  localStorage.setItem(getStorageKey(), JSON.stringify(notes));
}

function createNote() {
  const n = blankNote();
  notes.unshift(n);
  activeNoteId = n.id;
  saveLocalNotes();
  renderAll();
  focusTitle();
}

function deleteActiveNote() {
  if (!activeNoteId) return;
  const i = notes.findIndex(n => n.id === activeNoteId);
  if (i >= 0) {
    notes.splice(i, 1);
    if (notes[i]) activeNoteId = notes[i].id;
    else if (notes[i-1]) activeNoteId = notes[i-1].id;
    else activeNoteId = null;
    saveLocalNotes();
    renderAll();
  }
}

function updateActiveNoteFromUI() {
  const n = notes.find(n => n.id === activeNoteId);
  if (!n) return;
  n.title = noteTitleEl.value.trim();
  n.tags = (noteTagsEl.value || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
  n.contentHTML = editorEl.innerHTML;
  n.contentText = htmlToText(n.contentHTML);
  n.updatedAt = nowISO();
  saveLocalNotes();
  renderList();
  renderTags();
}

function focusTitle() {
  noteTitleEl.focus();
  noteTitleEl.select?.();
}

// ===== Rendering =====
function renderAll() {
  renderList();
  renderEditor();
  renderTags();
}

function renderList(filter = {}) {
  const q = (searchInput.value || "").toLowerCase();
  const tagFilter = tagListEl.dataset.activeTag || null;

  const filtered = notes.filter(n => {
    if (tagFilter && !n.tags.includes(tagFilter)) return false;
    if (!q) return true;
    return (
      (n.title || "").toLowerCase().includes(q) ||
      (n.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (n.contentText || "").toLowerCase().includes(q)
    );
  });

  noteListEl.innerHTML = "";
  filtered.forEach(n => {
    const li = document.createElement("li");
    li.className = "note-item" + (n.id === activeNoteId ? " active" : "");
    li.innerHTML = `
      <div class="title">${escapeHtml(n.title || "Untitled")}</div>
      <div class="meta">
        ${n.tags.map(t => `#${escapeHtml(t)}`).join(" ")} ${n.tags.length ? "• " : ""}
        ${new Date(n.updatedAt).toLocaleString()}
      </div>
    `;
    li.addEventListener("click", () => {
      activeNoteId = n.id;
      renderEditor();
      renderList();
    });
    noteListEl.appendChild(li);
  });

  noteCountEl.textContent = `${filtered.length} note${filtered.length === 1 ? "" : "s"}`;
}

function renderEditor() {
  const n = notes.find(n => n.id === activeNoteId);
  if (!n) {
    noteTitleEl.value = "";
    noteTagsEl.value = "";
    editorEl.innerHTML = "";
    editorEl.contentEditable = false;
    deleteNoteBtn.disabled = true;
    return;
  }
  editorEl.contentEditable = true;
  deleteNoteBtn.disabled = false;

  noteTitleEl.value = n.title || "";
  noteTagsEl.value = (n.tags || []).join(", ");
  editorEl.innerHTML = n.contentHTML || "";
}

function renderTags() {
  const tagCounts = {};
  for (const n of notes) {
    for (const t of n.tags || []) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  tagListEl.innerHTML = "";
  const active = tagListEl.dataset.activeTag || null;

  // "All" filter
  const all = document.createElement("div");
  all.className = "tag" + (active ? "" : " active");
  all.textContent = "All";
  all.addEventListener("click", () => {
    delete tagListEl.dataset.activeTag;
    renderList();
    renderTags();
  });
  tagListEl.appendChild(all);

  Object.keys(tagCounts).sort().forEach(t => {
    const el = document.createElement("div");
    el.className = "tag" + (active === t ? " active" : "");
    el.textContent = `${t} (${tagCounts[t]})`;
    el.addEventListener("click", () => {
      tagListEl.dataset.activeTag = t;
      renderList();
      renderTags();
    });
    tagListEl.appendChild(el);
  });
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

// ===== Editor Toolbar =====
blockFormatSel.addEventListener("change", () => {
  document.execCommand("formatBlock", false, blockFormatSel.value);
  // Maintain caret focus in editor
  editorEl.focus();
  updateActiveNoteFromUI();
});

document.querySelectorAll(".tool[data-cmd]").forEach(btn => {
  btn.addEventListener("click", () => {
    const cmd = btn.dataset.cmd;
    document.execCommand(cmd, false, null);
    editorEl.focus();
    updateActiveNoteFromUI();
  });
});

linkBtn.addEventListener("click", () => {
  const url = prompt("Enter URL");
  if (url) {
    document.execCommand("createLink", false, url);
    editorEl.focus();
    updateActiveNoteFromUI();
  }
});

clearBtn.addEventListener("click", () => {
  editorEl.innerHTML = "";
  updateActiveNoteFromUI();
});

// ===== Events =====
signInBtn.addEventListener("click", () => signIn());
signOutBtn.addEventListener("click", () => signOut());
newNoteBtn.addEventListener("click", () => create_
