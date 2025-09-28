module.exports = function (RED) {
  "use strict";

  const fs = require("fs");
  const fsp = require("fs/promises");
  const https = require("https");
  const http = require("http");

  // 强制使用本插件目录下的 tesseract.js（避免被其他包影响版本）
  const tesseract = require(require.resolve("tesseract.js", { paths: [__dirname] }));
  const { createWorker } = tesseract;

  /* ---------------- Helpers ---------------- */
  function isHttpUrl(s) { return typeof s === "string" && /^https?:\/\//i.test(s); }
  function isDataUrl(s) { return typeof s === "string" && /^data:image\/[a-z0-9+.-]+;base64,/i.test(s); }

  async function downloadAsBuffer(url) {
    if (typeof fetch === "function") {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download image. HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }
    const lib = url.startsWith("https") ? https : http;
    return new Promise((resolve, reject) => {
      lib.get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download image. HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    });
  }

  async function normalizePayloadToBuffer(node, payload) {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload && payload.type === "Buffer" && Array.isArray(payload.data)) return Buffer.from(payload.data);
    if (isDataUrl(payload)) {
      const b64 = payload.split(",", 2)[1] || "";
      return Buffer.from(b64, "base64");
    }
    if (isHttpUrl(payload)) {
      node.status({ fill: "blue", shape: "dot", text: "downloading image" });
      return await downloadAsBuffer(payload);
    }
    if (typeof payload === "string") {
      if (!fs.existsSync(payload)) throw new Error(`Referenced image file does not exist: ${payload}`);
      return await fsp.readFile(payload);
    }
    throw new Error("Unsupported payload type. Provide URL/dataURL/path/Buffer/{type:'Buffer',data:[...]}.");
  }

  function withTimeout(promise, ms, onTimeout) {
    if (!ms || ms <= 0) return promise;
    let t = null;
    return Promise.race([
      promise.finally(() => clearTimeout(t)),
      new Promise((_, reject) => {
        t = setTimeout(() => {
          try { onTimeout && onTimeout(); } catch {}
          reject(new Error(`OCR timeout after ${ms}ms`));
        }, ms);
      }),
    ]);
  }

  /* --------------- Worker Pool (per node) --------------- */
  function makePool() {
    /** @type {{worker:any, lang:string|null, busy:boolean, api:{hasLoad:boolean, hasLangInit:boolean}}[]} */
    const pool = [];
    let desiredSize = 1;

    async function createOne() {
      // 兼容不同实现：createWorker 可能同步/异步返回
      let w = createWorker();
      if (w && typeof w.then === "function") w = await w;

      const api = {
        hasLoad: typeof w.load === "function",                            // 有的构建无 load()
        hasLangInit: typeof w.loadLanguage === "function" && typeof w.initialize === "function",
      };

      // 不再依赖 w.load() —— 某些 v6 构建没有这个 API
      return { worker: w, lang: null, busy: false, api };
    }

    async function ensureSize(size) {
      desiredSize = Math.max(1, Math.min(4, Number(size) || 1)); // 限 1~4
      while (pool.length < desiredSize) pool.push(await createOne());
      while (pool.length > desiredSize) {
        const item = pool.pop();
        if (item && item.worker && typeof item.worker.terminate === "function") {
          try { await item.worker.terminate(); } catch {}
        }
      }
      return pool;
    }

    async function initLangIfNeeded(item, lang) {
      if (item.lang === lang) return;
      if (item.api.hasLangInit) {
        await item.worker.loadLanguage(lang);
        await item.worker.initialize(lang);
        item.lang = lang;
      } else {
        // 没有 loadLanguage/initialize：视为“已就绪”，无法切换语言。
        // 这里记录一次，防止频繁重复尝试。
        item.lang = item.lang || lang;
      }
    }

    async function acquire(lang) {
      // 找空闲
      for (const it of pool) {
        if (!it.busy) {
          it.busy = true;
          await initLangIfNeeded(it, lang);
          return it;
        }
      }
      // 等待释放
      return new Promise((resolve, reject) => {
        const check = async () => {
          for (const it of pool) {
            if (!it.busy) {
              it.busy = true;
              try {
                await initLangIfNeeded(it, lang);
                resolve(it);
              } catch (e) {
                it.busy = false;
                reject(e);
              }
              return;
            }
          }
          setTimeout(check, 20);
        };
        check();
      });
    }

    async function release(item) { if (item) item.busy = false; }

    async function destroy() {
      for (const it of pool) {
        try { typeof it.worker.terminate === "function" && await it.worker.terminate(); } catch {}
      }
      pool.length = 0;
    }

    return { ensureSize, acquire, release, destroy, get size() { return pool.length; } };
  }

  /* ---------------- Node Definition ---------------- */
  function ZocrNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const pool = makePool();

    node.on("input", async function (msg, send, done) {
      try {
        const imageBuffer = await normalizePayloadToBuffer(node, msg.payload);

        // 动态配置：msg.zocr 优先，兼容 msg.zocrConfig
        const incoming = msg.zocr || msg.zocrConfig || {};
        const defaults = {
          lang: "eng",
          parameters: {
            tessedit_char_whitelist: "0123456789",
            tessedit_pageseg_mode: "6",
          },
          rectangle: null,   // { left, top, width, height }
          poolSize: 1,       // 1~4
          timeoutMs: 30000,  // 30s
        };
        const cfg = {
          ...defaults,
          ...incoming,
          parameters: { ...(defaults.parameters || {}), ...(incoming.parameters || {}) },
        };
        const lang = String(cfg.lang || "eng");

        await pool.ensureSize(cfg.poolSize);

        node.status({ fill: "blue", shape: "dot", text: `ocr (${lang})` });

        const item = await pool.acquire(lang);

        // setParameters 若存在则设置
        if (cfg.parameters && typeof item.worker.setParameters === "function") {
          await item.worker.setParameters(cfg.parameters);
        }

        // rectangle 识别区域
        const recognizeOptions = {};
        const rect = cfg.rectangle;
        if (
          rect &&
          Number.isInteger(rect.left) &&
          Number.isInteger(rect.top) &&
          Number.isInteger(rect.width) &&
          Number.isInteger(rect.height)
        ) {
          recognizeOptions.rectangle = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        }

        // 识别：优先 worker.recognize；否则兜底 tesseract.recognize
        const doRecognize = async () => {
          if (typeof item.worker.recognize === "function") {
            return await item.worker.recognize(imageBuffer, recognizeOptions);
          }
          if (typeof tesseract.recognize === "function") {
            return await tesseract.recognize(imageBuffer, lang, cfg.parameters || {});
          }
          throw new Error("No available recognize API on this tesseract.js build.");
        };

        const result = await withTimeout(doRecognize(), cfg.timeoutMs);

        msg.payload = result;
        node.status({});
        send(msg);
        await pool.release(item);
        if (done) done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "ocr failed" });
        node.error(err, msg);
        if (done) done(err);
      }
    });

    node.on("close", async function (removed, done) {
      try { await pool.destroy(); } catch (_) {} finally { done(); }
    });
  }

  RED.nodes.registerType("zocr", ZocrNode);
};