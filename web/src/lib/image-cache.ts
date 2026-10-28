"use client";

import localforage from "localforage";

type CachedImageRecord = {
  version: 1;
  source: string;
  blob: Blob;
  cachedAt: number;
};

export type ResolvedCachedImage = {
  source: string;
  src: string;
  blob: Blob | null;
  fromCache: boolean;
};

const imageCacheStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "image_cache",
});
const memoryCache = new Map<string, { src: string; blob: Blob }>();
const pendingLoads = new Map<string, Promise<ResolvedCachedImage>>();

function isInlineSource(source: string) {
  return source.startsWith("data:") || source.startsWith("blob:");
}

function normalizeSource(source: string) {
  const value = String(source || "").trim();
  if (!value || isInlineSource(value) || typeof window === "undefined") {
    return value;
  }
  try {
    const parsed = new URL(value, window.location.origin);
    // HTTPS 页面下引用同源的 http 资源会被浏览器按混合内容拦截；
    // 同源资源直接跟随当前页面协议，避免旧数据里的 http 链接失效。
    if (
      parsed.protocol === "http:" &&
      window.location.protocol === "https:" &&
      parsed.host === window.location.host
    ) {
      parsed.protocol = "https:";
    }
    return parsed.href;
  } catch {
    return value;
  }
}

function cacheKey(source: string) {
  return `image-cache:v1:${source}`;
}

function isCachedImageRecord(value: unknown, source: string): value is CachedImageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CachedImageRecord>;
  return record.version === 1 && record.source === source && record.blob instanceof Blob && record.blob.size > 0;
}

function rememberBlob(source: string, blob: Blob) {
  const existing = memoryCache.get(source);
  if (existing) return existing.src;
  const src = URL.createObjectURL(blob);
  memoryCache.set(source, { src, blob });
  return src;
}

export function getImmediateCachedImageSource(source: string): string | null {
  const normalized = normalizeSource(source);
  if (!normalized) return null;
  if (isInlineSource(normalized)) return normalized;
  return memoryCache.get(normalized)?.src || null;
}

export async function resolveCachedImage(source: string): Promise<ResolvedCachedImage> {
  const normalized = normalizeSource(source);
  if (!normalized) {
    throw new Error("图片地址为空");
  }
  if (isInlineSource(normalized)) {
    return { source: normalized, src: normalized, blob: null, fromCache: true };
  }

  const memory = memoryCache.get(normalized);
  if (memory) {
    return { source: normalized, src: memory.src, blob: memory.blob, fromCache: true };
  }
  const pending = pendingLoads.get(normalized);
  if (pending) return pending;

  const loading = (async () => {
    try {
      const stored = await imageCacheStorage.getItem<CachedImageRecord>(cacheKey(normalized));
      if (isCachedImageRecord(stored, normalized)) {
        return {
          source: normalized,
          src: rememberBlob(normalized, stored.blob),
          blob: stored.blob,
          fromCache: true,
        };
      }
    } catch {
      // IndexedDB 不可用时继续走网络，并保留当前页面的内存缓存。
    }

    // 浏览器 HTTP 缓存可能存着 <img> 发起的 no-cors 响应（没有 ACAO），
    // 后续 cors fetch 复用它会被 CORS 拦截；reload 强制绕过浏览器缓存重新取。
    // 应用自己的 IndexedDB / 内存缓存仍然生效，不会造成重复下载。
    const response = await fetch(normalized, { cache: "reload" });
    if (!response.ok) {
      throw new Error(`图片加载失败：HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) {
      throw new Error("图片加载失败：响应为空");
    }
    const resolved = {
      source: normalized,
      src: rememberBlob(normalized, blob),
      blob,
      fromCache: false,
    };
    try {
      await imageCacheStorage.setItem(cacheKey(normalized), {
        version: 1,
        source: normalized,
        blob,
        cachedAt: Date.now(),
      } satisfies CachedImageRecord);
    } catch {
      // 浏览器存储空间不足时仍返回已下载的内存 Blob。
    }
    return resolved;
  })();

  pendingLoads.set(normalized, loading);
  try {
    return await loading;
  } finally {
    pendingLoads.delete(normalized);
  }
}

export async function deleteCachedImageSources(sources: Array<string | undefined>): Promise<void> {
  const normalizedSources = [...new Set(sources.map((source) => normalizeSource(source || "")).filter(Boolean))];
  await Promise.allSettled(normalizedSources.map((source) => pendingLoads.get(source)));
  await Promise.allSettled(
    normalizedSources.map(async (source) => {
      if (isInlineSource(source)) return;
      const memory = memoryCache.get(source);
      if (memory) {
        URL.revokeObjectURL(memory.src);
        memoryCache.delete(source);
      }
      await imageCacheStorage.removeItem(cacheKey(source));
    }),
  );
}

export async function clearCachedImages(): Promise<void> {
  await Promise.allSettled([...pendingLoads.values()]);
  for (const cached of memoryCache.values()) {
    URL.revokeObjectURL(cached.src);
  }
  memoryCache.clear();
  await imageCacheStorage.clear();
}
