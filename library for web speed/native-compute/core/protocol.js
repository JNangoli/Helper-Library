// Wire protocol shared by the main thread and workers.

/** postMessage throws if the same object appears twice in a transfer list. */
export const unique = (items) => [...new Set(items)];
