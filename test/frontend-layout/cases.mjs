// One row per harness. Adding a harness is one row plus one entry .tsx: the HTML, the bundle and
// the npm script all follow from here. The HTML used to be 19 committed files that differed only
// in <title> and the bundle src.
export const CASES = [
  {
    name: "approval",
    title: "Mirall approval in-flight harness",
    // One pending request + a delayed approve reply so the in-flight disable is observable.
    cfg: `      pendingRequests: [{ publicKey: 'joiner00000000000000000000000000000000000000000000000000000000ab', displayName: 'Bob', avatar: null }],
      rpcDelayMs: 400,
      delayTypes: ['space:approve-member'],`,
  },
  // Mounts every avatar the app draws and sweeps for one that is not recessed.
  { name: "avatars", title: "Mirall avatar recess harness" },
  { name: "dropoverlay", title: "Mirall drop-overlay layout harness" },
  { name: "errorassoc", title: "Mirall dialog error-association harness" },
  { name: "failpaths", title: "Mirall action failure-path harness" },
  { name: "filecard", title: "Mirall FileCard error-state / toast-width layout harness" },
  // This one measures painted colour in both themes, and scans the stylesheet for the hover fill.
  { name: "facepile", title: "Mirall facepile ring harness" },
  { name: "focusring", title: "Mirall focus-ring clearance harness" },
  { name: "indexing", title: "Mirall indexing-labels harness" },
  // This one scans the stylesheet rather than rendering against it.
  { name: "logohover", title: "Mirall top bar logo hover harness", note: "The REAL built stylesheet, so the harness scans the app's actual CSS." },
  { name: "members", title: "Mirall members layout harness" },
  { name: "memo", title: "Mirall row memo / render-count harness" },
  { name: "mirrorers", title: "Mirall mirrored-by facepile layout harness" },
  { name: "modaltitle", title: "Mirall confirm-modal title overflow layout harness" },
  { name: "peerdownload", title: "Mirall peer-download serve UI harness" },
  { name: "progress", title: "Mirall progress-lane ARIA harness" },
  { name: "segments", title: "Mirall segmented-control harness" },
  { name: "sharecard", title: "Mirall ShareCard hit-area layout harness" },
  { name: "spaceoverflow", title: "Mirall space document-overflow harness" },
  { name: "toastdedupe", title: "Mirall retry-toast dedupe harness" },
  { name: "toaststack", title: "Mirall sticky-toast eviction harness" },
  { name: "transferfaults", title: "Mirall transfer-fault burst harness" },
  { name: "stickyheader", title: "Mirall space sticky-header harness" },
  { name: "truncation", title: "Mirall text-truncation harness" },
  { name: "waiting", title: "Mirall owner-row waiting-cluster harness" },
  { name: "harness", title: "Mirall layout harness" },
]
