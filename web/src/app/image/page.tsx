"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageDrawingDialog } from "@/app/image/components/image-drawing-dialog";
import { ImageResults, buildTurnLightboxImages, hasTurnLightboxImages, type ImageLightboxGroup, type ImageLightboxGroupKind, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  fetchAccounts,
  fetchImageModelCatalog,
  fetchImageTasks,
  resumeImagePoll,
  submitImageTaskBatch,
  uploadImageInput,
  type Account,
  type ImageBatchTaskItem,
  type ImageModel,
  type ImageTask,
} from "@/lib/api";
import { clearCachedImages, deleteCachedImageSources, resolveCachedImage } from "@/lib/image-cache";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { useSettingsStore } from "@/app/settings/store";
import {
  clearImageConversations,
  deleteImageConversation,
  getImageConversation,
  getImageConversationStats,
  listImageConversations,
  renameImageConversation,
  saveImageConversation,
  saveImageConversations,
  type ImageConversation,
  type ImageConversationMode,
  type ImageConversationSummary,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:image_active_conversation_id";
const IMAGE_RATIO_STORAGE_KEY = "chatgpt2api:image_last_ratio";
const IMAGE_TIER_STORAGE_KEY = "chatgpt2api:image_last_tier";
const IMAGE_QUALITY_STORAGE_KEY = "chatgpt2api:image_last_quality";
const IMAGE_MODEL_STORAGE_KEY = "chatgpt2api:image_last_model";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const SCROLL_POSITIONS_STORAGE_KEY = "chatgpt2api:image_scroll_positions";
const SCROLL_TO_LATEST_THRESHOLD = 160;
const FALLBACK_IMAGE_MODELS: ImageModel[] = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2",
  "gpt-5-5-thinking",
  "gpt-5-5",
  "gpt-5-3",
];

function loadScrollPositions(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveScrollPositions(positions: Map<string, number>) {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, number> = {};
    positions.forEach((value, key) => { obj[key] = value; });
    window.sessionStorage.setItem(SCROLL_POSITIONS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // sessionStorage may be full or unavailable
  }
}

function clampImageCount(value: string) {
  return String(Math.min(100, Math.max(1, Math.floor(Number(value) || 1))));
}
function parseImageSize(size: string) {
  const match = size.match(/^(\d+)x(\d+)$/);
  return match ? { width: match[1], height: match[2] } : { width: "1024", height: "1024" };
}

const activeConversationQueueIds = new Set<string>();
let pollAbortController: AbortController | null = null;

// 任务状态轮询：正常 2 秒一次；连续失败后降频重试，避免一次网关抖动就把整批任务判死。
const TASK_POLL_INTERVAL_MS = 2000;
const TASK_POLL_SLOW_RETRY_AFTER = 10;
const TASK_POLL_SLOW_RETRY_DELAY_MS = 10000;
const TASK_POLL_GIVE_UP_AFTER = 60;

function getResultsDistanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

const BATCH_SOFT_LIMIT_PROMPTS = 20;
const BATCH_SOFT_LIMIT_IMAGES = 50;

function splitBatchPrompts(value: string) {
  return value
    .split(/\|{3,}|｜{3,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type PendingBatch = {
  prompts: string[];
  count: number;
  model: ImageModel;
  mode: ImageConversationMode;
  size: string;
  ratio: string;
  tier: string;
  quality: string;
  referenceImages: StoredReferenceImage[];
  maskImages: StoredReferenceImage[];
  conversationId: string;
  targetConversation: ImageConversation | null;
};

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_REFERENCE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

function isAcceptedReferenceImage(file: File) {
  const type = String(file.type || "").toLowerCase();
  if (ACCEPTED_REFERENCE_IMAGE_TYPES.has(type)) {
    return true;
  }
  if (type && type !== "application/octet-stream") {
    return false;
  }
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

async function uploadReferenceImages(images: StoredReferenceImage[]): Promise<StoredReferenceImage[]> {
  const cache = new Map<string, StoredReferenceImage>();
  const result: StoredReferenceImage[] = [];
  for (const image of images) {
    const key = image.url || image.dataUrl || "";
    if (!key) {
      continue;
    }
    const existing = cache.get(key);
    if (existing) {
      result.push(existing);
      continue;
    }
    let stored: StoredReferenceImage;
    if (image.url) {
      stored = { name: image.name, type: image.type, url: image.url };
    } else {
      const file = dataUrlToFile(image.dataUrl!, image.name || "reference.png", image.type);
      const uploaded = await uploadImageInput(file);
      stored = {
        name: image.name || uploaded.name,
        type: image.type || uploaded.type,
        url: uploaded.url,
      };
    }
    cache.set(key, stored);
    result.push(stored);
  }
  return result;
}

function normalizeStoredImageModel(value: string | null, availableModels: ImageModel[]): ImageModel {
  const normalized = String(value || "").trim();
  if (normalized && availableModels.includes(normalized)) {
    return normalized;
  }
  return availableModels.includes("gpt-image-2") ? "gpt-image-2" : availableModels[0] || "gpt-image-2";
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const blob = (await resolveCachedImage(url)).blob;
  if (!blob) throw new Error("读取结果图失败");
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

function getTurnResultSources(turn: ImageTurn | null | undefined) {
  return turn?.images.flatMap((image) => (image.url ? [image.url] : [])) || [];
}

function getConversationResultSources(conversation: ImageConversation | null | undefined) {
  return conversation?.turns.flatMap(getTurnResultSources) || [];
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct?.dataUrl) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function taskDataToStoredImage(image: StoredImage, task: ImageTask): StoredImage {
  if (task.status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...image,
        taskId: task.id,
        status: "error",
        taskStatus: undefined,
        progress: undefined,
        error: "未返回图片数据",
      };
    }
    return {
      ...image,
      taskId: task.id,
      status: "success",
      taskStatus: undefined,
      progress: undefined,
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
      durationMs: task.duration_ms,
    };
  }

  if (task.status === "error") {
    return {
      ...image,
      taskId: task.id,
      status: "error",
      taskStatus: undefined,
      progress: undefined,
      error: task.error || "生成失败",
      durationMs: task.duration_ms,
    };
  }

  const newTaskStatus = task.status === "queued" ? "queued" : task.status === "running" ? "running" : image.taskStatus;
  const shouldSetStartTime = newTaskStatus === "running" && !image.startTime;
  const startTime = shouldSetStartTime ? Date.now() : image.startTime;
  // elapsedSecs 仅使用后端返回的值，确保计时从 image_stream_resolve_start 开始
  const elapsedSecs =
    newTaskStatus === "running" && typeof task.elapsed_secs === "number"
      ? task.elapsed_secs
      : undefined;

  return {
    ...image,
    taskId: task.id,
    status: "loading",
    taskStatus: newTaskStatus,
    progress: task.progress || image.progress,
    error: undefined,
    startTime,
    elapsedSecs,
    elapsedUpdatedAt: elapsedSecs != null ? Date.now() : undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversationSummary[]) {
  const activeConversation = conversations.find(
    (conversation) => conversation.stats.queued + conversation.stats.running > 0,
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversationSummary[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function summaryFromConversation(conversation: ImageConversation): ImageConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turns.length,
    stats: getImageConversationStats(conversation),
  };
}

function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  const loadingCount = turn.images.filter((image) => image.status === "loading").length;
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  if (loadingCount > 0) {
    // 如果任何图片的 taskStatus 为 running，则状态为 generating
    const hasRunning = turn.images.some((image) => image.taskStatus === "running");
    if (hasRunning) {
      return { status: "generating", error: undefined };
    }
    return { status: turn.status === "queued" ? "queued" : "generating", error: undefined };
  }
  if (failedCount > 0) {
    return { status: "error", error: `其中 ${failedCount} 张未成功生成` };
  }
  if (successCount > 0) {
    return { status: "success", error: undefined };
  }
  // 所有图片都被忽略（images 为空），视为完成
  return { status: "success", error: undefined };
}

function finalizeIdleQueuedTurn(turn: ImageTurn): ImageTurn {
  if (
    (turn.status !== "queued" && turn.status !== "generating") ||
    turn.images.some((image) => image.status === "loading")
  ) {
    return turn;
  }
  const derived = deriveTurnStatus(turn);
  if (derived.status === turn.status && derived.error === turn.error) {
    return turn;
  }
  return {
    ...turn,
    ...derived,
  };
}

async function syncConversationImageTasks(items: ImageConversation[]) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.resultsDeleted
            ? []
            : turn.images.flatMap((image) =>
                (image.status === "loading" || (image.status === "error" && image.taskId))
                  ? [image.taskId!]
                  : [],
              ),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchImageTasks>>;
  try {
    taskList = await fetchImageTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (!image.taskId) {
          return image;
        }
        if (image.status !== "loading" && image.status !== "error") {
          return image;
        }
        const task = taskMap.get(image.taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage(image, task);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      changed = true;
      const derived = deriveTurnStatus({ ...turn, images });
      return {
        ...turn,
        ...derived,
        images,
      };
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }
  return normalized;
}

async function recoverConversationHistory(items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating" && turn.status !== "error") {
        return turn;
      }

      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: "页面刷新或任务中断，未找到可恢复的任务 ID",
        };
      });
      const candidateTurn = turnChanged ? { ...turn, images } : turn;
      const nextTurn = finalizeIdleQueuedTurn(candidateTurn);
      const derived = turnChanged ? deriveTurnStatus(nextTurn) : { status: nextTurn.status, error: nextTurn.error };
      if (!turnChanged && nextTurn === turn && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      changed = true;
      return {
        ...nextTurn,
        ...derived,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }

  return syncConversationImageTasks(normalized);
}


function ImagePageContent({ isAdmin }: { isAdmin: boolean }) {
  const didLoadQuotaRef = useRef(false);
  const conversationsRef = useRef<ImageConversationSummary[]>([]);
  const hydratedConversationsRef = useRef<Map<string, ImageConversation>>(new Map());
  const hydratingConversationsRef = useRef<Map<string, Promise<ImageConversation | null>>>(new Map());
  const loadCancelledRef = useRef(false);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const lastConversationIdRef = useRef<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollPositionsRef = useRef<Map<string, number>>(loadScrollPositions());
  const isRestoringScrollRef = useRef(false);
  const scrollRestoreGenerationRef = useRef(0);

  const config = useSettingsStore((state) => state.config);
  const imageTimeoutRetrySecs = Number(config?.image_timeout_retry_secs || 30);

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("3");
  const [imageRatio, setImageRatio] = useState("auto");
  const [imageTier, setImageTier] = useState("1k");
  const [imageWidth, setImageWidth] = useState("1024");
  const [imageHeight, setImageHeight] = useState("1024");
  const [imageQuality, setImageQuality] = useState("auto");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-2");
  const [globalImageModel, setGlobalImageModel] = useState<ImageModel>("gpt-image-2");
  const [imageModels, setImageModels] = useState<ImageModel[]>(FALLBACK_IMAGE_MODELS);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [maskImages, setMaskImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<ImageConversation | null>(null);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [availableQuota, setAvailableQuota] = useState("加载中...");
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxGroup, setLightboxGroup] = useState<{ turnId: string; kind: ImageLightboxGroupKind } | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [drawingDialog, setDrawingDialog] = useState<
    | { mode: "sketch" }
    | { mode: "annotate"; conversationId: string; image: StoredImage; source: string }
    | null
  >(null);
  const scrollToLatestBtnRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "one"; id: string }
    | { type: "prompt"; conversationId: string; turnId: string }
    | { type: "results"; conversationId: string; turnId: string }
    | { type: "all" }
    | null
  >(null);

  const parsedCount = useMemo(() => Number(clampImageCount(imageCount)), [imageCount]);
  const selectedConversation = activeConversation;
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce(
        (sum, conversation) => sum + conversation.stats.queued + conversation.stats.running,
        0,
      ),
    [conversations],
  );
  const deleteConfirmTitle =
    deleteConfirm?.type === "all"
      ? "清空历史记录"
      : deleteConfirm?.type === "prompt"
        ? "删除提示词记录"
        : deleteConfirm?.type === "results"
          ? "删除生成结果"
          : deleteConfirm?.type === "one"
            ? "删除对话"
            : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "prompt"
        ? "确认删除这条提示词记录吗？对应生成结果会保留。"
        : deleteConfirm?.type === "results"
          ? "确认删除这条生成结果吗？对应提示词记录会保留。"
          : deleteConfirm?.type === "one"
            ? "确认删除这条图片对话吗？删除后无法恢复。"
            : "";
  const pendingBatchImageCount = pendingBatch ? pendingBatch.prompts.length * pendingBatch.count : 0;
  const pendingBatchOverLimit = pendingBatch
    ? pendingBatch.prompts.length > BATCH_SOFT_LIMIT_PROMPTS || pendingBatchImageCount > BATCH_SOFT_LIMIT_IMAGES
    : false;

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const scrollResultsToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    shouldStickToBottomRef.current = true;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
  }, []);

  const handleResultsScroll = useCallback(() => {
    if (scrollRafRef.current !== null) {
      return;
    }

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const element = resultsViewportRef.current;
      if (!element) {
        return;
      }

      // 恢复滚动位置期间不处理滚动事件
      if (isRestoringScrollRef.current) {
        return;
      }

      // 保存当前会话的滚动位置（debounce 300ms 写入 sessionStorage）
      const convId = lastConversationIdRef.current;
      if (convId) {
        scrollPositionsRef.current.set(convId, element.scrollTop);
        if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = setTimeout(() => {
          scrollSaveTimerRef.current = null;
          saveScrollPositions(scrollPositionsRef.current);
        }, 300);
      }

      const isAwayFromLatest = getResultsDistanceFromBottom(element) > SCROLL_TO_LATEST_THRESHOLD;
      shouldStickToBottomRef.current = !isAwayFromLatest;
      // 直接操作 DOM 控制按钮显隐，避免 setState 触发全组件重渲染
      const btn = scrollToLatestBtnRef.current;
      if (btn) {
        if (isAwayFromLatest) {
          btn.style.display = "";
        } else {
          btn.style.display = "none";
        }
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollSaveTimerRef.current !== null) {
        clearTimeout(scrollSaveTimerRef.current);
        saveScrollPositions(scrollPositionsRef.current);
      }
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const storedRatio =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_RATIO_STORAGE_KEY) : null;
      const storedTier =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_TIER_STORAGE_KEY) : null;
      const storedQuality =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY) : null;
      const storedCount =
        typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_COUNT_STORAGE_KEY) : null;
      setImageRatio(storedRatio || "1:1");
      setImageTier(storedTier || "1k");
      setImageWidth("1024");
      setImageHeight("1024");
      setImageQuality(storedQuality || "auto");
      setImageCount(storedCount ? clampImageCount(storedCount) : "1");

      const items = await listImageConversations();
      if (loadCancelledRef.current) {
        return;
      }

      conversationsRef.current = items;
      setConversations(items);
      const storedConversationId =
        typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) : null;
      const nextSelectedConversationId =
        (storedConversationId && items.some((conversation) => conversation.id === storedConversationId)
          ? storedConversationId
          : null) ?? pickFallbackConversationId(items);
      setSelectedConversationId(nextSelectedConversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取会话记录失败";
      toast.error(message);
    } finally {
      if (!loadCancelledRef.current) {
        setIsLoadingHistory(false);
      }
    }
  }, [
    setImageRatio,
    setImageTier,
    setImageWidth,
    setImageHeight,
    setImageQuality,
    setImageCount,
    setConversations,
    setSelectedConversationId,
    setIsLoadingHistory,
  ]);

  // Handle bfcache (back/forward cache) — re-sync task status on page restore
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void loadHistory();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [loadHistory]);

  useEffect(() => {
    loadCancelledRef.current = false;
    void loadHistory();
    return () => {
      loadCancelledRef.current = true;
      // 组件卸载时保存当前滚动位置到 sessionStorage
      const element = resultsViewportRef.current;
      const convId = lastConversationIdRef.current;
      if (element && convId) {
        scrollPositionsRef.current.set(convId, element.scrollTop);
        saveScrollPositions(scrollPositionsRef.current);
      }
      activeConversationQueueIds.clear();
      if (pollAbortController) {
        pollAbortController.abort();
        pollAbortController = null;
      }
    };
  }, [loadHistory]);

  useEffect(() => {
    let cancelled = false;

    const loadImageModels = async () => {
      try {
        const catalog = await fetchImageModelCatalog();
        const available = Array.from(new Set(catalog.models));
        if (cancelled || available.length === 0) {
          return;
        }
        setImageModels(available);
        const storedModel = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) : null;
        const configuredDefaultModel = String(catalog.default_image_model || "").trim();
        if (configuredDefaultModel && available.includes(configuredDefaultModel)) {
          setGlobalImageModel(configuredDefaultModel);
        }
        setImageModel((current) => {
          if (configuredDefaultModel && available.includes(configuredDefaultModel)) {
            return configuredDefaultModel;
          }
          if (available.includes(current)) {
            return current;
          }
          return normalizeStoredImageModel(storedModel, available);
        });
      } catch {
        if (!cancelled) {
          setImageModels(FALLBACK_IMAGE_MODELS);
        }
      }
    };

    void loadImageModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuota = useCallback(async () => {
    if (!isAdmin) {
      setAvailableQuota("--");
      return;
    }
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((prev) => (prev === "加载中..." ? "--" : prev));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const handleFocus = () => {
      void loadQuota();
    };

    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAdmin, loadQuota]);

  // 切换会话时保存旧会话滚动位置，并隐藏容器防止闪烁
  useLayoutEffect(() => {
    if (!selectedConversation) {
      lastConversationIdRef.current = null;
      shouldStickToBottomRef.current = true;
      const btn = scrollToLatestBtnRef.current;
      if (btn) btn.style.display = "none";
      return;
    }

    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    const didSwitchConversation = lastConversationIdRef.current !== selectedConversation.id;

    if (didSwitchConversation) {
      // 递增 generation，使之前未完成的 rAF 回调失效
      scrollRestoreGenerationRef.current += 1;

      // 先保存旧会话的滚动位置（lastConversationIdRef 还是旧值）
      const oldConvId = lastConversationIdRef.current;
      if (oldConvId) {
        scrollPositionsRef.current.set(oldConvId, element.scrollTop);
        saveScrollPositions(scrollPositionsRef.current);
      }
      // 更新为新会话 ID
      lastConversationIdRef.current = selectedConversation.id;

      // 如果有保存的滚动位置，隐藏容器防止用户看到 scrollTop=0 的内容
      const savedScrollTop = scrollPositionsRef.current.get(selectedConversation.id);
      if (savedScrollTop != null && savedScrollTop > 0) {
        element.style.visibility = "hidden";
        isRestoringScrollRef.current = true;
      }
    }
  }, [selectedConversation?.id]);

  // 恢复滚动位置或跟随最新内容
  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    const element = resultsViewportRef.current;
    if (!element) {
      return;
    }

    const savedScrollTop = scrollPositionsRef.current.get(selectedConversation.id);

    if (savedScrollTop != null && savedScrollTop > 0) {
      // 捕获当前 generation，用于检测是否已被新的切换取代
      const generation = scrollRestoreGenerationRef.current;
      // 容器已在 useLayoutEffect 中设为 visibility:hidden，用户看不到滚动过程
      requestAnimationFrame(() => {
        // 如果 generation 已变，说明用户又切换了，放弃本次恢复
        if (scrollRestoreGenerationRef.current !== generation) return;
        element.scrollTop = savedScrollTop;
        // 再等一帧确保 scrollTop 生效后再显示容器
        requestAnimationFrame(() => {
          // 再次检查 generation
          if (scrollRestoreGenerationRef.current !== generation) return;
          const isAwayFromLatest = getResultsDistanceFromBottom(element) > SCROLL_TO_LATEST_THRESHOLD;
          shouldStickToBottomRef.current = !isAwayFromLatest;
          const btn = scrollToLatestBtnRef.current;
          if (btn) btn.style.display = isAwayFromLatest ? "" : "none";
          // 显示容器 — 用户直接看到正确位置的内容
          element.style.visibility = "";
          isRestoringScrollRef.current = false;
        });
      });
      // 恢复后清除保存的位置，下次内容更新时走正常的 shouldFollowLatest 逻辑
      scrollPositionsRef.current.delete(selectedConversation.id);
      return;
    }

    // 无保存位置，按正常逻辑处理
    const shouldFollowLatest =
      shouldStickToBottomRef.current ||
      getResultsDistanceFromBottom(element) <= SCROLL_TO_LATEST_THRESHOLD;

    if (shouldFollowLatest) {
      requestAnimationFrame(() => scrollResultsToLatest("smooth"));
      return;
    }

    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "";
  }, [selectedConversation?.id, selectedConversation?.updatedAt, selectedConversation?.turns.length, scrollResultsToLatest]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_RATIO_STORAGE_KEY, imageRatio);
    window.localStorage.setItem(IMAGE_TIER_STORAGE_KEY, imageTier);
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, imageQuality);
    window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, imageModel);
  }, [imageRatio, imageTier, imageQuality, imageModel]);

  useEffect(() => {
    if (typeof window !== "undefined" && parsedCount > 0) {
      window.localStorage.setItem(IMAGE_COUNT_STORAGE_KEY, String(parsedCount));
    }
  }, [parsedCount]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const applyHydratedConversation = useCallback((conversation: ImageConversation) => {
    hydratedConversationsRef.current.set(conversation.id, conversation);
    if (selectedConversationIdRef.current === conversation.id) {
      setActiveConversation(conversation);
    }
    const nextConversations = sortImageConversations([
      summaryFromConversation(conversation),
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
  }, []);

  const hydrateConversation = useCallback(async (id: string): Promise<ImageConversation | null> => {
    const cached = hydratedConversationsRef.current.get(id);
    if (cached) {
      return cached;
    }
    const inFlight = hydratingConversationsRef.current.get(id);
    if (inFlight) {
      return inFlight;
    }
    const task = (async () => {
      const loaded = await getImageConversation(id);
      if (!loaded) {
        return null;
      }
      // 恢复中断的轮次 / 同步任务状态（仅针对该会话）
      const [recovered] = await recoverConversationHistory([loaded]);
      hydratedConversationsRef.current.set(recovered.id, recovered);
      if (selectedConversationIdRef.current === recovered.id) {
        setActiveConversation(recovered);
      }
      const nextConversations = sortImageConversations([
        summaryFromConversation(recovered),
        ...conversationsRef.current.filter((item) => item.id !== recovered.id),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      return recovered;
    })();
    hydratingConversationsRef.current.set(id, task);
    try {
      return await task;
    } finally {
      hydratingConversationsRef.current.delete(id);
    }
  }, []);

  const persistConversation = async (conversation: ImageConversation) => {
    applyHydratedConversation(conversation);
    try {
      await saveImageConversation(conversation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      toast.error(`保存生图历史失败：${message}`);
    }
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = hydratedConversationsRef.current.get(conversationId) ?? (await hydrateConversation(conversationId));
      if (!current) {
        return;
      }
      const nextConversation = updater(current);
      applyHydratedConversation(nextConversation);
      if (options.persist !== false) {
        try {
          await saveImageConversation(nextConversation);
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          toast.error(`保存生图历史失败：${message}`);
        }
      }
    },
    [applyHydratedConversation, hydrateConversation],
  );

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    if (!selectedConversationId) {
      setActiveConversation(null);
      setIsConversationLoading(false);
      return;
    }
    const cached = hydratedConversationsRef.current.get(selectedConversationId);
    if (cached) {
      setActiveConversation(cached);
      setIsConversationLoading(false);
      return;
    }
    setActiveConversation(null);
    setIsConversationLoading(true);
    let cancelled = false;
    void hydrateConversation(selectedConversationId)
      .then((loaded) => {
        if (!cancelled && !loaded) {
          toast.error("读取会话失败，请稍后重试");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsConversationLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConversationId, hydrateConversation]);

  useEffect(() => {
    if (!selectedConversationId) return;
    const summary = conversationsRef.current.find((item) => item.id === selectedConversationId);
    const conversationModel = summary && imageModels.includes(summary.model)
      ? summary.model
      : imageModels[0];
    if (conversationModel) {
      setImageModel(conversationModel);
    }
  }, [imageModels, selectedConversationId]);

  const handleConversationModelChange = useCallback(
    async (model: ImageModel) => {
      setImageModel(model);
      if (!selectedConversationId) return;
      await updateConversation(selectedConversationId, (current) => {
        if (!current) {
          throw new Error("图片对话不存在");
        }
        return { ...current, model, updatedAt: new Date().toISOString() };
      });
    },
    [selectedConversationId, updateConversation],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setReferenceImages([]);
    setMaskImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    shouldStickToBottomRef.current = true;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    setSelectedConversationId(null);
    setImageModel(globalImageModel);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleDeleteConversation = async (id: string) => {
    const removedConversation = hydratedConversationsRef.current.get(id) ?? null;
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    hydratedConversationsRef.current.delete(id);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
      await deleteCachedImageSources(getConversationResultSources(removedConversation));
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      try {
        const items = await listImageConversations();
        conversationsRef.current = items;
        setConversations(items);
      } catch {
        // 服务端回读失败时保留当前界面状态，避免二次报错
      }
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    const conversation = hydratedConversationsRef.current.get(conversationId) ?? null;
    if (!conversation) {
      return;
    }
    const removedSources = part === "results"
      ? getTurnResultSources(conversation.turns.find((turn) => turn.id === turnId))
      : [];

    const turns = conversation.turns
      .map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        const images =
          part === "results"
            ? turn.images.map((image) => ({ id: image.id, status: "error" as const, error: "生成结果已删除" }))
            : turn.images;
        const derived =
          part === "results"
            ? deriveTurnStatus({
                ...turn,
                images,
              })
            : { status: turn.status, error: turn.error };
        const nextTurn = {
          ...turn,
          prompt: part === "prompt" ? "" : turn.prompt,
          promptDeleted: part === "prompt" ? true : turn.promptDeleted,
          resultsDeleted: part === "results" ? true : turn.resultsDeleted,
          ...derived,
          images,
        };
        return nextTurn.promptDeleted && nextTurn.resultsDeleted ? null : nextTurn;
      })
      .filter((turn): turn is ImageTurn => Boolean(turn));

    if (turns.length === 0) {
      await handleDeleteConversation(conversationId);
      return;
    }

    const nextConversation = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      turns,
    };
    await persistConversation(nextConversation);
    if (removedSources.length > 0) {
      await deleteCachedImageSources(removedSources);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      await clearCachedImages().catch(() => undefined);
      conversationsRef.current = [];
      setConversations([]);
      hydratedConversationsRef.current.clear();
      setActiveConversation(null);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const handleRenameConversation = async (id: string, title: string) => {
    const updatedAt = new Date().toISOString();
    const nextConversations = conversations.map((item) =>
      item.id === id ? { ...item, title, updatedAt } : item,
    );
    conversationsRef.current = sortImageConversations(nextConversations);
    setConversations(conversationsRef.current);
    const hydrated = hydratedConversationsRef.current.get(id);
    if (hydrated) {
      const nextHydrated = { ...hydrated, title, updatedAt };
      hydratedConversationsRef.current.set(id, nextHydrated);
      if (selectedConversationIdRef.current === id) {
        setActiveConversation(nextHydrated);
      }
    }
    try {
      await renameImageConversation(id, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : "重命名失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openDeletePromptConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "prompt", conversationId, turnId });
  };

  const openDeleteResultsConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "results", conversationId, turnId });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    if (target.type === "prompt" || target.type === "results") {
      await handleDeleteTurnPart(target.conversationId, target.turnId, target.type);
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const accepted = files.filter(isAcceptedReferenceImage);
    if (accepted.length === 0) {
      toast.error("不支持的图片格式，请使用 JPG / PNG / WebP / GIF");
      return;
    }
    if (accepted.length < files.length) {
      toast.error("部分图片格式不支持，已跳过（请使用 JPG / PNG / WebP / GIF）");
    }

    try {
      const previews = await Promise.all(
        accepted.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    if (referenceImages.length <= 1 && fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
    setMaskImages([]);
  }, [referenceImages.length]);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference = "id" in image
          ? (await buildReferenceImageFromStoredImage(
              image,
              `conversation-${conversationId}-${Date.now()}.png`,
            ))?.referenceImage ?? null
          : image;
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);
        setReferenceImages((prev) => [...prev, nextReference]);
        setMaskImages([]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [],
  );

  const handleAnnotateImage = useCallback(
    (conversationId: string, image: StoredImage, source: string) => {
      setDrawingDialog({ mode: "annotate", conversationId, image, source });
    },
    [],
  );

  const handleApplyDrawing = useCallback(
    async (file: File) => {
      if (!drawingDialog) return;
      const dataUrl = await readFileAsDataUrl(file);
      const storedDrawing: StoredReferenceImage = { name: file.name, type: file.type || "image/png", dataUrl };

      if (drawingDialog.mode === "sketch") {
        setReferenceImages((current) => [...current, storedDrawing]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("草图已加入参考图，请描述希望生成的完整画面");
        return;
      }

      const source = await buildReferenceImageFromStoredImage(
        drawingDialog.image,
        `annotated-source-${Date.now()}.png`,
      );
      if (!source) {
        throw new Error("无法读取要标注编辑的图片");
      }
      setSelectedConversationId(drawingDialog.conversationId);
      setReferenceImages([source.referenceImage]);
      setMaskImages([storedDrawing]);
      setImagePrompt("");
      textareaRef.current?.focus();
      toast.success("标注区域已应用，请描述需要如何修改");
    },
    [drawingDialog],
  );

  const handleReuseTurnConfig = useCallback(async (conversationId: string, turnId: string) => {
    const conversation = hydratedConversationsRef.current.get(conversationId) ?? null;
    const turn = conversation?.turns.find((item) => item.id === turnId);
    if (!conversation || !turn || !turn.prompt.trim()) {
      return;
    }

    setSelectedConversationId(conversationId);
    setImagePrompt(turn.prompt);
    setImageCount(String(Math.max(1, turn.count || turn.images.length || 1)));
    setImageRatio(turn.ratio);
    setImageTier(turn.tier);
    const parsedSize = parseImageSize(turn.size);
    setImageWidth(parsedSize.width);
    setImageHeight(parsedSize.height);
    setImageQuality(turn.quality);
    setImageModel(turn.model);
    setReferenceImages(turn.referenceImages);
    setMaskImages(turn.maskImages);
    await updateConversation(conversationId, (current) => ({
      ...(current ?? conversation),
      model: turn.model,
      updatedAt: new Date().toISOString(),
    }));
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, [updateConversation]);

  const openLightbox = useCallback((group: ImageLightboxGroup) => {
    if (group.images.length === 0) {
      return;
    }

    setLightboxGroup({ turnId: group.turnId, kind: group.kind });
    setLightboxImages(group.images);
    setLightboxIndex(Math.max(0, Math.min(group.index, group.images.length - 1)));
    setLightboxOpen(true);
  }, []);

  // 灯箱上下切换：只落在同一会话里有同类图片的轮次上，跳过被删除或空的轮次
  const lightboxGroupTurns = useMemo(() => {
    if (!lightboxGroup || !selectedConversation) {
      return [];
    }
    return selectedConversation.turns.filter(
      (turn) => !turn.resultsDeleted && hasTurnLightboxImages(turn, lightboxGroup.kind),
    );
  }, [lightboxGroup, selectedConversation]);

  const lightboxGroupPosition = lightboxGroup
    ? lightboxGroupTurns.findIndex((turn) => turn.id === lightboxGroup.turnId)
    : -1;

  const lightboxTurnLabel = useMemo(() => {
    if (!lightboxGroup || !selectedConversation) {
      return undefined;
    }
    const index = selectedConversation.turns.findIndex((turn) => turn.id === lightboxGroup.turnId);
    return index < 0 ? undefined : `第 ${index + 1} / ${selectedConversation.turns.length} 轮`;
  }, [lightboxGroup, selectedConversation]);

  const goToAdjacentLightboxTurn = useCallback((direction: -1 | 1) => {
    if (!lightboxGroup || lightboxGroupPosition < 0) {
      return;
    }
    const target = lightboxGroupTurns[lightboxGroupPosition + direction];
    if (!target) {
      return;
    }
    const images = buildTurnLightboxImages(target, lightboxGroup.kind);
    if (images.length === 0) {
      return;
    }
    setLightboxGroup({ turnId: target.id, kind: lightboxGroup.kind });
    setLightboxImages(images);
    setLightboxIndex((current) => Math.min(current, images.length - 1));
  }, [lightboxGroup, lightboxGroupPosition, lightboxGroupTurns]);

  const createLoadingImages = (turnId: string, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const imageId = `${turnId}-${index}`;
      return {
        id: imageId,
        taskId: imageId,
        status: "loading" as const,
      };
    });

  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
        return;
      }

      const snapshot = hydratedConversationsRef.current.get(conversationId) ?? null;
      const pendingTurns = (snapshot?.turns ?? []).filter(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || pendingTurns.length === 0) {
        return;
      }

      activeConversationQueueIds.add(conversationId);
      const pendingTurnIdSet = new Set(pendingTurns.map((turn) => turn.id));
      const applyTasks = async (tasks: ImageTask[]) => {
        const taskMap = new Map(tasks.map((task) => [task.id, task]));
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          const turns = conversation.turns.map((turn) => {
            if (!pendingTurnIdSet.has(turn.id)) {
              return turn;
            }
            let turnChanged = false;
            const images = turn.images.map((image) => {
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              if (!task) {
                return image;
              }
              turnChanged = true;
              return taskDataToStoredImage({ ...image, taskId }, task);
            });
            if (!turnChanged) {
              return turn;
            }
            const derived = deriveTurnStatus({ ...turn, images });
            return {
              ...turn,
              ...derived,
              images,
            };
          });
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns,
          };
        });
      };

      const markImagesFailed = async (taskIds: string[], message: string) => {
        if (taskIds.length === 0) {
          return;
        }
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          const turns = conversation.turns.map((turn) => {
            if (!pendingTurnIdSet.has(turn.id)) {
              return turn;
            }
            let turnChanged = false;
            const images = turn.images.map((image) => {
              if (!taskIds.includes(image.taskId || image.id)) {
                return image;
              }
              turnChanged = true;
              return { ...image, status: "error" as const, error: message };
            });
            if (!turnChanged) {
              return turn;
            }
            const derived = deriveTurnStatus({ ...turn, images });
            return { ...turn, ...derived, images };
          });
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns,
          };
        });
      };

      const submitPendingBatch = async (turns: ImageTurn[], missingTaskIds?: string[]) => {
        const items: ImageBatchTaskItem[] = [];
        for (const turn of turns) {
          const images = turn.images.filter(
            (image) =>
              image.status === "loading" &&
              (!missingTaskIds || (image.taskId ? missingTaskIds.includes(image.taskId) : false)),
          );
          if (images.length === 0) {
            continue;
          }
          let referenceUrls: string[] = [];
          let maskUrls: string[] = [];
          if (turn.mode === "edit") {
            try {
              const [references, masks] = await Promise.all([
                uploadReferenceImages(turn.referenceImages),
                uploadReferenceImages(turn.maskImages),
              ]);
              referenceUrls = references.flatMap((image) => (image.url ? [image.url] : []));
              maskUrls = masks.flatMap((image) => (image.url ? [image.url] : []));
            } catch (error) {
              const message = error instanceof Error ? error.message : "参考图上传失败";
              await markImagesFailed(images.map((image) => image.taskId || image.id), message);
              toast.error(`参考图上传失败：${message}`);
              continue;
            }
          }
          for (const image of images) {
            items.push({
              client_task_id: image.taskId || image.id,
              mode: turn.mode,
              prompt: turn.prompt,
              model: turn.model,
              size: turn.size,
              quality: turn.quality,
              reference_urls: referenceUrls,
              mask_urls: maskUrls,
            });
          }
        }
        const batchSize = 100;
        for (let start = 0; start < items.length; start += batchSize) {
          const chunk = items.slice(start, start + batchSize);
          try {
            await submitImageTaskBatch(chunk);
          } catch (error) {
            const message = error instanceof Error ? error.message : "任务提交失败";
            await markImagesFailed(chunk.map((item) => item.client_task_id), message);
            toast.error(`任务提交失败：${message}`);
          }
        }
      };

      try {
        await submitPendingBatch(pendingTurns);

        let consecutiveErrors = 0;
        let pollErrorNotified = false;
        while (true) {
          const latestConversation = hydratedConversationsRef.current.get(conversationId) ?? null;
          const latestTurns = (latestConversation?.turns ?? []).filter((turn) => pendingTurnIdSet.has(turn.id));
          const loadingTaskIds = Array.from(
            new Set(
              latestTurns.flatMap((turn) =>
                turn.images.flatMap((image) =>
                  image.status === "loading" && image.taskId ? [image.taskId] : [],
                ),
              ),
            ),
          );
          if (loadingTaskIds.length === 0) {
            break;
          }

          const waitMs = consecutiveErrors >= TASK_POLL_SLOW_RETRY_AFTER
            ? TASK_POLL_SLOW_RETRY_DELAY_MS
            : TASK_POLL_INTERVAL_MS;
          await sleep(waitMs);
          try {
            const taskList = await fetchImageTasks(loadingTaskIds);
            consecutiveErrors = 0;
            pollErrorNotified = false;
            if (taskList.items.length > 0) {
              await applyTasks(taskList.items);
            }
            if (taskList.missing_ids.length > 0) {
              await submitPendingBatch(latestTurns, taskList.missing_ids);
            }
          } catch (pollError) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= TASK_POLL_GIVE_UP_AFTER) {
              throw pollError;
            }
            if (!pollErrorNotified) {
              pollErrorNotified = true;
              toast.error("图片状态同步失败，正在自动重试…");
            }
          }
        }

        await loadQuota();
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成图片失败";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) => {
              if (!pendingTurnIdSet.has(turn.id)) {
                return turn;
              }
              const images = turn.images.map((image) =>
                image.status === "loading" ? { ...image, status: "error" as const, error: message } : image,
              );
              const derived = deriveTurnStatus({ ...turn, images });
              return { ...turn, ...derived, images };
            }),
          };
        });
        toast.error(message);
      } finally {
        activeConversationQueueIds.delete(conversationId);
        for (const summary of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(summary.id) &&
            summary.stats.queued + summary.stats.running > 0
          ) {
            void hydrateConversation(summary.id).then((conversation) => {
              if (conversation) {
                void runConversationQueue(summary.id);
              }
            });
          }
        }
      }
    },
    [loadQuota, updateConversation],
  );

  const handleRegenerateTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      const conversation = hydratedConversationsRef.current.get(conversationId) ?? null;
      const sourceTurn = conversation?.turns.find((turn) => turn.id === turnId);
      if (!conversation || !sourceTurn || !sourceTurn.prompt.trim()) {
        return;
      }

      const now = new Date().toISOString();
      const nextTurnId = createId();
      const count = Math.max(1, sourceTurn.count || sourceTurn.images.length || 1);
      const nextTurn: ImageTurn = {
        id: nextTurnId,
        prompt: sourceTurn.prompt,
        model: sourceTurn.model,
        mode: sourceTurn.mode,
        referenceImages: sourceTurn.referenceImages,
        maskImages: sourceTurn.maskImages,
        count,
        size: sourceTurn.size,
        ratio: sourceTurn.ratio,
        tier: sourceTurn.tier,
        quality: sourceTurn.quality,
        images: createLoadingImages(nextTurnId, count),
        createdAt: now,
        status: "queued",
      };
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: [...conversation.turns, nextTurn],
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
      toast.success("已加入重新生成队列");
    },
    [runConversationQueue],
  );

  const handleBatchRegenerate = useCallback(
    async (conversationId: string, turnIds: string[]) => {
      const conversation = hydratedConversationsRef.current.get(conversationId) ?? null;
      if (!conversation) {
        return;
      }
      const selectedIds = new Set(turnIds);
      const sourceTurns = conversation.turns.filter(
        (turn) => selectedIds.has(turn.id) && Boolean(turn.prompt.trim()),
      );
      if (sourceTurns.length === 0) {
        return;
      }

      const now = new Date().toISOString();
      const nextTurns: ImageTurn[] = sourceTurns.map((sourceTurn) => {
        const nextTurnId = createId();
        const count = Math.max(1, sourceTurn.count || sourceTurn.images.length || 1);
        return {
          id: nextTurnId,
          prompt: sourceTurn.prompt,
          model: sourceTurn.model,
          mode: sourceTurn.mode,
          referenceImages: sourceTurn.referenceImages,
          maskImages: sourceTurn.maskImages,
          count,
          size: sourceTurn.size,
          ratio: sourceTurn.ratio,
          tier: sourceTurn.tier,
          quality: sourceTurn.quality,
          images: createLoadingImages(nextTurnId, count),
          createdAt: now,
          status: "queued",
        };
      });

      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: [...conversation.turns, ...nextTurns],
      };

      // 一次性写入全部新轮次，再触发一次队列，避免逐条保存 + 多次入队
      shouldStickToBottomRef.current = true;
      const btn = scrollToLatestBtnRef.current;
      if (btn) btn.style.display = "none";
      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
      toast.success(`已加入 ${nextTurns.length} 个重新生成任务`);
    },
    [runConversationQueue],
  );

  const handleRetryImage = useCallback(
    async (conversationId: string, turnId: string, imageId: string) => {
      const conversation = hydratedConversationsRef.current.get(conversationId) ?? null;
      if (!conversation) {
        return;
      }
      const replacedImage = conversation.turns
        .find((turn) => turn.id === turnId)
        ?.images.find((image) => image.id === imageId);

      const now = new Date().toISOString();
      const retryImageId = `${turnId}-${createId()}`;
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: conversation.turns.map((turn) => {
          if (turn.id !== turnId) {
            return turn;
          }
          if (!turn.prompt.trim()) {
            return turn;
          }

          const images = turn.images.map((image) =>
            image.id === imageId
              ? {
                  id: retryImageId,
                  taskId: retryImageId,
                  status: "loading" as const,
                }
              : image,
          );
          const derived = deriveTurnStatus({ ...turn, status: "queued", images });
          return {
            ...turn,
            ...derived,
            images,
          };
        }),
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      await deleteCachedImageSources([replacedImage?.url]);
      void runConversationQueue(conversationId);
    },
    [runConversationQueue],
  );

  const handleTimeoutRetryContinue = useCallback(
    async (taskId: string) => {
      let holder: { conversationId: string } | null = null;
      for (const [id, conversation] of hydratedConversationsRef.current) {
        if (conversation.turns.some((turn) => turn.images.some((image) => image.taskId === taskId))) {
          holder = { conversationId: id };
          break;
        }
      }
      if (!holder) {
        toast.error("未找到对应的生成任务");
        return;
      }
      const { conversationId } = holder;
      try {
        await resumeImagePoll(taskId, imageTimeoutRetrySecs);
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? hydratedConversationsRef.current.get(conversationId) ?? null;
          if (!conversation) return current!;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) => {
              if (!turn.images.some((image) => image.taskId === taskId)) {
                return turn;
              }
              const images = turn.images.map((image) =>
                image.taskId === taskId
                  ? { ...image, status: "loading" as const, error: undefined, taskStatus: "running" as const, startTime: image.startTime || Date.now() }
                  : image,
              );
              const derived = deriveTurnStatus({ ...turn, images });
              return { ...turn, ...derived, images };
            }),
          };
        });
        // 续等后把该任务重新纳入全局轮询
        void runConversationQueue(conversationId);
        toast.info(`已继续等待 ${imageTimeoutRetrySecs} 秒`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "续轮询失败";
        toast.error(msg);
      }
    },
    [runConversationQueue, imageTimeoutRetrySecs, updateConversation],
  );

  const handleDismissErrors = useCallback(
    async (conversationId: string, turnId: string) => {
      await updateConversation(conversationId, (current) => {
        const conversation = current ?? hydratedConversationsRef.current.get(conversationId) ?? null;
        if (!conversation) return current!;
        return {
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((turn) => {
            if (turn.id !== turnId) return turn;
            const successImages = turn.images.filter((image) => image.status !== "error");
            const derived = deriveTurnStatus({ ...turn, images: successImages });
            return {
              ...turn,
              ...derived,
              count: successImages.length,
              images: successImages,
            };
          }),
        };
      });
    },
    [updateConversation],
  );

  useEffect(() => {
    for (const summary of conversations) {
      if (
        !activeConversationQueueIds.has(summary.id) &&
        summary.stats.queued + summary.stats.running > 0
      ) {
        void hydrateConversation(summary.id).then((conversation) => {
          if (conversation) {
            void runConversationQueue(summary.id);
          }
        });
      }
    }
  }, [conversations, runConversationQueue, hydrateConversation]);

  const executeBatch = async (batch: PendingBatch) => {
    const now = new Date().toISOString();
    let resolvedReferences = batch.referenceImages;
    let resolvedMasks = batch.maskImages;
    if (batch.mode === "edit") {
      try {
        resolvedReferences = await uploadReferenceImages(batch.referenceImages);
        resolvedMasks = await uploadReferenceImages(batch.maskImages);
      } catch (error) {
        const message = error instanceof Error ? error.message : "参考图上传失败";
        toast.error(`参考图上传失败：${message}`);
        return;
      }
    }
    const draftTurns: ImageTurn[] = batch.prompts.map((prompt) => {
      const turnId = createId();
      return {
        id: turnId,
        prompt,
        model: batch.model,
        mode: batch.mode,
        referenceImages: resolvedReferences,
        maskImages: resolvedMasks,
        count: batch.count,
        size: batch.size,
        ratio: batch.ratio,
        tier: batch.tier,
        quality: batch.quality,
        images: createLoadingImages(turnId, batch.count),
        createdAt: now,
        status: "queued",
      };
    });
    const targetConversation =
      hydratedConversationsRef.current.get(batch.conversationId) ?? batch.targetConversation;
    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          model: targetConversation.model || batch.model,
          updatedAt: now,
          turns: [...targetConversation.turns, ...draftTurns],
        }
      : {
          id: batch.conversationId,
          title: buildConversationTitle(batch.prompts[0] ?? ""),
          model: batch.model,
          createdAt: now,
          updatedAt: now,
          turns: draftTurns,
        };

    shouldStickToBottomRef.current = true;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    setSelectedConversationId(batch.conversationId);
    clearComposerInputs();
    setPendingBatch(null);

    await persistConversation(baseConversation);
    void runConversationQueue(batch.conversationId);
    toast.success(`已拆分为 ${batch.prompts.length} 个任务，共 ${batch.prompts.length * batch.count} 张图`);
  };

  const handleSubmit = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    const prompts = splitBatchPrompts(prompt);
    if (prompts.length === 0) {
      toast.error("请输入提示词");
      return;
    }

    const effectiveImageMode: ImageConversationMode = referenceImages.length > 0 ? "edit" : "generate";

    let targetConversation = selectedConversationId
      ? hydratedConversationsRef.current.get(selectedConversationId) ?? null
      : null;
    if (selectedConversationId && !targetConversation) {
      targetConversation = await hydrateConversation(selectedConversationId);
    }
    if (selectedConversationId && !targetConversation) {
      toast.error("当前会话读取失败，请重试后再发送");
      return;
    }

    const imageSize = `${imageWidth || 1024}x${imageHeight || 1024}`;
    if (prompts.length > 1) {
      setPendingBatch({
        prompts,
        count: parsedCount,
        model: targetConversation?.model || imageModel,
        mode: effectiveImageMode,
        size: imageSize,
        ratio: imageRatio,
        tier: imageTier,
        quality: imageQuality,
        referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
        maskImages: effectiveImageMode === "edit" ? maskImages : [],
        conversationId: targetConversation?.id ?? createId(),
        targetConversation,
      });
      return;
    }

    let resolvedReferences: StoredReferenceImage[] = [];
    let resolvedMasks: StoredReferenceImage[] = [];
    if (effectiveImageMode === "edit") {
      try {
        resolvedReferences = await uploadReferenceImages(referenceImages);
        resolvedMasks = await uploadReferenceImages(maskImages);
      } catch (error) {
        const message = error instanceof Error ? error.message : "参考图上传失败";
        toast.error(`参考图上传失败：${message}`);
        return;
      }
    }

    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const singlePrompt = prompts[0] ?? prompt;
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt: singlePrompt,
      model: targetConversation?.model || imageModel,
      mode: effectiveImageMode,
      referenceImages: resolvedReferences,
      maskImages: resolvedMasks,
      count: parsedCount,
      size: imageSize,
      ratio: imageRatio,
      tier: imageTier,
      quality: imageQuality,
      images: createLoadingImages(turnId, parsedCount),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          model: targetConversation.model || imageModel,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(singlePrompt),
          model: imageModel,
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
      };

    shouldStickToBottomRef.current = true;
    const btn = scrollToLatestBtnRef.current;
    if (btn) btn.style.display = "none";
    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    void runConversationQueue(conversationId);

    const targetStats = getImageConversationStats(baseConversation);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入当前对话队列");
    } else if (!targetConversation) {
      toast.success("已创建新对话并开始处理");
    } else {
      toast.success("已发送到当前对话");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-6.5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5.25rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            onRenameConversation={handleRenameConversation}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                onRenameConversation={handleRenameConversation}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex min-h-0 flex-col gap-2 sm:gap-4">
          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-2xl border-stone-200 bg-white/90 text-stone-700 shadow-sm"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-2 size-4" />
              历史记录 ({conversations.length})
            </Button>
            <Button
              className="h-10 rounded-2xl bg-stone-950 text-white shadow-sm"
              onClick={handleCreateDraft}
            >
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-2xl border-stone-200 bg-white/85 px-3 text-stone-600 shadow-sm"
              onClick={openClearHistoryConfirm}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              ref={resultsViewportRef}
              onScroll={handleResultsScroll}
              className="hide-scrollbar h-full overscroll-contain overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
              style={{ contain: "layout style paint" }}
            >
              {isConversationLoading && selectedConversationId ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-stone-500">
                  <LoaderCircle className="size-4 animate-spin" />
                  正在读取会话…
                </div>
              ) : (
                <ImageResults
                  selectedConversation={selectedConversation}
                  onOpenLightbox={openLightbox}
                  onContinueEdit={handleContinueEdit}
                  onAnnotateImage={handleAnnotateImage}
                  onDeletePrompt={openDeletePromptConfirm}
                  onDeleteResults={openDeleteResultsConfirm}
                  onReuseTurnConfig={handleReuseTurnConfig}
                  onRegenerateTurn={handleRegenerateTurn}
                  onBatchRegenerate={handleBatchRegenerate}
                  onRetryImage={handleRetryImage}
                  onTimeoutRetryContinue={handleTimeoutRetryContinue}
                  onDismissErrors={handleDismissErrors}
                  formatConversationTime={formatConversationTime}
                />
              )}
            </div>

            <button
              ref={scrollToLatestBtnRef}
              type="button"
              aria-label="滚动到最新消息"
              title="滚动到最新消息"
              onClick={() => scrollResultsToLatest("smooth")}
              className="absolute bottom-4 left-1/2 z-20 inline-flex size-11 -translate-x-1/2 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-700 shadow-lg shadow-stone-200/60 backdrop-blur transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:border-white/10 dark:bg-stone-800/95 dark:text-stone-100 dark:shadow-black/40 dark:hover:bg-stone-700"
              style={{ display: "none" }}
            >
              <ArrowDown className="size-5" />
            </button>
          </div>

          <ImageComposer
            prompt={imagePrompt}
            imageCount={imageCount}
            imageRatio={imageRatio}
            imageTier={imageTier}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            imageQuality={imageQuality}
            imageModel={imageModel}
            imageModels={imageModels}
            availableQuota={availableQuota}
            activeTaskCount={activeTaskCount}
            referenceImages={referenceImages}
            maskImages={maskImages}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onPromptChange={setImagePrompt}
            onImageCountChange={(value) => setImageCount(value ? clampImageCount(value) : "")}
            onImageRatioChange={setImageRatio}
            onImageTierChange={setImageTier}
            onImageWidthChange={setImageWidth}
            onImageHeightChange={setImageHeight}
            onImageQualityChange={setImageQuality}
            onImageModelChange={(model) => void handleConversationModelChange(model)}
            onSubmit={handleSubmit}
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
            onOpenSketch={() => setDrawingDialog({ mode: "sketch" })}
          />
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
        hasPreviousGroup={lightboxGroupPosition > 0}
        hasNextGroup={lightboxGroupPosition >= 0 && lightboxGroupPosition < lightboxGroupTurns.length - 1}
        onPreviousGroup={() => goToAdjacentLightboxTurn(-1)}
        onNextGroup={() => goToAdjacentLightboxTurn(1)}
        groupLabel={lightboxGroupTurns.length > 1 ? lightboxTurnLabel : undefined}
      />

      <ImageDrawingDialog
        mode={drawingDialog?.mode || "sketch"}
        open={drawingDialog !== null}
        source={drawingDialog?.mode === "annotate" ? drawingDialog.source : undefined}
        onOpenChange={(open) => {
          if (!open) setDrawingDialog(null);
        }}
        onApply={handleApplyDrawing}
      />

      {pendingBatch ? (
        <Dialog open onOpenChange={(open) => (!open ? setPendingBatch(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>批量生成确认</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                将生成 {pendingBatch.prompts.length} 个任务，共 {pendingBatchImageCount} 张图。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[42vh] space-y-1 overflow-y-auto rounded-xl bg-stone-50 p-3 text-sm leading-6 text-stone-700 dark:bg-white/5 dark:text-stone-300">
              {pendingBatch.prompts.map((item, index) => (
                <div key={index} className="truncate" title={item}>
                  {index + 1}. {item}
                </div>
              ))}
            </div>
            {pendingBatchOverLimit ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                任务或图片数量较多（建议不超过 {BATCH_SOFT_LIMIT_PROMPTS} 个任务 / {BATCH_SOFT_LIMIT_IMAGES} 张图），将消耗较多额度。
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingBatch(null)}>
                取消
              </Button>
              <Button onClick={() => pendingBatch && void executeBatch(pendingBatch)}>开始生成</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}


    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent isAdmin={session.role === "admin"} />;
}
