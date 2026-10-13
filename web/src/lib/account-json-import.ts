import type { AccountImportPayload } from "./api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sub2API 导出的账号把凭据放在 `credentials` 里，账号级信息放在外层或 `extra`。
 * 这里把它摊平成号池导入需要的字段，忽略 platform、type="oauth"、concurrency 等
 * 与号池无关的字段，避免把 `type="oauth"` 误当套餐类型。
 */
function flattenSub2ApiAccount(raw: Record<string, unknown>): Record<string, unknown> | null {
  const credentials = raw.credentials;
  if (!isRecord(credentials)) {
    return null;
  }
  const accessToken = pickString(credentials.access_token);
  if (!accessToken) {
    return null;
  }
  const extra = isRecord(raw.extra) ? raw.extra : {};
  const flattened: Record<string, unknown> = { access_token: accessToken };
  const assign = (key: string, value: string) => {
    if (value) {
      flattened[key] = value;
    }
  };
  assign("refresh_token", pickString(credentials.refresh_token));
  assign("id_token", pickString(credentials.id_token));
  assign(
    "email",
    pickString(credentials.email) || pickString(extra.email) || pickString(raw.name),
  );
  assign(
    "account_id",
    pickString(credentials.chatgpt_account_id) || pickString(credentials.organization_id),
  );
  assign("user_id", pickString(credentials.chatgpt_user_id));
  assign("type", pickString(credentials.plan_type) || pickString(extra.plan_type));
  flattened.export_type = "codex";
  flattened.source_type = "codex";
  return flattened;
}

export function getAccountJsonAccount(value: unknown): AccountImportPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const normalized = flattenSub2ApiAccount(value) ?? value;
  const token = pickString(normalized.access_token) || pickString(normalized.accessToken);
  if (!token) {
    return null;
  }

  const payload: AccountImportPayload = {
    ...normalized,
    access_token: token,
    source_type: "codex",
  };
  delete payload.accessToken;
  if (payload.type === "codex") {
    payload.export_type = "codex";
    delete payload.type;
  }
  return payload;
}

export function getAccountJsonAccounts(value: unknown): AccountImportPayload[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => getAccountJsonAccount(item))
      .filter((item): item is AccountImportPayload => Boolean(item));
  }

  const singleAccount = getAccountJsonAccount(value);
  if (singleAccount) {
    return [singleAccount];
  }

  if (isRecord(value)) {
    const nested = value.accounts ?? value.items;
    if (Array.isArray(nested)) {
      return nested
        .map((item) => getAccountJsonAccount(item))
        .filter((item): item is AccountImportPayload => Boolean(item));
    }
  }

  return [];
}
