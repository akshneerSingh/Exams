/* ============================================================================
   sync.js — Abgleich zwischen Geräten

   Wird von index.html und quiz.html geladen und stellt window.Sync bereit.

   Grundsatz: es wird nie eine Antwort verworfen, nur weil ein Gerät später
   geschrieben hat. Der Abgleich geht Frage für Frage, nicht Prüfung für
   Prüfung. Wer im Zug ohne Netz Block C löst und am MacBook Block A, hat
   danach beides.

   Dafür merkt sich diese Datei zu jeder beantworteten Frage, wann sie zuletzt
   geändert wurde. Die Engine in quiz.html weiss davon nichts: sie schreibt wie
   bisher nach localStorage, und der Aufruf wird hier abgefangen und mit einem
   Zeitstempel versehen.

   Löschungen sind Grabsteine (deleted: true) statt entfernter Einträge —
   sonst würde eine am Telefon gelöschte Prüfung beim nächsten Abgleich vom
   MacBook wieder auferstehen.
   ========================================================================== */

(function (global) {
  "use strict";

  const INDEX_KEY = "pruefung:index";
  const FOLDERS_KEY = "pruefung:folders";
  const META_KEY = "pruefung:sync";
  const DATA_PREFIX = "pruefung:data:";
  const PROGRESS_PREFIX = "pruefung:progress:";

  /* Den nativen Aufruf sichern, bevor er weiter unten ersetzt wird. */
  const NATIVE_SET = Storage.prototype.setItem;

  const listeners = [];
  /* Öffentliche Quizzes schreiben bei jeder Antwort. Bei einer ganzen
     Klasse liefe das Gratiskontingent von Cloudflare KV schnell voll,
     deshalb wird gebündelt statt sofort geschickt. */
  const PUSH_DELAY = 30000;
  let pushTimer = null;
  let pendingPush = false;
  let running = null;

  /* ====================== Speicher ====================== */

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  function meta() {
    const stored = readJSON(META_KEY, null);
    if (stored && stored.device) return stored;
    const fresh = {
      device: randomKey(10),
      endpoint: "",
      key: "",
      rev: null,
      lastSync: 0,
      uploaded: {},
      stamps: {}          /* examId → { updated, rounds: { i: { answers:{}, flags:{} } } } */
    };
    writeJSON(META_KEY, fresh);
    return fresh;
  }

  function saveMeta(next) { writeJSON(META_KEY, next); }

  /* Erst wenn wirklich etwas gelöst wurde, bekommt das Gerät einen Code.
     Sonst legte jeder Seitenaufruf einen leeren Eintrag im Speicher an. */
  function ensureKeyInternal() {
    const state = meta();
    if (state.key) return state.key;
    if (!state.endpoint) return "";
    state.key = randomKey(24);
    saveMeta(state);
    return state.key;
  }

  function randomKey(length) {
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    const bytes = new Uint8Array(length);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function now() { return Date.now(); }

  /* ====================== Ordner ====================== */

  function folders() { return readJSON(FOLDERS_KEY, {}); }
  function saveFolders(map) { writeJSON(FOLDERS_KEY, map); }

  function createFolder(name, parent) {
    const map = folders();
    const id = "f" + randomKey(8);
    map[id] = { id, name: String(name || "Ordner").trim().slice(0, 60), parent: parent || null, updated: now() };
    saveFolders(map);
    schedulePush();
    return id;
  }

  function renameFolder(id, name) {
    const map = folders();
    if (!map[id]) return;
    map[id].name = String(name || "").trim().slice(0, 60) || map[id].name;
    map[id].updated = now();
    saveFolders(map);
    schedulePush();
  }

  function moveFolder(id, parent) {
    const map = folders();
    if (!map[id] || id === parent) return;
    /* Kein Ordner darf in seinen eigenen Nachfahren wandern. */
    let walk = parent;
    while (walk) {
      if (walk === id) return;
      walk = map[walk] ? map[walk].parent : null;
    }
    map[id].parent = parent || null;
    map[id].updated = now();
    saveFolders(map);
    schedulePush();
  }

  /* Ordner löschen: Unterordner und Prüfungen rücken eine Ebene hoch. */
  function deleteFolder(id) {
    const map = folders();
    if (!map[id]) return;
    const parent = map[id].parent || null;
    Object.values(map).forEach((folder) => {
      if (folder.parent === id) { folder.parent = parent; folder.updated = now(); }
    });
    const list = readJSON(INDEX_KEY, []);
    list.forEach((entry) => {
      if (entry.folder === id) { entry.folder = parent; entry.updated = now(); }
    });
    writeJSON(INDEX_KEY, list);
    map[id] = { id, name: map[id].name, parent, updated: now(), deleted: true };
    saveFolders(map);
    schedulePush();
  }

  function folderPath(id) {
    const map = folders();
    const trail = [];
    let walk = id;
    while (walk && map[walk] && !map[walk].deleted && trail.length < 12) {
      trail.unshift(map[walk]);
      walk = map[walk].parent;
    }
    return trail;
  }

  function childFolders(parent) {
    return Object.values(folders())
      .filter((folder) => !folder.deleted && (folder.parent || null) === (parent || null))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }

  /* Flache Liste aller Ordner mit Tiefe — für Auswahlmenüs. */
  function folderTree(parent, depth) {
    parent = parent || null;
    depth = depth || 0;
    const out = [];
    childFolders(parent).forEach((folder) => {
      out.push({ folder, depth });
      if (depth < 8) out.push(...folderTree(folder.id, depth + 1));
    });
    return out;
  }

  function setExamFolder(examId, folderId) {
    const list = readJSON(INDEX_KEY, []);
    const entry = list.find((item) => item.id === examId);
    if (!entry) return;
    entry.folder = folderId || null;
    entry.updated = now();
    writeJSON(INDEX_KEY, list);
    schedulePush();
  }

  /* ====================== Fortschritt mit Zeitstempeln ====================== */

  /* Beim Schreiben wird der alte Stand gegen den neuen gehalten; nur wirklich
     geänderte Fragen bekommen einen neuen Zeitstempel. Sonst würde jede
     Neuberechnung alles "frisch" machen und der Abgleich verlöre seinen Sinn. */
  function stampProgress(examId, before, after) {
    const state = meta();
    const record = state.stamps[examId] || { updated: 0, rounds: {} };
    const at = now();

    (after && Array.isArray(after.rounds) ? after.rounds : []).forEach((round, index) => {
      const old = before && Array.isArray(before.rounds) ? before.rounds[index] : null;
      const slot = record.rounds[index] || { answers: {}, flags: {} };

      Object.keys(round.answers || {}).forEach((q) => {
        const a = JSON.stringify((old && old.answers ? old.answers[q] : null) || null);
        const b = JSON.stringify(round.answers[q] || null);
        if (a !== b) slot.answers[q] = at;
      });
      Object.keys(old && old.answers ? old.answers : {}).forEach((q) => {
        if (!(q in (round.answers || {}))) slot.answers[q] = at;
      });

      Object.keys(round.flags || {}).forEach((q) => {
        if (!(old && old.flags && old.flags[q])) slot.flags[q] = at;
      });
      Object.keys(old && old.flags ? old.flags : {}).forEach((q) => {
        if (!(round.flags || {})[q]) slot.flags[q] = at;
      });

      record.rounds[index] = slot;
    });

    record.updated = at;
    state.stamps[examId] = record;
    saveMeta(state);
  }

  /* Der Aufruf der Engine wird abgefangen, damit quiz.html unverändert bleibt. */
  function interceptProgressWrites() {
    if (Storage.prototype.setItem.__pruefungWrapped) return;
    const native = NATIVE_SET;
    const wrapped = function (key, value) {
      if (typeof key === "string" && key.startsWith(PROGRESS_PREFIX)) {
        const examId = key.slice(PROGRESS_PREFIX.length);
        let before = null;
        let after = null;
        try { before = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
        try { after = JSON.parse(value); } catch (_) {}
        native.call(this, key, value);
        if (after) { stampProgress(examId, before, after); ensureKeyInternal(); schedulePush(); }
        return;
      }
      return native.call(this, key, value);
    };
    wrapped.__pruefungWrapped = true;
    Storage.prototype.setItem = wrapped;
  }

  /* ====================== Zusammenführen ====================== */

  function mergeRecords(local, remote) {
    const out = {};
    const ids = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
    ids.forEach((id) => {
      const a = (local || {})[id];
      const b = (remote || {})[id];
      if (!a) { out[id] = b; return; }
      if (!b) { out[id] = a; return; }
      out[id] = (b.updated || 0) > (a.updated || 0) ? b : a;
    });
    return out;
  }

  function mergeProgress(local, remote) {
    const localData = local && local.data;
    const remoteData = remote && remote.data;
    if (!localData) return remote || null;
    if (!remoteData) return local || null;

    /* Verschiedene Prüfungen unter derselben Kennung: nicht zusammenführbar. */
    if (localData.questionCount !== remoteData.questionCount) {
      return (remote.updated || 0) > (local.updated || 0) ? remote : local;
    }

    const localNewer = (local.updated || 0) >= (remote.updated || 0);
    const localRounds = Array.isArray(localData.rounds) ? localData.rounds : [];
    const remoteRounds = Array.isArray(remoteData.rounds) ? remoteData.rounds : [];

    /* Wer mehr Runden hat, gibt das Gerüst vor. Wurden auf beiden Geräten
       unabhängig Wiederholungsrunden gestartet, lässt sich deren Abstammung
       nicht verschmelzen — dann gewinnt die längere Kette. */
    const baseIsLocal = localRounds.length > remoteRounds.length
      || (localRounds.length === remoteRounds.length && localNewer);
    const base = JSON.parse(JSON.stringify(baseIsLocal ? localData : remoteData));
    const baseStamps = (baseIsLocal ? local : remote).stamps || { rounds: {} };
    const otherData = baseIsLocal ? remoteData : localData;
    const otherStamps = (baseIsLocal ? remote : local).stamps || { rounds: {} };

    const stamps = { updated: Math.max(local.updated || 0, remote.updated || 0), rounds: {} };

    base.rounds.forEach((round, index) => {
      const other = (otherData.rounds || [])[index];
      const mine = (baseStamps.rounds || {})[index] || { answers: {}, flags: {} };
      const theirs = (otherStamps.rounds || {})[index] || { answers: {}, flags: {} };
      const slot = { answers: {}, flags: {} };

      round.answers = round.answers || {};
      round.flags = round.flags || {};

      if (other) {
        Object.keys(other.answers || {}).forEach((q) => {
          const mineAt = mine.answers[q] || 0;
          const theirsAt = theirs.answers[q] || 0;
          if (!(q in round.answers) || theirsAt > mineAt) round.answers[q] = other.answers[q];
        });
        Object.keys(other.flags || {}).forEach((q) => {
          const mineAt = mine.flags[q] || 0;
          const theirsAt = theirs.flags[q] || 0;
          if (!(q in round.flags) || theirsAt > mineAt) round.flags[q] = other.flags[q];
        });
      }

      Object.keys(round.answers).forEach((q) => {
        slot.answers[q] = Math.max(mine.answers[q] || 0, theirs.answers[q] || 0);
      });
      Object.keys(round.flags).forEach((q) => {
        slot.flags[q] = Math.max(mine.flags[q] || 0, theirs.flags[q] || 0);
      });
      stamps.rounds[index] = slot;
    });

    /* Wo man zuletzt stand, kommt vom zuletzt benutzten Gerät. */
    const recent = localNewer ? localData : remoteData;
    base.round = Math.min(recent.round || 0, base.rounds.length - 1);
    if (base.rounds[base.round] && recent.rounds && recent.rounds[base.round]) {
      base.rounds[base.round].lastQ = recent.rounds[base.round].lastQ;
    }

    return { data: base, stamps, updated: stamps.updated };
  }

  /* ====================== Dokument ====================== */

  function localDocument() {
    const state = meta();
    const list = readJSON(INDEX_KEY, []);
    const exams = {};
    list.forEach((entry) => {
      exams[entry.id] = {
        id: entry.id,
        title: entry.title,
        subtitle: entry.subtitle || "",
        count: entry.count || 0,
        blocks: entry.blocks || 0,
        folder: entry.folder || null,
        addedAt: entry.addedAt || 0,
        updated: entry.updated || entry.addedAt || 0,
        deleted: Boolean(entry.deleted)
      };
    });

    /* Alle Fortschrittsschlüssel einsammeln — auch die der öffentlichen
       Quizzes, die kein Verzeichniseintrag sind. */
    const progress = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PROGRESS_PREFIX)) continue;
      const id = key.slice(PROGRESS_PREFIX.length);
      const data = readJSON(key, null);
      if (!data) continue;
      const stamps = state.stamps[id] || { updated: 0, rounds: {} };
      progress[id] = { data, stamps, updated: stamps.updated || 0 };
    }

    return { v: 1, folders: folders(), exams, progress };
  }

  function applyDocument(doc) {
    if (!doc) return;
    saveFolders(doc.folders || {});

    const list = Object.values(doc.exams || {})
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    writeJSON(INDEX_KEY, list);

    const state = meta();
    Object.keys(doc.progress || {}).forEach((id) => {
      const entry = doc.progress[id];
      if (!entry || !entry.data) return;
      writeJSONRaw(PROGRESS_PREFIX + id, entry.data);
      state.stamps[id] = entry.stamps || { updated: entry.updated || 0, rounds: {} };
    });
    saveMeta(state);
  }

  /* Schreibt am abgefangenen setItem vorbei: beim Anwenden eines bereits
     zusammengeführten Standes darf nicht erneut gestempelt werden, sonst
     sähe fremder Fortschritt wie eigener, frischer aus. */
  function writeJSONRaw(key, value) {
    try { NATIVE_SET.call(localStorage, key, JSON.stringify(value)); } catch (_) {}
  }

  function mergeDocuments(local, remote) {
    if (!remote) return local;
    const exams = mergeRecords(local.exams, remote.exams);
    const foldersOut = mergeRecords(local.folders, remote.folders);
    const progress = {};
    const ids = new Set([...Object.keys(local.progress || {}), ...Object.keys(remote.progress || {})]);
    ids.forEach((id) => {
      const merged = mergeProgress((local.progress || {})[id], (remote.progress || {})[id]);
      if (merged) progress[id] = merged;
    });
    return { v: 1, folders: foldersOut, exams, progress };
  }

  /* ====================== Übertragung ====================== */

  function configured() {
    const state = meta();
    return Boolean(state.endpoint && state.key);
  }

  function base() {
    const state = meta();
    return state.endpoint.replace(/\/+$/, "") + "/v1/" + state.key;
  }

  async function request(path, options) {
    const response = await fetch(base() + path, options);
    return response;
  }

  async function sync(options) {
    options = options || {};
    if (!configured()) return { ok: false, reason: "not-configured" };
    if (running) return running;

    running = (async () => {
      const notes = { pulledExams: 0, pushedExams: 0, changed: false };
      try {
        let remoteRev = null;
        let remoteDoc = null;

        const head = await request("/index", { cache: "no-store" });
        if (!head.ok) throw new Error("Abgleich nicht erreichbar (HTTP " + head.status + ").");
        const payload = await head.json();
        remoteRev = payload.rev;
        remoteDoc = payload.doc;

        let merged = mergeDocuments(localDocument(), remoteDoc);

        /* Fehlende Fragen nachladen. */
        for (const id of Object.keys(merged.exams)) {
          if (merged.exams[id].deleted) continue;
          if (localStorage.getItem(DATA_PREFIX + id) !== null) continue;
          try {
            const response = await request("/exam/" + encodeURIComponent(id), { cache: "no-store" });
            if (response.ok) {
              localStorage.setItem(DATA_PREFIX + id, await response.text());
              notes.pulledExams += 1;
            }
          } catch (_) { /* beim nächsten Mal */ }
        }

        /* Eigene Fragen hochladen, die dort noch fehlen. */
        const state = meta();
        for (const id of Object.keys(merged.exams)) {
          if (merged.exams[id].deleted || state.uploaded[id]) continue;
          const raw = localStorage.getItem(DATA_PREFIX + id);
          if (raw === null) continue;
          try {
            const response = await request("/exam/" + encodeURIComponent(id), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: raw
            });
            if (response.ok) { state.uploaded[id] = true; notes.pushedExams += 1; }
          } catch (_) { /* beim nächsten Mal */ }
        }
        saveMeta(state);

        /* Index schreiben, bei Konflikt einmal neu zusammenführen. */
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await request("/index", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseRev: remoteRev, doc: merged })
          });
          if (response.ok) {
            const result = await response.json();
            const after = meta();
            after.rev = result.rev;
            after.lastSync = now();
            saveMeta(after);
            break;
          }
          if (response.status !== 409) throw new Error("Abgleich abgelehnt (HTTP " + response.status + ").");
          const conflict = await response.json();
          remoteRev = conflict.rev;
          merged = mergeDocuments(merged, conflict.doc);
        }

        const before = JSON.stringify(localDocument());
        applyDocument(merged);
        notes.changed = JSON.stringify(localDocument()) !== before;

        listeners.forEach((fn) => { try { fn(notes); } catch (_) {} });
        return { ok: true, ...notes };
      } catch (error) {
        return { ok: false, reason: error.message };
      } finally {
        running = null;
      }
    })();

    return running;
  }

  function schedulePush() {
    if (!configured()) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pendingPush = false; sync(); }, PUSH_DELAY);
  }

  /* Beim Verlassen der Seite sofort losschicken, sonst ginge die letzte
     halbe Minute Arbeit verloren. */
  function flush() {
    if (!pendingPush) return;
    clearTimeout(pushTimer);
    pendingPush = false;
    sync();
  }

  /* ====================== Nach aussen ====================== */

  const Sync = {
    meta,
    saveMeta,
    configured,
    flush,

    /* Die Worker-Adresse steht in content/index.json, damit Besucher nichts
       einrichten müssen. Der Schlüssel bleibt geräteeigen. */
    setEndpoint(endpoint) {
      const state = meta();
      if (state.endpoint === endpoint) return;
      state.endpoint = endpoint || "";
      state.rev = null;
      saveMeta(state);
    },

    /* Beim ersten gelösten Quiz bekommt jedes Gerät still einen Schlüssel.
       Er ist der Fortsetzungscode, den man auf dem zweiten Gerät eingibt. */
    ensureKey() {
      const state = meta();
      if (!state.key) { state.key = randomKey(24); saveMeta(state); }
      return state.key;
    },

    useKey(key) {
      const clean = String(key || "").trim().toLowerCase().replace(/\s+/g, "");
      if (!/^[a-z0-9]{16,64}$/.test(clean)) throw new Error("Ungültiger Code.");
      const state = meta();
      state.key = clean; state.rev = null; state.uploaded = {}; state.lastSync = 0;
      saveMeta(state);
      return sync();
    },
    randomKey,
    sync,
    schedulePush,
    onSync(fn) { listeners.push(fn); },
    folders, childFolders, folderTree, folderPath,
    createFolder, renameFolder, moveFolder, deleteFolder, setExamFolder,
    markExamChanged(examId) {
      const list = readJSON(INDEX_KEY, []);
      const entry = list.find((item) => item.id === examId);
      if (entry) { entry.updated = now(); writeJSON(INDEX_KEY, list); }
      schedulePush();
    },
    async test(endpoint) {
      const response = await fetch(endpoint.replace(/\/+$/, "") + "/v1", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      if (!body.ok) throw new Error("Unerwartete Antwort.");
      return true;
    }
  };

  interceptProgressWrites();

  /* Die Worker-Adresse kommt aus config.js und gilt für beide Seiten. */
  if (global.APP_CONFIG && global.APP_CONFIG.syncEndpoint) {
    const state = meta();
    if (state.endpoint !== global.APP_CONFIG.syncEndpoint) {
      state.endpoint = global.APP_CONFIG.syncEndpoint;
      state.rev = null;
      saveMeta(state);
    }
  }

  /* Beim Zurückkehren auf die Seite frisch abgleichen. */
  global.addEventListener("pageshow", () => sync());
  global.addEventListener("online", () => sync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
    else flush();
  });
  global.addEventListener("pagehide", flush);

  global.Sync = Sync;
})(window);
