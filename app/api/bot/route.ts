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

if (!token) throw new Error('TELEGRAM_BOT_TOKEN wajib ada di Environment Variables');

const bot = new TelegramBot(token, { polling: false });

// =======================================================
// STRUKTUR DATABASE (IN-MEMORY / SIMULASI JSON)
// =======================================================

type Product = {
  id: string;
  code: string;
  name: string;
  category: string; // Jenis
  unit: string;     // Satuan (PCS, DUS)
  priceBuy: number; // Hpp
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
  paymentProof?: string; // Teks / File ID
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
  customCommands: Record<string, string>; // /promo -> "Diskon 50%"
  users: Record<number, UserSession>;
};

// SIMPAN DB DI GLOBAL AGAR TIDAK HILANG SAAT REFRESH DEVELOPMENT
const globalForDB = global as unknown as { db: DB };
const db: DB = globalForDB.db || {
  company: { name: "Sofunsyabi Store", addr: "Jakarta, ID", email: "admin@bot.com" },
  admins: [], 
  categories: ["Makanan", "Minuman", "Jasa"],
  units: ["PCS", "PACK", "BOX"],
  products: [
    { id: "1", code: "P-001", name: "Premium Coffee", category: "Minuman", unit: "PCS", priceBuy: 5000, priceSell: 15000, stock: 50 },
    { id: "2", code: "J-002", name: "Desain Banner", category: "Jasa", unit: "PCS", priceBuy: 0, priceSell: 50000, stock: 999 }
  ],
  orders: [],
  customCommands: { 
      "/about": "Bot Marketplace Canggih v2.0 - Developed with Next.js",
      "/faq": "Cara pesan: Pilih menu > Klik Item > Checkout" 
  },
  users: {}
};
if (process.env.NODE_ENV !== 'production') globalForDB.db = db;

// =======================================================
// HELPER FUNCTIONS (UTILITIES)
// =======================================================

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const getSession = (chatId: number) => {
    if (!db.users[chatId]) db.users[chatId] = { step: 'IDLE', temp: {}, cart: [] };
    return db.users[chatId];
};
const isAdmin = (u?: string, id?: number) => (u === OWNER_USERNAME || (id && db.admins.includes(id)));
const resetSession = (s: UserSession) => { s.step = 'IDLE'; s.temp = {}; };

// FUNGSI SUPER: EXPORT KE EXCEL (BUFFER)
async function generateExcelReport() {
    const dataToExport = db.orders.map(o => ({
        Invoice: o.invoice,
        Tanggal: o.date,
        Pembeli: o.buyerName,
        Status: o.status,
        Total: o.totalPrice,
        Items: o.items.map(i => `${i.name} (${i.qty})`).join(', ')
    }));

    // Membuat Worksheet & Workbook
    const worksheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan Penjualan");

    // Menghasilkan Buffer
    const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return buf;
}

// =======================================================
// MAIN LOGIC (HANDLER POST)
// =======================================================

export async function POST(req: Request) {
    try {
        const update = await req.json();

        // 1. Handle Callback Button (Navigasi Menu)
        if (update.callback_query) {
            await handleCallback(update.callback_query);
        }
        
        // 2. Handle Text Message
        else if (update.message && update.message.text) {
            await handleMessage(update.message);
        }
        // 3. Handle Photo (Bukti Transfer)
        else if (update.message && update.message.photo) {
             await handlePhoto(update.message);
        }

        return NextResponse.json({ status: 'ok' });
    } catch (e: any) {
        console.error("Critical Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

// --- MESSAGE HANDLER (LOGIC) ---
async function handleMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const username = msg.from?.username;
    const session = getSession(chatId);

    // AUTO ADMIN ACCESS (Owner only)
    if (username === OWNER_USERNAME && !db.admins.includes(chatId)) {
        db.admins.push(chatId);
    }

    // A. DETEKSI CUSTOM COMMAND (Dibuat Dinamis)
    // Cek apakah user mengetik command yang ada di database custom
    const cleanCmd = text.split(' ')[0]; // Ambil kata pertama
    if (db.customCommands[cleanCmd]) {
        await bot.sendMessage(chatId, `🤖 ${db.customCommands[cleanCmd]}`);
        return;
    }

    // B. PROSES INPUT USER (STATE MACHINE)
    if (session.step !== 'IDLE') {
        await processInputSteps(chatId, text, session);
        return;
    }

    // C. MENU UTAMA
    switch (text) {
        case '/start':
            const greet = `Selamat Datang, ${msg.from?.first_name}! 🛍️\n\nSelamat berbelanja di *${db.company.name}*.\nGunakan menu di bawah ini:`;
            await bot.sendMessage(chatId, greet, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [
                        [{ text: '🛍️ Katalog Produk' }, { text: '🛒 Cek Keranjang' }],
                        [{ text: '📞 Chat Admin' }, { text: '🏢 Tentang Kami' }]
                    ],
                    resize_keyboard: true
                }
            });
            break;

        case '🛍️ Katalog Produk':
            await showProductCatalog(chatId);
            break;

        case '🛒 Cek Keranjang':
            await showCart(chatId);
            break;

        case '📞 Chat Admin':
            session.step = 'LIVE_CHAT';
            await bot.sendMessage(chatId, "💬 *MODE LIVE CHAT*\n\nSilakan ketik pesan/laporan bug Anda. Semua pesan akan diteruskan ke Admin.\nKetik 'BATAL' untuk keluar.", { parse_mode: 'Markdown' });
            break;

        case '🏢 Tentang Kami':
            await bot.sendMessage(chatId, `🏢 *INFO PERUSAHAAN*\n\nNama: ${db.company.name}\nAlamat: ${db.company.addr}\nEmail: ${db.company.email}\nBot Version: 2.0 Pro`, {parse_mode: 'Markdown'});
            break;

        case '/admin':
            if (isAdmin(username, chatId)) await showAdminDashboard(chatId);
            else await bot.sendMessage(chatId, "⛔ Akses Ditolak. Halaman ini hanya untuk Staff.");
            break;

        default:
            if(!isAdmin(username, chatId)) await bot.sendMessage(chatId, "❓ Perintah tidak dikenal. Gunakan menu tombol dibawah.");
    }
}

async function handlePhoto(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    if (session.step === 'CONFIRM_PAYMENT') {
        const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : 'No-File';
        await finishCheckout(chatId, session, `FOTO BUKTI ID: ${photoId}`);
    }
}

// --- CALLBACK QUERY HANDLER (BUTTONS) ---
async function handleCallback(query: TelegramBot.CallbackQuery) {
    const chatId = query.message?.chat.id!;
    const data = query.data!;
    const session = getSession(chatId);
    
    // Clear loading state
    try { await bot.answerCallbackQuery(query.id); } catch(e){}

    // --- AREA USER ---
    if (data.startsWith('add_cart_')) {
        const pid = data.split('_')[2];
        const product = db.products.find(p => p.id === pid);
        if (product && product.stock > 0) {
            const item = session.cart.find(c => c.productId === pid);
            if (item) item.qty++;
            else session.cart.push({ productId: pid, name: product.name, price: product.priceSell, qty: 1 });
            
            await bot.sendMessage(chatId, `✅ *${product.name}* ditambahkan ke keranjang!`, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, "❌ Stok habis kak.");
        }
    }
    
    if (data === 'checkout_start') {
        if(session.cart.length === 0) return bot.sendMessage(chatId, "Keranjang kosong.");
        session.step = 'CONFIRM_PAYMENT';
        const total = session.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        await bot.sendMessage(chatId, `🧾 *CHECKOUT CONFIRMATION*\n\nTotal: *${formatRp(total)}*\n\nSilakan transfer ke BCA 123456 (PT Bot).\n\n📷 **Kirim BUKTI TRANSFER (Foto/Teks) sekarang:**`, {parse_mode: 'Markdown'});
    }
    
    if (data === 'cart_clear') {
        session.cart = [];
        await bot.editMessageText("🗑️ Keranjang telah dikosongkan.", { chat_id: chatId, message_id: query.message?.message_id });
    }

    // --- AREA ADMIN ---
    if (!isAdmin(query.from.username, chatId)) return;

    if (data === 'adm_products') await showAdminProducts(chatId);
    if (data === 'adm_add_prod') {
        session.step = 'ADD_PROD_NAME';
        await bot.sendMessage(chatId, "🔤 Masukkan **NAMA ITEM**:", { parse_mode: 'Markdown'});
    }
    
    // EXPORT EXCEL
    if (data === 'adm_export') {
        if(db.orders.length === 0) return bot.sendMessage(chatId, "Data Order Kosong.");
        await bot.sendMessage(chatId, "⏳ Sedang meng-convert data ke Excel...");
        const buffer = await generateExcelReport();
        await bot.sendDocument(chatId, buffer, {}, {
            filename: `Laporan_Penjualan_${Date.now()}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
    }

    // EDIT PRICE
    if (data.startsWith('adm_edit_')) {
        const pid = data.split('_')[2];
        session.temp.editId = pid;
        session.step = 'EDIT_PRICE_VAL';
        await bot.sendMessage(chatId, "💰 Masukkan **HARGA BARU** (Angka saja):", { parse_mode: 'Markdown'});
    }
    
    // NEW COMMAND
    if (data === 'adm_new_cmd') {
        session.step = 'CMD_KEY';
        await bot.sendMessage(chatId, "🔤 Masukkan trigger command (Wajib pakai /, contoh: /promo):");
    }

    // BROADCAST
    if (data === 'adm_broadcast') {
        session.step = 'BROADCAST_MSG';
        await bot.sendMessage(chatId, "📢 Tulis pesan BROADCAST untuk semua user:");
    }
}

// --- STATE MACHINE PROCESSOR ---
async function processInputSteps(chatId: number, text: string, session: UserSession) {
    if (text.toUpperCase() === 'BATAL') {
        resetSession(session);
        await bot.sendMessage(chatId, "🚫 Proses dibatalkan.");
        return;
    }

    // 1. ADD PRODUCT FLOW
    if (session.step === 'ADD_PROD_NAME') {
        session.temp.name = text;
        session.step = 'ADD_PROD_CAT';
        // Tampilkan pilihan kategori biar gampang (logic simplified: text input)
        await bot.sendMessage(chatId, `📂 Masukkan JENIS/KATEGORI (Pilih: ${db.categories.join(', ')}):`);
    }
    else if (session.step === 'ADD_PROD_CAT') {
        session.temp.cat = text;
        session.step = 'ADD_PROD_UNIT';
        await bot.sendMessage(chatId, `📦 Masukkan SATUAN (Pilih: ${db.units.join(', ')}):`);
    }
    else if (session.step === 'ADD_PROD_UNIT') {
        session.temp.unit = text;
        session.step = 'ADD_PROD_BUY';
        await bot.sendMessage(chatId, "📉 Masukkan HARGA MODAL (Angka):");
    }
    else if (session.step === 'ADD_PROD_BUY') {
        session.temp.buy = parseInt(text);
        session.step = 'ADD_PROD_SELL';
        await bot.sendMessage(chatId, "📈 Masukkan HARGA JUAL (Angka):");
    }
    else if (session.step === 'ADD_PROD_SELL') {
        session.temp.sell = parseInt(text);
        session.step = 'ADD_PROD_STOCK';
        await bot.sendMessage(chatId, "🔢 Masukkan STOK AWAL (Angka):");
    }
    else if (session.step === 'ADD_PROD_STOCK') {
        const newProd: Product = {
            id: Date.now().toString(),
            code: `ITM-${Math.floor(Math.random()*9000)+1000}`,
            name: session.temp.name,
            category: session.temp.cat,
            unit: session.temp.unit,
            priceBuy: session.temp.buy,
            priceSell: session.temp.sell,
            stock: parseInt(text)
        };
        db.products.push(newProd);
        resetSession(session);
        await bot.sendMessage(chatId, `✅ Produk **${newProd.name}** berhasil ditambah!\nKode: ${newProd.code}`, {parse_mode: 'Markdown'});
    }

    // 2. CHECKOUT PAYMENT FLOW
    else if (session.step === 'CONFIRM_PAYMENT') {
        await finishCheckout(chatId, session, text); // Text dianggap bukti jika user malas upload foto
    }

    // 3. ADD CUSTOM COMMAND
    else if (session.step === 'CMD_KEY') {
        if (!text.startsWith('/')) return bot.sendMessage(chatId, "❌ Command harus dimulai dengan /");
        session.temp.key = text;
        session.step = 'CMD_VAL';
        await bot.sendMessage(chatId, `✅ Command ${text} dicatat.\nSekarang masukkan RESPON BALASANNYA:`);
    }
    else if (session.step === 'CMD_VAL') {
        db.customCommands[session.temp.key] = text;
        resetSession(session);
        await bot.sendMessage(chatId, "✅ Command Custom Disimpan!");
    }

    // 4. BROADCAST
    else if (session.step === 'BROADCAST_MSG') {
        // Dummy implementation for list user (because users in DB is Record not Array, need extract keys)
        const userIds = Object.keys(db.users);
        let count = 0;
        userIds.forEach(uid => {
            bot.sendMessage(Number(uid), `📢 **INFORMASI**\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{});
            count++;
        });
        resetSession(session);
        await bot.sendMessage(chatId, `✅ Broadcast dikirim ke ${count} user.`);
    }

    // 5. LIVE CHAT
    else if (session.step === 'LIVE_CHAT') {
        const fromName = getSession(chatId).temp.username || 'User';
        const msgAdmin = `📩 *PESAN LIVE CHAT*\nDari: ID ${chatId}\nPesan: ${text}\n\n_Untuk membalas, kirim pesan manual ke ID tersebut._`;
        db.admins.forEach(aid => bot.sendMessage(aid, msgAdmin, { parse_mode: 'Markdown'}));
        await bot.sendMessage(chatId, "✅ Terkirim ke Admin.");
        // Session tidak di reset agar bisa chat terus, user harus ketik BATAL untuk keluar
    }

    // 6. EDIT PRICE
    else if (session.step === 'EDIT_PRICE_VAL') {
        const p = db.products.find(x => x.id === session.temp.editId);
        if(p) {
            p.priceSell = parseInt(text);
            await bot.sendMessage(chatId, `✅ Harga ${p.name} diupdate jadi ${formatRp(p.priceSell)}`);
        }
        resetSession(session);
    }
}

// --- FUNGSI TAMBAHAN (VIEW CONTROLLERS) ---

async function finishCheckout(chatId: number, session: UserSession, proof: string) {
    const total = session.cart.reduce((s, i) => s + (i.price * i.qty), 0);
    const invoice = `INV/${Date.now()}`;
    
    // Simpan Order
    db.orders.push({
        invoice,
        date: new Date().toLocaleDateString(),
        buyerName: "User Telegram", // Idealnya ambil dari msg context
        buyerId: chatId,
        items: [...session.cart],
        totalPrice: total,
        status: 'PENDING',
        paymentProof: proof
    });

    // Kurangi Stok Real
    session.cart.forEach(c => {
        const p = db.products.find(x => x.id === c.productId);
        if (p) p.stock = Math.max(0, p.stock - c.qty);
    });

    // Notif ke User
    await bot.sendMessage(chatId, `✅ **PESANAN DITERIMA!**\nID Invoice: ${invoice}\nStatus: Menunggu Konfirmasi Admin.\n\nTerima kasih sudah berbelanja.`, { parse_mode: 'Markdown'});
    
    // Notif ke Admin
    const itemsList = session.cart.map(i => `${i.name} (${i.qty})`).join(', ');
    const msgAdm = `🚨 **ORDER BARU MASUK!**\nInv: ${invoice}\nItem: ${itemsList}\nTotal: ${formatRp(total)}\nBukti: ${proof}`;
    db.admins.forEach(aid => bot.sendMessage(aid, msgAdm, { parse_mode: 'Markdown'}));

    session.cart = []; // Reset keranjang
    session.step = 'IDLE';
}

async function showAdminDashboard(chatId: number) {
    const keyboard = {
        inline_keyboard: [
            [{ text: "📦 Atur Produk", callback_data: "adm_products" }, { text: "➕ Tambah Item", callback_data: "adm_add_prod" }],
            [{ text: "📝 Data Command", callback_data: "adm_new_cmd" }, { text: "📢 Broadcast", callback_data: "adm_broadcast" }],
            [{ text: "📥 DOWNLOAD LAPORAN EXCEL", callback_data: "adm_export" }]
        ]
    };
    const stats = `
🔐 **PANEL ADMIN**
👤 Admin: ${OWNER_USERNAME}

📊 **Statistik Cepat:**
📦 Total Produk: ${db.products.length}
💰 Total Transaksi: ${db.orders.length}
👥 Total User Aktif: ${Object.keys(db.users).length}
    `;
    await bot.sendMessage(chatId, stats, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showProductCatalog(chatId: number) {
    if (db.products.length === 0) return bot.sendMessage(chatId, "Belum ada produk.");
    
    // Membuat List Cantik
    for (const p of db.products) {
        const btn = { inline_keyboard: [[{ text: `➕ Beli ${p.name}`, callback_data: `add_cart_${p.id}` }]] };
        const desc = `🍱 *${p.name}* (Kode: ${p.code})\nJenis: ${p.category} | Satuan: ${p.unit}\n💰 Harga: *${formatRp(p.priceSell)}*\n📦 Sisa Stok: ${p.stock}`;
        await bot.sendMessage(chatId, desc, { parse_mode: 'Markdown', reply_markup: btn });
    }
}

async function showAdminProducts(chatId: number) {
    if (db.products.length === 0) return bot.sendMessage(chatId, "Produk kosong.");
    for (const p of db.products) {
        const btn = { inline_keyboard: [[{ text: `✏️ Edit Harga`, callback_data: `adm_edit_${p.id}` }, { text: `❌ Hapus`, callback_data: `adm_del_${p.id}` }]] };
        await bot.sendMessage(chatId, `${p.name} - Stok: ${p.stock}`, { reply_markup: btn });
    }
}

async function showCart(chatId: number) {
    const s = getSession(chatId);
    if(s.cart.length === 0) return bot.sendMessage(chatId, "🛒 Keranjang kamu kosong.");

    let msg = "🛒 **KERANJANG SAYA**\n\n";
    let total = 0;
    s.cart.forEach((i, idx) => {
        const sub = i.price * i.qty;
        total += sub;
        msg += `${idx+1}. ${i.name}\n   ${i.qty} x ${formatRp(i.price)} = *${formatRp(sub)}*\n`;
    });
    msg += `\n💵 **TOTAL: ${formatRp(total)}**`;

    await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ CHECKOUT & BAYAR", callback_data: "checkout_start" }],
                [{ text: "❌ Kosongkan Keranjang", callback_data: "cart_clear" }]
            ]
        }
    });
}

// 405 Handler browser
export async function GET() {
  return NextResponse.json({ status: 'Bot PRO Version Active with Excel Support 🚀' });
}