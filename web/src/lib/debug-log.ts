export type DebugLogLevel = "info" | "warn" | "error";

let enabled: boolean | null = null;

function readDebugQuery() {
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
  if (enabled !== true) {
    enabled = readDebugQuery();
  }
  return enabled === true;
}

export function setDebugLogEnabled(value: boolean) {
  enabled = value;
}

export function debugLog(level: DebugLogLevel, message: string, detail?: unknown) {
  if (!isDebugLogEnabled()) {
    return;
  }

  const text = `[debug] ${message}`;
  if (level === "error") {
    console.error(text, detail ?? "");
  } else if (level === "warn") {
    console.warn(text, detail ?? "");
  } else {
    console.log(text, detail ?? "");
  }
}
