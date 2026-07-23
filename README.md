# Relay chat YouTube -> overlay StreamElements

Piccolo server Node.js che:
1. Controlla se sul tuo canale YouTube è attiva una diretta (partendo dal Channel ID).
2. Recupera la chat live collegata.
3. Inoltra ogni messaggio via WebSocket all'overlay, che lo mostra insieme ai messaggi Twitch.

## Deploy su Render

1. Carica questa cartella (`server.js`, `package.json`) su un repository GitHub (Render fa il deploy da lì).
2. Su [render.com](https://render.com) crea un nuovo **Web Service**, collegato al repository.
3. Impostazioni build:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance type**: Free va bene per iniziare
4. Vai su **Environment** e aggiungi queste variabili:
   - `YOUTUBE_API_KEY` = la tua API key di YouTube Data API v3
   - `YOUTUBE_CHANNEL_ID` = il Channel ID del canale da monitorare (non lo username, l'ID che inizia con `UC...`)
5. Fai il deploy. Nei log dovresti vedere `[RELAY] Server avviato sulla porta ...`.
6. Render ti darà un URL tipo `https://nome-servizio.onrender.com`. Nel `widget.js` dell'overlay, sostituisci:

   ```js
   const SEYT_RELAY_URL = 'wss://SOSTITUISCI-CON-IL-TUO-URL.onrender.com';
   ```

   con lo stesso host ma **con `wss://`** invece di `https://`, es:

   ```js
   const SEYT_RELAY_URL = 'wss://nome-servizio.onrender.com';
   ```

## Note importanti

- **Piano gratuito Render**: i servizi free "dormono" dopo un po' di inattività e si risvegliano alla prima richiesta (con qualche secondo di ritardo). Se questo per il tuo streaming è un problema, valuta un piano a pagamento o un ping periodico per tenerlo sveglio.
- **Quota API YouTube**: ogni chiamata a `liveChat/messages` consuma quota. Il server rispetta l'intervallo di polling suggerito dall'API stessa (di solito 5-10 secondi), quindi in una diretta lunga il consumo resta ragionevole, ma se hai più overlay/canali attivi tienilo d'occhio nella Google Cloud Console.
- Se la diretta finisce, il server torna automaticamente a cercare la prossima diretta sullo stesso canale, senza bisogno di riavviarlo.
