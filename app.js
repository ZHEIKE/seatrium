/* =========================================================================
   Apontamento de Campo - NPO
   App state, navegação entre telas, busca incremental, fila offline e sync.
   ========================================================================= */

const DB_NAME = 'apontamentoNPO';
const DB_VERSION = 1;
let db = null;
let TAGS = [];              // dataset completo carregado de tags_data.json
let TAGS_BY_LOCAL = {};     // cache "BLOCO||SUBBLOCO" -> array ordenado por score

/* ---------------------------------------------------------------------
   Status disponíveis variam por Atividade, e cada um tem uma cor semântica.
   STATUS_CONCLUIDO define quais valores contam como "item pronto/instalado"
   para fins de detecção de TAG já reportada (local e via planilha).
   --------------------------------------------------------------------- */
const STATUS_POR_ATIVIDADE = {
  'Montagem de Equipamentos': ['Instalado', 'Retrabalho'],
  'Montagem de Suporte': ['Visual', 'Montado', 'Retrabalho'],
  'Montagem de Moldura MCT': ['Visual', 'Montado', 'Retrabalho'],
  'Montagem de Penetração/Colar': ['Visual', 'Montado', 'Retrabalho'],
  'Montagem de Bandejamento': ['Parcial', 'Total'],
};
const STATUS_COR = {
  'Instalado': 'success',
  'Montado': 'success',
  'Total': 'success',
  'Visual': 'warning',
  'Parcial': 'warning',
  'Retrabalho': 'danger',
};
const STATUS_CONCLUIDO = new Set(['Instalado', 'Montado', 'Total']);

function statusOpcoesPara(atividade) {
  return STATUS_POR_ATIVIDADE[atividade] || ['Instalado', 'Em andamento', 'Problema'];
}

/* ---------------------------------------------------------------------
   IndexedDB — só para a fila de apontamentos (dado que precisa persistir
   e ser reenviado). Nomes/URL de sync ficam em localStorage (mais simples).
   --------------------------------------------------------------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('apontamentos')) {
        const store = _db.createObjectStore('apontamentos', { keyPath: 'id', autoIncrement: true });
        store.createIndex('synced', 'synced', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbAdd(storeName, obj) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------------------
   Navegação entre telas
   --------------------------------------------------------------------- */
const Screens = {
  history: ['operador'],
  go(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    this.history.push(name);
    Screens.renderCrumbs(name);
    window.scrollTo(0, 0);
    if (name === 'sync') Sync.renderQueue();
    if (name === 'confirmacao') App.renderResumoConfirmacao();
    if (name === 'config') App.renderConfig();
  },
  voltar() {
    if (this.history.length < 2) { this.go('operador'); return; }
    this.history.pop(); // remove tela atual
    const anterior = this.history.pop(); // pega a tela anterior (será empilhada de novo pelo go())
    this.go(anterior || 'operador');
  },
  renderCrumbs(name) {
    const el = document.getElementById('crumbs');
    const chips = [];
    if (App.state.operador) chips.push(App.state.operador);
    if (['bloco', 'subbloco', 'busca', 'confirmarTag', 'apontamento', 'apontamentoLote'].includes(name)) {
      if (App.state.atividade) chips.push(App.state.atividade);
      if (App.state.bloco) chips.push(App.state.bloco);
      if (App.state.subBloco) chips.push(App.state.subBloco);
    }
    if (!chips.length) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = chips.map((c) => `<span class="crumb-chip">${c}</span>`).join('');
  }
};

/* ---------------------------------------------------------------------
   App — estado corrente do fluxo de apontamento
   --------------------------------------------------------------------- */
const App = {
  state: {
    operador: null,
    atividade: null,
    bloco: null,
    subBloco: null,
    tagSelecionada: null,
    padraoDigitado: '',
    status: null,
    fotoBase64: null,
    ultimoLote: [],
    sessao: [],
  },

  async init() {
    db = await openDB();
    await this.carregarTagsData();
    this.renderOperadores();
    this.atualizarStatusConexao();
    window.addEventListener('online', () => { this.atualizarStatusConexao(); Sync.sincronizarAgora(); });
    window.addEventListener('offline', () => this.atualizarStatusConexao());
    await Sync.atualizarBadge();
    if (navigator.onLine) { Sync.sincronizarAgora(); Sync.atualizarTagsReportadasRemoto(); }
  },

  async carregarTagsData() {
    const info = document.getElementById('infoBaseTags');
    this.erroCarregarBase = false;
    try {
      const res = await fetch('tags_data.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      TAGS = await res.json();
      if (info) info.textContent = TAGS.length.toLocaleString('pt-BR') + ' TAGs carregadas (base de referência local).';
    } catch (err) {
      TAGS = [];
      this.erroCarregarBase = true;
      if (info) info.textContent = 'Não foi possível carregar a base de referência.';
      console.warn('Falha ao carregar tags_data.json:', err);
    }
  },

  atualizarStatusConexao() {
    const pill = document.getElementById('connStatus');
    if (navigator.onLine) {
      pill.textContent = 'Online';
      pill.className = 'status-pill online';
    } else {
      pill.textContent = 'Offline';
      pill.className = 'status-pill offline';
    }
  },

  /* ---------- Operadores (equipe) ---------- */
  getOperadores() {
    return JSON.parse(localStorage.getItem('operadores') || '[]');
  },
  setOperadores(list) {
    localStorage.setItem('operadores', JSON.stringify(list));
  },
  renderOperadores() {
    const list = this.getOperadores();
    const el = document.getElementById('listaOperadores');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">Nenhum nome cadastrado ainda. Use "+ Cadastrar meu nome" abaixo.</div>';
      return;
    }
    el.innerHTML = list.map((nome) =>
      '<button class="btn btn-secondary" onclick="App.selecionarOperador(\'' + nome.replace(/'/g, "\\'") + '\')">' + nome + '</button>'
    ).join('');
  },
  selecionarOperador(nome) {
    this.state.operador = nome;
    this.state.sessao = [];
    const elOp = document.getElementById('topbarOperador');
    elOp.textContent = 'Operador: ' + nome;
    elOp.style.display = 'block';
    this.renderAtividades();
    Screens.go('atividade');
  },
  salvarOperador() {
    const input = document.getElementById('novoOperadorNome');
    const nome = input.value.trim();
    if (!nome) { alert('Digite um nome.'); return; }
    const list = this.getOperadores();
    if (!list.includes(nome)) list.push(nome);
    this.setOperadores(list);
    input.value = '';
    this.renderOperadores();
    this.selecionarOperador(nome);
  },

  /* ---------- Atividade ---------- */
  renderAtividades() {
    const el = document.getElementById('listaAtividades');
    if (this.erroCarregarBase || !TAGS.length) {
      el.innerHTML = '<div class="empty-state">⚠️ A base de TAGs não carregou. Publique no Netlify/GitHub Pages ou rode um servidor local, então recarregue a página.</div>';
      return;
    }
    const contagem = {};
    TAGS.forEach((t) => { contagem[t.a] = (contagem[t.a] || 0) + 1; });
    // ordem fixa combinada com o usuário, não alfabética
    const ORDEM = ['Montagem de Suporte', 'Montagem de Equipamentos', 'Montagem de Bandejamento', 'Montagem de Moldura MCT', 'Montagem de Penetração/Colar'];
    const atividades = ORDEM.filter((a) => contagem[a]).concat(Object.keys(contagem).filter((a) => !ORDEM.includes(a)));
    el.innerHTML = atividades.map((a) =>
      '<div class="tile" onclick="App.selecionarAtividade(\'' + a.replace(/'/g, "\\'") + '\')">' +
      '<div><div>' + a + '</div><div class="tile-meta">' + contagem[a] + ' itens na base</div></div>' +
      '<div class="tile-arrow">›</div></div>'
    ).join('');
  },
  selecionarAtividade(a) {
    this.state.atividade = a;
    this.renderBlocos();
    Screens.go('bloco');
  },

  /* ---------- Bloco / Sub-bloco ---------- */
  renderBlocos() {
    const el = document.getElementById('listaBlocos');
    if (this.erroCarregarBase || !TAGS.length) {
      el.innerHTML = '<div class="empty-state">⚠️ A base de TAGs não carregou. Publique no Netlify/GitHub Pages ou rode um servidor local, então recarregue a página.</div>';
      return;
    }
    const doAtividade = TAGS.filter((t) => t.a === this.state.atividade);
    const blocos = [...new Set(doAtividade.map((t) => t.b).filter(Boolean))].sort();
    el.innerHTML = blocos.map((b) => {
      const count = doAtividade.filter((t) => t.b === b).length;
      return '<div class="tile" onclick="App.selecionarBloco(\'' + b + '\')">' +
        '<div><div>' + b + '</div><div class="tile-meta">' + count + ' itens nesta atividade</div></div>' +
        '<div class="tile-arrow">›</div></div>';
    }).join('');
  },
  selecionarBloco(b) {
    this.state.bloco = b;
    this.renderSubBlocos();
    document.getElementById('subblocoDesc').textContent = 'Sub-blocos dentro de ' + b + '.';
    Screens.go('subbloco');
  },
  renderSubBlocos() {
    const doLocal = TAGS.filter((t) => t.a === this.state.atividade && t.b === this.state.bloco);
    const subs = [...new Set(doLocal.map((t) => t.s).filter(Boolean))].sort();
    const el = document.getElementById('listaSubBlocos');
    el.innerHTML = subs.map((s) => {
      const count = doLocal.filter((t) => t.s === s).length;
      return '<div class="tile" onclick="App.selecionarSubBloco(\'' + s + '\')">' +
        '<div><div>' + s + '</div><div class="tile-meta">' + count + ' itens</div></div>' +
        '<div class="tile-arrow">›</div></div>';
    }).join('') || '<div class="empty-state">Nenhum sub-bloco encontrado.</div>';
  },
  selecionarSubBloco(s) {
    this.state.subBloco = s;
    Busca.prepararLocal();
    Screens.go('busca');
  },

  /* ---------- Seleção de TAG / apontamento ---------- */
  selecionarTag(tag) {
    this.state.tagJaReportada = Busca.tagsReportadas.has(tag.t);
    if (this.state.tagJaReportada) {
      const confirmar = confirm('A TAG ' + tag.t + ' já foi reportada como concluída. Deseja mesmo continuar? (use apenas para corrigir um registro anterior)');
      if (!confirmar) return;
    }
    this.state.tagSelecionada = tag;
    this.renderDetalheTag('detalheTagCard');
    Screens.go('confirmarTag');
  },

  abrirApontamento() {
    this.renderStatusChoices();
    Screens.go('apontamento');
  },

  renderStatusChoices() {
    const opcoes = statusOpcoesPara(this.state.atividade);
    const el = document.getElementById('statusChoices');
    el.style.gridTemplateColumns = 'repeat(' + opcoes.length + ', 1fr)';
    el.innerHTML = opcoes.map((s) =>
      '<div class="choice-btn" data-status="' + s + '" data-cor="' + (STATUS_COR[s] || 'success') + '" onclick="App.setStatus(\'' + s + '\')">' + s + '</div>'
    ).join('');
  },
  renderDetalheTag(elId) {
    const t = this.state.tagSelecionada;
    const el = document.getElementById(elId);
    if (!t) { el.innerHTML = ''; return; }
    el.innerHTML =
      '<div class="detail-tag">' + t.t + '</div>' +
      '<div class="detail-grid">' +
      '<div><div class="label">Descrição</div><div class="value">' + (t.d || '—') + '</div></div>' +
      '<div><div class="label">Tipo</div><div class="value">' + (t.tc || '—') + '</div></div>' +
      '<div><div class="label">Comprimento</div><div class="value">' + (t.c || '—') + '</div></div>' +
      '<div><div class="label">Espessura</div><div class="value">' + (t.e || '—') + '</div></div>' +
      '<div><div class="label">Diâmetro</div><div class="value">' + (t.dm || '—') + '</div></div>' +
      '<div><div class="label">Largura</div><div class="value">' + (t.l || '—') + '</div></div>' +
      '<div><div class="label">Desenho</div><div class="value">' + (t.dw || '—') + '</div></div>' +
      '<div><div class="label">Quantidade</div><div class="value">' + (t.q || '—') + ' ' + (t.u || '') + '</div></div>' +
      '<div><div class="label">Status na engenharia</div><div class="value">' + (t.st || '—') + '</div></div>' +
      '</div>';
  },

  setStatus(status) {
    this.state.status = status;
    document.querySelectorAll('#statusChoices .choice-btn').forEach((b) => b.classList.remove('selected'));
    document.querySelector('#statusChoices .choice-btn[data-status="' + status + '"]').classList.add('selected');
    this.validarFormApontamento();
  },

  handleFoto(event) {
    const file = event.target.files[0];
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        const maxW = 1000;
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.6);
        App.state.fotoBase64 = base64;
        document.getElementById('photoArea').innerHTML =
          '<img class="photo-preview" src="' + base64 + '">' +
          '<button class="link-btn" onclick="document.getElementById(\'inputFoto\').click()">Trocar foto</button>';
        App.validarFormApontamento();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  validarFormApontamento() {
    const ok = !!this.state.status;
    document.getElementById('btnSalvarApontamento').disabled = !ok;
  },

  async salvarApontamento() {
    const t = this.state.tagSelecionada;
    const registro = {
      tag: t.t,
      atividade: this.state.atividade,
      bloco: this.state.bloco,
      subBloco: this.state.subBloco,
      statusNovo: this.state.status,
      observacao: document.getElementById('inputObservacao').value.trim(),
      responsavelExecucao: this.state.operador,
      nivelConfianca: document.getElementById('selectConfianca').value,
      padraoDigitado: this.state.padraoDigitado || '',
      fotoBase64: this.state.fotoBase64,
      dataApontamento: new Date().toISOString(),
      synced: 0,
      jaReportadaAntes: !!this.state.tagJaReportada,
    };
    await dbAdd('apontamentos', registro);
    this.state.ultimoLote = [registro];
    this.state.sessao.push(registro);
    // reset campos do formulário (mantém local/operador)
    this.state.tagSelecionada = null;
    this.state.status = null;
    this.state.fotoBase64 = null;
    this.state.tagJaReportada = false;
    document.getElementById('inputObservacao').value = '';
    document.getElementById('photoArea').innerHTML =
      '<div class="photo-box" onclick="document.getElementById(\'inputFoto\').click()">📷 Toque para tirar ou anexar foto</div>';
    document.querySelectorAll('#screen-apontamento .choice-btn').forEach((b) => b.classList.remove('selected'));
    await Sync.atualizarBadge();
    document.getElementById('confirmacaoDesc').textContent = '1 apontamento salvo neste aparelho. Será enviado automaticamente quando houver internet.';
    Screens.go('confirmacao');
    if (navigator.onLine) Sync.sincronizarAgora();
  },

  novoApontamentoMesmoLocal() {
    Busca.prepararLocal();
    Screens.go('busca');
  },

  renderResumoConfirmacao() {
    const el = document.getElementById('listaResumoConfirmacao');
    if (!el) return;
    const lista = this.state.sessao;
    if (!lista.length) { el.innerHTML = '<div class="empty-state">Nenhum item nesta sessão.</div>'; return; }
    el.innerHTML = lista.slice().reverse().map((a) => Sync.itemCardHTML(a, { permitirExcluir: false })).join('');
  },

  async concluirECompartilhar() {
    if (!this.state.sessao.length) { alert('Nenhum apontamento nesta sessão pra compartilhar.'); return; }
    if (navigator.onLine) { await Sync.sincronizarAgora(); }
    this._compartilharLista(this.state.sessao, 'Resumo de atividade');
    this.state.sessao = [];
    Screens.go('atividade');
  },

  adicionarNovoApontamento() {
    // Retoma de onde deu pra continuar: se já tem atividade+bloco+sub-bloco
    // selecionados, vai direto pra busca; senão, volta pro passo que falta.
    if (!this.state.operador) { Screens.go('operador'); return; }
    if (!this.state.atividade) { this.renderAtividades(); Screens.go('atividade'); return; }
    if (!this.state.bloco) { this.renderBlocos(); Screens.go('bloco'); return; }
    if (!this.state.subBloco) { this.renderSubBlocos(); Screens.go('subbloco'); return; }
    Busca.prepararLocal();
    Screens.go('busca');
  },

  /* ---------- Apontamento em lote (várias TAGs de uma vez) ---------- */
  loteTags: [],
  loteStatus: null,
  loteFotoBase64: null,

  iniciarLote(lista) {
    this.loteTags = lista;
    this.loteStatus = null;
    this.loteFotoBase64 = null;
    document.getElementById('inputObservacaoLote').value = '';
    document.getElementById('photoAreaLote').innerHTML =
      '<div class="photo-box" onclick="document.getElementById(\'inputFotoLote\').click()">📷 Toque para tirar ou anexar uma foto do conjunto</div>';
    this.renderStatusChoicesLote();
    document.getElementById('btnSalvarLote').disabled = true;
    const card = document.getElementById('resumoLoteCard');
    card.innerHTML = '<div class="detail-tag">' + lista.length + ' TAG(s) selecionada(s)</div>' +
      lista.map((t) => '<div style="font-family:var(--mono); font-size:13px; padding:4px 0; border-bottom:1px solid var(--line)">' + t.t + ' <span style="color:var(--mut); font-family:var(--sans)">— ' + (t.d || '') + '</span></div>').join('');
    Screens.go('apontamentoLote');
  },

  renderStatusChoicesLote() {
    const opcoes = statusOpcoesPara(this.state.atividade);
    const el = document.getElementById('statusChoicesLote');
    el.style.gridTemplateColumns = 'repeat(' + opcoes.length + ', 1fr)';
    el.innerHTML = opcoes.map((s) =>
      '<div class="choice-btn" data-status-lote="' + s + '" data-cor="' + (STATUS_COR[s] || 'success') + '" onclick="App.setStatusLote(\'' + s + '\')">' + s + '</div>'
    ).join('');
  },

  setStatusLote(status) {
    this.loteStatus = status;
    document.querySelectorAll('#screen-apontamentoLote .choice-btn').forEach((b) => b.classList.remove('selected'));
    document.querySelector('#screen-apontamentoLote .choice-btn[data-status-lote="' + status + '"]').classList.add('selected');
    document.getElementById('btnSalvarLote').disabled = !this.loteStatus;
  },

  handleFotoLote(event) {
    const file = event.target.files[0];
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        const maxW = 1000;
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        App.loteFotoBase64 = canvas.toDataURL('image/jpeg', 0.6);
        document.getElementById('photoAreaLote').innerHTML =
          '<img class="photo-preview" src="' + App.loteFotoBase64 + '">' +
          '<button class="link-btn" onclick="document.getElementById(\'inputFotoLote\').click()">Trocar foto</button>';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  async salvarApontamentoLote() {
    if (!this.loteStatus || !this.loteTags.length) return;
    const observacao = document.getElementById('inputObservacaoLote').value.trim();
    const agora = new Date().toISOString();
    const registros = [];
    for (const t of this.loteTags) {
      const registro = {
        tag: t.t,
        atividade: this.state.atividade,
        bloco: this.state.bloco,
        subBloco: this.state.subBloco,
        statusNovo: this.loteStatus,
        observacao,
        responsavelExecucao: this.state.operador,
        nivelConfianca: 'Lote — ver observação',
        padraoDigitado: '',
        fotoBase64: this.loteFotoBase64,
        dataApontamento: agora,
        synced: 0,
        jaReportadaAntes: Busca.tagsReportadas.has(t.t),
      };
      await dbAdd('apontamentos', registro);
      registros.push(registro);
      this.state.sessao.push(registro);
    }
    this.state.ultimoLote = registros;
    await Sync.atualizarBadge();
    document.getElementById('confirmacaoDesc').textContent = registros.length + ' apontamento(s) salvos neste aparelho. Serão enviados automaticamente quando houver internet.';
    Screens.go('confirmacao');
    if (navigator.onLine) Sync.sincronizarAgora();
  },

  /* ---------- Compartilhar via WhatsApp ---------- */
  async compartilharFilaWhatsApp() {
    const all = await dbGetAll('apontamentos');
    const pendentes = all.filter((a) => !a.synced);
    if (!pendentes.length) { alert('Nenhum apontamento pendente para compartilhar.'); return; }
    this._compartilharLista(pendentes, 'Fila de apontamentos pendentes');
  },

  _compartilharLista(lista, titulo) {
    const linhas = [
      '*Resumo de atividade — Elétrica e Automação - Seatrium NPO*',
      'Responsável: ' + (lista[0].responsavelExecucao || '—'),
      'Atividade: ' + (lista[0].atividade || '—'),
      'Local: ' + (lista[0].bloco || '—') + ' / ' + (lista[0].subBloco || '—'),
    ];
    lista.forEach((a) => {
      const aviso = a.jaReportadaAntes ? ' ⚠(já reportada antes)' : '';
      linhas.push('• ' + a.tag + ' — ' + a.statusNovo + (a.observacao ? ' (' + a.observacao + ')' : '') + aviso);
    });
    linhas.push('Total: ' + lista.length + ' item(ns)');
    const texto = linhas.join('\n');
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
  },

  /* ---------- Config / equipe ---------- */
  renderConfig() {
    const list = this.getOperadores();
    const el = document.getElementById('listaEquipe');
    el.innerHTML = list.map((nome, i) =>
      '<div class="person-row"><span>' + nome + '</span><button class="link-btn" onclick="App.removerNomeConfig(' + i + ')">remover</button></div>'
    ).join('') || '<div class="empty-state">Nenhum nome cadastrado.</div>';
    document.getElementById('inputSyncUrl').value = localStorage.getItem('syncUrl') || '';
  },
  adicionarNomeConfig() {
    const input = document.getElementById('novoNomeConfig');
    const nome = input.value.trim();
    if (!nome) return;
    const list = this.getOperadores();
    if (!list.includes(nome)) list.push(nome);
    this.setOperadores(list);
    input.value = '';
    this.renderConfig();
    this.renderOperadores();
  },
  removerNomeConfig(i) {
    const list = this.getOperadores();
    list.splice(i, 1);
    this.setOperadores(list);
    this.renderConfig();
    this.renderOperadores();
  },
  salvarSyncUrl() {
    const url = document.getElementById('inputSyncUrl').value.trim();
    localStorage.setItem('syncUrl', url);
    alert('URL salva.');
  }
};

/* ---------------------------------------------------------------------
   Busca — filtro incremental + ranking por probabilidade dentro do local
   --------------------------------------------------------------------- */
const Busca = {
  candidatosLocal: [],
  modoMultiplo: false,
  selecionados: {}, // tag -> registro

  prepararLocal() {
    const key = App.state.atividade + '||' + App.state.bloco + '||' + App.state.subBloco;
    if (!TAGS_BY_LOCAL[key]) {
      const itens = TAGS.filter((t) => t.a === App.state.atividade && t.b === App.state.bloco && t.s === App.state.subBloco);
      // score simples: frequência da descrição/tipo de item dentro do próprio local
      // (TIPOCOMPONENTE vem vazio na base atual, então usamos DESCRICAO)
      const freq = {};
      itens.forEach((t) => { freq[t.d] = (freq[t.d] || 0) + 1; });
      itens.forEach((t) => { t._score = freq[t.d] || 0; });
      itens.sort((a, b) => b._score - a._score || a.t.localeCompare(b.t));
      TAGS_BY_LOCAL[key] = itens;
    }
    this.candidatosLocal = TAGS_BY_LOCAL[key];
    this.modoMultiplo = false;
    this.selecionados = {};
    document.getElementById('inputBusca').value = '';
    document.getElementById('barraSelecaoMultipla').style.display = 'none';
    document.getElementById('btnToggleMulti').textContent = 'Selecionar várias';
    App.state.padraoDigitado = '';
    this.atualizarTagsReportadas().then(() => this.renderCandidatos(this.candidatosLocal));
  },

  tagsReportadas: new Set(),

  async atualizarTagsReportadas() {
    const set = new Set();
    // 1) TAGs que este próprio aparelho já marcou como Instalado (inclui pendentes de sync)
    try {
      const locais = await dbGetAll('apontamentos');
      locais.forEach((a) => { if (STATUS_CONCLUIDO.has(a.statusNovo)) set.add(a.tag); });
    } catch (e) { /* IndexedDB pode ainda não estar pronto */ }
    // 2) TAGs que a planilha (equipe toda) já tem como Instalado, última vez que conseguiu buscar
    try {
      const remoto = JSON.parse(localStorage.getItem('tagsReportadasRemoto') || '[]');
      remoto.forEach((t) => set.add(t));
    } catch (e) { /* ignora */ }
    this.tagsReportadas = set;
  },

  alternarModoMultiplo() {
    this.modoMultiplo = !this.modoMultiplo;
    this.selecionados = {};
    document.getElementById('btnToggleMulti').textContent = this.modoMultiplo ? 'Cancelar seleção' : 'Selecionar várias';
    document.getElementById('barraSelecaoMultipla').style.display = this.modoMultiplo ? 'block' : 'none';
    this.renderCandidatos(window.__candidatos || this.candidatosLocal);
  },

  toggleSelecao(tag) {
    if (this.selecionados[tag.t]) delete this.selecionados[tag.t];
    else this.selecionados[tag.t] = tag;
    const n = Object.keys(this.selecionados).length;
    document.getElementById('btnContinuarLote').textContent = 'Continuar com ' + n + ' selecionada' + (n === 1 ? '' : 's');
    this.renderCandidatos(window.__candidatos || this.candidatosLocal);
  },

  irParaLote() {
    const lista = Object.values(this.selecionados);
    if (!lista.length) { alert('Selecione ao menos uma TAG.'); return; }
    App.iniciarLote(lista);
  },

  filtrar(query) {
    App.state.padraoDigitado = query;
    if (!query) { this.renderCandidatos(this.candidatosLocal); return; }
    let resultado;
    if (query.includes('?')) {
      const escaped = query.replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/\\\?/g, '.');
      const re = new RegExp(escaped, 'i');
      resultado = this.candidatosLocal.filter((t) => re.test(t.t));
    } else {
      const q = query.toUpperCase();
      resultado = this.candidatosLocal.filter((t) => t.t.toUpperCase().includes(q));
    }
    this.renderCandidatos(resultado);
  },

  renderCandidatos(list) {
    document.getElementById('candidateCount').textContent =
      list.length + ' de ' + this.candidatosLocal.length + ' pendente(s)';
    const el = document.getElementById('listaCandidatos');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">Nenhum item corresponde. Tente digitar menos caracteres, ou use "?" no lugar do que não conseguir ler.</div>';
      return;
    }
    window.__candidatos = list.slice(0, 40);
    const multi = this.modoMultiplo;
    el.innerHTML = window.__candidatos.map((t, i) => {
      const selecionado = multi && this.selecionados[t.t];
      const reportada = this.tagsReportadas.has(t.t);
      const acao = multi ? "Busca.toggleSelecao(window.__candidatos[" + i + "])" : "App.selecionarTag(window.__candidatos[" + i + "])";
      const checkbox = multi ? '<span style="float:right; font-size:16px">' + (selecionado ? '☑' : '☐') + '</span>' : '';
      let corBorda = 'var(--accent)';
      let corFundo = '';
      if (selecionado) { corBorda = 'var(--success)'; corFundo = 'background:var(--success-bg);'; }
      else if (reportada) { corBorda = 'var(--danger)'; corFundo = 'background:var(--danger-bg);'; }
      return '<div class="candidate-card" style="border-left-color:' + corBorda + ';' + corFundo + '" onclick="' + acao + '">' +
        checkbox +
        (reportada ? '<div style="font-size:11px; font-weight:800; color:var(--danger); letter-spacing:0.03em; margin-bottom:3px">⚠ TAG JÁ REPORTADA COMO CONCLUÍDA</div>' : '') +
        '<div class="candidate-tag">' + t.t + '</div>' +
        '<div class="candidate-details">' +
        '<span><b>' + (t.d || '—') + '</b></span>' +
        '<span>' + (t.tc || '') + '</span>' +
        '<span>Desenho: ' + (t.dw || '—') + '</span>' +
        '<span>Qtd: ' + (t.q || '—') + ' ' + (t.u || '') + '</span>' +
        '</div></div>';
    }).join('');
  }
};

/* ---------------------------------------------------------------------
   Sync — fila local de apontamentos -> Google Apps Script (Web App)
   --------------------------------------------------------------------- */
const Sync = {
  itemCardHTML(a, opts) {
    opts = opts || {};
    const permitirExcluir = opts.permitirExcluir !== false;
    return '<div class="candidate-card" style="border-left-color:' + (a.synced ? 'var(--success)' : (a.erroSync ? 'var(--danger)' : 'var(--accent)')) + '">' +
      '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px">' +
      '<div class="candidate-tag">' + a.tag + ' <span style="font-size:11px; font-weight:700; color:' + (a.synced ? 'var(--success)' : (a.erroSync ? 'var(--danger)' : 'var(--warning)')) + '">' + (a.synced ? '✓ sincronizado' : (a.erroSync ? '✗ erro' : '⏳ pendente')) + '</span></div>' +
      (permitirExcluir && a.id ? '<button class="link-btn" style="color:var(--danger); white-space:nowrap" onclick="Sync.excluirItem(' + a.id + ')">excluir</button>' : '') +
      '</div>' +
      (a.jaReportadaAntes ? '<div style="font-size:11px; font-weight:800; color:var(--danger); margin-top:2px">⚠ já reportada antes</div>' : '') +
      (a.erroSync ? '<div style="font-size:12px; color:var(--danger); margin-top:4px">' + a.erroSync + '</div>' : '') +
      '<div class="candidate-details">' +
      '<span><b>' + a.statusNovo + '</b></span>' +
      '<span>' + a.bloco + ' / ' + a.subBloco + '</span>' +
      '<span>' + a.responsavelExecucao + '</span>' +
      '<span>' + new Date(a.dataApontamento).toLocaleString('pt-BR') + '</span>' +
      '</div></div>';
  },

  async atualizarTagsReportadasRemoto() {
    const url = localStorage.getItem('syncUrl');
    if (!url || !navigator.onLine) return;
    try {
      const resp = await fetch(url + '?action=reportadas');
      const corpo = await resp.json();
      if (corpo && corpo.status === 'ok' && Array.isArray(corpo.tags)) {
        localStorage.setItem('tagsReportadasRemoto', JSON.stringify(corpo.tags));
        localStorage.setItem('tagsReportadasAtualizadoEm', new Date().toISOString());
      }
    } catch (err) {
      console.warn('Falha ao buscar TAGs já reportadas:', err);
    }
  },

  async atualizarBadge() {
    const all = await dbGetAll('apontamentos');
    const pendentes = all.filter((a) => !a.synced);
    const badge = document.getElementById('pendingBadge');
    if (pendentes.length) {
      badge.style.display = 'inline-flex';
      document.getElementById('pendingCount').innerHTML = '<b>' + pendentes.length + '</b> apontamento(s) aguardando sincronizar';
    } else {
      badge.style.display = 'none';
    }
  },

  async renderQueue() {
    const all = await dbGetAll('apontamentos');
    const el = document.getElementById('listaSync');
    if (!all.length) { el.innerHTML = '<div class="empty-state">Nenhum apontamento registrado ainda.</div>'; return; }
    el.innerHTML = all.slice().reverse().map((a) => this.itemCardHTML(a)).join('');
  },

  async excluirItem(id) {
    if (!confirm('Excluir este apontamento? Essa ação não pode ser desfeita.')) return;
    await dbDelete('apontamentos', id);
    await this.atualizarBadge();
    this.renderQueue();
  },

  async sincronizarAgora() {
    const url = localStorage.getItem('syncUrl');
    if (!url) return;
    if (!navigator.onLine) return;
    const all = await dbGetAll('apontamentos');
    const pendentes = all.filter((a) => !a.synced);
    const btn = document.getElementById('btnSyncAgora');
    if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando...'; }
    for (const item of pendentes) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS no Apps Script
          body: JSON.stringify(item),
        });
        let corpo = null;
        try { corpo = await resp.json(); } catch (e) { /* resposta não era JSON */ }
        if (resp.ok && corpo && corpo.status === 'ok') {
          item.synced = 1;
          item.syncedAt = new Date().toISOString();
          item.erroSync = null;
          await dbPut('apontamentos', item);
        } else {
          item.erroSync = (corpo && corpo.message) ? corpo.message : ('Resposta inesperada do servidor (HTTP ' + resp.status + ')');
          await dbPut('apontamentos', item);
          console.warn('Apps Script retornou erro para o item', item.id, item.erroSync);
        }
      } catch (err) {
        console.warn('Falha ao sincronizar item', item.id, err);
        break; // provavelmente perdeu conexão no meio; tenta de novo depois
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar agora'; }
    await this.atualizarBadge();
    this.renderQueue();
    this.atualizarTagsReportadasRemoto();
  }
};

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  App.init();
  const inputBusca = document.getElementById('inputBusca');
  if (inputBusca) inputBusca.addEventListener('input', (e) => Busca.filtrar(e.target.value));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW falhou', err));
  });
}

// tenta sincronizar periodicamente em background (a cada 2 min, só se online)
setInterval(() => { if (navigator.onLine) Sync.sincronizarAgora(); }, 120000);
