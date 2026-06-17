require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { uploadFileToDrive } = require('./utils/gasUploader');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// 🔧 Inisialisasi Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

// 🔹 FUNGSI: GENERATE PASSWORD ACAK YANG KUAT
function generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

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

// 🔹 Middleware: Cek Status User Aktif di Setiap Request
function checkUserActive(req, res, next) {
  if (!req.session.user) return next();
  
  supabase
    .from('users')
    .select('is_active')
    .eq('id', req.session.user.id)
    .single()
    .then(({ data, error }) => {
      if (error || !data) {
        req.session.destroy(() => res.redirect('/login'));
        return;
      }
      if (data.is_active === false) {
        console.warn(`🚫 Session dihentikan: User nonaktif → ${req.session.user.email}`);
        req.session.destroy(() => {
          res.render('login', { error: '🚫 Akun Anda telah dinonaktifkan. Hubungi Humas.' });
        });
        return;
      }
      next();
    })
    .catch(err => {
      console.error('❌ Error cek status user:', err);
      next();
    });
}

app.use('/dashboard', checkUserActive);
app.use('/mitra', checkUserActive);
app.use('/users', checkUserActive);
app.use('/test-alert', checkUserActive);
app.use('/change-password', checkUserActive);

// 🔹 SETUP MULTER
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Max 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan!'), false);
  }
});

// 🔹 SETUP NODemailer
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

// 🔹 ROUTES
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();

    if (error || !user) return res.render('login', { error: '❌ Email tidak ditemukan' });
    if (user.is_active === false) {
      return res.render('login', { error: '🚫 Akun Anda telah dinonaktifkan. Hubungi Humas.' });
    }

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

// ========================================================================
// 🚨 ROUTE DASHBOARD (SUDAH DIPERBAIKI: RESET JAM KE 00:00:00)
// ========================================================================
app.get('/dashboard', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // ✅ RESET JAM KE 00:00:00
    
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
      endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM KE 00:00:00
      
      if (isNaN(endDate.getTime())) return;
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      
      if (diffDays < 0) stats.expired++;
      else if (diffDays <= 7) { stats.segera_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#dc3545' }); }
      else if (diffDays <= 30) { stats.akan_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#ffc107' }); }
      else stats.aktif++;
    });
    stats.total = (allMitra || []).length;
    segeraBerakhir.sort((a,b) => a.sisa_hari - b.sisa_hari);
    
    res.render('dashboard', { stats, segeraBerakhir, user: req.session.user, activePage: 'dashboard', alertCount: segeraBerakhir.length });
  } catch (err) {
    console.error('❌ Error dashboard:', err.message);
    res.status(500).send('Gagal memuat dashboard.');
  }
});

// ========================================================================
// 🚨 ROUTE DAFTAR MITRA (SUDAH DIPERBAIKI: RESET JAM KE 00:00:00)
// ========================================================================
app.get('/mitra', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    let query = supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (req.session.user.role === 'admin_fakultas' && req.session.user.fakultas_id) {
      query = query.ilike('email_fakultas', `%${req.session.user.fakultas_id}%`);
    }
    
    const { data: mitraList, error } = await query;
    if (error) throw error;

    const mitraDenganStatus = (mitraList || []).map(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM
      
      if (isNaN(endDate.getTime())) return { ...mitra, sisa_hari: 0, status: 'Invalid', color: '#999', badgeClass: 'expired' };
      
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      let status, color, badgeClass;
      if (diffDays < 0) { status = 'Expired'; color = '#6c757d'; badgeClass = 'expired'; }
      else if (diffDays <= 7) { status = 'Segera Berakhir'; color = '#dc3545'; badgeClass = 'danger'; }
      else if (diffDays <= 30) { status = 'Akan Berakhir'; color = '#ffc107'; badgeClass = 'warning'; }
      else { status = 'Aktif'; color = '#28a745'; badgeClass = 'active'; }
      return { ...mitra, sisa_hari: diffDays, status, color, badgeClass };
    });

    const alertCount = mitraDenganStatus.filter(m => m.sisa_hari > 0 && m.sisa_hari <= 30).length;
    res.render('mitra-table', { mitra: mitraDenganStatus, user: req.session.user, activePage: 'mitra', alertCount });
  } catch (err) {
    console.error('❌ Error table view:', err.message);
    res.status(500).send('Gagal memuat daftar mitra.');
  }
});

app.get('/mitra/tambah', requireAuth('humas'), (req, res) => 
  res.render('form-mitra', { mitra: null, action: 'tambah', user: req.session.user, activePage: 'tambah', alertCount: 0 })
);

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
    res.status(500).send('Gagal menyimpan data.');
  }
});

// ========================================================================
// 🚨 ROUTE UPLOAD PDF (VERSI LENGKAP: DEBUG + AJAX JSON + NAMA INSTANSI)
// ========================================================================
app.post('/mitra/:id/upload', requireAuth('humas', 'admin_fakultas'), upload.single('file_pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    const { jenis_file } = req.body;
    
    console.log('\n========================================');
    console.log('🔍 [DEBUG UPLOAD] Data dari form:');
    console.log('   - Mitra ID:', id);
    console.log('   - Jenis File:', jenis_file);
    console.log('   - File ada?:', !!req.file);
    if (req.file) {
      console.log('   - Nama File:', req.file.originalname);
      console.log('   - Ukuran:', (req.file.size / 1024).toFixed(2), 'KB');
      console.log('   - MIME Type:', req.file.mimetype);
    }
    console.log('========================================\n');
    
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase.from('mitra').select('email_fakultas').eq('id', id).single();
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).json({ success: false, message: '❌ Anda hanya dapat mengupload dokumen untuk mitra fakultas Anda' });
      }
    }
    
    if (!req.file) throw new Error('File tidak ditemukan');
    if (!['mou', 'moa', 'ia', 'pks'].includes(jenis_file)) throw new Error('Jenis file tidak valid');
    
    console.log(`\n📤 [UPLOAD] ${req.file.originalname} | ${jenis_file.toUpperCase()} | Mitra ID: ${id}`);
    
    console.log('🔍 [DEBUG] Mengambil data mitra dari database...');
    const { data: mitraData, error: mitraError } = await supabase
      .from('mitra')
      .select('nama_instansi, kode_mitra')
      .eq('id', id)
      .single();
    
    if (mitraError) console.error('❌ [DEBUG] Error query database:', mitraError.message);
    console.log('✅ [DEBUG] Data mitra:', mitraData);
      
    if (mitraError || !mitraData) throw new Error('Data mitra tidak ditemukan di database');
    
    console.log('\n🔍 [DEBUG] Siap mengirim ke gasUploader:');
    console.log('   - Buffer size:', req.file.buffer.length, 'bytes');
    console.log('   - Nama instansi:', mitraData.nama_instansi);
    console.log('========================================\n');
    
    // Panggil fungsi upload dengan 4 parameter
    const driveLink = await uploadFileToDrive(
      req.file.buffer, 
      req.file.originalname, 
      req.file.mimetype,
      mitraData.nama_instansi 
    );
    
    console.log('\n✅ [DEBUG] Response dari gasUploader:');
    console.log('   - Drive Link:', driveLink);
    console.log('========================================\n');
    
    const fieldName = `file_${jenis_file}`;
    console.log(`🔍 [DEBUG] Update database: kolom "${fieldName}" dengan link Drive`);
    
    const { error: dbError } = await supabase
      .from('mitra')
      .update({ [fieldName]: driveLink })
      .eq('id', id);
    
    if (dbError) {
      console.error('❌ [DEBUG] Error update database:', dbError.message);
      throw dbError;
    }
    
    console.log('✅ [DEBUG] Database berhasil diupdate!\n');
    
    // 🚨 KIRIM RESPON JSON (BUKAN REDIRECT) UNTUK AJAX
    return res.json({
      success: true,
      message: `File ${jenis_file.toUpperCase()} berhasil disimpan ke Drive!`,
      previewLink: driveLink,
      jenis_file: jenis_file
    });

  } catch (err) {
    console.error('\n❌ [DEBUG] ERROR UPLOAD:');
    console.error('   - Message:', err.message);
    
    // 🚨 KIRIM RESPON JSON ERROR
    return res.status(500).json({
      success: false,
      message: err.message || 'Terjadi kesalahan saat mengupload file.'
    });
  }
});
// ========================================================================

// ========================================================================
// 🚨 ROUTE DETAIL MITRA (SUDAH DIPERBAIKI: RESET JAM KE 00:00:00)
// ========================================================================
app.get('/mitra/:id', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error) return res.status(500).send('❌ Database Error');
    if (!mitra) return res.status(404).send('❌ Mitra tidak ditemukan');
    
    const today = new Date();
    today.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    const endDate = new Date(mitra.tanggal_berakhir);
    endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    if (isNaN(endDate.getTime())) return res.status(500).send('❌ Format tanggal tidak valid');
    
    const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
    let status, color;
    if (diffDays < 0) { status = 'Expired'; color = '#6c757d'; }
    else if (diffDays <= 7) { status = 'Segera Berakhir'; color = '#dc3545'; }
    else if (diffDays <= 30) { status = 'Akan Berakhir'; color = '#ffc107'; }
    else { status = 'Aktif'; color = '#28a745'; }
    
    res.render('detail-mitra', { mitra: { ...mitra, sisa_hari: diffDays, status, color }, user: req.session.user, activePage: 'mitra', alertCount: 0 });
  } catch (err) {
    console.error('💥 Error:', err);
    res.status(500).send('Gagal memuat detail mitra.');
  }
});

app.get('/mitra/kode/:kode', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { kode } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('id').eq('kode_mitra', kode.toUpperCase()).single();
    if (error || !mitra) throw new Error('Kode mitra tidak ditemukan');
    res.redirect(`/mitra/${mitra.id}`);
  } catch (err) { res.status(404).send('❌ Mitra tidak ditemukan'); }
});

app.get('/mitra/:id/edit', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase.from('mitra').select('email_fakultas').eq('id', id).single();
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengedit mitra fakultas Anda');
      }
    }
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    res.render('form-mitra', { mitra, action: 'edit', user: req.session.user, activePage: 'tambah', alertCount: 0 });
  } catch (err) { res.status(500).send('Gagal memuat form edit.'); }
});

app.post('/mitra/:id/update', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase.from('mitra').select('email_fakultas').eq('id', id).single();
      if (checkError || !mitra.email_fakultas?.includes(req.session.user.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengupdate mitra fakultas Anda');
      }
    }
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir } = req.body;
    const { error } = await supabase.from('mitra').update({ nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir }).eq('id', id);
    if (error) throw error;
    res.redirect(`/mitra/${id}`);
  } catch (err) { 
    console.error('❌ Error update:', err.message); 
    res.status(500).send('Gagal update data.'); 
  }
});

// ========================================================================
// 🚨 ROUTE TEST ALERT (SUDAH DIPERBAIKI: RESET JAM KE 00:00:00)
// ========================================================================
app.get('/test-alert', requireAuth('humas'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    const formatDateLocal = (date) => date.toISOString().split('T')[0];
    const todayStr = formatDateLocal(today);
    const maxDate = new Date(); maxDate.setDate(today.getDate() + 30);
    const maxDateStr = formatDateLocal(maxDate);

    const { data: allMitra, error } = await supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (error) throw error;

    const mitraInRange = (allMitra || []).filter(m => {
      const endDate = new Date(m.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM
      const sisa = Math.ceil((endDate - today) / (1000*60*60*24));
      return sisa >= 0 && sisa <= 30;
    }).map(m => {
      const endDate = new Date(m.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM
      return { ...m, sisa_hari: Math.ceil((endDate - today) / (1000*60*60*24)) };
    });

    res.render('test-alert', { serverTime: today.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' }), todayStr, maxDateStr, totalMitra: (allMitra || []).length, inRangeCount: mitraInRange.length, mitraList: mitraInRange, user: req.session.user, activePage: 'alert', alertCount: mitraInRange.length });
  } catch (err) {
    console.error('💥 Test Alert Error:', err);
    res.status(500).send('❌ Gagal memuat halaman test alert.');
  }
});

// ========================================================================
// 🚨 ROUTE KIRIM EMAIL TEST (SUDAH DIPERBAIKI: RESET JAM KE 00:00:00)
// ========================================================================
app.post('/test-alert/send', requireAuth('humas'), async (req, res) => {
  try {
    const { mitra_id } = req.body;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', mitra_id).single();
    if (error || !mitra) return res.status(404).json({ success: false, message: 'Mitra tidak ditemukan' });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    const endDate = new Date(mitra.tanggal_berakhir);
    endDate.setHours(0, 0, 0, 0); // ✅ RESET JAM
    
    const sisa_hari = Math.ceil((endDate - today) / (1000*60*60*24));
    const subject = `🧪 [TEST MANUAL] Alert: "${mitra.nama_instansi}" Berakhir dalam ${sisa_hari} Hari`;
    
    const sent = await sendAlertEmail({ to: mitra.email_fakultas, subject, mitra: { ...mitra, sisa_hari } });
    
    if (sent) {
      res.json({ success: true, message: 'Email alert berhasil dikirim!', data: { email: mitra.email_fakultas, nama_instansi: mitra.nama_instansi, sisa_hari: sisa_hari } });
    } else {
      res.json({ success: false, message: 'Gagal mengirim email. Cek konfigurasi SMTP di server.' });
    }
  } catch (err) {
    console.error('❌ Error kirim email test:', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem: ' + err.message });
  }
});

app.get('/users', requireAuth('humas'), async (req, res) => {
    try {
        const { data: users, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.render('users', { users: users || [], user: req.session.user, activePage: 'users', alertCount: 0 });
    } catch (err) {
        console.error('❌ Error fetching users:', err);
        res.status(500).send('Gagal memuat data user.');
    }
});

app.get('/users/tambah', requireAuth('humas'), (req, res) => {
    res.render('form-user', { action: 'tambah', user: req.session.user, activePage: 'users', alertCount: 0 });
});

app.post('/users', requireAuth('humas'), async (req, res) => {
    try {
        const { name, email, password, role, fakultas_id } = req.body;
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const insertData = { name, email, password_hash, role, fakultas_id: role === 'admin_fakultas' ? fakultas_id : null, is_active: true };
        const { error } = await supabase.from('users').insert(insertData);
        if (error) throw error;
        res.redirect('/users');
    } catch (err) {
        console.error('❌ Error adding user:', err);
        res.status(500).send('Gagal menambah user. Pastikan email belum terdaftar.');
    }
});

app.post('/users/:id/reset-password', requireAuth('humas'), async (req, res) => {
    try {
        const { id } = req.params;
        const { data: targetUser, error: fetchError } = await supabase.from('users').select('email').eq('id', id).single();
        if (fetchError) throw fetchError;

        const newPassword = generateRandomPassword(12);
        console.log(`\n [RESET PASSWORD] User: ${targetUser.email} | New Password: ${newPassword}`);
        
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(newPassword, salt);
        const { error } = await supabase.from('users').update({ password_hash }).eq('id', id);
        if (error) throw error;
        
        res.send(`
            <!DOCTYPE html><html><head><title>Password Berhasil Direset</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
            <style>body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #1a3a5c 0%, #0f2439 100%); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; text-align: center; border-top: 5px solid #10b981; }
            .success-icon { font-size: 4rem; margin-bottom: 20px; } h2 { color: #10b981; margin-bottom: 10px; font-size: 1.5rem; }
            .user-info { background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0; } .user-info strong { color: #1a3a5c; font-size: 1.1rem; }
            .pw-box { background: linear-gradient(135deg, #fef3c7, #fde68a); padding: 20px; border-radius: 12px; font-family: 'Courier New', monospace; font-size: 1.4rem; letter-spacing: 2px; color: #92400e; font-weight: bold; margin: 25px 0; border: 3px dashed #f59e0b; user-select: all; cursor: pointer; }
            .pw-box:hover { background: linear-gradient(135deg, #d1fae5, #a7f3d0); }
            .warning { background: #fef3c7; color: #92400e; padding: 15px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 25px; border-left: 4px solid #f59e0b; text-align: left; }
            .btn { background: linear-gradient(135deg, #1a3a5c, #2c5282); color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; display: inline-block; }
            .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(26, 58, 92, 0.3); }</style></head>
            <body><div class="card"><div class="success-icon">✅</div><h2>Password Berhasil Direset!</h2>
            <div class="user-info"><strong>${targetUser.email}</strong><br><small style="color: #64748b">Akun berhasil diperbarui</small></div>
            <p style="color: #64748b; margin: 20px 0;">Password baru (klik untuk copy):</p>
            <div class="pw-box" onclick="navigator.clipboard.writeText('${newPassword}'); this.style.background='linear-gradient(135deg, #d1fae5, #a7f3d0)'; alert('✅ Password tersalin!')">${newPassword}</div>
            <div class="warning"><strong>⚠️ PENTING:</strong><br>• Password di atas <strong>hanya muncul sekali</strong><br>• Segera berikan password ini kepada user<br>• User dapat mengubah password setelah login</div>
            <a href="/users" class="btn">← Kembali ke Manajemen User</a></div></body></html>
        `);
    } catch (err) {
        console.error('❌ Error reset password:', err);
        res.status(500).send('Gagal reset password: ' + err.message);
    }
});

app.post('/users/:id/toggle-status', requireAuth('humas'), async (req, res) => {
    try {
        const { id } = req.params;
        const { data: currentUser } = await supabase.from('users').select('is_active').eq('id', id).single();
        const newStatus = !currentUser.is_active;
        const { error } = await supabase.from('users').update({ is_active: newStatus }).eq('id', id);
        if (error) throw error;
        res.redirect('/users');
    } catch (err) {
        console.error('❌ Error toggle status:', err);
        res.status(500).send('Gagal mengubah status user.');
    }
});

app.get('/change-password', requireAuth('humas', 'admin_fakultas', 'guest'), (req, res) => {
    res.render('change-password', { user: req.session.user, error: null, success: null, activePage: 'change-password', alertCount: 0 });
});

app.post('/change-password', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
    try {
        const { old_password, new_password, confirm_password } = req.body;
        const userId = req.session.user.id;
        const { data: user, error } = await supabase.from('users').select('password_hash, email').eq('id', userId).single();
        if (error) throw error;

        const isMatch = await bcrypt.compare(old_password, user.password_hash);
        if (!isMatch) return res.render('change-password', { user: req.session.user, error: '❌ Password lama yang Anda masukkan salah!', success: null, activePage: 'change-password', alertCount: 0 });
        if (new_password !== confirm_password) return res.render('change-password', { user: req.session.user, error: '❌ Password baru dan Konfirmasi Password tidak cocok!', success: null, activePage: 'change-password', alertCount: 0 });
        if (new_password.length < 8) return res.render('change-password', { user: req.session.user, error: '❌ Password minimal harus 8 karakter!', success: null, activePage: 'change-password', alertCount: 0 });

        const salt = await bcrypt.genSalt(10);
        const new_password_hash = await bcrypt.hash(new_password, salt);
        const { error: updateError } = await supabase.from('users').update({ password_hash: new_password_hash }).eq('id', userId);
        if (updateError) throw updateError;

        res.render('change-password', { user: req.session.user, error: null, success: '✅ Password berhasil diubah!', activePage: 'change-password', alertCount: 0 });
    } catch (err) {
        console.error('❌ Error change password:', err);
        res.status(500).send('Terjadi kesalahan sistem.');
    }
});

const PORT = process.env.PORT || 3000;
// 🚨 HANYA SATU app.listen DI SINI
app.listen(PORT, () => console.log(`🚀 Server aktif di http://localhost:${PORT}`));