import {
  blobToDataUrl,
  buildPaperJsonBundle,
  buildStandalonePaperHtml,
  cacheStats,
  clearOfflineCache,
  downloadBlob,
  downloadExactPaperOffline,
  downloadTextFile,
  estimateStorage,
  extractPaperImageUrls,
  formatBytes,
  getCachedImageBlob,
  getCachedPaper,
  isOfflineCacheAvailable,
  listCachedPapers,
  paperFileSlug,
  removeCachedPaper,
  requestPersistentStorage,
} from "./offline-storage.mjs";

/** Tracks connectivity so offline mode is explained instead of failing silently. */
function useOnlineStatus(React) {
  const [online, setOnline] = React.useState(
    () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  );
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () =>
      setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [React]);
  return online;
}

/**
 * Download / offline controls for the exact-paper picker.
 *
 * Props: { React, exam, paper, loadQuestions, loadYearData, onStatusChange }
 * - loadQuestions(exam, paper) -> normalized questions (fresh, no cache)
 * - loadYearData(archiveFile) -> year data (for MathJax defs), optional
 *
 * "Download & save offline" caches the paper + every embedded image in
 * IndexedDB and downloads a self-contained HTML paper file, so the same
 * paper can be sat offline (with scoring/results) and read/printed later.
 */
export function OfflinePaperControls({
  React,
  exam,
  paper,
  loadQuestions,
  loadYearData,
  onStatusChange,
}) {
  const h = React.createElement;
  const [summary, setSummary] = React.useState(null);
  const [checking, setChecking] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState("");
  const [fileBusy, setFileBusy] = React.useState("");
  const abortRef = React.useRef(null);
  const online = useOnlineStatus(React);

  const refresh = React.useCallback(async () => {
    if (!paper) {
      setSummary(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const cached = await getCachedPaper(paper);
      setSummary(
        cached
          ? {
              key: cached.key,
              title: cached.title,
              questionCount: cached.questionCount,
              imageCount: cached.imageCount,
              imageBytes: cached.imageBytes,
              failedImages: cached.failedImages || [],
              downloadedAt: cached.downloadedAt,
              complete: (cached.failedImages || []).length === 0,
            }
          : null,
      );
    } catch {
      setSummary(null);
    } finally {
      setChecking(false);
    }
  }, [paper]);

  React.useEffect(() => {
    let current = true;
    refresh().then(() => {
      if (!current) return;
    });
    return () => {
      current = false;
    };
  }, [refresh]);

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (!paper) return null;
  if (!isOfflineCacheAvailable()) {
    return h(
      "p",
      { className: "offline-note", key: "unavailable" },
      "Offline saving is not available in this browser. You can still sit the paper online.",
    );
  }

  const notifyChange = () => {
    onStatusChange?.();
  };

  const handleDownload = async () => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setProgress({ phase: "questions", loaded: 0, total: 1 });
    try {
      const result = await downloadExactPaperOffline({
        paperSource: paper,
        exam,
        paper,
        loadQuestions,
        loadYearData,
        signal: controller.signal,
        onProgress: (next) => setProgress(next),
      });
      setSummary(result.summary);
      notifyChange();
      // The request asks for the paper file *and* the offline cache:
      // cache first (above), then hand the user a self-contained file.
      await downloadFile("html");
      if (result.failed.length) {
        setError(
          `Saved offline with ${result.failed.length} image${result.failed.length === 1 ? "" : "s"} unavailable (check your connection and retry). The paper text, keys and solutions are complete.`,
        );
      }
    } catch (downloadError) {
      if (downloadError?.name === "AbortError") {
        setError("Download cancelled. Nothing was saved.");
      } else {
        setError(
          downloadError?.message ||
            "The paper could not be saved for offline use.",
        );
      }
    } finally {
      setBusy(false);
      setProgress(null);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleRemove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await removeCachedPaper(paper);
      setSummary(null);
      notifyChange();
    } catch (removeError) {
      setError(removeError?.message || "The offline copy could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const downloadFile = async (format) => {
    if (fileBusy) return;
    setFileBusy(format);
    setError("");
    try {
      let cached = await getCachedPaper(paper);
      if (!cached) {
        // File download without a prior cache: save first so the file and
        // the offline copy stay identical.
        const result = await downloadExactPaperOffline({
          paperSource: paper,
          exam,
          paper,
          loadQuestions,
          loadYearData,
          onProgress: (next) => setProgress(next),
        });
        setSummary(result.summary);
        notifyChange();
        cached = await getCachedPaper(paper);
      }
      if (!cached) throw new Error("The paper could not be prepared.");
      const urls = extractPaperImageUrls(cached.questions || []);
      const imageDataUrls = new Map();
      for (const url of urls) {
        const blob = await getCachedImageBlob(url);
        if (blob) imageDataUrls.set(url, await blobToDataUrl(blob));
      }
      const slug = paperFileSlug(cached.title || paper.title);
      if (format === "json") {
        const bundle = buildPaperJsonBundle({
          paper: cached.paperSource || paper,
          questions: cached.questions,
          mathjaxDefs: cached.mathjaxDefs,
          imageDataUrls,
        });
        downloadTextFile(
          `${slug}.json`,
          JSON.stringify(bundle, null, 2),
          "application/json",
        );
      } else {
        const html = buildStandalonePaperHtml({
          paper: cached.paperSource || paper,
          questions: cached.questions,
          mathjaxDefs: cached.mathjaxDefs,
          imageDataUrls,
        });
        downloadTextFile(`${slug}.html`, html, "text/html");
      }
      if (imageDataUrls.size < urls.length) {
        setError("Some diagrams could not be embedded in the exported file. It will use their original online URLs.");
      }
    } catch (fileError) {
      setError(fileError?.message || "The paper file could not be prepared.");
    } finally {
      setFileBusy("");
      setProgress(null);
    }
  };

  const progressLabel = progress
    ? progress.phase === "questions"
      ? "Loading the paper…"
      : progress.phase === "images"
        ? `Downloading images ${progress.loaded}/${progress.total}…`
        : progress.phase === "saving"
          ? "Saving for offline use…"
          : "Done"
    : "";
  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : 0;

  const statusText = checking
    ? "Checking offline copy…"
    : !online && !summary
      ? "You are offline and this paper is not saved yet. Reconnect to download it — everything else keeps working."
      : summary
      ? `Saved offline · ${summary.questionCount} questions · ${summary.imageCount} images (${formatBytes(summary.imageBytes)})${summary.downloadedAt ? ` · ${new Date(summary.downloadedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}${summary.complete ? "" : ` · ${summary.failedImages.length} image(s) missing`}`
      : "Not saved offline yet. Download to sit this paper without internet — with diagrams, keys and solutions.";

  return h("div", { className: "exact-paper-offline", key: "offline" }, [
    h("p", { className: "offline-status", key: "status" }, statusText),
    busy && progress
      ? h("div", { className: "offline-progress", key: "progress" }, [
          h("div", { className: "offline-progress-track", key: "track" }, [
            h("i", { key: "fill", style: { width: `${progressPct}%` } }),
          ]),
          h("span", { key: "label" }, progressLabel),
          h(
            "button",
            {
              type: "button",
              className: "text-button",
              onClick: handleCancel,
              key: "cancel",
            },
            "Cancel",
          ),
        ])
      : h("div", { className: "offline-actions", key: "actions" }, [
          !summary
            ? h(
                "button",
                {
                  type: "button",
                  className: "btn outline exact-paper-download",
                  disabled: busy || checking || !online,
                  onClick: handleDownload,
                  key: "download",
                },
                online
                  ? "⬇ Download & save offline"
                  : "Offline — reconnect to download",
              )
            : [
                h(
                  "button",
                  {
                    type: "button",
                    className: "btn outline exact-paper-download",
                    disabled: busy || Boolean(fileBusy),
                    onClick: () => downloadFile("html"),
                    key: "html",
                  },
                  fileBusy === "html" ? "Preparing file…" : "⬇ Paper file (.html)",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "btn outline exact-paper-download",
                    disabled: busy || Boolean(fileBusy),
                    onClick: () => downloadFile("json"),
                    key: "json",
                  },
                  fileBusy === "json" ? "Preparing file…" : "⬇ Data (.json)",
                ),
                !summary.complete &&
                  h(
                    "button",
                    {
                      type: "button",
                      className: "btn outline exact-paper-download",
                      disabled: busy,
                      onClick: handleDownload,
                      key: "retry",
                    },
                    "Retry images",
                  ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "text-button exact-paper-remove",
                    disabled: busy,
                    onClick: handleRemove,
                    key: "remove",
                  },
                  "Remove offline copy",
                ),
              ],
        ]),
    error && h("p", { className: "offline-error", role: "alert", key: "error" }, error),
    summary &&
      h(
        "p",
        { className: "offline-note", key: "note" },
        "Offline mocks use the saved copy and score exactly like the online paper. The .html file is self-contained for reading/printing.",
      ),
  ]);
}

/**
 * Settings → offline cache manager: storage usage, saved papers, and
 * controls to keep data persistent / clear the cache.
 */
export function OfflineCacheManager({ React, notify }) {
  const h = React.createElement;
  const [stats, setStats] = React.useState(null);
  const [papers, setPapers] = React.useState([]);
  const [estimate, setEstimate] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [persistent, setPersistent] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextStats, nextPapers, nextEstimate] = await Promise.all([
        cacheStats(),
        listCachedPapers(),
        estimateStorage(),
      ]);
      setStats(nextStats);
      setPapers(nextPapers);
      setEstimate(nextEstimate);
    } catch (loadError) {
      setError(loadError?.message || "Offline storage could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isOfflineCacheAvailable()) {
    return h("div", { className: "offline-cache-manager", key: "manager" }, [
      h("div", { className: "settings-divider", key: "divider" }),
      h("h3", { key: "heading" }, "Offline papers"),
      h(
        "p",
        { className: "muted small", key: "note" },
        "Offline saving is not available in this browser (IndexedDB is missing). Progress still saves to local storage.",
      ),
    ]);
  }

  const handleRemove = async (key) => {
    try {
      await removeCachedPaper(key);
      notify?.("Offline copy removed.");
      await refresh();
    } catch (removeError) {
      setError(removeError?.message || "The offline copy could not be removed.");
    }
  };

  const handleClear = async () => {
    try {
      await clearOfflineCache();
      notify?.("Offline cache cleared.");
      await refresh();
    } catch (clearError) {
      setError(clearError?.message || "The offline cache could not be cleared.");
    }
  };

  const handlePersist = async () => {
    const granted = await requestPersistentStorage();
    setPersistent(granted);
    notify?.(
      granted
        ? "This browser will keep your offline papers."
        : "The browser did not grant persistent storage. Offline papers may be evicted under storage pressure.",
    );
  };

  const usageText = estimate
    ? estimate.quota > 0
      ? `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} used`
      : `${formatBytes(estimate.usage)} used`
    : "";

  return h("div", { className: "offline-cache-manager", key: "manager" }, [
    h("div", { className: "settings-divider", key: "divider" }),
    h("h3", { key: "heading" }, "Offline papers"),
    h(
      "p",
      { className: "muted small", key: "desc" },
      "Downloaded exact papers (with every diagram) live in this browser's offline cache. They open and score without internet. Progress backup above does not include them — re-download on a new device.",
    ),
    loading
      ? h("p", { className: "muted small", key: "loading" }, "Checking offline cache…")
      : h("div", { className: "offline-cache-body", key: "body" }, [
          h("p", { className: "offline-cache-usage", key: "usage" }, [
            stats && stats.papers
              ? `${stats.papers} paper${stats.papers === 1 ? "" : "s"} · ${stats.images} images · ${formatBytes(stats.totalBytes)}${usageText ? ` · ${usageText}` : ""}`
              : `No papers saved offline yet.${usageText ? ` ${usageText}.` : ""}`,
          ]),
          papers.length > 0 &&
            h("div", { className: "offline-cache-list", key: "list" }, papers.map((entry) =>
              h("div", { className: "offline-cache-row", key: entry.key }, [
                h("div", { className: "offline-cache-info", key: "info" }, [
                  h("strong", { key: "title" }, entry.title || entry.key),
                  h(
                    "span",
                    { key: "meta" },
                    `${entry.questionCount} questions · ${entry.imageCount} images · ${formatBytes(entry.imageBytes)}${entry.downloadedAt ? ` · ${new Date(entry.downloadedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}${entry.complete ? "" : ` · ${entry.failedImages.length} missing`}`,
                  ),
                ]),
                h(
                  "button",
                  {
                    type: "button",
                    className: "text-button",
                    onClick: () => handleRemove(entry.key),
                    key: "remove",
                  },
                  "Remove",
                ),
              ]),
            )),
          h("div", { className: "offline-cache-actions", key: "actions" }, [
            h(
              "button",
              {
                type: "button",
                className: "btn outline",
                onClick: handlePersist,
                key: "persist",
              },
              persistent ? "Keeping offline data ✓" : "Keep offline data",
            ),
            papers.length > 0 &&
              h(
                "button",
                {
                  type: "button",
                  className: "text-button",
                  onClick: handleClear,
                  key: "clear",
                },
                "Clear all offline papers",
              ),
          ]),
        ]),
    error && h("p", { className: "error-message", role: "alert", key: "error" }, error),
  ]);
}
