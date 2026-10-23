// Route data with stale-while-revalidate: a screen you've seen shows its saved data instantly,
// then refreshes in the background. Requests for the same URL are shared (a hover prefetch and
// the click that follows use one request).

const LIMIT = 50;

export class RouteDataCache {
  entries = new Map(); // url id -> { promise, value, hasValue, settled, time }

  /** Data for a match, or a promise of it. onFresh(value) is called if a background refresh finishes. */
  load(matched, location, onFresh) {
    const { route } = matched;
    if (!route.loader) return undefined;
    const entry = this.entries.get(location.id);
    if (entry?.hasValue) {
      const age = Date.now() - entry.time;
      if (entry.settled && age > (route.staleTime ?? 10_000)) {
        this.fetch(matched, location, entry)
          .then(onFresh)
          .catch(() => {});
      }
      return entry.value; // show what we have now
    }
    if (entry && !entry.settled) return entry.promise;
    return this.fetch(matched, location);
  }

  fetch(matched, location, previous) {
    const entry = { settled: false, hasValue: !!previous?.hasValue, value: previous?.value, time: previous?.time ?? 0 };
    entry.promise = Promise.resolve()
      .then(() =>
        matched.route.loader({ params: matched.params, query: new URLSearchParams(location.search), location }),
      )
      .then(
        (value) => {
          Object.assign(entry, { value, hasValue: true, settled: true, time: Date.now() });
          return value;
        },
        (error) => {
          entry.settled = true;
          if (!entry.hasValue) this.entries.delete(location.id); // let the next visit retry
          throw error;
        },
      );
    this.entries.delete(location.id);
    this.entries.set(location.id, entry);
    while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value);
    return entry.promise;
  }

  invalidate(id) {
    if (id) this.entries.delete(id);
    else this.entries.clear();
  }
}
