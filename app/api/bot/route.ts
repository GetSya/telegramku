// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';

// 1. Pastikan Token ada
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN tidak ditemukan di Environment Variables');
}

// 2. Inisialisasi Bot (PENTING: polling harus FALSE)
// Kita gunakan polling: false karena di Vercel kita pakai Webhook
const bot = new TelegramBot(token, { polling: false });

// 3. Konfigurasi Route Next.js agar dinamis (tidak di-cache)
export const dynamic = 'force-dynamic';

// --- LOGIKA PESAN ---
// Kita pasang listener di sini, tapi ingat: di serverless, listener ini
// dibuat ulang setiap kali ada pesan masuk.
bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  console.log(`[LOG] Pesan masuk dari ${msg.from?.first_name}: ${text}`);

  try {
    if (text === '/start') {
      await bot.sendMessage(chatId, 'Halo! Bot Node.js API sudah aktif di Vercel.');
    } else {
      await bot.sendMessage(chatId, `Kamu bilang: ${text}`);
    }
  } catch (error) {
    console.error('[ERROR] Gagal mengirim pesan:', error);
  }
});
// --------------------

// 4. Handler POST (Pintu masuk dari Telegram)
export async function POST(req: Request) {
  try {
    // Ambil data JSON yang dikirim Telegram
    const body = await req.json();

    // Cek apakah ini update yang valid
    if (!body || !body.update_id) {
      return NextResponse.json({ status: 'No update_id found' }, { status: 400 });
    }

    // PENTING: Oper data ini ke library node-telegram-bot-api
    // Library ini akan membaca data dan memicu event bot.on('message') di atas
    bot.processUpdate(body);

    // Beri respon 200 OK ke Telegram agar tidak dikirim ulang
    return NextResponse.json({ status: 'ok' });

  } catch (error) {
    console.error('Error handling request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// Handler GET (Cuma buat ngetes di browser kalau route ini hidup)
export async function GET() {
  return NextResponse.json({ status: 'Bot API is running correctly' });
}