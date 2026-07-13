# Apontamento de Campo — NPO (protótipo PWA)

Aplicativo web instalável (PWA), sem loja de aplicativos, sem login corporativo,
funciona offline. Baseado na base `10-07.xlsx` (30.585 TAGs únicas).

## O que já está pronto

- **index.html / style.css / app.js** — o app em si (Bloco → Sub-bloco → busca
  incremental com "?" para caracteres ilegíveis → confirmação → apontamento
  com foto/status/confiança → fila offline → sincronização).
- **tags_data.json** — base de referência (TAGs) já extraída e embarcada.
- **manifest.json / sw.js / icons/** — o que torna o app instalável e
  funcional sem internet.
- **google-apps-script.gs** — código do backend (grava em uma Planilha Google
  + salva fotos no Google Drive). Instruções de instalação estão no topo do
  próprio arquivo.

## Passo a passo para colocar no ar

### 1. Backend (Google Sheets + Apps Script) — 10 minutos
Siga o comentário no topo de `google-apps-script.gs`. No fim, você terá uma
URL do tipo `https://script.google.com/macros/s/AAA.../exec`.

### 2. Hospedar o app (escolha uma opção gratuita)

**Opção A — GitHub Pages (recomendado, grátis, simples):**
1. Crie um repositório novo no GitHub.
2. Suba todos os arquivos desta pasta (exceto o `.gs`, que não vai pro site).
3. Em `Settings > Pages`, ative o GitHub Pages apontando para a branch
   principal, pasta raiz.
4. Em alguns minutos, o app estará em `https://seu-usuario.github.io/repo/`.

**Opção B — Netlify (drag-and-drop, sem git):**
1. Acesse app.netlify.com, crie conta gratuita.
2. Arraste a pasta com os arquivos (exceto `.gs`) na área de deploy manual.
3. Pronto — você recebe uma URL pública na hora.

Qualquer uma das duas serve HTTPS automaticamente, o que é **obrigatório**
para o PWA funcionar offline (Service Worker só roda em HTTPS ou localhost).

### 3. Configurar no app
1. Abra a URL publicada no celular.
2. Toque em "Configurações / equipe" na tela inicial.
3. Cole a URL do Apps Script (`/exec`) no campo de sincronização.
4. Cadastre os nomes da equipe.
5. No Android/Chrome: menu (⋮) → "Adicionar à tela inicial" para instalar
   como app. No iPhone/Safari: botão compartilhar → "Adicionar à Tela de
   Início".

### 4. Atualizando a base de TAGs no futuro
Quando o ESCOPO for atualizado, gere um novo `tags_data.json` a partir do
Excel mais recente e apenas substitua o arquivo no repositório/deploy — não
precisa mexer em mais nada.

## Limitações conhecidas deste protótipo (para você levar à conversa com o TI)

- Fotos ficam em Base64 dentro do IndexedDB até sincronizar — em celulares
  com pouco espaço, evite deixar muitos apontamentos pendentes por dias.
- Sem controle de acesso: qualquer pessoa com o link/app instalado e o nome
  cadastrado pode registrar apontamentos. Adequado para prova de conceito,
  não para produção formal.
- A reconciliação com o ESCOPO oficial continua manual (exportar a aba
  APONTAMENTOS da planilha e cruzar via Power Query), como já combinado.
