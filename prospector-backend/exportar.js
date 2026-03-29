// exportar.js — Geração de planilha Excel com duas abas
const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

/**
 * Gera uma planilha Excel com duas abas:
 *  1. "Dados Completos"       — todas as empresas com todos os campos
 *  2. "Contatos Prioritários" — somente Alta/Média prioridade, com link WhatsApp
 *
 * @param {Array}  empresas - array mesclado de todas as fontes
 * @param {string} regiao
 * @param {string} setor
 * @returns {{ caminho: string, nomeArquivo: string }}
 */
function gerarExcel(empresas, regiao, setor) {
  const wb = XLSX.utils.book_new();

  // ── Aba 1: Dados Completos ────────────────────────────────────────────────
  const linhas1 = empresas.map(e => ({
    'Empresa':              e.nome_empresa         || '',
    'CNPJ':                 e.cnpj                 || '',
    'Setor':                e.setor                || setor,
    'Cidade/UF':            e.cidade_uf            || regiao,
    'Endereço':             e.endereco             || '',
    'Resumo':               e.resumo_negocio       || '',
    'Contato Principal':    e.contatos?.[0]?.nome          || '',
    'Cargo':                e.contatos?.[0]?.cargo         || '',
    'Tipo':                 e.contatos?.[0]?.tipo          || '',
    'Telefone Contato':     e.contatos?.[0]?.telefone      || '',
    'Email Contato':        e.contatos?.[0]?.email         || '',
    'LinkedIn Contato':     e.contatos?.[0]?.linkedin_perfil || '',
    'Telefone Empresa':     e.telefone_empresa     || '',
    'Email Empresa':        e.email_empresa        || '',
    'Instagram':            e.instagram            || '',
    'LinkedIn Empresa':     e.linkedin             || '',
    'Site':                 e.site                 || '',
    'Tamanho':              e.tamanho_empresa      || '',
    'Prioridade':           e.prioridade           || 'Baixa',
    'Fonte':                e.fonte                || '',
    'Data Prospecção':      new Date().toLocaleDateString('pt-BR'),
    'Status':               'Novo',
    'Observações':          '',
  }));

  const ws1 = XLSX.utils.json_to_sheet(linhas1);
  ws1['!cols'] = [
    { wch: 32 }, { wch: 20 }, { wch: 18 }, { wch: 16 }, { wch: 36 },
    { wch: 40 }, { wch: 26 }, { wch: 22 }, { wch: 14 }, { wch: 18 },
    { wch: 28 }, { wch: 34 }, { wch: 18 }, { wch: 28 }, { wch: 24 },
    { wch: 34 }, { wch: 30 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
    { wch: 16 }, { wch: 12 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ws1, 'Dados Completos');

  // ── Aba 2: Contatos Prioritários ──────────────────────────────────────────
  const prioritarios = empresas.filter(
    e => e.prioridade === 'Alta' || e.prioridade === 'Média'
  );

  const linhas2 = prioritarios.map(e => {
    const tel = e.contatos?.[0]?.telefone || e.telefone_empresa || '';
    const telLimpo = tel.replace(/\D/g, '');

    return {
      'Empresa':           e.nome_empresa                    || '',
      'Endereço':          e.endereco                        || '',
      'Contato':           e.contatos?.[0]?.nome             || '',
      'Cargo':             e.contatos?.[0]?.cargo            || '',
      'Tipo':              e.contatos?.[0]?.tipo             || '',
      'Telefone':          tel,
      'WhatsApp':          telLimpo ? `https://wa.me/55${telLimpo}` : '',
      'Email':             e.contatos?.[0]?.email            || '',
      'LinkedIn Contato':  e.contatos?.[0]?.linkedin_perfil  || '',
      'LinkedIn Empresa':  e.linkedin                        || '',
      'Instagram':         e.instagram                       || '',
      'Prioridade':        e.prioridade                      || '',
      'Status':            'Novo',
      'Observações':       '',
    };
  });

  const ws2 = XLSX.utils.json_to_sheet(linhas2);
  ws2['!cols'] = [
    { wch: 32 }, { wch: 36 }, { wch: 26 }, { wch: 22 }, { wch: 14 },
    { wch: 18 }, { wch: 36 }, { wch: 28 }, { wch: 34 }, { wch: 34 },
    { wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ws2, 'Contatos Prioritários');

  // ── Salvar ────────────────────────────────────────────────────────────────
  const exportDir = path.join(__dirname, 'exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  const timestamp   = new Date().toISOString().slice(0, 10);
  // Sanitiza: remove acentos, caracteres inválidos em nomes de arquivo
  const regiaoSanitizada = regiao
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos (á→a, ã→a)
    .replace(/[\s\/\\:*?"<>|]/g, '_')                 // remove caracteres inválidos
    .replace(/_+/g, '_')                              // remove underscores duplos
    .replace(/^_|_$/g, '');                           // remove underscore no início/fim
  const nomeArquivo = `prospector_${regiaoSanitizada}_${timestamp}.xlsx`;
  const caminho     = path.join(exportDir, nomeArquivo);

  XLSX.writeFile(wb, caminho);
  console.log(`[excel] Planilha salva: ${nomeArquivo} (${linhas1.length} empresas, ${linhas2.length} prioritários)`);

  return { caminho, nomeArquivo };
}

module.exports = { gerarExcel };
