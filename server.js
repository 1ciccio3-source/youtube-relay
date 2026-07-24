/* ============================================================
   RELAY YOUTUBE per overlay StreamElements
   ------------------------------------------------------------
   Cosa fa:
   1) Ogni tot secondi controlla, tramite il Channel ID, se sul
      canale YouTube è attiva una diretta (search.list con
      eventType=live).
   2) Trovata la diretta, recupera il liveChatId collegato al
      video (videos.list -> liveStreamingDetails.activeLiveChatId).
   3) Fa polling di liveChatMessages.list rispettando l'intervallo
      che l'API stessa consiglia (pollingIntervalMillis), e per
      ogni messaggio nuovo lo inoltra a tutti i client WebSocket
      connessi (cioè il tuo overlay) nel formato che widget.js
      si aspetta:
      { type: "message", id, authorName, authorPhoto, text }
   4) Se la diretta finisce, torna a cercare la prossima.

   Variabili d'ambiente richieste (le imposti su Render):
   - YOUTUBE_API_KEY   -> la tua API key di YouTube Data API v3
   - YOUTUBE_CHANNEL_ID -> il Channel ID del canale da monitorare
   - PORT (opzionale, Render la imposta da solo)
   ============================================================ */

const http = require('http');
const { WebSocketServer } = require('ws');

const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

if (!API_KEY || !CHANNEL_ID) {
  console.error('[RELAY] Mancano YOUTUBE_API_KEY e/o YOUTUBE_CHANNEL_ID nelle variabili d\'ambiente.');
  process.exit(1);
}

const YT_API = 'https://www.googleapis.com/youtube/v3';

// Ogni quanto ricontrolliamo se è iniziata una diretta (quando non ce n'è una attiva)
// A 60s, la search.list (100 unita' a chiamata) esaurisce la quota
// giornaliera (10.000 unita') in un paio d'ore se non c'e' mai diretta.
// Con 5 minuti restiamo entro un consumo sostenibile per tutto il giorno.
const LIVE_SEARCH_INTERVAL_MS = 5 * 60 * 1000;

// ---- stato interno ----
let liveChatId = null;
let nextPageToken = null;
let pollTimer = null;
let searchTimer = null;

// ---- server HTTP + WebSocket ----
const httpServer = http.createServer((req, res) => {
  // Endpoint minimo di health-check, utile per Render
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Relay YouTube attivo.\n');
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

// ---- ricerca diretta attiva ----
async function findLiveChatId() {
  try {
    const searchUrl = `${YT_API}/search?part=snippet&channelId=${CHANNEL_ID}&eventType=live&type=video&key=${API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) {
      return null; // nessuna diretta in corso
    }

    const videoId = searchData.items[0].id.videoId;

    const videoUrl = `${YT_API}/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
    const videoRes = await fetch(videoUrl);
    const videoData = await videoRes.json();

    const details = videoData.items && videoData.items[0] && videoData.items[0].liveStreamingDetails;
    return (details && details.activeLiveChatId) || null;
  } catch (err) {
    console.error('[RELAY] Errore nella ricerca della diretta:', err.message);
    return null;
  }
}

async function startSearchLoop() {
  if (liveChatId) return; // già in diretta, non serve cercare

  const found = await findLiveChatId();
  if (found) {
    console.log('[RELAY] Diretta trovata, liveChatId:', found);
    liveChatId = found;
    nextPageToken = null;
    pollLiveChat();
  } else {
    searchTimer = setTimeout(startSearchLoop, LIVE_SEARCH_INTERVAL_MS);
  }
}

// ---- polling dei messaggi della chat ----
async function pollLiveChat() {
  if (!liveChatId) return;

  try {
    let url = `${YT_API}/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${API_KEY}`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      // La diretta è probabilmente finita, o il liveChatId non è più valido
      console.warn('[RELAY] Chat non più disponibile, torno a cercare una nuova diretta:', data.error.message);
      liveChatId = null;
      nextPageToken = null;
      startSearchLoop();
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
  startSearchLoop();
});
