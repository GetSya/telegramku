// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
import * as XLSX from 'xlsx';

// =======================================================
// KONFIGURASI ENGINE & SERVER
// =======================================================

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;
// GANTI USERNAME ADMIN DI SINI (Tanpa @)
const OWNER_USERNAME = 'sofunsyabi'; 

if (!token) throw new Error('TELEGRAM_BOT_TOKEN wajib ada');

const bot = new TelegramBot(token, { polling: false });

// =======================================================
// STRUKTUR DATABASE 
// =======================================================

type Product = {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  priceBuy: number;
  priceSell: number;
  stock: number;
};

type CartItem = {
  productId: string;
  name: string;
  price: number;
  qty: number;
};

type Order = {
  invoice: string;
  date: string;
  buyerName: string;
  buyerId: number;
  items: CartItem[];
  totalPrice: number;
  status: 'PENDING' | 'PAID' | 'SENT' | 'REJECTED';
  paymentProof?: string;
};

type UserSession = {
  step: 'IDLE' | 'ADD_PROD_NAME' | 'ADD_PROD_CAT' | 'ADD_PROD_UNIT' | 'ADD_PROD_BUY' | 'ADD_PROD_SELL' | 'ADD_PROD_STOCK' | 'CMD_KEY' | 'CMD_VAL' | 'CONFIRM_PAYMENT' | 'BROADCAST_MSG' | 'LIVE_CHAT' | 'EDIT_PRICE_VAL';
  temp: any;
  cart: CartItem[];
};

type DB = {
  company: { name: string; addr: string; email: string };
  admins: number[]; 
  products: Product[];
  orders: Order[];
  categories: string[];
  units: string[];
  customCommands: Record<string, string>;
  users: Record<number, UserSession>;
};

const globalForDB = global as unknown as { db: DB };
const db: DB = globalForDB.db || {
  company: { name: "Sofunsyabi Store", addr: "Jakarta, ID", email: "admin@bot.com" },
  admins: [], 
  categories: ["Makanan", "Minuman", "Jasa", "Digital"],
  units: ["PCS", "PACK", "BOX", "JAM"],
  products: [
    { id: "1", code: "P-001", name: "Premium Coffee", category: "Minuman", unit: "PCS", priceBuy: 5000, priceSell: 15000, stock: 50 },
    { id: "2", code: "J-002", name: "Jasa Desain", category: "Jasa", unit: "PROJECT", priceBuy: 0, priceSell: 50000, stock: 999 }
  ],
  orders: [],
  customCommands: { 
      "/about": "Bot Marketplace Canggih v2.1" 
  },
  users: {}
};
if (process.env.NODE_ENV !== 'production') globalForDB.db = db;

// =======================================================
// HELPER FUNCTIONS
// =======================================================

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const getSession = (chatId: number) => {
    if (!db.users[chatId]) db.users[chatId] = { step: 'IDLE', temp: {}, cart: [] };
    return db.users[chatId];
};
const isAdmin = (u?: string, id?: number) => (u === OWNER_USERNAME || (id && db.admins.includes(id)));
const resetSession = (s: UserSession) => { s.step = 'IDLE'; s.temp = {}; };

async function generateExcelReport() {
    const dataToExport = db.orders.map(o => ({
        Invoice: o.invoice,
        Tanggal: o.date,
        Pembeli: o.buyerName,
        Total: o.totalPrice,
        Status: o.status,
        Items: o.items.map(i => `${i.name} (${i.qty})`).join(', ')
    }));
    const worksheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// =======================================================
// MAIN HANDLER
// =======================================================

export async function POST(req: Request) {
    try {
        const update = await req.json();

        if (update.callback_query) {
            await handleCallback(update.callback_query);
        } else if (update.message) {
            if (update.message.text) await handleMessage(update.message);
            else if (update.message.photo) await handlePhoto(update.message);
        }
        return NextResponse.json({ status: 'ok' });
    } catch (e: any) {
        console.error("Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

async function handleMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const username = msg.from?.username;
    const session = getSession(chatId);

    // Auto Admin logic
    if (username === OWNER_USERNAME && !db.admins.includes(chatId)) db.admins.push(chatId);

    // 1. Cek Input Proses (Input Harga, Nama, dll)
    if (session.step !== 'IDLE') {
        await processInputSteps(chatId, text, session);
        return;
    }

    // 2. Custom Command
    const cmdKey = text.split(' ')[0];
    if (db.customCommands[cmdKey]) {
        await bot.sendMessage(chatId, `🤖 ${db.customCommands[cmdKey]}`);
        return;
    }

    // 3. Command Utama
    if (text === '/start' || text === '/menu') {
        await showMainMenu(chatId, msg.from?.first_name || 'Kak');
    }
    else if (text === '/admin') {
        if (isAdmin(username, chatId)) await showAdminDashboard(chatId);
        else await bot.sendMessage(chatId, "⛔ Menu khusus Admin.");
    }
    else {
        await bot.sendMessage(chatId, "💡 Ketik /menu untuk belanja atau /admin untuk panel admin.");
    }
}

async function handlePhoto(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const session = getSession(chatId);
    if (session.step === 'CONFIRM_PAYMENT') {
        const fileId = msg.photo ? msg.photo[msg.photo.length-1].file_id : 'Unknown';
        await finishCheckout(chatId, session, `FOTO BUKTI (FileID: ${fileId})`);
    }
}

async function handleCallback(query: TelegramBot.CallbackQuery) {
    const chatId = query.message?.chat.id!;
    const data = query.data!;
    const session = getSession(chatId);
    const username = query.from.username;

    // Bersihkan loading spinner di tombol
    try { await bot.answerCallbackQuery(query.id); } catch(e){}

    // === NAVIGATION MAIN MENU ===
    if (data === 'menu_catalog') await showProductCatalog(chatId);
    if (data === 'menu_cart') await showCart(chatId);
    if (data === 'menu_chat') {
        session.step = 'LIVE_CHAT';
        await bot.sendMessage(chatId, "💬 **LIVE CHAT**\n\nSilakan ketik pesan Anda. Admin akan membaca & membalas pesan Anda.\nKetik **BATAL** untuk selesai.", {parse_mode: 'Markdown'});
    }
    if (data === 'menu_info') {
         await bot.sendMessage(chatId, `🏢 **${db.company.name}**\n📍 ${db.company.addr}\n📧 ${db.company.email}`, {parse_mode: 'Markdown'});
    }

    // === CART & CHECKOUT ===
    if (data.startsWith('add_cart_')) {
        const pid = data.split('_')[2];
        const p = db.products.find(x => x.id === pid);
        if (p && p.stock > 0) {
            const exist = session.cart.find(c => c.productId === pid);
            if(exist) exist.qty++;
            else session.cart.push({ productId: pid, name: p.name, price: p.priceSell, qty: 1 });
            await bot.sendMessage(chatId, `✅ **${p.name}** masuk keranjang!`, {parse_mode:'Markdown'});
        } else {
            await bot.sendMessage(chatId, "❌ Stok habis.");
        }
    }
    if (data === 'checkout_start') {
        if (session.cart.length === 0) return bot.sendMessage(chatId, "Keranjang kosong.");
        session.step = 'CONFIRM_PAYMENT';
        const total = session.cart.reduce((a,b)=>a+(b.price*b.qty),0);
        await bot.sendMessage(chatId, `🧾 **TOTAL TAGIHAN: ${formatRp(total)}**\n\nSilakan transfer dan **KIRIM BUKTI (FOTO/TEXT)** disini sekarang.`, {parse_mode:'Markdown'});
    }
    if (data === 'cart_clear') {
        session.cart = [];
        await bot.sendMessage(chatId, "🗑️ Keranjang dikosongkan.");
    }

    // === ADMIN AREA ===
    if (!isAdmin(username, chatId)) return;

    if (data === 'adm_dash') await showAdminDashboard(chatId);
    if (data === 'adm_products') await showAdminProducts(chatId);
    if (data === 'adm_add_prod') {
        session.step = 'ADD_PROD_NAME';
        await bot.sendMessage(chatId, "🔤 Masukkan **NAMA ITEM**:", {parse_mode: 'Markdown'});
    }
    if (data === 'adm_export') {
        if (db.orders.length === 0) return bot.sendMessage(chatId, "Data Order Kosong.");
        await bot.sendMessage(chatId, "⏳ Membuat file Excel...");
        const buf = await generateExcelReport();
        await bot.sendDocument(chatId, buf, {}, { 
            filename: `Rekap_${Date.now()}.xlsx`, 
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
        });
    }
    if (data === 'adm_broadcast') {
        session.step = 'BROADCAST_MSG';
        await bot.sendMessage(chatId, "📢 Tulis pesan Broadcast:");
    }
    if (data.startsWith('adm_edit_')) {
        session.temp.editId = data.split('_')[2];
        session.step = 'EDIT_PRICE_VAL';
        await bot.sendMessage(chatId, "💰 Masukkan Harga Baru (Angka):");
    }
    if (data.startsWith('adm_del_')) {
        const pid = data.split('_')[2];
        db.products = db.products.filter(p => p.id !== pid);
        await bot.sendMessage(chatId, "✅ Produk dihapus.");
        await showAdminProducts(chatId);
    }
}

// === VIEW FUNCTIONS ===

async function showMainMenu(chatId: number, name: string) {
    const text = `Selamat datang, *${name}*! 👋\nSilakan pilih menu belanja di bawah ini:`;
    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🛍️ Lihat Produk", callback_data: "menu_catalog" }, { text: "🛒 Keranjang Saya", callback_data: "menu_cart" }],
                [{ text: "💬 Live Chat", callback_data: "menu_chat" }, { text: "🏢 Info Toko", callback_data: "menu_info" }],
                (isAdmin(undefined, chatId) ? [{ text: "🔧 ADMIN PANEL", callback_data: "adm_dash" }] : [])
            ]
        }
    });
}

async function showAdminDashboard(chatId: number) {
    await bot.sendMessage(chatId, `🔧 **ADMIN PANEL**\nUser: ${OWNER_USERNAME}\nTotal Orders: ${db.orders.length}`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📦 Daftar Produk & Edit", callback_data: "adm_products" }],
                [{ text: "➕ Tambah Produk Baru", callback_data: "adm_add_prod" }],
                [{ text: "📥 DOWNLOAD EXCEL", callback_data: "adm_export" }],
                [{ text: "📢 Broadcast Pesan", callback_data: "adm_broadcast" }]
            ]
        }
    });
}

async function showProductCatalog(chatId: number) {
    if (db.products.length === 0) return bot.sendMessage(chatId, "Produk Kosong.");
    for (const p of db.products) {
        await bot.sendMessage(chatId, `🏷️ **${p.name}**\n💰 ${formatRp(p.priceSell)}\n📦 Stok: ${p.stock}\n📂 ${p.category}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "➕ Masukkan Keranjang", callback_data: `add_cart_${p.id}` }]] }
        });
    }
}

async function showAdminProducts(chatId: number) {
    if (db.products.length === 0) return bot.sendMessage(chatId, "Produk Kosong.");
    for (const p of db.products) {
        await bot.sendMessage(chatId, `📦 ${p.name}\nStok: ${p.stock} | Hrg: ${formatRp(p.priceSell)}`, {
            reply_markup: { inline_keyboard: [[{ text: "✏️ Ubah Harga", callback_data: `adm_edit_${p.id}` }, { text: "❌ Hapus", callback_data: `adm_del_${p.id}` }]] }
        });
    }
}

async function showCart(chatId: number) {
    const cart = getSession(chatId).cart;
    if(cart.length === 0) return bot.sendMessage(chatId, "Keranjang Anda Kosong 😢");
    
    let msg = "🛒 **KERANJANG BELANJA**\n\n";
    let total = 0;
    cart.forEach((i, x) => {
        msg += `${x+1}. ${i.name} (${i.qty}) = ${formatRp(i.price*i.qty)}\n`;
        total += i.price*i.qty;
    });
    msg += `\n💵 **Total: ${formatRp(total)}**`;

    await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: "✅ CHECKOUT & BAYAR", callback_data: "checkout_start" }, { text: "🗑️ Hapus Semua", callback_data: "cart_clear" }]]
        }
    });
}

// === LOGIC PROCESS INPUT ===
async function processInputSteps(chatId: number, text: string, session: UserSession) {
    if(text.toLowerCase() === 'batal') {
        resetSession(session);
        return bot.sendMessage(chatId, "❌ Proses dibatalkan. Ketik /menu");
    }

    if (session.step === 'ADD_PROD_NAME') {
        session.temp.name = text; session.step = 'ADD_PROD_CAT';
        bot.sendMessage(chatId, "Ketik **KATEGORI** (Misal: Makanan/Jasa):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_CAT') {
        session.temp.cat = text; session.step = 'ADD_PROD_UNIT';
        bot.sendMessage(chatId, "Ketik **SATUAN** (Misal: PCS/PACK):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_UNIT') {
        session.temp.unit = text; session.step = 'ADD_PROD_BUY';
        bot.sendMessage(chatId, "Masukkan **HARGA MODAL** (Angka saja):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_BUY') {
        session.temp.buy = parseInt(text); session.step = 'ADD_PROD_SELL';
        bot.sendMessage(chatId, "Masukkan **HARGA JUAL** (Angka saja):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_SELL') {
        session.temp.sell = parseInt(text); session.step = 'ADD_PROD_STOCK';
        bot.sendMessage(chatId, "Masukkan **JUMLAH STOK** (Angka saja):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_STOCK') {
        db.products.push({
            id: Date.now().toString(),
            code: `P${Math.floor(Math.random()*900)}`,
            name: session.temp.name, category: session.temp.cat, unit: session.temp.unit,
            priceBuy: session.temp.buy, priceSell: session.temp.sell, stock: parseInt(text)
        });
        resetSession(session);
        await bot.sendMessage(chatId, "✅ Produk Tersimpan!");
        await showAdminDashboard(chatId);
    }
    else if (session.step === 'CONFIRM_PAYMENT') {
        await finishCheckout(chatId, session, text);
    }
    else if (session.step === 'BROADCAST_MSG') {
        Object.keys(db.users).forEach(uid => {
            bot.sendMessage(Number(uid), `📢 **PENGUMUMAN**\n\n${text}`, {parse_mode:'Markdown'}).catch(()=>{});
        });
        resetSession(session);
        bot.sendMessage(chatId, "Broadcast terkirim.");
    }
    else if (session.step === 'EDIT_PRICE_VAL') {
        const p = db.products.find(x => x.id === session.temp.editId);
        if(p) { p.priceSell = parseInt(text); bot.sendMessage(chatId, "✅ Harga update."); }
        resetSession(session);
    }
    else if (session.step === 'LIVE_CHAT') {
        db.admins.forEach(id => bot.sendMessage(id, `💬 **CHAT USER**\nDari: ${text}`).catch(()=>{}));
        bot.sendMessage(chatId, "✅ Terkirim ke Admin.");
    }
}

async function finishCheckout(chatId: number, session: UserSession, proof: string) {
    const total = session.cart.reduce((a,b)=>a+(b.price*b.qty),0);
    const invoice = `INV/${Date.now()}`;
    db.orders.push({
        invoice, date: new Date().toLocaleDateString(), buyerName: 'User', buyerId: chatId,
        items: [...session.cart], totalPrice: total, status: 'PENDING', paymentProof: proof
    });
    session.cart = [];
    session.step = 'IDLE';
    await bot.sendMessage(chatId, `✅ **Terima Kasih!**\nOrder No: ${invoice}\nStatus: Menunggu verifikasi admin.`);
    
    // Alert Admin
    db.admins.forEach(aid => {
        bot.sendMessage(aid, `🚨 **ORDER MASUK**\n${invoice}\n${formatRp(total)}\nBukti: ${proof}`, {parse_mode:'Markdown'});
    });
}

// 405 Handler
export async function GET() { return NextResponse.json({ status: 'Bot Active', dbProducts: db.products.length }); }