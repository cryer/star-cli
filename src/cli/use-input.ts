import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { type Key, splitKeypresses, splitTrailingIncomplete, toInputKey } from "./keypress";

export type InputHandler = (input: string, key: Key) => void;

// Drop-in replacement for Ink's useInput that first splits each stdin chunk
// into individual keypresses (see keypress.ts). Ink parses one keypress per
// chunk, so coalesced rapid keys — repeated arrow presses while browsing
// history, double-Esc, a key landing right after a paste — after the first
// were silently dropped.
export function useInput(inputHandler: InputHandler, options: { isActive?: boolean } = {}) {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin();
  // An escape sequence split across two reads is held here until the rest
  // arrives (a bare trailing ESC is never held — it is the Escape key).
  const pendingRef = useRef("");

  useEffect(() => {
    if (options.isActive === false) return;
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);

  useEffect(() => {
    if (options.isActive === false) return;
    const handleData = (data: string) => {
      const { head, tail } = splitTrailingIncomplete(pendingRef.current + data);
      pendingRef.current = tail;
      for (const unit of splitKeypresses(head)) {
        const { input, key } = toInputKey(unit);
        // Same guard as Ink: Ctrl+C is left to Ink's own exit handler unless
        // the app opted out of exit-on-Ctrl-C.
        if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
          inputHandler(input, key);
        }
      }
    };
    internal_eventEmitter?.on("input", handleData);
    return () => {
      internal_eventEmitter?.removeListener("input", handleData);
    };
  }, [options.isActive, internal_exitOnCtrlC, internal_eventEmitter, inputHandler]);
}
