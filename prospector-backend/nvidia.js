// nvidia.js — Agente de IA para extração e análise de dados de prospecção
// Modelo principal: z-ai/glm4.7 (thinking) via NVIDIA NIM
// Fallback: Claude (Anthropic)

const OpenAI = require('openai');
const axios  = require('axios');

// ─── Validação de chave (sincronizada com server.js) ──────────────────────────
function chaveNvidiaValida() {
  const key = process.env.NVIDIA_API_KEY || '';
  return key.length > 10 && !key.includes('xxxx') && !key.includes('seu_token');
}

// ─── Cliente NVIDIA (OpenAI-compatible) ───────────────────────────────────────
function criarClienteNvidia() {
  return new OpenAI({
    apiKey:  process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Prompt para processar resultados brutos do Google Search
 */
function buildPromptGoogle(resultados, regiao, setor) {
  const texto = resultados
    .slice(0, 20)
    .map(r => `Título: ${r.title}\nURL: ${r.link}\nDescrição: ${r.snippet || ''}`)
    .join('\n\n---\n\n');

  return `Você é um agente de prospecção comercial especializado no mercado brasileiro.

Analise os resultados de busca abaixo sobre "${setor}" na região de "${regiao}" e extraia informações de empresas.

Para cada empresa encontrada, retorne um JSON com o formato EXATO abaixo:

{
  "empresas": [
    {
      "nome_empresa": "Nome completo da empresa",
      "cnpj": "XX.XXX.XXX/XXXX-XX ou vazio",
      "setor": "Setor de atuação",
      "cidade_uf": "Cidade/UF",
      "endereco": "Endereço completo se disponível ou vazio",
      "resumo_negocio": "Resumo de 2 linhas sobre o que a empresa faz",
      "contatos": [
        {
          "nome": "Nome da pessoa",
          "cargo": "Cargo (Dono, Sócio, Diretor, Gerente)",
          "tipo": "dono | socio | diretor | gerente",
          "telefone": "(XX) XXXXX-XXXX ou vazio",
          "email": "email@empresa.com ou vazio",
          "linkedin_perfil": "URL do perfil LinkedIn ou vazio"
        }
      ],
      "telefone_empresa": "(XX) XXXXX-XXXX ou vazio",
      "email_empresa": "email@empresa.com ou vazio",
      "instagram": "@usuario ou URL ou vazio",
      "linkedin": "URL da empresa no LinkedIn ou vazio",
      "site": "URL completa ou vazio",
      "fonte": "google_search",
      "prioridade": "Alta | Média | Baixa"
    }
  ]
}

REGRAS:
- Prioridade "Alta" = tem telefone direto do decisor (dono/sócio/diretor)
- Prioridade "Média" = tem empresa com telefone geral ou email
- Prioridade "Baixa" = poucos dados encontrados
- O campo "fonte" deve SEMPRE ser "google_search"
- Não invente dados — deixe vazio se não tiver certeza
- Retorne APENAS o JSON, sem texto adicional, sem markdown, sem \`\`\`

RESULTADOS DE BUSCA DO GOOGLE:
${texto}`;
}

/**
 * Prompt para enriquecer dados do Apify (Maps + LinkedIn) em lote
 * Processa até BATCH_SIZE empresas por chamada para não perder dados
 */
function buildPromptEnriquecimento(empresas, regiao, setor) {
  const texto = empresas
    .map((e, i) => `
[${i + 1}] ${e.nome_empresa}
  Endereço: ${e.endereco || '?'}
  Telefone: ${e.telefone_empresa || '?'}
  Site: ${e.site || '?'}
  LinkedIn: ${e.linkedin || '?'}
  Instagram: ${e.instagram || '?'}
  Resumo: ${e.resumo_negocio || '?'}
  Contatos: ${(e.contatos || []).map(c => `${c.nome} (${c.cargo})`).join(', ') || 'nenhum'}
  Prioridade atual: ${e.prioridade || '?'}
`.trim()).join('\n\n---\n\n');

  return `Você é um agente de prospecção B2B especializado no mercado brasileiro.

Recebeu uma lista de ${empresas.length} empresas do setor "${setor}" na região de "${regiao}" coletadas via Google Maps e LinkedIn.

Sua tarefa:
1. Analise cada empresa e melhore os campos incompletos com base no contexto
2. Para empresas sem resumo, deduza a atividade pelo nome e setor
3. Classifique a prioridade:
   - "Alta" = contato direto (dono/sócio/diretor) com telefone
   - "Média" = telefone da empresa OU contato sem telefone
   - "Baixa" = só nome/endereço, sem contato funcional
4. NÃO invente telefones ou emails — deixe vazio se não souber
5. Retorne EXATAMENTE ${empresas.length} empresas na mesma ordem

Retorne o JSON com o formato EXATO (sem markdown, sem \`\`\`):

{
  "empresas": [
    {
      "nome_empresa": "...",
      "cnpj": "...",
      "setor": "...",
      "cidade_uf": "...",
      "endereco": "...",
      "resumo_negocio": "...",
      "contatos": [{"nome":"","cargo":"","tipo":"","telefone":"","email":"","linkedin_perfil":""}],
      "telefone_empresa": "...",
      "email_empresa": "...",
      "instagram": "...",
      "linkedin": "...",
      "site": "...",
      "fonte": "google_maps",
      "prioridade": "Alta | Média | Baixa"
    }
  ]
}

EMPRESAS (${empresas.length} no total):
${texto}`;
}

// ─── Agente GLM4.7 (thinking) ─────────────────────────────────────────────────

async function chamarGLM(prompt) {
  const client = criarClienteNvidia();

  const stream = await client.chat.completions.create({
    model: 'z-ai/glm4.7',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 16384,
    chat_template_kwargs: {
      enable_thinking: true,
      clear_thinking: false,
    },
    stream: true,
  });

  let thinking = '';
  let conteudo = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.reasoning_content) thinking += delta.reasoning_content;
    if (delta?.content)           conteudo  += delta.content;
  }

  if (thinking) {
    console.log(`[glm4.7] Raciocínio interno: ${thinking.length} chars`);
  }

  return conteudo.trim();
}

// ─── Fallback Claude ──────────────────────────────────────────────────────────

async function chamarClaude(prompt) {
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 60000,
    }
  );
  return data.content[0].text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * BUG #3 fix: parse JSON com logging detalhado de falhas
 */
function parseJSON(texto) {
  const limpo = texto.replace(/```json|```/g, '').trim();
  const json = JSON.parse(limpo);

  // BUG #3 fix: logar quando chave 'empresas' não está presente
  if (!json.empresas) {
    console.warn('[ia] ⚠️  JSON retornado sem campo "empresas". Chaves presentes:', Object.keys(json));
    return [];
  }

  return json.empresas;
}

function escolherProvider() {
  // BUG #18 fix: mesma lógica de chaveNvidiaValida() sincronizada
  if (chaveNvidiaValida()) return 'glm';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

async function chamarIA(prompt) {
  const provider = escolherProvider();

  if (provider === 'glm') {
    console.log('[ia] Provider: GLM4.7 (NVIDIA NIM — thinking)');
    try {
      return await chamarGLM(prompt);
    } catch (err) {
      console.error('[ia] Erro GLM4.7:', err.message);
      if (process.env.ANTHROPIC_API_KEY) {
        console.log('[ia] Fallback para Claude...');
        return await chamarClaude(prompt);
      }
      throw err;
    }
  }

  if (provider === 'claude') {
    console.log('[ia] Provider: Claude (Anthropic)');
    return await chamarClaude(prompt);
  }

  throw new Error('Nenhum provider de IA configurado (NVIDIA_API_KEY ou ANTHROPIC_API_KEY)');
}

// ─── Funções exportadas ───────────────────────────────────────────────────────

/**
 * Extrai empresas dos resultados brutos do Google Search
 */
async function extrairDadosComIA(resultadosBrutos, regiao = '', setor = '') {
  if (!resultadosBrutos || resultadosBrutos.length === 0) return [];

  const prompt = buildPromptGoogle(resultadosBrutos, regiao, setor);

  try {
    const resposta = await chamarIA(prompt);
    const empresas = parseJSON(resposta);
    console.log(`[ia] ${empresas.length} empresas extraídas do Google Search`);
    return empresas;
  } catch (err) {
    console.error('[ia] Erro na extração Google:', err.message);
    return [];
  }
}

/**
 * BUG #4 fix: processa em lotes de 25 para não perder empresas além do limite do prompt
 * Enriquece e analisa empresas vindas do Apify (Maps + LinkedIn)
 */
async function enriquecerComIA(empresas, regiao = '', setor = '') {
  if (!empresas || empresas.length === 0) return empresas;

  const BATCH_SIZE = 25;

  // Se cabe em um único lote, processa direto
  if (empresas.length <= BATCH_SIZE) {
    return await _enriquecerLote(empresas, regiao, setor);
  }

  // Mais de 25: processa em lotes e concatena o resultado
  console.log(`[ia] Processando em ${Math.ceil(empresas.length / BATCH_SIZE)} lotes de ${BATCH_SIZE}...`);
  const resultado = [];

  for (let i = 0; i < empresas.length; i += BATCH_SIZE) {
    const lote = empresas.slice(i, i + BATCH_SIZE);
    console.log(`[ia] Lote ${Math.floor(i / BATCH_SIZE) + 1}: empresas ${i + 1}–${i + lote.length}`);
    const loteEnriquecido = await _enriquecerLote(lote, regiao, setor);
    resultado.push(...loteEnriquecido);
  }

  console.log(`[ia] Total após enriquecimento em lotes: ${resultado.length} empresas`);
  return resultado;
}

async function _enriquecerLote(lote, regiao, setor) {
  const prompt = buildPromptEnriquecimento(lote, regiao, setor);
  try {
    const resposta = await chamarIA(prompt);
    const enriquecidas = parseJSON(resposta);

    // Se a IA devolveu menos do que recebeu, mantém as originais para o excedente
    if (enriquecidas.length === 0) {
      console.warn('[ia] Lote retornou 0 empresas — mantendo originais');
      return lote;
    }

    // Mescla: prefere dados enriquecidos, mas preserva campos que a IA deixou vazios
    return lote.map((original, idx) => {
      const enriq = enriquecidas[idx];
      if (!enriq) return original;
      return {
        ...original,
        ...enriq,
        // Mantém campos originais se a IA os devolveu vazios
        telefone_empresa: enriq.telefone_empresa || original.telefone_empresa || '',
        endereco:         enriq.endereco         || original.endereco         || '',
        linkedin:         enriq.linkedin         || original.linkedin         || '',
        site:             enriq.site             || original.site             || '',
        instagram:        enriq.instagram        || original.instagram        || '',
        // Mantém contatos originais (do LinkedIn) se a IA não retornou nenhum
        contatos: (enriq.contatos && enriq.contatos.length > 0)
          ? enriq.contatos
          : original.contatos || [],
        // Preserva fonte original — não deixa a IA sobrescrever
        fonte: original.fonte || enriq.fonte || '',
      };
    });
  } catch (err) {
    console.error('[ia] Erro no lote:', err.message);
    return lote;
  }
}

module.exports = { extrairDadosComIA, enriquecerComIA };
