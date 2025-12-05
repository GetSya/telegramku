// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
import * as XLSX from 'xlsx';

// =======================================================
// 1. SETUP ENGINE
// =======================================================

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_USERNAME = 'sofunsyabi'; // GANTI username admin tanpa @

if (!token) throw new Error('TELEGRAM_BOT_TOKEN wajib ada');

const bot = new TelegramBot(token, { polling: false });

// =======================================================
// 2. DATA STRUKTUR (DATABASE)
// =======================================================

type Product = {
  id: string;
  code: string;
  name: string;
  description: string; // <-- ITEM BARU: DESKRIPSI
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

// Langkah State Machine ditambah: ADD_PROD_DESC
type UserSession = {
  step: 'IDLE' | 'ADD_PROD_NAME' | 'ADD_PROD_DESC' | 'ADD_PROD_CAT' | 'ADD_PROD_UNIT' | 'ADD_PROD_BUY' | 'ADD_PROD_SELL' | 'ADD_PROD_STOCK' | 'CMD_KEY' | 'CMD_VAL' | 'CONFIRM_PAYMENT' | 'BROADCAST_MSG' | 'LIVE_CHAT' | 'EDIT_PRICE_VAL';
  temp: any;
  cart: CartItem[];
  msgId?: number; // Menyimpan ID pesan terakhir agar bisa dihapus/edit (UI lebih bersih)
};

type DB = {
  company: { name: string; addr: string; email: string };
  admins: number[]; 
  products: Product[];
  orders: Order[];
  customCommands: Record<string, string>;
  users: Record<number, UserSession>;
};

const globalForDB = global as unknown as { db: DB };
const db: DB = globalForDB.db || {
  company: { name: "Sofunsyabi Store", addr: "Jakarta, Indonesia", email: "admin@store.id" },
  admins: [], 
  products: [
    { 
        id: "1", code: "KOPI01", name: "Kopi Gula Aren", 
        description: "Kopi susu dengan gula aren asli, disajikan dingin. Tahan 2 hari di kulkas.", // Deskripsi dummy
        category: "Minuman", unit: "CUP", priceBuy: 5000, priceSell: 18000, stock: 50 
    }
  ],
  orders: [],
  customCommands: { "/help": "Gunakan tombol menu di bawah." },
  users: {}
};
if (process.env.NODE_ENV !== 'production') globalForDB.db = db;

// =======================================================
// 3. HELPERS
// =======================================================

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const getSession = (chatId: number) => {
    if (!db.users[chatId]) db.users[chatId] = { step: 'IDLE', temp: {}, cart: [] };
    return db.users[chatId];
};
const isAdmin = (u?: string, id?: number) => (u === OWNER_USERNAME || (id && db.admins.includes(id)));
const resetSession = (s: UserSession) => { s.step = 'IDLE'; s.temp = {}; };

async function generateExcel() {
    const data = db.orders.map(o => ({
        Invoice: o.invoice, Date: o.date, Buyer: o.buyerName, 
        Items: o.items.map(i=>`${i.name}(${i.qty})`).join(', '),
        Total: o.totalPrice, Status: o.status
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Sales");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// =======================================================
// 4. HANDLER UTAMA
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
        console.error(e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

// =======================================================
// 5. LOGIC MESSAGE
// =======================================================

async function handleMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const username = msg.from?.username;
    const session = getSession(chatId);

    if (username === OWNER_USERNAME && !db.admins.includes(chatId)) db.admins.push(chatId);

    // 1. INPUT STEP (ADMIN ADD PRODUCT / USER CHECKOUT)
    if (session.step !== 'IDLE') {
        await processInput(chatId, text, session);
        return;
    }

    // 2. MAIN MENU
    if (text === '/start' || text === '/menu') {
        await showMainMenu(chatId, msg.from?.first_name || 'Kak');
    }
    else if (text === '/admin') {
        if(isAdmin(username, chatId)) await showAdminDashboard(chatId);
        else bot.sendMessage(chatId, "⛔ Anda bukan Admin.");
    }
    else {
        // Cek custom command
        const key = text.split(' ')[0];
        if (db.customCommands[key]) await bot.sendMessage(chatId, db.customCommands[key]);
        else await bot.sendMessage(chatId, "Silakan pilih menu.", {reply_markup:{inline_keyboard:[[{text:"🛍️ Menu Belanja", callback_data:"menu_catalog"}]]}});
    }
}

async function handlePhoto(msg: TelegramBot.Message) {
    const session = getSession(msg.chat.id);
    if (session.step === 'CONFIRM_PAYMENT') {
        const fid = msg.photo ? msg.photo[msg.photo.length-1].file_id : 'xx';
        await finishCheckout(msg.chat.id, session, fid, msg.from?.first_name || 'User');
    }
}

// =======================================================
// 6. LOGIC BUTTON (CALLBACK) - UI NAVIGATION
// =======================================================

async function handleCallback(q: TelegramBot.CallbackQuery) {
    const chatId = q.message?.chat.id!;
    const msgId = q.message?.message_id; // Kita pakai ini untuk edit message agar rapi
    const data = q.data!;
    const session = getSession(chatId);
    
    try { await bot.answerCallbackQuery(q.id); } catch(e){}

    // A. MENU & CATALOG UI (USER)
    if (data === 'menu_catalog') await showCatalogList(chatId, msgId); // Ganti dari showProductCatalog ke showCatalogList
    if (data === 'menu_cart') await showCart(chatId, msgId);
    if (data === 'menu_main') await bot.deleteMessage(chatId, msgId!).then(() => showMainMenu(chatId, "Kak"));

    // B. DETAIL PRODUK VIEW (USER)
    if (data.startsWith('view_p_')) {
        const pid = data.replace('view_p_', '');
        await showProductDetail(chatId, pid, msgId);
    }

    // C. ADD TO CART
    if (data.startsWith('add_c_')) {
        const pid = data.replace('add_c_', '');
        const p = db.products.find(x => x.id === pid);
        if (p && p.stock > 0) {
            const ex = session.cart.find(c => c.productId === pid);
            if(ex) ex.qty++; else session.cart.push({ productId: pid, name: p.name, price: p.priceSell, qty: 1 });
            // Alert kecil muncul di layar user
            await bot.answerCallbackQuery(q.id, { text: `✅ ${p.name} (+1) masuk keranjang!` }); 
        } else {
            await bot.answerCallbackQuery(q.id, { text: `❌ Stok Habis!`, show_alert: true });
        }
    }

    // D. CHECKOUT SYSTEM
    if (data === 'checkout_start') {
        if(session.cart.length===0) return bot.answerCallbackQuery(q.id, { text: "Keranjang kosong!", show_alert:true});
        session.step = 'CONFIRM_PAYMENT';
        const total = session.cart.reduce((a,b)=>a+(b.price*b.qty),0);
        await bot.sendMessage(chatId, `🧾 **TOTAL BAYAR: ${formatRp(total)}**\n\nNomor Rekening:\nBCA 1234567890 (Toko Bot)\n\nSilakan kirimkan **FOTO BUKTI** atau Tulis 'Sudah'.`, {parse_mode:'Markdown'});
    }
    if (data === 'cart_clear') { session.cart = []; await showCart(chatId, msgId); }

    // E. ADMIN AREA
    if (!isAdmin(q.from.username, chatId)) return;
    
    // Verifikasi Pembayaran
    if (data.startsWith('v_acc_')) await processOrder(data.replace('v_acc_', ''), 'PAID', chatId, msgId!);
    if (data.startsWith('v_rej_')) await processOrder(data.replace('v_rej_', ''), 'REJECTED', chatId, msgId!);

    if (data === 'adm_add') {
        session.step = 'ADD_PROD_NAME';
        await bot.sendMessage(chatId, "1. Masukkan **NAMA PRODUK**:", {parse_mode:'Markdown'});
    }
    if (data === 'adm_list') await showAdminList(chatId);
    if (data === 'adm_xl') {
        await bot.sendDocument(chatId, await generateExcel(), {}, { filename:'Rekap.xlsx', contentType: 'application/xlsx'});
    }
}

// =======================================================
// 7. INPUT PROCESSOR (STATE MACHINE)
// =======================================================

async function processInput(chatId: number, text: string, session: UserSession) {
    if(text.toLowerCase() === 'batal') { resetSession(session); return bot.sendMessage(chatId, "Batal."); }

    // FLOW TAMBAH PRODUK BARU
    if (session.step === 'ADD_PROD_NAME') {
        session.temp.name = text; 
        session.step = 'ADD_PROD_DESC'; // <-- FLOW BARU
        await bot.sendMessage(chatId, "2. Masukkan **DESKRIPSI PRODUK** (Penjelasan singkat, kondisi, dll):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_DESC') {
        session.temp.desc = text; 
        session.step = 'ADD_PROD_CAT';
        await bot.sendMessage(chatId, "3. Masukkan **KATEGORI** (cth: Makanan):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_CAT') {
        session.temp.cat = text; 
        session.step = 'ADD_PROD_UNIT';
        await bot.sendMessage(chatId, "4. Masukkan **SATUAN** (cth: PCS):", {parse_mode:'Markdown'});
    }
    else if (session.step === 'ADD_PROD_UNIT') {
        session.temp.unit = text; 
        session.step = 'ADD_PROD_BUY';
        await bot.sendMessage(chatId, "5. Masukkan **HARGA MODAL** (Angka):");
    }
    else if (session.step === 'ADD_PROD_BUY') {
        session.temp.buy = parseInt(text); 
        session.step = 'ADD_PROD_SELL';
        await bot.sendMessage(chatId, "6. Masukkan **HARGA JUAL** (Angka):");
    }
    else if (session.step === 'ADD_PROD_SELL') {
        session.temp.sell = parseInt(text); 
        session.step = 'ADD_PROD_STOCK';
        await bot.sendMessage(chatId, "7. Masukkan **STOK AWAL** (Angka):");
    }
    else if (session.step === 'ADD_PROD_STOCK') {
        db.products.push({
            id: Date.now().toString(), code: `ITM${Date.now()}`,
            name: session.temp.name, 
            description: session.temp.desc, // Simpan Deskripsi
            category: session.temp.cat, unit: session.temp.unit,
            priceBuy: session.temp.buy, priceSell: session.temp.sell, 
            stock: parseInt(text)
        });
        resetSession(session);
        await bot.sendMessage(chatId, "✅ Produk Berhasil Disimpan!");
    }
    // FLOW USER CHECKOUT
    else if (session.step === 'CONFIRM_PAYMENT') {
        await finishCheckout(chatId, session, text, 'User');
    }
    // LIVE CHAT
    else if (session.step === 'LIVE_CHAT') {
        db.admins.forEach(id => bot.sendMessage(id, `💬 User: ${text}`));
        bot.sendMessage(chatId, "Terkirim.");
    }
}

// =======================================================
// 8. UI FUNCTIONS (DISPLAYS) - PERUBAHAN TAMPILAN
// =======================================================

async function showMainMenu(chatId: number, name: string) {
    const text = `Halo *${name}*! 👋 Selamat datang di ${db.company.name}.\nSilakan pilih menu:`;
    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🛍️ Katalog Produk", callback_data: "menu_catalog" }, { text: "🛒 Keranjang Saya", callback_data: "menu_cart" }],
                [{ text: "📞 Hubungi Admin", callback_data: "menu_chat" }],
                (isAdmin(undefined, chatId) ? [{text: "🔧 PANEL ADMIN", callback_data: "adm_list"}] : [])
            ]
        }
    });
}

// TAMPILAN DAFTAR PRODUK BERUPA TOMBOL GRID
async function showCatalogList(chatId: number, msgIdToEdit?: number) {
    if(db.products.length === 0) return bot.sendMessage(chatId, "⚠️ Belum ada produk.");

    // Buat Grid Tombol 2 Kolom
    const productButtons = [];
    const products = [...db.products];
    
    while (products.length > 0) {
        const row = products.splice(0, 2); // Ambil 2 produk per baris
        productButtons.push(
            row.map(p => ({ text: p.name, callback_data: `view_p_${p.id}` }))
        );
    }
    // Tambah tombol navigasi bawah
    productButtons.push([{text: "⬅️ Menu Utama", callback_data: "menu_main"}, {text: "🛒 Lihat Keranjang", callback_data: "menu_cart"}]);

    const options: any = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: productButtons } };
    
    // Jika bisa diedit (transisi lebih mulus)
    if (msgIdToEdit) {
        try {
            await bot.editMessageText("🛍️ **PILIH KATEGORI / PRODUK**\nKlik nama item untuk lihat deskripsi & detail:", {
                chat_id: chatId, message_id: msgIdToEdit, ...options
            });
            return;
        } catch(e) {} // Fallback jika gagal edit (biasanya karena pesan terlalu lama)
    } 
    
    await bot.sendMessage(chatId, "🛍️ **PILIH KATEGORI / PRODUK**\nKlik nama item untuk lihat deskripsi & detail:", options);
}

// TAMPILAN DETAIL PRODUK + DESKRIPSI
async function showProductDetail(chatId: number, pid: string, msgIdToEdit?: number) {
    const p = db.products.find(x => x.id === pid);
    if (!p) return;

    // Teks Deskripsi dibuat tebal dan rapi
    const caption = `📦 **${p.name.toUpperCase()}**\n\n📝 **Deskripsi:**\n_${p.description}_\n\n🏷 Jenis: ${p.category}\n💰 Harga: **${formatRp(p.priceSell)}**\n📦 Sisa Stok: ${p.stock} ${p.unit}`;

    const kb = {
        inline_keyboard: [
            [{ text: "🛒 TAMBAH KE KERANJANG", callback_data: `add_c_${p.id}` }],
            [{ text: "⬅️ Kembali ke Katalog", callback_data: "menu_catalog" }, { text: "Bayar 💳", callback_data: "menu_cart" }]
        ]
    };

    if (msgIdToEdit) {
         try {
            await bot.editMessageText(caption, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown', reply_markup: kb });
            return;
         } catch(e) {}
    }
    await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: kb });
}

async function showCart(chatId: number, msgId?: number) {
    const cart = getSession(chatId).cart;
    let msg = cart.length ? "🛒 **ISI KERANJANG**\n\n" : "🛒 **Keranjang Kosong**";
    let total = 0;
    cart.forEach(i => { msg += `• ${i.name} (${i.qty}) = ${formatRp(i.qty*i.price)}\n`; total += i.qty*i.price; });
    msg += cart.length ? `\n💰 **TOTAL: ${formatRp(total)}**` : "";

    const btn = cart.length ? [[{ text: "✅ CHECKOUT SEKARANG", callback_data: "checkout_start" }, {text:"🗑 Kosongkan", callback_data:"cart_clear"}]] : [];
    btn.push([{text:"⬅️ Belanja Lagi", callback_data:"menu_catalog"}, {text:"🏠 Home", callback_data:"menu_main"}]);

    if(msgId) try { await bot.editMessageText(msg, {chat_id: chatId, message_id: msgId, parse_mode:'Markdown', reply_markup:{inline_keyboard:btn}}); return; } catch(e){}
    await bot.sendMessage(chatId, msg, {parse_mode:'Markdown', reply_markup:{inline_keyboard:btn}});
}

// =======================================================
// 9. LOGIC ORDER ADMIN
// =======================================================

async function finishCheckout(chatId: number, session: UserSession, proof: string, buyerName: string) {
    const total = session.cart.reduce((a,b)=>a+(b.price*b.qty),0);
    const invoice = `INV${Date.now()}`; // Short Invoice ID

    db.orders.push({
        invoice, date: new Date().toLocaleDateString(), buyerName, buyerId: chatId,
        items: [...session.cart], totalPrice: total, status: 'PENDING', paymentProof: proof
    });

    session.cart.forEach(c => { const p = db.products.find(x => x.id === c.productId); if(p) p.stock -= c.qty; });
    session.cart = []; session.step = 'IDLE';

    await bot.sendMessage(chatId, `✅ Pesanan **${invoice}** Diterima!\nMohon tunggu verifikasi admin.`);

    // NOTIF ADMIN
    const notif = `🔔 **ORDER BARU**\n${invoice}\nBuyer: ${buyerName}\nTotal: ${formatRp(total)}`;
    const kb = { inline_keyboard: [[{text:"✅ TERIMA", callback_data:`v_acc_${invoice}`}, {text:"❌ TOLAK", callback_data:`v_rej_${invoice}`}]]};
    
    db.admins.forEach(id => {
        if (proof.length > 50) bot.sendPhoto(id, proof, {caption: notif, parse_mode:'Markdown', reply_markup: kb}).catch(()=>{});
        else bot.sendMessage(id, `${notif}\nBukti: ${proof}`, {parse_mode:'Markdown', reply_markup: kb}).catch(()=>{});
    });
}

async function processOrder(inv: string, status: 'PAID'|'REJECTED', adminId: number, msgId: number) {
    const o = db.orders.find(x => x.invoice === inv);
    if (!o) return bot.sendMessage(adminId, "Order tidak ditemukan.");
    if (o.status !== 'PENDING') return bot.sendMessage(adminId, "Order sudah diproses sebelumnya.");

    o.status = status;
    const isPaid = status === 'PAID';
    
    // Feedback ke Admin
    await bot.editMessageCaption(
        `${isPaid ? '✅' : '❌'} **${status}** | ${o.invoice} | ${o.buyerName}`, 
        { chat_id: adminId, message_id: msgId, parse_mode: 'Markdown' }
    ).catch(() => bot.sendMessage(adminId, `Order ${inv} status: ${status}`));

    // Notif ke Buyer
    if (!isPaid) {
        // Balikin stok
        o.items.forEach(i => { const p = db.products.find(x => x.id === i.productId); if(p) p.stock += i.qty; });
        bot.sendMessage(o.buyerId, `❌ Maaf pesanan **${inv}** DITOLAK (Bukti/Stok tidak valid).`);
    } else {
        bot.sendMessage(o.buyerId, `✅ Hore! Pembayaran **${inv}** diterima. Pesanan sedang diproses.`);
    }
}

async function showAdminList(chatId: number) {
    const text = `🔧 **ADMIN**\nProduk: ${db.products.length}\nOrder Pending: ${db.orders.filter(o=>o.status==='PENDING').length}`;
    await bot.sendMessage(chatId, text, {
        parse_mode:'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{text:"➕ Tambah Item", callback_data:"adm_add"}, {text:"📥 Download Rekap", callback_data:"adm_xl"}],
                [{text: "🏠 Mode User", callback_data:"menu_main"}]
            ]
        }
    });
}

// 405 fix
export async function GET() { return NextResponse.json({ status: 'PRO v3.0 - Grid & Desc' }); }