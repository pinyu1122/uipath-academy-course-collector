import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CDP_JSON = "http://127.0.0.1:9222/json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCORM_SCRAPER = path.join(SCRIPT_DIR, "scrape_scorm_cdp.mjs");
const OUT_ROOT = path.join(SCRIPT_DIR, "academy_course_output");
const MAX_STEPS = Number(process.env.MAX_NEXT_STEPS || 100);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  return {
    async send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise(resolve => pending.set(mid, resolve));
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails, null, 2));
  }

  return result.result?.result?.value;
}

async function getTargets() {
  return await (await fetch(CDP_JSON)).json();
}

function isPrimePlayerTarget(target) {
  return target.type === "iframe" &&
    target.url.includes("cpcontents.adobe.com/public/prime-player") &&
    target.webSocketDebuggerUrl;
}

async function findAcademyPageTarget() {
  const targets = await getTargets();
  return targets.find(t =>
    t.type === "page" &&
    t.url.includes("academy.uipath.com") &&
    t.webSocketDebuggerUrl
  );
}

async function findPrimePlayerTarget() {
  const targets = await getTargets();
  return targets.find(isPrimePlayerTarget) || null;
}

async function waitForPrimePlayer(previousUrl = "", timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const target = await findPrimePlayerTarget();
    if (target && (!previousUrl || target.url !== previousUrl)) return target;
    await sleep(500);
  }
  return null;
}

async function hasOuterNext(client) {
  return evaluate(client, `(() => {
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    return [...document.querySelectorAll('button,a,[role="button"]')]
      .filter(visible)
      .some(el => {
        const text = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title);
        const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
        return /^Next(\\s|$|→|›|»)/i.test(text) && !disabled;
      });
  })()`);
}

async function waitForVisiblePlayer(client, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const target = await findPrimePlayerTarget();
    if (target && await hasOuterNext(client)) return target;
    await sleep(500);
  }
  return null;
}

async function getAcademyPageClient() {
  const target = await findAcademyPageTarget();
  if (!target) {
    throw new Error("找不到 UiPath Academy 分頁。請先用 run_cdp.bat 開 Chrome 並登入 Academy。");
  }
  return cdpConnect(target.webSocketDebuggerUrl);
}

async function getPageSummary(client) {
  return evaluate(client, `(() => {
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const iframe = document.querySelector('iframe');
    return {
      url: location.href,
      title: document.title,
      iframeSrc: iframe?.src || '',
      text: clean(document.body?.innerText || '').slice(0, 300),
    };
  })()`);
}

async function clickStartOrResume(client) {
  return evaluate(client, `(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter(visible)
      .map(el => {
        const text = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title);
        const row = el.closest('li,tr,[class*="course"],[class*="Course"],[class*="Training"],section,article') || el.parentElement;
        const rowText = clean(row?.innerText || '');
        return { el, text, rowText };
      });

    const preferred = buttons.find(x => /^Resume learning plan$/i.test(x.text));
    const fallback = buttons.find(x =>
      /^(Start|Resume|Review)$/i.test(x.text) &&
      !/survey|assessment|certification/i.test(x.rowText)
    );
    const target = preferred || fallback;
    if (!target) {
      return { clicked: false, reason: 'No visible Resume learning plan / Start / Resume / Review button found' };
    }

    target.el.scrollIntoView({ block: 'center' });
    await delay(300);
    const result = { clicked: true, text: target.text, rowText: target.rowText.slice(0, 300), url: location.href };
    setTimeout(() => target.el.click(), 0);
    return result;
  })()`);
}

async function clickOuterNext(client) {
  return evaluate(client, `(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const controls = [...document.querySelectorAll('button,a,[role="button"]')]
      .filter(visible)
      .map(el => ({
        el,
        text: clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      }));

    const next = controls.find(x => /^Next(\\s|$|→|›|»)/i.test(x.text) && !x.disabled);
    if (!next) {
      return { clicked: false, reason: 'No enabled outer Next button found' };
    }

    next.el.scrollIntoView({ block: 'center' });
    await delay(200);
    const result = { clicked: true, text: next.text, url: location.href };
    setTimeout(() => next.el.click(), 0);
    return result;
  })()`);
}

function runScormScraper() {
  execFileSync(process.execPath, [SCORM_SCRAPER], {
    cwd: SCRIPT_DIR,
    stdio: "inherit",
  });
}

const runLog = {
  startedAt: new Date().toISOString(),
  maxSteps: MAX_STEPS,
  modules: [],
};

fs.mkdirSync(path.join(OUT_ROOT, "_learning_plan_runs"), { recursive: true });

const client = await getAcademyPageClient();

try {
  let primeTarget = await hasOuterNext(client) ? await waitForPrimePlayer("", 2000) : null;
  if (!primeTarget) {
    console.log("目前沒有開啟 SCORM player，嘗試按 Resume learning plan / Start / Resume...");
    const opened = await clickStartOrResume(client);
    runLog.initialClick = opened;
    console.log(opened.clicked ? `已點擊：${opened.text}` : `沒有可點擊項目：${opened.reason}`);
    if (!opened.clicked) throw new Error(opened.reason);
    primeTarget = await waitForVisiblePlayer(client, 60000);
  }

  if (!primeTarget) {
    throw new Error("點擊後仍找不到 Adobe SCORM player。可能目前項目不是 SCORM 課程。");
  }

  const seenPrimeUrls = new Set();
  let currentTarget = primeTarget;

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (seenPrimeUrls.has(currentTarget.url)) {
      console.log("偵測到相同 SCORM player URL，停止避免重複爬同一個 module。");
      break;
    }

    seenPrimeUrls.add(currentTarget.url);
    console.log("");
    console.log("==============================================================================");
    console.log(`[Learning plan ${step}/${MAX_STEPS}] ${currentTarget.url}`);
    console.log("==============================================================================");

    const moduleLog = {
      step,
      primePlayerUrl: currentTarget.url,
      startedAt: new Date().toISOString(),
    };

    try {
      runScormScraper();
      moduleLog.scraped = true;
    } catch (error) {
      moduleLog.scraped = false;
      moduleLog.error = String(error?.message || error);
      console.error(`這個 module 爬取失敗：${moduleLog.error}`);
    }

    moduleLog.finishedAt = new Date().toISOString();
    runLog.modules.push(moduleLog);

    const next = await clickOuterNext(client) || {
      clicked: false,
      reason: "Outer Next click did not return a result, likely because the page navigated immediately",
    };
    moduleLog.nextClick = next;
    if (!next.clicked) {
      console.log(`找不到可用的 Next，停止：${next.reason}`);
      break;
    }

    console.log(`已點擊外層 Next：${next.text}`);
    const nextTarget = await waitForPrimePlayer(currentTarget.url, 60000);
    if (!nextTarget) {
      const pageSummary = await getPageSummary(client).catch(() => null);
      moduleLog.afterNextPage = pageSummary;
      console.log("按 Next 後沒有偵測到新的 SCORM player，停止。可能已到最後，或下一頁不是 SCORM 內容。");
      if (pageSummary?.iframeSrc) console.log(`目前 iframe: ${pageSummary.iframeSrc}`);
      if (pageSummary?.text) console.log(`目前頁面文字: ${pageSummary.text}`);
      break;
    }

    currentTarget = nextTarget;
  }
} finally {
  runLog.finishedAt = new Date().toISOString();
  const logPath = path.join(OUT_ROOT, "_learning_plan_runs", `run_${timestamp()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(runLog, null, 2), "utf8");
  client.close();
  console.log("");
  console.log(`Learning plan run log: ${logPath}`);
}
