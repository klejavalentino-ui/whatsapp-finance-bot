import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  proto,
  WASocket,
  jidDecode,
  isJidBot,
  isJidMetaIa,
  META_AI_JID,
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
  const decoded = jidDecode(jid);
  const user = decoded?.user || jid.split('@')[0].split(':')[0];
  return user.replace(/\D/g, '');
}

/**
 * Valida de forma estricta si el mensaje ocurre dentro del chat personal del usuario autorizado.
 * NO debe operar ni leer mensajes en chats de terceros, grupos, estados o interacciones con Meta AI.
 */
function isAuthorizedSender(msg: proto.IWebMessageInfo, myCreds?: any): boolean {
  const remoteJid = msg.key.remoteJid || '';
  const participant = msg.key.participant || (msg as any).participant || '';

  // 1. Ignorar de inmediato si remoteJid está vacío, es difusión, grupo o newsletter
  if (
    !remoteJid ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@newsletter')
  ) {
    return false;
  }

  // 2. Descartar cualquier identificador asociado a Meta AI o bots en remoteJid
  if (
    isJidBot(remoteJid) ||
    isJidMetaIa(remoteJid) ||
    remoteJid === META_AI_JID ||
    remoteJid.endsWith('@bot') ||
    remoteJid.includes('bot') ||
    remoteJid === '0@s.whatsapp.net' ||
    remoteJid === '0@c.us' ||
    remoteJid.includes('1313555') ||
    remoteJid.includes('1316555')
  ) {
    return false;
  }

  // 3. Descartar si el participante es un bot o Meta AI
  if (
    participant &&
    (isJidBot(participant) ||
      isJidMetaIa(participant) ||
      participant === META_AI_JID ||
      participant.endsWith('@bot') ||
      participant.includes('bot') ||
      participant.includes('1313555') ||
      participant.includes('1316555') ||
      participant === '0@s.whatsapp.net' ||
      participant === '0@c.us')
  ) {
    return false;
  }

  // 4. Descartar cualquier mensaje que tenga atributos de bot o IA a nivel de WebMessageInfo
  const msgAny = msg as any;
  if (
    msgAny.is1PBizBotMessage ||
    msgAny.isSupportAiMessage ||
    msgAny.botMessageInvokerJid ||
    msgAny.botTargetId ||
    msgAny.invokedBotWid ||
    msgAny.botPluginMetadata ||
    msgAny.bizPrivacyStatus
  ) {
    return false;
  }

  // 5. Descartar cualquier mensaje que contenga estructuras de invocación de bot o IA
  const rawMsg = msg.message as any;
  if (
    !rawMsg ||
    rawMsg.botInvokeMessage ||
    rawMsg.richResponseMessage ||
    rawMsg.botTaskMessage ||
    rawMsg.questionMessage ||
    rawMsg.botMetadata ||
    rawMsg.botPluginMetadata ||
    rawMsg.botSessionMetadata ||
    rawMsg.botMetricsMetadata ||
    rawMsg.botAgeCollectionMetadata ||
    rawMsg.messageContextInfo?.botMessageInfo ||
    rawMsg.messageContextInfo?.botMetadata
  ) {
    return false;
  }

  // 6. Revisar contextInfo de mensajes
  const contextInfo =
    rawMsg.extendedTextMessage?.contextInfo ||
    rawMsg.imageMessage?.contextInfo ||
    rawMsg.videoMessage?.contextInfo ||
    rawMsg.documentMessage?.contextInfo;

  if (
    contextInfo?.invokedBotWid ||
    contextInfo?.forwardedAiBotMessageInfo ||
    contextInfo?.botMessageInfo ||
    contextInfo?.botMetadata
  ) {
    return false;
  }

  const mentionedJid = contextInfo?.mentionedJid || [];
  if (
    mentionedJid.some(
      (j: string) =>
        isJidBot(j) ||
        isJidMetaIa(j) ||
        j === META_AI_JID ||
        j.includes('bot') ||
        j.includes('1313555') ||
        j.includes('1316555') ||
        j === '0@s.whatsapp.net' ||
        j === '0@c.us'
    )
  ) {
    return false;
  }

  // 7. En el chat personal (bloc de notas / chat con uno mismo), el mensaje debe provenir del usuario (fromMe)
  if (!msg.key.fromMe) {
    return false;
  }

  // 8. El chat en sí (remoteJid) DEBE pertenecer estrictamente al propio usuario
  const allowed = config.allowedPhoneNumber; // Ej: 34642448328
  const userPhone = myCreds?.me?.id ? getDigitsFromJid(myCreds.me.id) : '';
  const userLid = myCreds?.me?.lid ? getDigitsFromJid(myCreds.me.lid) : '';
  const fallbackLid = '9870623391753';

  const validIdentifiers = new Set<string>();
  if (allowed) validIdentifiers.add(allowed);
  if (userPhone) validIdentifiers.add(userPhone);
  if (userLid) validIdentifiers.add(userLid);
  validIdentifiers.add(fallbackLid);

  const chatDigits = getDigitsFromJid(remoteJid);
  if (!chatDigits || !validIdentifiers.has(chatDigits)) {
    return false;
  }

  if (participant) {
    const partDigits = getDigitsFromJid(participant);
    if (partDigits && !validIdentifiers.has(partDigits)) {
      return false;
    }
  }

  return true;
}

/**
 * Determina si el texto tiene apariencia o intención real de registro financiero
 * (divisas, términos de gastos/ingresos/inversiones o formato concepto + monto).
 */
function looksLikeFinancialAttempt(text: string): boolean {
  const lower = text.toLowerCase();
  // 1. Presencia de divisas o símbolos monetarios
  const hasCurrency = /([€$£]|eur(?:os?)?|usd|d[oó]lar(?:es)?|ars|pesos?|u\$s|us\$)/i.test(text);
  // 2. Términos o verbos explícitos de finanzas
  const hasFinancialTerms = /\b(gasto|gast[eé]|gastos|pago|pagu[eé]|pagos|compr[eé]|compras?|ingreso|ingresos|cobr[eé]|sueldo|salario|invert[ií]|inversi[oó]n|inversiones|acciones|cedears?|cripto|btc|fondo|alquiler|expensas|supermercado|almuerzo|cena|desayuno|nafta|combustible|uber|taxi)\b/i.test(lower);
  // 3. Patrón común: concepto de 1 a 3 palabras seguido de un número (ej. "Taxi 15", "Pizza 20")
  const hasSimpleExpensePattern = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{2,25}\s+\d+(?:[.,]\d+)?(?:\s*[a-zA-Z$€]+)?$/i.test(text.trim());

  return hasCurrency || hasFinancialTerms || hasSimpleExpensePattern;
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
    markOnlineOnConnect: false, // Evita marcar al usuario como "En línea" al conectar el bot
    browser: ['Expense Bot', 'Chrome', '1.0.0'],
  });

  // Guardar credenciales cuando se actualizan los tokens criptográficos
  sock.ev.on('creds.update', saveCreds);

  // Manejo del ciclo de vida de la conexión y renderizado del código QR
  sock.ev.on('connection.update', async (update) => {
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
      console.log(`🔒 Modo seguro activo: Solo se responderá al número +${config.allowedPhoneNumber}`);
      console.log(`🔕 Modo sigiloso activo: Cuenta no marcada como "En línea"\n`);

      // Asegurar presencia como desconectado / invisible
      try {
        await sock.sendPresenceUpdate('unavailable');
      } catch {}
    }
  });

  // Escuchar mensajes entrantes y sincronizados (tanto notify como append)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const msgId = msg.key.id;
      if (!msgId || processedMessageIds.has(msgId)) continue;
      rememberMessageId(msgId);

      // 1. Filtro estricto de seguridad: Solo operar en el chat personal del usuario autorizado
      if (!isAuthorizedSender(msg, state.creds)) {
        // Descartar de inmediato sin leer ni procesar mensajes de conversaciones con otras personas
        continue;
      }

      // 2. Extraer texto del mensaje exclusivamente si es del chat personal
      const text = extractTextMessage(msg.message);
      if (!text) continue;

      // 3. Ignorar interacciones o menciones a Meta AI o bots
      const lowerText = text.toLowerCase();
      if (
        lowerText.includes('@meta') ||
        lowerText.includes('meta ai') ||
        lowerText.includes('@ai') ||
        lowerText.startsWith('@')
      ) {
        continue;
      }

      // 4. Si el mensaje es una respuesta generada por el bot, ignorar para evitar bucles
      if (
        text.startsWith('✅ *Registrado con éxito:*') ||
        text.startsWith('⚠️') ||
        text.startsWith('❌')
      ) {
        continue;
      }

      // 5. FILTRO CRUCIAL DE NÚMEROS / MONTOS:
      // Si el mensaje no contiene ningún dígito numérico, es imposible que sea una transacción financiera.
      // Se descartan en absoluto silencio preguntas a Meta AI, notas personales, saludos y textos conversacionales.
      if (!/\d/.test(text)) {
        continue;
      }

      console.log(`\n📩 [Mensaje Financiero Detectado] id: ${msgId} | chat: ${msg.key.remoteJid} | texto: "${text}"`);

      try {
        // 6. Procesar mediante IA (Gemini Flash con Structured Output)
        const extraction = await parseTransactionWithGemini(text);

        if (!extraction.esValido || !extraction.transaccion) {
          // Si no es válido y tampoco parece un intento de registro financiero (ej. preguntas con números a Meta AI), descartar en silencio
          if (!looksLikeFinancialAttempt(text)) {
            continue;
          }

          const mensajeError =
            extraction.mensajeAclaracion ||
            '⚠️ *No pude interpretar la transacción.*\n\n' +
            'Por favor asegúrate de incluir el concepto y el monto.\n' +
            'Ejemplos:\n' +
            '• _Almuerzo 12.50 euros_\n' +
            '• _Supermercado 50 usd_\n' +
            '• _Nafta 15000 pesos ayer_';

          try {
            const sent = await sock.sendMessage(msg.key.remoteJid!, { text: mensajeError }, { quoted: msg });
            if (sent?.key?.id) rememberMessageId(sent.key.id);
          } catch (sendErr) {
            console.error('[WhatsApp] Fallo al enviar mensaje de aclaración:', sendErr);
          }
          continue;
        }

        const tx = extraction.transaccion;

        // 7. Escribir fila en Google Sheets
        await appendTransaction(tx);

        // 8. Responder mensaje de confirmación formateado
        const formattedAmount = `${tx.monto.toFixed(2)} ${tx.moneda}`;
        const confirmationMessage =
          `✅ *Registrado con éxito:*\n` +
          `• *Tipo:* ${tx.tipo}\n` +
          `• *Monto:* ${formattedAmount}\n` +
          `• *Categoría:* ${tx.categoria}\n` +
          `• *Concepto:* ${tx.descripcion}\n` +
          `• *Fecha:* ${tx.fecha}`;

        try {
          const sent = await sock.sendMessage(msg.key.remoteJid!, { text: confirmationMessage }, { quoted: msg });
          if (sent?.key?.id) rememberMessageId(sent.key.id);
          console.log(`[WhatsApp] ✅ Respuesta enviada con éxito.`);
        } catch (sendErr) {
          console.error('[WhatsApp] Fallo al enviar confirmación:', sendErr);
        }
      } catch (err: any) {
        console.error('[Error] Fallo al procesar el mensaje:', err);
        if (looksLikeFinancialAttempt(text)) {
          const errorReply = `❌ Ocurrió un error al registrar el movimiento: ${err?.message || 'Error desconocido'}.\nPor favor intenta nuevamente.`;
          try {
            const sent = await sock.sendMessage(msg.key.remoteJid!, { text: errorReply }, { quoted: msg });
            if (sent?.key?.id) rememberMessageId(sent.key.id);
          } catch {}
        }
      } finally {
        try {
          await sock.sendPresenceUpdate('unavailable');
        } catch {}
      }
    }
  });

  return sock;
}
