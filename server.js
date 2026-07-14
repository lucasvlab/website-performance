const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);
const PAGESPEED_TIMEOUT_MS = Number(process.env.PAGESPEED_TIMEOUT_MS || 90000);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 1);
const MAX_LEGAL_LINKS_TO_VERIFY = 8;

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';
const PAGESPEED_STRATEGY = process.env.PAGESPEED_STRATEGY || 'mobile';
const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vlab-audit-api',
    mode: 'pagespeed-lighthouse-aligned-stable',
    time: new Date().toISOString()
  });
});

function normalizeUrl(input) {
  const raw = String(input || '').trim();

  if (!raw) {
    throw new Error('Keine URL übergeben.');
  }

  return raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
}

function safeLower(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function sameHostOrRelative(url, baseUrl) {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);

    return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyFetchError(error, status = 0) {
  const message = String(error?.message || error || '').toLowerCase();

  if ([401, 403, 406, 429, 451].includes(Number(status))) {
    return 'blocked-or-restricted';
  }

  if (error?.name === 'AbortError' || message.includes('aborted') || message.includes('timeout')) {
    return 'timeout';
  }

  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econn') ||
    message.includes('socket') ||
    message.includes('tls')
  ) {
    return 'network-or-tls';
  }

  return 'unknown-fetch-error';
}

function buildNotice(type, title, text) {
  return { type, title, text };
}

function noticeForHtmlFetch(result) {
  if (result?.ok) return null;

  const status = Number(result?.status || 0);

  if ([401, 403, 406, 451].includes(status)) {
    return buildNotice(
      'html-fetch-restricted',
      'Direkter Seitenabruf wurde blockiert',
      `Die Website hat den technischen Abruf mit Status ${status} abgelehnt. Das passiert oft durch Bot-Schutz, Web Application Firewalls, Geo-Blocking, Rechenzentrums-Blocking oder strenge Serverregeln. Performance-Werte können trotzdem über Lighthouse verfügbar sein. Inhalte, Rechtstexte, Labels und Tracking-Signale sind dann nur eingeschränkt prüfbar.`
    );
  }

  if (status === 429) {
    return buildNotice(
      'html-fetch-rate-limited',
      'Website hat zu viele Anfragen abgelehnt',
      'Der direkte Seitenabruf wurde mit Status 429 begrenzt. Bitte später erneut versuchen. Die Seite nutzt wahrscheinlich Rate Limiting oder Bot-Schutz.'
    );
  }

  if (result?.reason === 'timeout') {
    return buildNotice(
      'html-fetch-timeout',
      'Direkter Seitenabruf hat zu lange gedauert',
      'Die Website hat nicht rechtzeitig auf den technischen Abruf reagiert. Bitte später erneut versuchen oder eine konkrete Unterseite testen.'
    );
  }

  return buildNotice(
    'html-fetch-failed',
    'Direkter Seitenabruf nicht möglich',
    'Die Website konnte vom Analyse-Server nicht direkt geladen werden. Mögliche Ursachen sind Bot-Schutz, TLS-Probleme, Redirect-Probleme, temporäre Serverprobleme oder blockierte Rechenzentrums-IP-Adressen. Bitte später erneut versuchen.'
  );
}

function noticeForPageSpeed(error) {
  if (!error) return null;

  const message = String(error?.message || error || '').toLowerCase();

  if (error?.name === 'AbortError' || message.includes('aborted') || message.includes('timeout')) {
    return buildNotice(
      'pagespeed-timeout',
      'Lighthouse hat zu lange gedauert',
      'Der Performance-Check wurde wegen Zeitüberschreitung beendet. Bitte später erneut versuchen. Bei wiederholtem Auftreten sollte der PageSpeed-Timeout im Backend erhöht werden.'
    );
  }

  if (
    message.includes('quota') ||
    message.includes('rate') ||
    message.includes('429') ||
    message.includes('resource exhausted')
  ) {
    return buildNotice(
      'pagespeed-rate-limit',
      'Lighthouse API ist gerade begrenzt',
      'Die PageSpeed/Lighthouse API ist ausgelastet oder das API-Limit wurde erreicht. Bitte später erneut versuchen.'
    );
  }

  return buildNotice(
    'pagespeed-failed',
    'Lighthouse konnte nicht abgeschlossen werden',
    'Der Performance-Check konnte nicht abgeschlossen werden. Mögliche Ursachen sind ein temporärer API-Fehler, Bot-Schutz, sehr lange Ladezeiten oder blockierte Ressourcen.'
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  const { timeout, retries, ...fetchOptions } = options;

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const retries = Number(options.retries ?? FETCH_RETRIES);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        timeout: options.timeout || REQUEST_TIMEOUT_MS,
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          ...options.headers
        }
      });

      const text = await response.text().catch(() => '');

      return {
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        headers: response.headers,
        text,
        reason: response.ok ? null : classifyFetchError(null, response.status)
      };
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await wait(700 + attempt * 700);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: 0,
    url,
    headers: null,
    text: '',
    error: lastError?.message || 'fetch failed',
    reason: classifyFetchError(lastError, 0)
  };
}

function msToDisplay(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '-';

  const value = Number(ms);

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} s`;
  }

  return `${Math.round(value)} ms`;
}

function scoreToInt(score) {
  if (typeof score !== 'number') return 0;

  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

function getAuditNumber(audits, key) {
  const audit = audits && audits[key];

  if (!audit) return null;

  if (typeof audit.numericValue === 'number') {
    return audit.numericValue;
  }

  return null;
}

function getAuditDisplay(audits, key) {
  const audit = audits && audits[key];

  if (!audit) return '-';

  return audit.displayValue || msToDisplay(audit.numericValue);
}

function getCruxMetric(json, key) {
  return (
    json?.loadingExperience?.metrics?.[key] ||
    json?.originLoadingExperience?.metrics?.[key] ||
    null
  );
}

async function runPageSpeed(url) {
  const requestUrl = new URL(PAGESPEED_ENDPOINT);

  requestUrl.searchParams.set('url', url);
  requestUrl.searchParams.set('strategy', PAGESPEED_STRATEGY);
  requestUrl.searchParams.set('locale', 'de_DE');

  requestUrl.searchParams.append('category', 'performance');
  requestUrl.searchParams.append('category', 'accessibility');
  requestUrl.searchParams.append('category', 'best-practices');
  requestUrl.searchParams.append('category', 'seo');

  if (PAGESPEED_API_KEY) {
    requestUrl.searchParams.set('key', PAGESPEED_API_KEY);
  }

  const response = await fetchWithTimeout(requestUrl.toString(), {
    timeout: PAGESPEED_TIMEOUT_MS,
    headers: {
      accept: 'application/json'
    }
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message = json?.error?.message || `PageSpeed API Fehler ${response.status}`;
    throw new Error(message);
  }

  const lighthouse = json.lighthouseResult || {};
  const audits = lighthouse.audits || {};
  const categories = lighthouse.categories || {};

  const cruxInp = getCruxMetric(json, 'INTERACTION_TO_NEXT_PAINT');
  const cruxLcp = getCruxMetric(json, 'LARGEST_CONTENTFUL_PAINT_MS');
  const cruxFcp = getCruxMetric(json, 'FIRST_CONTENTFUL_PAINT_MS');
  const cruxCls = getCruxMetric(json, 'CUMULATIVE_LAYOUT_SHIFT_SCORE');

  const tbt = getAuditNumber(audits, 'total-blocking-time');

  const inpValue =
    cruxInp?.percentile !== undefined
      ? `${Math.round(cruxInp.percentile)} ms`
      : tbt !== null
        ? `${Math.round(tbt)} ms*`
        : '-';

  const inpSource =
    cruxInp?.percentile !== undefined
      ? 'crux-inp'
      : tbt !== null
        ? 'lighthouse-tbt-proxy'
        : 'not-available';

  const lighthouseTtfb = getAuditNumber(audits, 'server-response-time');
  const lighthouseLcp = getAuditNumber(audits, 'largest-contentful-paint');
  const lighthouseFcp = getAuditNumber(audits, 'first-contentful-paint');
  const lighthouseCls = getAuditNumber(audits, 'cumulative-layout-shift');

  return {
    id: json.id || url,
    finalUrl: lighthouse.finalUrl || json.id || url,
    lighthouseVersion: lighthouse.lighthouseVersion || null,
    fetchTime: lighthouse.fetchTime || null,
    strategy: PAGESPEED_STRATEGY,

    scores: {
      performance: {
        mobile: scoreToInt(categories.performance?.score)
      },
      accessibility: {
        mobile: scoreToInt(categories.accessibility?.score)
      },
      seo: {
        mobile: scoreToInt(categories.seo?.score)
      },
      bestPractices: {
        mobile: scoreToInt(categories['best-practices']?.score)
      },
      legal: {
        mobile: 0
      }
    },

    vitals: {
      estimated: false,
      hasCruxData: Boolean(json.loadingExperience?.metrics || json.originLoadingExperience?.metrics),
      hasLighthouse: true,

      ttfb:
        lighthouseTtfb !== null
          ? msToDisplay(lighthouseTtfb)
          : '-',

      lcp:
        lighthouseLcp !== null
          ? msToDisplay(lighthouseLcp)
          : cruxLcp?.percentile
            ? msToDisplay(cruxLcp.percentile)
            : getAuditDisplay(audits, 'largest-contentful-paint'),

      fcp:
        lighthouseFcp !== null
          ? msToDisplay(lighthouseFcp)
          : cruxFcp?.percentile
            ? msToDisplay(cruxFcp.percentile)
            : getAuditDisplay(audits, 'first-contentful-paint'),

      cls:
        lighthouseCls !== null
          ? String(Number(lighthouseCls).toFixed(3)).replace(/\.000$/, '')
          : cruxCls?.percentile !== undefined
            ? String((cruxCls.percentile / 100).toFixed(3))
            : '-',

      inp: inpValue,
      inpSource,

      speedIndex: getAuditDisplay(audits, 'speed-index'),
      tbt: tbt !== null ? `${Math.round(tbt)} ms` : '-',
      source: 'pagespeed-lighthouse'
    },

    lighthouse: {
      requestedUrl: lighthouse.requestedUrl || url,
      finalUrl: lighthouse.finalUrl || null,
      lighthouseVersion: lighthouse.lighthouseVersion || null,
      runWarnings: lighthouse.runWarnings || [],
      runtimeError: lighthouse.runtimeError || null,
      audits: {
        firstContentfulPaint: audits['first-contentful-paint'] || null,
        largestContentfulPaint: audits['largest-contentful-paint'] || null,
        cumulativeLayoutShift: audits['cumulative-layout-shift'] || null,
        totalBlockingTime: audits['total-blocking-time'] || null,
        speedIndex: audits['speed-index'] || null,
        serverResponseTime: audits['server-response-time'] || null,
        interactive: audits.interactive || null
      }
    },

    crux: {
      pageOverall: json.loadingExperience?.overall_category || null,
      originOverall: json.originLoadingExperience?.overall_category || null,
      inpCategory: cruxInp?.category || null,
      inpPercentile: cruxInp?.percentile || null
    }
  };
}

function findLinksByTerms($, baseUrl, terms) {
  const found = [];
  const seen = new Set();

  $('a[href], button, [role="button"]').each((_, el) => {
    const $el = $(el);

    const rawHref =
      $el.attr('href') ||
      $el.attr('data-href') ||
      $el.attr('data-url') ||
      '';

    const text = cleanText(
      $el.text() ||
      $el.attr('aria-label') ||
      $el.attr('title') ||
      $el.attr('value') ||
      ''
    );

    const hrefText = cleanText(rawHref);
    const haystack = safeLower(`${text} ${hrefText}`);

    if (!terms.some(term => haystack.includes(term))) return;

    const href = rawHref ? absoluteUrl(rawHref, baseUrl) : null;
    const key = `${safeLower(text)}|${href || ''}`;

    if (seen.has(key)) return;
    seen.add(key);

    found.push({
      text,
      href,
      source: rawHref ? 'link' : 'button-text'
    });
  });

  return found;
}

const LEGAL_TERMS = {
  impressum: [
    'impressum',
    'anbieterkennzeichnung',
    'legal notice',
    'legal information'
  ],
  datenschutz: [
    'datenschutz',
    'datenschutzerklaerung',
    'datenschutzerklärung',
    'privacy',
    'privacy policy'
  ],
  agb: [
    'agb',
    'allgemeine geschäftsbedingungen',
    'allgemeine geschaeftsbedingungen',
    'terms',
    'terms and conditions',
    'bedingungen'
  ],
  widerruf: [
    'widerruf',
    'widerrufsrecht',
    'widerrufsbelehrung',
    'widerrufsformular',
    'widerruf formular',
    'widerruf einreichen',
    'vertrag widerrufen',
    'retoure',
    'retouren',
    'rückgabe',
    'rueckgabe',
    'rücksendung',
    'ruecksendung',
    'refund',
    'return',
    'returns',
    'return policy',
    'withdrawal',
    'right of withdrawal',
    'withdrawal form',
    'cancellation'
  ]
};

const WIDERRUF_STRONG_SIGNALS = [
  'widerrufsrecht',
  'widerrufsbelehrung',
  'widerrufsformular',
  'muster-widerrufsformular',
  'vertrag widerrufen',
  'widerruf einreichen',
  'hiermit widerrufe',
  'ausübung des widerrufsrechts',
  'ausuebung des widerrufsrechts',
  'right of withdrawal',
  'withdrawal form',
  'model withdrawal form',
  'cancellation form',
  'return policy',
  'refund policy'
];

const WIDERRUF_2026_SIGNALS = [
  'widerrufsfunktion',
  'widerrufsbutton',
  'widerrufsschaltfläche',
  'widerrufsschaltflaeche',
  'vertrag widerrufen',
  'widerruf einreichen',
  'elektronisch widerrufen'
];

function getVisiblePageText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function verifyWiderrufTarget(candidate, baseUrl) {
  const linkText = safeLower(candidate.text);
  const hrefText = safeLower(candidate.href);
  const combined = `${linkText} ${hrefText}`;

  const strongLinkHit = WIDERRUF_STRONG_SIGNALS.some(term =>
    combined.includes(term)
  );

  const buttonHit = [
    'widerruf einreichen',
    'vertrag widerrufen',
    'widerruf formular',
    'widerrufsformular'
  ].some(term => combined.includes(term));

  if (!candidate.href) {
    return {
      found: buttonHit || strongLinkHit,
      confidence: buttonHit ? 'high' : strongLinkHit ? 'medium' : 'low',
      reason: 'button-or-text-without-href'
    };
  }

  if (!sameHostOrRelative(candidate.href, baseUrl)) {
    return {
      found: strongLinkHit || buttonHit,
      confidence: strongLinkHit || buttonHit ? 'medium' : 'low',
      reason: 'external-link-not-fetched'
    };
  }

  try {
    const result = await fetchText(candidate.href, {
      timeout: REQUEST_TIMEOUT_MS
    });

    if (!result.ok) {
      return {
        found: strongLinkHit || buttonHit,
        confidence: strongLinkHit || buttonHit ? 'medium' : 'low',
        reason: `target-status-${result.status}`
      };
    }

    const pageText = safeLower(getVisiblePageText(result.text));

    const pageHasStrongSignal = WIDERRUF_STRONG_SIGNALS.some(term =>
      pageText.includes(term)
    );

    const pageHas2026Signal = WIDERRUF_2026_SIGNALS.some(term =>
      pageText.includes(term)
    );

    return {
      found: Boolean(pageHasStrongSignal || strongLinkHit || buttonHit),
      confidence: pageHasStrongSignal ? 'high' : strongLinkHit || buttonHit ? 'medium' : 'low',
      has2026Keywords: Boolean(pageHas2026Signal),
      reason: pageHasStrongSignal ? 'verified-target-page' : 'link-text-match',
      finalUrl: result.url
    };
  } catch {
    return {
      found: strongLinkHit || buttonHit,
      confidence: strongLinkHit || buttonHit ? 'medium' : 'low',
      reason: 'target-fetch-failed'
    };
  }
}

async function detectWiderruf($, baseUrl) {
  const candidates = findLinksByTerms($, baseUrl, LEGAL_TERMS.widerruf)
    .filter(link => link.href || link.text)
    .slice(0, MAX_LEGAL_LINKS_TO_VERIFY);

  for (const candidate of candidates) {
    const verified = await verifyWiderrufTarget(candidate, baseUrl);

    if (verified.found) {
      return {
        found: true,
        url: verified.finalUrl || candidate.href || null,
        linkText: candidate.text || null,
        confidence: verified.confidence,
        has2026Keywords: Boolean(
          verified.has2026Keywords ||
          WIDERRUF_2026_SIGNALS.some(term => safeLower(candidate.text).includes(term))
        ),
        riskFlag: false,
        source: verified.reason,
        candidates
      };
    }
  }

  return {
    found: false,
    url: null,
    linkText: null,
    confidence: 'none',
    has2026Keywords: false,
    riskFlag: false,
    source: 'not-detected',
    candidates
  };
}

function detectShop($, baseUrl, legal) {
  const url = safeLower(baseUrl);
  const body = safeLower($('body').text());

  const links = $('a[href]')
    .map((_, el) => `${$(el).text()} ${$(el).attr('href')}`)
    .get()
    .join(' ')
    .toLowerCase();

  const html = safeLower($.html());

  return Boolean(
    legal.agb ||
    legal.widerruf ||
    /shop|store|warenkorb|kasse|checkout|cart|product|produkt|fanshop/.test(url) ||
    /warenkorb|in den warenkorb|zur kasse|checkout|cart|add to cart|buy now|jetzt kaufen|produkt/.test(body) ||
    /\/cart|\/checkout|\/products|\/collections|\/produkt|\/shop/.test(links) ||
    /shopify|woocommerce|magento|shopware|plentymarkets|commerce|ecommerce/.test(html)
  );
}

async function getRobotsOk(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;

    const result = await fetchText(robotsUrl, {
      timeout: 6000
    });

    if (!result.ok) return false;

    const text = result.text.toLowerCase();

    return !/user-agent:\s*\*\s*disallow:\s*\//i.test(text);
  } catch {
    return false;
  }
}

function detectTrackers($, html) {
  const scripts = [];

  $('script[src]').each((_, el) => {
    scripts.push($(el).attr('src') || '');
  });

  const signatures = [
    ['Google Tag Manager', 'Tag Manager', 'hoch', ['googletagmanager.com', 'gtm.js', 'gtm-']],
    ['Google Analytics', 'Analytics', 'hoch', ['google-analytics.com', 'analytics.google.com', 'gtag/js', 'ga.js']],
    ['Google Ads', 'Marketing', 'hoch', ['googleadservices.com', 'doubleclick.net', 'ads/ga-audiences']],
    ['Meta Pixel', 'Marketing', 'hoch', ['connect.facebook.net', 'facebook.com/tr', 'fbq']],
    ['LinkedIn Insight Tag', 'Marketing', 'hoch', ['snap.licdn.com', 'linkedin.com/px']],
    ['TikTok Pixel', 'Marketing', 'hoch', ['analytics.tiktok.com']],
    ['Hotjar', 'Analytics', 'hoch', ['hotjar.com']],
    ['Microsoft Clarity', 'Analytics', 'hoch', ['clarity.ms']],
    ['Cookiebot', 'Consent', 'niedrig', ['cookiebot', 'consent.cookiebot.com']],
    ['Usercentrics', 'Consent', 'niedrig', ['usercentrics', 'usercentrics.eu']],
    ['OneTrust', 'Consent', 'niedrig', ['onetrust', 'optanon', 'cookielaw.org']],
    ['Consentmanager', 'Consent', 'niedrig', ['consentmanager', 'consentmanager.net']],
    ['Borlabs Cookie', 'Consent', 'niedrig', ['borlabs', 'borlabs-cookie']],
    ['CookieYes', 'Consent', 'niedrig', ['cookieyes', 'cookie-law-info']],
    ['Complianz', 'Consent', 'niedrig', ['complianz', 'cmplz']]
  ];

  const haystack = safeLower(`${html} ${scripts.join(' ')}`);
  const detected = [];

  for (const [name, cat, risk, keys] of signatures) {
    if (keys.some(key => haystack.includes(key))) {
      detected.push({
        name,
        cat,
        risk
      });
    }
  }

  const hasConsentTool = detected.some(d => d.cat === 'Consent');

  return {
    detected,
    scripts,
    thirdPartyScripts: scripts,
    hasConsentTool,
    cmpDetected: hasConsentTool
  };
}

function calculatePerformanceScore(pageSpeedScores = {}, checks = {}) {
  let score = Number(pageSpeedScores.performance?.mobile || 0);

  if (!score) {
    score = 68;
  }

  if (!checks.htmlFetchOk && checks.partialAudit) {
    score = Math.min(score, 79);
  }

  return clamp(score, 15, 100);
}

function calculateAccessibilityScore(pageSpeedScores = {}, checks = {}) {
  let score = Number(pageSpeedScores.accessibility?.mobile || 0);

  if (!score) {
    score = 70;
  }

  let failedLocalAudits = 0;

  if (!checks.htmlFetchOk && checks.partialAudit) {
    score = Math.min(score, 79);
    failedLocalAudits += 1;
  }

  if (!checks.htmlLang) {
    failedLocalAudits += 1;
    score = Math.min(score, 89);
  }

  if (checks.noAlt) {
    const missingAlt = Number(checks.imgWithoutAlt || 0);
    failedLocalAudits += 1;

    score = Math.min(score, 89);

    if (missingAlt >= 5) {
      score = Math.min(score, 79);
    }

    if (missingAlt >= 15) {
      score = Math.min(score, 69);
    }
  }

  if (checks.noLabel) {
    failedLocalAudits += 1;
    score = Math.min(score, 79);
  }

  if (checks.imagesWithoutDimensions > 10) {
    score = Math.min(score, 89);
  }

  if (failedLocalAudits >= 2) {
    score = Math.min(score, 79);
  }

  if (failedLocalAudits >= 3) {
    score = Math.min(score, 69);
  }

  return clamp(score, 20, 100);
}

function calculateSeoScore(pageSpeedScores = {}, checks = {}) {
  let score = Number(pageSpeedScores.seo?.mobile || 0);

  if (!score) {
    score = 65;
  }

  let failedSeoBasics = 0;

  if (!checks.htmlFetchOk && checks.partialAudit) {
    score = Math.min(score, 79);
    failedSeoBasics += 1;
  }

  if (checks.noMeta) {
    failedSeoBasics += 1;
    score = Math.min(score, 89);
  }

  if (!checks.hasCanonical) {
    failedSeoBasics += 1;
    score = Math.min(score, 89);
  }

  if (!checks.robotsOk) {
    failedSeoBasics += 1;
    score = Math.min(score, 89);
  }

  if (!checks.htmlLang) {
    failedSeoBasics += 1;
    score = Math.min(score, 89);
  }

  if (checks.noAlt) {
    failedSeoBasics += 1;
    score = Math.min(score, 89);
  }

  if (failedSeoBasics >= 2) {
    score = Math.min(score, 84);
  }

  if (failedSeoBasics >= 3) {
    score = Math.min(score, 79);
  }

  if (failedSeoBasics >= 4) {
    score = Math.min(score, 69);
  }

  return clamp(score, 30, 100);
}

function calculateBestPracticesScore(pageSpeedScores = {}, checks = {}) {
  let score = Number(pageSpeedScores.bestPractices?.mobile || 0);

  if (!score) {
    score = 75;
  }

  if (!checks.hasHttps) {
    score = Math.min(score, 49);
  }

  if (!checks.hasFavicon) {
    score = Math.min(score, 89);
  }

  if (!checks.htmlFetchOk && checks.partialAudit) {
    score = Math.min(score, 79);
  }

  return clamp(score, 30, 100);
}

function calculateLegalScore(checks = {}) {
  let score = 70;
  let issues = 0;

  if (checks.legal?.impressum) {
    score += 6;
  } else {
    score -= 18;
    issues += 1;
  }

  if (checks.legal?.datenschutz) {
    score += 6;
  } else {
    score -= 18;
    issues += 1;
  }

  if (checks.trackers?.hasConsentTool) {
    score += 4;
  } else {
    score -= 8;
    issues += 1;
  }

  if (checks.trackers?.trackingCookiesOnLoad?.length) {
    score -= 24;
    issues += 2;
  }

  if (checks.isShop && checks.legal && !checks.legal.widerruf) {
    score -= 10;
    issues += 1;
  }

  if (checks.isShop && checks.legal && !checks.legal.agb) {
    score -= 6;
    issues += 1;
  }

  if (issues > 0) {
    score = Math.min(score, 89);
  }

  if (issues >= 2) {
    score = Math.min(score, 79);
  }

  if (issues >= 4) {
    score = Math.min(score, 69);
  }

  if (!checks.htmlFetchOk && checks.partialAudit) {
    score = Math.min(score, 62);
  }

  return clamp(score, 25, 100);
}

function mergeScores(pageSpeedScores = {}, checks = {}) {
  return {
    performance: {
      mobile: calculatePerformanceScore(pageSpeedScores, checks)
    },
    accessibility: {
      mobile: calculateAccessibilityScore(pageSpeedScores, checks)
    },
    seo: {
      mobile: calculateSeoScore(pageSpeedScores, checks)
    },
    bestPractices: {
      mobile: calculateBestPracticesScore(pageSpeedScores, checks)
    },
    legal: {
      mobile: calculateLegalScore(checks)
    }
  };
}

function fallbackScoresFromHtml(checks = {}) {
  return mergeScores(
    {
      performance: { mobile: 68 },
      accessibility: { mobile: 70 },
      seo: { mobile: 65 },
      bestPractices: { mobile: 75 }
    },
    checks
  );
}

function fallbackVitals() {
  return {
    estimated: true,
    hasCruxData: false,
    hasLighthouse: false,
    ttfb: '-',
    lcp: '-',
    fcp: '-',
    cls: '-',
    inp: '-',
    inpSource: 'not-available',
    speedIndex: '-',
    tbt: '-',
    source: 'html-fallback'
  };
}

function buildUnavailableChecks(finalUrl, response, pageSpeedResult, notices) {
  return {
    _url: finalUrl,

    htmlFetchOk: false,
    htmlFetchStatus: response.status || 0,
    htmlFetchReason: response.reason || null,
    htmlFetchError: response.error || null,
    partialAudit: true,
    auditWarnings: notices,

    htmlLang: false,

    noAlt: false,
    imgWithoutAlt: 0,
    imgWithoutAltExamples: [],

    noLabel: false,
    viewport: false,
    noMeta: false,
    hasCanonical: false,
    robotsOk: false,

    scriptCount: 0,
    deferredScripts: 0,
    blockingScripts: 0,
    stylesheetCount: 0,

    hasWebP: false,
    imgCount: 0,
    lazyImgCount: 0,
    eagerImgCount: 0,
    imagesWithoutDimensions: 0,

    responseSizeKb: 0,

    hasHttps: finalUrl.startsWith('https://'),
    hasFavicon: false,

    legal: {
      impressum: false,
      datenschutz: false,
      agb: false,
      widerruf: false
    },

    legalLinks: {
      impressum: [],
      datenschutz: [],
      agb: []
    },

    widerruf: {
      found: false,
      url: null,
      linkText: null,
      confidence: 'not-checked',
      has2026Keywords: false,
      riskFlag: false,
      source: 'html-fetch-unavailable',
      candidates: []
    },

    trackers: {
      detected: [],
      scripts: [],
      thirdPartyScripts: [],
      hasConsentTool: false,
      cmpDetected: false
    },

    isShop: false,

    lighthouse: null,

    pageSpeed: {
      id: finalUrl,
      strategy: PAGESPEED_STRATEGY,
      lighthouseVersion: null,
      fetchTime: null,
      crux: null,
      error: pageSpeedResult.error?.message || null
    }
  };
}

app.get('/audit', async (req, res) => {
  const started = Date.now();

  try {
    const inputUrl = normalizeUrl(req.query.url);

    const [response, pageSpeedResult] = await Promise.all([
      fetchText(inputUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        retries: FETCH_RETRIES
      }),
      runPageSpeed(inputUrl)
        .then(value => ({ ok: true, value }))
        .catch(error => ({ ok: false, error }))
    ]);

    const notices = [];
    const htmlNotice = noticeForHtmlFetch(response);
    const pageSpeedNotice = pageSpeedResult.ok ? null : noticeForPageSpeed(pageSpeedResult.error);

    if (htmlNotice) notices.push(htmlNotice);
    if (pageSpeedNotice) notices.push(pageSpeedNotice);

    if (!response.ok && !pageSpeedResult.ok) {
      const finalUrl = response.url || inputUrl;

      const extraNotice = buildNotice(
        'limited-fallback-report',
        'Eingeschränkte Analyse',
        'Die Website konnte gerade nicht vollständig geprüft werden. Wahrscheinlich blockiert die Seite automatisierte Serverabrufe oder Lighthouse war temporär nicht verfügbar. Der Report zeigt deshalb nur eine eingeschränkte technische Einschätzung. Bitte später erneut testen oder eine konkrete Unterseite prüfen.'
      );

      const allNotices = [...notices, extraNotice];
      const checks = buildUnavailableChecks(finalUrl, response, pageSpeedResult, allNotices);
      const scores = fallbackScoresFromHtml(checks);
      const durationMs = Date.now() - started;

      return res.status(200).json({
        url: finalUrl,
        scores,
        checks,
        vitals: {
          ...fallbackVitals(),
          apiDurationMs: durationMs
        },
        notices: allNotices,
        partialAudit: true,
        retryRecommended: true
      });
    }

    const pageSpeed = pageSpeedResult.ok ? pageSpeedResult.value : null;
    const finalUrl = pageSpeed?.finalUrl || response.url || inputUrl;
    const html = response.ok ? response.text || '' : '';
    const $ = cheerio.load(html);

    const legalLinks = {
      impressum: response.ok ? findLinksByTerms($, finalUrl, LEGAL_TERMS.impressum) : [],
      datenschutz: response.ok ? findLinksByTerms($, finalUrl, LEGAL_TERMS.datenschutz) : [],
      agb: response.ok ? findLinksByTerms($, finalUrl, LEGAL_TERMS.agb) : []
    };

    const widerruf = response.ok
      ? await detectWiderruf($, finalUrl)
      : {
          found: false,
          url: null,
          linkText: null,
          confidence: 'not-checked',
          has2026Keywords: false,
          riskFlag: false,
          source: 'html-fetch-unavailable',
          candidates: []
        };

    const legal = {
      impressum: legalLinks.impressum.length > 0,
      datenschutz: legalLinks.datenschutz.length > 0,
      agb: legalLinks.agb.length > 0,
      widerruf: widerruf.found
    };

    const imgWithoutAlt = response.ok
      ? $('img').filter((_, el) => !cleanText($(el).attr('alt'))).length
      : 0;

    const imgWithoutAltExamples = response.ok
      ? $('img')
          .filter((_, el) => !cleanText($(el).attr('alt')))
          .map((_, el) => absoluteUrl($(el).attr('src') || $(el).attr('data-src') || '', finalUrl))
          .get()
          .filter(Boolean)
          .slice(0, 8)
      : [];

    const scripts = response.ok ? $('script').length : 0;
    const deferredScripts = response.ok ? $('script[defer],script[async]').length : 0;
    const responseSizeKb = response.ok ? Math.round(Buffer.byteLength(html, 'utf8') / 1024) : 0;
    const robotsOk = response.ok ? await getRobotsOk(finalUrl) : false;

    const trackers = response.ok ? detectTrackers($, html) : {
      detected: [],
      scripts: [],
      thirdPartyScripts: [],
      hasConsentTool: false,
      cmpDetected: false
    };

    const checks = {
      _url: finalUrl,

      htmlFetchOk: response.ok,
      htmlFetchStatus: response.status,
      htmlFetchReason: response.reason || null,
      htmlFetchError: response.error || null,
      partialAudit: !response.ok || !pageSpeedResult.ok,
      auditWarnings: notices,

      htmlLang: response.ok ? Boolean($('html').attr('lang')) : false,

      noAlt: imgWithoutAlt > 0,
      imgWithoutAlt,
      imgWithoutAltExamples,

      noLabel: response.ok ? $('input,textarea,select').filter((_, el) => {
        const id = $(el).attr('id');
        const type = safeLower($(el).attr('type'));

        if (['hidden', 'submit', 'button'].includes(type)) return false;
        if ($(el).attr('aria-label') || $(el).attr('aria-labelledby')) return false;
        if (id && $(`label[for="${id}"]`).length) return false;

        return $(el).closest('label').length === 0;
      }).length > 0 : false,

      viewport: response.ok ? $('meta[name="viewport"]').length > 0 : false,
      noMeta: response.ok ? !$('meta[name="description"]').attr('content') : false,
      hasCanonical: response.ok ? $('link[rel="canonical"]').length > 0 : false,
      robotsOk,

      scriptCount: scripts,
      deferredScripts,
      blockingScripts: Math.max(0, scripts - deferredScripts),
      stylesheetCount: response.ok ? $('link[rel="stylesheet"]').length : 0,

      hasWebP: response.ok ? /\.webp|\.avif/i.test(html) : false,
      imgCount: response.ok ? $('img').length : 0,
      lazyImgCount: response.ok ? $('img[loading="lazy"]').length : 0,
      eagerImgCount: response.ok ? $('img:not([loading="lazy"])').length : 0,
      imagesWithoutDimensions: response.ok ? $('img').filter((_, el) => !$(el).attr('width') || !$(el).attr('height')).length : 0,

      responseSizeKb,

      hasHttps: finalUrl.startsWith('https://'),
      hasFavicon: response.ok ? $('link[rel*="icon"]').length > 0 : false,

      legal,
      legalLinks,
      widerruf,
      trackers,

      isShop: false,

      lighthouse: pageSpeed?.lighthouse || null,

      pageSpeed: pageSpeed ? {
        id: pageSpeed.id,
        strategy: pageSpeed.strategy,
        lighthouseVersion: pageSpeed.lighthouseVersion,
        fetchTime: pageSpeed.fetchTime,
        crux: pageSpeed.crux
      } : {
        id: finalUrl,
        strategy: PAGESPEED_STRATEGY,
        lighthouseVersion: null,
        fetchTime: null,
        crux: null,
        error: pageSpeedResult.error?.message || null
      }
    };

    checks.isShop = response.ok ? detectShop($, finalUrl, legal) : false;

    const scores = pageSpeed
      ? mergeScores(pageSpeed.scores, checks)
      : fallbackScoresFromHtml(checks);

    const durationMs = Date.now() - started;

    res.json({
      url: finalUrl,
      scores,
      checks,
      vitals: {
        ...(pageSpeed ? pageSpeed.vitals : fallbackVitals()),
        apiDurationMs: durationMs
      },
      notices,
      partialAudit: checks.partialAudit,
      retryRecommended: notices.some(notice => [
        'html-fetch-timeout',
        'html-fetch-failed',
        'html-fetch-rate-limited',
        'pagespeed-timeout',
        'pagespeed-rate-limit',
        'pagespeed-failed',
        'limited-fallback-report'
      ].includes(notice.type))
    });
  } catch (err) {
    console.error('GET /audit failed:', err);

    const notice = buildNotice(
      'audit-failed',
      'Analyse konnte nicht abgeschlossen werden',
      'Die Analyse ist unerwartet fehlgeschlagen. Bitte versuche es später erneut oder teste eine konkrete Unterseite.'
    );

    const finalUrl = req.query.url ? normalizeUrl(req.query.url) : '';

    const fallbackResponse = {
      ok: false,
      status: 0,
      url: finalUrl,
      reason: 'unexpected-error',
      error: err.message || 'Analyse fehlgeschlagen.'
    };

    const fakePageSpeedResult = {
      ok: false,
      error: err
    };

    const checks = finalUrl
      ? buildUnavailableChecks(finalUrl, fallbackResponse, fakePageSpeedResult, [notice])
      : null;

    res.status(200).json({
      error: checks ? undefined : 'Analyse nicht abgeschlossen',
      message: err.message || 'Analyse fehlgeschlagen.',
      userHint: notice.text,
      retryRecommended: true,
      notices: [notice],
      ...(checks ? {
        url: finalUrl,
        scores: fallbackScoresFromHtml(checks),
        checks,
        vitals: {
          ...fallbackVitals(),
          apiDurationMs: Date.now() - started
        },
        partialAudit: true
      } : {})
    });
  }
});

app.listen(PORT, () => {
  console.log(`V-LAB audit API läuft auf Port ${PORT}`);
});
