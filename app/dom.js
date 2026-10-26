/** Small DOM toolkit: safe HTML injection, LaTeX typesetting, toasts, dialogs. */

const ALLOWED_TAGS = new Set([
  "a", "b", "i", "u", "em", "strong", "small", "sub", "sup", "span", "div", "p",
  "br", "hr", "img", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead",
  "tbody", "tfoot", "tr", "td", "th", "caption", "figure", "figcaption", "code",
  "pre", "blockquote", "mark", "del", "ins", "h1", "h2", "h3", "h4", "h5", "h6",
  "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "mspace",
  "ms", "mglyph", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mstyle",
  "merror", "mpadded", "mphantom", "menclose", "mfenced", "mover", "munder",
  "munderover", "mmultiscripts", "mprescripts", "none", "mtable", "mtr", "mtd",
  "mlabeledtr",
]);

const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "textarea", "select", "option", "button", "svg", "noscript",
  "template", "audio", "video", "source", "track", "canvas",
]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip anything executable from question HTML while keeping math and images. */
export function sanitizeHtml(html) {
  const input = String(html || "");
  if (!input) return "";
  if (!/[<&]/.test(input)) return escapeHtml(input).replace(/\n/g, "<br>");

  const template = document.createElement("template");
  template.innerHTML = input;

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();

      if (DROP_TAGS.has(tag)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }

      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value || "";
        if (
          name.startsWith("on") ||
          name === "style" ||
          name === "srcdoc" ||
          name === "formaction" ||
          /^\s*javascript:/i.test(value) ||
          /^\s*data:text\/html/i.test(value)
        ) {
          child.removeAttribute(attribute.name);
        }
      }
      if (tag === "a") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      walk(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

const MATH_PATTERN = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

function isMathHost(node, root) {
  let parent = node.parentElement;
  while (parent && parent !== root) {
    const tag = parent.tagName.toLowerCase();
    if (tag === "math" || tag === "annotation" || tag === "script" || tag === "style") return true;
    if (parent.classList?.contains("katex")) return true;
    parent = parent.parentElement;
  }
  return false;
}

/** Replace $…$, $$…$$, \(…\), \[…\] inside text nodes with KaTeX output. */
export function typesetMath(root) {
  if (!root || !window.katex) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.includes("$") && !node.nodeValue?.includes("\\")) {
        return NodeFilter.FILTER_REJECT;
      }
      return isMathHost(node, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const text = node.nodeValue;
    MATH_PATTERN.lastIndex = 0;
    if (!MATH_PATTERN.test(text)) continue;
    MATH_PATTERN.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let match;
    while ((match = MATH_PATTERN.exec(text))) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      const formula = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
      const display = Boolean(match[1] || match[3]);
      const span = document.createElement("span");
      span.className = display ? "math-display" : "math-inline";
      try {
        window.katex.render(formula.trim(), span, {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
          output: "html",
        });
      } catch {
        span.textContent = formula;
      }
      fragment.appendChild(span);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.replaceWith(fragment);
  }
}

/** Prepare images: lazy, async, and a readable fallback when offline. */
export function upgradeImages(root) {
  for (const image of root.querySelectorAll("img")) {
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener(
      "error",
      () => {
        const note = document.createElement("span");
        note.className = "chip offline";
        note.textContent = "diagram needs an internet connection";
        image.replaceWith(note);
      },
      { once: true },
    );
  }
}

/** Insert trusted-ish HTML (already escaped or from the question bank) into a node. */
export function setRichContent(node, html) {
  node.innerHTML = sanitizeHtml(html);
  typesetMath(node);
  upgradeImages(node);
  return node;
}

/**
 * Fill a question view: stem, every option body, and the worked solution.
 * Placeholders are rendered escaped, then hydrated here with KaTeX + sanitising.
 */
export function hydrateQuestion(container, question) {
  const stem = container.querySelector(".q-stem");
  if (stem) setRichContent(stem, question.text);
  for (const body of container.querySelectorAll(".option .body")) {
    const id = body.closest("[data-option]")?.dataset.option;
    const option = (question.options || []).find((entry) => entry.id === id);
    setRichContent(body, option?.text || "");
  }
  const solution = container.querySelector("[data-solution-text]");
  if (solution) setRichContent(solution, question.solution || "");
  typesetMath(container);
  upgradeImages(container);
}

/* ------------------------------------------------------------------ toasts */

let toastHost;

export function toast(message, kind = "") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const item = document.createElement("div");
  item.className = `toast ${kind}`.trim();
  item.textContent = message;
  toastHost.appendChild(item);
  setTimeout(() => {
    item.style.transition = "opacity 200ms ease";
    item.style.opacity = "0";
    setTimeout(() => item.remove(), 220);
  }, kind === "bad" ? 5200 : 3200);
}

export function confirmDialog({ title, body, confirm = "Continue", cancel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.innerHTML = `
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <div class="actions">
        <button class="btn ghost" data-choice="cancel">${escapeHtml(cancel)}</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-choice="confirm">${escapeHtml(confirm)}</button>
      </div>`;
    document.body.appendChild(dialog);
    const close = (value) => {
      resolve(value);
      dialog.close();
      dialog.remove();
    };
    dialog.addEventListener("click", (event) => {
      const choice = event.target.closest("[data-choice]")?.dataset.choice;
      if (choice) close(choice === "confirm");
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });
    dialog.showModal();
  });
}

/* ----------------------------------------------------------------- helpers */

export function percent(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function scoreLabel(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
