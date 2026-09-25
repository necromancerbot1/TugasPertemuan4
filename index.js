// =============================================================
//  NECRO BOT — index.js
//  WhatsApp bot dengan Gemini AI, cari jurnal, buat PPT, dll.
// =============================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const sqlite3      = require('sqlite3').verbose();
const { exec, execSync } = require('child_process');
const pino         = require('pino');
const qrcode       = require('qrcode-terminal');
const { Chess }    = require('chess.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const PptxGenJS    = require('pptxgenjs');
const officeParser = require('officeparser');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

// ====================== KONFIGURASI ======================
// Simpan semua key sensitif di environment variable, JANGAN di-hardcode.

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || 'MASUKKAN_API_KEY_GEMINI_DI_SINI';
const GCSE_API_KEY    = process.env.GCSE_API_KEY    || '';  // Google Custom Search — https://developers.google.com/custom-search/v1/introduction
const GCSE_CX         = process.env.GCSE_CX         || '';  // Search Engine ID dari https://programmablesearchengine.google.com

const GEMINI_MODEL    = 'gemini-1.5-pro';
const GEMINI_TIMEOUT  = 60_000;   // 60 detik
const MAX_WA_LENGTH   = 4000;

const NOMOR_OWNER     = process.env.NOMOR_OWNER || '6282163037397'; // Nomor WA owner (tanpa @s.whatsapp.net)
const NOMOR_BOT       = process.env.NOMOR_BOT   || '6289530381985';
const NOMOR_BOT_LID   = process.env.NOMOR_BOT_LID || '98076383518841';
const LINK_GAME       = 'https://deadshot.io';
const LINK_WEB        = 'https://necromanbot.my.id/';
const IP_VPS          = process.env.IP_VPS || '38.102.126.42';
const PORT            = 10155;
// =========================================================

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const DOCS_DIR = path.join(__dirname, 'dokumen');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const db     = new sqlite3.Database('./game_data.db');
const sesiCatur = {}; // { jid: Chess }
let waSocket = null;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
db.run("CREATE TABLE IF NOT EXISTS rank (nama TEXT, skor INTEGER)");

// =============================================================
// SOCKET.IO — Leaderboard & Catur Multiplayer Real-time
// =============================================================
const sesiCaturWeb = {}; // { roomId: { chess, players: [socketId] } }

io.on('connection', (socket) => {
    // --- Leaderboard ---
    db.all("SELECT nama, skor FROM rank ORDER BY skor DESC LIMIT 10", [], (err, rows) => {
        socket.emit('update_leaderboard', rows || []);
    });
    socket.on('kirim_skor', (data) => {
        db.run("INSERT INTO rank (nama, skor) VALUES (?, ?)", [data.nama, data.skor], () => {
            db.all("SELECT nama, skor FROM rank ORDER BY skor DESC LIMIT 10", [], (err, rows) => {
                io.emit('update_leaderboard', rows || []);
            });
        });
    });

    // --- Catur Multiplayer Web ---
    socket.on('catur_join', ({ roomId, playerName }) => {
        if (!sesiCaturWeb[roomId]) {
            sesiCaturWeb[roomId] = { chess: new Chess(), players: [], names: {} };
        }
        const room = sesiCaturWeb[roomId];
        if (room.players.length >= 2 && !room.players.includes(socket.id)) {
            socket.emit('catur_error', 'Room penuh (maks 2 pemain).');
            return;
        }
        if (!room.players.includes(socket.id)) {
            room.players.push(socket.id);
            room.names[socket.id] = playerName || `Pemain ${room.players.length}`;
        }
        socket.join(roomId);
        const color = room.players.indexOf(socket.id) === 0 ? 'white' : 'black';
        socket.emit('catur_joined', {
            color,
            fen: room.chess.fen(),
            turn: room.chess.turn(),
            players: Object.values(room.names)
        });
        io.to(roomId).emit('catur_state', {
            fen: room.chess.fen(),
            turn: room.chess.turn(),
            players: Object.values(room.names),
            moveCount: room.chess.moveNumber()
        });
    });

    socket.on('catur_move', ({ roomId, from, to, promotion }) => {
        const room = sesiCaturWeb[roomId];
        if (!room) return socket.emit('catur_error', 'Room tidak ditemukan.');
        const playerIdx = room.players.indexOf(socket.id);
        const expectedColor = playerIdx === 0 ? 'w' : 'b';
        if (room.chess.turn() !== expectedColor) return socket.emit('catur_error', 'Bukan giliran Anda.');
        try {
            const move = room.chess.move({ from, to, promotion: promotion || 'q' });
            if (!move) return socket.emit('catur_error', 'Langkah ilegal.');
            const state = {
                fen: room.chess.fen(),
                turn: room.chess.turn(),
                lastMove: { from, to },
                isCheck: room.chess.isCheck(),
                isCheckmate: room.chess.isCheckmate(),
                isDraw: room.chess.isDraw(),
                players: Object.values(room.names),
                moveCount: room.chess.moveNumber()
            };
            io.to(roomId).emit('catur_state', state);
            if (state.isCheckmate || state.isDraw) {
                io.to(roomId).emit('catur_gameover', {
                    result: state.isCheckmate ? `🏆 ${room.names[socket.id]} menang!` : '🤝 Remis!'
                });
                delete sesiCaturWeb[roomId];
            }
        } catch { socket.emit('catur_error', 'Langkah tidak valid.'); }
    });

    socket.on('catur_resign', ({ roomId }) => {
        const room = sesiCaturWeb[roomId];
        if (!room) return;
        io.to(roomId).emit('catur_gameover', { result: `🏳️ ${room.names[socket.id]} menyerah.` });
        delete sesiCaturWeb[roomId];
    });

    socket.on('disconnect', () => {
        for (const [roomId, room] of Object.entries(sesiCaturWeb)) {
            if (room.players.includes(socket.id)) {
                io.to(roomId).emit('catur_gameover', { result: '⚠️ Lawan terputus. Permainan selesai.' });
                delete sesiCaturWeb[roomId];
            }
        }
    });
});

// =============================================================
// HALAMAN HTML — Catur Multiplayer Interaktif
// Dapat dibuka dari link yang dikirim bot ke WhatsApp
// =============================================================
app.get('/catur', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Necro Chess ♟️</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1a1a2e; color: #eee; font-family: 'Segoe UI', sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 16px; }
  h1 { color: #f0c040; margin-bottom: 12px; font-size: 1.6rem; }
  #lobby, #game { width: 100%; max-width: 480px; }
  #lobby { display: flex; flex-direction: column; gap: 10px; background: #16213e; padding: 20px; border-radius: 12px; }
  input { padding: 10px; border-radius: 8px; border: 1px solid #444; background: #0f3460; color: #fff; font-size: 1rem; }
  button { padding: 10px 18px; border-radius: 8px; border: none; background: #f0c040; color: #1a1a2e; font-weight: bold; cursor: pointer; font-size: 1rem; }
  button:hover { background: #ffd666; }
  button.danger { background: #e74c3c; color: #fff; }
  #board-wrap { position: relative; width: 100%; max-width: 480px; }
  #board { display: grid; grid-template-columns: repeat(8, 1fr); width: 100%; aspect-ratio: 1; border: 2px solid #f0c040; border-radius: 4px; overflow: hidden; }
  .sq { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; font-size: clamp(18px, 5vw, 34px); cursor: pointer; position: relative; user-select: none; transition: background 0.1s; }
  .sq.light { background: #f0d9b5; }
  .sq.dark  { background: #b58863; }
  .sq.selected { background: #7fc97f !important; }
  .sq.hint     { background: #7fc97f88 !important; }
  .sq.lastmove { background: #cdd16f !important; }
  .sq.check    { background: #e74c3c !important; }
  #info { width: 100%; max-width: 480px; background: #16213e; border-radius: 10px; padding: 12px; margin-top: 10px; }
  #status { font-size: 1.1rem; color: #f0c040; font-weight: bold; margin-bottom: 6px; }
  #moves { max-height: 100px; overflow-y: auto; font-size: 0.8rem; color: #aaa; font-family: monospace; }
  #players { font-size: 0.9rem; color: #88c; margin-bottom: 6px; }
  #gameover-overlay { display: none; position: fixed; inset: 0; background: #000a; z-index: 99; align-items: center; justify-content: center; flex-direction: column; gap: 16px; }
  #gameover-overlay.show { display: flex; }
  #gameover-msg { font-size: 2rem; color: #f0c040; text-align: center; padding: 20px; }
  #coords-file { display: flex; width: 100%; max-width: 480px; justify-content: space-around; color: #888; font-size: 0.7rem; margin-top: 2px; }
</style>
</head>
<body>
<h1>♟️ Necro Chess</h1>

<div id="lobby">
  <input id="inp-name" placeholder="Nama kamu" maxlength="20">
  <input id="inp-room" placeholder="Room ID (sama dengan lawan)" maxlength="20" value="room1">
  <button onclick="joinRoom()">Masuk / Buat Room</button>
  <div id="lobby-msg" style="color:#aaa;font-size:0.85rem;"></div>
</div>

<div id="game" style="display:none; flex-direction:column; align-items:center; gap:10px;">
  <div id="info">
    <div id="players"></div>
    <div id="status">Menunggu lawan...</div>
    <div id="moves"></div>
  </div>
  <div id="board-wrap">
    <div id="board"></div>
  </div>
  <div id="coords-file">
    <span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span><span>g</span><span>h</span>
  </div>
  <button class="danger" onclick="resign()">🏳️ Menyerah</button>
</div>

<div id="gameover-overlay">
  <div id="gameover-msg"></div>
  <button onclick="location.reload()">Main Lagi</button>
</div>

<script>
const PIECES = {
  K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',
  k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'
};
const FILES = 'abcdefgh';
const socket = io();
let myColor = null, selectedSq = null, lastMove = null, currentFen = null, legalMoves = [];
let roomId = '', moveHistory = [];

function joinRoom() {
  const name = document.getElementById('inp-name').value.trim() || 'Pemain';
  roomId = document.getElementById('inp-room').value.trim() || 'room1';
  document.getElementById('lobby-msg').textContent = 'Menghubungkan...';
  socket.emit('catur_join', { roomId, playerName: name });
}

socket.on('catur_joined', ({ color, fen, turn, players }) => {
  myColor = color;
  currentFen = fen;
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'flex';
  renderBoard(fen, turn);
  updatePlayers(players);
});

socket.on('catur_state', ({ fen, turn, lastMove: lm, isCheck, players, moveCount }) => {
  currentFen = fen;
  lastMove = lm || null;
  selectedSq = null;
  legalMoves = [];
  renderBoard(fen, turn, isCheck);
  updatePlayers(players);
  const myTurn = (turn === 'w' && myColor === 'white') || (turn === 'b' && myColor === 'black');
  document.getElementById('status').textContent = myTurn ? '🟢 Giliran kamu!' : '⏳ Giliran lawan...';
  if (lm) {
    moveHistory.push('Move ' + moveCount + ': ' + lm.from + '-' + lm.to);
    const mDiv = document.getElementById('moves');
    mDiv.innerHTML = moveHistory.slice(-20).join('<br>');
    mDiv.scrollTop = mDiv.scrollHeight;
  }
});

socket.on('catur_error', (msg) => { document.getElementById('status').textContent = '⚠️ ' + msg; });

socket.on('catur_gameover', ({ result }) => {
  document.getElementById('gameover-msg').textContent = result;
  document.getElementById('gameover-overlay').classList.add('show');
});

function parseFen(fen) {
  const board = Array(64).fill(null);
  const ranks = fen.split(' ')[0].split('/');
  ranks.forEach((rank, r) => {
    let f = 0;
    for (const ch of rank) {
      if (isNaN(ch)) { board[r * 8 + f] = ch; f++; }
      else f += parseInt(ch);
    }
  });
  return board;
}

function sqName(row, col) { return FILES[col] + (8 - row); }

function renderBoard(fen, turn, isCheck) {
  const pieces = parseFen(fen);
  const board  = document.getElementById('board');
  board.innerHTML = '';
  const flip = myColor === 'black';
  for (let i = 0; i < 64; i++) {
    const displayIdx = flip ? 63 - i : i;
    const row = Math.floor(displayIdx / 8), col = displayIdx % 8;
    const sq  = sqName(row, col);
    const div = document.createElement('div');
    div.className = 'sq ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
    div.dataset.sq = sq;
    if (lastMove && (sq === lastMove.from || sq === lastMove.to)) div.classList.add('lastmove');
    if (sq === selectedSq) div.classList.add('selected');
    if (legalMoves.includes(sq)) div.classList.add('hint');
    const piece = pieces[displayIdx];
    if (piece) {
      div.textContent = PIECES[piece] || piece;
      if (isCheck && ((piece === 'K' && turn === 'w') || (piece === 'k' && turn === 'b'))) div.classList.add('check');
    }
    div.addEventListener('click', () => handleClick(sq));
    board.appendChild(div);
  }
}

function handleClick(sq) {
  const myTurn = currentFen && ((currentFen.split(' ')[1] === 'w' && myColor === 'white') || (currentFen.split(' ')[1] === 'b' && myColor === 'black'));
  if (!myTurn) return;
  if (selectedSq) {
    if (legalMoves.includes(sq)) {
      socket.emit('catur_move', { roomId, from: selectedSq, to: sq });
    }
    selectedSq = null; legalMoves = [];
    renderBoard(currentFen, currentFen.split(' ')[1]);
  } else {
    selectedSq = sq;
    legalMoves = getHints(sq);
    renderBoard(currentFen, currentFen.split(' ')[1]);
  }
}

// Hitung moves sederhana dari FEN (client-side preview saja, server yang validasi)
function getHints(sq) {
  // Kirimkan ke server untuk cek; di sini cukup highlight semua kemungkinan
  // (validasi penuh ada di server via chess.js)
  return []; // Biarkan kosong — tampilan hint memerlukan chess.js di client
}

function updatePlayers(players) {
  document.getElementById('players').textContent =
    '♔ ' + (players[0] || '?') + '  vs  ♚ ' + (players[1] || 'Menunggu...');
}

function resign() {
  if (confirm('Yakin menyerah?')) socket.emit('catur_resign', { roomId });
}
</script>
</body>
</html>`);
});

// =============================================================
// HELPERS UMUM
// =============================================================

function cleanAndValidatePhone(raw) {
    if (typeof raw !== 'string') throw new Error('Nomor pengirim harus berupa string.');
    const cleaned = raw.replace(/[^\d]/g, '');
    if (!/^\d{7,15}$/.test(cleaned)) throw new Error(`Nomor pengirim tidak valid: "${raw}"`);
    return cleaned;
}

function splitMessage(text, maxLen = MAX_WA_LENGTH) {
    const parts = [];
    let rem = text;
    while (rem.length > maxLen) {
        let cut = rem.lastIndexOf('\n', maxLen);
        if (cut < maxLen * 0.5) cut = rem.lastIndexOf('. ', maxLen);
        if (cut < maxLen * 0.5) cut = maxLen;
        parts.push(rem.slice(0, cut + 1).trimEnd());
        rem = rem.slice(cut + 1).trimStart();
    }
    if (rem.length > 0) parts.push(rem);
    return parts;
}

async function sendLongMessage(sock, jid, text, extra = {}) {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
        const header = parts.length > 1 ? `_(${i + 1}/${parts.length})_\n\n` : '';
        await sock.sendMessage(jid, { text: header + parts[i], ...extra });
        if (i < parts.length - 1) await new Promise(r => setTimeout(r, 800));
    }
}

function saveTextDoc(filename, content) {
    const safe = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const out  = path.join(DOCS_DIR, safe.endsWith('.txt') ? safe : safe + '.txt');
    fs.writeFileSync(out, content, 'utf-8');
    return out;
}

// =============================================================
// PENCARIAN JURNAL & BUKU
// Menggunakan Google Custom Search API (gratis 100 query/hari)
// Cara dapat key: https://developers.google.com/custom-search/v1/introduction
// =============================================================

/**
 * Cari jurnal/buku di internet dan kembalikan daftar hasil dengan link.
 * Secara default menyertakan situs akademik: scholar, researchgate, semanticscholar, dll.
 * @param {string} query - Kata kunci pencarian
 * @param {'jurnal'|'buku'|'semua'} tipe
 * @returns {Promise<string>} Teks hasil yang siap dikirim ke WA
 */
async function searchAcademic(query, tipe = 'semua') {
    // Tambah kata kunci akademik sesuai tipe
    const siteFilter = tipe === 'jurnal'
        ? 'site:scholar.google.com OR site:researchgate.net OR site:semanticscholar.org OR site:pubmed.ncbi.nlm.nih.gov OR site:arxiv.org OR site:sciencedirect.com'
        : tipe === 'buku'
        ? 'site:books.google.com OR site:openlibrary.org OR site:z-lib.org OR site:pdfdrive.com'
        : '';
    const fullQuery = siteFilter ? `${query} ${siteFilter}` : `${query} jurnal OR buku ilmiah`;

    // Jika API key tersedia, pakai Google Custom Search
    if (GCSE_API_KEY && GCSE_CX) {
        return new Promise((resolve, reject) => {
            const url = `https://www.googleapis.com/customsearch/v1?key=${GCSE_API_KEY}&cx=${GCSE_CX}&q=${encodeURIComponent(fullQuery)}&num=5`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (!json.items || json.items.length === 0) {
                            return resolve('Tidak ada hasil ditemukan untuk pencarian tersebut.');
                        }
                        let hasil = `🔍 *Hasil Pencarian: "${query}"*\n\n`;
                        json.items.forEach((item, i) => {
                            hasil += `*${i + 1}. ${item.title}*\n`;
                            if (item.snippet) hasil += `📝 ${item.snippet.slice(0, 120)}...\n`;
                            hasil += `🔗 ${item.link}\n\n`;
                        });
                        resolve(hasil.trim());
                    } catch (e) { reject(new Error('Gagal parse hasil pencarian: ' + e.message)); }
                });
            }).on('error', reject);
        });
    }

    // Fallback: Minta Gemini untuk merekomendasikan sumber dengan link (tanpa browsing nyata)
    const prompt =
        `Berikan rekomendasi 5 ${tipe === 'buku' ? 'buku' : tipe === 'jurnal' ? 'jurnal/artikel ilmiah' : 'sumber (jurnal/buku)'} ` +
        `tentang: "${query}"\n\n` +
        `Untuk setiap item, berikan:\n` +
        `1. Judul lengkap\n2. Penulis/Editor\n3. Tahun terbit\n4. Link akses (gunakan URL nyata seperti Google Scholar, ResearchGate, Google Books, dll.)\n5. Ringkasan singkat (2 kalimat)\n\n` +
        `Format jawaban dengan nomor dan rapi. Sertakan link langsung yang bisa diklik.`;
    const jawaban = await askGemini(prompt, '');
    return `🔍 *Rekomendasi ${tipe === 'buku' ? 'Buku' : 'Jurnal'}: "${query}"*\n_(Dihasilkan AI — untuk hasil lebih akurat, set GCSE_API_KEY)_\n\n${jawaban}`;
}

// =============================================================
// GEMINI HELPERS
// =============================================================

async function askGemini(userMessage, systemInstruction = '') {
    const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        ...(systemInstruction && { systemInstruction })
    });
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), GEMINI_TIMEOUT)
    );
    const result = await Promise.race([model.generateContent(userMessage), timeoutPromise]);
    return result.response.text().trim();
}

async function askGeminiWithFile(prompt, fileBuffer, mimeType) {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), GEMINI_TIMEOUT)
    );
    const result = await Promise.race([
        model.generateContent([prompt, { inlineData: { data: fileBuffer.toString('base64'), mimeType } }]),
        timeoutPromise
    ]);
    return result.response.text().trim();
}

async function askGeminiWithText(prompt, docText) {
    const combined = `${prompt}\n\n---ISI DOKUMEN---\n${docText}\n---AKHIR DOKUMEN---`;
    return askGemini(combined, 'Kamu adalah asisten profesional yang menganalisis dokumen. Jawab dalam Bahasa Indonesia.');
}

// =============================================================
// PPTX BUILDER
// =============================================================

async function buildPptx(topik, jumlahSlide = 10) {
    const prompt =
        `Buat presentasi PowerPoint profesional tentang: "${topik}"\n` +
        `Jumlah slide: ${jumlahSlide}\n\n` +
        `Kembalikan HANYA array JSON valid tanpa markdown fencing:\n` +
        `[{"title":"...", "subtitle":"...(opsional, hanya slide 1)", "bullets":["...","..."], "notes":"..."}]\n\n` +
        `Panduan: slide pertama = judul+subtitle, slide terakhir = penutup, maks 5 poin per slide, Bahasa Indonesia.`;

    const raw     = await askGemini(prompt, '');
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    let slides;
    try { slides = JSON.parse(cleaned); }
    catch { throw new Error('Gemini tidak mengembalikan JSON yang valid. Coba lagi.'); }

    const pptx = new PptxGenJS();
    pptx.layout  = 'LAYOUT_WIDE';
    pptx.author  = 'Necro AI Bot';
    pptx.title   = topik;

    const BG = '1E2A38', TITLE_CLR = 'F0C040', TXT = 'FFFFFF', ACCENT = '4FC3F7';

    slides.forEach((slide, idx) => {
        const s = pptx.addSlide();
        s.background = { color: BG };
        const isFirst = idx === 0, isLast = idx === slides.length - 1;

        if (isFirst) {
            s.addText(slide.title || topik, { x: 0.5, y: 1.8, w: '90%', h: 1.5, fontSize: 36, bold: true, color: TITLE_CLR, align: 'center', fontFace: 'Calibri' });
            if (slide.subtitle) s.addText(slide.subtitle, { x: 0.5, y: 3.5, w: '90%', h: 0.8, fontSize: 20, color: TXT, align: 'center', fontFace: 'Calibri' });
            s.addShape(pptx.ShapeType.rect, { x: 2, y: 4.6, w: 6, h: 0.05, fill: { color: TITLE_CLR } });
        } else if (isLast) {
            s.addText(slide.title || 'Terima Kasih', { x: 0.5, y: 2.0, w: '90%', h: 1.2, fontSize: 40, bold: true, color: TITLE_CLR, align: 'center', fontFace: 'Calibri' });
            if (slide.bullets?.[0]) s.addText(slide.bullets[0], { x: 0.5, y: 3.5, w: '90%', h: 0.8, fontSize: 18, color: TXT, align: 'center', fontFace: 'Calibri', italic: true });
        } else {
            s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 1.1, fill: { color: '162130' } });
            s.addText(slide.title || `Slide ${idx + 1}`, { x: 0.4, y: 0.1, w: '90%', h: 0.9, fontSize: 24, bold: true, color: TITLE_CLR, fontFace: 'Calibri', valign: 'middle' });
            s.addText(String(idx + 1), { x: 9.2, y: 0.15, w: 0.5, h: 0.7, fontSize: 14, color: ACCENT, bold: true, align: 'right' });
            const bullets = (slide.bullets || []).map(b => ({ text: b, options: { fontSize: 18, color: TXT, bullet: { color: ACCENT }, paraSpaceAfter: 6 } }));
            if (bullets.length > 0) s.addText(bullets, { x: 0.5, y: 1.3, w: '90%', h: 4.2, fontFace: 'Calibri', valign: 'top' });
        }
        if (slide.notes) s.addNotes(slide.notes);
        s.addText(`${idx + 1} / ${slides.length}`, { x: 0, y: 5.1, w: '100%', h: 0.3, fontSize: 10, color: '888888', align: 'right' });
    });

    const judul    = topik.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, '_').trim();
    const fileName = `${judul}_${Date.now()}.pptx`;
    const filePath = path.join(DOCS_DIR, fileName);
    await pptx.writeFile({ fileName: filePath });
    return { filePath, fileName, slideCount: slides.length };
}

// =============================================================
// OWNER TERMINAL — Jalankan perintah & install module dari WA
// =============================================================

/**
 * Jalankan perintah shell, kembalikan output sebagai string.
 * Hanya bisa dipanggil oleh NOMOR_OWNER.
 */
function runShell(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { cwd: __dirname, timeout: 60000 }, (error, stdout, stderr) => {
            let out = '';
            if (stdout) out += `✅ OUTPUT:\n${stdout.trim()}\n`;
            if (stderr) out += `⚠️ STDERR:\n${stderr.trim()}\n`;
            if (error && !stdout && !stderr) out += `❌ ERROR: ${error.message}`;
            resolve(out.trim() || '(Selesai, tidak ada output)');
        });
    });
}

/**
 * Install npm package secara otomatis.
 * Contoh perintah WA: !install axios
 */
async function installModule(sock, jid, moduleName, quoted) {
    // Validasi nama module (hanya huruf, angka, -, /, @)
    if (!/^[@a-zA-Z0-9\-_/. ]+$/.test(moduleName)) {
        await sock.sendMessage(jid, { text: '❌ Nama module tidak valid.' }, { quoted });
        return;
    }
    await sock.sendMessage(jid, { text: `📦 Menginstall *${moduleName}*...\n(Tunggu sebentar)` }, { quoted });
    const hasil = await runShell(`npm install ${moduleName} --save`);
    await sock.sendMessage(jid, { text: `📦 *npm install ${moduleName}*\n\n${hasil}` }, { quoted });
}

// =============================================================
// DETEKSI INTENT
// =============================================================
const isPptRequest   = t => /buat(kan)?\s+(presentasi|ppt|powerpoint|slide)/i.test(t);
const isDocRequest   = t => /buat(kan)?\s+(dokumen|surat|laporan|proposal|artikel|makalah|resume|cv|rangkuman|ringkasan)/i.test(t);
const isSearchJurnal = t => /cari(kan)?\s+(jurnal|paper|artikel\s+ilmiah|penelitian)/i.test(t);
const isSearchBuku   = t => /cari(kan)?\s+(buku|referensi\s+buku)/i.test(t);
const isSearchUmum   = t => /cari(kan)?\s+/i.test(t) && !isSearchJurnal(t) && !isSearchBuku(t);
const extractSlideCount = t => { const m = t.match(/(\d+)\s*slide/i); return m ? Math.min(parseInt(m[1]), 30) : 10; };

// =============================================================
// BOT WHATSAPP (Baileys)
// =============================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('sesi_bot');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            waSocket = sock;
            console.log('✅ Bot WhatsApp Berhasil Terhubung!');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (msg.key.fromMe || m.type !== 'notify') return;

        const jid      = msg.key.remoteJid;
        const pengirim = msg.key.participant || msg.key.remoteJid;
        const isOwner  = pengirim.replace('@s.whatsapp.net', '') === NOMOR_OWNER ||
                         jid.replace('@s.whatsapp.net', '') === NOMOR_OWNER;
        const pesan    = msg.message?.conversation
                      || msg.message?.extendedTextMessage?.text
                      || msg.message?.documentMessage?.caption
                      || msg.message?.imageMessage?.caption
                      || '';

        const nomorBotJid    = `${NOMOR_BOT}@s.whatsapp.net`;
        const nomorBotLidJid = `${NOMOR_BOT_LID}@lid`;
        const tagArray  = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isDM      = !jid.endsWith('@g.us');
        const aiTrigger = tagArray.includes(nomorBotJid) || tagArray.includes(nomorBotLidJid) || isDM;

        // ----------------------------------------------------------------
        // OWNER-ONLY COMMANDS
        // ----------------------------------------------------------------
        if (isOwner) {
            // Install module: !install <nama>
            if (pesan.startsWith('!install ')) {
                const moduleName = pesan.replace('!install ', '').trim();
                await installModule(sock, jid, moduleName, msg);
                return;
            }

            // Terminal langsung: > <perintah>
            if (pesan.startsWith('> ')) {
                await sock.sendMessage(jid, { text: '⚙️ Menjalankan...' }, { quoted: msg });
                const hasil = await runShell(pesan.slice(2));
                // Pecah output panjang
                const parts = splitMessage(hasil);
                for (let i = 0; i < parts.length; i++) {
                    const h = parts.length > 1 ? `_(${i + 1}/${parts.length})_\n\n` : '';
                    await sock.sendMessage(jid, { text: `💻 *Terminal Output*\n\n${h}${parts[i]}` });
                    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 500));
                }
                return;
            }

            // Restart bot: !restart
            if (pesan === '!restart') {
                await sock.sendMessage(jid, { text: '🔄 Bot akan restart...' });
                setTimeout(() => process.exit(0), 1500); // Jika pakai PM2/nodemon, akan otomatis restart
                return;
            }
        }

        // ----------------------------------------------------------------
        // FILE HANDLER — PDF, PPTX, Gambar
        // ----------------------------------------------------------------
        const docMsg   = msg.message?.documentMessage;
        const imageMsg = msg.message?.imageMessage;

        if ((docMsg || imageMsg) && aiTrigger) {
            const caption  = pesan.trim() || 'Tolong analisis dan rangkum isi file ini.';
            const mimeType = docMsg?.mimetype || imageMsg?.mimetype || '';
            const fileName = docMsg?.fileName || '';

            await sock.sendMessage(jid, { text: '📂 *Necro AI* sedang membaca file...' }, { quoted: msg });

            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});

                const isPptx  = mimeType.includes('presentationml') || mimeType.includes('powerpoint') || /\.pptx?$/i.test(fileName);
                const isPdf   = mimeType === 'application/pdf' || /\.pdf$/i.test(fileName);
                const isImage = mimeType.startsWith('image/');

                if (isPptx) {
                    const tmp = path.join(os.tmpdir(), `pptx_${Date.now()}.pptx`);
                    fs.writeFileSync(tmp, buffer);
                    const docText = await officeParser.parseOfficeAsync(tmp).finally(() => { try { fs.unlinkSync(tmp); } catch {} });
                    const jawaban = await askGeminiWithText(caption, docText || '(file kosong)');
                    await sendLongMessage(sock, jid, `👁️ *Necro AI (PPT)*\n\n${jawaban}`, { mentions: [pengirim] });
                    if (/simpan|buat dokumen|save/i.test(caption)) {
                        const out = saveTextDoc(`analisis_ppt_${Date.now()}.txt`, jawaban);
                        await sock.sendMessage(jid, { document: fs.readFileSync(out), fileName: path.basename(out), mimetype: 'text/plain', caption: '📎 Hasil analisis PPT.' });
                    }
                } else if (isPdf) {
                    const jawaban = await askGeminiWithFile(caption, buffer, 'application/pdf');
                    await sendLongMessage(sock, jid, `👁️ *Necro AI (PDF)*\n\n${jawaban}`, { mentions: [pengirim] });
                    if (/simpan|buat dokumen|save/i.test(caption)) {
                        const out = saveTextDoc(`analisis_pdf_${Date.now()}.txt`, jawaban);
                        await sock.sendMessage(jid, { document: fs.readFileSync(out), fileName: path.basename(out), mimetype: 'text/plain', caption: '📎 Hasil analisis PDF.' });
                    }
                } else if (isImage) {
                    const jawaban = await askGeminiWithFile(caption, buffer, mimeType);
                    await sendLongMessage(sock, jid, `👁️ *Necro AI (Gambar)*\n\n${jawaban}`, { mentions: [pengirim] });
                } else {
                    await sock.sendMessage(jid, { text: '❌ Format tidak didukung. Kirim PDF, PPTX, atau gambar.' }, { quoted: msg });
                }
            } catch (err) {
                await sock.sendMessage(jid, {
                    text: err.message === 'TIMEOUT' ? '⏱️ Maaf, AI sedang sibuk. Coba beberapa saat lagi.' : `❌ Gagal membaca file: ${err.message}`,
                    mentions: [pengirim]
                }, { quoted: msg });
            }
            return;
        }

        // ----------------------------------------------------------------
        // AI TEXT HANDLER
        // ----------------------------------------------------------------
        if (aiTrigger && pesan) {
            const q = pesan.replace(/@\d+/g, '').trim();
            const isCmd = /^!(menu|ping|play|web|catur|skor|spotify|chess|move|install|restart|musik|tictactoe|ulartangga)/.test(q);
            if (!q || isCmd) { /* lanjut ke command center */ }
            else {
                await sock.sendMessage(jid, { text: '🧠 *Necro AI* sedang memproses...' }, { quoted: msg });
                try {
                    // Buat PPT
                    if (isPptRequest(q)) {
                        const jumlah = extractSlideCount(q);
                        const topik  = q.replace(/buat(kan)?\s+(presentasi|ppt|powerpoint|slide)/gi, '').replace(/\d+\s*slide/gi, '').trim() || q;
                        await sock.sendMessage(jid, { text: `🎨 Membuat PPT "${topik}" (${jumlah} slide)...` }, { quoted: msg });
                        const { filePath, fileName, slideCount } = await buildPptx(topik, jumlah);
                        await sock.sendMessage(jid, {
                            document: fs.readFileSync(filePath), fileName,
                            mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                            caption: `✅ *"${topik}"* selesai!\n📊 ${slideCount} slide — buka dengan PowerPoint / Google Slides`,
                            mentions: [pengirim]
                        });
                        return;
                    }

                    // Buat Dokumen
                    if (isDocRequest(q)) {
                        const jawaban  = await askGemini(q, 'Kamu adalah asisten profesional. Buat dokumen yang diminta dengan format lengkap dan terstruktur.');
                        const judul    = q.slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim();
                        const filePath = saveTextDoc(`${judul || 'dokumen'}_${Date.now()}.txt`, jawaban);
                        await sendLongMessage(sock, jid, `📄 *Dokumen*\n\n${jawaban}`, { mentions: [pengirim] });
                        await sock.sendMessage(jid, { document: fs.readFileSync(filePath), fileName: path.basename(filePath), mimetype: 'text/plain', caption: `📎 File dokumen tersedia.` });
                        return;
                    }

                    // Cari jurnal
                    if (isSearchJurnal(q)) {
                        const keyword = q.replace(/cari(kan)?\s+(jurnal|paper|artikel\s+ilmiah|penelitian)/gi, '').trim();
                        const hasil   = await searchAcademic(keyword, 'jurnal');
                        await sendLongMessage(sock, jid, hasil, { mentions: [pengirim] });
                        return;
                    }

                    // Cari buku
                    if (isSearchBuku(q)) {
                        const keyword = q.replace(/cari(kan)?\s+(buku|referensi\s+buku)/gi, '').trim();
                        const hasil   = await searchAcademic(keyword, 'buku');
                        await sendLongMessage(sock, jid, hasil, { mentions: [pengirim] });
                        return;
                    }

                    // Cari umum
                    if (isSearchUmum(q)) {
                        const keyword = q.replace(/cari(kan)?\s+/gi, '').trim();
                        const hasil   = await searchAcademic(keyword, 'semua');
                        await sendLongMessage(sock, jid, hasil, { mentions: [pengirim] });
                        return;
                    }

                    // Pertanyaan umum
                    const jawaban = await askGemini(q, 'Kamu adalah asisten AI yang cerdas dan menjawab dalam Bahasa Indonesia secara lengkap dan terperinci.');
                    await sendLongMessage(sock, jid, `👁️ *Necro AI*\n\n${jawaban}`, { mentions: [pengirim] });

                } catch (err) {
                    await sock.sendMessage(jid, {
                        text: err.message === 'TIMEOUT' ? '⏱️ Maaf, AI sedang sibuk. Coba beberapa saat lagi.' : `❌ AI Error: ${err.message}`,
                        mentions: [pengirim]
                    }, { quoted: msg });
                }
                return;
            }
        }

        if (!pesan) return;

        // ----------------------------------------------------------------
        // COMMAND CENTER
        // ----------------------------------------------------------------
        if (pesan === '!menu') {
            const ownerCmds = isOwner
                ? `\n\n⚙️ *OWNER ONLY:*\n▸ *> perintah* — Terminal server\n▸ *!install nama-module* — Install npm package\n▸ *!restart* — Restart bot`
                : '';
            const menu =
                `💀 *NECROBOT COMMAND CENTER* 💀\n\n` +
                `▸ *!ping* — Cek status\n` +
                `▸ *!play* — Web Portal\n` +
                `▸ *!web* — Website Utama\n` +
                `▸ *!skor* — Leaderboard\n\n` +
                `🎮 *IN-APP GAME BROWSER (NEW!):*\n` +
                `▸ *!catur* — Papan Catur Interaktif\n` +
                `▸ *!tictactoe* — Arena Tic-Tac-Toe\n` +
                `▸ *!ulartangga* — Kocok Dadu Ular Tangga\n` +
                `▸ *!musik* — Necro Music Player\n` +
                `▸ *!spotify [link]* — Putar Link Spotify\n\n` +
                `🤖 *AI (tag bot / DM):*\n` +
                `▸ Tanya apa saja\n` +
                `▸ _"Carikan jurnal tentang X"_\n` +
                `▸ _"Buatkan presentasi tentang X [N slide]"_\n` +
                `▸ Kirim *PDF/PPTX/gambar* + pertanyaan` +
                ownerCmds;
            await sock.sendMessage(jid, { text: menu });
            return;
        }

        if (pesan === '!ping') { await sock.sendMessage(jid, { text: '✅ Sistem aktif.' }); return; }

        if (pesan === '!play') {
            await sock.sendMessage(jid, { text: `🎮 *PORTAL GAME*\n\n${LINK_GAME}`, linkPreview: true });
            return;
        }

        if (pesan === '!web') {
            await sock.sendMessage(jid, { text: `🌐 *NECROMAN NETWORK*\n\n${LINK_WEB}`, linkPreview: true });
            return;
        }

        // --- PERINTAH CATUR ---
        if (pesan === '!catur') {
            const link = `http://${IP_VPS}:${PORT}/catur`;
            await sock.sendMessage(jid, {
                text: "♟️ *NECRO CHESS ARENA*\n\nKetuk gambar kartu di bawah ini untuk membuka papan catur interaktif!",
                contextInfo: {
                    externalAdReply: {
                        title: "🎮 Mainkan Catur Sekarang",
                        body: "Necro AI - In-App Browser",
                        thumbnailUrl: "https://i.imgur.com/6E2bS4A.jpeg", // Ilustrasi papan catur cyber
                        sourceUrl: link,
                        mediaType: 1,
                        renderLargerThumbnail: true
                    }
                }
            });
            return;
        }

        // --- PERINTAH MUSIK ---
        if (pesan === '!musik') {
            const linkMusik = `http://${IP_VPS}:${PORT}/musik.html`;
            await sock.sendMessage(jid, {
                text: "🎧 *NECRO MUSIC PLAYER*\n\nKetuk gambar di bawah ini untuk memutar lagu langsung di WA!",
                contextInfo: {
                    externalAdReply: {
                        title: "▶️ Buka Pemutar Musik",
                        body: "Media Stream - YouTube & Spotify",
                        thumbnailUrl: "https://i.imgur.com/x49C24R.jpeg", // Ilustrasi musik
                        sourceUrl: linkMusik,
                        mediaType: 1,
                        renderLargerThumbnail: true
                    }
                }
            });
            return;
        }

        // --- PERINTAH ULAR TANGGA ---
        if (pesan === '!ulartangga') {
            const linkUT = `http://${IP_VPS}:${PORT}/ular-tangga.html`;
            await sock.sendMessage(jid, {
                text: "🐍🪜 *ARENA ULAR TANGGA*\n\nKetuk arena di bawah ini untuk mulai mengocok dadu!",
                contextInfo: {
                    externalAdReply: {
                        title: "🎲 Buka Ular Tangga",
                        body: "Necro AI Mini Games",
                        thumbnailUrl: "https://i.imgur.com/s1DtdwN.jpeg", // Ilustrasi ular tangga
                        sourceUrl: linkUT,
                        mediaType: 1,
                        renderLargerThumbnail: true
                    }
                }
            });
            return;
        }
        
        // --- PERINTAH TIC-TAC-TOE ---
        if (pesan === '!tictactoe') {
            const linkTTT = `http://${IP_VPS}:${PORT}/tictactoe.html`;
            await sock.sendMessage(jid, {
                text: "❌⭕ *ARENA TIC-TAC-TOE*\n\nKetuk gambar di bawah ini untuk menguji ketangkasanmu!",
                contextInfo: {
                    externalAdReply: {
                        title: "🎮 Main Tic-Tac-Toe",
                        body: "Necro AI Mini Games",
                        thumbnailUrl: "https://i.imgur.com/bXjXzO5.png", // Ilustrasi Tic-Tac-Toe
                        sourceUrl: linkTTT,
                        mediaType: 1,
                        renderLargerThumbnail: true
                    }
                }
            });
            return;
        }
        
        // Catur CLI (PNG — mode lama, tetap ada)
        if (pesan === '!chess start') {
            sesiCatur[jid] = new Chess();
            const fenUrl = `https://fen2image.chessvision.ai/${encodeURIComponent(sesiCatur[jid].fen())}`;
            await sock.sendMessage(jid, { image: { url: fenUrl }, caption: '♟️ *Catur CLI*\nGunakan: *!move [dari] [ke]*\nContoh: *!move e2 e4*' });
            return;
        }

        if (pesan.startsWith('!move ')) {
            if (!sesiCatur[jid]) return;
            const [, from, to] = pesan.split(' ');
            if (!from || !to) return;
            try {
                sesiCatur[jid].move({ from, to });
                const fenUrl = `https://fen2image.chessvision.ai/${encodeURIComponent(sesiCatur[jid].fen())}`;
                let status = 'Giliran selanjutnya!';
                if (sesiCatur[jid].isCheckmate()) { status = '🏆 *SKAKMAT!*'; delete sesiCatur[jid]; }
                await sock.sendMessage(jid, { image: { url: fenUrl }, caption: status });
            } catch { await sock.sendMessage(jid, { text: '❌ Langkah ilegal!' }); }
            return;
        }
    });
}

// =============================================================
// POST /webhook
// =============================================================
app.post('/webhook', async (req, res) => {
    const { sender, message } = req.body || {};
    let cleanedSender;
    try { cleanedSender = cleanAndValidatePhone(sender); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    if (typeof message !== 'string' || message.trim() === '')
        return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    if (!waSocket)
        return res.status(503).json({ error: 'Bot belum terhubung.' });

    const recipientJid = `${cleanedSender}@s.whatsapp.net`;
    const FALLBACK = 'Maaf, asisten AI sedang sibuk. Silakan coba beberapa saat lagi.';
    const q = message.trim();

    try {
        if (isPptRequest(q)) {
            const jumlah = extractSlideCount(q);
            const topik  = q.replace(/buat(kan)?\s+(presentasi|ppt|powerpoint|slide)/gi, '').replace(/\d+\s*slide/gi, '').trim() || q;
            const { filePath, fileName, slideCount } = await buildPptx(topik, jumlah);
            await waSocket.sendMessage(recipientJid, {
                document: fs.readFileSync(filePath), fileName,
                mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                caption: `✅ "${topik}" — ${slideCount} slide`
            });
            return res.json({ status: 'ok', type: 'pptx' });
        }
        if (isSearchJurnal(q)) {
            const hasil = await searchAcademic(q.replace(/cari(kan)?\s+(jurnal|paper|artikel\s+ilmiah|penelitian)/gi, '').trim(), 'jurnal');
            const parts = splitMessage(hasil);
            for (const p of parts) await waSocket.sendMessage(recipientJid, { text: p });
            return res.json({ status: 'ok', type: 'search' });
        }
        const aiReply = await askGemini(q, 'Kamu adalah asisten AI yang menjawab dalam Bahasa Indonesia secara lengkap.');
        const parts   = splitMessage(aiReply);
        for (let i = 0; i < parts.length; i++) {
            const h = parts.length > 1 ? `_(${i + 1}/${parts.length})_\n\n` : '';
            await waSocket.sendMessage(recipientJid, { text: h + parts[i] });
            if (i < parts.length - 1) await new Promise(r => setTimeout(r, 800));
        }
        return res.json({ status: 'ok', type: 'text' });
    } catch (err) {
        console.error('[Webhook]', err.message);
        try { await waSocket.sendMessage(recipientJid, { text: FALLBACK }); } catch {}
        return res.json({ status: 'fallback_sent', reason: err.message });
    }
});

// =============================================================
// START SERVER
// =============================================================
server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
    console.log(`♟️  Catur multiplayer: http://localhost:${PORT}/catur`);
    startBot();
});
