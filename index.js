// index.js (ESM)

import https from 'https';
import http from 'http';
import { URL } from 'url';

const args = process.argv.slice(2); // Более надёжный парсинг аргументов
const startDomain = args[0]; // Первый аргумент

if (!startDomain) {
  console.error('Использование: node index.js example.com');
  process.exit(1);
}
console.log(`Стартовый домен: ${startDomain}`); // Лог для проверки

const visited = new Set();
const foundHosts = new Set();
const maxRequests = 300;
let requestCount = 0;
const maxRedirects = 5;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetch(url, redirectCount = 0) {
  if (redirectCount > maxRedirects) return '';
  await delay(Math.random() * 4000 + 1000);
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      timeout: 10000,
      headers: { 
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8,application/json'
      }
    };
    client.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        resolve(fetch(redirectUrl, redirectCount + 1));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function crawl(hostname, depth, maxDepth) {
  if (depth > maxDepth || visited.has(hostname) || requestCount >= maxRequests) return;
  visited.add(hostname);
  requestCount++;
  
  console.log(`Краулинг: ${hostname} (глубина ${depth})`);
  
  const html = await fetch('https://' + hostname);
  if (!html) return;

  // Улучшенный парсинг: захватываем href, src, content, data-url, srcset и т.д.
  const links = html.match(/(?:href|src|content|data-url|data-src|srcset)=["']([^"']+)["']/g) || [];
  links.forEach(link => {
    const match = link.match(/["']([^"']+)["']/);
    if (match) {
      let href = match[1].trim();
      // Для srcset: разбиваем на части
      if (link.includes('srcset')) {
        href.split(',').forEach(part => {
          const src = part.trim().split(' ')[0];
          processLink(src, hostname);
        });
      } else {
        processLink(href, hostname);
      }
    }
  });

  const related = [...foundHosts].filter(h => h.endsWith(startDomain) && !visited.has(h));
  for (const h of related) {
    await crawl(h, depth + 1, maxDepth);
  }
}

function processLink(href, hostname) {
  try {
    const urlObj = new URL(href.startsWith('http') ? href : 'https://' + hostname + (href.startsWith('/') ? '' : '/') + href);
    const foundHost = urlObj.hostname;
    if (foundHost.endsWith(startDomain) && !visited.has(foundHost) && !foundHosts.has(foundHost)) {
      foundHosts.add(foundHost);
      console.log(`Найден новый: ${foundHost}`);
    }
  } catch (e) {}
}

async function fetchFromCrtSh(domain, retry = 0) {
  const url = `https://crt.sh/?q=%25.${domain}&output=json`;
  const data = await fetch(url);
  if (!data || data.startsWith('<')) {
    console.error('crt.sh вернул не JSON. Возможно, CAPTCHA или ошибка сервера.');
    if (retry < 1) {
      console.log('Повторная попытка...');
      await delay(5000); // Пауза перед retry
      return fetchFromCrtSh(domain, retry + 1);
    }
    return;
  }

  try {
    const entries = JSON.parse(data);
    entries.forEach(entry => {
      const names = entry.name_value.split('\n');
      names.forEach(name => {
        name = name.trim();
        if (name.endsWith(domain) && !name.startsWith('*.')) {
          foundHosts.add(name);
        }
      });
    });
  } catch (e) {
    console.error(`Ошибка парсинга crt.sh: ${e.message}`);
  }
}

(async () => {
  foundHosts.add(startDomain);
  
  await fetchFromCrtSh(startDomain);
  
  await crawl(startDomain, 0, 7);
  
  const uniqueHosts = [...new Set([...foundHosts])].sort();
  
  console.log(`Найдено ${uniqueHosts.length} доменов/поддоменов:`);
  console.log(uniqueHosts.join('\n'));
})();
