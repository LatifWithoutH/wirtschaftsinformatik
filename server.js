require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const session = require('express-session');
const bcrypt = require('bcryptjs');

// 🔹 IMPORT GAS UPLOADER (Jembatan ke Google Drive)
const { uploadFileToDrive } = require('./utils/gasUploader');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// 🔹 Session Config
app.use(session({
  secret: process.env.SESSION_SECRET || 'uniba-dudika-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// 🔹 Middleware: Proteksi Route berdasarkan Role
function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (allowedRoles.length && !allowedRoles.includes(req.session.user.role)) {
      return res.status(403).send('❌ Akses ditolak: Role tidak memiliki izin');
    }
    next();
  };
}

// ✅ Inisialisasi Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 🔹 SETUP MULTER (Upload Handler - Simpan di Memory)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Max 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan!'), false);
  }
});

// 🔹 SETUP NODemailer (Email Transporter)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// 🔹 FUNGSI: Kirim Email Alert
async function sendAlertEmail({ to, subject, mitra }) {
  const htmlContent = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #d32f2f;">⚠️ Peringatan: Masa Kerja Sama Hampir Berakhir</h2>
      <p><strong>Instansi:</strong> ${mitra.nama_instansi}</p>
      <p><strong>Kontak:</strong> ${mitra.nama_kontak || '-'} (${mitra.no_hp_kontak || '-'})</p>
      <p><strong>Email Fakultas:</strong> ${mitra.email_fakultas}</p>
      <p><strong>Tanggal Mulai:</strong> ${new Date(mitra.tanggal_mulai).toLocaleDateString('id-ID')}</p>
      <p><strong>Tanggal Berakhir:</strong> ${new Date(mitra.tanggal_berakhir).toLocaleDateString('id-ID')}</p>
      <p style="background: #fff3cd; padding: 10px; border-radius: 4px; border-left: 4px solid #ffc107;">
        <strong>📅 Sisa Waktu:</strong> ${mitra.sisa_hari} hari lagi
      </p>
      <h3>📎 Dokumen Legalitas:</h3>
      <ul>
        ${mitra.file_mou ? `<li><a href="${mitra.file_mou}" target="_blank">MoU</a></li>` : '<li>MoU: Belum diupload</li>'}
        ${mitra.file_moa ? `<li><a href="${mitra.file_moa}" target="_blank">MoA</a></li>` : '<li>MoA: Belum diupload</li>'}
        ${mitra.file_ia ? `<li><a href="${mitra.file_ia}" target="_blank">IA</a></li>` : '<li>IA: Belum diupload</li>'}
        ${mitra.file_pks ? `<li><a href="${mitra.file_pks}" target="_blank">PKS</a></li>` : '<li>PKS: Belum diupload</li>'}
      </ul>
      <p style="margin-top: 20px; font-size: 13px; color: #666;">
        💡 Silakan segera koordinasi dengan pihak mitra untuk perpanjangan kerja sama.<br>
        Email ini dikirim otomatis oleh <strong>SI Mitra DUDIKA UNIBA Surakarta</strong>.
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"SI Mitra DUDIKA" <${process.env.EMAIL_USER}>`,
      to: Array.isArray(to) ? to.join(',') : to,
      subject: subject,
      html: htmlContent
    });
    console.log(`✅ Email alert terkirim ke: ${to}`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim email:', err.message);
    return false;
  }
}

// 🔹 HOME → Redirect ke Dashboard
app.get('/', (req, res) => res.redirect('/dashboard'));

// 🔹 LOGIN ROUTES
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) return res.render('login', { error: '❌ Email tidak ditemukan' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.render('login', { error: '❌ Password salah' });

    req.session.user = { id: user.id, email: user.email, role: user.role, fakultas_id: user.fakultas_id };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: '❌ Terjadi kesalahan sistem' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// 🔹 DASHBOARD MODERN (Stats + Charts)
app.get('/dashboard', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    
    let query = supabase.from('mitra').select('*');
    if (req.session.user.role === 'admin_fakultas' && req.session.user.fakultas_id) {
      query = query.ilike('email_fakultas', `%${req.session.user.fakultas_id}%`);
    }
    
    const { data: allMitra, error } = await query;
    if (error) throw error;
    
    const stats = { total: 0, aktif: 0, akan_berakhir: 0, segera_berakhir: 0, expired: 0 };
    const segeraBerakhir = [];
    
    (allMitra || []).forEach(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      if (isNaN(endDate.getTime())) return;
      
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      if (diffDays < 0) stats.expired++;
      else if (diffDays <= 7) { stats.segera_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#dc3545' }); }
      else if (diffDays <= 30) { stats.akan_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#ffc107' }); }
      else stats.aktif++;
    });
    stats.total = (allMitra || []).length;
    segeraBerakhir.sort((a,b) => a.sisa_hari - b.sisa_hari);
    
    res.render('dashboard', { 
      stats, 
      segeraBerakhir, 
      user: req.session.user,
      activePage: 'dashboard',
      alertCount: segeraBerakhir.length
    });
  } catch (err) {
    console.error('❌ Error dashboard:', err.message);
    res.status(500).send('Gagal memuat dashboard. Silakan coba lagi.');
  }
});

// 🔹 DAFTAR MITRA (Tabel Improved)
app.get('/mitra', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    
    let query = supabase
      .from('mitra')
      .select('*')
      .order('tanggal_berakhir', { ascending: true });
    
    if (req.session.user.role === 'admin_fakultas' && req.session.user.fakultas_id) {
      query = query.ilike('email_fakultas', `%${req.session.user.fakultas_id}%`);
    }
    
    const { data: mitraList, error } = await query;
    if (error) throw error;

    const mitraDenganStatus = (mitraList || []).map(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      if (isNaN(endDate.getTime())) return { ...mitra, sisa_hari: 0, status: 'Invalid', color: '#999', badgeClass: 'expired' };
      
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      let status, color, badgeClass;
      if (diffDays < 0) { status = 'Expired'; color = '#6c757d'; badgeClass = 'expired'; }
      else if (diffDays <= 7) { status = 'Segera Berakhir'; color = '#dc3545'; badgeClass = 'danger'; }
      else if (diffDays <= 30) { status = 'Akan Berakhir'; color = '#ffc107'; badgeClass = 'warning'; }
      else { status = 'Aktif'; color = '#28a745'; badgeClass = 'active'; }
      return { ...mitra, sisa_hari: diffDays, status, color, badgeClass };
    });

    // Hitung alert count untuk sidebar
    const alertCount = mitraDenganStatus.filter(m => m.sisa_hari > 0 && m.sisa_hari <= 30).length;

    res.render('mitra-table', { 
      mitra: mitraDenganStatus, 
      user: req.session.user,
      activePage: 'mitra',
      alertCount: alertCount
    });
  } catch (err) {
    console.error('❌ Error table view:', err.message);
    res.status(500).send('Gagal memuat daftar mitra. Silakan coba lagi.');
  }
});

// 🔹 FORM Tambah Mitra — HANYA HUMAS
app.get('/mitra/tambah', requireAuth('humas'), (req, res) => 
  res.render('form-mitra', { 
    mitra: null, 
    action: 'tambah', 
    user: req.session.user,
    activePage: 'tambah',
    alertCount: 0
  })
);

// 🔹 POST Simpan Data Mitra + Generate kode_mitra
app.post('/mitra', requireAuth('humas'), async (req, res) => {
  try {
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir } = req.body;
    const { count } = await supabase.from('mitra').select('*', { count: 'exact', head: true });
    const kode_mitra = `MITRA-${String((count || 0) + 1).padStart(4, '0')}`;
    const { error } = await supabase.from('mitra').insert({ kode_mitra, nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir });
    if (error) throw error;
    res.redirect('/mitra');
  } catch (err) {
    console.error('❌ Error insert mitra:', err.message);
    res.status(500).send('Gagal menyimpan data. Silakan coba lagi.');
  }
});

// 🔹 UPLOAD PDF — ✅ GANTI KE GOOGLE DRIVE VIA GAS BRIDGE
app.post('/mitra/:id/upload', requireAuth('humas', 'admin_fakultas'), upload.single('file_pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    const { jenis_file } = req.body;
    
    // 🔹 Cek: admin_fakultas hanya bisa upload untuk mitra fakultas sendiri
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase
        .from('mitra')
        .select('email_fakultas')
        .eq('id', id)
        .single();
      
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengupload dokumen untuk mitra fakultas Anda');
      }
    }
    
    if (!req.file) throw new Error('File tidak ditemukan');
    if (!['mou', 'moa', 'ia', 'pks'].includes(jenis_file)) throw new Error('Jenis file tidak valid');
    
    console.log(`\n📤 [UPLOAD] Menerima file: ${req.file.originalname}`);
    console.log(`   Jenis: ${jenis_file.toUpperCase()}`);
    console.log(`   Ukuran: ${(req.file.size / 1024).toFixed(2)} KB`);
    console.log(`   Mitra ID: ${id}`);
    
    // 🚀 UPLOAD KE GOOGLE DRIVE VIA GAS BRIDGE
    console.log('🚀 Mengirim ke Google Drive via GAS...');
    const driveLink = await uploadFileToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
    
    console.log(`✅ File berhasil masuk Drive!`);
    console.log(`🔗 Link: ${driveLink}`);
    
    // 💾 SIMPAN LINK KE DATABASE SUPABASE
    const fieldName = `file_${jenis_file}`;
    const { error: dbError } = await supabase
      .from('mitra')
      .update({ [fieldName]: driveLink })
      .eq('id', id);
    
    if (dbError) throw dbError;
    
    console.log(`💾 Link berhasil disimpan ke kolom ${fieldName} untuk Mitra ID ${id}`);
    console.log('─'.repeat(50));
    
    res.redirect(`/mitra/${id}`);
  } catch (err) {
    console.error('❌ Error upload:', err.message);
    res.status(500).send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #dc3545;">❌ Upload Gagal</h1>
        <p>${err.message}</p>
        <a href="/mitra/${req.params.id}" style="color: #003366;">← Kembali ke Detail Mitra</a>
      </div>
    `);
  }
});

// 🔹 DETAIL MITRA
app.get('/mitra/:id', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { id } = req.params;
    console.log('🔍 Mencari mitra dengan ID:', id);
    
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error) { console.error('❌ Supabase Error:', error); return res.status(500).send('❌ Database Error. Silakan coba lagi.'); }
    if (!mitra) { console.warn('⚠️ Mitra tidak ditemukan untuk ID:', id); return res.status(404).send('❌ Mitra tidak ditemukan'); }
    
    console.log('✅ Data mitra ditemukan:', mitra.nama_instansi);
    const today = new Date();
    const endDate = new Date(mitra.tanggal_berakhir);
    if (isNaN(endDate.getTime())) { console.error('❌ Invalid date:', mitra.tanggal_berakhir); return res.status(500).send('❌ Format tanggal_berakhir tidak valid'); }
    
    const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
    let status, color;
    if (diffDays < 0) { status = 'Expired'; color = '#6c757d'; }
    else if (diffDays <= 7) { status = 'Segera Berakhir'; color = '#dc3545'; }
    else if (diffDays <= 30) { status = 'Akan Berakhir'; color = '#ffc107'; }
    else { status = 'Aktif'; color = '#28a745'; }
    
    console.log(`📊 Status: ${status} (${diffDays} hari)`);
    
    res.render('detail-mitra', { 
      mitra: { ...mitra, sisa_hari: diffDays, status, color }, 
      user: req.session.user,
      activePage: 'mitra',
      alertCount: 0
    });
  } catch (err) {
    console.error('💥 Unexpected Error:', err);
    res.status(500).send('Gagal memuat detail mitra. Silakan coba lagi.');
  }
});

// 🔹 Redirect by Kode Mitra
app.get('/mitra/kode/:kode', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('id').eq('kode_mitra', kode.toUpperCase()).single();
    if (error || !mitra) throw new Error('Kode mitra tidak ditemukan');
    res.redirect(`/mitra/${mitra.id}`);
  } catch (err) { res.status(404).send('❌ Mitra dengan kode tersebut tidak ditemukan'); }
});

// 🔹 FORM Edit
app.get('/mitra/:id/edit', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase
        .from('mitra')
        .select('email_fakultas')
        .eq('id', id)
        .single();
      
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengedit mitra fakultas Anda');
      }
    }
    
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    
    res.render('form-mitra', { 
      mitra, 
      action: 'edit', 
      user: req.session.user,
      activePage: 'tambah',
      alertCount: 0
    });
  } catch (err) { res.status(500).send('Gagal memuat form edit. Silakan coba lagi.'); }
});

// 🔹 UPDATE Data Mitra
app.post('/mitra/:id/update', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase
        .from('mitra')
        .select('email_fakultas')
        .eq('id', id)
        .single();
      
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengupdate mitra fakultas Anda');
      }
    }
    
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir } = req.body;
    const { error } = await supabase.from('mitra').update({ nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir }).eq('id', id);
    if (error) throw error;
    res.redirect(`/mitra/${id}`);
  } catch (err) { console.error('❌ Error update:', err.message); res.status(500).send('Gagal update data. Silakan coba lagi.'); }
});

// 🔹 ROUTE: /test-alert
app.get('/test-alert', requireAuth('humas'), async (req, res) => {
  try {
    const today = new Date();
    const formatDateLocal = (date) => date.toISOString().split('T')[0];
    
    const todayStr = formatDateLocal(today);
    const maxDate = new Date(); 
    maxDate.setDate(today.getDate() + 30);
    const maxDateStr = formatDateLocal(maxDate);

    const { data: allMitra, error } = await supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (error) throw error;

    const mitraInRange = (allMitra || []).filter(m => {
      const endDate = new Date(m.tanggal_berakhir);
      const sisa = Math.ceil((endDate - today) / (1000*60*60*24));
      return sisa >= 0 && sisa <= 30;
    }).map(m => ({
      ...m,
      sisa_hari: Math.ceil((new Date(m.tanggal_berakhir) - today) / (1000*60*60*24))
    }));

    res.render('test-alert', {
      serverTime: today.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }),
      todayStr,
      maxDateStr,
      totalMitra: (allMitra || []).length,
      inRangeCount: mitraInRange.length,
      mitraList: mitraInRange,
      user: req.session.user,
      activePage: 'alert',
      alertCount: mitraInRange.length
    });

  } catch (err) {
    console.error('💥 Test Alert Error:', err);
    res.status(500).send('❌ Gagal memuat halaman test alert.');
  }
});

// 🔹 POST: Kirim Email Test
app.post('/test-alert/send', requireAuth('humas'), async (req, res) => {
  try {
    const { mitra_id } = req.body;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', mitra_id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    const today = new Date();
    const endDate = new Date(mitra.tanggal_berakhir);
    const sisa_hari = Math.ceil((endDate - today) / (1000*60*60*24));
    const subject = `🧪 [TEST MANUAL] Alert: "${mitra.nama_instansi}" Berakhir dalam ${sisa_hari} Hari`;
    const sent = await sendAlertEmail({ to: mitra.email_fakultas, subject, mitra: { ...mitra, sisa_hari } });
    res.send(sent ? `✅ Email test terkirim ke ${mitra.email_fakultas}<br><a href="/test-alert">← Kembali</a>` : `❌ Gagal kirim. Cek terminal.`);
  } catch (err) { res.status(500).send('❌ Gagal kirim email test.'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server aktif di http://localhost:${PORT}`));