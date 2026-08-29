/* ============================================================================
   config.js — die einzige Datei, die du nach dem Einrichten anfasst.

   syncEndpoint  Adresse deines Cloudflare Workers. Leer lassen heisst: kein
                 Abgleich, alles bleibt auf dem jeweiligen Gerät. Sobald hier
                 eine Adresse steht, bekommt jedes Gerät beim ersten gelösten
                 Quiz still einen eigenen Fortsetzungscode.
   ========================================================================== */
window.APP_CONFIG = {
  syncEndpoint: "https://pruefungen-sync.akshneer005.workers.dev",
  contentIndex: "content/index.json"
};

