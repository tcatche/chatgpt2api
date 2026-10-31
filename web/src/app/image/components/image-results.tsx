"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Brush, Clock3, Download, EyeOff, Layers, LoaderCircle, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCachedImageSource } from "@/hooks/use-cached-image-source";
import { getImmediateCachedImageSource, resolveCachedImage } from "@/lib/image-cache";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurn, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

export type ImageLightboxGroupKind = "results" | "references";

export type ImageLightboxGroup = {
  turnId: string;
  kind: ImageLightboxGroupKind;
  images: ImageLightboxItem[];
  index: number;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (group: ImageLightboxGroup) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onAnnotateImage: (conversationId: string, image: StoredImage, source: string) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onBatchRegenerate: (conversationId: string, turnIds: string[]) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onTimeoutRetryContinue: (taskId: string) => void | Promise<void>;
  onDismissErrors: (conversationId: string, turnId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

// Blob URL 缓存：避免 base64 超长字符串在 DOM 中，改用短小的 blob: URL
const b64BlobUrlCache = new Map<string, string>();

// 结果图尺寸缓存：灯箱跨轮次切换时也要显示同一份尺寸，放模块级避免随组件丢失
const imageDimensions = new Map<string, string>();

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    let url = b64BlobUrlCache.get(image.b64_json);
    if (!url) {
      const binary = atob(image.b64_json);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      url = URL.createObjectURL(blob);
      b64BlobUrlCache.set(image.b64_json, url);
    }
    return url;
  }
  return image.url || "";
}

/** 该轮是否至少有一张可在灯箱里展示的图，用于决定上下切换时能否停在它上面。 */
export function hasTurnLightboxImages(turn: ImageTurn, kind: ImageLightboxGroupKind) {
  if (kind === "references") {
    return turn.referenceImages.length + turn.maskImages.length > 0;
  }
  return turn.images.some((image) => image.status === "success" && Boolean(image.b64_json || image.url));
}

export function buildTurnLightboxImages(turn: ImageTurn, kind: ImageLightboxGroupKind): ImageLightboxItem[] {
  if (kind === "references") {
    return [
      ...turn.referenceImages.map((image, index) => ({
        id: `${turn.id}-reference-${index}`,
        src: image.url || image.dataUrl || "",
      })),
      ...turn.maskImages.map((image, index) => ({
        id: `${turn.id}-mask-${index}`,
        src: image.url || image.dataUrl || "",
      })),
    ];
  }
  return turn.images.flatMap((image) => {
    const src = image.status === "success" ? getStoredImageSrc(image) : "";
    if (!src) return [];
    return [{
      id: image.id,
      src,
      sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
      dimensions: imageDimensions.get(image.id),
    }];
  });
}

async function downloadStoredImage(image: StoredImage, index: number) {
  let blob: Blob | null = null;
  try {
    if (image.b64_json) {
      const binary = atob(image.b64_json);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: "image/png" });
    } else if (image.url) {
      blob = (await resolveCachedImage(image.url)).blob;
    } else {
      return;
    }
  } catch (err) {
    console.error("Failed to download image:", err);
    // 如果 fetch 失败，尝试直接在新窗口打开
    if (image.url) {
      window.open(image.url, "_blank");
    }
    return;
  }
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const extension = /\.(webp|jpe?g|png|gif)(?:[?#]|$)/i.exec(image.url || "")?.[1]?.toLowerCase() || "png";
  a.download = `image-${index + 1}.${extension}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onAnnotateImage,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onBatchRegenerate,
  onRetryImage,
  onTimeoutRetryContinue,
  onDismissErrors,
  formatConversationTime,
}: ImageResultsProps) {
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  
  // 仅在存在 loading 图片时启动定时器，避免空闲时无谓重渲染
  const hasLoadingImages = selectedConversation?.turns.some(
    (turn) => !turn.resultsDeleted && turn.images.some((image) => image.status === "loading"),
  );
  useEffect(() => {
    if (!hasLoadingImages) return;
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, [hasLoadingImages]);

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    // 使用模块级缓存，不触发 React 重渲染，消除级联重渲染
    if (imageDimensions.get(id) !== dimensions) {
      imageDimensions.set(id, dimensions);
    }
  };

  // 批量重新生成：有提示词、且不在生成中的轮次才可以选
  const regenerableTurns = (selectedConversation?.turns ?? []).filter(
    (turn) => Boolean(turn.prompt.trim()) && turn.status !== "queued" && turn.status !== "generating",
  );
  const regenerableIds = regenerableTurns.map((turn) => turn.id);
  const errorTurnIds = regenerableTurns
    .filter((turn) => turn.status === "error" || turn.images.some((image) => image.status === "error"))
    .map((turn) => turn.id);
  const selectedTurns = regenerableTurns.filter((turn) => batchSelection.includes(turn.id));
  const selectedImageCount = selectedTurns.reduce(
    (sum, turn) => sum + Math.max(1, turn.count || turn.images.length || 1),
    0,
  );

  const toggleBatchTurn = (turnId: string, checked: boolean) => {
    setBatchSelection((current) =>
      checked ? Array.from(new Set([...current, turnId])) : current.filter((id) => id !== turnId),
    );
  };

  const handleBatchConfirm = async () => {
    if (!selectedConversation || selectedTurns.length === 0) {
      return;
    }
    setBatchSubmitting(true);
    try {
      await onBatchRegenerate(selectedConversation.id, selectedTurns.map((turn) => turn.id));
      setBatchOpen(false);
      setBatchSelection([]);
    } finally {
      setBatchSubmitting(false);
    }
  };

  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[260px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl">
          <h1
            className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            在同一窗口里保留本地历史与任务状态，并从已有结果图继续发起新的无状态编辑。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/70 pb-3 dark:border-white/10">
        <span className="text-xs text-stone-500">共 {selectedConversation.turns.length} 轮</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-full border-stone-200 bg-white px-3 text-stone-700 hover:bg-stone-50"
          onClick={() => {
            setBatchSelection([]);
            setBatchOpen(true);
          }}
          disabled={regenerableIds.length === 0}
        >
          <Layers className="size-3.5" />
          批量重新生成
        </Button>
      </div>
      {selectedConversation.turns.map((turn, turnIndex) => {
        const referenceLightboxImages = buildTurnLightboxImages(turn, "references");
        const successfulTurnImages = buildTurnLightboxImages(turn, "results");

        return (
          <div key={turn.id} className="flex flex-col gap-3 sm:gap-4">
            {!turn.promptDeleted ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] px-1 py-1 text-[14px] leading-6 text-stone-900 sm:max-w-[82%] sm:text-[15px] sm:leading-7">
                  <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-stone-400 sm:mb-2">
                    <span>第 {turnIndex + 1} 轮</span>
                    <span>
                      {turn.mode === "edit" ? "编辑图" : "文生图"}
                    </span>
                    <span>{getTurnStatusLabel(turn.status)}</span>
                    <span>{formatConversationTime(turn.createdAt)}</span>
                  </div>
                  <div className="text-right">{turn.prompt}</div>
                  <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      复用配置
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePrompt(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除提示词记录"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!turn.resultsDeleted ? (
              <div className="flex justify-start">
                <div className="w-full p-1">
                  {turn.referenceImages.length > 0 ? (
                    <div className="mb-4 flex flex-col items-end">
                      <div className="mb-3 text-xs font-medium text-stone-500">本轮参考图</div>
                      <div className="flex flex-wrap justify-end gap-3">
                        {turn.referenceImages.map((image, index) => (
                          <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenLightbox({ turnId: turn.id, kind: "references", images: referenceLightboxImages, index })}
                              className="group relative h-24 w-24 overflow-hidden border border-stone-200/80 bg-stone-100/60 text-left transition hover:border-stone-300"
                              aria-label={`预览参考图 ${image.name || index + 1}`}
                            >
                              <img
                                src={image.url || image.dataUrl || ""}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                              />
                            </button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="rounded-full border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                              onClick={() => onContinueEdit(selectedConversation.id, image)}
                            >
                              <Sparkles className="size-4" />
                              引用
                            </Button>
                          </div>
                        ))}
                        {turn.maskImages.map((mask, index) => (
                          <div key={`${turn.id}-mask-${index}`} className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenLightbox({ turnId: turn.id, kind: "references", images: referenceLightboxImages, index: turn.referenceImages.length + index })}
                              className="group relative h-24 w-24 overflow-hidden border border-stone-200/80 bg-stone-300 text-left transition hover:border-stone-400"
                              aria-label={`预览标注遮罩 ${index + 1}`}
                            >
                              <img
                                src={mask.url || mask.dataUrl || ""}
                                alt={`标注遮罩 ${index + 1}：透明区域将重绘`}
                                className="absolute inset-0 h-full w-full object-contain"
                              />
                            </button>
                            <span className="text-[11px] text-stone-500">标注遮罩 · 透明处重绘</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                    <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1">{turn.model}</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                    {turn.status === "queued" ? (
                      <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">等待当前对话中的前序任务完成</span>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:block sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
                    {turn.images.map((image, index) => {
                      const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                      if (image.status === "success" && imageSrc) {
                        const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                        const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
                        const dimensions = imageDimensions.get(image.id);
                        const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                        return (
                          <div
                            key={image.id}
                            className="break-inside-avoid"
                          >
                            <LazyImage
                              src={imageSrc}
                              alt={`Generated result ${index + 1}`}
                              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-xl sm:aspect-auto"
                              onLoad={(event) => {
                                updateImageDimensions(
                                  image.id,
                                  event.currentTarget.naturalWidth,
                                  event.currentTarget.naturalHeight,
                                );
                              }}
                              onOpen={() => onOpenLightbox({ turnId: turn.id, kind: "results", images: successfulTurnImages, index: currentIndex })}
                            />
                            <div className="flex flex-col gap-2 px-0.5 py-1 text-[10px] sm:px-3 sm:py-3 sm:text-xs">
                              <div data-slot="image-result-meta" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-stone-500">
                                <span>结果 {index + 1}</span>
                                {image.durationMs != null ? <span className="whitespace-nowrap text-stone-400">{formatDuration(image.durationMs)}</span> : null}
                                {imageMeta ? <span className="whitespace-nowrap text-stone-400">{imageMeta}</span> : null}
                              </div>
                              <div data-slot="image-result-actions" className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center sm:justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 w-full rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => onAnnotateImage(
                                    selectedConversation.id,
                                    image,
                                    getImmediateCachedImageSource(imageSrc) || imageSrc,
                                  )}
                                  aria-label="编辑"
                                >
                                  <Brush className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">编辑</span>
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 w-full rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => onContinueEdit(selectedConversation.id, image)}
                                  aria-label="引用"
                                >
                                  <Sparkles className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">引用</span>
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 w-full rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => void downloadStoredImage(image, index)}
                                  aria-label="下载"
                                >
                                  <Download className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">下载</span>
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (image.status === "error") {
                        const isTimeoutError = image.error?.includes("超时") && image.taskId;
                        return (
                          <div key={image.id} className="break-inside-avoid">
                            <div
                              className={cn(
                                "overflow-hidden rounded-xl border border-rose-200 bg-rose-50",
                                "aspect-square",
                                turn.ratio === "1:1" && "sm:aspect-square",
                                turn.ratio === "16:9" && "sm:aspect-video",
                                turn.ratio === "9:16" && "sm:aspect-[9/16]",
                                turn.ratio === "4:3" && "sm:aspect-[4/3]",
                                turn.ratio === "3:4" && "sm:aspect-[3/4]",
                              )}
                            >
                            <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1.5 px-2 py-2 text-center text-[11px] leading-4 text-rose-600 sm:gap-3 sm:px-6 sm:py-8 sm:text-sm sm:leading-6">
                              <p className="font-medium">图片 {index + 1}/{turn.images.length}</p>
                              <span className="line-clamp-2 sm:line-clamp-none">{image.error || "生成失败"}</span>
                              <div className="flex items-center gap-2">
                                {isTimeoutError && (
                                  <button
                                    type="button"
                                    onClick={() => void onTimeoutRetryContinue(image.taskId!)}
                                    className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-medium text-emerald-600 shadow-sm transition hover:bg-emerald-200 sm:px-3 sm:text-xs"
                                  >
                                    继续等待
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                  className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-rose-600 shadow-sm transition hover:bg-rose-100 sm:px-3 sm:text-xs"
                                >
                                  重新生成这一张
                                </button>
                              </div>
                            </div>
                            </div>
                            <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-3 sm:text-xs">
                              <div className="min-w-0 text-stone-500">
                                <span>结果 {index + 1}</span>
                                {image.durationMs != null ? <span className="text-stone-400 sm:ml-2">{formatDuration(image.durationMs)}</span> : null}
                                <span className="block text-transparent">-</span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const imageTaskStatus = image.taskStatus || (turn.status === "queued" ? "queued" : "running");
                      const imageStatusLabel = imageTaskStatus === "queued" ? "排队中" : getProgressLabel(image.progress);
                      const showElapsed = imageTaskStatus === "running" && image.elapsedSecs != null;
                      const elapsedDisplay = showElapsed
                        ? formatElapsed(
                            image.elapsedUpdatedAt != null
                              ? image.elapsedSecs! + (currentTime - image.elapsedUpdatedAt!) / 1000
                              : image.elapsedSecs!,
                          )
                        : null;
                      return (
                        <div key={image.id} className="break-inside-avoid">
                          <div
                            className={cn(
                              "overflow-hidden rounded-xl border border-stone-200/80 bg-stone-100/80 relative",
                              turn.ratio === "1:1" && "aspect-square",
                              turn.ratio === "16:9" && "aspect-video",
                              turn.ratio === "9:16" && "aspect-[9/16]",
                              turn.ratio === "4:3" && "aspect-[4/3]",
                              turn.ratio === "3:4" && "aspect-[3/4]",
                            )}
                          >
                          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 py-3 text-center text-stone-500 sm:gap-3 sm:px-6 sm:py-8">
                            <div className="rounded-full bg-white p-2 shadow-sm sm:p-3">
                              {imageTaskStatus === "queued" ? (
                                <Clock3 className="size-4 sm:size-5" />
                              ) : (
                                <LoaderCircle className="size-4 animate-spin sm:size-5" />
                              )}
                            </div>
                            <p className="text-[11px] font-medium leading-4 sm:text-sm">
                              图片 {index + 1}/{turn.images.length}
                            </p>
                            <p className="text-[10px] leading-4 text-stone-400 sm:text-xs">
                              {imageStatusLabel}
                            </p>
                          </div>
                          </div>
                          {elapsedDisplay != null && (
                            <div className="px-0.5 py-1 text-[10px] text-stone-400 sm:px-3 sm:py-3 sm:text-xs">{elapsedDisplay}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {turn.status === "error" && turn.error ? (
                    <div className="mt-4 flex items-center justify-between border-l-2 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                      <span>{turn.error}</span>
                      <button
                        type="button"
                        onClick={() => void onDismissErrors(selectedConversation.id, turn.id)}
                        className="ml-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700 transition hover:bg-amber-200 hover:text-amber-900"
                      >
                        <EyeOff className="size-3" />
                        忽略错误
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-3 flex items-center gap-1.5 text-[11px] sm:mt-4">
                    <button
                      type="button"
                      onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-500 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      <RotateCcw className="size-3" />
                      全部重新生成
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除生成结果"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <Dialog
        open={batchOpen}
        onOpenChange={(open) => {
          setBatchOpen(open);
          if (!open) {
            setBatchSelection([]);
          }
        }}
      >
        <DialogContent className="w-[min(94vw,640px)] rounded-2xl">
          <DialogHeader className="gap-1">
            <DialogTitle>批量重新生成</DialogTitle>
            <p className="text-xs leading-5 text-stone-500">
              勾选轮次后每轮各新增一次生成，不覆盖原有结果，会重新消耗额度。
            </p>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => setBatchSelection(regenerableIds)}
              disabled={regenerableIds.length === 0}
            >
              全选
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => setBatchSelection(regenerableIds.filter((id) => !batchSelection.includes(id)))}
              disabled={regenerableIds.length === 0}
            >
              反选
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => setBatchSelection(errorTurnIds)}
              disabled={errorTurnIds.length === 0}
            >
              选中出错的轮次{errorTurnIds.length > 0 ? `（${errorTurnIds.length}）` : ""}
            </Button>
            <button
              type="button"
              className="text-xs text-stone-400 transition hover:text-stone-700 disabled:opacity-50"
              onClick={() => setBatchSelection([])}
              disabled={batchSelection.length === 0}
            >
              清空
            </button>
          </div>
          <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
            {selectedConversation.turns.map((turn, turnIndex) => {
              const eligible = regenerableIds.includes(turn.id);
              const checked = batchSelection.includes(turn.id);
              const imageCount = Math.max(1, turn.count || turn.images.length || 1);
              const hasError = errorTurnIds.includes(turn.id);
              return (
                <div
                  key={turn.id}
                  onClick={() => {
                    if (eligible) {
                      toggleBatchTurn(turn.id, !checked);
                    }
                  }}
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border px-3 py-2 text-xs transition",
                    eligible
                      ? "cursor-pointer border-stone-200 bg-white hover:bg-stone-50 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                      : "cursor-not-allowed border-stone-100 bg-stone-50 opacity-60 dark:border-white/5 dark:bg-white/5",
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    disabled={!eligible}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={(value) => toggleBatchTurn(turn.id, Boolean(value))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-stone-400">
                      <span className="font-medium text-stone-700 dark:text-stone-200">第 {turnIndex + 1} 轮</span>
                      <span>{getTurnStatusLabel(turn.status)}</span>
                      {hasError ? <span className="text-rose-500">有失败图</span> : null}
                      <span>{turn.model}</span>
                      <span>{imageCount} 张</span>
                      <span>{formatConversationTime(turn.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-stone-700 dark:text-stone-200">
                      {turn.prompt || "（无提示词）"}
                    </span>
                    {!eligible ? (
                      <span className="mt-0.5 block text-[11px] text-stone-400">
                        {turn.prompt.trim() ? "正在生成，等这一轮结束后再选" : "没有提示词，无法重新生成"}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
          <DialogFooter className="items-center gap-2">
            <span className="mr-auto text-xs text-stone-500">
              已选 {selectedTurns.length} 个任务 · 共 {selectedImageCount} 张图
            </span>
            <Button type="button" variant="ghost" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleBatchConfirm()}
              disabled={selectedTurns.length === 0 || batchSubmitting}
            >
              {batchSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认重新生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

const PROGRESS_LABELS: Record<string, string> = {
  getting_account: "确认可用账号",
  uploading: "上传图片",
  bootstrapping: "预热首页",
  getting_token: "获取 token",
  preparing_conversation: "准备会话",
  starting_generation: "启动生成",
  generating: "生成中",
  receiving_image: "接收图片中",
};

function getProgressLabel(progress?: string) {
  if (!progress) {
    return "生成中";
  }
  return PROGRESS_LABELS[progress] || "生成中";
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const base64SizeCache = new Map<string, string>();
function formatBase64ImageSize(base64: string) {
  let cached = base64SizeCache.get(base64);
  if (cached !== undefined) return cached;
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    cached = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } else if (bytes >= 1024) {
    cached = `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    cached = `${bytes} B`;
  }
  base64SizeCache.set(base64, cached);
  return cached;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}

const LazyImage = memo(function LazyImage({ src, alt, className, onLoad, onOpen }: {
  src: string;
  alt: string;
  className: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onOpen?: () => void;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const cachedSrc = useCachedImageSource(src, isVisible);

  useEffect(() => {
    const element = imgRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className="relative">
      {isVisible && cachedSrc ? (
        <button
          type="button"
          onClick={onOpen}
          className={className}
        >
          <img
            src={cachedSrc}
            alt={alt}
            className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:h-auto sm:object-contain"
            onLoad={onLoad}
          />
        </button>
      ) : (
        <div className={`animate-pulse rounded-xl bg-stone-100 min-h-[200px] sm:min-h-[280px] ${className}`} />
      )}
    </div>
  );
});
