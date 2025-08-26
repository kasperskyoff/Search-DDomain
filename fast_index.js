// fast_index.js (ESM)
// Данный файл тестовый, может и плохо работать

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

if (isMainThread) {
  const args = process.argv.slice(2);
  const startDomain = args[0];
  const useDelay = args.includes('--delay');

  if (!startDomain) {
    console.error('Использование: node fast_index.js example.com [--delay]');
    process.exit(1);
  }

  const visited = new Set();
  const foundHosts = new Set();
  const maxRequests = 300;
  let requestCount = 0;
  const maxRedirects = 5;
  const maxParallel = 50;
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

  async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetch(url, redirectCount = 0) {
    if (redirectCount > maxRedirects) return '';
    if (useDelay) await delay(Math.random() * 400 + 100);

    return new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { url, redirectCount } });
      worker.on('message', resolve);
      worker.on('error', () => resolve(''));
      worker.on('exit', () => resolve(''));
    });
  }

  async function crawl(hostname, depth, maxDepth) {
    if (depth > maxDepth || visited.has(hostname) || requestCount >= maxRequests) return;
    visited.add(hostname);
    requestCount++;

    const html = await fetch('https://' + hostname);
    if (!html) return;

    const links = html.match(/(?:href|src|content|data-url|data-src|srcset)=["']([^"']+)["']/g) || [];
    links.forEach(link => {
      const match = link.match(/["']([^"']+)["']/);
      if (match && match[1]) {
        let href = match[1].trim();
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

    // Мы тут конечно фильтруем
    const related = [...foundHosts].filter(h => typeof h === 'string' && h.endsWith(startDomain) && !visited.has(h));
    const chunks = [];
    for (let i = 0; i < related.length; i += maxParallel) {
      chunks.push(related.slice(i, i + maxParallel));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(h => crawl(h, depth + 1, maxDepth)));
    }
  }

  function processLink(href, hostname) {
    try {
      if (!href || typeof href !== 'string') return; // Защита от мусора
      const urlObj = new URL(href.startsWith('http') ? href : 'https://' + hostname + (href.startsWith('/') ? '' : '/') + href);
      const foundHost = urlObj.hostname;
      if (foundHost && typeof foundHost === 'string' && foundHost.endsWith(startDomain) && !visited.has(foundHost) && !foundHosts.has(foundHost)) {
        foundHosts.add(foundHost);
      }
    } catch (e) {}
  }

  async function fetchFromCrtSh(domain, retry = 0) {
    const url = `https://crt.sh/?q=%25.${domain}&output=json`;
    const data = await fetch(url);
    if (!data || data.startsWith('<')) {
      if (retry < 1) {
        if (useDelay) await delay(5000);
        return fetchFromCrtSh(domain, retry + 1);
      }
      return;
    }

    try {
      const entries = JSON.parse(data);
      if (Array.isArray(entries)) {
        entries.forEach(entry => {
          if (entry && entry.name_value) {
            const names = entry.name_value.split('\n');
            names.forEach(name => {
              name = name.trim();
              if (name && typeof name === 'string' && name.endsWith(domain) && !name.startsWith('*.')) {
                foundHosts.add(name);
              }
            });
          }
        });
      }
    } catch (e) {}
  }

  (async () => {
    foundHosts.add(startDomain);
    await fetchFromCrtSh(startDomain);
    await crawl(startDomain, 0, 7);

    const uniqueHosts = [...foundHosts].filter(h => typeof h === 'string').sort();
    console.log(`Найдено ${uniqueHosts.length} доменов/поддоменов:`);
    console.log(uniqueHosts.join('\n'));
  })();

} else {
  const { url, redirectCount } = workerData;

  function fetchWorker(url, redirectCount) {
    return new Promise((resolve) => {
      try {
        const client = url.startsWith('https') ? https : http;
        const options = {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8,application/json'
          }
        };

        const req = client.get(url, options, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, url).href;
            fetchWorker(redirectUrl, redirectCount + 1).then(resolve);
            return;
          }

          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });

        req.on('error', () => resolve(''));
        req.on('timeout', () => {
          req.destroy();
          resolve('');
        });
      } catch (e) {
        resolve('');
      }
    });
  }

  fetchWorker(url, redirectCount).then(result => {
    parentPort.postMessage(result);
  }).catch(() => {
    parentPort.postMessage('');
  });
}
