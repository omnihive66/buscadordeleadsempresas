// apify.js — Integração com Apify (Google Maps + LinkedIn)
const axios = require('axios');

const APIFY_BASE = 'https://api.apify.com/v2/acts';

function token() {
  return process.env.APIFY_API_TOKEN;
}

function apifyHabilitado() {
  return !!(token() && !token().includes('seu_token'));
}

/**
 * Executa um actor do Apify de forma síncrona e retorna os itens do dataset
 */
async function runActor(actorId, input, timeoutSecs = 20) {
  const url = `${APIFY_BASE}/${actorId}/run-sync-get-dataset-items`;
  try {
    const { data } = await axios.post(url, input, {
      params: { token: token(), timeout: timeoutSecs, memory: 512 },
      headers: { 'Content-Type': 'application/json' },
      timeout: (timeoutSecs + 30) * 1000,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.message;
    console.error(`[apify] Erro no actor ${actorId}: HTTP ${status} — ${msg}`);
    return [];
  }
}

// ─── Google Maps ──────────────────────────────────────────────────────────────

/**
 * Busca empresas no Google Maps via Apify
 * Campos reais retornados pelo actor compass/crawler-google-places:
 *  title, address, phones[], emails[], linkedIns[], instagrams[], website, city, state
 */
async function buscarNoGoogleMaps(regiao, setor) {
  if (!apifyHabilitado()) {
    console.log('[apify/maps] APIFY_API_TOKEN não configurado — pulando Google Maps');
    return [];
  }

  console.log(`[apify/maps] Buscando "${setor}" em "${regiao}"`);
  try {
    const resultados = await runActor('compass~crawler-google-places', {
      searchStringsArray: [setor],
      locationQuery: regiao,
      maxCrawledPlacesPerSearch: 10,
      language: 'pt-BR',
      countryCode: 'br',
      // scrapeContacts removido — causa run de 0 itens em 8s no plano FREE
      skipClosedPlaces: false,
    }, 22);

    const empresas = resultados
      .filter(r => r.title)
      .map(r => normalizarResultadoMaps(r, regiao, setor));

    console.log(`[apify/maps] ${empresas.length} empresas encontradas`);
    return empresas;
  } catch (err) {
    console.error('[apify/maps] Erro:', err.message);
    return [];
  }
}

function normalizarResultadoMaps(r, regiao, setor) {
  const nome     = r.title || '';
  const endereco = r.address || '';
  const cidade   = r.city   || '';
  const estado   = r.state  || '';
  const cidadeUf = cidade && estado ? `${cidade}/${estado}` : (cidade || regiao);

  // Campos reais: phones[] e emails[] (arrays)
  const telefone = (r.phones && r.phones[0]) || r.phone || '';
  const email    = (r.emails && r.emails[0]) || r.email || '';

  // Redes sociais: linkedIns[], instagrams[] (arrays)
  const linkedin  = (r.linkedIns  && r.linkedIns[0])  || '';
  const instagram = (r.instagrams && r.instagrams[0]) || '';

  // WhatsApp e outros
  const whatsapp = (r.whatsapps && r.whatsapps[0]) || '';
  const telFinal = whatsapp || telefone;

  return {
    nome_empresa:     nome,
    cnpj:             '',
    setor:            r.categoryName || (r.categories && r.categories[0]) || setor,
    cidade_uf:        cidadeUf,
    endereco,
    resumo_negocio:   r.description || '',
    contatos:         [],
    telefone_empresa: telFinal,
    email_empresa:    email,
    instagram,
    linkedin,
    site:             r.website || r.domain || '',
    prioridade:       telFinal ? 'Média' : 'Baixa',
    fonte:            'google_maps',
    tamanho_empresa:  '',
  };
}

// ─── LinkedIn Empresas ────────────────────────────────────────────────────────

/**
 * Busca empresas no LinkedIn por setor e região
 * Campos reais retornados pelo actor harvestapi/linkedin-company-search:
 *  name, linkedinUrl, website, phone, locations[], industries[], description
 */
async function buscarEmpresasLinkedIn(regiao, setor) {
  if (!apifyHabilitado()) {
    console.log('[apify/linkedin] APIFY_API_TOKEN não configurado — pulando LinkedIn empresas');
    return [];
  }

  console.log(`[apify/linkedin] Buscando empresas: "${setor}" em "${regiao}"`);
  try {
    const resultados = await runActor('harvestapi~linkedin-company-search', {
      searchQuery: `${setor} ${regiao}`,
      scraperMode: 'full',
      maxItems: 8,
    }, 18);

    const empresas = resultados
      .filter(r => r.name)
      .map(r => {
        // locations é array de objetos {city, country, ...}
        const loc = r.locations && r.locations[0];
        const cidade = loc?.city || loc?.geographicArea || regiao;
        // industries é array de strings
        const setor_ = (r.industries && r.industries[0]) || r.industry || setor;

        return {
          nome_empresa:     r.name || '',
          cnpj:             '',
          setor:            setor_,
          cidade_uf:        cidade,
          endereco:         loc ? [loc.line1, loc.city, loc.geographicArea].filter(Boolean).join(', ') : '',
          resumo_negocio:   r.description || r.tagline || '',
          contatos:         [],
          telefone_empresa: r.phone || '',
          email_empresa:    '',
          instagram:        '',
          linkedin:         r.linkedinUrl || r.url || '',
          site:             r.website || '',
          prioridade:       'Baixa',
          tamanho_empresa:  r.employeeCount ? String(r.employeeCount) : '',
          fonte:            'linkedin',
        };
      });

    console.log(`[apify/linkedin] ${empresas.length} empresas encontradas`);
    return empresas;
  } catch (err) {
    console.error('[apify/linkedin] Erro empresas:', err.message);
    return [];
  }
}

// ─── LinkedIn Responsáveis ────────────────────────────────────────────────────

/**
 * Busca donos, diretores e gerentes das empresas via LinkedIn
 */
async function buscarResponsaveisLinkedIn(linkedinUrls, regiao) {
  if (!apifyHabilitado()) return new Map();
  if (!linkedinUrls || linkedinUrls.length === 0) return new Map();

  const urls = linkedinUrls.slice(0, 3); // máximo 3 no Vercel 60s
  console.log(`[apify/linkedin] Buscando responsáveis de ${urls.length} empresa(s)`);

  try {
    const resultados = await runActor('harvestapi~linkedin-company-employees', {
      companies: urls,
      seniorityLevelIds: ['220', '300', '310', '320'],
      locations: [regiao, 'Brazil'],
      profileScraperMode: 'Short ($4 per 1k)',
      maxItems: 15,
      companyBatchMode: 'one_by_one',
      maxItemsPerCompany: 5,
    }, 15);

    const mapa = new Map();
    for (const r of resultados) {
      const companyUrl = normalizarUrlLinkedIn(r.companyUrl || r.currentCompanyUrl || '');
      if (!companyUrl) continue;

      if (!mapa.has(companyUrl)) mapa.set(companyUrl, []);
      mapa.get(companyUrl).push({
        nome:            r.fullName || r.name || '',
        cargo:           r.headline || r.jobTitle || r.currentTitle || '',
        tipo:            inferirTipo(r.headline || r.jobTitle || ''),
        telefone:        r.phone || '',
        email:           r.email || '',
        linkedin_perfil: r.profileUrl || r.linkedinUrl || '',
      });
    }

    console.log(`[apify/linkedin] Responsáveis encontrados em ${mapa.size} empresa(s)`);
    return mapa;
  } catch (err) {
    console.error('[apify/linkedin] Erro responsáveis:', err.message);
    return new Map();
  }
}

// ─── Merge de fontes ──────────────────────────────────────────────────────────

/**
 * Mescla resultados de Google Maps, Google Search (IA) e LinkedIn numa lista única
 */
function mesclarEmpresas(fromMaps, fromGoogle, fromLinkedIn) {
  const mapa = new Map();

  const adicionar = (e) => {
    const key = normalizarNome(e.nome_empresa);
    if (!key) return;
    if (!mapa.has(key)) {
      mapa.set(key, { ...e, contatos: [...(e.contatos || [])] });
      return;
    }
    const base = mapa.get(key);
    base.cnpj             = base.cnpj             || e.cnpj             || '';
    base.endereco         = base.endereco         || e.endereco         || '';
    base.telefone_empresa = base.telefone_empresa || e.telefone_empresa || '';
    base.email_empresa    = base.email_empresa    || e.email_empresa    || '';
    base.instagram        = base.instagram        || e.instagram        || '';
    base.linkedin         = base.linkedin         || e.linkedin         || '';
    base.site             = base.site             || e.site             || '';
    base.resumo_negocio   = base.resumo_negocio   || e.resumo_negocio   || '';
    base.tamanho_empresa  = base.tamanho_empresa  || e.tamanho_empresa  || '';

    // Acumula fontes
    if (e.fonte && !base.fonte?.includes(e.fonte)) {
      base.fonte = base.fonte ? `${base.fonte},${e.fonte}` : e.fonte;
    }

    // Mescla contatos sem duplicar
    for (const c of (e.contatos || [])) {
      const jaExiste = base.contatos.some(
        bc => normalizarNome(bc.nome) === normalizarNome(c.nome)
      );
      if (!jaExiste) base.contatos.push(c);
    }
  };

  for (const e of fromMaps)     adicionar(e);
  for (const e of fromGoogle)   adicionar(e);
  for (const e of fromLinkedIn) adicionar(e);

  return Array.from(mapa.values());
}

/**
 * Injeta os responsáveis do LinkedIn nos respectivos registros de empresa
 */
function injetarResponsaveis(empresas, mapaResponsaveis) {
  if (!mapaResponsaveis || mapaResponsaveis.size === 0) return empresas;

  return empresas.map(e => {
    if (!e.linkedin) return e;
    const key = normalizarUrlLinkedIn(e.linkedin);
    const responsaveis = mapaResponsaveis.get(key) || [];
    if (responsaveis.length === 0) return e;

    const novosContatos = [...e.contatos];
    for (const r of responsaveis) {
      const jaExiste = novosContatos.some(
        c => normalizarNome(c.nome) === normalizarNome(r.nome)
      );
      if (!jaExiste) novosContatos.push(r);
    }

    const temResponsavelComTelefone = novosContatos.some(
      c => ['dono', 'socio', 'diretor'].includes(c.tipo) && c.telefone
    );
    const temResponsavel = novosContatos.some(
      c => ['dono', 'socio', 'diretor'].includes(c.tipo)
    );

    const prioridade = temResponsavelComTelefone ? 'Alta'
      : temResponsavel ? 'Média'
      : e.prioridade || 'Baixa';

    return { ...e, contatos: novosContatos, prioridade };
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizarNome(nome) {
  return (nome || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+(ltda|me|epp|eireli|s\/a|sa|ss|lda|inc|corp)\.?\s*$/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarUrlLinkedIn(url) {
  return (url || '')
    .split('?')[0]
    .replace(/\/(about|life|jobs)\/?$/, '')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim();
}

function inferirTipo(cargo) {
  const c = (cargo || '').toLowerCase();
  if (c.includes('owner') || c.includes('proprietário') || c.includes('dono')) return 'dono';
  if (c.includes('partner') || c.includes('sócio') || c.includes('socio')) return 'socio';
  if (c.includes('ceo') || c.includes('presidente') || c.includes('founder') || c.includes('fundador')) return 'dono';
  if (c.includes('cto') || c.includes('coo') || c.includes('cfo') || c.includes('diretor') || c.includes('director')) return 'diretor';
  if (c.includes('vp') || c.includes('vice')) return 'diretor';
  return 'gerente';
}

module.exports = {
  apifyHabilitado,
  buscarNoGoogleMaps,
  buscarEmpresasLinkedIn,
  buscarResponsaveisLinkedIn,
  mesclarEmpresas,
  injetarResponsaveis,
};
