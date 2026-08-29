/* ============================================================================
   config.js — die einzige Datei, die du nach dem Einrichten anfasst.

   syncEndpoint  Adresse deines Cloudflare Workers. Leer lassen heisst: kein
                 Geräteabgleich, der Fortschritt bleibt auf dem jeweiligen
                 Gerät.

   repo          Für den Verwaltungsbereich: "benutzername/repository", also
                 genau so, wie es in der GitHub-Adresse steht. Ohne diesen
                 Eintrag lässt sich nichts über die Seite hochladen.

   branch        Fast immer "main". Nur ändern, wenn dein Repository einen
                 anderen Hauptzweig benutzt.
   ========================================================================== */
window.APP_CONFIG = {
  syncEndpoint: "https://pruefungen-sync.akshneer005.workers.dev",
  repo: "akshneerSingh/Exams",
  branch: "main",
  contentIndex: "content/index.json"
};
