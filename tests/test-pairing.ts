import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from '../src/config/env.js';

async function testPairing() {
  const { state } = await useMultiFileAuthState('./auth_session');
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { qr } = update;
    if (qr) {
      console.log('QR recibido. Solicitando código de emparejamiento para +', config.allowedPhoneNumber);
      try {
        const code = await sock.requestPairingCode(config.allowedPhoneNumber);
        console.log('\n============================================================');
        console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${code}`);
        console.log('============================================================\n');
      } catch (err: any) {
        console.error('Error al pedir pairing code:', err?.message || err);
      }
    }
  });
}

testPairing();
