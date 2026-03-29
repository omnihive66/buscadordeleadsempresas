// busca.js — Integração com SerpAPI e ReceitaWS
const axios = require('axios');

/**
 * Busca empresas no Google via SerpAPI usando múltiplas queries estratégicas
 * BUG #14 fix: queries rodando em PARALELO (era sequencial, ~40s → ~10s)
 * @param {string} regiao - Ex: "Anápolis GO"
 * @param {string} setor  - Ex: "construtoras"
 * @returns {Array} resultados brutos do Google
 */
async function buscarNoGoogle(regiao, setor) {
  const queries = [
    `${setor} ${regiao} telefone contato`,
    `site:linkedin.com "${setor}" "${regiao}" diretor OR sócio OR fundador`,
    `site:instagram.com "${setor}" "${regiao}"`,
    `"${setor}" "${regiao}" CNPJ OR email OR whatsapp`,
  ];

  // Executa todas as queries em paralelo
  const resultadosPorQuery = await Promise.all(
    queries.map(query => buscarQuery(query))
  );

  // Deduplica por URL
  const vistas = new Set();
  const resultados = [];

  for (const lista of resultadosPorQuery) {
    for (const r of lista) {
      if (!vistas.has(r.link)) {
        vistas.add(r.link);
        resultados.push(r);
      }
    }
  }

  console.log(`[busca] ${resultados.length} resultados únicos encontrados`);
  return resultados;
}

/**
 * Executa uma única query no SerpAPI
 */
async function buscarQuery(query) {
  try {
    const { data } = await axios.get('https://serpapi.com/search', {
      params: {
        q: query,
        // location removido: formato informal (ex: "Anápolis GO") causa 400
        // a região já está embutida na query string
        hl: 'pt',
        gl: 'br',
        num: 10,
        api_key: process.env.SERP_API_KEY,
      },
      timeout: 10000,
    });
    return data.organic_results || [];
  } catch (err) {
    console.error(`[busca] Erro na query "${query}":`, err.message);
    return [];
  }
}

/**
 * Busca dados de empresa pelo CNPJ na ReceitaWS (gratuito)
 * @param {string} cnpj
 * @returns {Object|null}
 */
async function buscarCNPJ(cnpj) {
  try {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    if (cnpjLimpo.length !== 14) return null;

    const { data } = await axios.get(
      `https://receitaws.com.br/v1/cnpj/${cnpjLimpo}`,
      { timeout: 8000 }
    );

    if (data.status === 'ERROR') return null;

    return {
      nome:       data.nome,
      fantasia:   data.fantasia,
      telefone:   data.telefone,
      email:      data.email,
      logradouro: data.logradouro,
      municipio:  data.municipio,
      uf:         data.uf,
      socios: (data.qsa || []).map(s => ({
        nome:  s.nome  || '',
        // BUG #6 fix: s.qual pode ser undefined — garantir string
        cargo: s.qual  || '',
      })),
    };
  } catch {
    return null;
  }
}

module.exports = { buscarNoGoogle, buscarCNPJ };
