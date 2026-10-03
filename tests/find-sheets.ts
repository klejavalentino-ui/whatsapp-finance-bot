import { google } from 'googleapis';
import fs from 'fs';
import { config } from '../src/config/env.js';

async function findSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleCredentialsPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });

  const drive = google.drive({ version: 'v3', auth });

  console.log('Buscando hojas de cálculo compartidas con la cuenta de servicio...');
  try {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: 'files(id, name, webViewLink)',
    });

    const files = res.data.files || [];
    console.log(`Hojas encontradas: ${files.length}`);
    for (const f of files) {
      console.log(`- Nombre: "${f.name}" | ID: ${f.id} | Link: ${f.webViewLink}`);
    }
  } catch (err: any) {
    console.error('Error al listar archivos con Drive API:', err?.message || err);
  }

  const sheets = google.sheets({ version: 'v4', auth });
  console.log(`Probando acceso directo a ID: "${config.spreadsheetId}"...`);
  try {
    const sheetRes = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    console.log(`✅ ¡Éxito! Título: "${sheetRes.data.properties?.title}"`);
  } catch (err: any) {
    console.error(`❌ Fallo directo con "${config.spreadsheetId}":`, err?.message || err);
  }
}

findSheets();
