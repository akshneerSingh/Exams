/* ============================================================================
   admin.js — Schreibzugriff auf das Repository

   GitHub Pages liefert nur aus, es nimmt nichts entgegen. Damit die Seite
   selbst Dateien ablegen kann, spricht sie direkt mit der GitHub-API. Dafür
   braucht sie einen Token; der bleibt in diesem Browser und geht nirgends
   sonst hin.

   Geschrieben wird über die Git-Data-API statt über die bequemere
   Contents-API: die legt pro Datei einen eigenen Commit an, und beim Hochladen
   von zwanzig Altprüfungen wären das zwanzig Commits und zwanzig Neubauten der
   Seite. Hier wird ein Baum gebaut und einmal committet — egal wie viele
   Dateien.

   Ablauf eines Commits:
     1  ref lesen        → letzter Commit
     2  commit lesen     → dessen Baum
     3  blobs anlegen    → je Datei einmal
     4  Baum anlegen     → auf dem alten aufbauend
     5  commit anlegen   → mit dem alten als Elternteil
     6  ref umbiegen     → fertig
   ========================================================================== */

(function (global) {
  "use strict";

  const TOKEN_KEY = "pruefung:gh";
  /* Nur für Tests überschreibbar; im Betrieb immer die echte API. */
  const apiBase = () => (global.APP_CONFIG && global.APP_CONFIG.githubApi) || "https://api.github.com";

  function config() {
    const cfg = global.APP_CONFIG || {};
    return {
      repo: cfg.repo || "",
      branch: cfg.branch || "main"
    };
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; }
  }

  function enabled() { return Boolean(token() && config().repo); }

  async function api(path, options) {
    options = options || {};
    const response = await fetch(apiBase() + path, {
      method: options.method || "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token(),
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
    if (!response.ok) {
      let detail = "HTTP " + response.status;
      try {
        const body = await response.json();
        if (body && body.message) detail = body.message;
      } catch (_) { /* Text war kein JSON */ }
      if (response.status === 401) detail = "Token ungültig oder abgelaufen.";
      if (response.status === 403) detail = "Token hat keine Schreibrechte auf dieses Repository.";
      if (response.status === 404) detail = "Repository nicht gefunden — stimmt repo in config.js?";
      throw new Error(detail);
    }
    return response.status === 204 ? null : response.json();
  }

  /* ==================== Anmeldung ==================== */

  async function login(value) {
    const clean = String(value || "").trim();
    if (!clean) throw new Error("Kein Token eingegeben.");
    const { repo, branch } = config();
    if (!repo) throw new Error("In config.js fehlt der Eintrag repo.");
    try { localStorage.setItem(TOKEN_KEY, clean); } catch (_) {}
    try {
      /* Ein Lesezugriff prüft Token und Repository in einem Schritt. */
      await api("/repos/" + repo + "/git/ref/heads/" + encodeURIComponent(branch));
    } catch (error) {
      logout();
      throw error;
    }
    return true;
  }

  function logout() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }

  /* ==================== Kodierung ==================== */

  /* GitHub will Base64. btoa kann kein UTF-8, deshalb der Umweg über Bytes —
     sonst zerfallen Umlaute in Titeln und Fragen. */
  function toBase64(input) {
    const bytes = typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Datei nicht lesbar."));
      reader.readAsArrayBuffer(file);
    });
  }

  /* ==================== Commit ==================== */

  /* changes: [{ path, content }]  zum Anlegen oder Ersetzen
              [{ path, remove: true }]  zum Löschen                        */
  async function commit(changes, message) {
    if (!enabled()) throw new Error("Nicht angemeldet.");
    if (!changes.length) return null;
    const { repo, branch } = config();
    const base = "/repos/" + repo;

    const ref = await api(base + "/git/ref/heads/" + encodeURIComponent(branch));
    const parent = ref.object.sha;
    const head = await api(base + "/git/commits/" + parent);

    const entries = [];
    for (const change of changes) {
      if (change.remove) {
        entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await api(base + "/git/blobs", {
        method: "POST",
        body: { content: toBase64(change.content), encoding: "base64" }
      });
      entries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const tree = await api(base + "/git/trees", {
      method: "POST",
      body: { base_tree: head.tree.sha, tree: entries }
    });

    const made = await api(base + "/git/commits", {
      method: "POST",
      body: { message: message || "Inhalt aktualisiert", tree: tree.sha, parents: [parent] }
    });

    await api(base + "/git/refs/heads/" + encodeURIComponent(branch), {
      method: "PATCH",
      body: { sha: made.sha }
    });

    return made.sha;
  }

  /* ==================== Alte HTML-Prüfungen ==================== */

  /* Die früher erzeugten Dateien tragen ihre Fragen als JavaScript-Objekt in
     sich. Hier wird genau dieser Block herausgelöst und zu JSON gemacht. */
  function quizFromHtml(text) {
    const marked = text.match(
      /KPRIM-DATEN:\s*START[^\n]*\n([\s\S]*?)\/\/\s*=*\s*KPRIM-DATEN:\s*ENDE/);
    let source = null;
    if (marked) {
      const inner = marked[1].match(/=\s*([\s\S]*?);\s*$/);
      if (inner) source = inner[1].trim();
    }
    if (!source) {
      const assigned = text.match(
        /(?:const|let|var)\s+QUIZ_DATA\s*=\s*([\s\S]*?);\s*(?:\n\s*(?:\/\/|\(\(|<\/script>))/);
      if (assigned) source = assigned[1].trim();
    }
    if (!source && text.trim().startsWith("{")) source = text.trim();
    if (!source) throw new Error("Kein QUIZ_DATA-Block gefunden.");

    let payload;
    try { payload = new Function('"use strict"; return (' + source + ");")(); }
    catch (error) { throw new Error("QUIZ_DATA liess sich nicht lesen (" + error.message + ")."); }

    if (!payload || !Array.isArray(payload.questions) || !payload.questions.length) {
      throw new Error("Keine Fragen enthalten.");
    }
    const bad = payload.questions.findIndex((q) =>
      !q || typeof q.stem !== "string" || !Array.isArray(q.statements) || !q.statements.length);
    if (bad !== -1) throw new Error("Frage " + (bad + 1) + " ist unvollständig.");
    if (String((payload.exam && payload.exam.title) || "").includes("<Fach>")) {
      throw new Error("Das ist die unausgefüllte Vorlage.");
    }
    return payload;
  }

  /* Der Dateiname bleibt der, unter dem du die Datei ablegst — nur was in
     einem Pfad oder einer Adresse Ärger macht, wird ersetzt. Umlaute,
     Grossschreibung und Leerzeichen bleiben erhalten. */
  function safeName(text) {
    return String(text || "datei")
      .replace(/[\\/:*?"<>|#%]+/g, "-")   /* in Pfaden und URLs heikel */
      .replace(/\s+/g, " ")
      .replace(/^[.\s-]+|[.\s-]+$/g, "")
      .slice(0, 90) || "datei";
  }

  function slug(text) {
    return String(text || "datei").toLowerCase()
      .replace(/[äàáâ]/g, "a").replace(/[öòóô]/g, "o").replace(/[üùúû]/g, "u")
      .replace(/ß/g, "ss").replace(/[éèêë]/g, "e")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "datei";
  }

  /* Eine ausgewählte Datei in etwas verwandeln, das committet werden kann. */
  async function prepare(file) {
    const name = file.name;
    const lower = name.toLowerCase();

    if (lower.endsWith(".pdf")) {
      const base = name.replace(/\.pdf$/i, "");
      return {
        kind: "pdf",
        title: base.replace(/[_-]+/g, " ").trim(),
        basename: safeName(base),
        ext: ".pdf",
        content: new Uint8Array(await readFile(file)),
        meta: "PDF"
      };
    }

    if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".json")) {
      const text = new TextDecoder().decode(await readFile(file));
      const payload = quizFromHtml(text);
      const title = (payload.exam && payload.exam.title) || name.replace(/\.[^.]+$/, "");
      const blocks = [...new Set(payload.questions.map((q) => q.block).filter(Boolean))].length;
      return {
        kind: "quiz",
        title,
        /* Auch eine umgewandelte HTML-Prüfung behält ihren Namen, nur mit
           anderer Endung. */
        basename: safeName(name.replace(/\.[^.]+$/, "")),
        ext: ".json",
        content: JSON.stringify(payload),
        meta: payload.questions.length + " Fragen"
          + (blocks > 1 ? " · " + blocks + " Blöcke" : ""),
        converted: !lower.endsWith(".json")
      };
    }

    throw new Error("Nur PDF, HTML und JSON.");
  }

  global.Admin = {
    enabled, login, logout, commit, prepare, quizFromHtml, slug, safeName,
    hasToken: () => Boolean(token()),
    repo: () => config().repo
  };
})(window);
