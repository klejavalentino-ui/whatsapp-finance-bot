import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { parseTransactionWithGemini } from './ai.js';
import { appendTransaction } from './sheets.js';

function saveHtmlQr(qrString: string): void {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Vincular WhatsApp - Bot de Gastos</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
    .card { background: #111b21; padding: 36px 40px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); text-align: center; max-width: 440px; }
    h1 { color: #00a884; margin-top: 0; font-size: 24px; font-weight: 600; }
    p { color: #aebac1; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
    .qr-container { display: inline-block; padding: 20px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
    .note { margin-top: 20px; color: #8696a0; font-size: 13px; }
    .refresh-badge { display: inline-block; margin-top: 10px; background: #202c33; color: #00a884; padding: 6px 12px; border-radius: 20px; font-size: 12px; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>
<body>
  <div class="card">
    <h1>📱 Vincular con WhatsApp</h1>
    <p>1. Abre WhatsApp en tu teléfono.<br>2. Toca <b>Menú / Ajustes</b> &gt; <b>Dispositivos vinculados</b>.<br>3. Toca <b>Vincular un dispositivo</b> y apunta la cámara a este código:</p>
    <div class="qr-container">
      <div id="qrcode"></div>
    </div>
    <div class="note">
      <span class="refresh-badge">🔄 Código QR activo (se actualiza automáticamente)</span>
    </div>
  </div>
  <script>
    new QRCode(document.getElementById("qrcode"), {
      text: ${JSON.stringify(qrString)},
      width: 280,
      height: 280,
      colorDark : "#000000",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.M
    });
    setTimeout(() => location.reload(), 15000);
  </script>
</body>
</html>`;
  try {
    fs.writeFileSync(path.resolve(process.cwd(), 'qr.html'), html, 'utf-8');
  } catch {}
}

// Logger silencioso para Baileys para no saturar la consola de QR
const logger = pino({ level: 'silent' });

// Cache en memoria para deduplicar mensajes entrantes (evita procesar el mismo mensaje tras reconexión)
const processedMessageIds = new Set<string>();
const MAX_PROCESSED_CACHE = 500;

function rememberMessageId(id: string): void {
  if (processedMessageIds.size > MAX_PROCESSED_CACHE) {
    const [first] = processedMessageIds;
    processedMessageIds.delete(first);
  }
  processedMessageIds.add(id);
}

/**
 * Extrae el texto legible de cualquier estructura de mensaje de WhatsApp.
 */
function extractTextMessage(message: proto.IMessage | null | undefined): string {
  if (!message) return '';
  const unwrapped =
    (message as any).ephemeralMessage?.message ||
    (message as any).viewOnceMessage?.message ||
    (message as any).viewOnceMessageV2?.message ||
    (message as any).documentWithCaptionMessage?.message ||
    message;

  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    ''
  ).trim();
}

/**
 * Normaliza y extrae únicamente los dígitos de un JID de WhatsApp.
 */
function getDigitsFromJid(jid?: string | null): string {
  if (!jid) return '';
  return jid.split('@')[0].replace(/\D/g, '');
}

/**
 * Valida si el mensaje entrante pertenece de forma exclusiva al usuario autorizado o a su chat personal.
 */
function isAuthorizedSender(msg: proto.IWebMessageInfo, myCreds?: any): boolean {
  const remoteJid = msg.key.remoteJid || '';

  // 1. Ignorar actualizaciones de estado o mensajes grupales
  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
    return false;
  }

  const allowed = config.allowedPhoneNumber;
  const chatDigits = getDigitsFromJid(remoteJid);
  const userPhone = myCreds?.me?.id ? getDigitsFromJid(myCreds.me.id) : allowed;
  const userLidDigits = myCreds?.me?.lid ? getDigitsFromJid(myCreds.me.lid) : '9870623391753';

  // Coincide con número de teléfono
  if (chatDigits === allowed || (userPhone && chatDigits === userPhone)) {
    return true;
  }

  // Coincide con LID de la cuenta personal
  if (userLidDigits && chatDigits === userLidDigits) {
    return true;
  }

  // Si fue enviado por el propio usuario (fromMe)
  if (msg.key.fromMe) {
    // Si viene de @lid o coincide con el usuario, es el chat consigo mismo
    if (remoteJid.endsWith('@lid') || chatDigits === allowed || chatDigits === userPhone || chatDigits === userLidDigits) {
      return true;
    }
  }

  return false;
}

/**
 * Inicia el cliente de WhatsApp con Baileys.
 */
export async function startWhatsAppClient(): Promise<WASocket> {
  // Asegurar existencia de directorio de sesión
  if (!fs.existsSync(config.whatsappAuthDir)) {
    fs.mkdirSync(config.whatsappAuthDir, { recursive: true });
  }

  console.log('[WhatsApp] Cargando sesión de autenticación...');
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsappAuthDir);

  let version: [number, number, number] = [2, 3000, 1015901307];
  let isLatest = false;
  try {
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (latest) {
      version = latest.version;
      isLatest = latest.isLatest;
    }
  } catch {
    // Usar versión por defecto si hay timeout de red
  }

  console.log(`[WhatsApp] Usando versión de protocolo WhatsApp: v${version.join('.')}`);
  console.log(`[WhatsApp] Número personal autorizado: +${config.allowedPhoneNumber || 'NO CONFIGURADO'}`);
  console.log('[WhatsApp] Conectando a los servidores de WhatsApp para generar QR...');

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    browser: ['Expense Bot', 'Chrome', '1.0.0'],
  });

  // Guardar credenciales cuando se actualizan los tokens criptográficos
  sock.ev.on('creds.update', saveCreds);

  // Manejo del ciclo de vida de la conexión y renderizado del código QR
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      saveHtmlQr(qr);
      console.log('\n============================================================');
      console.log('  📱 CÓDIGO QR GENERADO (Actualizado en tiempo real):');
      console.log('  OPCIÓN 1: Escanea este QR directamente con WhatsApp.');
      console.log('  OPCIÓN 2: Abre el archivo qr.html en tu navegador para verlo grande y en blanco y negro:');
      console.log(`  ${path.resolve(process.cwd(), 'qr.html')}`);
      console.log('============================================================\n');
      qrcode.generate(qr, { small: true });
      console.log('============================================================\n');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[WhatsApp] Conexión cerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => {
          startWhatsAppClient().catch((err) => console.error('[WhatsApp] Error al reconectar:', err));
        }, 3000);
      } else {
        console.log('[WhatsApp] Sesión cerrada definitivamente. Borra la carpeta de sesión para generar un nuevo QR.');
      }
    } else if (connection === 'open') {
      console.log('\n🚀 [WhatsApp] ¡Conexión establecida exitosamente!');
      console.log(`✅ Bot listo para recibir gastos e ingresos personales.`);
      console.log(`🔒 Modo seguro activo: Solo se responderá al número +${config.allowedPhoneNumber}\n`);
    }
  });

  // Escuchar mensajes entrantes y sincronizados (tanto notify como append)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const msgId = msg.key.id;
      if (!msgId || processedMessageIds.has(msgId)) continue;
      rememberMessageId(msgId);

      // 1. Extraer texto del mensaje
      const text = extractTextMessage(msg.message);
      if (!text) continue;

      // 2. Si el mensaje es una respuesta generada por el bot, ignorar para evitar bucles
      if (
        text.startsWith('✅ *Registrado con éxito:*') ||
        text.startsWith('⚠️') ||
        text.startsWith('❌')
      ) {
        continue;
      }

      console.log(`\n[EVENTO MSG] id: ${msgId} | remoteJid: ${msg.key.remoteJid} | fromMe: ${msg.key.fromMe} | texto: "${text}"`);

      // 3. Filtro estricto de seguridad: número autorizado o chat personal
      if (!isAuthorizedSender(msg, state.creds)) {
        console.log(`[Seguridad] Mensaje descartado de ${msg.key.remoteJid}: no coincide con el usuario autorizado.`);
        continue;
      }

      console.log(`📩 [Mensaje Aceptado] "${text}" en chat ${msg.key.remoteJid}`);

      // Enviar indicador de "escribiendo..." en WhatsApp
      if (msg.key.remoteJid) {
        await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
      }

      try {
        // 4. Procesar mediante IA (Gemini Flash con Structured Output)
        const extraction = await parseTransactionWithGemini(text);

        if (!extraction.esValido || !extraction.transaccion) {
          const mensajeError =
            extraction.mensajeAclaracion ||
            '⚠️ *No pude interpretar la transacción.*\n\n' +
            'Por favor asegúrate de incluir el concepto y el monto.\n' +
            'Ejemplos:\n' +
            '• _Almuerzo 12.50_\n' +
            '• _Cobro sueldo 1500_\n' +
            '• _Uber 800 transporte ayer_';

          let sent: any;
          try {
            sent = await sock.sendMessage(msg.key.remoteJid!, { text: mensajeError }, { quoted: msg });
          } catch {
            sent = await sock.sendMessage(`${config.allowedPhoneNumber}@s.whatsapp.net`, { text: mensajeError });
          }
          if (sent?.key?.id) rememberMessageId(sent.key.id);
          continue;
        }

        const tx = extraction.transaccion;

        // 5. Escribir fila en Google Sheets
        await appendTransaction(tx);

        // 6. Responder mensaje de confirmación formateado
        const formattedAmount = `${config.currencySymbol}${tx.monto.toFixed(2)}`;
        const confirmationMessage =
          `✅ *Registrado con éxito:*\n` +
          `• *Tipo:* ${tx.tipo}\n` +
          `• *Monto:* ${formattedAmount}\n` +
          `• *Categoría:* ${tx.categoria}\n` +
          `• *Concepto:* ${tx.descripcion}\n` +
          `• *Fecha:* ${tx.fecha}`;

        let sent: any;
        try {
          sent = await sock.sendMessage(msg.key.remoteJid!, { text: confirmationMessage }, { quoted: msg });
        } catch {
          sent = await sock.sendMessage(`${config.allowedPhoneNumber}@s.whatsapp.net`, { text: confirmationMessage });
        }
        if (sent?.key?.id) rememberMessageId(sent.key.id);
        console.log(`[WhatsApp] ✅ Respuesta enviada con éxito.`);
      } catch (err: any) {
        console.error('[Error] Fallo al procesar el mensaje:', err);
        const errorReply = `❌ Ocurrió un error al registrar el movimiento: ${err?.message || 'Error desconocido'}.\nPor favor intenta nuevamente.`;
        const sent = await sock.sendMessage(msg.key.remoteJid!, { text: errorReply }, { quoted: msg });
        if (sent?.key?.id) rememberMessageId(sent.key.id);
      } finally {
        if (msg.key.remoteJid) {
          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
        }
      }
    }
  });

  return sock;
}
