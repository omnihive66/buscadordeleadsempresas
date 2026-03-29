// server.js — Servidor principal do Prospector
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { buscarNoGoogle, buscarCNPJ }                        = require('./busca');
const { extrairDadosComIA, enriquecerComIA }                = require('./nvidia');
const { gerarExcel }                                        = require('./exportar');
const {
  apifyHabilitado,
  buscarNoGoogleMaps,
  buscarEmpresasLinkedIn,
  buscarResponsaveisLinkedIn,
  mesclarEmpresas,
  injetarResponsaveis,
} = require('./apify');

const app  = express();
const PORT = process.env.PORT || 3001;

// BASE_URL para gerar links de download — configur em produção
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Vercel: sistema de arquivos read-only — arquivos Excel vão para /tmp
const EXPORT_DIR = (process.env.VERCEL || process.env.NODE_ENV === 'production')
  ? '/tmp'
  : path.join(__dirname, 'exports');

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/exports', express.static(EXPORT_DIR));

// ── Validação das chaves na inicialização ─────────────────────────────────────
function chaveNvidiaValida() {
  const key = process.env.NVIDIA_API_KEY || '';
  return key.length > 10 && !key.includes('xxxx') && !key.includes('seu_token');
}

function validarConfig() {
  const erros = [];
  if (!process.env.SERP_API_KEY || process.env.SERP_API_KEY.includes('sua_chave')) {
    erros.push('SERP_API_KEY não configurada');
  }
  if (!chaveNvidiaValida() && !process.env.ANTHROPIC_API_KEY) {
    erros.push('Configure NVIDIA_API_KEY ou ANTHROPIC_API_KEY');
  }
  return erros;
}

// ── Timeout helper ────────────────────────────────────────────────────────────
function comTimeout(promise, ms, nome) {
  const limite = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${nome} excedeu ${ms / 1000}s`)), ms)
  );
  return Promise.race([promise, limite]);
}

// ── Rota: status do servidor ──────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const erros = validarConfig();
  const ia = process.env.ANTHROPIC_API_KEY ? 'claude' : 'glm4.7 (nvidia)';
  res.json({
    ok:           erros.length === 0,
    erros,
    ia_provider:  ia,
    apify_ativo:  apifyHabilitado(),
    timestamp:    new Date().toISOString(),
  });
});

// ── Rota: busca principal ─────────────────────────────────────────────────────
app.post('/buscar', async (req, res) => {
  const { regiao, setor } = req.body;

  if (!regiao?.trim() || !setor?.trim()) {
    return res.status(400).json({ erro: 'Informe região e setor' });
  }

  const erros = validarConfig();
  if (erros.length > 0) {
    return res.status(500).json({ erro: `Configuração incompleta: ${erros.join(', ')}` });
  }

  try {
    console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Buscando: "${setor}" em "${regiao}"`);

    // ── 1. Buscar em todas as fontes ──────────────────────────────────────────
    // SerpAPI roda em paralelo com os actors Apify.
    // Os dois actors Apify (Maps + LinkedIn) rodam SEQUENCIALMENTE entre si
    // para respeitar o limite de 1 run simultâneo do plano FREE do Apify.
    const [resultadosGoogle, [empresasMaps, empresasLinkedIn]] = await comTimeout(
      Promise.all([
        buscarNoGoogle(regiao, setor),
        // Sequencial: Maps primeiro, depois LinkedIn
        (async () => {
          const maps    = await buscarNoGoogleMaps(regiao, setor);
          const linkedin = await buscarEmpresasLinkedIn(regiao, setor);
          return [maps, linkedin];
        })(),
      ]),
      350_000,
      'busca de dados'
    );

    console.log(`[server] Google Search: ${resultadosGoogle.length} | Maps: ${empresasMaps.length} | LinkedIn: ${empresasLinkedIn.length}`);

    // ── 2. Extrair dados do Google Search via IA ──────────────────────────────
    let empresasGoogle = [];
    if (resultadosGoogle.length > 0) {
      empresasGoogle = await extrairDadosComIA(resultadosGoogle, regiao, setor);
    }

    // ── 3. Mesclar as três fontes ─────────────────────────────────────────────
    let empresas = mesclarEmpresas(empresasMaps, empresasGoogle, empresasLinkedIn);

    if (empresas.length === 0) {
      return res.json({ empresas: [], total: 0, aviso: 'Nenhuma empresa encontrada nas fontes disponíveis' });
    }

    // ── 3b. Agente GLM4.7 (thinking) enriquece dados do Apify ────────────────
    if (empresasMaps.length > 0 || empresasLinkedIn.length > 0) {
      console.log(`[server] Agente GLM4.7 analisando ${empresas.length} empresas do Apify...`);
      empresas = await enriquecerComIA(empresas, regiao, setor);
    }

    // ── 4. Buscar responsáveis no LinkedIn ────────────────────────────────────
    const urlsLinkedIn = empresas
      .map(e => e.linkedin)
      .filter(u => u && u.includes('linkedin.com/company'));

    if (urlsLinkedIn.length > 0) {
      console.log(`[server] Buscando responsáveis para ${urlsLinkedIn.length} empresa(s) no LinkedIn...`);
      const mapaResponsaveis = await buscarResponsaveisLinkedIn(urlsLinkedIn, regiao);
      empresas = injetarResponsaveis(empresas, mapaResponsaveis);
    }

    // ── 5. Enriquecer com dados do CNPJ ──────────────────────────────────────
    const enriquecidas = await Promise.all(
      empresas.map(async (e) => {
        if (e.cnpj) {
          const dadosCNPJ = await buscarCNPJ(e.cnpj);
          if (dadosCNPJ) {
            e.telefone_empresa = e.telefone_empresa || dadosCNPJ.telefone || '';
            e.endereco = e.endereco || [
              dadosCNPJ.logradouro,
              dadosCNPJ.municipio,
              dadosCNPJ.uf,
            ].filter(Boolean).join(', ');

            if (!e.contatos || e.contatos.length === 0) {
              // BUG #6 fix: garantir cargo sempre como string (s.qual pode ser undefined)
              e.contatos = dadosCNPJ.socios.map(s => ({
                nome:            s.nome            || '',
                cargo:           s.cargo           || s.qual || '',
                tipo:            'socio',
                telefone:        '',
                email:           dadosCNPJ.email   || '',
                linkedin_perfil: '',
              }));
            }
          }
        }
        return e;
      })
    );

    // ── 6. Gerar planilha ─────────────────────────────────────────────────────
    const { nomeArquivo } = gerarExcel(enriquecidas, regiao, setor);

    console.log(`✅ Concluído: ${enriquecidas.length} empresas (${empresasMaps.length} Maps | ${empresasGoogle.length} Google IA | ${empresasLinkedIn.length} LinkedIn)\n`);

    res.json({
      empresas:   enriquecidas,
      total:      enriquecidas.length,
      fontes: {
        google_search: empresasGoogle.length,
        google_maps:   empresasMaps.length,
        linkedin:      empresasLinkedIn.length,
      },
      // BUG #11 fix: usa BASE_URL em vez de localhost hardcoded
      excel_url:  `${BASE_URL}/exports/${nomeArquivo}`,
      excel_nome: nomeArquivo,
    });

  } catch (err) {
    console.error('❌ Erro interno:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Rota: download direto ─────────────────────────────────────────────────────
app.get('/download/:arquivo', (req, res) => {
  const caminho = path.join(EXPORT_DIR, req.params.arquivo);
  res.download(caminho, (err) => {
    if (err) res.status(404).json({ erro: 'Arquivo não encontrado' });
  });
});

// ── Start (desenvolvimento local) ─────────────────────────────────────────────
// Em produção (Vercel), o app é exportado abaixo e não usa listen
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    const erros = validarConfig();
    console.log(`\n🚀 Prospector Backend rodando em http://localhost:${PORT}`);
    console.log(`📡 IA provider: ${process.env.ANTHROPIC_API_KEY ? 'Claude (Anthropic)' : 'GLM4.7 (NVIDIA NIM — thinking)'}`);
    console.log(`🗺  Apify (Google Maps + LinkedIn): ${apifyHabilitado() ? '✅ ativo' : '⚠️  não configurado (APIFY_API_TOKEN)'}`);
    if (erros.length > 0) {
      console.warn(`⚠️  Atenção: ${erros.join(' | ')}`);
      console.warn(`   Configure o arquivo .env com base no .env.example`);
    } else {
      console.log(`✅ Configuração OK — pronto para buscar!\n`);
    }
  });
}

// Exporta o app para o Vercel (serverless)
module.exports = app;
