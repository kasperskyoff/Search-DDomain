// index.mjs
// По одному домену на входе пытается найти связанные домены:
// - редиректы
// - ссылки/ресурсы из HTML (несколько внутренних страниц)
// - canonical/og:site_name для понимания "ядра"
// - SAN из TLS-сертификатов
// - CNAME из DNS
// - CT-логи (crt.sh) для субдоменов исходного eTLD+1 (опционально)
// Без зависимостей. Node 18+ (есть fetch).
// Сделан для программ которые обходят ограничения РКН.

import tls from 'node:tls';
import dns from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

// ---------------------- ПАРАМЕТРЫ ----------------------
const args = process.argv.slice(2).filter(Boolean);
if (args.length === 0) {
  console.error('Использование: node index.mjs <domain> [--maxPages 12] [--timeout 8000] [--concurrency 4]');
  process.exit(1);
}
const seedInput = args[0].toLowerCase().trim();
const MAX_PAGES = parseInt(getArg('--maxPages', '12'), 10);
const REQ_TIMEOUT = parseInt(getArg('--timeout', '8000'), 10);
const CONCURRENCY = parseInt(getArg('--concurrency', '4'), 10);

// ---------------------- УТИЛИТЫ ------------------------
function getArg(flag, def) {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}

function normalizeHost(host) {
  try {
    return host.toLowerCase().replace(/\.$/, '');
  } catch {
    return host.toLowerCase();
  }
}

// Очень приблизительный eTLD+1. Для «всех сайтов мира» лучше tldts.
function getETLDPlusOne(host) {
  const h = normalizeHost(host);
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // Простейшие PSL-исключения
  const commonMulti = new Set([
    'co.uk','org.uk','gov.uk','ac.uk','co.jp','com.au','net.au','com.br','com.cn','com.tr','com.mx'
  ]);
  const last2 = parts.slice(-2).join('.');
  const last3 = parts.slice(-3).join('.');
  if (commonMulti.has(last2)) return parts.slice(-3).join('.');
  if (commonMulti.has(last3)) return parts.slice(-4).join('.');
  return last2;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function withTimeout(promise, ms, label = 'request') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toAbsolute(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function extractHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function looksLikeAsset(url) {
  return /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|mp4|m3u8|mpd|webm|ogg|mp3|json)(\?|#|$)/i.test(url);
}

// Примитивный парсинг HTML: ссылки, ресурсы, canonical, og:site_name
function parseHtml(html, baseUrl) {
  const links = [];
  const assets = [];
  const metas = { canonical: null, ogSiteName: null, title: null };

  // title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) metas.title = titleMatch[1].trim();

  // canonical
  const canonicalMatch = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i);
  if (canonicalMatch) {
    const hrefMatch = canonicalMatch[0].match(/href=["']([^"']+)["']/i);
    if (hrefMatch) metas.canonical = toAbsolute(baseUrl, hrefMatch[1]);
  }

  // og:site_name
  const reOg = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/ig;
  let m;
  while ((m = reOg.exec(html)) !== null) {
    metas.ogSiteName = (m[1] || '').trim();
  }

  const reAttr = /\b(?:href|src)=["']([^"']+)["']/ig;
  while ((m = reAttr.exec(html)) !== null) {
    const abs = toAbsolute(baseUrl, m[1]);
    if (!abs || !isHttpUrl(abs)) continue;
    if (looksLikeAsset(abs)) assets.push(abs);
    else links.push(abs);
  }

  return { links: uniq(links), assets: uniq(assets), metas };
}

// Ограниченная очередь
class Queue {
  constructor(concurrency = 4) {
    this.c = concurrency;
    this.running = 0;
    this.q = [];
  }
  push(task) {
    return new Promise((resolve, reject) => {
      this.q.push({ task, resolve, reject });
      this._run();
    });
  }
  _run() {
    while (this.running < this.c && this.q.length) {
      const { task, resolve, reject } = this.q.shift();
      this.running++;
      task().then(resolve, reject).finally(() => {
        this.running--;
        this._run();
      });
    }
  }
}

// ---------------------- СЕТЬ ---------------------------
const UA = 'Domain-Discovery-Bot/1.0 (+https://example.com; contact: admin@example.com)';

async function httpGet(url) {
  const res = await withTimeout(fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'manual',
  }), REQ_TIMEOUT, `GET ${url}`);
  return res;
}

async function fetchFollowRedirects(url, maxHops = 10) {
  const chain = [];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await httpGet(current);
    chain.push({ url: current, status: res.status, location: res.headers.get('location') || null });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = toAbsolute(current, res.headers.get('location'));
      if (!next || !isHttpUrl(next)) break;
      if (chain.some(x => x.url === next)) break; // цикл
      current = next;
      continue;
    }
    break;
  }
  return chain;
}

async function fetchHtml(url) {
  const res = await withTimeout(fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow'
  }), REQ_TIMEOUT, `GET ${url}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html')) return { html: '', finalUrl: res.url, status: res.status };
  const html = await res.text();
  return { html, finalUrl: res.url, status: res.status };
}

async function getCertSANs(host, port = 443) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: REQ_TIMEOUT }, () => {
      const cert = socket.getPeerCertificate();
      const san = cert && cert.subjectaltname ? cert.subjectaltname : '';
      socket.end();
      const names = [];
      for (const part of san.split(',')) {
        const m = part.trim().match(/DNS:([*a-z0-9.-]+)/i);
        if (m) names.push(m[1].toLowerCase());
      }
      resolve(uniq(names));
    });
    socket.on('error', () => resolve([]));
    socket.on('timeout', () => { socket.destroy(); resolve([]); });
  });
}

async function getCNAMEChain(host) {
  const out = [];
  let current = host;
  for (let i = 0; i < 5; i++) {
    try {
      const cname = await dns.resolveCname(current);
      if (!cname || cname.length === 0) break;
      const next = normalizeHost(cname[0]);
      out.push(next);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return out;
}

async function getCTLogSubdomains(baseDomain) {
  // crt.sh JSON может дублировать записи, ограничим и обезопасим
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(baseDomain)}&output=json`;
  try {
    const res = await withTimeout(fetch(url, { headers: { 'User-Agent': UA } }), REQ_TIMEOUT, `GET ${url}`);
    if (!res.ok) return [];
    const json = await res.json();
    const names = new Set();
    for (const r of json) {
      const cn = (r['common_name'] || '').toLowerCase();
      const sans = (r['name_value'] || '').toLowerCase().split('\n');
      if (cn.endsWith(`.${baseDomain}`) || cn === baseDomain) names.add(cn);
      for (const s of sans) {
        const h = s.trim();
        if (!h) continue;
        if (h.endsWith(`.${baseDomain}`) || h === baseDomain) names.add(h);
      }
      if (names.size > 5000) break; // сохранения
    }
    return [...names];
  } catch {
    return [];
  }
}

// ---------------------- ЛОГИКА ОЦЕНКИ ------------------
function scoreSystem() {
  const map = new Map(); // host -> {score, reasons:Set}
  function add(host, points, reason) {
    host = normalizeHost(host);
    const v = map.get(host) || { score: 0, reasons: new Set() };
    v.score += points;
    if (reason) v.reasons.add(reason);
    map.set(host, v);
  }
  function topSorted() {
    return [...map.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .map(([host, v]) => ({ host, score: v.score, reasons: [...v.reasons] }));
  }
  return { add, topSorted };
}

// ---------------------- ОСНОВНОЕ ------------------------
async function main() {
  const seedHost = normalizeHost(seedInput.replace(/^https?:\/\//, ''));
  const seedHttp = `http://${seedHost}/`;
  const seedHttps = `https://${seedHost}/`;

  const scores = scoreSystem();
  const candidateHosts = new Set([seedHost]);

  // 1) Редиректы (http и https старт)
  const chains = [];
  for (const start of [seedHttp, seedHttps]) {
    try {
      const ch = await fetchFollowRedirects(start);
      chains.push(ch);
      for (const step of ch) {
        const h = extractHost(step.url);
        if (h) {
          candidateHosts.add(h);
          scores.add(h, 5, 'redirect-chain');
        }
        if (step.location) {
          const h2 = extractHost(toAbsolute(step.url, step.location));
          if (h2) {
            candidateHosts.add(h2);
            scores.add(h2, 8, 'redirect-target');
          }
        }
      }
    } catch {}
  }

  // 2) HTML нескольких внутренних страниц на финальном хосте(ах)
  const coreHosts = uniq([...candidateHosts]);
  const crawlQueue = new Queue(CONCURRENCY);
  const visited = new Set();
  const toVisit = new Set();

  // Выбираем хост(ы) с максимальными баллами как ядро
  const coreSorted = coreHosts.sort((a, b) => {
    const sa = (scores.topSorted().find(x => x.host === a)?.score) || 0;
    const sb = (scores.topSorted().find(x => x.host === b)?.score) || 0;
    return sb - sa;
  });
  const seedCore = coreSorted[0] || seedHost;

  toVisit.add(`https://${seedCore}/`);

  const foundUrls = new Set();
  const foundHostsFromPages = new Map(); // host -> {links, assets}

  let brandTokens = new Set();
  let visitedCount = 0;

  async function visit(url) {
    visited.add(url);
    const { html, finalUrl } = await fetchHtml(url);
    foundUrls.add(finalUrl);
    const pageHost = extractHost(finalUrl);
    if (pageHost) {
      scores.add(pageHost, 3, 'page-load');
      candidateHosts.add(pageHost);
    }
    if (!html) return;

    const { links, assets, metas } = parseHtml(html, finalUrl);

    const brandCandidates = [];
    if (metas.title) brandCandidates.push(metas.title);
    if (metas.ogSiteName) brandCandidates.push(metas.ogSiteName);
    brandCandidates
      .flatMap(s => s.split(/[|—\-–•·:]+/g))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach(t => brandTokens.add(t.toLowerCase()));

    if (metas.canonical) {
      const ch = extractHost(metas.canonical);
      if (ch) {
        candidateHosts.add(ch);
        scores.add(ch, 7, 'canonical');
      }
    }

    const all = uniq([...links, ...assets]);
    for (const u of all) {
      const h = extractHost(u);
      if (!h) continue;

      const rec = foundHostsFromPages.get(h) || { links: 0, assets: 0 };
      if (looksLikeAsset(u)) rec.assets++;
      else rec.links++;
      foundHostsFromPages.set(h, rec);

      candidateHosts.add(h);
      const pts = looksLikeAsset(u) ? 2 : 3;
      scores.add(h, pts, looksLikeAsset(u) ? 'asset-ref' : 'link-ref');

      // Планируем поверхностный обход только того же eTLD+1
      const sameSite = getETLDPlusOne(h) === getETLDPlusOne(seedCore);
      if (sameSite && !visited.has(u) && toVisit.size + visited.size < MAX_PAGES) {
        // внутренние страницы
        const pathOk = /^https:/.test(u) && !/\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|mp4|m3u8|mpd|webm|ogg|mp3|json)(\?|#|$)/i.test(u);
        if (pathOk) toVisit.add(u);
      }
    }
  }

  while (toVisit.size && visitedCount < MAX_PAGES) {
    const batch = [...toVisit].slice(0, CONCURRENCY);
    batch.forEach(u => toVisit.delete(u));
    const tasks = batch.map(u => crawlQueue.push(() => visit(u).catch(() => {})));
    await Promise.all(tasks);
    visitedCount += batch.length;
  }

  // 3) TLS SANs для самых значимых хостов
  const sanTargets = [...candidateHosts].slice(0, 10);
  for (const host of sanTargets) {
    const sans = await getCertSANs(host);
    for (const s of sans) {
      // Отбрасываем wildcard-шаблоны до хоста
      const h = s.replace(/^\*\./, '');
      candidateHosts.add(h);
      scores.add(h, 4, 'tls-san');
    }
  }

  // 4) CNAME цепочки
  for (const host of [...candidateHosts].slice(0, 20)) {
    const cnames = await getCNAMEChain(host);
    for (const c of cnames) {
      candidateHosts.add(c);
      scores.add(c, 3, 'cname');
    }
  }

  // 5) CT-логи для eTLD+1 исходника (субдомены)
  const base = getETLDPlusOne(seedHost);
  const ctSubs = await getCTLogSubdomains(base);
  for (const h of ctSubs) {
    candidateHosts.add(h);
    scores.add(h, 2, 'ct-log');
  }

  // ---------------------- ФИЛЬТРАЦИЯ (уберу скоро, наверн)--------------------
  // Эвристика "свои" vs "внешние":
  // - + сильные сигналы: redirect-target, canonical, page-load
  // - + часто встречающиеся в ссылках/ресурсах
  // - + shared eTLD+1 с основным
  // - + домены, на которые часто указывают preconnect/dns-prefetch (часто статика/шортенеры бренда)
  // - - уберём явные трекеры/большие CDN (можно расширить список)
  const NEGATIVE_SUFFIXES = [
    'googletagmanager.com','google-analytics.com','doubleclick.net','facebook.net','facebook.com',
    'googlesyndication.com','adnxs.com','scorecardresearch.com','mathtag.com','criteo.com','quantserve.com',
    'cloudflareinsights.com'
  ];

  const coreBase = getETLDPlusOne(seedCore);
  const stats = scores.topSorted();

  const result = stats
    .filter(({ host }) => {
      if (!host) return false;
      const baseH = getETLDPlusOne(host);

      // минус крупные общеизвестные аналитики
      if (NEGATIVE_SUFFIXES.some(suf => host.endsWith(suf))) return false;

      // баллы и причины
      const item = stats.find(x => x.host === host);
      const reasons = new Set(item?.reasons || []);

      const rec = foundHostsFromPages.get(host) || { links: 0, assets: 0 };
      const freq = rec.links + rec.assets;

      // Сильные положительные
      const strong = ['redirect-target', 'canonical'].some(r => reasons.has(r));

      // Считаем "своими", если:
      // - тот же eTLD+1, ИЛИ
      // - сильный сигнал (редирект/каноникал), ИЛИ
      // - высокая частота встречаемости на страницах, ИЛИ
      // - явно попали через TLS SAN/CNAME и ещё присутствуют в страницах
      const likelyOwned =
        baseH === coreBase ||
        strong ||
        freq >= 3 ||
        (reasons.has('tls-san') && freq >= 1) ||
        (reasons.has('cname') && freq >= 1);

      return likelyOwned;
    })
    .map(x => x.host);

  // Итоговая сортировка:
  // - выше те, у кого больше баллов; далее — алфавит
  const finalSorted = uniq(result).sort((a, b) => {
    const sa = stats.find(x => x.host === a)?.score || 0;
    const sb = stats.find(x => x.host === b)?.score || 0;
    if (sb !== sa) return sb - sa;
    return a.localeCompare(b);
  });

  for (const h of finalSorted) {
    console.log(h);
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
