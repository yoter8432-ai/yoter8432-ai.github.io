import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());

const PAGE_URL = process.env.PAGE_URL || "https://example.com"; // <-- замени на реальный источник
const SELECTOR_ITEM = process.env.S_ITEM || ".region";          // карточка области
const SELECTOR_NAME = process.env.S_NAME || ".region-name";     // текст названия
const SELECTOR_ALERT = process.env.S_ALERT || ".is-alert";      // если элемент/класс существует -> тревога

let lastSnapshot = { ts: 0, states: [] };

function isAlertForHandle(el, selector) {
  const found = el.querySelector(selector);
  if (!found) return false;
  return true;
}

async function scrapeOnce(page) {
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  // иногда сайты дорисовывают данные — подождём немного
  await page.waitForTimeout(800);

  const states = await page.$$eval(SELECTOR_ITEM, (items, sName, sAlert) => {
    function txt(n){ return (n?.textContent || "").trim(); }
    function isOn(el, sel){
      const found = el.querySelector(sel);
      return !!found;
    }
    return items.map((el, idx) => {
      const nameEl = el.querySelector(sName);
      const name = txt(nameEl) || `Область #${idx+1}`;
      const alert = isOn(el, sAlert);
      return { id: idx+1, name, alert, changed: new Date().toISOString() };
    });
  }, SELECTOR_NAME, SELECTOR_ALERT);

  return { ts: Date.now(), states };
}

// Фоновый «поллер» раз в 10 сек
let browser, page;
async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({ args: ["--no-sandbox"] });
  if (!page) page = await browser.newPage();
}
async function poll() {
  try {
    await ensureBrowser();
    const snap = await scrapeOnce(page);
    // Если есть изменения, обновим снапшот
    const changed =
      snap.states.length !== lastSnapshot.states.length ||
      snap.states.some((s, i) => s.alert !== (lastSnapshot.states[i]?.alert));

    if (changed) {
      // проставим корректный changed для изменившихся
      snap.states = snap.states.map((s, i) => {
        const prev = lastSnapshot.states[i];
        if (!prev || prev.alert !== s.alert) return { ...s, changed: new Date().toISOString() };
        return { ...s, changed: prev.changed };
      });
      lastSnapshot = snap;
      broadcast(JSON.stringify({ type: "states", data: lastSnapshot }));
    }
  } catch (e) {
    // не роняем сервер — просто лог и новый заход
    console.error("poll error:", e.message);
  }
}
setInterval(poll, 10_000);
poll(); // первый запуск

// SSE для фронта
const clients = new Set();
app.get("/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);

  // отправим текущее состояние при подключении
  if (lastSnapshot.states.length) {
    res.write(`data: ${JSON.stringify({ type: "states", data: lastSnapshot })}\n\n`);
  }

  req.on("close", () => clients.delete(res));
});
function broadcast(payload) {
  for (const res of clients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}

// REST «на всякий случай»
app.get("/states", (req, res) => res.json(lastSnapshot));

// Статика (наш фронтенд)
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
