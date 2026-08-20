import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CDP_JSON = "http://127.0.0.1:9222/json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCORM_SCRAPER = path.join(SCRIPT_DIR, "scrape_scorm_cdp.mjs");
const BASE_OUT_ROOT = path.join(SCRIPT_DIR, "output");
const MAX_STEPS = Number(process.env.MAX_NEXT_STEPS || 100);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeFilename(text, maxLen = 100) {
  return (text || "untitled")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .replace(/[ ._]+$/g, "") || "untitled";
}

let OUT_ROOT = null;

function isSurveyPage(summary) {
  const haystack = `${summary?.url || ""}\n${summary?.title || ""}\n${summary?.iframeSrc || ""}\n${summary?.text || ""}`;
  return /survey|surveymonkey|feedback/i.test(haystack);
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  let opened = false;

  const eventError = event => {
    if (event instanceof Error) return event;
    return new Error(event?.message || event?.error?.message || "CDP WebSocket error");
  };

  const settlePending = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      opened = true;
      resolve();
    };
    ws.onerror = event => {
      const error = eventError(event);
      if (!opened) reject(error);
      settlePending(error);
    };
    ws.onclose = () => {
      settlePending(new Error("CDP WebSocket closed"));
    };
  });

  return {
    async send(method, params = {}) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("CDP WebSocket is not open");
      }
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
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

async function inspectPrimePlayerTarget(target) {
  if (!target?.webSocketDebuggerUrl) return { isScorm: false, reason: "Missing websocket URL" };

  let primeClient = null;
  try {
    primeClient = await cdpConnect(target.webSocketDebuggerUrl);
    return await evaluate(primeClient, `(() => {
      const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
      const moduleFrame = document.querySelector('#modulePlayerIframe');
      const out = {
        primeUrl: location.href,
        title: document.title,
        hasModuleFrame: Boolean(moduleFrame),
        hasDriverDoc: false,
        hasContentFrame: false,
        contentSrc: '',
        contentHref: '',
        contentAccessError: '',
        lessonLinks: 0,
        bodyLength: 0,
        bodyText: '',
        isAssessment: false,
        isScorm: false,
        isReady: false,
      };

      let driverDoc = null;
      try {
        driverDoc = moduleFrame?.contentWindow?.document || null;
        out.hasDriverDoc = Boolean(driverDoc);
      } catch (error) {
        out.contentAccessError = String(error?.message || error);
      }

      const contentFrame = driverDoc?.querySelector('#content-frame');
      out.hasContentFrame = Boolean(contentFrame);
      out.contentSrc = contentFrame?.src || contentFrame?.getAttribute('src') || '';

      const haystack = [out.primeUrl, out.title, out.contentSrc, clean(document.body?.innerText || '')].join('\\n');
      out.isAssessment = /onlinetests\\.app|Assess\\.aspx|assessment|certification/i.test(haystack);

      try {
        const contentWindow = contentFrame?.contentWindow || null;
        out.contentHref = contentWindow?.location?.href || '';
        const doc = contentWindow?.document || null;
        out.lessonLinks = doc ? doc.querySelectorAll('a[href*="#/lessons/"]').length : 0;
        out.bodyLength = doc?.body?.innerText?.length || 0;
        out.bodyText = clean(doc?.body?.innerText || '').slice(0, 300);
      } catch (error) {
        out.contentAccessError = String(error?.message || error);
      }

      out.isScorm = !out.isAssessment && (
        out.lessonLinks > 0 ||
        /scormcontent|#\\/lessons\\//i.test([out.contentSrc, out.contentHref].join('\\n'))
      );
      out.isReady = out.isScorm && (out.lessonLinks > 0 || out.bodyLength > 300);
      return out;
    })()`);
  } catch (error) {
    return {
      isScorm: false,
      isReady: false,
      error: String(error?.message || error),
      primeUrl: target.url,
    };
  } finally {
    primeClient?.close();
  }
}

async function waitForPrimePlayerResult(previousUrl = "", timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const target = await findPrimePlayerTarget();
    if (target && (!previousUrl || target.url !== previousUrl)) {
      const inspection = await inspectPrimePlayerTarget(target).catch(error => ({
        isScorm: false,
        isReady: false,
        error: String(error?.message || error),
        primeUrl: target.url,
      }));
      if (inspection.isAssessment || (inspection.hasContentFrame && !inspection.isScorm && inspection.contentAccessError)) {
        return { target: null, nonScorm: true, inspection };
      }
      if (inspection.isReady || inspection.isScorm) return { target, inspection };
    }
    await sleep(500);
  }
  return { target: null, nonScorm: false, inspection: null };
}

async function waitForPrimePlayer(previousUrl = "", timeoutMs = 45000) {
  const result = await waitForPrimePlayerResult(previousUrl, timeoutMs);
  return result.target || null;
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

async function getLearningPlanTitle(client) {
  const title = await evaluate(client, `(() => {
    const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const headings = [...document.querySelectorAll('h1,h2')]
      .filter(visible)
      .map(el => clean(el.innerText || el.textContent))
      .filter(Boolean)
      .filter(text => !/^(Previous|Next|Table of contents)$/i.test(text));

    const pageTitle = clean(document.title || '').replace(/\\s*[-|]\\s*UiPath Academy\\s*$/i, '');
    const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\\b\\w/g, ch => ch.toUpperCase());

    return headings.find(text => /training|developer|academy|automation|studio|course|learning/i.test(text)) ||
      headings[0] ||
      pageTitle ||
      slug ||
      'Learning Plan';
  })()`);

  return safeFilename(title, 90);
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

async function advancePastNonScormPages(client, previousPrimeUrl, moduleLog, reason) {
  const skippedPages = [];

  for (let attempt = 1; attempt <= 10; attempt++) {
    const pageSummary = await getPageSummary(client).catch(() => null);
    if (pageSummary) {
      skippedPages.push({
        attempt,
        reason,
        isSurvey: isSurveyPage(pageSummary),
        ...pageSummary,
      });
    }

    if (isSurveyPage(pageSummary)) {
      console.log("偵測到 Feedback Survey / 問卷頁，嘗試按外層 Next 跳過，不自動填答或送出問卷。");
    } else {
      console.log("目前不是 SCORM player，嘗試按外層 Next 繼續找下一個 SCORM module。");
    }

    if (pageSummary?.iframeSrc) console.log(`目前 iframe: ${pageSummary.iframeSrc}`);
    if (pageSummary?.text) console.log(`目前頁面文字: ${pageSummary.text}`);

    const next = await clickOuterNext(client) || {
      clicked: false,
      reason: "Outer Next click did not return a result, likely because the page navigated immediately",
    };
    if (skippedPages.length) {
      skippedPages[skippedPages.length - 1].nextClick = next;
    } else {
      skippedPages.push({ attempt, reason, nextClick: next });
    }

    if (!next.clicked) {
      moduleLog.skippedNonScormPages = skippedPages;
      return null;
    }

    console.log(`已點擊外層 Next：${next.text}`);
    const nextTarget = await waitForPrimePlayer(previousPrimeUrl, 60000);
    if (nextTarget) {
      moduleLog.skippedNonScormPages = skippedPages;
      return nextTarget;
    }
  }

  moduleLog.skippedNonScormPages = skippedPages;
  return null;
}

async function runScormScraper() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`重新嘗試爬取目前 SCORM module (${attempt}/3)...`);
        await sleep(5000);
      }
      execFileSync(process.execPath, [SCORM_SCRAPER], {
        cwd: SCRIPT_DIR,
        stdio: "inherit",
        env: {
          ...process.env,
          UIPATH_ACADEMY_OUTPUT_ROOT: OUT_ROOT,
        },
      });
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      console.error(`SCORM 爬取嘗試 ${attempt}/3 失敗：${String(error?.message || error)}`);
    }
  }

  return {
    ok: false,
    attempts: 3,
    error: String(lastError?.message || lastError || "SCORM scrape failed"),
  };
}

const client = await getAcademyPageClient();
const learningPlanTitle = await getLearningPlanTitle(client).catch(() => "Learning Plan");
OUT_ROOT = path.resolve(
  process.env.UIPATH_ACADEMY_BATCH_OUTPUT_ROOT ||
  path.join(BASE_OUT_ROOT, learningPlanTitle)
);

const runLog = {
  startedAt: new Date().toISOString(),
  learningPlanTitle,
  outputRoot: OUT_ROOT,
  maxSteps: MAX_STEPS,
  modules: [],
};

fs.mkdirSync(path.join(OUT_ROOT, "_learning_plan_runs"), { recursive: true });

console.log(`本次 learning plan 輸出資料夾：${OUT_ROOT}`);

try {
  let primeTarget = await hasOuterNext(client) ? await waitForPrimePlayer("", 2000) : null;
  if (!primeTarget) {
    const initialLog = { step: 0, startedAt: new Date().toISOString() };
    if (await hasOuterNext(client)) {
      console.log("目前停在非 SCORM player 頁面，先嘗試按外層 Next 找下一個 SCORM module...");
      primeTarget = await advancePastNonScormPages(client, "", initialLog, "initial non-scorm page");
      runLog.initialNonScorm = initialLog;
    }
  }

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
      const scrapeResult = await runScormScraper();
      moduleLog.scrapeResult = scrapeResult;
      if (!scrapeResult.ok) throw new Error(scrapeResult.error);
      moduleLog.scraped = true;
    } catch (error) {
      moduleLog.scraped = false;
      moduleLog.error = String(error?.message || error);
      console.error(`這個 module 爬取失敗：${moduleLog.error}`);
      console.log("這個 module 連續重試後仍失敗，停止以避免一路跳過後面的課。");
      break;
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
      const targetAfterSkippedPages = await advancePastNonScormPages(
        client,
        currentTarget.url,
        moduleLog,
        "after outer next"
      );
      if (targetAfterSkippedPages) {
        currentTarget = targetAfterSkippedPages;
        continue;
      }

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
