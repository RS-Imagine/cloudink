/**
 * @template T
 * @typedef {(value: T, prev: T) => void} Listener
 */

/**
 * Creates a lightweight reactive micro-store without heavy framework dependencies.
 * @template T
 * @param {T} initialValue
 */
export function createStore(initialValue) {
  let value = initialValue;
  /** @type {Set<Listener<T>>} */
  const listeners = new Set();

  return {
    /**
     * Retrieve the current state.
     * @returns {T}
     */
    get() {
      return value;
    },
    /**
     * Set a new state value and notify listeners if changed.
     * @param {T} next
     */
    set(next) {
      if (next !== value) {
        const prev = value;
        value = next;
        listeners.forEach((fn) => {
          try {
            fn(value, prev);
          } catch (err) {
            console.error('Store subscriber error:', err);
          }
        });
      }
    },
    /**
     * Update state using a mutator function.
     * @param {(current: T) => T} updater
     */
    update(updater) {
      this.set(updater(value));
    },
    /**
     * Subscribe to state updates. Returns an unsubscribe callback.
     * @param {Listener<T>} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener);
      listener(value, value);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Global reactive UI stores for CloudInk Admin.
 */
export const editorStore = createStore({
  dirty: 0,
  savedVersion: 0,
  conflict: false,
  slug: '',
  title: '',
  wordCount: 0,
});
