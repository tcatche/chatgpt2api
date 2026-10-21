"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __erudaInitialized?: boolean;
  }
}

export function DebugConsole() {
  useEffect(() => {
    if (typeof window === "undefined" || window.__erudaInitialized) {
      return;
    }
    if (!new URLSearchParams(window.location.search).has("debug")) {
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
      })
      .catch((error) => {
        window.__erudaInitialized = false;
        console.error("[debug] Eruda 加载失败", error);
      });
  }, []);

  return null;
}
