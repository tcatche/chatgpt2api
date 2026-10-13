const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/account-json-import.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const moduleRef = { exports: {} };
const requireModule = (name) => (name === "./api" ? {} : require(name));
new Function("require", "module", "exports", compiled)(requireModule, moduleRef, moduleRef.exports);
const { getAccountJsonAccount, getAccountJsonAccounts } = moduleRef.exports;

const sub2apiExport = {
  exported_at: "2026-10-13T01:41:16Z",
  proxies: [],
  accounts: [
    {
      name: "nyvmzq22071@outlook.com",
      platform: "openai",
      type: "oauth",
      credentials: {
        access_token: "sub2api-access-token",
        refresh_token: "rt.sub2api",
        id_token: "sub2api-id-token",
        email: "nyvmzq22071@outlook.com",
        chatgpt_account_id: "a9e917de-39ac-43f0-ae09-11d39cb22f2a",
        chatgpt_user_id: "user-THOlYIpHMO38j0RZlh6o3JV0",
        organization_id: "org-a6uKQr2XujM7TcOCvFXlPOUr",
        plan_type: "free",
        expires_at: "2026-10-14T07:34:33+08:00",
      },
      extra: { email: "nyvmzq22071@outlook.com" },
      concurrency: 10,
      priority: 1,
      rate_multiplier: 1,
      auto_pause_on_expired: true,
    },
  ],
};

test("sub2api export flattens credentials into import payloads", () => {
  const items = getAccountJsonAccounts(sub2apiExport);
  assert.equal(items.length, 1);
  const account = items[0];
  assert.equal(account.access_token, "sub2api-access-token");
  assert.equal(account.refresh_token, "rt.sub2api");
  assert.equal(account.id_token, "sub2api-id-token");
  assert.equal(account.email, "nyvmzq22071@outlook.com");
  assert.equal(account.account_id, "a9e917de-39ac-43f0-ae09-11d39cb22f2a");
  assert.equal(account.user_id, "user-THOlYIpHMO38j0RZlh6o3JV0");
  assert.equal(account.type, "free");
  assert.equal(account.export_type, "codex");
  assert.equal(account.source_type, "codex");
  assert.equal(account.credentials, undefined);
  assert.equal(account.concurrency, undefined);
});

test("sub2api account falls back to name for email and drops oauth type", () => {
  const items = getAccountJsonAccounts([
    { name: "a@b.com", platform: "openai", type: "oauth", credentials: { access_token: "t1" } },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, undefined);
  assert.equal(items[0].email, "a@b.com");
  assert.equal(items[0].export_type, "codex");
});

test("project export single account object is read as one account", () => {
  const items = getAccountJsonAccounts({ access_token: "own", type: "codex" });
  assert.equal(items.length, 1);
  assert.equal(items[0].access_token, "own");
  assert.equal(items[0].export_type, "codex");
  assert.equal(items[0].type, undefined);
});

test("project export array keeps every account", () => {
  const items = getAccountJsonAccounts([{ access_token: "a" }, { access_token: "b" }]);
  assert.equal(items.length, 2);
  assert.equal(items[0].source_type, "codex");
  assert.equal(items[1].access_token, "b");
});

test("cpa nested accounts are extracted", () => {
  const items = getAccountJsonAccounts({ accounts: [{ access_token: "cpa", type: "codex" }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].access_token, "cpa");
  assert.equal(items[0].export_type, "codex");
});

test("missing access token yields no accounts", () => {
  assert.equal(getAccountJsonAccounts({ foo: "bar" }).length, 0);
  assert.equal(getAccountJsonAccount({ credentials: { refresh_token: "rt" } }), null);
});
