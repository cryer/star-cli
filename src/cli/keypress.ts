// Keypress parsing and stdin-chunk splitting.
//
// Ink's useInput parses each stdin chunk as exactly ONE keypress, so when the
// terminal coalesces rapid keys into a single read (ESC[A ESC[A from fast
// arrow presses or key repeat), every key after the first is silently dropped
// — history navigation and line hopping then feel dead. Here a chunk is first
// split into individual keypress units (escape sequences vs. maximal plain
// text runs, so pasted text still arrives as one string), and each unit is
// parsed separately.
//
// parseKeypress is a TypeScript port of Ink's parse-keypress.js (itself from
// enquirer's keypress.js, MIT), kept behavior-identical so existing handlers
// see the same (input, key) pairs as before.

export interface Keypress {
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  code?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing escape sequences is the whole point
const metaKeyCodeRe = /^(?:\u001B)([a-zA-Z0-9])$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing escape sequences is the whole point
const fnKeyRe = /^(?:\u001B+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

const keyName: Record<string, string> = {
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[[5~": "pageup",
  "[[6~": "pagedown",
  "[7~": "home",
  "[8~": "end",
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",
  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",
  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",
  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",
  "[Z": "tab",
};

export const nonAlphanumericKeys = [...Object.values(keyName), "backspace"];

const shiftKeyCodes = new Set([
  "[a",
  "[b",
  "[c",
  "[d",
  "[e",
  "[2$",
  "[3$",
  "[5$",
  "[6$",
  "[7$",
  "[8$",
  "[Z",
]);

const ctrlKeyCodes = new Set([
  "Oa",
  "Ob",
  "Oc",
  "Od",
  "Oe",
  "[2^",
  "[3^",
  "[5^",
  "[6^",
  "[7^",
  "[8^",
]);

export function parseKeypress(s: string): Keypress {
  const key: Keypress = {
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: s,
  };
  if (s === "\r") {
    key.name = "return";
  } else if (s === "\n") {
    key.name = "enter";
  } else if (s === "\t") {
    key.name = "tab";
  } else if (s === "\b" || s === "\u001B\b") {
    key.name = "backspace";
    key.meta = s.charAt(0) === "\u001B";
  } else if (s === "\x7f" || s === "\u001B\x7f") {
    key.name = "delete";
    key.meta = s.charAt(0) === "\u001B";
  } else if (s === "\u001B" || s === "\u001B\u001B") {
    key.name = "escape";
    key.meta = s.length === 2;
  } else if (s === " " || s === "\u001B ") {
    key.name = "space";
    key.meta = s.length === 2;
  } else if (s.length === 1 && s <= "\x1a") {
    key.name = String.fromCharCode(s.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (s.length === 1 && s >= "0" && s <= "9") {
    key.name = "number";
  } else if (s.length === 1 && s >= "a" && s <= "z") {
    key.name = s;
  } else if (s.length === 1 && s >= "A" && s <= "Z") {
    key.name = s.toLowerCase();
    key.shift = true;
  }
  const metaMatch = key.name === undefined ? metaKeyCodeRe.exec(s) : null;
  const fnMatch = key.name === undefined && metaMatch === null ? fnKeyRe.exec(s) : null;
  if (metaMatch) {
    key.meta = true;
    key.shift = /^[A-Z]$/.test(metaMatch[1] ?? "");
  } else if (fnMatch) {
    const segs = [...s];
    if (segs[0] === "\u001B" && segs[1] === "\u001B") {
      key.option = true;
    }
    const code = [fnMatch[1], fnMatch[2], fnMatch[4], fnMatch[6]].filter(Boolean).join("");
    const modifier = Number(fnMatch[3] || fnMatch[5] || 1) - 1;
    key.ctrl = !!(modifier & 4);
    key.meta = !!(modifier & 10);
    key.shift = !!(modifier & 1);
    key.code = code;
    key.name = keyName[code];
    key.shift = shiftKeyCodes.has(code) || key.shift;
    key.ctrl = ctrlKeyCodes.has(code) || key.ctrl;
  }
  return key;
}

// Splits a raw stdin chunk into keypress units. Escape sequences (CSI:
// ESC [ … final-byte; SS3: ESC O char; meta: ESC + char, including the
// ESC ESC [ … meta-sequence form) each become one unit; everything between
// them stays one intact text run so multi-character paste chunks keep
// arriving as a single input string. A trailing incomplete sequence is
// returned as-is — the same thing Ink would have parsed from the chunk.
export function splitKeypresses(chunk: string): string[] {
  const units: string[] = [];
  let i = 0;
  const csiLength = (start: number): number => {
    // start points just past "ESC [". Consume until the final byte
    // (0x40–0x7E) or the end of the chunk.
    let j = start;
    while (j < chunk.length) {
      const code = chunk.charCodeAt(j);
      j += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return j;
  };
  while (i < chunk.length) {
    if (chunk[i] !== "\u001B") {
      const next = chunk.indexOf("\u001B", i);
      const end = next === -1 ? chunk.length : next;
      units.push(chunk.slice(i, end));
      i = end;
      continue;
    }
    const next = chunk[i + 1];
    if (next === undefined) {
      units.push("\u001B");
      i += 1;
    } else if (next === "[") {
      const end = csiLength(i + 2);
      units.push(chunk.slice(i, end));
      i = end;
    } else if (next === "O") {
      const end = Math.min(i + 3, chunk.length);
      units.push(chunk.slice(i, end));
      i = end;
    } else if (next === "\u001B" && (chunk[i + 2] === "[" || chunk[i + 2] === "O")) {
      // Meta + arrow (ESC ESC [ A): keep as one unit.
      const end = chunk[i + 2] === "[" ? csiLength(i + 3) : Math.min(i + 4, chunk.length);
      units.push(chunk.slice(i, end));
      i = end;
    } else if (next === "\u001B") {
      // Two bare ESCs (double-Esc editing): dispatch them separately.
      units.push("\u001B");
      i += 1;
    } else {
      // Meta + character.
      units.push(chunk.slice(i, i + 2));
      i += 2;
    }
  }
  return units;
}

export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

// A chunk tail that is the beginning of an escape sequence split across two
// reads ("ESC[20" of an incoming "ESC[201~"). Held back by the dispatcher and
// prepended to the next chunk. A bare trailing ESC is deliberately NOT held:
// it is the Escape key and must dispatch immediately.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape-sequence prefixes is the whole point
const INCOMPLETE_TAIL_RE = /\u001B(?:\[(?:[0-9;?]*)?|O|\u001B(?:\[(?:[0-9;?]*)?|O))$/;

// Splits a chunk into the dispatchable head and an incomplete escape-sequence
// tail to hold for the next chunk.
export function splitTrailingIncomplete(chunk: string): { head: string; tail: string } {
  const match = INCOMPLETE_TAIL_RE.exec(chunk);
  if (!match) return { head: chunk, tail: "" };
  return { head: chunk.slice(0, chunk.length - match[0].length), tail: match[0] };
}

// Maps one keypress unit to the (input, key) pair Ink's useInput would have
// produced for it, so handlers can stay unchanged.
export function toInputKey(unit: string): { input: string; key: Key } {
  const keypress = parseKeypress(unit);
  const key: Key = {
    upArrow: keypress.name === "up",
    downArrow: keypress.name === "down",
    leftArrow: keypress.name === "left",
    rightArrow: keypress.name === "right",
    pageDown: keypress.name === "pagedown",
    pageUp: keypress.name === "pageup",
    return: keypress.name === "return",
    escape: keypress.name === "escape",
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === "tab",
    backspace: keypress.name === "backspace",
    delete: keypress.name === "delete",
    meta: keypress.meta || keypress.name === "escape" || keypress.option,
  };
  let input = keypress.ctrl ? (keypress.name ?? "") : keypress.sequence;
  if (nonAlphanumericKeys.includes(keypress.name ?? "")) {
    input = "";
  }
  if (input.startsWith("\u001B")) {
    input = input.slice(1);
  }
  if (input.length === 1 && /[A-Z]/.test(input)) {
    key.shift = true;
  }
  return { input, key };
}
