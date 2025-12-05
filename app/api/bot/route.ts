import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';

// PENTING: Mencegah Next.js melakukan caching static
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;

// Inisialisasi bot tanpa polling
const bot = new TelegramBot(token || '', { polling: false });

export async function POST(req: Request) {
  // 1. Cek Token dulu
  if (!token) {
    console.error('❌ ERROR: TELEGRAM_BOT_TOKEN belum disetting di Vercel!');
    return NextResponse.json({ error: 'Token missing' }, { status: 500 });
  }

  try {
    // 2. Baca data yang dikirim Telegram
    const body = await req.json();
    console.log('📩 Data Masuk:', JSON.stringify(body, null, 2));

    // 3. Cek apakah ada pesan teks
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;

      console.log(`🗣️ Pesan dari user: ${text}`);

      // 4. Kirim Balasan Langsung (Tanpa bot.on)
      await bot.sendMessage(chatId, `Bot Vercel menerima: "${text}"`);
      
      console.log('✅ Balasan terkirim ke Telegram');
    } else {
        console.log('⚠️ Bukan pesan teks atau struktur body berbeda');
    }

    // 5. Beri respon 200 OK ke Telegram supaya tidak dikirim ulang
    return NextResponse.json({ status: 'ok' });

  } catch (error: any) {
    console.error('❌ Terjadi Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Handler GET untuk test manual di browser
export async function GET() {
  return NextResponse.json({ 
    status: 'Bot API Ready', 
    tokenCheck: process.env.TELEGRAM_BOT_TOKEN ? 'Token Ada' : 'Token Kosong' 
  });
}