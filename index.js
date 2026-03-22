// Render fallback entrypoint: load the real server module from the workspace.
(async () => {
  await import("./server/src/index.js");
})();
