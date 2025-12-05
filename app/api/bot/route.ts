// app/api/bot/route.ts
import { Bot, webhookCallback } from 'grammy';

export const dynamic = 'force-dynamic'; // Mencegah caching statis
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable not found.');

const bot = new Bot(token);

// --- LOGIKA BOT DI SINI ---

// Command: /start
bot.command('start', async (ctx) => {
  await ctx.reply('Halo! Saya adalah bot Telegram yang berjalan di Vercel 🚀');
});

// Menangani pesan teks biasa
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  await ctx.reply(`Kamu berkata: "${text}"`);
});

// --- AKHIR LOGIKA BOT ---

// Handler untuk POST request dari Telegram (Webhook)
export const POST = webhookCallback(bot, 'std/http');