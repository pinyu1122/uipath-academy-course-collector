import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const CDP_JSON = "http://127.0.0.1:9222/json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(SCRIPT_DIR, "academy_course_output");

function safeFilename(text, maxLen = 100) {
  return (text || "untitled")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .replace(/[ ._]+$/g, "") || "untitled";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\?/g, "'s")
    .replace(/\?l/g, "'ll")
    .replace(/\?/g, "'")
    .replace(/([:–—-])\?([A-Za-z0-9])/g, "$1 $2")
    .replace(/([a-z])\?([a-z])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
  };
  return map[type] || "";
}

function filenameFromUrl(url, fallback = "download") {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(path.basename(parsed.pathname));
    return safeFilename(name || fallback, 140);
  } catch (_) {
    return safeFilename(fallback, 140);
  }
}

function cleanDownloadFilename(rawName, ext = "") {
  let name = String(rawName || "download")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const wantedExt = ext || path.extname(name);
  if (wantedExt) {
    const escapedExt = wantedExt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name
      .replace(new RegExp(`\\s*\\(?\\s*\\d+(?:\\.\\d+)?\\s*(?:KB|MB|GB|B)\\s*${escapedExt}\\s*\\)?\\s*$`, "i"), "")
      .replace(new RegExp(`\\s+\\d+(?:\\.\\d+)?\\s*(?:KB|MB|GB|B)\\s*$`, "i"), "");

    while (name.toLowerCase().endsWith((wantedExt + wantedExt).toLowerCase())) {
      name = name.slice(0, -wantedExt.length);
    }

    if (!name.toLowerCase().endsWith(wantedExt.toLowerCase())) name += wantedExt;
  } else {
    name = name.replace(/\s*[\[(]?\s*\d+(?:\.\d+)?\s*(?:KB|MB|GB|B)\s*[\])]?\s*$/i, "");
  }

  return safeFilename(name, 140);
}

function unzipDownloadedFile(filePath, downloadsDir) {
  if (path.extname(filePath).toLowerCase() !== ".zip") return null;

  const baseName = safeFilename(path.basename(filePath, ".zip"), 120);
  const extractDir = path.join(downloadsDir, "extracted", baseName);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      filePath,
      extractDir,
    ], { stdio: "pipe" });

    return { extracted: true, extractDir };
  } catch (error) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    return {
      extracted: false,
      extractDir,
      error: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

function resetGeneratedDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
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

async function findCdpTarget(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await (await fetch(CDP_JSON)).json();
    const target = targets.find(predicate);
    if (target) return target;
    await sleep(250);
  }
  return null;
}

async function scrapeScribeWalkthrough(embed) {
  const scribeUrl = embed.src || embed.href || embed.url;
  if (!scribeUrl) return null;

  const target = await findCdpTarget(t =>
    t.type === "iframe" &&
    t.webSocketDebuggerUrl &&
    t.url.replace(/\/$/, "") === scribeUrl.replace(/\/$/, ""),
    5000
  );

  if (!target) {
    return {
      url: scribeUrl,
      title: embed.title || "Scribe walkthrough",
      error: "Scribe iframe target not found",
      steps: [],
    };
  }

  const scribeClient = await cdpConnect(target.webSocketDebuggerUrl);
  try {
    return await evaluate(scribeClient, `(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const clean = text => (text || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const buttonText = el => clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      const clickButton = pattern => {
        const el = [...document.querySelectorAll('button,a,[role="button"]')]
          .find(x => pattern.test(buttonText(x)));
        if (!el) return false;
        el.click();
        return true;
      };
      const stepInfo = () => {
        const match = (document.body.innerText || '').match(/Step\\s+(\\d+)\\s+of\\s+(\\d+)/i);
        return match ? { current: Number(match[1]), total: Number(match[2]) } : { current: 0, total: 0 };
      };
      const cover = () => ({
        title: clean(document.querySelector('h1')?.innerText || document.title || 'Scribe walkthrough'),
        description: [...document.querySelectorAll('p')]
          .map(p => clean(p.innerText || p.textContent))
          .filter(Boolean)
          .join('\\n'),
        url: location.href,
      });
      const readStep = () => {
        const info = stepInfo();
        const paragraphs = [...document.querySelectorAll('p')]
          .map(p => clean(p.innerText || p.textContent))
          .filter(Boolean);
        const images = [...document.querySelectorAll('img')]
          .map(img => ({ src: img.currentSrc || img.src || '', alt: clean(img.alt || '') }))
          .filter(img => img.src);
        let text = paragraphs.join('\\n');
        if (!text) {
          text = (document.body.innerText || '')
            .split('\\n')
            .map(clean)
            .filter(line => line && !/^Step\\s+\\d+\\s+of\\s+\\d+$/i.test(line) && !/^(Back|Next|Get Started|Open original Scribe)$/i.test(line))
            .join('\\n');
        }
        return { number: info.current, total: info.total, text, images };
      };

      for (let guard = 0; guard < 20; guard++) {
        const body = clean(document.body.innerText || '');
        if (/Get Started|Step\\s+\\d+\\s+of\\s+\\d+/i.test(body)) break;
        await delay(250);
      }

      for (let guard = 0; guard < 120; guard++) {
        const info = stepInfo();
        if (!info.current) break;
        if (!clickButton(/^back$/i)) break;
        await delay(250);
      }

      const intro = cover();
      const firstInfo = stepInfo();
      if (firstInfo.current === 0) {
        clickButton(/get started/i);
        await delay(800);
      }

      const steps = [];
      const seen = new Set();
      for (let guard = 0; guard < 120; guard++) {
        const step = readStep();
        if (step.number > 0 && step.text) {
          const key = step.number + '|' + step.text;
          if (!seen.has(key)) {
            seen.add(key);
            steps.push(step);
          }
        }
        if (step.total && step.number >= step.total) break;
        if (!clickButton(/^next$/i)) break;
        await delay(450);
      }

      return { url: location.href, title: intro.title, description: intro.description, steps };
    })()`);
  } finally {
    scribeClient.close();
  }
}

async function downloadAttachment(item, downloadsDir, prefix) {
  const url = item.href || item.url;
  if (!url) return { ...item, downloaded: false, error: "Missing URL" };

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
    const response = await fetch(url);
    if (!response.ok) {
      lastError = `HTTP ${response.status}`;
      await sleep(500 * attempt);
      continue;
    }

    const contentDisposition = response.headers.get("content-disposition") || "";
    const dispositionMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const dispositionName = dispositionMatch ? decodeURIComponent(dispositionMatch[1].replace(/"$/g, "")) : "";
    const ext = path.extname(new URL(url).pathname) || extensionFromContentType(response.headers.get("content-type"));
    const rawName = dispositionName || item.text || filenameFromUrl(url, "download");
    const baseName = cleanDownloadFilename(rawName, ext);
    const filename = safeFilename(`${prefix}_${baseName}`, 170);
    const filePath = path.join(downloadsDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    const extraction = unzipDownloadedFile(filePath, downloadsDir);
    return { ...item, downloaded: true, filename, path: filePath, bytes: buffer.length, extraction };
    } catch (error) {
      lastError = String(error?.message || error);
      await sleep(500 * attempt);
    }
  }

  return { ...item, downloaded: false, error: lastError || "Download failed" };
}

function markdownForLesson(index, lesson) {
  const out = [];
  out.push(`# ${lesson.title || `Lesson ${index}`}`);
  out.push("");
  out.push(`- Lesson index: ${index}`);
  out.push(`- URL: ${lesson.url}`);
  out.push("");

  const lessonText = cleanText(lesson.text);
  if (lessonText) {
    out.push("## Content");
    out.push("");
    out.push(lessonText);
    out.push("");
  }

  if (lesson.links?.length) {
    out.push("## Links");
    out.push("");
    for (const link of lesson.links) {
      out.push(`- [${link.text || link.href}](${link.href})`);
    }
    out.push("");
  }

  if (lesson.attachments?.length) {
    out.push("## Attachments");
    out.push("");
    for (const item of lesson.attachments) {
      out.push(`- [${item.text || item.href}](${item.href})`);
    }
    out.push("");
  }

  if (lesson.downloadedFiles?.length) {
    out.push("## Downloaded Files");
    out.push("");
    for (const file of lesson.downloadedFiles) {
      if (file.downloaded) {
        out.push(`- ${file.filename} (${file.bytes || 0} bytes)`);
        if (file.extraction?.extracted) {
          out.push(`  - Extracted to: ${file.extraction.extractDir}`);
        } else if (file.extraction?.error) {
          out.push(`  - Extract failed: ${file.extraction.error}`);
        }
      } else {
        out.push(`- ${file.text || file.href}: download failed${file.error ? ` (${file.error})` : ""}`);
      }
    }
    out.push("");
  }

  if (lesson.riseInteractions?.length) {
    out.push("## Rise Interactive Blocks");
    out.push("");
    for (const block of lesson.riseInteractions) {
      out.push(`### ${block.title || `${block.variant || block.type || "Interactive block"} ${block.index}`}`);
      out.push("");
      if (block.variant || block.type) {
        out.push(`- Type: ${[block.type, block.variant].filter(Boolean).join(" / ")}`);
        out.push("");
      }
      for (const item of block.items || []) {
        out.push(`#### ${item.title || "Item"}`);
        out.push("");
        if (item.description) {
          out.push(cleanText(item.description));
          out.push("");
        }
        if (item.image) {
          out.push(`Image: ${item.image}`);
          out.push("");
        }
      }
    }
  }

  if (lesson.interactiveWalkthroughs?.length) {
    out.push("## Interactive Walkthroughs");
    out.push("");
    for (const walkthrough of lesson.interactiveWalkthroughs) {
      out.push(`### ${walkthrough.title || "Scribe walkthrough"}`);
      out.push("");
      if (walkthrough.url) out.push(`- Source: ${walkthrough.url}`);
      if (walkthrough.description) {
        out.push("");
        out.push(cleanText(walkthrough.description));
      }
      if (walkthrough.error) {
        out.push("");
        out.push(`Unable to extract steps: ${walkthrough.error}`);
      }
      out.push("");
      for (const step of walkthrough.steps || []) {
        const total = step.total ? `/${step.total}` : "";
        out.push(`#### Step ${step.number}${total}`);
        out.push("");
        out.push(cleanText(step.text));
        if (step.images?.length) {
          out.push("");
          out.push("Images:");
          for (const image of step.images) {
            out.push(`- ${image.alt ? `${cleanText(image.alt)}: ` : ""}${image.src}`);
          }
        }
        out.push("");
      }
    }
  }

  if (lesson.quizQuestions?.length) {
    out.push("## Quiz Questions");
    out.push("");
    for (const question of lesson.quizQuestions) {
      out.push(`### ${question.counter || `Question ${question.index}`}`);
      out.push("");
      if (question.type) {
        out.push(`- Type: ${question.type}`);
        out.push("");
      }
      out.push(cleanText(question.question));
      out.push("");

      if (question.options?.length) {
        out.push("Options:");
        for (const option of question.options) {
          out.push(`- ${cleanText(option)}`);
        }
        out.push("");
      }

      if (question.matchOptions?.length) {
        out.push("Match choices:");
        for (const option of question.matchOptions) {
          out.push(`- ${cleanText(option)}`);
        }
        out.push("");
      }
    }
  }

  if (lesson.captions?.length) {
    out.push("## Captions");
    out.push("");
    for (const cap of lesson.captions) {
      out.push(`### ${cap.mediaId || cap.url || "Caption"} (${cap.language || "unknown"})`);
      out.push("");
      const lines = (cap.lines || []).map(x => cleanText(x.text || x)).filter(Boolean);
      if (lines.length) {
        out.push(lines.join("\n"));
      } else if (cap.url) {
        out.push(`- Source: ${cap.url}`);
      }
      out.push("");
    }
  }

  return out.join("\n").trim() + "\n";
}

const targets = await (await fetch(CDP_JSON)).json();
const target = targets.find(t =>
  t.type === "iframe" &&
  t.url.includes("cpcontents.adobe.com/public/prime-player") &&
  t.webSocketDebuggerUrl
);

if (!target) {
  console.error("找不到 Adobe prime-player iframe。請先用 run_cdp.bat 開 Chrome 並進入課程頁。");
  process.exit(1);
}

console.log("Attached target:", target.id);
const client = await cdpConnect(target.webSocketDebuggerUrl);

const meta = await evaluate(client, `(async () => {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let doc = null;
  let lastState = '';

  for (let attempt = 1; attempt <= 120; attempt++) {
    const moduleFrame = document.querySelector('#modulePlayerIframe');
    let driverDoc = null;
    let contentFrame = null;
    let accessError = '';

    try {
      driverDoc = moduleFrame?.contentWindow?.document || null;
      contentFrame = driverDoc?.querySelector('#content-frame') || null;
      doc = contentFrame?.contentWindow?.document || null;
    } catch (error) {
      doc = null;
      accessError = String(error?.message || error);
    }

    const contentSrc = contentFrame?.src || contentFrame?.getAttribute?.('src') || '';
    const bodyText = doc?.body?.innerText || '';
    const lessonLinks = doc ? doc.querySelectorAll('a[href*="#/lessons/"]').length : 0;
    lastState = [
      'moduleFrame=' + Boolean(moduleFrame),
      'driverDoc=' + Boolean(driverDoc),
      'contentFrame=' + Boolean(contentFrame),
      'contentSrc=' + contentSrc,
      'doc=' + Boolean(doc),
      'readyState=' + (doc?.readyState || ''),
      'bodyLength=' + bodyText.length,
      'lessonLinks=' + lessonLinks,
      'accessError=' + accessError,
    ].join(', ');

    if (!doc && /onlinetests\\.app|Assess\\.aspx|assessment|certification/i.test(contentSrc + '\\n' + accessError)) {
      return { error: 'content-frame is assessment or cross-origin non-SCORM content', lastState };
    }

    if (doc && doc.readyState === 'complete' && (lessonLinks > 0 || bodyText.length > 300)) break;
    await delay(500);
  }

  if (!doc) return { error: 'content-frame not ready', lastState };

  const courseTitle = (document.body.innerText || '').split('\\n').find(Boolean) || document.title || 'UiPath Academy Course';
  const links = [...doc.querySelectorAll('a[href*="#/lessons/"]')]
    .map(a => ({ href: a.href, text: (a.innerText || a.title || a.getAttribute('aria-label') || '').trim() }))
    .filter(x => x.href);

  const seen = new Set();
  const lessons = [];
  for (const link of links) {
    const key = link.href.replace(/\\?.*$/, '');
    if (!seen.has(key)) {
      seen.add(key);
      lessons.push(link);
    }
  }

  return {
    courseTitle,
    currentUrl: doc.location.href,
    lessonCount: lessons.length,
    lessons,
    lastState,
  };
})()`);

if (meta.error) {
  console.error(meta.error);
  if (meta.lastState) console.error(meta.lastState);
  process.exit(1);
}

console.log("Course:", meta.courseTitle);
console.log("Lessons discovered:", meta.lessonCount);

const courseDir = path.join(OUT_ROOT, safeFilename(meta.courseTitle, 80));
const lessonDir = path.join(courseDir, "lessons");
const rawCaptionDir = path.join(courseDir, "raw_captions");
const downloadsDir = path.join(courseDir, "downloads");
const walkthroughDir = path.join(courseDir, "interactive_walkthroughs");
const debugDir = path.join(courseDir, "_debug");
resetGeneratedDir(lessonDir);
resetGeneratedDir(rawCaptionDir);
resetGeneratedDir(downloadsDir);
resetGeneratedDir(walkthroughDir);
resetGeneratedDir(debugDir);
fs.writeFileSync(path.join(debugDir, "scorm_lessons.json"), JSON.stringify(meta, null, 2), "utf8");

const lessonsOut = [];

for (let i = 0; i < meta.lessons.length; i++) {
  const href = meta.lessons[i].href;
  console.log(`[${i + 1}/${meta.lessons.length}] ${href}`);

  const lesson = await evaluate(client, `(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const moduleFrame = document.querySelector('#modulePlayerIframe');
    const driverDoc = moduleFrame.contentWindow.document;
    const contentFrame = driverDoc.querySelector('#content-frame');
    const win = contentFrame.contentWindow;

    win.location.href = ${JSON.stringify(href)};
    await delay(1200);

    let doc = win.document;
    for (let i = 0; i < 20; i++) {
      doc = win.document;
      if (doc.readyState === 'complete' && (doc.body?.innerText || '').length > 100) break;
      await delay(300);
    }

    const clickAllTabs = async () => {
      const tabs = [...doc.querySelectorAll('button[id^="tab-"], [role="tab"], .blocks-tabs__header-item')];
      const seen = new Set();
      const chunks = [];

      for (const tab of tabs) {
        const label = (tab.innerText || tab.textContent || '').trim().replace(/\\s+/g, ' ');
        if (!label || seen.has(label)) continue;
        seen.add(label);
        try {
          tab.scrollIntoView({ block: 'center' });
          tab.click();
          await delay(250);
          const active = [...doc.querySelectorAll('.blocks-tabs__content-item--active, [role="tabpanel"]')]
            .map(x => (x.innerText || '').trim())
            .filter(Boolean)
            .join('\\n');
          if (active) chunks.push(label + '\\n' + active);
        } catch (_) {}
      }
      return chunks;
    };

    const cleanQuizText = text => (text || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();

    const htmlToText = html => {
      const div = doc.createElement('div');
      div.innerHTML = String(html || '')
        .replace(/<\\s*br\\s*\\/?>/gi, '\\n')
        .replace(/<\\/(p|div|li|ul|ol|h[1-6])>/gi, '\\n');
      return cleanQuizText(div.innerText || div.textContent || '');
    };

    const extractQuizQuestionsFromCourse = async () => {
      if (typeof win.__fetchCourse !== 'function') return [];
      try {
        const payload = await win.__fetchCourse();
        const course = payload?.course || payload;
        const lessonId = (win.location.href.match(/#\\/lessons\\/([^/?#]+)/) || [])[1];
        const quizLesson = (course?.lessons || []).find(lesson => lesson.id === lessonId) ||
          (course?.lessons || []).find(lesson => lesson.type === 'quiz' && lesson.title === title);
        const items = Array.isArray(quizLesson?.items) ? quizLesson.items : [];
        return items.map((item, idx) => {
          const answers = Array.isArray(item.answers) ? item.answers : [];
          const options = [];
          const matchOptions = [];

          for (const answer of answers) {
            const answerText = htmlToText(answer.title);
            const matchText = htmlToText(answer.matchTitle);
            if (answerText) options.push(answerText);
            if (matchText) matchOptions.push(matchText);
          }

          return {
            index: idx + 1,
            counter: 'Question ' + String(idx + 1).padStart(2, '0') + '/' + String(items.length).padStart(2, '0'),
            type: item.type || '',
            question: htmlToText(item.title),
            options: [...new Set(options)],
            matchOptions: [...new Set(matchOptions)],
          };
        }).filter(question => question.question);
      } catch (_) {
        return [];
      }
    };

    const extractQuizQuestionsFromDom = () => {
      const cards = [...doc.querySelectorAll('.quiz-card')];
      const seen = new Set();
      const questions = [];

      for (const card of cards) {
        const counter = cleanQuizText(card.querySelector('.quiz-card__number-title, .quiz-card__number, .quiz-card__counter')?.innerText);
        const question = cleanQuizText(card.querySelector('.quiz-card__title')?.innerText);
        if (!question) continue;

        const options = [...card.querySelectorAll(
          '.quiz-multiple-choice-option__label, .quiz-multiple-choice-option__text, label.quiz-multiple-choice-option, .quiz-card__interactive label'
        )]
          .map(el => cleanQuizText(el.innerText || el.textContent))
          .filter(Boolean);
        const uniqueOptions = [...new Set(options)];

        const key = counter + '|' + question;
        if (seen.has(key)) continue;
        seen.add(key);
        questions.push({
          index: questions.length + 1,
          counter,
          question,
          options: uniqueOptions,
          matchOptions: [],
        });
      }

      return questions;
    };

    const extractRiseInteractionsFromCourse = async () => {
      if (typeof win.__fetchCourse !== 'function') return [];
      try {
        const payload = await win.__fetchCourse();
        const course = payload?.course || payload;
        const lessonId = (win.location.href.match(/#\\/lessons\\/([^/?#]+)/) || [])[1];
        const currentLesson = (course?.lessons || []).find(lesson => lesson.id === lessonId) ||
          (course?.lessons || []).find(lesson => lesson.title === title);
        const blocks = Array.isArray(currentLesson?.items) ? currentLesson.items : [];
        const interactions = [];

        for (const block of blocks) {
          if (block?.type !== 'interactive') continue;
          const items = (Array.isArray(block.items) ? block.items : [])
            .map(item => {
              const image =
                item?.media?.image?.originalUrl ||
                item?.media?.image?.crushedKey ||
                item?.media?.image?.key ||
                '';
              return {
                title: htmlToText(item?.title),
                description: htmlToText(item?.description || item?.paragraph),
                image,
              };
            })
            .filter(item => item.title || item.description || item.image);

          if (!items.length) continue;
          interactions.push({
            index: interactions.length + 1,
            type: block.type || '',
            variant: block.variant || '',
            title: block.variant ? block.variant[0].toUpperCase() + block.variant.slice(1) : 'Interactive block',
            items,
          });
        }

        return interactions;
      } catch (_) {
        return [];
      }
    };

    const captionLinesFromJson = data => {
      const parseLines = lines => {
        if (!Array.isArray(lines)) return [];
        return lines.map(line => {
          let text = line?.text || '';
          if (Array.isArray(text)) text = text.join('');
          text = String(text).replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim();
          return text ? { start: line?.start, end: line?.end, text } : null;
        }).filter(Boolean);
      };

      if (data?.hash?.lines) return parseLines(data.hash.lines);
      if (data?.lines) return parseLines(data.lines);
      if (Array.isArray(data?.captions)) {
        const preferred =
          data.captions.find(x => x?.wistiaLanguageCode === 'chi') ||
          data.captions.find(x => /^zh/i.test(x?.bcp47LanguageTag || '')) ||
          data.captions.find(x => x?.hash?.lines) ||
          data.captions[0];
        if (preferred?.hash?.lines) return parseLines(preferred.hash.lines);
        if (preferred?.lines) return parseLines(preferred.lines);
      }
      if (data?.captions?.hash?.lines) return parseLines(data.captions.hash.lines);
      if (data?.captions?.lines) return parseLines(data.captions.lines);
      return [];
    };

    const captionLinesFromVtt = text => {
      const lines = String(text || '').replace(/\\r\\n/g, '\\n').split('\\n');
      const out = [];
      let current = [];
      let start = null;
      let end = null;
      const flush = () => {
        const body = current.join(' ').replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim();
        if (body) out.push({ start, end, text: body });
        current = [];
        start = null;
        end = null;
      };
      for (const raw of lines) {
        const line = raw.trim();
        if (line.includes('-->')) {
          flush();
          const parts = line.split('-->').map(x => x.trim());
          start = parts[0];
          end = parts[1]?.split(/\\s+/)[0] || null;
        } else if (!line) {
          flush();
        } else if (line === 'WEBVTT' || /^NOTE\\b/.test(line) || /^\\d+$/.test(line)) {
          continue;
        } else {
          current.push(line);
        }
      }
      flush();
      return out;
    };

    const discoverCaptions = async () => {
      const html = doc.documentElement.innerHTML || '';
      const domResourceUrls = [
        ...[...doc.querySelectorAll('iframe, video, source, track, script')].flatMap(el => [
          el.src,
          el.getAttribute('src'),
          el.getAttribute('data-src'),
        ]),
      ].filter(Boolean);
      const sources = [html, ...domResourceUrls];
      const combined = sources.join('\\n');
      const decodedCombined = sources.map(x => {
        try {
          return decodeURIComponent(x);
        } catch (_) {
          return x;
        }
      }).join('\\n');
      const searchText = combined + '\\n' + decodedCombined;

      const ids = new Set();
      const addMatches = pattern => {
        for (const match of searchText.matchAll(pattern)) {
          if (match[1]) ids.add(match[1].toLowerCase());
        }
      };
      addMatches(/\\/embed\\/iframe\\/([a-z0-9]{8,14})/ig);
      addMatches(/\\/embed\\/medias\\/([a-z0-9]{8,14})/ig);
      addMatches(/\\/embed\\/captions\\/([a-z0-9]{8,14})/ig);
      addMatches(/wistia_async_([a-z0-9]{8,14})/ig);
      addMatches(/(?:data-wistia-id|media-id)=["']([a-z0-9]{8,14})["']/ig);

      const directCaptionUrls = [...new Set(domResourceUrls.filter(url =>
        /\\/embed\\/captions\\//i.test(url) || /\\.(vtt)(\\?|$)/i.test(url)
      ))];
      const languages = ['chi', 'zho', 'zh-TW', 'zh', 'eng', 'en'];
      const captions = [];

      const fetchCaption = async (url, mediaId = '', language = '') => {
        try {
          const resp = await fetch(url);
          if (!resp.ok) return null;
          const text = await resp.text();
          let lines = [];
          let raw = text;
          let format = 'text';
          if (/\\.vtt(\\?|$)/i.test(url) || /WEBVTT/i.test(text.slice(0, 100))) {
            format = 'vtt';
            lines = captionLinesFromVtt(text);
          } else {
            try {
              raw = JSON.parse(text);
              format = 'json';
              lines = captionLinesFromJson(raw);
            } catch (_) {
              lines = captionLinesFromVtt(text);
            }
          }
          if (!lines.length) return null;
          return { url, mediaId, language, format, raw, lines };
        } catch (_) {
          return null;
        }
      };

      for (const url of directCaptionUrls) {
        const mediaMatch = url.match(/\\/embed\\/captions\\/([^/.?]+)/i);
        const langMatch = url.match(/[?&]language=([^&]+)/i);
        const cap = await fetchCaption(url, mediaMatch?.[1] || '', langMatch?.[1] || '');
        if (cap) captions.push(cap);
      }

      const seenMedia = new Set(captions.map(x => x.mediaId).filter(Boolean));
      for (const mediaId of ids) {
        if (seenMedia.has(mediaId)) continue;
        for (const lang of languages) {
          const candidates = [
            \`https://fast.wistia.net/embed/captions/\${mediaId}.json?language=\${lang}\`,
            \`https://fast.wistia.net/embed/captions/\${mediaId}.vtt?language=\${lang}\`,
          ];
          let found = null;
          for (const url of candidates) {
            found = await fetchCaption(url, mediaId, lang);
            if (found) break;
          }
          if (found) {
            captions.push(found);
            break;
          }
        }
      }

      const seen = new Set();
      return captions.filter(cap => {
        const key = cap.mediaId || cap.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const title =
      doc.querySelector('h1')?.innerText?.trim() ||
      doc.title ||
      'Lesson';

    const main =
      doc.querySelector('main.lesson-main') ||
      doc.querySelector('.page__content') ||
      doc.body;

    const baseText = (main.innerText || doc.body.innerText || '')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();

    const tabChunks = await clickAllTabs();
    const links = [...main.querySelectorAll('a[href]')]
      .map(a => ({ text: (a.innerText || '').trim().replace(/\\s+/g, ' '), href: a.href }))
      .filter(x => x.href && !x.href.includes('#/lessons/'));

    const downloadablePattern = /\\.(pdf|zip|7z|rar|docx?|xlsx?|pptx?|csv|txt|json|xaml|nupkg|uipx|zipx)($|[?#])/i;
    const attachments = links.filter(x =>
      downloadablePattern.test(x.href) ||
      /\\b(download|resource|attachment|exercise|template|sample|file)\\b/i.test(x.text) ||
      /\\b\\d+(\\.\\d+)?\\s*(KB|MB|GB)\\b/i.test(x.text)
    );
    const normalLinks = links.filter(x => !attachments.some(a => a.href === x.href));
    const scribeEmbeds = [...main.querySelectorAll('iframe[src*="scribehow.com/embed"], iframe[src*="scribehow.com/o/"]')]
      .map(frame => ({
        src: frame.src || frame.getAttribute('src') || '',
        title: frame.title || frame.getAttribute('title') || '',
      }))
      .filter(x => x.src);
    const captions = await discoverCaptions();
    const courseQuizQuestions = await extractQuizQuestionsFromCourse();
    const quizQuestions = courseQuizQuestions.length ? courseQuizQuestions : extractQuizQuestionsFromDom();
    const riseInteractions = await extractRiseInteractionsFromCourse();

    return {
      url: win.location.href,
      title,
      text: [baseText, ...tabChunks].filter(Boolean).join('\\n\\n---\\n\\n'),
      links: normalLinks,
      attachments,
      scribeEmbeds,
      captions,
      quizQuestions,
      riseInteractions,
    };
  })()`);

  const filename = `${String(i + 1).padStart(2, "0")}_${safeFilename(lesson.title, 90)}.md`;

  const interactiveWalkthroughs = [];
  for (let scribeIndex = 0; scribeIndex < (lesson.scribeEmbeds || []).length; scribeIndex++) {
    const embed = lesson.scribeEmbeds[scribeIndex];
    console.log(`  Scribe ${scribeIndex + 1}/${lesson.scribeEmbeds.length}: ${embed.src}`);
    const walkthrough = await scrapeScribeWalkthrough(embed);
    if (walkthrough) {
      interactiveWalkthroughs.push(walkthrough);
      const rawName = `${String(i + 1).padStart(2, "0")}_${safeFilename(walkthrough.title || `scribe_${scribeIndex + 1}`, 80)}.json`;
      fs.writeFileSync(path.join(walkthroughDir, rawName), JSON.stringify(walkthrough, null, 2), "utf8");
    }
  }

  const downloadedFiles = [];
  for (let attachmentIndex = 0; attachmentIndex < (lesson.attachments || []).length; attachmentIndex++) {
    const attachment = lesson.attachments[attachmentIndex];
    const prefix = `${String(i + 1).padStart(2, "0")}_${String(attachmentIndex + 1).padStart(2, "0")}`;
    console.log(`  Download ${attachmentIndex + 1}/${lesson.attachments.length}: ${attachment.href}`);
    downloadedFiles.push(await downloadAttachment(attachment, downloadsDir, prefix));
  }

  lesson.interactiveWalkthroughs = interactiveWalkthroughs;
  lesson.downloadedFiles = downloadedFiles;

  const md = markdownForLesson(i + 1, lesson);
  fs.writeFileSync(path.join(lessonDir, filename), md, "utf8");

  for (let capIndex = 0; capIndex < (lesson.captions || []).length; capIndex++) {
    const cap = lesson.captions[capIndex];
    const rawName = `${String(i + 1).padStart(2, "0")}_${safeFilename(cap.mediaId || `caption_${capIndex + 1}`, 50)}_${safeFilename(cap.language || "unknown", 20)}`;
    const suffix = cap.format === "vtt" ? ".vtt" : ".json";
    const rawValue = typeof cap.raw === "string" ? cap.raw : JSON.stringify(cap.raw ?? cap.lines, null, 2);
    fs.writeFileSync(path.join(rawCaptionDir, rawName + suffix), rawValue, "utf8");
  }

  lessonsOut.push({ ...lesson, filename, markdown: md });
}

const full = [];
full.push(`# ${meta.courseTitle}`);
full.push("");
for (const lesson of lessonsOut) {
  full.push(lesson.markdown.trim());
  full.push("");
  full.push("---");
  full.push("");
}

fs.writeFileSync(path.join(courseDir, "full_course.md"), full.join("\n").trim() + "\n", "utf8");
fs.writeFileSync(
  path.join(courseDir, "scorm_scrape_report.json"),
  JSON.stringify({ meta, lessons: lessonsOut.map(({ markdown, ...x }) => x) }, null, 2),
  "utf8"
);

client.close();
console.log("Done:", courseDir);
