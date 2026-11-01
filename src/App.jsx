import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Trash2,
  LogOut,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Search,
  Sliders,
  X,
  Key,
  Sparkles,
  ShieldAlert,
  ChevronDown,
  Copy,
  Check,
  Smartphone,
  Share2,
} from 'lucide-react';

const STORAGE_KEY = 'discord_cleaner_token';

// Script extrator rápido para navegador do celular
const BOOKMARKLET_CODE = `javascript:(function(){try{let t;window.webpackChunkdiscord_app.push([[Math.random()],{},(r)=>{for(const m of Object.keys(r.c)){if(r.c[m]?.exports?.default?.getToken!==undefined){t=r.c[m].exports.default.getToken();}}}]);if(!t){t=(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken();}if(t){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t);}prompt("Seu Token do Discord foi copiado com sucesso! Caso necessario, copie abaixo:",t);}else{alert("Faca login em discord.com/app antes de rodar!");}}catch(e){alert("Abra discord.com/app logado no navegador primeiro.");}})();`;

// Script Eruda para inspecionar requisições no celular
const ERUDA_CODE = `javascript:(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/eruda';document.body.appendChild(s);s.onload=function(){eruda.init();eruda.show();};})();`;

function getAvatarUrl(user) {
  if (!user) return 'https://cdn.discordapp.com/embed/avatars/0.png';
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  try {
    const index = Number((BigInt(user.id || '0') >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  } catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
}

export default function App() {
  // Autenticação & Perfil
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [rememberToken, setRememberToken] = useState(true);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Modais de Ajuda de Token
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tokenModalTab, setTokenModalTab] = useState('magic'); // 'magic' | 'bookmarklet' | 'pc'
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);
  const [copiedEruda, setCopiedEruda] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [generatorToken, setGeneratorToken] = useState('');
  const [copiedGeneratedLink, setCopiedGeneratedLink] = useState(false);

  // Navegação
  const [activeTab, setActiveTab] = useState('cleaner'); // 'cleaner' | 'batch'

  // DMs & Seleção
  const [dms, setDms] = useState([]);
  const [loadingDms, setLoadingDms] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDm, setSelectedDm] = useState(null);
  const [manualId, setManualId] = useState('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState('');

  // Configurações de Limpeza
  const [amount, setAmount] = useState(50); // 10, 25, 50, 100, -1 (todas)
  const [filterText, setFilterText] = useState('');
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Execução da Limpeza
  const [purging, setPurging] = useState(false);
  const [progress, setProgress] = useState({
    deleted: 0,
    target: 50,
    snippet: '',
    statusText: '',
    rateLimitWait: 0,
  });
  const [purgeDone, setPurgeDone] = useState(false);
  const [purgeError, setPurgeError] = useState('');
  const abortControllerRef = useRef(null);

  // Operações em lote legadas
  const [batchGuildId, setBatchGuildId] = useState('');
  const [batchLogs, setBatchLogs] = useState([]);

  const loadDms = useCallback(async (currentToken) => {
    const t = currentToken || token;
    if (!t) return;
    setLoadingDms(true);
    try {
      const res = await fetch('/api/dm/list', {
        headers: { Authorization: t.trim() },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        setDms(data);
      }
    } catch {
      // Ignora erro silencioso de listagem
    } finally {
      setLoadingDms(false);
    }
  }, [token]);

  const validateAndLogin = useCallback(async (tokenToTest) => {
    if (!tokenToTest || !tokenToTest.trim()) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenToTest.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.id) {
        setUser(data);
        if (rememberToken) {
          localStorage.setItem(STORAGE_KEY, tokenToTest.trim());
        }
        loadDms(tokenToTest.trim());
      } else {
        throw new Error(data.message || 'Token inválido ou expirado');
      }
    } catch (err) {
      setAuthError(err.message || 'Falha na conexão com o Discord');
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, [rememberToken, loadDms]);

  // Auto-login se já tiver token salvo OU se vier via link mágico (?token=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    const targetToken = urlToken ? urlToken.trim() : (localStorage.getItem(STORAGE_KEY) || '').trim();

    if (urlToken) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (!targetToken) return;

    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: targetToken }),
        });
        const data = await res.json();
        if (!ignore && res.ok && data.id) {
          setUser(data);
          localStorage.setItem(STORAGE_KEY, targetToken);
          loadDms(targetToken);
        }
      } catch {
        // token expirado ou inválido
      }
    })();
    return () => {
      ignore = true;
    };
  }, [loadDms]);

  async function handleLoginSubmit(e) {
    e.preventDefault();
    await validateAndLogin(token);
  }

  function handleLogout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken('');
    setUser(null);
    setDms([]);
    setSelectedDm(null);
  }

  function copyText(text, setCopiedState) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
    setCopiedState(true);
    setTimeout(() => setCopiedState(false), 2000);
  }

  function handleShareLink() {
    if (!token) return;
    const url = `${window.location.origin}/?token=${encodeURIComponent(token.trim())}`;
    copyText(url, setCopiedShareLink);
  }

  function handleGenerateLink() {
    if (!generatorToken.trim()) return;
    const url = `${window.location.origin}/?token=${encodeURIComponent(generatorToken.trim())}`;
    copyText(url, setCopiedGeneratedLink);
  }

  async function handleResolveManual() {
    if (!manualId.trim()) return;
    setManualLoading(true);
    setManualError('');
    try {
      const res = await fetch('/api/dm/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim(),
          recipientId: manualId.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.id) {
        setSelectedDm(data);
        setDms((prev) => {
          if (prev.some((c) => c.id === data.id)) return prev;
          return [data, ...prev];
        });
        setManualId('');
      } else {
        setSelectedDm({
          id: manualId.trim(),
          type: 1,
          recipients: [{ id: manualId.trim(), username: 'Canal Direto / ' + manualId.trim() }],
        });
        setManualId('');
      }
    } catch (err) {
      setManualError(err.message || 'Falha ao encontrar conversa');
    } finally {
      setManualLoading(false);
    }
  }

  async function startPurge() {
    if (!selectedDm || !token) return;
    setShowConfirmModal(false);
    setPurging(true);
    setPurgeDone(false);
    setPurgeError('');
    setProgress({
      deleted: 0,
      target: amount,
      snippet: '',
      statusText: 'Iniciando limpeza...',
      rateLimitWait: 0,
    });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/api/dm/purge-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim(),
          channelId: selectedDm.id,
          amount,
          filterText: filterText.trim(),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Erro na conexão (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          if (!block.trim()) continue;
          const matchEvent = block.match(/^event:\s*(.+)$/m);
          const matchData = block.match(/^data:\s*(.+)$/m);
          const ev = matchEvent ? matchEvent[1].trim() : 'message';
          let data = {};
          try {
            data = matchData ? JSON.parse(matchData[1]) : {};
          } catch {
            data = {};
          }

          if (ev === 'status') {
            setProgress((prev) => ({ ...prev, statusText: data.message || '' }));
          } else if (ev === 'progress') {
            setProgress((prev) => ({
              ...prev,
              deleted: data.deleted,
              snippet: data.snippet,
              rateLimitWait: 0,
              statusText: 'Apagando mensagens...',
            }));
          } else if (ev === 'ratelimit') {
            setProgress((prev) => ({
              ...prev,
              rateLimitWait: data.waitSeconds,
              statusText: `Aguardando pausa do Discord (${data.waitSeconds}s)...`,
            }));
          } else if (ev === 'done') {
            setPurgeDone(true);
            setProgress((prev) => ({
              ...prev,
              deleted: data.totalDeleted,
              statusText: data.message || 'Limpeza concluída!',
            }));
          } else if (ev === 'error') {
            setPurgeError(data.message || 'Ocorreu um erro');
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setPurgeError(err.message || 'Erro inesperado durante a limpeza');
      }
    } finally {
      abortControllerRef.current = null;
      setPurging(false);
    }
  }

  function stopPurge() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPurging(false);
  }

  // Filtragem de conversas por busca
  const filteredDms = dms.filter((dm) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (dm.recipients && dm.recipients.length > 0) {
      return dm.recipients.some(
        (r) =>
          (r.username && r.username.toLowerCase().includes(q)) ||
          (r.global_name && r.global_name.toLowerCase().includes(q))
      );
    }
    return dm.id.includes(q);
  });

  // Funções de lote legadas
  async function runBatch(endpoint, body) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), guildId: batchGuildId, ...body }),
      });
      const data = await res.json();
      setBatchLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${JSON.stringify(data)}`, ...prev]);
    } catch (err) {
      setBatchLogs((prev) => [`[${new Date().toLocaleTimeString()}] Erro: ${err.message}`, ...prev]);
    }
  }

  // Se não estiver logado, exibe tela de login mobile-first
  if (!user) {
    return (
      <div className="min-h-[100dvh] bg-[#1e1f22] text-[#f2f3f5] flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-[#2b2d31] rounded-2xl border border-[#383a40] shadow-2xl p-6 sm:p-7 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#5865f2]/15 text-[#5865f2] mb-1">
              <Trash2 className="w-7 h-7" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              Limpador de Chat
            </h1>
            <p className="text-xs sm:text-sm text-[#949ba4]">
              Apague suas mensagens de qualquer DM privada direto pelo celular.
            </p>
          </div>

          {/* Banner de Ajuda para Pegar o Token no Celular */}
          <button
            type="button"
            onClick={() => setShowTokenModal(true)}
            className="w-full p-3.5 rounded-xl bg-[#5865f2]/10 hover:bg-[#5865f2]/15 border border-[#5865f2]/30 flex items-center justify-between transition-colors text-left group"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#5865f2] text-white flex items-center justify-center shrink-0">
                <Smartphone className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5">
                  Como pegar o token no celular?
                </p>
                <p className="text-[11px] text-[#949ba4]">
                  Toque para ver o extrator de 1 clique ou link mágico
                </p>
              </div>
            </div>
            <ChevronDown className="w-4 h-4 text-[#5865f2] -rotate-90 group-hover:translate-x-0.5 transition-transform shrink-0" />
          </button>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-[#b5bac1]">
                  Token da Conta
                </label>
                <button
                  type="button"
                  onClick={() => setShowTokenModal(true)}
                  className="text-xs text-[#5865f2] hover:underline flex items-center gap-1"
                >
                  <Key className="w-3.5 h-3.5" />
                  Pegar Token
                </button>
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Cole o token do Discord aqui..."
                className="w-full px-3.5 py-3 bg-[#1e1f22] border border-[#383a40] rounded-xl text-[#f2f3f5] placeholder-[#80848e] text-sm focus:outline-none focus:border-[#5865f2] focus:ring-1 focus:ring-[#5865f2] transition-colors font-mono"
                required
                disabled={authLoading}
              />
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer text-xs sm:text-sm text-[#b5bac1] select-none py-1">
              <input
                type="checkbox"
                checked={rememberToken}
                onChange={(e) => setRememberToken(e.target.checked)}
                className="w-4 h-4 rounded bg-[#1e1f22] border-[#383a40] text-[#5865f2] focus:ring-0 focus:ring-offset-0 cursor-pointer"
              />
              <span>Lembrar neste celular (para não precisar colar de novo)</span>
            </label>

            {authError && (
              <div className="flex items-start gap-2 bg-[#da373c]/10 border border-[#da373c]/30 text-[#f23f43] p-3 rounded-xl text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{authError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading || !token.trim()}
              className="w-full py-3.5 bg-[#5865f2] hover:bg-[#4752c4] disabled:bg-[#5865f2]/40 text-white rounded-xl font-medium text-sm transition-all shadow-md active:scale-[0.99] flex items-center justify-center gap-2"
            >
              {authLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Conectando...</span>
                </>
              ) : (
                <span>Acessar Limpador</span>
              )}
            </button>
          </form>
        </div>

        {/* Modal de Ajuda: Como pegar o Token no celular */}
        {showTokenModal && (
          <TokenHelperModal
            tab={tokenModalTab}
            setTab={setTokenModalTab}
            onClose={() => setShowTokenModal(false)}
            copiedBookmarklet={copiedBookmarklet}
            onCopyBookmarklet={() => copyText(BOOKMARKLET_CODE, setCopiedBookmarklet)}
            copiedEruda={copiedEruda}
            onCopyEruda={() => copyText(ERUDA_CODE, setCopiedEruda)}
            generatorToken={generatorToken}
            setGeneratorToken={setGeneratorToken}
            copiedGeneratedLink={copiedGeneratedLink}
            onGenerateLink={handleGenerateLink}
          />
        )}
      </div>
    );
  }

  // Usuário autenticado
  const recipient = selectedDm?.recipients?.[0];
  const dmName = recipient
    ? (recipient.global_name || recipient.username)
    : selectedDm?.name || (selectedDm ? `Canal ${selectedDm.id}` : '');
  const dmUsername = recipient?.username ? `@${recipient.username}` : '';
  const dmAvatar = getAvatarUrl(recipient);

  return (
    <div className="min-h-[100dvh] bg-[#1e1f22] text-[#f2f3f5] flex flex-col antialiased">
      {/* Top Header Mobile */}
      <header className="sticky top-0 z-30 bg-[#2b2d31]/95 backdrop-blur-md border-b border-[#383a40] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <img
              src={getAvatarUrl(user)}
              alt="Avatar"
              className="w-9 h-9 rounded-full object-cover bg-[#1e1f22]"
            />
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#23a55a] ring-2 ring-[#2b2d31]" />
          </div>
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-semibold truncate text-white leading-tight">
              {user.global_name || user.username}
            </p>
            <p className="text-[11px] text-[#949ba4] truncate font-mono">
              @{user.username}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Botão de Compartilhar Link para o Celular dela */}
          <button
            onClick={handleShareLink}
            title="Copiar link de acesso para o celular dela"
            className="p-2 rounded-xl bg-[#5865f2]/15 hover:bg-[#5865f2]/25 text-[#5865f2] border border-[#5865f2]/30 flex items-center gap-1.5 text-xs font-semibold transition-colors"
          >
            {copiedShareLink ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#23a55a]" />
                <span className="text-[#23a55a] hidden sm:inline">Link Copiado!</span>
              </>
            ) : (
              <>
                <Share2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Enviar pro Celular</span>
              </>
            )}
          </button>

          <button
            onClick={handleLogout}
            title="Sair / Trocar Conta"
            className="p-2 rounded-xl bg-[#1e1f22] hover:bg-[#35373c] text-[#949ba4] hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-[#2b2d31] border-b border-[#383a40] px-4 flex gap-2">
        <button
          onClick={() => setActiveTab('cleaner')}
          className={`py-2.5 px-3 border-b-2 text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition-colors ${
            activeTab === 'cleaner'
              ? 'border-[#5865f2] text-white'
              : 'border-transparent text-[#949ba4] hover:text-[#dbdee1]'
          }`}
        >
          <Trash2 className="w-4 h-4" />
          <span>Limpar DM</span>
        </button>
        <button
          onClick={() => setActiveTab('batch')}
          className={`py-2.5 px-3 border-b-2 text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition-colors ${
            activeTab === 'batch'
              ? 'border-[#5865f2] text-white'
              : 'border-transparent text-[#949ba4] hover:text-[#dbdee1]'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>Servidor (Lote)</span>
        </button>
      </div>

      {/* Conteúdo Principal */}
      <main className="flex-1 w-full max-w-lg mx-auto p-3 sm:p-4 pb-20 space-y-4">
        {activeTab === 'cleaner' ? (
          <>
            {/* Card de Conversa Selecionada */}
            {selectedDm ? (
              <section className="bg-[#2b2d31] rounded-2xl border border-[#383a40] p-4 sm:p-5 shadow-lg space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-[#383a40]">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={dmAvatar}
                      alt={dmName}
                      className="w-11 h-11 rounded-full object-cover bg-[#1e1f22]"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-[#5865f2]/20 text-[#5865f2] font-semibold text-[10px]">
                          {selectedDm.type === 3 ? 'Grupo' : 'DM'}
                        </span>
                        <h2 className="text-sm sm:text-base font-bold text-white truncate">
                          {dmName}
                        </h2>
                      </div>
                      {dmUsername && (
                        <p className="text-xs text-[#949ba4] truncate font-mono">
                          {dmUsername}
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => setSelectedDm(null)}
                    className="p-1.5 rounded-lg bg-[#1e1f22] text-[#949ba4] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Opções de Limpeza */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#b5bac1] mb-2">
                      Quantas mensagens suas apagar?
                    </label>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[10, 25, 50, 100, -1].map((amt) => (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => setAmount(amt)}
                          className={`py-2 rounded-xl text-xs font-semibold transition-all ${
                            amount === amt
                              ? 'bg-[#5865f2] text-white shadow-md'
                              : 'bg-[#1e1f22] text-[#b5bac1] hover:bg-[#35373c]'
                          }`}
                        >
                          {amt === -1 ? 'Todas' : amt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-[#b5bac1] mb-1.5">
                      Filtro de texto (opcional)
                    </label>
                    <input
                      type="text"
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                      placeholder="Apagar só mensagens que contêm..."
                      className="w-full px-3 py-2.5 bg-[#1e1f22] border border-[#383a40] rounded-xl text-xs sm:text-sm text-[#f2f3f5] placeholder-[#80848e] focus:outline-none focus:border-[#5865f2]"
                    />
                  </div>

                  {/* Informação sobre permissão */}
                  <div className="bg-[#1e1f22] rounded-xl p-3 border border-[#383a40] text-[11px] text-[#949ba4] flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-[#f0b232] shrink-0 mt-0.5" />
                    <span>
                      O Discord só permite que você apague as mensagens <strong>enviadas pela sua própria conta</strong>. As mensagens da outra pessoa permanecerão intactas.
                    </span>
                  </div>

                  {/* Botão de Ação */}
                  <button
                    type="button"
                    onClick={() => setShowConfirmModal(true)}
                    className="w-full py-3.5 bg-[#da373c] hover:bg-[#b82e33] text-white rounded-xl font-bold text-sm transition-all shadow-md active:scale-[0.99] flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Limpar {amount === -1 ? 'Todas as Mensagens' : `${amount} Mensagens`}</span>
                  </button>
                </div>
              </section>
            ) : (
              /* Seleção de Conversa */
              <section className="bg-[#2b2d31] rounded-2xl border border-[#383a40] p-4 sm:p-5 shadow-lg space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm sm:text-base font-bold text-white">
                      Suas Conversas Recentes
                    </h2>
                    <p className="text-xs text-[#949ba4]">
                      Toque na pessoa para limpar as mensagens
                    </p>
                  </div>
                  <button
                    onClick={() => loadDms()}
                    disabled={loadingDms}
                    className="p-2 rounded-xl bg-[#1e1f22] text-[#949ba4] hover:text-white transition-colors"
                    title="Atualizar conversas"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingDms ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {/* Campo de Busca */}
                <div className="relative">
                  <Search className="w-4 h-4 text-[#949ba4] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Buscar amigo por nome..."
                    className="w-full pl-9 pr-3 py-2 bg-[#1e1f22] border border-[#383a40] rounded-xl text-xs sm:text-sm text-[#f2f3f5] placeholder-[#80848e] focus:outline-none focus:border-[#5865f2]"
                  />
                </div>

                {/* Lista de DMs */}
                {loadingDms ? (
                  <div className="py-8 flex flex-col items-center justify-center gap-2 text-xs text-[#949ba4]">
                    <Loader2 className="w-5 h-5 animate-spin text-[#5865f2]" />
                    <span>Carregando conversas...</span>
                  </div>
                ) : filteredDms.length > 0 ? (
                  <div className="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1">
                    {filteredDms.map((dm) => {
                      const other = dm.recipients?.[0];
                      const name = other
                        ? (other.global_name || other.username)
                        : dm.name || `Canal ${dm.id}`;
                      const username = other?.username ? `@${other.username}` : '';
                      const avatar = getAvatarUrl(other);

                      return (
                        <button
                          key={dm.id}
                          type="button"
                          onClick={() => setSelectedDm(dm)}
                          className="w-full p-2.5 rounded-xl bg-[#1e1f22] hover:bg-[#35373c] border border-transparent hover:border-[#383a40] flex items-center gap-3 text-left transition-all active:scale-[0.99]"
                        >
                          <img
                            src={avatar}
                            alt={name}
                            className="w-10 h-10 rounded-full object-cover shrink-0 bg-[#2b2d31]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs sm:text-sm font-semibold text-white truncate">
                                {name}
                              </span>
                              {dm.type === 3 && (
                                <span className="text-[10px] bg-[#5865f2]/20 text-[#5865f2] px-1 rounded font-medium">
                                  Grupo
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-[#949ba4] truncate font-mono">
                              {username || dm.id}
                            </p>
                          </div>
                          <ChevronDown className="w-4 h-4 text-[#80848e] -rotate-90 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-6 text-center text-xs text-[#949ba4] bg-[#1e1f22] rounded-xl border border-[#383a40] p-4">
                    Nenhuma conversa aberta encontrada.
                  </div>
                )}

                {/* Opção Manual */}
                <div className="pt-2 border-t border-[#383a40] space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#b5bac1] block">
                    Ou digite o ID do usuário / canal
                  </span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualId}
                      onChange={(e) => setManualId(e.target.value)}
                      placeholder="ID do amigo ou ID do canal..."
                      className="flex-1 px-3 py-2.5 bg-[#1e1f22] border border-[#383a40] rounded-xl text-xs sm:text-sm text-[#f2f3f5] placeholder-[#80848e] font-mono focus:outline-none focus:border-[#5865f2]"
                    />
                    <button
                      type="button"
                      onClick={handleResolveManual}
                      disabled={manualLoading || !manualId.trim()}
                      className="px-4 py-2.5 bg-[#5865f2] hover:bg-[#4752c4] disabled:bg-[#5865f2]/40 text-white rounded-xl text-xs font-semibold shrink-0 transition-colors"
                    >
                      {manualLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Abrir'}
                    </button>
                  </div>
                  {manualError && (
                    <p className="text-xs text-[#f23f43]">{manualError}</p>
                  )}
                </div>
              </section>
            )}
          </>
        ) : (
          /* Aba de Lote Legada */
          <section className="bg-[#2b2d31] rounded-2xl border border-[#383a40] p-4 sm:p-5 shadow-lg space-y-4">
            <h2 className="text-base font-bold text-white">Administração em Lote (Servidor)</h2>
            <p className="text-xs text-[#949ba4]">
              Funções para criar cargos, canais e convites em massa em servidores.
            </p>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#b5bac1] mb-1.5">
                ID do Servidor
              </label>
              <input
                type="text"
                value={batchGuildId}
                onChange={(e) => setBatchGuildId(e.target.value)}
                placeholder="123456789012345678"
                className="w-full px-3 py-2.5 bg-[#1e1f22] border border-[#383a40] rounded-xl text-xs sm:text-sm font-mono text-white focus:outline-none focus:border-[#5865f2]"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() =>
                  runBatch('/api/batch/invites', {
                    channels: ['123456789012345678'],
                    maxAge: 0,
                    maxUses: 0,
                  })
                }
                className="py-2.5 bg-[#1e1f22] hover:bg-[#35373c] text-white rounded-xl text-xs font-semibold border border-[#383a40]"
              >
                Criar Convites
              </button>
              <button
                type="button"
                onClick={() =>
                  runBatch('/api/batch/roles', {
                    roles: [{ name: 'Novo Cargo', color: 0 }],
                  })
                }
                className="py-2.5 bg-[#1e1f22] hover:bg-[#35373c] text-white rounded-xl text-xs font-semibold border border-[#383a40]"
              >
                Criar Cargos
              </button>
              <button
                type="button"
                onClick={() =>
                  runBatch('/api/batch/channels', {
                    channels: [{ name: 'novo-canal', type: 0 }],
                  })
                }
                className="py-2.5 bg-[#1e1f22] hover:bg-[#35373c] text-white rounded-xl text-xs font-semibold border border-[#383a40]"
              >
                Criar Canais
              </button>
            </div>

            {batchLogs.length > 0 && (
              <div className="bg-[#1e1f22] rounded-xl p-3 border border-[#383a40] text-xs font-mono text-[#949ba4] max-h-36 overflow-y-auto space-y-1">
                {batchLogs.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Modal de Confirmação */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#2b2d31] rounded-2xl border border-[#383a40] p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#da373c]/15 text-[#da373c] flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm sm:text-base font-bold text-white">Confirmar Limpeza</h3>
                <p className="text-xs text-[#949ba4]">Esta ação não pode ser desfeita.</p>
              </div>
            </div>

            <p className="text-xs text-[#dbdee1] leading-relaxed">
              Você está prestes a apagar as suas mensagens na conversa com{' '}
              <strong className="text-white">{dmName}</strong>. Deseja continuar?
            </p>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 rounded-xl bg-[#1e1f22] hover:bg-[#35373c] text-[#dbdee1] font-semibold text-xs"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={startPurge}
                className="flex-1 py-2.5 rounded-xl bg-[#da373c] hover:bg-[#b82e33] text-white font-bold text-xs shadow-md"
              >
                Sim, Limpar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal / Overlay de Progresso ao Vivo */}
      {(purging || purgeDone || purgeError) && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#2b2d31] rounded-2xl border border-[#383a40] p-5 sm:p-6 shadow-2xl space-y-5 text-center">
            {purgeDone ? (
              <div className="w-14 h-14 rounded-full bg-[#23a55a]/15 text-[#23a55a] flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
            ) : purgeError ? (
              <div className="w-14 h-14 rounded-full bg-[#da373c]/15 text-[#da373c] flex items-center justify-center mx-auto">
                <AlertCircle className="w-8 h-8" />
              </div>
            ) : (
              <div className="w-14 h-14 rounded-full bg-[#5865f2]/15 text-[#5865f2] flex items-center justify-center mx-auto">
                <Loader2 className="w-8 h-8 animate-spin" />
              </div>
            )}

            <div className="space-y-1">
              <h3 className="text-base sm:text-lg font-bold text-white">
                {purgeDone
                  ? 'Limpeza Concluída!'
                  : purgeError
                  ? 'Falha na Limpeza'
                  : 'Limpando Conversa...'}
              </h3>
              <p className="text-xs text-[#949ba4]">
                {purgeError || progress.statusText}
              </p>
            </div>

            {/* Contador */}
            <div className="bg-[#1e1f22] rounded-xl p-4 border border-[#383a40] space-y-2">
              <div className="flex items-baseline justify-center gap-1.5">
                <span className="text-3xl font-extrabold text-white">
                  {progress.deleted}
                </span>
                {progress.target !== -1 && (
                  <span className="text-xs text-[#949ba4]">/ {progress.target}</span>
                )}
                <span className="text-xs font-semibold text-[#b5bac1] ml-1">
                  mensagens apagadas
                </span>
              </div>

              {progress.snippet && (
                <p className="text-[11px] text-[#80848e] truncate font-mono bg-[#2b2d31] px-2 py-1 rounded">
                  {progress.snippet}
                </p>
              )}

              {progress.rateLimitWait > 0 && (
                <div className="text-[11px] text-[#f0b232] font-semibold animate-pulse">
                  Pausa de segurança do Discord: aguardando {progress.rateLimitWait}s...
                </div>
              )}
            </div>

            {/* Ações */}
            <div className="pt-1">
              {purging ? (
                <button
                  type="button"
                  onClick={stopPurge}
                  className="w-full py-3 bg-[#da373c] hover:bg-[#b82e33] text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-[0.99]"
                >
                  Interromper Agora
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setPurgeDone(false);
                    setPurgeError('');
                  }}
                  className="w-full py-3 bg-[#5865f2] hover:bg-[#4752c4] text-white rounded-xl text-xs font-bold transition-all shadow-md active:scale-[0.99]"
                >
                  Fechar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Subcomponente: Modal interativo de ajuda para obter token no celular
function TokenHelperModal({
  tab,
  setTab,
  onClose,
  copiedBookmarklet,
  onCopyBookmarklet,
  copiedEruda,
  onCopyEruda,
  generatorToken,
  setGeneratorToken,
  copiedGeneratedLink,
  onGenerateLink,
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-lg bg-[#2b2d31] rounded-2xl border border-[#383a40] shadow-2xl p-5 sm:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-2 border-b border-[#383a40]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#5865f2]/15 text-[#5865f2] flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">Como Pegar o Token</h3>
              <p className="text-[11px] text-[#949ba4]">Escolha a forma mais fácil para você</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-[#1e1f22] text-[#949ba4] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Abas */}
        <div className="grid grid-cols-3 gap-1 bg-[#1e1f22] p-1 rounded-xl text-xs font-semibold">
          <button
            onClick={() => setTab('magic')}
            className={`py-2 rounded-lg transition-all ${
              tab === 'magic'
                ? 'bg-[#5865f2] text-white shadow-sm'
                : 'text-[#949ba4] hover:text-white'
            }`}
          >
            Link Mágico
          </button>
          <button
            onClick={() => setTab('bookmarklet')}
            className={`py-2 rounded-lg transition-all ${
              tab === 'bookmarklet'
                ? 'bg-[#5865f2] text-white shadow-sm'
                : 'text-[#949ba4] hover:text-white'
            }`}
          >
            No Celular
          </button>
          <button
            onClick={() => setTab('pc')}
            className={`py-2 rounded-lg transition-all ${
              tab === 'pc'
                ? 'bg-[#5865f2] text-white shadow-sm'
                : 'text-[#949ba4] hover:text-white'
            }`}
          >
            Pelo PC
          </button>
        </div>

        {/* Conteúdo Aba 1: Link Mágico (O namorado gera pro celular dela) */}
        {tab === 'magic' && (
          <div className="space-y-3.5 text-xs text-[#dbdee1]">
            <div className="bg-[#5865f2]/10 border border-[#5865f2]/25 rounded-xl p-3 space-y-1.5">
              <p className="font-bold text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-[#5865f2]" />
                O jeito mais fácil (Ela não precisa fazer nada!):
              </p>
              <p className="text-[#949ba4] leading-relaxed">
                Você pode gerar um link com o token dela já embutido. Quando ela abrir o link no WhatsApp pelo celular, o app já entra <strong>automaticamente conectado</strong> e salva no aparelho dela!
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#b5bac1]">
                Cole o token aqui para gerar o link dela:
              </label>
              <input
                type="text"
                value={generatorToken}
                onChange={(e) => setGeneratorToken(e.target.value)}
                placeholder="Cole o token da conta dela..."
                className="w-full px-3 py-2.5 bg-[#1e1f22] border border-[#383a40] rounded-xl text-xs font-mono text-white focus:outline-none focus:border-[#5865f2]"
              />
              <button
                type="button"
                onClick={onGenerateLink}
                disabled={!generatorToken.trim()}
                className="w-full py-2.5 bg-[#5865f2] hover:bg-[#4752c4] disabled:bg-[#5865f2]/40 text-white rounded-xl font-bold flex items-center justify-center gap-1.5 transition-colors"
              >
                {copiedGeneratedLink ? (
                  <>
                    <Check className="w-4 h-4 text-[#23a55a]" />
                    <span>Link Copiado para o WhatsApp!</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4" />
                    <span>Copiar Link Mágico para Ela</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Conteúdo Aba 2: Extrator no Celular (Bookmarklet) */}
        {tab === 'bookmarklet' && (
          <div className="space-y-3.5 text-xs text-[#dbdee1]">
            <p className="text-[#949ba4]">
              Se ela quiser extrair o token <strong>diretamente pelo celular</strong> usando o Chrome ou Safari:
            </p>

            <div className="bg-[#1e1f22] rounded-xl p-3 border border-[#383a40] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-white text-[11px] uppercase tracking-wider">
                  Extrator de 1 Toque
                </span>
                <button
                  type="button"
                  onClick={onCopyBookmarklet}
                  className="px-2.5 py-1 rounded-lg bg-[#5865f2] hover:bg-[#4752c4] text-white text-[11px] font-semibold flex items-center gap-1"
                >
                  {copiedBookmarklet ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Copiado!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copiar Código</span>
                    </>
                  )}
                </button>
              </div>

              <ol className="list-decimal pl-4 space-y-1.5 text-[#b5bac1]">
                <li>Clique no botão acima para copiar o código.</li>
                <li>
                  No navegador do celular (Chrome ou Safari), abra{' '}
                  <span className="text-[#5865f2] font-semibold">discord.com/app</span> e entre na conta.
                </li>
                <li>
                  Na barra de endereço do navegador, apague tudo, digite a palavra{' '}
                  <code className="text-white bg-[#2b2d31] px-1 py-0.5 rounded font-bold">javascript:</code>{' '}
                  e cole o código logo em seguida.
                </li>
                <li>Dê Enter. Seu token aparecerá na tela copiado na hora!</li>
              </ol>
            </div>

            {/* Alternativa Eruda */}
            <div className="pt-1 border-t border-[#383a40] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#949ba4]">Opção B: Abrir Console Móvel (Eruda)</span>
                <button
                  type="button"
                  onClick={onCopyEruda}
                  className="text-[#5865f2] hover:underline flex items-center gap-1 text-[11px]"
                >
                  {copiedEruda ? <Check className="w-3 h-3 text-[#23a55a]" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedEruda ? 'Copiado!' : 'Copiar Eruda'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Conteúdo Aba 3: Pelo PC */}
        {tab === 'pc' && (
          <div className="space-y-3 text-xs text-[#dbdee1]">
            <p className="text-[#949ba4]">
              No computador, você pega o token em menos de 10 segundos:
            </p>
            <ol className="list-decimal pl-4 space-y-2 text-[#b5bac1]">
              <li>
                Abra o Discord no navegador (Chrome, Edge, Brave ou Opera) e entre na conta.
              </li>
              <li>
                Pressione <kbd className="bg-[#1e1f22] border border-[#383a40] px-1.5 py-0.5 rounded text-white font-mono">Ctrl + Shift + I</kbd> (ou clique com botão direito &gt; Inspecionar).
              </li>
              <li>
                Vá na aba <strong>Console</strong>, cole o código abaixo e dê Enter:
                <div className="mt-1.5 bg-[#1e1f22] p-2.5 rounded-lg border border-[#383a40] font-mono text-[11px] text-[#5865f2] break-all select-all">
                  (webpackChunkdiscord_app.push([[''],{},e=&gt;&#123;m=[];for(let c in e.c)m.push(e.c[c])&#125;]),m).find(m=&gt;m?.exports?.default?.getToken!==void 0).exports.default.getToken()
                </div>
              </li>
              <li>Copie o token exibido e use na Aba &quot;Link Mágico&quot; para mandar pro celular dela!</li>
            </ol>
          </div>
        )}

        <div className="pt-2 border-t border-[#383a40]">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 bg-[#1e1f22] hover:bg-[#35373c] text-white rounded-xl text-xs font-semibold transition-colors"
          >
            Entendi / Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
