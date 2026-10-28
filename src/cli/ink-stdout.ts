const actualStreams = new WeakMap<object, NodeJS.WriteStream>();

// The REPL owns a bounded viewport. Hide the real row count from Ink's
// fallback, which otherwise clears the screen and replays history when a
// resize briefly evaluates the previous frame against a smaller terminal.
export function createInkStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  const proxy = new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === "rows") return Number.MAX_SAFE_INTEGER;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  actualStreams.set(proxy, stdout);
  return proxy;
}

export function terminalRows(stdout: NodeJS.WriteStream): number | undefined {
  return actualStreams.get(stdout)?.rows ?? stdout.rows;
}
