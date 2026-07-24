/* ============================================================
   RELAY YOUTUBE per overlay StreamElements
   ------------------------------------------------------------
   Cosa fa:
   1) Ti mostra una paginetta web (aprendo l'URL del servizio nel
      browser) dove incolli il link o l'ID della tua diretta YouTube
      prima di iniziare lo stream.
   2) Da quel video recupera il liveChatId collegato
      (videos.list -> liveStreamingDetails.activeLiveChatId).
   3) Fa polling di liveChatMessages.list rispettando l'intervallo
      che l'API stessa consiglia (pollingIntervalMillis), e per
      ogni messaggio nuovo lo inoltra a tutti i client WebSocket
      connessi (cioè il tuo overlay) nel formato che widget.js
      si aspetta:
      { type: "message", id, authorName, authorPhoto, text }
   4) Se la diretta finisce, il server si rimette in attesa che tu
      gli passi il prossimo video dalla stessa pagina.

   NOTA: non c'e' piu' ricerca automatica della diretta (search.list),
   perche' costava 100 unita' di quota per chiamata ed esauriva la
   quota giornaliera gratuita in poche ore. Ora si usa solo
   videos.list (1 unita') e liveChat/messages.list (poche unita' a
   chiamata), quindi la quota dura molto di piu'.

   Variabili d'ambiente richieste (le imposti su Render):
   - YOUTUBE_API_KEY   -> la tua API key di YouTube Data API v3
   - PORT (opzionale, Render la imposta da solo)
   ============================================================ */

const http = require('http');
const { WebSocketServer } = require('ws');

const API_KEY = process.env.YOUTUBE_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error('[RELAY] Manca YOUTUBE_API_KEY nelle variabili d\'ambiente.');
  process.exit(1);
}

const YT_API = 'https://www.googleapis.com/youtube/v3';

// ---- stato interno ----
let liveChatId = null;
let nextPageToken = null;
let pollTimer = null;
let statusMessage = 'Nessun video impostato. Incolla il link della diretta qui sotto.';
let statusIsError = false;

// ---- estrazione videoId da vari formati di link ----
function extractVideoId(input) {
  const raw = input.trim();

  // già un ID "nudo" (11 caratteri tipici di YouTube)
  if (/^[a-zA-Z0-9_-]{10,15}$/.test(raw) && !raw.includes('/')) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.replace('/', '');
    }
    if (url.searchParams.get('v')) {
      return url.searchParams.get('v');
    }
    // formati /live/VIDEOID
    const liveMatch = url.pathname.match(/\/live\/([a-zA-Z0-9_-]+)/);
    if (liveMatch) return liveMatch[1];
  } catch (e) {
    // non era un URL valido
  }
  return null;
}

// ---- pagina web ----
function renderPage() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Relay YouTube</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; background:#111; color:#eee; }
  h1 { font-size: 20px; }
  input[type=text] { width: 100%; padding: 10px; font-size: 15px; box-sizing: border-box; margin-bottom: 10px; }
  button { padding: 10px 20px; font-size: 15px; cursor: pointer; }
  .status { padding: 12px; border-radius: 6px; margin-bottom: 20px; background: ${statusIsError ? '#5c1a1a' : '#1a3d1a'}; color: #fff; }
</style>
</head>
<body>
  <h1>Relay chat YouTube</h1>
  <div class="status">${statusMessage}</div>
  <form method="POST" action="/set-video">
    <input type="text" name="video" placeholder="Incolla qui il link (o l'ID) della diretta YouTube" required>
    <button type="submit">Collega diretta</button>
  </form>
</body>
</html>`;
}

async function activateVideo(videoId) {
  try {
    const videoUrl = `${YT_API}/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
    const videoRes = await fetch(videoUrl);
    const videoData = await videoRes.json();

    if (videoData.error) {
      statusMessage = `Errore API: ${videoData.error.message}`;
      statusIsError = true;
      return;
    }

    const details = videoData.items && videoData.items[0] && videoData.items[0].liveStreamingDetails;
    const found = details && details.activeLiveChatId;

    if (!found) {
      statusMessage = 'Questo video non risulta in diretta al momento (o la chat live non è attiva). Controlla il link e riprova.';
      statusIsError = true;
      return;
    }

    liveChatId = found;
    nextPageToken = null;
    statusMessage = 'Diretta collegata! La chat è in ascolto.';
    statusIsError = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollLiveChat();
  } catch (err) {
    statusMessage = `Errore imprevisto: ${err.message}`;
    statusIsError = true;
  }
}

// ---- server HTTP + WebSocket ----
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage());
    return;
  }

  if (req.method === 'POST' && req.url === '/set-video') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const params = new URLSearchParams(body);
      const raw = params.get('video') || '';
      const videoId = extractVideoId(raw);

      if (!videoId) {
        statusMessage = 'Non sono riuscito a riconoscere un ID video valido in quel link.';
        statusIsError = true;
      } else {
        await activateVideo(videoId);
      }

      res.writeHead(302, { Location: '/' });
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Non trovato');
});

const wss = new WebSocketServer({ server: httpServer });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[RELAY] Overlay connesso. Client attivi:', wss.clients.size);
  ws.on('close', () => {
    console.log('[RELAY] Overlay disconnesso. Client attivi:', wss.clients.size);
  });
});

// ---- polling dei messaggi della chat ----
async function pollLiveChat() {
  if (!liveChatId) return;

  try {
    let url = `${YT_API}/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${API_KEY}`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.warn('[RELAY] Chat non più disponibile:', data.error.message);
      liveChatId = null;
      nextPageToken = null;
      statusMessage = 'La diretta collegata è terminata (o la chat non è più raggiungibile). Incolla il link della prossima diretta quando sei pronto.';
      statusIsError = true;
      return;
    }

    nextPageToken = data.nextPageToken;

    (data.items || []).forEach((item) => {
      const snippet = item.snippet;
      const author = item.authorDetails;
      if (!snippet || snippet.type !== 'textMessageEvent') return; // ignora super chat, membership, ecc.

      broadcast({
        type: 'message',
        id: item.id,
        authorName: author.displayName,
        authorPhoto: author.profileImageUrl,
        text: snippet.displayMessage
      });
    });

    const delay = Math.max(data.pollingIntervalMillis || 5000, 2000); // mai sotto i 2s, per rispettare le quote
    pollTimer = setTimeout(pollLiveChat, delay);
  } catch (err) {
    console.error('[RELAY] Errore nel polling della chat:', err.message);
    pollTimer = setTimeout(pollLiveChat, 5000);
  }
}

httpServer.listen(PORT, () => {
  console.log('[RELAY] Server avviato sulla porta', PORT);
});
