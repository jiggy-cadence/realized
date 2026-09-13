// Moved to packages/core/src/realized.js when the math was extracted into the
// publishable @realized-lp/core package. This shim keeps the in-repo scripts
// (build-corpus, spike-hunt*, walk-forward, ...) importing one canonical copy
// instead of a fork that can drift out of sync with packages/core (not published to npm).
export * from '../packages/core/src/realized.js';
