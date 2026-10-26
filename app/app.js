import { EXAM_LABEL } from "./core.js";
import { escapeHtml, typesetMath, upgradeImages } from "./dom.js";
import { getPrefs, setPrefs } from "./store.js";
import * as home from "./views/home.js";
import * as papers from "./views/papers.js";
import * as bank from "./views/bank.js";
import * as practice from "./views/practice.js";
import * as library from "./views/library.js";
import * as sessionView from "./views/session.js";
import * as analysis from "./views/analysis.js";

const VIEWS = {
  home,
  papers,
  bank,
  practice,
  library,
  session: sessionView,
  analysis,
};

const NAV = [
  { route: "home", hash: "#/", label: "Overview" },
  { route: "papers", hash: "#/papers", label: "Exact papers" },
  { route: "bank", hash: "#/bank", label: "Question bank" },
  { route: "practice", hash: "#/practice", label: "Custom set" },
  { route: "library", hash: "#/library", label: "Library" },
];

const state = {
  route: { name: "home", params: {} },
  exam: getPrefs().exam || "JEE_Main",
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  cleanup: null,
  renderToken: 0,
  renderedHash: "",
};

const root = document.getElementById("app");

/* ------------------------------------------------------------------ router */

export function parseHash(hash = window.location.hash || "#/") {
  const clean = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = clean.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(queryPart));

  if (!segments.length) return { name: "home", params };
  if (segments[0] === "attempt" && segments[1]) {
    return { name: "analysis", params: { ...params, id: decodeURIComponent(segments[1]) } };
  }
  if (segments[0] === "session") return { name: "session", params };
  const known = ["papers", "practice", "library", "bank"];
  if (known.includes(segments[0])) return { name: segments[0], params };
  return { name: "home", params: {} };
}

export function navigate(hash, { replace = false } = {}) {
  if (!hash.startsWith("#")) hash = `#${hash}`;
  if (window.location.hash === hash) {
    render();
    return;
  }
  if (replace) {
    window.history.replaceState(null, "", hash);
    render();
  } else {
    window.location.hash = hash;
  }
}

/* ------------------------------------------------------------------- shell */

function shellBody(route) {
  const isSession = route.name === "session";
  const nav = NAV.map(
    (item) =>
      `<a href="${item.hash}" class="${route.name === item.route ? "is-active" : ""}">${item.label}</a>`,
  ).join("");

  return `
    <header class="topbar">
      <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>PYQ Studio<span class="brand-sub">JEE</span></a>
      ${isSession ? "" : `<nav class="nav" aria-label="Primary">${nav}</nav>`}
      <div class="topbar-right">
        <span class="net-pill ${state.online ? "" : "is-offline"}" data-net-pill>
          <span class="dot" aria-hidden="true"></span><span class="net-text">${state.online ? "Online" : "Offline"}</span>
        </span>
      </div>
    </header>
    <main id="view"></main>
    <footer class="footer">
      <span>Practice with real JEE questions · ${EXAM_LABEL[state.exam]} selected</span>
      <span>Progress and downloads stay in this browser</span>
    </footer>`;
}

function updateNetPill() {
  const pill = document.querySelector("[data-net-pill]");
  if (!pill) return;
  pill.classList.toggle("is-offline", !state.online);
  pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="net-text">${state.online ? "Online" : "Offline"}</span>`;
}

/* ------------------------------------------------------------------ render */

export async function render() {
  const token = ++state.renderToken;
  const route = parseHash();
  // A re-render of the same route (expanding a chapter, filtering a list) must
  // not throw the reader back to the top of the page.
  const sameRoute = state.renderedHash === window.location.hash;
  const scrollY = sameRoute ? window.scrollY : 0;
  state.route = route;

  // Deep links (home cards, analysis "practise" links) carry the exam with them.
  const routeExam = route.params?.exam;
  if (
    routeExam &&
    (route.name === "papers" || route.name === "practice" || route.name === "bank") &&
    routeExam !== state.exam
  ) {
    state.exam = routeExam;
    setPrefs({ exam: routeExam });
  }

  const view = VIEWS[route.name] || VIEWS.home;
  const isSession = route.name === "session";

  if (typeof state.cleanup === "function") {
    try {
      state.cleanup();
    } catch {
      /* ignore */
    }
    state.cleanup = null;
  }

  // Each render gets a fresh subtree: views attach listeners to their mount
  // node, so replacing it is what tears the previous view's listeners down.
  root.innerHTML = isSession
    ? `<div id="session-root"></div>`
    : `<div class="shell">${shellBody(route)}</div>`;
  const mount = isSession ? document.getElementById("session-root") : document.getElementById("view");

  const ctx = {
    exam: state.exam,
    setExam(exam) {
      if (!exam || exam === state.exam) return;
      state.exam = exam;
      setPrefs({ exam });
      render();
    },
    online: state.online,
    params: route.params,
    navigate,
    rerender: () => render(),
    isCurrent: () => token === state.renderToken,
  };

  try {
    const result = await view.render(ctx, mount);
    if (token !== state.renderToken) return;
    if (typeof result === "string") mount.innerHTML = result;
    typesetMath(mount);
    upgradeImages(mount);
    const viewCleanup = view.mount?.(mount, ctx);
    // A view may hand back its own teardown (the session stops a timer and a
    // document-level key handler); mount() may return one too.
    const teardowns = [typeof result === "function" ? result : null, viewCleanup].filter(
      (entry) => typeof entry === "function",
    );
    if (teardowns.length) {
      state.cleanup = () => {
        for (const teardown of teardowns) {
          try {
            teardown();
          } catch {
            /* a failed teardown must not block navigation */
          }
        }
      };
    }
    if (!isSession) setPrefs({ lastRoute: window.location.hash || "#/" });
    if (!isSession) {
      window.scrollTo(0, scrollY);
      state.renderedHash = window.location.hash;
    }
  } catch (error) {
    console.error(error);
    if (token !== state.renderToken) return;
    mount.innerHTML = `<div class="page narrow"><div class="notice bad">${escapeHtml(
      error?.message || "Something went wrong while loading this view.",
    )}</div><p class="actions" style="margin-top:16px"><a class="btn" href="#/">Back to overview</a></p></div>`;
  }
}

export function setOnline(value) {
  state.online = value;
  updateNetPill();
  const view = VIEWS[state.route.name];
  if (view?.onNetworkChange) view.onNetworkChange(value, state.route.params);
  else render();
}

if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is optional */
    });
  });
}

if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

window.addEventListener("hashchange", render);
window.addEventListener("online", () => setOnline(true));
window.addEventListener("offline", () => setOnline(false));

document.addEventListener("click", (event) => {
  const link = event.target.closest?.('a[href^="#"]');
  if (!link) return;
  const hash = link.getAttribute("href");
  if (hash === window.location.hash) {
    event.preventDefault();
    render();
  }
});

render();
