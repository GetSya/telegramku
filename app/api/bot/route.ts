// app/api/bot/route.ts
import { NextResponse } from 'next/server';
import TelegramBot from 'node-telegram-bot-api';
import * as XLSX from 'xlsx';

// =======================================================
// KONFIGURASI
// =======================================================

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const token = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_USERNAME = 'sofunsyabi'; // Ganti dengan username Telegram owner tanpa @

if (!token) throw new Error('TELEGRAM_BOT_TOKEN wajib ada di environment variables');

// Inisialisasi Bot
const bot = new TelegramBot(token, { polling: false });

// =======================================================
// TIPE DATA
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
  createdAt: string;
};

type CartItem = {
  productId: string;
  name: string;
  price: number;
  qty: number;
  unit: string;
};

type Order = {
  invoice: string;
  date: string;
  buyerName: string;
  buyerId: number;
  buyerUsername?: string;
  items: CartItem[];
  totalPrice: number;
  status: 'PENDING' | 'PAID' | 'SENT' | 'REJECTED' | 'COMPLETED';
  paymentProofFileId?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  notes?: string;
};

type UserSession = {
  step: 'IDLE' | 'ADD_PROD_NAME' | 'ADD_PROD_CAT' | 'ADD_PROD_UNIT' | 'ADD_PROD_BUY' | 'ADD_PROD_SELL' | 'ADD_PROD_STOCK' | 'CONFIRM_PAYMENT' | 'BROADCAST_MSG' | 'LIVE_CHAT' | 'EDIT_PRICE_VAL' | 'EDIT_STOCK_VAL' | 'VIEW_ORDERS' | 'ORDER_DETAIL' | 'VERIFY_ORDER' | 'ADD_NOTE';
  temp: any;
  cart: CartItem[];
  lastMessageId?: number;
};

type DB = {
  company: { name: string; addr: string; email: string; phone: string; bank: string };
  admins: number[];
  products: Product[];
  orders: Order[];
  categories: string[];
  units: string[];
  customCommands: Record<string, string>;
  users: Record<number, UserSession>;
};

// =======================================================
// DATABASE IN-MEMORY (WARNING: Data hilang saat restart/redeploy)
// =======================================================

const globalForDB = global as unknown as { db: DB };
const db: DB = globalForDB.db || {
  company: {
    name: "Sofunsyabi Store",
    addr: "Jakarta, Indonesia",
    email: "admin@sofunsyabi.com",
    phone: "+62 812-3456-7890",
    bank: "BCA 1234567890 a/n Sofunsyabi Store"
  },
  admins: [],
  categories: ["Makanan", "Minuman", "Jasa", "Digital", "Pakaian", "Elektronik"],
  units: ["PCS", "PACK", "BOX", "JAM", "KG", "METER", "SET"],
  products: [
    {
      id: "1",
      code: "P-001",
      name: "Premium Coffee Arabica",
      category: "Minuman",
      unit: "PACK",
      priceBuy: 25000,
      priceSell: 45000,
      stock: 100,
      createdAt: "2024-01-01"
    }
  ],
  orders: [],
  customCommands: {
    "/about": "🤖 *Marketplace Bot v3.0*\nFitur lengkap untuk jual beli via Telegram",
    "/help": "Ketik /menu untuk belanja\n/admin untuk panel admin"
  },
  users: {}
};

if (process.env.NODE_ENV !== 'production') globalForDB.db = db;

// =======================================================
// HELPER FUNCTIONS
// =======================================================

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

const getNow = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

const getSession = (chatId: number): UserSession => {
  if (!db.users[chatId]) {
    db.users[chatId] = { step: 'IDLE', temp: {}, cart: [] };
  }
  return db.users[chatId];
};

// Modified resetSession to optionally keep cart
const resetSession = (chatId: number, keepCart: boolean = false) => {
  const oldCart = db.users[chatId]?.cart || [];
  db.users[chatId] = { 
    step: 'IDLE', 
    temp: {}, 
    cart: keepCart ? oldCart : [] 
  };
};

const isAdmin = (username?: string, userId?: number): boolean => {
  if (username === OWNER_USERNAME) return true;
  if (userId && db.admins.includes(userId)) return true;
  return false;
};

const deleteMessage = async (chatId: number, messageId?: number) => {
  if (messageId) {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      // Ignore
    }
  }
};

const sendOrderNotification = async (order: Order, status: string) => {
  const statusText = {
    'PAID': '✅ PEMBAYARAN DIVERIFIKASI',
    'REJECTED': '❌ PEMBAYARAN DITOLAK',
    'SENT': '🚚 PESANAN DIKIRIM',
    'COMPLETED': '🎉 PESANAN SELESAI'
  }[status] || status;

  let message = `📦 *UPDATE STATUS PESANAN*\n\n`;
  message += `📋 Invoice: ${order.invoice}\n`;
  message += `📅 Tanggal: ${order.date}\n`;
  message += `💰 Total: ${formatRp(order.totalPrice)}\n`;
  message += `🔄 Status: ${statusText}\n`;

  if (status === 'REJECTED' && order.notes) {
    message += `\n📝 Catatan: ${order.notes}\n`;
    message += `\nSilakan hubungi admin untuk informasi lebih lanjut.`;
  } else if (status === 'SENT') {
    message += `\n🚚 Pesanan telah dikirim.\nHarap konfirmasi jika barang sudah sampai.`;
  }

  try {
    await bot.sendMessage(order.buyerId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
};

const generateInvoice = (): string => {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `INV/${year}${month}${day}/${random}`;
};

async function generateExcelReport() {
  const worksheetData = db.orders.map(o => ({
    'Invoice': o.invoice,
    'Tanggal': o.date,
    'Pembeli': o.buyerName,
    'Username': o.buyerUsername || '-',
    'Total': o.totalPrice,
    'Status': o.status,
    'Verifikasi': o.verifiedAt || '-',
    'Diverifikasi oleh': o.verifiedBy || '-',
    'Item': o.items.map(i => `${i.name} (${i.qty} ${i.unit})`).join(', ')
  }));

  const worksheet = XLSX.utils.json_to_sheet(worksheetData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Laporan");
  
  // Auto-size columns approximate
  worksheet['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 50 }];
  
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
  const firstName = msg.from?.first_name || 'Customer';
  const session = getSession(chatId);

  // Auto add owner as admin
  if (username === OWNER_USERNAME && !db.admins.includes(chatId)) {
    db.admins.push(chatId);
  }

  // Clean old message if exists
  if (session.lastMessageId) {
    await deleteMessage(chatId, session.lastMessageId);
    session.lastMessageId = undefined; // Reset ID after delete attempt
  }

  // Handle input steps
  if (session.step !== 'IDLE') {
    await processInputSteps(chatId, text, session, msg);
    return;
  }

  // Handle custom commands
  if (db.customCommands[text]) {
    const response = await bot.sendMessage(chatId, db.customCommands[text], { parse_mode: 'Markdown' });
    session.lastMessageId = response.message_id;
    return;
  }

  // Handle Admin Reply Command: /reply [ID] [Message]
  if (text.startsWith('/reply') && isAdmin(username, chatId)) {
    const parts = text.split(' ');
    if (parts.length < 3) {
      await bot.sendMessage(chatId, "❌ Format salah. Gunakan: `/reply [User ID] [Pesan]`", { parse_mode: 'Markdown' });
      return;
    }
    const targetId = parseInt(parts[1]);
    const replyMsg = parts.slice(2).join(' ');

    if (isNaN(targetId)) {
      await bot.sendMessage(chatId, "❌ User ID harus angka.");
      return;
    }

    try {
      await bot.sendMessage(targetId, `💬 *BALASAN ADMIN*\n\n${replyMsg}`, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, `✅ Pesan terkirim ke User ID: ${targetId}`);
    } catch (error) {
      await bot.sendMessage(chatId, `❌ Gagal mengirim pesan. User mungkin memblokir bot.`);
    }
    return;
  }

  // Handle main commands
  switch (text) {
    case '/start':
    case '/menu':
      await showMainMenu(chatId, firstName);
      break;
    
    case '/admin':
      if (isAdmin(username, chatId)) {
        await showAdminDashboard(chatId);
      } else {
        const response = await bot.sendMessage(chatId, "⛔ Akses ditolak. Hanya admin yang dapat mengakses panel ini.");
        session.lastMessageId = response.message_id;
      }
      break;
    
    case '/cart':
      await showCart(chatId);
      break;
    
    case '/clear':
      session.cart = [];
      const response = await bot.sendMessage(chatId, "🗑️ Keranjang berhasil dikosongkan!");
      session.lastMessageId = response.message_id;
      break;
    
    case '/orders':
      if (isAdmin(username, chatId)) {
        await showOrderManagement(chatId);
      }
      break;
    
    default:
      // Default fallback
      const helpResponse = await bot.sendMessage(
        chatId,
        "🤖 *Marketplace Bot*\n\n" +
        "Perintah yang tersedia:\n" +
        "• /menu - Menu utama\n" +
        "• /cart - Lihat keranjang\n" +
        "• /clear - Kosongkan keranjang\n" +
        (isAdmin(username, chatId) ? "• /admin - Panel admin\n" : "") +
        "\nAtau klik /menu untuk mulai belanja!",
        { parse_mode: 'Markdown' }
      );
      session.lastMessageId = helpResponse.message_id;
  }
}

async function handlePhoto(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const username = msg.from?.username;
  const firstName = msg.from?.first_name || 'Customer';

  if (session.step === 'CONFIRM_PAYMENT' && msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
    const fileId = photo.file_id;
    
    const invoice = generateInvoice();
    const total = session.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    
    const order: Order = {
      invoice,
      date: getNow(),
      buyerName: firstName,
      buyerId: chatId,
      buyerUsername: username,
      items: [...session.cart],
      totalPrice: total,
      status: 'PENDING',
      paymentProofFileId: fileId
    };

    db.orders.push(order);
    
    // Clear cart and session, but keep session fresh
    resetSession(chatId, false);
    
    const userResponse = await bot.sendMessage(
      chatId,
      `✅ *PESANAN DIBUAT!*\n\n` +
      `📋 Invoice: ${invoice}\n` +
      `💰 Total: ${formatRp(total)}\n` +
      `📅 Tanggal: ${order.date}\n\n` +
      `Bukti pembayaran diterima. Admin akan memverifikasi dalam 1x24 jam.`,
      { parse_mode: 'Markdown' }
    );
    getSession(chatId).lastMessageId = userResponse.message_id;

    // Notify Admins
    const adminMessage = `🚨 *PESANAN BARU!*\n\n` +
      `📋 Invoice: ${invoice}\n` +
      `👤 Pembeli: ${firstName} (@${username || 'no_username'})\n` +
      `🆔 User ID: \`${chatId}\`\n` +
      `💰 Total: ${formatRp(total)}\n` +
      `📅 Tanggal: ${order.date}\n\n` +
      `Klik tombol di bawah untuk verifikasi:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "👁️ Lihat Detail", callback_data: `order_detail_${invoice}` },
          { text: "✅ Verifikasi", callback_data: `verify_order_${invoice}` }
        ]
      ]
    };

    for (const adminId of db.admins) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: adminMessage,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } catch (error) {
        console.error(`Failed to notify admin ${adminId}:`, error);
        await bot.sendMessage(adminId, adminMessage, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      }
    }
  }
}

async function handleCallback(query: TelegramBot.CallbackQuery) {
  const chatId = query.message?.chat.id!;
  const data = query.data!;
  const session = getSession(chatId);
  const username = query.from.username;
  const messageId = query.message?.message_id;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {}

  // Clean old message logic
  if (session.lastMessageId && session.lastMessageId !== messageId) {
    await deleteMessage(chatId, session.lastMessageId);
  }
  // Set current message as last message to be potentially deleted later
  session.lastMessageId = messageId;

  // === USER MENU ===
  if (data === 'menu_catalog') {
    await showProductCatalog(chatId);
  } else if (data === 'menu_cart') {
    await showCart(chatId);
  } else if (data === 'menu_chat') {
    session.step = 'LIVE_CHAT';
    const response = await bot.sendMessage(
      chatId,
      "💬 *LIVE CHAT*\n\n" +
      "Tulis pesan Anda. Admin akan membalas secepatnya.\n\n" +
      "Ketik **BATAL** untuk keluar.",
      { parse_mode: 'Markdown' }
    );
    session.lastMessageId = response.message_id;
  } else if (data === 'menu_info') {
    const response = await bot.sendMessage(
      chatId,
      `🏢 *${db.company.name}*\n\n` +
      `📍 ${db.company.addr}\n` +
      `📧 ${db.company.email}\n` +
      `📱 ${db.company.phone}\n\n` +
      `🏦 *Rekening Pembayaran:*\n${db.company.bank}`,
      { parse_mode: 'Markdown' }
    );
    session.lastMessageId = response.message_id;
  } else if (data.startsWith('add_cart_')) {
    const productId = data.split('_')[2];
    const product = db.products.find(p => p.id === productId);
    
    if (product) {
      if (product.stock > 0) {
        const existingItem = session.cart.find(item => item.productId === productId);
        
        if (existingItem) {
          if (existingItem.qty < product.stock) {
            existingItem.qty++;
          } else {
            await bot.sendMessage(chatId, `❌ Stok mentok. Sisa: ${product.stock}`);
            return;
          }
        } else {
          session.cart.push({
            productId: product.id,
            name: product.name,
            price: product.priceSell,
            qty: 1,
            unit: product.unit
          });
        }
        
        const response = await bot.sendMessage(
          chatId,
          `✅ *${product.name}* masuk keranjang!\nTotal di keranjang: ${session.cart.find(c => c.productId === productId)?.qty || 1}`,
          { parse_mode: 'Markdown' }
        );
        session.lastMessageId = response.message_id;
      } else {
        await bot.sendMessage(chatId, "❌ Stok habis.");
      }
    }
  } else if (data === 'checkout_start') {
    if (session.cart.length === 0) {
      await bot.sendMessage(chatId, "🛒 Keranjang kosong.");
      return;
    }
    
    session.step = 'CONFIRM_PAYMENT';
    const total = session.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    
    const response = await bot.sendMessage(
      chatId,
      `💳 *KONFIRMASI PEMBAYARAN*\n\n` +
      `Total: ${formatRp(total)}\n\n` +
      `🏦 Transfer ke:\n${db.company.bank}\n\n` +
      `📸 *Kirim screenshot bukti transfer sekarang!*`,
      { parse_mode: 'Markdown' }
    );
    session.lastMessageId = response.message_id;
  } else if (data === 'cart_clear') {
    session.cart = [];
    const response = await bot.sendMessage(chatId, "🗑️ Keranjang dikosongkan.");
    session.lastMessageId = response.message_id;
  } else if (data.startsWith('update_qty_')) {
    const [_, __, action, productId] = data.split('_'); // Fix split
    const cartItem = session.cart.find(item => item.productId === productId);
    const product = db.products.find(p => p.id === productId);
    
    if (cartItem && product) {
      if (action === 'inc') {
        if (cartItem.qty < product.stock) {
          cartItem.qty++;
        } else {
          await bot.sendMessage(chatId, `❌ Stok maksimal tercapai.`);
          return;
        }
      } else if (action === 'dec') {
        if (cartItem.qty > 1) {
          cartItem.qty--;
        } else {
          session.cart = session.cart.filter(item => item.productId !== productId);
        }
      }
      await showCart(chatId);
    }
  }

  // === ADMIN COMMANDS ===
  if (!isAdmin(username, chatId)) return;

  if (data === 'adm_dash') {
    await showAdminDashboard(chatId);
  } else if (data === 'adm_products') {
    await showAdminProducts(chatId);
  } else if (data === 'adm_add_prod') {
    session.step = 'ADD_PROD_NAME';
    const response = await bot.sendMessage(
      chatId,
      "📦 *TAMBAH PRODUK BARU*\nMasukkan nama produk:",
      { parse_mode: 'Markdown' }
    );
    session.lastMessageId = response.message_id;
  } else if (data === 'adm_export') {
    if (db.orders.length === 0) {
      await bot.sendMessage(chatId, "📭 Data kosong.");
      return;
    }
    
    await bot.sendMessage(chatId, "⏳ Membuat laporan...");
    
    try {
      const buffer = await generateExcelReport();
      await bot.sendDocument(
  chatId,
  buffer,
  {}, // Argumen ke-3: Kosongkan jika tidak ada caption
  {   // Argumen ke-4: Metadata file (filename & contentType masuk sini)
    filename: `Laporan_${new Date().toISOString().split('T')[0]}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
);
    } catch (error) {
      await bot.sendMessage(chatId, "❌ Gagal membuat laporan.");
    }
  } else if (data === 'adm_broadcast') {
    session.step = 'BROADCAST_MSG';
    const response = await bot.sendMessage(
      chatId,
      "📢 *BROADCAST*\nTulis pesan untuk semua user (Ketik BATAL untuk cancel):",
      { parse_mode: 'Markdown' }
    );
    session.lastMessageId = response.message_id;
  } else if (data === 'adm_orders') {
    await showOrderManagement(chatId);
  } else if (data.startsWith('order_detail_')) {
    const invoice = data.split('_')[2];
    await showOrderDetail(chatId, invoice);
  } else if (data.startsWith('verify_order_')) {
    const invoice = data.split('_')[2];
    const order = db.orders.find(o => o.invoice === invoice);
    
    if (order) {
      session.temp = { orderInvoice: invoice };
      // Show confirmation dialog instead of changing step immediately
      const response = await bot.sendMessage(
        chatId,
        `Verifikasi ${invoice}?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Terima (Paid)", callback_data: `confirm_verify_${invoice}_PAID` },
                { text: "❌ Tolak (Reject)", callback_data: `confirm_verify_${invoice}_REJECTED` }
              ],
              [{ text: "⬅️ Batal", callback_data: `order_detail_${invoice}` }]
            ]
          }
        }
      );
      session.lastMessageId = response.message_id;
    }
  } else if (data.startsWith('confirm_verify_')) {
    const [_, __, invoice, status] = data.split('_');
    const order = db.orders.find(o => o.invoice === invoice);
    
    if (order) {
      if (status === 'PAID') {
        order.status = 'PAID';
        order.verifiedAt = getNow();
        order.verifiedBy = username || 'Admin';
        
        // Reduce stock
        for (const item of order.items) {
          const product = db.products.find(p => p.id === item.productId);
          if (product) product.stock = Math.max(0, product.stock - item.qty);
        }
        
        await sendOrderNotification(order, 'PAID');
        await bot.sendMessage(chatId, `✅ ${invoice} LUNAS.`);
        await showOrderDetail(chatId, invoice);
      } else if (status === 'REJECTED') {
        order.status = 'REJECTED';
        order.verifiedAt = getNow();
        order.verifiedBy = username || 'Admin';
        session.temp = { orderInvoice: invoice };
        session.step = 'ADD_NOTE';
        
        const response = await bot.sendMessage(
          chatId,
          `📝 Alasan penolakan untuk ${invoice}:`,
          { parse_mode: 'Markdown' }
        );
        session.lastMessageId = response.message_id;
        return;
      }
    }
  } else if (data.startsWith('update_status_')) {
    const [_, __, invoice, status] = data.split('_');
    const order = db.orders.find(o => o.invoice === invoice);
    
    if (order && (status === 'SENT' || status === 'COMPLETED')) {
      order.status = status as any;
      await sendOrderNotification(order, status);
      await bot.sendMessage(chatId, `✅ Status diperbarui: ${status}`);
      await showOrderDetail(chatId, invoice);
    }
  } else if (data.startsWith('adm_edit_')) {
    const productId = data.split('_')[2];
    const product = db.products.find(p => p.id === productId);
    
    if (product) {
      const response = await bot.sendMessage(
        chatId,
        `✏️ Edit: ${product.name}\nStok: ${product.stock}\nHarga: ${formatRp(product.priceSell)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "💰 Harga", callback_data: `edit_price_${productId}` },
                { text: "📦 Stok", callback_data: `edit_stock_${productId}` }
              ],
              [
                { text: "🗑️ Hapus Produk", callback_data: `adm_del_${productId}` }
              ],
              [{ text: "⬅️ Kembali", callback_data: 'adm_products' }]
            ]
          }
        }
      );
      session.lastMessageId = response.message_id;
    }
  } else if (data.startsWith('edit_price_')) {
    const productId = data.split('_')[2];
    session.step = 'EDIT_PRICE_VAL';
    session.temp = { productId };
    const response = await bot.sendMessage(chatId, "💰 Masukkan harga baru (angka):");
    session.lastMessageId = response.message_id;
  } else if (data.startsWith('edit_stock_')) {
    const productId = data.split('_')[2];
    session.step = 'EDIT_STOCK_VAL';
    session.temp = { productId };
    const response = await bot.sendMessage(chatId, "📦 Masukkan stok baru (angka):");
    session.lastMessageId = response.message_id;
  } else if (data.startsWith('adm_del_')) {
    const productId = data.split('_')[2];
    db.products = db.products.filter(p => p.id !== productId);
    await bot.sendMessage(chatId, "✅ Produk dihapus.");
    await showAdminProducts(chatId);
  }
}

// =======================================================
// VIEW FUNCTIONS
// =======================================================

async function showMainMenu(chatId: number, name: string) {
  const session = getSession(chatId);
  const cartCount = session.cart.reduce((sum, item) => sum + item.qty, 0);
  
  const text = `👋 *Halo, ${name}!*\nSelamat datang di ${db.company.name}.\n\n🛒 Isi Keranjang: ${cartCount}`;

  const keyboard = [
    [
      { text: "🛍️ Katalog Produk", callback_data: "menu_catalog" },
      { text: `🛒 Keranjang (${cartCount})`, callback_data: "menu_cart" }
    ],
    [
      { text: "💬 Live Chat", callback_data: "menu_chat" },
      { text: "🏢 Info Toko", callback_data: "menu_info" }
    ]
  ];

  if (isAdmin(undefined, chatId)) {
    keyboard.push([{ text: "🔧 Admin Panel", callback_data: "adm_dash" }]);
  }

  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  
  session.lastMessageId = response.message_id;
}

async function showAdminDashboard(chatId: number) {
  const pendingOrders = db.orders.filter(o => o.status === 'PENDING').length;
  
  const text = `🔧 *ADMIN PANEL*\n\n` +
    `📊 Stats:\n` +
    `📦 Produk: ${db.products.length}\n` +
    `📋 Pesanan Total: ${db.orders.length}\n` +
    `⏳ Pending: ${pendingOrders}`;

  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📦 Produk", callback_data: "adm_products" },
          { text: `📋 Pesanan (${pendingOrders})`, callback_data: "adm_orders" }
        ],
        [
          { text: "➕ Tambah Produk", callback_data: "adm_add_prod" },
          { text: "📥 Export Excel", callback_data: "adm_export" }
        ],
        [
          { text: "📢 Broadcast", callback_data: "adm_broadcast" }
        ],
        [
          { text: "⬅️ Menu Utama", callback_data: "menu_catalog" }
        ]
      ]
    }
  });
  
  getSession(chatId).lastMessageId = response.message_id;
}

async function showProductCatalog(chatId: number) {
  if (db.products.length === 0) {
    const response = await bot.sendMessage(chatId, "📭 Produk kosong.");
    getSession(chatId).lastMessageId = response.message_id;
    return;
  }
  
  for (const product of db.products) {
    const text = `🏷️ *${product.name}*\n` +
      `💰 ${formatRp(product.priceSell)} / ${product.unit}\n` +
      `📦 Stok: ${product.stock}\n` +
      `📂 Kat: ${product.category}`;

    const response = await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: "➕ Beli", callback_data: `add_cart_${product.id}` }
        ]]
      }
    });
    
    // Jangan set lastMessageId di sini agar tidak menghapus pesan produk sebelumnya saat scrolling
  }
  
  // Kirim tombol navigasi di bawah
  const nav = await bot.sendMessage(chatId, "Pilih produk di atas 👆", {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "menu_catalog" }, { text: "🛒 Keranjang", callback_data: "menu_cart" }]]
    }
  });
  getSession(chatId).lastMessageId = nav.message_id;
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

async function showCart(chatId: number) {
  const session = getSession(chatId);
  
  if (session.cart.length === 0) {
    const response = await bot.sendMessage(
      chatId,
      "🛒 Keranjang kosong.",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🛍️ Belanja", callback_data: "menu_catalog" }]]
        }
      }
    );
    session.lastMessageId = response.message_id;
    return;
  }
  
  let total = 0;
  let itemsText = session.cart.map((item, index) => {
    const subtotal = item.price * item.qty;
    total += subtotal;
    return `${index + 1}. *${item.name}*\n   ${item.qty} x ${formatRp(item.price)} = ${formatRp(subtotal)}`;
  }).join('\n\n');
  
  const text = `🛒 *KERANJANG*\n\n${itemsText}\n\n💰 *Total: ${formatRp(total)}*`;
  
    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  
  for (const item of session.cart) {
    keyboard.push([
      { text: `➖ ${item.name.substring(0, 10)}`, callback_data: `update_qty_dec_${item.productId}` },
      { text: `➕`, callback_data: `update_qty_inc_${item.productId}` }
    ]);
  }
  
  keyboard.push([
    { text: "✅ Checkout", callback_data: "checkout_start" },
    { text: "🗑️ Bersihkan", callback_data: "cart_clear" }
  ]);
  
  keyboard.push([{ text: "🛍️ Tambah Produk", callback_data: "menu_catalog" }]);
  
  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  
  session.lastMessageId = response.message_id;
}

async function showOrderManagement(chatId: number) {
  const pending = db.orders.filter(o => o.status === 'PENDING');
  const history = db.orders.filter(o => o.status !== 'PENDING').slice(-5); // Ambil 5 terakhir
  
  let text = `📋 *ORDER MANAGEMENT*\n\n`;
  
  // PERBAIKAN DI SINI: Tambahkan tipe data eksplisit
  let keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  
  if (pending.length > 0) {
    text += `⏳ *PENDING VERIFIKASI:*\n`;
    pending.forEach(o => text += `- ${o.invoice} (${o.buyerName})\n`);
    // Kita isi keyboard dengan map
    keyboard = pending.map(o => [{ text: `⏳ ${o.invoice}`, callback_data: `order_detail_${o.invoice}` }]);
  } else {
    text += `✅ Tidak ada pesanan pending.\n`;
  }

  if (history.length > 0) {
    text += `\n📜 *RIWAYAT TERAKHIR:*\n`;
    history.forEach(o => text += `- ${o.status} ${o.invoice}\n`);
    // Kita push tombol baru ke keyboard yang sudah ada
    history.forEach(o => keyboard.push([{ text: `📜 ${o.invoice}`, callback_data: `order_detail_${o.invoice}` }]));
  }
  
  keyboard.push([{ text: "⬅️ Dashboard", callback_data: "adm_dash" }]);

  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  
  getSession(chatId).lastMessageId = response.message_id;
}

async function showOrderDetail(chatId: number, invoice: string) {
  const order = db.orders.find(o => o.invoice === invoice);
  if (!order) {
    await bot.sendMessage(chatId, "❌ Data tidak ditemukan.");
    return;
  }
  
  const itemsText = order.items.map(i => `- ${i.name} (${i.qty}x)`).join('\n');
  
  const text = `📋 *DETAIL ${order.invoice}*\n` +
    `👤 ${order.buyerName} (@${order.buyerUsername || '-'})\n` +
    `📅 ${order.date}\n` +
    `💰 ${formatRp(order.totalPrice)}\n` +
    `🔄 Status: ${order.status}\n\n` +
    `🛒 Items:\n${itemsText}`;
  
const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  
  if (order.status === 'PENDING') {
    keyboard.push([{ text: "✅ Verifikasi Pembayaran", callback_data: `verify_order_${order.invoice}` }]);
  } else if (order.status === 'PAID') {
    keyboard.push([{ text: "🚚 Kirim Barang", callback_data: `update_status_${order.invoice}_SENT` }]);
  } else if (order.status === 'SENT') {
    keyboard.push([{ text: "🎉 Selesai", callback_data: `update_status_${order.invoice}_COMPLETED` }]);
  }
  
  if (order.paymentProofFileId) {
    try {
      await bot.sendPhoto(chatId, order.paymentProofFileId, {
        caption: text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "adm_orders" }], ...keyboard] }
      });
      return;
    } catch (e) {}
  }
  
  keyboard.push([{ text: "⬅️ Kembali", callback_data: "adm_orders" }]);
  
  const response = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
  getSession(chatId).lastMessageId = response.message_id;
}

// =======================================================
// PROCESS INPUT STEPS
// =======================================================

async function processInputSteps(chatId: number, text: string, session: UserSession, msg?: TelegramBot.Message) {
  if (text.toLowerCase() === 'batal') {
    resetSession(chatId, true); // Keep cart if canceling generic action
    await showMainMenu(chatId, msg?.from?.first_name || 'Customer');
    return;
  }

  switch (session.step) {
    case 'ADD_PROD_NAME':
      session.temp.name = text;
      session.step = 'ADD_PROD_CAT';
      await bot.sendMessage(chatId, "📂 Kategori:", { reply_markup: { keyboard: [db.categories.map(c=>c), ['Batal']], resize_keyboard: true, one_time_keyboard: true } });
      break;

    case 'ADD_PROD_CAT':
      session.temp.category = text;
      if (!db.categories.includes(text)) db.categories.push(text);
      session.step = 'ADD_PROD_UNIT';
      await bot.sendMessage(chatId, "📏 Satuan:", { reply_markup: { keyboard: [db.units.map(u=>u), ['Batal']], resize_keyboard: true, one_time_keyboard: true } });
      break;

    case 'ADD_PROD_UNIT':
      session.temp.unit = text;
      if (!db.units.includes(text)) db.units.push(text);
      session.step = 'ADD_PROD_BUY';
      await bot.sendMessage(chatId, "💰 Harga Modal (Angka):");
      break;

    case 'ADD_PROD_BUY':
      const buy = parseInt(text.replace(/\D/g, ''));
      if (isNaN(buy)) { await bot.sendMessage(chatId, "❌ Harus angka."); return; }
      session.temp.priceBuy = buy;
      session.step = 'ADD_PROD_SELL';
      await bot.sendMessage(chatId, "💰 Harga Jual (Angka):");
      break;

    case 'ADD_PROD_SELL':
      const sell = parseInt(text.replace(/\D/g, ''));
      if (isNaN(sell)) { await bot.sendMessage(chatId, "❌ Harus angka."); return; }
      session.temp.priceSell = sell;
      session.step = 'ADD_PROD_STOCK';
      await bot.sendMessage(chatId, "📦 Stok Awal (Angka):");
      break;

    case 'ADD_PROD_STOCK':
      const stock = parseInt(text.replace(/\D/g, ''));
      if (isNaN(stock)) { await bot.sendMessage(chatId, "❌ Harus angka."); return; }
      
      const newProd: Product = {
        id: Date.now().toString(),
        code: `P-${Date.now().toString().slice(-4)}`,
        name: session.temp.name,
        category: session.temp.category,
        unit: session.temp.unit,
        priceBuy: session.temp.priceBuy,
        priceSell: session.temp.priceSell,
        stock: stock,
        createdAt: getNow()
      };
      
      db.products.push(newProd);
      resetSession(chatId);
      await bot.sendMessage(chatId, "✅ Produk tersimpan!");
      await showAdminProducts(chatId);
      break;

    case 'EDIT_PRICE_VAL':
      const pPrice = parseInt(text.replace(/\D/g, ''));
      if (!isNaN(pPrice) && session.temp.productId) {
        const prod = db.products.find(p => p.id === session.temp.productId);
        if (prod) prod.priceSell = pPrice;
        await bot.sendMessage(chatId, "✅ Harga update.");
      }
      resetSession(chatId);
      await showAdminProducts(chatId);
      break;

    case 'EDIT_STOCK_VAL':
      const pStock = parseInt(text.replace(/\D/g, ''));
      if (!isNaN(pStock) && session.temp.productId) {
        const prod = db.products.find(p => p.id === session.temp.productId);
        if (prod) prod.stock = pStock;
        await bot.sendMessage(chatId, "✅ Stok update.");
      }
      resetSession(chatId);
      await showAdminProducts(chatId);
      break;

    case 'BROADCAST_MSG':
      resetSession(chatId);
      const count = Object.keys(db.users).length;
      await bot.sendMessage(chatId, `📢 Mengirim ke ${count} user...`);
      
      for (const uid of Object.keys(db.users)) {
        if (parseInt(uid) === chatId) continue;
        try {
          await bot.sendMessage(uid, `📢 *PENGUMUMAN*\n\n${text}`, { parse_mode: 'Markdown' });
        } catch (e) {}
      }
      await bot.sendMessage(chatId, "✅ Broadcast selesai.");
      break;

    case 'ADD_NOTE': // Reject note
      const order = db.orders.find(o => o.invoice === session.temp.orderInvoice);
      if (order) {
        order.notes = text;
        await sendOrderNotification(order, 'REJECTED');
        await bot.sendMessage(chatId, "✅ Pesanan ditolak.");
      }
      resetSession(chatId);
      await showOrderManagement(chatId);
      break;

    case 'LIVE_CHAT':
      const userMsg = `💬 *CHAT USER*\n👤 ${msg?.from?.first_name} (ID: \`${chatId}\`)\n\n${text}`;
      
      // Kirim ke semua admin
      for (const aid of db.admins) {
        await bot.sendMessage(aid, userMsg + `\n\n_Balas dengan: /reply ${chatId} pesan_`, { parse_mode: 'Markdown' });
      }
      
      await bot.sendMessage(chatId, "✅ Terkirim ke admin. Tunggu balasan ya! (Ketik BATAL untuk keluar)");
      break;
  }
}

// =======================================================
// GET HANDLER (Check Status)
// =======================================================

export async function GET() {
  return NextResponse.json({
    status: 'Bot Active',
    time: getNow(),
    stats: {
      products: db.products.length,
      orders: db.orders.length,
      admins: db.admins.length
    }
  });
}