"use client";

import { useEffect } from "react";

import { debugLog, isDebugLogEnabled } from "@/lib/debug-log";

declare global {
  interface Window {
    __erudaInitialized?: boolean;
  }
}

export function DebugConsole() {
  useEffect(() => {
    if (!isDebugLogEnabled() || window.__erudaInitialized) {
      return;
    }
    window.__erudaInitialized = true;

    void import("eruda")
      .then(({ default: eruda }) => {
        eruda.init({
          autoScale: true,
          useShadowDom: true,
          defaults: {
            displaySize: 50,
            transparency: 0.92,
          },
        });
        debugLog("info", "Eruda 调试面板已启用", {
          version: eruda.version,
          ua: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          dpr: window.devicePixelRatio,
        });
      })
      .catch((error) => {
        window.__erudaInitialized = false;
        console.error("[debug] Eruda 加载失败", error);
      });
  }, []);

  return null;
}
