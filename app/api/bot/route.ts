import { Bot, webhookCallback } from 'grammy';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable not found.');

const bot = new Bot(token);

bot.on('message', async (ctx) => {
  // Log ke Vercel console untuk debugging
  console.log("Pesan diterima:", ctx.message); 
  try {
      await ctx.reply("Bot berhasil terhubung! Pesan diterima.");
  } catch (e) {
      console.error("Gagal mengirim pesan balik:", e);
  }
});

export const POST = webhookCallback(bot, 'std/http');