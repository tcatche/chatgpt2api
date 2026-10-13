"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, ServerCog } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchImageTasks, type ImageTask } from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageTaskHistoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const STATUS_LABEL: Record<ImageTask["status"], string> = {
  queued: "排队中",
  running: "生成中",
  success: "成功",
  error: "失败",
};

function statusClass(status: ImageTask["status"]) {
  switch (status) {
    case "success":
      return "bg-emerald-50 text-emerald-600";
    case "error":
      return "bg-rose-50 text-rose-600";
    case "running":
      return "bg-blue-50 text-blue-600";
    default:
      return "bg-amber-50 text-amber-700";
  }
}

function taskImageSources(task: ImageTask): string[] {
  return (task.data || []).flatMap((item) => {
    if (item.b64_json) {
      return [`data:image/png;base64,${item.b64_json}`];
    }
    return item.url ? [item.url] : [];
  });
}

export function ImageTaskHistoryDialog({ open, onOpenChange }: ImageTaskHistoryDialogProps) {
  const [tasks, setTasks] = useState<ImageTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchImageTasks([]);
      setTasks(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取服务端历史失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(84dvh,780px)] w-[94vw] max-w-[720px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
        <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <ServerCog className="size-5" />
            服务端生图历史
          </DialogTitle>
          <DialogDescription className="text-sm leading-6">
            读取当前账号在服务端保存的图片任务（含提示词、参数与结果），换设备也能看到。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-stone-500">{loading ? "读取中…" : `共 ${tasks.length} 条`}</span>
            <Button
              variant="outline"
              className="h-8 rounded-lg px-3 text-xs"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? (
                <LoaderCircle className="mr-1 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 size-3.5" />
              )}
              刷新
            </Button>
          </div>
          {error ? (
            <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>
          ) : !loading && tasks.length === 0 ? (
            <div className="px-1 py-6 text-sm leading-6 text-stone-500">服务端还没有生图任务记录。</div>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => {
                const sources = taskImageSources(task);
                return (
                  <div key={task.id} className="rounded-2xl border border-stone-200/80 bg-white/70 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p
                        className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-800"
                        title={task.prompt || ""}
                      >
                        {task.prompt || "（无提示词）"}
                      </p>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px]", statusClass(task.status))}>
                        {STATUS_LABEL[task.status]}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-500">
                      <span>{task.mode === "edit" ? "图生图" : "文生图"}</span>
                      {task.model ? <span>{task.model}</span> : null}
                      {task.size ? <span>{task.size}</span> : null}
                      {task.quality ? <span>{task.quality}</span> : null}
                      <span>{task.created_at}</span>
                    </div>
                    {task.error ? (
                      <p className="mt-2 line-clamp-2 text-xs text-rose-500">{task.error}</p>
                    ) : null}
                    {sources.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {sources.map((src, index) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={`${task.id}-${index}`}
                            src={src}
                            alt={task.prompt || "生成结果"}
                            loading="lazy"
                            className="size-20 rounded-xl border border-stone-200 object-cover"
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
