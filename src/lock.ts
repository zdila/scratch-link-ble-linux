export function createLock() {
  let lockPromise: Promise<void> | undefined;

  let resolve: (() => void) | undefined;

  return {
    async lock() {
      lockPromise = new Promise((r) => {
        resolve = r;
      });
    },

    unlock() {
      resolve?.();
      resolve = undefined;
      lockPromise = undefined;
    },
  };
}
