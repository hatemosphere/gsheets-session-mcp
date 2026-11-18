const DEFAULTS = Object.freeze({ maxEvents: 200, maxChangesPerEvent: 500, maxMemoryMb: 8 });

export class ActivityLog {
  #entries = [];
  #bytes = 0;

  constructor(options = {}) {
    const maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
    const maxChangesPerEvent = options.maxChangesPerEvent ?? DEFAULTS.maxChangesPerEvent;
    const maxMemoryMb = options.maxMemoryMb ?? DEFAULTS.maxMemoryMb;

    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('activity.maxEvents must be a positive integer');
    }
    if (!Number.isInteger(maxChangesPerEvent) || maxChangesPerEvent < 1) {
      throw new Error('activity.maxChangesPerEvent must be a positive integer');
    }
    if (!Number.isFinite(maxMemoryMb) || maxMemoryMb <= 0) {
      throw new Error('activity.maxMemoryMb must be a positive number');
    }

    this.maxEvents = maxEvents;
    this.maxChangesPerEvent = maxChangesPerEvent;
    this.maxMemoryMb = maxMemoryMb;
    this.maxMemoryBytes = Math.floor(maxMemoryMb * 1024 * 1024);
  }

  get limits() {
    return {
      maxEvents: this.maxEvents,
      maxChangesPerEvent: this.maxChangesPerEvent,
      maxMemoryMb: this.maxMemoryMb,
      maxMemoryBytes: this.maxMemoryBytes,
    };
  }

  get sizeBytes() {
    return this.#bytes;
  }

  #byteSize(event) {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  }

  push(event) {
    if (!event || typeof event !== 'object') return false;
    const copy = { ...event };
    let changes = Array.isArray(copy.changes) ? copy.changes.slice() : null;
    let truncated = Boolean(copy.summary?.truncated);
    const syncSummary = () => {
      if (copy.summary && changes) {
        copy.summary = { ...copy.summary, returned: changes.length, truncated };
      }
    };

    if (changes && changes.length > this.maxChangesPerEvent) {
      changes = changes.slice(0, this.maxChangesPerEvent);
      truncated = true;
      syncSummary();
    }

    copy.changes = changes ?? copy.changes;
    while (changes?.length && this.#byteSize(copy) > this.maxMemoryBytes) {
      changes.pop();
      truncated = true;
      syncSummary();
    }
    if (this.#byteSize(copy) > this.maxMemoryBytes) return false;

    const bytes = this.#byteSize(copy);
    this.#entries.push({ event: copy, bytes });
    this.#bytes += bytes;
    while (this.#entries.length > this.maxEvents || this.#bytes > this.maxMemoryBytes) {
      const removed = this.#entries.shift();
      this.#bytes -= removed.bytes;
    }
    return true;
  }

  list({ limit = this.maxEvents, sinceTime = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('activity limit must be a positive integer');
    let selected = this.#entries;
    if (sinceTime !== null) selected = selected.filter((entry) => Date.parse(entry.event.time) >= sinceTime);
    return {
      total: selected.length,
      events: selected.slice(-Math.min(limit, this.maxEvents)).map((entry) => entry.event),
    };
  }
}
