// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;

// Inisialisasi Bot
const bot = new TelegramBot(token || '', { polling: false });

// 1. HANDLER UNTUK TELEGRAM (POST)
export async function POST(req: Request) {
  if (!token) {
    return NextResponse.json({ error: 'Token belum diisi di Vercel' }, { status: 500 });
  }

  try {
    const body = await req.json();

    // Log untuk melihat data yang dikirim Telegram di Vercel Logs
    console.log('Update masuk:', JSON.stringify(body));

    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;

      // Kirim balasan
      await bot.sendMessage(chatId, `Saya terima pesan: "${text}"`);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error: any) {
    console.error('Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 2. HANDLER UNTUK BROWSER (GET) <- INI YANG KURANG TADI
export async function GET() {
  return NextResponse.json({
    status: 'Bot Berjalan!',
    message: 'Halo, endpoint ini aktif. Tapi Telegram mengirim data lewat POST, bukan GET.',
    tokenCheck: process.env.TELEGRAM_BOT_TOKEN ? '✅ Token Ada' : '❌ Token Kosong'
  });
}