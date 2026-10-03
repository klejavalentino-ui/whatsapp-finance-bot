import { validateCoreConfig } from './config/env.js';
import { startWhatsAppClient } from './services/whatsapp.js';

// Asegurar que la salida se envíe inmediatamente sin buffering
const originalLog = console.log;
console.log = (...args: any[]) => {
  try {
    const text = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack : JSON.stringify(a))).join(' ') + '\n';
    process.stderr.write(text);
  } catch {}
  originalLog.apply(console, args);
};

import http from 'http';
import fs from 'fs';
import path from 'path';

function startHttpServer(): void {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bot: 'running', uptime: Math.floor(process.uptime()) }));
    } else if (req.url === '/qr') {
      const qrPath = path.resolve(process.cwd(), 'qr.html');
      if (fs.existsSync(qrPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(qrPath).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>✅ Sesión activa</h1><p>El bot ya está vinculado y conectado a WhatsApp.</p>');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`🌐 Servidor HTTP activo en el puerto ${port} (Health Check & /qr)`);
  });
}

async function bootstrap() {
  console.log('====================================================');
  console.log(' 💰 WhatsApp Expense Tracker Bot (Gemini + Sheets)  ');
  console.log('====================================================\n');

  // Validar variables de entorno requeridas
  validateCoreConfig();

  // Iniciar servidor HTTP para Render / Docker health checks
  startHttpServer();

  // Inicializar Google Sheets y pestaña Tablero en el arranque
  try {
    const { getSheetsClient, ensureTablero } = await import('./services/sheets.js');
    const sheets = await getSheetsClient();
    await ensureTablero(sheets);
  } catch (err: any) {
    console.warn('⚠️ Nota: Google Sheets se verificará al recibir el primer movimiento:', err?.message || err);
  }

  try {
    // Iniciar cliente de WhatsApp
    await startWhatsAppClient();
  } catch (error) {
    console.error('❌ Error crítico al inicializar la aplicación:', error);
    process.exit(1);
  }
}

// Manejo de apagado elegante
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando bot de WhatsApp de forma segura...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Señal SIGTERM recibida. Cerrando proceso...');
  process.exit(0);
});

bootstrap();
