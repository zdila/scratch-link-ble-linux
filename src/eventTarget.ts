export function createEventTarget<T extends { [key: string]: any }>() {
  const eventListeners: { [P in keyof T]: Set<(params: T[P]) => void> } =
    {} as any;

  function on<P extends keyof T>(type: P, callback: (params: T[P]) => void) {
    let s = eventListeners[type];

    if (!s) {
      s = new Set<(params: T[P]) => void>();

      eventListeners[type] = s;
    }

    s.add(callback);

    return () => {
      off(type, callback);
    };
  }

  function off<P extends keyof T>(type: P, callback: (params: T[P]) => void) {
    eventListeners[type]?.delete(callback);
  }

  function fire<P extends keyof T>(type: P, params: T[P]) {
    for (const callback of eventListeners[type] ?? []) {
      callback(params);
    }
  }

  return { on, off, fire };
}
