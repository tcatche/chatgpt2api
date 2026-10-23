"use client";

import { Check, ChevronsUpDown, MessagesSquare, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ManagedImageConversation } from "@/lib/api";
import { cn } from "@/lib/utils";

export const UNLINKED_CONVERSATION_ID = "__unlinked__";

type ConversationCountField = "image_count" | "image_total";

type ConversationFilterProps = {
  conversations: ManagedImageConversation[];
  unlinkedCount: number;
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  countField?: ConversationCountField;
  placeholder?: string;
  disabled?: boolean;
  triggerClassName?: string;
};

export function conversationDisplayLabel(
  conversations: ManagedImageConversation[],
  value: string,
  fallback = "全部会话",
) {
  if (!value) {
    return fallback;
  }
  if (value === UNLINKED_CONVERSATION_ID) {
    return "未关联";
  }
  const matched = conversations.find((item) => item.id === value);
  return matched?.title || matched?.id || "未知会话";
}

export function ConversationFilter({
  conversations,
  unlinkedCount,
  value,
  onChange,
  includeAll = true,
  countField = "image_count",
  placeholder,
  disabled = false,
  triggerClassName,
}: ConversationFilterProps) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");

  const options = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return conversations
      .map((item) => ({
        id: item.id,
        label: item.title || "(无标题)",
        count: Number(item[countField] ?? 0),
      }))
      .filter((item) => !text || item.label.toLowerCase().includes(text));
  }, [conversations, countField, keyword]);

  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    setKeyword("");
  };

  const currentLabel = conversationDisplayLabel(conversations, value, placeholder ?? "全部会话");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setKeyword("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("h-10 max-w-[240px] justify-between gap-2 rounded-xl border-stone-200 bg-white px-3 text-stone-700", triggerClassName)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <MessagesSquare className="size-4 shrink-0 text-stone-400" />
            <span className="truncate">{currentLabel}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-stone-400" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-stone-400" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索会话标题"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {includeAll ? (
              <ConversationOption active={value === ""} label="全部会话" count={null} onSelect={() => select("")} />
            ) : null}
            <ConversationOption
              active={value === UNLINKED_CONVERSATION_ID}
              label="未关联"
              count={unlinkedCount}
              onSelect={() => select(UNLINKED_CONVERSATION_ID)}
            />
            {options.map((option) => (
              <ConversationOption
                key={option.id}
                active={value === option.id}
                label={option.label}
                count={option.count}
                onSelect={() => select(option.id)}
              />
            ))}
            {options.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-stone-400">没有匹配的会话</p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ConversationOption({
  active,
  label,
  count,
  onSelect,
}: {
  active: boolean;
  label: string;
  count: number | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition",
        active ? "bg-stone-100 text-stone-900" : "text-stone-600 hover:bg-stone-50",
      )}
    >
      <Check className={cn("size-3.5 shrink-0", active ? "text-stone-900" : "text-transparent")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== null ? (
        <Badge variant="secondary" className="shrink-0 rounded-md px-1.5 py-0 text-[10px]">
          {count}
        </Badge>
      ) : null}
    </button>
  );
}
