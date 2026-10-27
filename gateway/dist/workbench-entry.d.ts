/**
 * Composition root for the stage-1 read-only workbench HTTP server.
 *
 * Run with the built dist: `node dist/workbench-entry.js`.
 *
 * It constructs the same shared service the MCP server builds (config, store,
 * coordinator) and binds the read-only adapter on the loopback port. It
 * starts no native work, no dispatch and no model request; nothing else in
 * this process writes to the task store.
 */
export {};
