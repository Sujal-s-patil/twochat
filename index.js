// Render fallback entrypoint: load the real server module from the workspace.
(async () => {
  try {
    await import("./server/src/index.js");
  } catch (error) {
    console.error("Fatal startup error:", error);
    process.exit(1);
  }
})();
