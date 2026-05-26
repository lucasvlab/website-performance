const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/audit', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'URL fehlt' });

  let cleanUrl = url;
  if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

  try {
    const categories = ['performance', 'accessibility', 'seo', 'best-practices'];
    const catParam = categories.map(c => `category=${c}`).join('&');

    const [mobileRes, desktopRes] = await Promise.all([
      fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(cleanUrl)}&strategy=mobile&${catParam}&key=AIzaSyABMoYvvt8MtQFTC2DMwciU3MuZDd5Z6YI`),
      fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(cleanUrl)}&strategy=desktop&${catParam}&key=AIzaSyABMoYvvt8MtQFTC2DMwciU3MuZDd5Z6YI`)
    ]);

    const [mobile, desktop] = await Promise.all([mobileRes.json(), desktopRes.json()]);

    if (mobile.error) return res.status(400).json({ error: mobile.error.message });

    const mCats = mobile.lighthouseResult?.categories || {};
    const dCats = desktop.lighthouseResult?.categories || {};
    const audits = mobile.lighthouseResult?.audits || {};

    const score = (cat, src) => Math.round((src?.[cat]?.score ?? 0) * 100);

    const lcp = audits['largest-contentful-paint']?.displayValue || '-';
    const fid = audits['total-blocking-time']?.displayValue || '-';
    const cls = audits['cumulative-layout-shift']?.displayValue || '-';
    const ttfb = audits['server-response-time']?.displayValue || '-';
    const scriptCount = Object.values(audits['bootup-time']?.details?.items || {}).length;
    const imgIssues = audits['uses-optimized-images']?.score !== 1;
    const hasWebP = audits['uses-webp-images']?.score === 1;
    const noMeta = audits['meta-description']?.score !== 1;
    const noAlt = audits['image-alt']?.score !== 1;
    const noLabel = audits['label']?.score !== 1;
    const contrastFail = audits['color-contrast']?.score !== 1;
    const hasHttps = audits['is-on-https']?.score === 1;
    const tapTargets = audits['tap-targets']?.score !== 1;
    const fontSize = audits['font-size']?.score !== 1;
    const viewport = audits['viewport']?.score === 1;

    res.json({
      url: cleanUrl,
      scores: {
        performance: { mobile: score('performance', mCats), desktop: score('performance', dCats) },
        seo: { mobile: score('seo', mCats), desktop: score('seo', dCats) },
        accessibility: { mobile: score('accessibility', mCats), desktop: score('accessibility', dCats) },
        bestPractices: { mobile: score('best-practices', mCats), desktop: score('best-practices', dCats) },
      },
      vitals: { lcp, fid, cls, ttfb },
      checks: {
        imgIssues, hasWebP, noMeta, noAlt,
        noLabel, contrastFail, hasHttps,
        tapTargets, fontSize, viewport, scriptCount
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analyse fehlgeschlagen: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`v-lab audit server running on port ${PORT}`));
