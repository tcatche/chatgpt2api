"use client";

import { Bug, Check, ChevronDown, ChevronUp, Copy, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  clearDebugLog,
  debugLog,
  getDebugLogEntries,
  isDebugQueryEnabled,
  setDebugLogEnabled,
  subscribeDebugLog,
  type DebugLogEntry,
} from "@/lib/debug-log";

const levelClass: Record<DebugLogEntry["level"], string> = {
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-rose-300",
};

export function DebugLogPanel() {
  const [active, setActive] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const entries = useSyncExternalStore(subscribeDebugLog, getDebugLogEntries, getDebugLogEntries);

  useEffect(() => {
    if (!isDebugQueryEnabled()) {
      return;
    }

    setDebugLogEnabled(true);
    setActive(true);
    debugLog("info", "调试日志已启用", {
      ua: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
    });

    const handleError = (event: ErrorEvent) => {
      debugLog("error", `window error: ${event.message}`, {
        source: `${event.filename}:${event.lineno}:${event.colno}`,
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      debugLog(
        "error",
        "未处理的 Promise 异常",
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : String(reason),
      );
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = entries
      .map((entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}${entry.detail ? ` ${entry.detail}` : ""}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      debugLog("warn", "复制日志失败，请长按选择文本");
    }
  }, [entries]);

  if (!active) {
    return null;
  }

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="fixed right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[300] inline-flex items-center gap-1 rounded-full bg-stone-950/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg"
      >
        <Bug className="size-3" />
        日志 {entries.length}
      </button>
    );
  }

  return (
    <div className="fixed left-2 right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[300] flex max-h-[45vh] flex-col overflow-hidden rounded-xl border border-white/15 bg-stone-950/95 text-white shadow-2xl backdrop-blur sm:left-3 sm:right-auto sm:top-3 sm:w-[480px]">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Bug className="size-3.5 text-sky-300" />
        <span className="text-[11px] font-semibold tracking-wide">调试日志</span>
        <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">{entries.length}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex size-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
            aria-label="复制全部日志"
          >
            {copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={clearDebugLog}
            className="inline-flex size-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
            aria-label="清空日志"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex size-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
            aria-label={collapsed ? "展开日志" : "收起日志"}
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setHidden(true)}
            className="inline-flex size-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white"
            aria-label="隐藏日志"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/10">
          {entries.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-white/50">暂无日志，返回页面选择一张参考图试试。</p>
          ) : (
            [...entries].reverse().map((entry) => (
              <div key={entry.id} className="border-b border-white/5 px-3 py-1.5 text-[11px] leading-4 last:border-b-0">
                <div className="flex gap-1.5">
                  <span className="shrink-0 text-white/35">{entry.time}</span>
                  <span className={`shrink-0 font-semibold ${levelClass[entry.level]}`}>
                    {entry.level.toUpperCase()}
                  </span>
                  <span className="min-w-0 break-words">{entry.message}</span>
                </div>
                {entry.detail ? (
                  <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-white/45">
                    {entry.detail}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
