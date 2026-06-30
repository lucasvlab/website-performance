const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const USER_AGENT = 'Mozilla/5.0 (compatible; V-LAB-Audit/1.0; +https://v-lab.one)';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
const PAGESPEED_TIMEOUT_MS = Number(process.env.PAGESPEED_TIMEOUT_MS || 60000);
const MAX_LEGAL_LINKS_TO_VERIFY = 8;

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';
const PAGESPEED_STRATEGY = process.env.PAGESPEED_STRATEGY || 'mobile';
const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vlab-audit-api',
    mode: 'pagespeed-lighthouse',
    time: new Date().toISOString()
  });
});

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Keine URL übergeben.');
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, {
    timeout: options.timeout || REQUEST_TIMEOUT_MS,
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'de-DE,de;q=0.9,en;q=0.8'
    }
  });

  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    url: response.url || url,
    headers: response.headers,
    text
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

function calculateLegalScore(checks) {
  let score = 70;

  checks.legal?.impressum ? score += 10 : score -= 12;
  checks.legal?.datenschutz ? score += 10 : score -= 12;
  checks.trackers?.hasConsentTool ? score += 8 : score -= 4;

  if (checks.trackers?.trackingCookiesOnLoad?.length) {
    score -= 18;
  }

  if (checks.isShop && checks.legal && !checks.legal.widerruf) {
    score -= 4;
  }

  return Math.max(35, Math.min(100, Math.round(score)));
}

function mergeScores(pageSpeedScores, checks) {
  const legalScore = calculateLegalScore(checks);

  return {
    performance: pageSpeedScores.performance || { mobile: 0 },
    accessibility: pageSpeedScores.accessibility || { mobile: 0 },
    seo: pageSpeedScores.seo || { mobile: 0 },
    bestPractices: pageSpeedScores.bestPractices || { mobile: 0 },
    legal: {
      mobile: legalScore
    }
  };
}

app.get('/audit', async (req, res) => {
  try {
    const inputUrl = normalizeUrl(req.query.url);
    const started = Date.now();

    const [response, pageSpeed] = await Promise.all([
      fetchText(inputUrl),
      runPageSpeed(inputUrl)
    ]);

    if (!response.ok) {
      return res.status(response.status).json({
        error: `URL konnte nicht geladen werden. Status ${response.status}`
      });
    }

    const finalUrl = pageSpeed.finalUrl || response.url || inputUrl;
    const html = response.text || '';
    const $ = cheerio.load(html);

    const legalLinks = {
      impressum: findLinksByTerms($, finalUrl, LEGAL_TERMS.impressum),
      datenschutz: findLinksByTerms($, finalUrl, LEGAL_TERMS.datenschutz),
      agb: findLinksByTerms($, finalUrl, LEGAL_TERMS.agb)
    };

    const widerruf = await detectWiderruf($, finalUrl);

    const legal = {
      impressum: legalLinks.impressum.length > 0,
      datenschutz: legalLinks.datenschutz.length > 0,
      agb: legalLinks.agb.length > 0,
      widerruf: widerruf.found
    };

    const imgWithoutAlt = $('img').filter((_, el) => {
      return !cleanText($(el).attr('alt'));
    }).length;

    const imgWithoutAltExamples = $('img')
      .filter((_, el) => !cleanText($(el).attr('alt')))
      .map((_, el) => {
        return absoluteUrl($(el).attr('src') || $(el).attr('data-src') || '', finalUrl);
      })
      .get()
      .filter(Boolean)
      .slice(0, 8);

    const scripts = $('script').length;
    const deferredScripts = $('script[defer],script[async]').length;
    const responseSizeKb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
    const robotsOk = await getRobotsOk(finalUrl);
    const trackers = detectTrackers($, html);

    const checks = {
      _url: finalUrl,

      htmlLang: Boolean($('html').attr('lang')),

      noAlt: imgWithoutAlt > 0,
      imgWithoutAlt,
      imgWithoutAltExamples,

      noLabel: $('input,textarea,select').filter((_, el) => {
        const id = $(el).attr('id');
        const type = safeLower($(el).attr('type'));

        if (['hidden', 'submit', 'button'].includes(type)) return false;
        if ($(el).attr('aria-label') || $(el).attr('aria-labelledby')) return false;
        if (id && $(`label[for="${id}"]`).length) return false;

        return $(el).closest('label').length === 0;
      }).length > 0,

      viewport: $('meta[name="viewport"]').length > 0,
      noMeta: !$('meta[name="description"]').attr('content'),
      hasCanonical: $('link[rel="canonical"]').length > 0,
      robotsOk,

      scriptCount: scripts,
      deferredScripts,
      blockingScripts: Math.max(0, scripts - deferredScripts),
      stylesheetCount: $('link[rel="stylesheet"]').length,

      hasWebP: /\.webp|\.avif/i.test(html),
      imgCount: $('img').length,
      lazyImgCount: $('img[loading="lazy"]').length,
      eagerImgCount: $('img:not([loading="lazy"])').length,
      imagesWithoutDimensions: $('img').filter((_, el) => {
        return !$(el).attr('width') || !$(el).attr('height');
      }).length,

      responseSizeKb,

      hasHttps: finalUrl.startsWith('https://'),
      hasFavicon: $('link[rel*="icon"]').length > 0,

      legal,
      legalLinks,
      widerruf,
      trackers,

      isShop: false,

      lighthouse: pageSpeed.lighthouse,

      pageSpeed: {
        id: pageSpeed.id,
        strategy: pageSpeed.strategy,
        lighthouseVersion: pageSpeed.lighthouseVersion,
        fetchTime: pageSpeed.fetchTime,
        crux: pageSpeed.crux
      }
    };

    checks.isShop = detectShop($, finalUrl, legal);

    const scores = mergeScores(pageSpeed.scores, checks);
    const durationMs = Date.now() - started;

    res.json({
      url: finalUrl,
      scores,
      checks,
      vitals: {
        ...pageSpeed.vitals,
        apiDurationMs: durationMs
      }
    });
  } catch (err) {
    console.error('GET /audit failed:', err);

    res.status(500).json({
      error: err.message || 'Analyse fehlgeschlagen.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`V-LAB audit API läuft auf Port ${PORT}`);
});
