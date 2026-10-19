"use client";

import type { ImageModel } from "@/lib/api";
import { httpRequest } from "@/lib/request";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl?: string;
  url?: string;
};

export type StoredImage = {
  id: string;
  taskId?: string;
  status?: "loading" | "success" | "error";
  taskStatus?: "queued" | "running";
  progress?: string;
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  error?: string;
  startTime?: number;
  elapsedSecs?: number;
  elapsedUpdatedAt?: number;
  durationMs?: number;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error";

export type ImageTurn = {
  id: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  maskImages: StoredReferenceImage[];
  count: number;
  size: string;
  ratio: string;
  tier: string;
  quality: string;
  images: StoredImage[];
  createdAt: string;
  status: ImageTurnStatus;
  error?: string;
  promptDeleted?: boolean;
  resultsDeleted?: boolean;
};

export type ImageConversation = {
  id: string;
  title: string;
  model: ImageModel;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

export type ImageConversationSummary = {
  id: string;
  title: string;
  model: ImageModel;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  stats: ImageConversationStats;
};

type ImageConversationSummaryResponse = {
  items: ImageConversationSummary[];
};

type ImageConversationResponse = {
  conversation: ImageConversation;
};

function normalizeSummary(item: ImageConversationSummary): ImageConversationSummary {
  return {
    id: String(item.id || ""),
    title: String(item.title || ""),
    model: (item.model as ImageModel) || "gpt-image-2",
    createdAt: String(item.createdAt || ""),
    updatedAt: String(item.updatedAt || ""),
    turnCount: Number(item.turnCount || 0),
    stats: {
      queued: Number(item.stats?.queued || 0),
      running: Number(item.stats?.running || 0),
    },
  };
}

type MutationAck = {
  ok: boolean;
  count?: number;
};

function normalizeStoredImage(image: StoredImage): StoredImage {
  const normalized = {
    ...image,
    taskId: typeof image.taskId === "string" && image.taskId ? image.taskId : undefined,
    taskStatus: image.taskStatus === "queued" || image.taskStatus === "running" ? image.taskStatus : undefined,
    url: typeof image.url === "string" && image.url ? image.url : undefined,
    revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
    startTime: typeof image.startTime === "number" ? image.startTime : undefined,
    elapsedSecs: typeof image.elapsedSecs === "number" ? image.elapsedSecs : undefined,
    elapsedUpdatedAt: typeof image.elapsedUpdatedAt === "number" ? image.elapsedUpdatedAt : undefined,
    durationMs: typeof image.durationMs === "number" ? image.durationMs : undefined,
  };
  if (image.status === "loading" || image.status === "error" || image.status === "success") {
    return normalized;
  }
  return {
    ...normalized,
    status: image.b64_json || image.url ? "success" : "loading",
  };
}

function normalizeReferenceImage(image: StoredReferenceImage): StoredReferenceImage {
  return {
    name: image.name || "reference.png",
    type: image.type || "image/png",
    dataUrl: typeof image.dataUrl === "string" && image.dataUrl ? image.dataUrl : undefined,
    url: typeof image.url === "string" && image.url ? image.url : undefined,
  };
}

function hasReferenceSource(image: StoredReferenceImage) {
  return Boolean(image.dataUrl || image.url);
}

function dataUrlMimeType(dataUrl: string) {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return match?.[1] || "image/png";
}

function getLegacyReferenceImages(source: Record<string, unknown>): StoredReferenceImage[] {
  if (Array.isArray(source.referenceImages)) {
    return source.referenceImages
      .filter((image): image is StoredReferenceImage => {
        if (!image || typeof image !== "object") {
          return false;
        }
        const candidate = image as StoredReferenceImage;
        return hasReferenceSource(candidate);
      })
      .map(normalizeReferenceImage);
  }

  if (source.sourceImage && typeof source.sourceImage === "object") {
    const image = source.sourceImage as { dataUrl?: unknown; fileName?: unknown };
    if (typeof image.dataUrl === "string" && image.dataUrl) {
      return [
        {
          name: typeof image.fileName === "string" && image.fileName ? image.fileName : "reference.png",
          type: dataUrlMimeType(image.dataUrl),
          dataUrl: image.dataUrl,
        },
      ];
    }
  }

  return [];
}

function normalizeTurn(turn: ImageTurn & Record<string, unknown>): ImageTurn {
  const normalizedImages = Array.isArray(turn.images) ? turn.images.map(normalizeStoredImage) : [];
  const derivedStatus: ImageTurnStatus =
    normalizedImages.some((image) => image.status === "loading")
      ? "generating"
      : normalizedImages.some((image) => image.status === "error")
        ? "error"
        : "success";

  return {
    id: String(turn.id || `${Date.now()}`),
    prompt: String(turn.prompt || ""),
    model: (turn.model as ImageModel) || "gpt-image-2",
    mode: turn.mode === "edit" ? "edit" : "generate",
    referenceImages: getLegacyReferenceImages(turn),
    maskImages: Array.isArray(turn.maskImages)
      ? turn.maskImages
          .filter((image): image is StoredReferenceImage => Boolean(image && hasReferenceSource(image)))
          .map(normalizeReferenceImage)
      : [],
    count: Math.max(1, Number(turn.count || normalizedImages.length || 1)),
    size: typeof turn.size === "string" ? turn.size : "",
    ratio: typeof turn.ratio === "string" && turn.ratio ? turn.ratio : "1:1",
    tier: typeof turn.tier === "string" && turn.tier ? turn.tier : "1k",
    quality: typeof turn.quality === "string" && turn.quality ? turn.quality : "auto",
    images: normalizedImages,
    createdAt: String(turn.createdAt || new Date().toISOString()),
    status:
      turn.status === "queued" ||
      turn.status === "generating" ||
      turn.status === "success" ||
      turn.status === "error"
        ? turn.status
        : derivedStatus,
    error: typeof turn.error === "string" ? turn.error : undefined,
    promptDeleted: turn.promptDeleted === true,
    resultsDeleted: turn.resultsDeleted === true,
  };
}

function normalizeConversation(conversation: ImageConversation & Record<string, unknown>): ImageConversation {
  const turns = Array.isArray(conversation.turns)
    ? conversation.turns.map((turn) => normalizeTurn(turn as ImageTurn & Record<string, unknown>))
    : [
        normalizeTurn({
          id: String(conversation.id || `${Date.now()}`),
          prompt: String(conversation.prompt || ""),
          model: (conversation.model as ImageModel) || "gpt-image-2",
          mode: conversation.mode === "edit" ? "edit" : "generate",
          referenceImages: getLegacyReferenceImages(conversation),
          maskImages: [],
          count: Number(conversation.count || 1),
          size: typeof conversation.size === "string" ? conversation.size : "",
          ratio: typeof conversation.ratio === "string" && conversation.ratio ? conversation.ratio : "1:1",
          tier: typeof conversation.tier === "string" && conversation.tier ? conversation.tier : "1k",
          quality: typeof conversation.quality === "string" && conversation.quality ? conversation.quality : "auto",
          images: Array.isArray(conversation.images) ? (conversation.images as StoredImage[]) : [],
          createdAt: String(conversation.createdAt || new Date().toISOString()),
          status:
            conversation.status === "generating" || conversation.status === "success" || conversation.status === "error"
              ? conversation.status
              : "success",
          error: typeof conversation.error === "string" ? conversation.error : undefined,
        }),
      ];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    id: String(conversation.id || `${Date.now()}`),
    title: String(conversation.title || ""),
    model: (conversation.model as ImageModel) || lastTurn?.model || "gpt-image-2",
    createdAt: String(conversation.createdAt || lastTurn?.createdAt || new Date().toISOString()),
    updatedAt: String(conversation.updatedAt || lastTurn?.createdAt || new Date().toISOString()),
    turns,
  };
}

function sortSummaries(summaries: ImageConversationSummary[]): ImageConversationSummary[] {
  return [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listImageConversations(): Promise<ImageConversationSummary[]> {
  const result = await httpRequest<ImageConversationSummaryResponse>("/api/image-conversations");
  return sortSummaries((result.items || []).map(normalizeSummary));
}

export async function getImageConversation(id: string): Promise<ImageConversation | null> {
  try {
    const result = await httpRequest<ImageConversationResponse>(
      `/api/image-conversations/${encodeURIComponent(id)}`,
    );
    return result.conversation ? normalizeConversation(result.conversation) : null;
  } catch {
    return null;
  }
}

export async function saveImageConversations(conversations: ImageConversation[]): Promise<void> {
  if (conversations.length === 0) {
    return;
  }
  await httpRequest<MutationAck>("/api/image-conversations", {
    method: "POST",
    body: { conversations },
  });
}

export async function saveImageConversation(conversation: ImageConversation): Promise<void> {
  await httpRequest<MutationAck>("/api/image-conversations", {
    method: "POST",
    body: { conversations: [conversation] },
  });
}

export async function renameImageConversation(id: string, title: string): Promise<void> {
  await httpRequest<MutationAck>(
    `/api/image-conversations/${encodeURIComponent(id)}/rename`,
    {
      method: "POST",
      body: { title },
    },
  );
}

export async function deleteImageConversation(id: string): Promise<void> {
  await httpRequest<MutationAck>(`/api/image-conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function clearImageConversations(): Promise<void> {
  await httpRequest<MutationAck>("/api/image-conversations", {
    method: "DELETE",
  });
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (!conversation) {
    return { queued: 0, running: 0 };
  }

  return conversation.turns.reduce(
    (acc, turn) => {
      if (turn.resultsDeleted) {
        return acc;
      }
      if (turn.status === "queued") {
        acc.queued += 1;
      } else if (turn.status === "generating") {
        acc.running += 1;
      }
      return acc;
    },
    { queued: 0, running: 0 },
  );
}
