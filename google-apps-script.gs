/**
 * BACKEND - Apontamento de Campo NPO
 * -----------------------------------------------------------------------
 * COMO USAR:
 * 1. Crie uma Planilha Google nova (Google Sheets).
 * 2. Nela, crie uma aba chamada exatamente "APONTAMENTOS" com esta linha
 *    de cabeçalho na linha 1 (nessa ordem):
 *    TAG | Atividade | Bloco | SubBloco | StatusNovo | Observacao | ResponsavelExecucao |
 *    NivelConfianca | PadraoDigitado | DataApontamento | SincronizadoEm | FotoURL
 * 3. Menu Extensões > Apps Script. Apague o conteúdo padrão e cole este
 *    arquivo inteiro.
 * 4. Clique em "Implantar" > "Nova implantação" > tipo "Aplicativo da Web".
 *    - Executar como: Eu (sua conta)
 *    - Quem pode acessar: Qualquer pessoa
 * 5. Copie a URL gerada (termina em /exec) e cole na tela "Configurações"
 *    do app, no campo "URL de sincronização".
 * 6. (Opcional) Crie uma pasta no Google Drive para guardar as fotos e
 *    cole o ID dela em DRIVE_FOLDER_ID abaixo. Se deixar em branco, as
 *    fotos são salvas na raiz do Drive da conta usada no deploy.
 * -----------------------------------------------------------------------
 */

const SHEET_NAME = 'APONTAMENTOS';
const DRIVE_FOLDER_ID = ''; // opcional: cole aqui o ID de uma pasta do Drive

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);

    let fotoUrl = '';
    if (data.fotoBase64) {
      fotoUrl = salvarFoto(data.fotoBase64, data.tag);
    }

    sheet.appendRow([
      data.tag || '',
      data.atividade || '',
      data.bloco || '',
      data.subBloco || '',
      data.statusNovo || '',
      data.observacao || '',
      data.responsavelExecucao || '',
      data.nivelConfianca || '',
      data.padraoDigitado || '',
      data.dataApontamento || '',
      new Date().toISOString(),
      fotoUrl
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function salvarFoto(base64Data, tag) {
  try {
    const matches = base64Data.match(/^data:(image\/\w+);base64,(.*)$/);
    if (!matches) return '';
    const contentType = matches[1];
    const bytes = Utilities.base64Decode(matches[2]);
    const blob = Utilities.newBlob(bytes, contentType, tag + '_' + new Date().getTime() + '.jpg');

    const folder = DRIVE_FOLDER_ID
      ? DriveApp.getFolderById(DRIVE_FOLDER_ID)
      : DriveApp.getRootFolder();

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return 'erro_ao_salvar_foto: ' + err.message;
  }
}

// Healthcheck simples - abrir a URL /exec direto no navegador deve mostrar isto
// Também aceita ?action=reportadas para retornar as TAGs já marcadas como "Instalado"
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  if (action === 'reportadas') {
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
      const data = sheet.getDataRange().getValues();
      const tags = [];
      // Colunas: A=TAG, B=Atividade, C=Bloco, D=SubBloco, E=StatusNovo
      for (let i = 1; i < data.length; i++) {
        if (data[i][4] === 'Instalado' && data[i][0]) tags.push(data[i][0]);
      }
      const unicas = Array.from(new Set(tags));
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'ok', tags: unicas }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'online', servico: 'Apontamento NPO' }))
    .setMimeType(ContentService.MimeType.JSON);
}
