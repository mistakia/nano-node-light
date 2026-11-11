// Insertion-ordered set of keys that evicts its oldest entries once it holds
// maximum_entry_count, so a dedupe store never grows without limit.
export default class BoundedCache {
  constructor({ maximum_entry_count }) {
    if (!(maximum_entry_count > 0)) {
      throw new Error('maximum_entry_count must be a positive number')
    }

    this.maximum_entry_count = maximum_entry_count
    this.entries = new Set()
  }

  get size() {
    return this.entries.size
  }

  has(key) {
    return this.entries.has(key)
  }

  set(key) {
    if (this.entries.has(key)) return

    this.entries.add(key)
    while (this.entries.size > this.maximum_entry_count) {
      const oldest_key = this.entries.values().next().value
      this.entries.delete(oldest_key)
    }
  }
}
