# v-lab Shop-Potenzialcheck

## Setup in 3 Schritten

### 1. Backend auf Render.com deployen

1. Repo auf GitHub pushen (nur server.js, package.json, render.yaml)
2. render.com → "New Web Service" → GitHub-Repo verbinden
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Deploy klicken → du bekommst eine URL wie `https://vlab-audit-api.onrender.com`

### 2. Webflow-Embed konfigurieren

In `webflow-embed.html` oben im Script:

```js
const API_BASE = 'https://vlab-audit-api.onrender.com'; // deine Render-URL
const CTA_URL  = 'https://v-lab.one/#kontakt';
```

### 3. In Webflow einbetten

1. Webflow → gewünschte Seite → Element hinzufügen → "Embed"
2. Gesamten Inhalt von `webflow-embed.html` einfügen
3. Publish

## Wichtige Hinweise

- Render.com Free Tier: Service schläft nach 15min Inaktivität ein → erste Anfrage dauert ~30s
- Für Produktion: Render Starter ($7/mo) oder eigener VPS
- Die PageSpeed API ist kostenlos, kein API-Key nötig für Basis-Nutzung
- Bei mehr als ~400 Anfragen/Tag → kostenlosen Google API-Key holen

## Datei-Übersicht

| Datei | Beschreibung |
|---|---|
| server.js | Node.js Backend – ruft PageSpeed API ab |
| package.json | Dependencies |
| render.yaml | Render.com Deployment-Konfiguration |
| webflow-embed.html | Komplettes Frontend für Webflow-Embed |
# website-performance
