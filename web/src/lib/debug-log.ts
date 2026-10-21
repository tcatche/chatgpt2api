export type DebugLogLevel = "info" | "warn" | "error";

export type DebugLogEntry = {
  id: number;
  time: string;
  level: DebugLogLevel;
  message: string;
  detail?: string;
};

const MAX_ENTRIES = 200;
const EMPTY_ENTRIES: DebugLogEntry[] = [];

let enabled = false;
let nextId = 1;
let entries: DebugLogEntry[] = EMPTY_ENTRIES;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function isDebugQueryEnabled() {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return new URLSearchParams(window.location.search).has("debug");
  } catch {
    return false;
  }
}

export function isDebugLogEnabled() {
  return enabled;
}

export function setDebugLogEnabled(value: boolean) {
  if (enabled === value) {
    return;
  }
  enabled = value;
  notify();
}

export function subscribeDebugLog(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDebugLogEntries() {
  return entries;
}

export function clearDebugLog() {
  entries = EMPTY_ENTRIES;
  notify();
}

function formatDetail(detail: unknown) {
  if (detail === undefined) {
    return undefined;
  }
  if (typeof detail === "string") {
    return detail;
  }
  try {
    return JSON.stringify(detail, null, 0);
  } catch {
    return String(detail);
  }
}

export function debugLog(level: DebugLogLevel, message: string, detail?: unknown) {
  if (!enabled) {
    if (!isDebugQueryEnabled()) {
      return;
    }
    enabled = true;
  }

  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const entry: DebugLogEntry = {
    id: nextId++,
    time,
    level,
    message,
    detail: formatDetail(detail),
  };

  entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];

  if (level === "error") {
    console.error(`[debug] ${message}`, detail ?? "");
  } else if (level === "warn") {
    console.warn(`[debug] ${message}`, detail ?? "");
  } else {
    console.log(`[debug] ${message}`, detail ?? "");
  }

  notify();
}
