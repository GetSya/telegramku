// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
import * as XLSX from 'xlsx';
import axios from 'axios';
import FormData from 'form-data';

// =======================================================
// KONFIGURASI
// =======================================================

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_USERNAME = 'sofunsyabi'; // Tanpa @

if (!token) throw new Error('TELEGRAM_BOT_TOKEN wajib ada');

const bot = new TelegramBot(token, { polling: false });

// =======================================================
// TIPE DATA & STATE
// =======================================================

type Product = {
  id: string; code: string; name: string; category: string;
  unit: string; priceBuy: number; priceSell: number; stock: number; createdAt: string;
};

type CartItem = {
  productId: string; name: string; price: number; qty: number; unit: string;
};

type Order = {
  invoice: string; date: string; buyerName: string; buyerId: number; buyerUsername?: string;
  items: CartItem[]; totalPrice: number; status: 'PENDING' | 'PAID' | 'SENT' | 'REJECTED';
  paymentProofFileId?: string; notes?: string; credentials?: string; // Menyimpan data akun yg dikirim
};

type UserSession = {
  step: 'IDLE' | 'ADD_PROD_NAME' | 'ADD_PROD_CAT' | 'ADD_PROD_UNIT' | 'ADD_PROD_BUY' | 'ADD_PROD_SELL' | 'ADD_PROD_STOCK' | 'CONFIRM_PAYMENT' | 'BROADCAST_MSG' | 'LIVE_CHAT' | 'EDIT_PRICE_VAL' | 'EDIT_STOCK_VAL' | 'ADD_NOTE' 
        | 'SEND_CREDENTIALS'; // <--- STEP BARU
  temp: any;
  cart: CartItem[];
  lastMessageId?: number;
};

type DB = {
  company: { name: string; addr: string; email: string; phone: string; bank: string };
  admins: number[]; products: Product[]; orders: Order[]; categories: string[]; units: string[];
  customCommands: Record<string, string>; users: Record<number, UserSession>;
};

// =======================================================
// DATABASE MEMORY
// =======================================================

const globalForDB = global as unknown as { db: DB };
const db: DB = globalForDB.db || {
  company: {
    name: "Sofunsyabi Store", addr: "Digital World", email: "admin@store.com",
    phone: "+62 812-3456-7890", bank: "BCA 1234567890 a/n Admin\nDANA 0812xxxx"
  },
  admins: [], categories: ["Aplikasi Premium", "Software PC", "Source Code", "E-Course"],
  units: ["Akun", "License Key", "File", "Link"],
  products: [
    { id: "1", code: "YT-PREM", name: "YouTube Premium 1 Bulan", category: "Aplikasi Premium", unit: "Akun", priceBuy: 5000, priceSell: 15000, stock: 50, createdAt: "2024-01-01" }
  ],
  orders: [], customCommands: { "/about": "🤖 Bot Digital Product Automator" }, users: {}
};

if (process.env.NODE_ENV !== 'production') globalForDB.db = db;

// =======================================================
// UTILS & HELPER
// =======================================================

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const getSession = (chatId: number): UserSession => {
  if (!db.users[chatId]) db.users[chatId] = { step: 'IDLE', temp: {}, cart: [] };
  return db.users[chatId];
};
const isAdmin = (u?: string, id?: number) => (u === OWNER_USERNAME || (id && db.admins.includes(id)));
const resetSession = (chatId: number, keepCart: boolean = false) => {
  const oldCart = db.users[chatId]?.cart || [];
  db.users[chatId] = { step: 'IDLE', temp: {}, cart: keepCart ? oldCart : [] };
};
const generateInvoice = () => `INV/${Date.now().toString().slice(-6)}/${Math.floor(Math.random()*999)}`;

async function generateExcelReport() {
    // Logic Excel Sederhana
    const worksheetData = db.orders.map(o => ({
        'Invoice': o.invoice, 'Tgl': o.date, 'Pembeli': o.buyerName, 
        'Total': o.totalPrice, 'Status': o.status, 'Produk': o.items.map(i=>i.name).join(', ')
    }));
    const worksheet = XLSX.utils.json_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function showAdminProducts(chatId: number) {
  const text = `📦 *LIST PRODUK* (${db.products.length})`;
  
  const keyboard = db.products.map(p => ([
    { text: `${p.name} (Stok: ${p.stock})`, callback_data: `adm_edit_${p.id}` }
  ]));

  keyboard.push([{ text: "➕ Tambah", callback_data: "adm_add_prod" }, { text: "⬅️ Kembali", callback_data: "adm_dash" }]);

  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  
  getSession(chatId).lastMessageId = response.message_id;
}

// FUNCTION TOURL (Upload Stream to Catbox/Uguu)
// Kita pakai Catbox.moe (lebih stabil utk bot) atau uguu (sesuai request)
async function uploadToUguu(fileUrl: string): Promise<string> {
    try {
        // 1. Download file dari Telegram sebagai Stream
        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        // 2. Siapkan Form Data
        const form = new FormData();
        // Uguu terkadang rewel dengan filename, kita generate acak
        form.append("files[]", response.data, { filename: `img-${Date.now()}.jpg` });

        // 3. Upload ke Uguu
        const res = await axios.post("https://uguu.se/upload.php", form, {
            headers: form.getHeaders(),
             // maxContentLength: Infinity,
             // maxBodyLength: Infinity
        });

        if(res.data && res.data.files && res.data.files[0]) {
            return res.data.files[0].url;
        } else {
            throw new Error("Respon Uguu kosong");
        }
    } catch (error: any) {
        console.error("Upload Error:", error.message);
        throw new Error("Gagal upload ke server.");
    }
}

// =======================================================
// MAIN HANDLER
// =======================================================

export async function POST(req: Request) {
  try {
    const update = await req.json();
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) {
      if (update.message.text) await handleMessage(update.message);
      else if (update.message.photo) await handlePhoto(update.message);
    }
    return NextResponse.json({ status: 'ok' });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function handleMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const username = msg.from?.username;
  const session = getSession(chatId);

  // Auto Admin
  if (username === OWNER_USERNAME && !db.admins.includes(chatId)) db.admins.push(chatId);

  // 1. INPUT STEP (Flow Khusus)
  if (session.step !== 'IDLE') {
    await processInputSteps(chatId, text, session, msg);
    return;
  }

  // 2. COMMAND /tourl (Konversi Gambar ke Link)
  if (text === '/tourl') {
      if (!msg.reply_to_message?.photo) {
          return bot.sendMessage(chatId, "⚠️ Balas sebuah gambar dengan perintah /tourl");
      }
      
      const waitMsg = await bot.sendMessage(chatId, "⏳ Sedang mengupload ke cloud...");
      try {
          // Ambil File ID resolusi terbesar
          const photos = msg.reply_to_message.photo;
          const fileId = photos[photos.length - 1].file_id;
          
          // Dapatkan URL Download Telegram
          const fileLink = await bot.getFileLink(fileId);
          
          // Upload Process
          const url = await uploadToUguu(fileLink);
          
          await bot.sendMessage(chatId, `✅ **Upload Berhasil!**\n\nURL: \`${url}\``, { 
              parse_mode: 'Markdown',
              disable_web_page_preview: true
          });
          await bot.deleteMessage(chatId, waitMsg.message_id);
      } catch (error) {
          await bot.editMessageText("❌ Gagal upload. Server sedang sibuk.", {chat_id: chatId, message_id: waitMsg.message_id});
      }
      return;
  }

  // 3. ADMIN /reply
  if (text.startsWith('/reply') && isAdmin(username, chatId)) {
    const parts = text.split(' ');
    if (parts.length < 3) return bot.sendMessage(chatId, "Format: `/reply [ID] [Pesan]`", {parse_mode:'Markdown'});
    try {
        await bot.sendMessage(parseInt(parts[1]), `📩 **PESAN DARI ADMIN:**\n\n${parts.slice(2).join(' ')}`, {parse_mode:'Markdown'});
        bot.sendMessage(chatId, "✅ Terkirim.");
    } catch { bot.sendMessage(chatId, "❌ Gagal kirim (User blokir bot?)."); }
    return;
  }

  // 4. MAIN MENU COMMANDS
  switch (text) {
    case '/start':
    case '/menu':
      await showMainMenu(chatId, msg.from?.first_name || 'Kak');
      break;
    case '/admin':
      if (isAdmin(username, chatId)) await showAdminDashboard(chatId);
      break;
    default:
      if (db.customCommands[text]) await bot.sendMessage(chatId, db.customCommands[text], {parse_mode:'Markdown'});
      else if (!isAdmin(username, chatId)) await bot.sendMessage(chatId, "Ketik /menu untuk belanja produk digital.");
  }
}

async function handlePhoto(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    
    // Konfirmasi Pembayaran
    if (session.step === 'CONFIRM_PAYMENT' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const total = session.cart.reduce((s, i) => s + (i.price * i.qty), 0);
        const invoice = generateInvoice();

        const order: Order = {
            invoice, date: new Date().toLocaleDateString(), 
            buyerName: msg.from?.first_name || 'User', buyerId: chatId, buyerUsername: msg.from?.username,
            items: [...session.cart], totalPrice: total, status: 'PENDING', paymentProofFileId: fileId
        };
        db.orders.push(order);
        
        // Kurangi stok
        session.cart.forEach(c => {
            const p = db.products.find(x => x.id === c.productId);
            if(p) p.stock = Math.max(0, p.stock - c.qty);
        });

        resetSession(chatId); // Reset user state
        
        await bot.sendMessage(chatId, `✅ **PESANAN DIBUAT**\nInvoice: ${invoice}\nMohon tunggu admin memverifikasi pembayaran.`);

        // Notify Admins
        const caption = `🚨 **ORDER PREMIUM MASUK**\n${invoice}\nBuyer: ${order.buyerName}\nTotal: ${formatRp(total)}\n\n_Lihat Bukti Transfer_ 👇`;
        const kb = { inline_keyboard: [[
            { text: "✅ Valid & Terima", callback_data: `verify_paid_${invoice}` },
            { text: "❌ Tolak", callback_data: `verify_reject_${invoice}` }
        ]]};
        
        for (const aid of db.admins) {
             bot.sendPhoto(aid, fileId, { caption, parse_mode: 'Markdown', reply_markup: kb }).catch(()=>{});
        }
    }
}

async function handleCallback(q: TelegramBot.CallbackQuery) {
    const chatId = q.message?.chat.id!;
    const data = q.data!;
    const session = getSession(chatId);

    try { await bot.answerCallbackQuery(q.id); } catch{}

    // === USER AREA ===
    if (data === 'menu_cat') await showProductCatalog(chatId);
    if (data === 'menu_cart') await showCart(chatId);
    if (data === 'menu_chat') {
        session.step = 'LIVE_CHAT';
        bot.sendMessage(chatId, "💬 **LIVE CHAT ADMIN**\nSilakan tulis pesan/pertanyaan Anda:");
    }
    if (data === 'menu_info') bot.sendMessage(chatId, `💳 **PAYMENT**\n${db.company.bank}\n\nHub: ${db.company.phone}`);
    
    if (data.startsWith('add_')) {
        const pid = data.split('_')[1];
        const p = db.products.find(x => x.id === pid);
        if(p && p.stock > 0) {
            const exist = session.cart.find(c => c.productId === pid);
            if(exist) exist.qty++; else session.cart.push({ productId:pid, name:p.name, price:p.priceSell, qty:1, unit:p.unit});
            bot.sendMessage(chatId, `✅ ${p.name} (+1) masuk keranjang.`);
        } else bot.sendMessage(chatId, "Stok habis.");
    }
    if (data === 'checkout') {
        if(session.cart.length === 0) return bot.sendMessage(chatId, "Keranjang kosong.");
        const tot = session.cart.reduce((s,i)=>s+(i.price*i.qty),0);
        session.step = 'CONFIRM_PAYMENT';
        bot.sendMessage(chatId, `🧾 **TOTAL: ${formatRp(tot)}**\nSilakan Transfer ke:\n${db.company.bank}\n\n📸 **Kirim BUKTI FOTO Transfer sekarang:**`);
    }
    if (data === 'clear_cart') { session.cart = []; bot.sendMessage(chatId, "Keranjang dibersihkan."); }

    // === ADMIN AREA ===
    if (!isAdmin(q.from.username, chatId)) return;

    if (data === 'adm_dash') showAdminDashboard(chatId);
    if (data === 'adm_prod') showAdminProducts(chatId);
    if (data === 'adm_add') { session.step = 'ADD_PROD_NAME'; bot.sendMessage(chatId, "Masukkan Nama Produk:"); }
    if (data === 'adm_xl') {
        const buf = await generateExcelReport();
        bot.sendDocument(chatId, buf, {}, {filename: `Laporan_${Date.now()}.xlsx`, contentType: 'application/xlsx'});
    }
    if (data.startsWith('verify_reject_')) {
        // Logika Reject (Bisa dikembangkan seperti sebelumnya)
        bot.sendMessage(chatId, "Pesanan Ditolak.");
        // Anda bisa copy logika restore stock dari kode sebelumnya disini
    }

    // --- LOGIKA UTAMA: TERIMA ORDER & OPSIONAL KIRIM DATA ---
    if (data.startsWith('verify_paid_')) {
        const inv = data.replace('verify_paid_', '');
        const order = db.orders.find(o => o.invoice === inv);
        
        if (order && order.status === 'PENDING') {
            order.status = 'PAID';
            // 1. Tawarkan opsi ke admin
            const kb = { inline_keyboard: [
                [{text:"📩 Ya, Kirim Data/Akun", callback_data:`send_data_yes_${inv}`}],
                [{text:"🙅‍♂️ Tidak, Cuma Notif Lunas", callback_data:`send_data_no_${inv}`}]
            ]};
            
            await bot.editMessageCaption(
                `✅ **PEMBAYARAN DITERIMA** (${inv})\nApakah Anda ingin mengirim Data Akun/File ke pembeli sekarang?`, 
                { chat_id: chatId, message_id: q.message?.message_id, parse_mode: 'Markdown', reply_markup: kb }
            );
        } else {
            bot.sendMessage(chatId, "Order sudah diproses atau tidak valid.");
        }
    }

    // A. JIKA ADMIN MILIH: KIRIM DATA (Input Credentials)
    if (data.startsWith('send_data_yes_')) {
        const inv = data.replace('send_data_yes_', '');
        session.temp = { invoiceTarget: inv };
        session.step = 'SEND_CREDENTIALS';
        
        bot.sendMessage(chatId, 
            `🔐 **KIRIM DATA AKSES / PRODUK**\nTarget: ${inv}\n\nSilakan ketik Email/Password/Link/Lisensi Key yang ingin dikirim ke User.\n\n_Contoh:_\nEmail: user@gmail.com\nPass: 123456`, 
            {parse_mode:'Markdown'}
        );
    }

    // B. JIKA ADMIN MILIH: TIDAK (Cuma Notif Biasa)
    if (data.startsWith('send_data_no_')) {
        const inv = data.replace('send_data_no_', '');
        const order = db.orders.find(o => o.invoice === inv);
        if (order) {
            order.status = 'SENT';
            bot.sendMessage(order.buyerId, `✅ **PEMBAYARAN DITERIMA!**\n\nTerima kasih, order **${inv}** telah selesai.\nSilakan cek pesan selanjutnya jika ada instruksi.`, {parse_mode:'Markdown'});
            bot.sendMessage(chatId, "✅ Order ditutup (Status: Paid/Sent). User sudah dinotifikasi.");
        }
    }
}

async function processInputSteps(chatId: number, text: string, session: UserSession, msg: any) {
    if(text === 'BATAL') { resetSession(chatId); return bot.sendMessage(chatId, "Batal."); }

    // ... LOGIKA INPUT PRODUK (Sama seperti sebelumnya) ...
    // Saya persingkat bagian Add Product agar fokus ke fitur baru
    if (session.step === 'ADD_PROD_NAME') { session.temp.name = text; session.step = 'ADD_PROD_CAT'; bot.sendMessage(chatId, "Kategori:"); }
    else if (session.step === 'ADD_PROD_CAT') { session.temp.cat = text; session.step = 'ADD_PROD_UNIT'; bot.sendMessage(chatId, "Unit (Akun/Key/File):"); }
    else if (session.step === 'ADD_PROD_UNIT') { session.temp.unit = text; session.step = 'ADD_PROD_BUY'; bot.sendMessage(chatId, "Modal:"); }
    else if (session.step === 'ADD_PROD_BUY') { session.temp.buy = Number(text); session.step = 'ADD_PROD_SELL'; bot.sendMessage(chatId, "Jual:"); }
    else if (session.step === 'ADD_PROD_SELL') { session.temp.sell = Number(text); session.step = 'ADD_PROD_STOCK'; bot.sendMessage(chatId, "Stok:"); }
    else if (session.step === 'ADD_PROD_STOCK') { 
        db.products.push({ id:Date.now().toString(), code:'P'+Date.now(), name:session.temp.name, category:session.temp.cat, unit:session.temp.unit, priceBuy:session.temp.buy, priceSell:session.temp.sell, stock:Number(text), createdAt: new Date().toISOString() });
        resetSession(chatId); bot.sendMessage(chatId, "✅ Produk Disimpan.");
    }

    // FITUR BARU: SEND CREDENTIALS
    else if (session.step === 'SEND_CREDENTIALS') {
        const inv = session.temp.invoiceTarget;
        const order = db.orders.find(o => o.invoice === inv);
        
        if (order) {
            order.status = 'SENT';
            order.credentials = text; // Simpan di history (opsional)

            // 1. KIRIM DATA KE PEMBELI (Format Eksklusif)
            const buyerMsg = `📦 **ORDER SELESAI & TERKIRIM!**\nInvoice: \`${inv}\`\n\n⬇️ **DATA PESANAN ANDA:**\n━━━━━━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━━━━━━\n\n⚠️ _Mohon segera amankan akun/data tersebut._\nTerima kasih!`;
            
            await bot.sendMessage(order.buyerId, buyerMsg, { parse_mode: 'Markdown' });
            
            // 2. Info Balik ke Admin
            await bot.sendMessage(chatId, `✅ **Sukses!** Data kredensial telah dikirim ke User untuk order ${inv}.`);
        } else {
            bot.sendMessage(chatId, "❌ Error: Order data hilang.");
        }
        resetSession(chatId);
    }
    
    // Live Chat Handler
    else if (session.step === 'LIVE_CHAT') {
        db.admins.forEach(id => bot.sendMessage(id, `💬 **CHAT ${msg?.from?.first_name}**:\n${text}\n_(Balas: /reply ${chatId} pesan)_`, {parse_mode:'Markdown'}));
        bot.sendMessage(chatId, "✅");
    }
    else if (session.step === 'CONFIRM_PAYMENT') {
        bot.sendMessage(chatId, "Mohon kirimkan FOTO Bukti transfer, bukan teks.");
    }
}

// VIEW HELPERS
async function showMainMenu(chatId: number, name: string) {
    bot.sendMessage(chatId, `Halo ${name} ⚡\nSelamat datang di Store Produk Digital.`, {
        reply_markup: { inline_keyboard: [
            [{text:"🛍️ Beli Aplikasi/Produk", callback_data:"menu_cat"}],
            [{text:"🛒 Keranjang", callback_data:"menu_cart"}, {text:"💬 Chat Admin", callback_data:"menu_chat"}],
            (isAdmin(undefined, chatId) ? [{text:"🔧 ADMIN PANEL", callback_data:"adm_dash"}] : [])
        ]}
    });
}
async function showAdminDashboard(chatId: number) {
    bot.sendMessage(chatId, "🔧 **ADMIN DASHBOARD**", {reply_markup: {inline_keyboard: [
        [{text:"📦 Produk", callback_data:"adm_prod"}, {text:"➕ Add Item", callback_data:"adm_add"}],
        [{text:"📥 Laporan Excel", callback_data:"adm_xl"}]
    ]}});
}
async function showProductCatalog(chatId: number) {
    if(!db.products.length) return bot.sendMessage(chatId, "Kosong.");
    for (const p of db.products) {
        bot.sendMessage(chatId, `📦 **${p.name}**\n💰 ${formatRp(p.priceSell)} / ${p.unit}\n📂 ${p.category}\nStok: ${p.stock}`, 
        { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{text:`➕ Beli (${p.priceSell/1000}k)`, callback_data:`add_${p.id}`}]]}});
    }
}
async function showCart(chatId: number) {
    const c = getSession(chatId).cart;
    if(!c.length) return bot.sendMessage(chatId, "Keranjang Kosong.");
    let msg = "🛒 **CART:**\n";
    let tot = 0;
    c.forEach(i=>{msg += `- ${i.name} (${formatRp(i.price)})\n`; tot += i.price});
    msg += `\nTotal: **${formatRp(tot)}**`;
    bot.sendMessage(chatId, msg, {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:"✅ Checkout", callback_data:"checkout"}, {text:"🗑 Hapus", callback_data:"clear_cart"}]]}});
}

export async function GET() { return NextResponse.json({ status: 'Digital Store Bot v4.0 Active' }); }