export function propagateHandlerError<T extends any[]>(
  fn: (...params: T) => void
) {
  return (...params: T) => {
    try {
      fn(...params);
    } catch (err) {
      process.nextTick(() => {
        throw err;
      });
    }
  };
}
