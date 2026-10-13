const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/image-cache.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

global.window = { location: { origin: "https://app.test", protocol: "https:", host: "app.test" } };
let objectUrlIndex = 0;
const revokedUrls = [];
URL.createObjectURL = () => `blob:cached-${++objectUrlIndex}`;
URL.revokeObjectURL = (url) => revokedUrls.push(url);

function loadImageCache(records, fetcher) {
  global.fetch = fetcher;
  const storage = {
    getItem: async (key) => records.get(key) ?? null,
    setItem: async (key, value) => {
      records.set(key, value);
      return value;
    },
    removeItem: async (key) => records.delete(key),
    clear: async () => records.clear(),
  };
  const module = { exports: {} };
  const requireModule = (name) => {
    if (name === "localforage") {
      return { __esModule: true, default: { createInstance: () => storage } };
    }
    return require(name);
  };
  new Function("require", "module", "exports", compiled)(requireModule, module, module.exports);
  return module.exports;
}

test("persistent cache serves a server image after a simulated page reload without another request", async () => {
  const records = new Map();
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return new Response(new Blob(["image-a"], { type: "image/png" }), { status: 200 });
  };

  const firstPage = loadImageCache(records, fetcher);
  const first = await firstPage.resolveCachedImage("/images/a.png");
  assert.equal(first.fromCache, false);
  assert.equal(fetchCount, 1);
  assert.equal(records.size, 1);

  const reloadedPage = loadImageCache(records, fetcher);
  const second = await reloadedPage.resolveCachedImage("/images/a.png");
  assert.equal(second.fromCache, true);
  assert.equal(fetchCount, 1);
  assert.match(second.src, /^blob:cached-/);
});

test("concurrent image consumers share one server request", async () => {
  const records = new Map();
  let fetchCount = 0;
  const cache = loadImageCache(records, async () => {
    fetchCount += 1;
    await Promise.resolve();
    return new Response(new Blob(["image-b"], { type: "image/png" }), { status: 200 });
  });

  const [thumbnail, lightbox] = await Promise.all([
    cache.resolveCachedImage("/images/b.png"),
    cache.resolveCachedImage("/images/b.png"),
  ]);
  assert.equal(fetchCount, 1);
  assert.equal(thumbnail.src, lightbox.src);
});

test("deleting an image removes its persistent entry and revokes its Blob URL", async () => {
  const records = new Map();
  const cache = loadImageCache(
    records,
    async () => new Response(new Blob(["image-c"], { type: "image/png" }), { status: 200 }),
  );
  const loaded = await cache.resolveCachedImage("/images/c.png");
  assert.equal(records.size, 1);

  await cache.deleteCachedImageSources(["/images/c.png"]);
  assert.equal(records.size, 0);
  assert.ok(revokedUrls.includes(loaded.src));
});

test("same-origin http image is upgraded to https on an https page", async () => {
  const records = new Map();
  const requested = [];
  const cache = loadImageCache(records, async (url) => {
    requested.push(url);
    return new Response(new Blob(["image-d"], { type: "image/png" }), { status: 200 });
  });
  await cache.resolveCachedImage("http://app.test/images/d.png");
  assert.equal(requested[0], "https://app.test/images/d.png");
});

test("cross-host http image keeps its scheme", async () => {
  const records = new Map();
  const requested = [];
  const cache = loadImageCache(records, async (url) => {
    requested.push(url);
    return new Response(new Blob(["image-e"], { type: "image/png" }), { status: 200 });
  });
  await cache.resolveCachedImage("http://cdn.other.test/images/e.png");
  assert.equal(requested[0], "http://cdn.other.test/images/e.png");
});
