"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, LoaderCircle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurn } from "@/store/image-conversations";

type ExportOption = {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  count: (conversation: ImageConversation) => number;
  build: (conversation: ImageConversation) => { filename: string; content: string; mime: string };
};

function fileTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function conversationFileStem(conversation: ImageConversation) {
  const title = conversation.title.trim() || conversation.id;
  return title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40);
}

function exportFilename(conversation: ImageConversation, suffix: string) {
  return `${conversationFileStem(conversation)}-${fileTimestamp()}-${suffix}`;
}

function collectSuccessUrls(conversation: ImageConversation) {
  const urls: string[] = [];
  for (const turn of conversation.turns) {
    for (const image of turn.images) {
      if (image.status === "success" && image.url) {
        urls.push(image.url);
      }
    }
  }
  return Array.from(new Set(urls));
}

function collectFailedImages(conversation: ImageConversation) {
  const failed: Array<Record<string, unknown>> = [];
  conversation.turns.forEach((turn, turnIndex) => {
    turn.images.forEach((image, imageIndex) => {
      if (image.status !== "error") return;
      failed.push({
        conversation_id: conversation.id,
        conversation_title: conversation.title,
        turn_index: turnIndex + 1,
        turn_id: turn.id,
        image_index: imageIndex + 1,
        image_id: image.id,
        task_id: image.taskId,
        error: image.error,
        prompt: turn.prompt,
        model: turn.model,
        mode: turn.mode,
        size: turn.size,
        quality: turn.quality,
        created_at: turn.createdAt,
      });
    });
  });
  return failed;
}

function collectFailedPrompts(conversation: ImageConversation) {
  const prompts: string[] = [];
  for (const turn of conversation.turns) {
    if (turn.prompt.trim() && turn.images.some((image) => image.status === "error")) {
      prompts.push(turn.prompt.trim());
    }
  }
  return Array.from(new Set(prompts));
}

const EXPORT_OPTIONS: ExportOption[] = [
  {
    key: "urls",
    label: "导出图片地址",
    description: "本会话全部成功图片的 URL，txt 一行一个",
    icon: <Download className="size-3.5" />,
    count: (conversation) => collectSuccessUrls(conversation).length,
    build: (conversation) => ({
      filename: exportFilename(conversation, "图片地址.txt"),
      content: `${collectSuccessUrls(conversation).join("\n")}\n`,
      mime: "text/plain",
    }),
  },
  {
    key: "conversation",
    label: "导出会话文件",
    description: "整个会话的 JSON，可用于备份或迁移",
    icon: <Download className="size-3.5" />,
    count: (conversation) => conversation.turns.length,
    build: (conversation) => ({
      filename: exportFilename(conversation, "会话.json"),
      content: `${JSON.stringify(conversation, null, 2)}\n`,
      mime: "application/json",
    }),
  },
  {
    key: "failed",
    label: "导出失败任务",
    description: "失败图片的 JSON，含错误原因与提示词",
    icon: <Download className="size-3.5" />,
    count: (conversation) => collectFailedImages(conversation).length,
    build: (conversation) => ({
      filename: exportFilename(conversation, "失败任务.json"),
      content: `${JSON.stringify(collectFailedImages(conversation), null, 2)}\n`,
      mime: "application/json",
    }),
  },
  {
    key: "failed-prompts",
    label: "导出失败提示词",
    description: "出现失败图片的提示词，txt 一行一条",
    icon: <Download className="size-3.5" />,
    count: (conversation) => collectFailedPrompts(conversation).length,
    build: (conversation) => ({
      filename: exportFilename(conversation, "失败提示词.txt"),
      content: `${collectFailedPrompts(conversation).join("\n")}\n`,
      mime: "text/plain",
    }),
  },
];

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function turnStatusLabel(status: ImageTurn["status"]) {
  if (status === "queued") return "排队中";
  if (status === "generating") return "处理中";
  if (status === "success") return "已完成";
  return "失败";
}

export type ConversationToolbarProps = {
  conversation: ImageConversation | null;
  onBatchRegenerate: (conversationId: string, turnIds: string[]) => void | Promise<void>;
  onBatchRegenerateErrors: (conversationId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
  className?: string;
};

export function ConversationToolbar({
  conversation,
  onBatchRegenerate,
  onBatchRegenerateErrors,
  formatConversationTime,
  className,
}: ConversationToolbarProps) {
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  useEffect(() => {
    if (!batchOpen) return;
    setBatchSelection((current) =>
      current.filter((id) => conversation?.turns.some((turn) => turn.id === id) ?? false),
    );
  }, [batchOpen, conversation]);

  if (!conversation) {
    return null;
  }

  const regenerableTurns = conversation.turns.filter(
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
  // 只统计「有提示词的轮次里失败的单张图」，用于批量重跑错误图
  const errorImageCount = conversation.turns.reduce(
    (sum, turn) =>
      sum + (turn.prompt.trim() ? turn.images.filter((image) => image.status === "error").length : 0),
    0,
  );

  const toggleBatchTurn = (turnId: string, checked: boolean) => {
    setBatchSelection((current) =>
      checked ? Array.from(new Set([...current, turnId])) : current.filter((id) => id !== turnId),
    );
  };

  const handleExport = (option: ExportOption) => {
    const { filename, content, mime } = option.build(conversation);
    downloadTextFile(filename, content, mime);
  };

  const handleBatchRegenerateErrors = async () => {
    if (errorImageCount === 0) return;
    setBatchSubmitting(true);
    try {
      await onBatchRegenerateErrors(conversation.id);
      setBatchOpen(false);
      setBatchSelection([]);
    } finally {
      setBatchSubmitting(false);
    }
  };

  const handleBatchConfirm = async () => {
    if (selectedTurns.length === 0) return;
    setBatchSubmitting(true);
    try {
      await onBatchRegenerate(conversation.id, selectedTurns.map((turn) => turn.id));
      setBatchOpen(false);
      setBatchSelection([]);
    } finally {
      setBatchSubmitting(false);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-[10px] sm:text-[11px]", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto shrink-0 gap-1 rounded-full border-stone-200 bg-white px-2 py-1 text-[10px] font-medium text-stone-600 shadow-none hover:bg-stone-50 sm:px-2.5 sm:py-1.5 sm:text-[11px]"
            title="导出本会话"
          >
            <Download className="size-3" />
            <span className="hidden sm:inline">导出</span>
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-1.5">
          {EXPORT_OPTIONS.map((option) => {
            const count = option.count(conversation);
            const disabled = count === 0;
            return (
              <button
                key={option.key}
                type="button"
                disabled={disabled}
                onClick={() => handleExport(option)}
                className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
              >
                <span className="mt-0.5 text-stone-400">{option.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-stone-800">
                    {option.label}
                    {disabled ? null : <span className="ml-1 text-stone-400">（{count}）</span>}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-stone-400">{option.description}</span>
                </span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-auto shrink-0 gap-1 rounded-full border-stone-200 bg-white px-2 py-1 text-[10px] font-medium text-stone-600 shadow-none hover:bg-stone-50 sm:px-2.5 sm:py-1.5 sm:text-[11px]"
        title={regenerableIds.length === 0 ? "当前没有可重新生成的轮次（都还在生成中或没有提示词）" : "批量重新生成"}
        onClick={() => {
          setBatchSelection([]);
          setBatchOpen(true);
        }}
      >
        <RotateCcw className="size-3" />
        <span className="hidden sm:inline">批量重新生成</span>
      </Button>

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
            {conversation.turns.map((turn, turnIndex) => {
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
                      <span>{turnStatusLabel(turn.status)}</span>
                      {hasError ? <span className="text-rose-500">有失败图</span> : null}
                      <span>{turn.model}</span>
                      <span>{imageCount} 张</span>
                      <span>{formatConversationTime(turn.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-stone-700 dark:text-stone-200" title={turn.prompt || "（无提示词）"}>
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
              variant="outline"
              title="只把失败的图片重新提交，已有的成功结果保持不变"
              disabled={errorImageCount === 0 || batchSubmitting}
              onClick={() => void handleBatchRegenerateErrors()}
            >
              重试出错图片{errorImageCount > 0 ? `（${errorImageCount}）` : ""}
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
