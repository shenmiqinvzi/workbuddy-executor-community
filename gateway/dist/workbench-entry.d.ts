/**
 * Composition root for stage-2 task reads and optional quota observations.
 *
 * Run with the built dist: `node dist/workbench-entry.js`.
 *
 * It constructs the same shared service the MCP server builds (config, store,
 * coordinator) and binds the read-only adapter on the loopback port. It
 * starts no native work, dispatch or model request. The optional background
 * quota collector writes only independent resource observations. HTTP GETs
 * read saved task/resource facts and never start collection.
 */
export {};
