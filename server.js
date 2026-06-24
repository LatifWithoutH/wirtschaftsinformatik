require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

// ✅ AUDIT LOGGER
const { logAudit } = require('./utils/auditLogger');
const { uploadFileToDrive } = require('./utils/gasUploader');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 🔒 VALIDASI STRICT: SESSION_SECRET wajib ada
if (!process.env.SESSION_SECRET) {
  console.error('❌ FATAL: SESSION_SECRET belum diset di environment variables!');
  console.error('   Jalankan: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ========================================================================
// 🔧 HELPER FUNCTIONS
// ========================================================================
function isSameFaculty(userFakultasId, mitraFakultasId) {
  if (!userFakultasId || !mitraFakultasId) return false;
  return userFakultasId === mitraFakultasId;
}

function filterMitraByFaculty(mitraList, user) {
  if (!mitraList) return [];
  if (user.role === 'humas' || user.role === 'guest') return mitraList;
  if (user.role === 'admin_fakultas' && user.fakultas_id) {
    return mitraList.filter(m => m.fakultas_id === user.fakultas_id);
  }
  return [];
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  const escaped = str.replace(/"/g, '""');
  if (/[",\n\r]/.test(str)) return `"${escaped}"`;
  return str;
}

function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (allowedRoles.length && !allowedRoles.includes(req.session.user.role)) {
      return res.status(403).send('❌ Akses ditolak: Role tidak memiliki izin');
    }
    next();
  };
}

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
app.use('/audit-log', checkUserActive);

// ========================================================================
// 🔒 RATE LIMITERS
// ========================================================================
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan!'), false);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: '⚠️ Terlalu banyak percobaan login.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, 
  handler: (req, res, next, options) => {
    const retryAfter = res.getHeader('Retry-After') || 900;
    console.warn(`🚨 [RATE LIMIT] Login diblokir dari IP: ${req.ip}. Retry after ${retryAfter}s`);
    
    res.status(429).render('login', { 
      error: '🚫 Terlalu banyak percobaan login. Akun dikunci sementara.',
      locked: true,
      retryAfter: retryAfter
    });
  }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Terlalu banyak request. Coba lagi dalam 15 menit.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ========================================================================
// 🚀 BASIC ROUTES
// ========================================================================
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// ✅ LOGIN DENGAN AUDIT LOG
app.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();

    if (error || !user) {
      await logAudit({
        action: 'LOGIN_FAILED',
        tableName: 'users',
        recordName: email,
        newData: { reason: 'Email not found' },
        req
      });
      return res.render('login', { error: '❌ Email tidak ditemukan' });
    }

    if (user.is_active === false) {
      await logAudit({
        action: 'LOGIN_FAILED',
        tableName: 'users',
        recordId: user.id,
        recordName: email,
        newData: { reason: 'Account inactive' },
        req
      });
      return res.render('login', { error: '🚫 Akun Anda telah dinonaktifkan.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await logAudit({
        action: 'LOGIN_FAILED',
        tableName: 'users',
        recordId: user.id,
        recordName: email,
        newData: { reason: 'Wrong password' },
        req
      });
      return res.render('login', { error: '❌ Password salah' });
    }

    // ✅ LOGIN BERHASIL
    await logAudit({
      action: 'LOGIN',
      tableName: 'users',
      recordId: user.id,
      recordName: email,
      user: { id: user.id, email: user.email, role: user.role },
      req
    });

    req.session.user = { id: user.id, email: user.email, role: user.role, fakultas_id: user.fakultas_id };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: '❌ Terjadi kesalahan sistem' });
  }
});

// ✅ LOGOUT DENGAN AUDIT LOG
app.get('/logout', async (req, res) => {
  if (req.session.user) {
    await logAudit({
      action: 'LOGOUT',
      tableName: 'users',
      recordId: req.session.user.id,
      recordName: req.session.user.email,
      user: req.session.user,
      req
    });
  }
  req.session.destroy(() => res.redirect('/login'));
});

// ========================================================================
// 🔑 ENDPOINT UNTUK TEST-ALERT.EJS (Ambil URL GAS)
// ========================================================================
app.get('/api/gas-url', requireAuth('humas'), (req, res) => {
  res.json({ url: process.env.GAS_WEB_APP_ALERT });
});

// ========================================================================
// 📊 DASHBOARD
// ========================================================================
app.get('/dashboard', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: allMitra, error } = await supabase.from('mitra').select('*');
    if (error) throw error;
    
    const filteredMitra = filterMitraByFaculty(allMitra, req.session.user);
    
    const stats = { total: 0, aktif: 0, akan_berakhir: 0, segera_berakhir: 0, expired: 0 };
    const segeraBerakhir = [];
    
    filteredMitra.forEach(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0);
      
      if (isNaN(endDate.getTime())) return;
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      
      if (diffDays < 0) stats.expired++;
      else if (diffDays <= 7) { stats.segera_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#dc3545' }); }
      else if (diffDays <= 30) { stats.akan_berakhir++; segeraBerakhir.push({ ...mitra, sisa_hari: diffDays, color: '#ffc107' }); }
      else stats.aktif++;
    });
    stats.total = filteredMitra.length;
    segeraBerakhir.sort((a,b) => a.sisa_hari - b.sisa_hari);
    
    res.render('dashboard', { stats, segeraBerakhir, user: req.session.user, activePage: 'dashboard', alertCount: segeraBerakhir.length });
  } catch (err) {
    console.error('❌ Error dashboard:', err.message);
    res.status(500).send('Gagal memuat dashboard.');
  }
});

// ========================================================================
// 📋 DAFTAR MITRA
// ========================================================================
// ========================================================================
// 📋 DAFTAR MITRA (DENGAN PAGINATION)
// ========================================================================
app.get('/mitra', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // ✅ PAGINATION PARAMS
    const page = parseInt(req.query.page) || 1;
    const limit = 15;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').toLowerCase().trim();
    
    const { data: allMitra, error } = await supabase
      .from('mitra')
      .select('*')
      .order('tanggal_berakhir', { ascending: true });
    
    if (error) throw error;
    
    let filteredMitra = filterMitraByFaculty(allMitra, req.session.user);
    
    // ✅ SEARCH SERVER-SIDE
    if (search) {
      filteredMitra = filteredMitra.filter(m =>
        (m.nama_instansi || '').toLowerCase().includes(search) ||
        (m.nama_kontak || '').toLowerCase().includes(search) ||
        (m.email_fakultas || '').toLowerCase().includes(search) ||
        (m.email_mitra_asli || '').toLowerCase().includes(search) ||
        (m.kode_mitra || '').toLowerCase().includes(search)
      );
    }
    
    // ✅ HITUNG STATS + STATUS UNTUK SEMUA DATA
    const stats = { aktif: 0, akanBerakhir: 0, segeraBerakhir: 0, expired: 0 };
    const mitraDenganStatus = filteredMitra.map(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0);
      
      if (isNaN(endDate.getTime())) {
        return { ...mitra, sisa_hari: 0, status: 'Invalid', color: '#999', badgeClass: 'expired' };
      }
      
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      let status, color, badgeClass;
      
      if (diffDays < 0) { 
        status = 'Expired'; color = '#6c757d'; badgeClass = 'expired'; 
        stats.expired++;
      }
      else if (diffDays <= 7) { 
        status = 'Segera Berakhir'; color = '#dc3545'; badgeClass = 'danger'; 
        stats.segeraBerakhir++;
      }
      else if (diffDays <= 30) { 
        status = 'Akan Berakhir'; color = '#ffc107'; badgeClass = 'warning'; 
        stats.akanBerakhir++;
      }
      else { 
        status = 'Aktif'; color = '#28a745'; badgeClass = 'active'; 
        stats.aktif++;
      }
      
      return { ...mitra, sisa_hari: diffDays, status, color, badgeClass };
    });
    
    // ✅ PAGINATION
    const totalItems = mitraDenganStatus.length;
    const totalPages = Math.ceil(totalItems / limit);
    const mitraPage = mitraDenganStatus.slice(offset, offset + limit);
    
    const alertCount = stats.akanBerakhir + stats.segeraBerakhir;
    
    res.render('mitra-table', { 
      mitra: mitraPage, 
      user: req.session.user, 
      activePage: 'mitra', 
      alertCount,
      stats,  // ✅ KIRIM STATS
      pagination: {  // ✅ KIRIM PAGINATION
        currentPage: page,
        totalPages,
        totalItems,
        limit,
        search
      }
    });
  } catch (err) {
    console.error('❌ Error table view:', err.message);
    res.status(500).send('Gagal memuat daftar mitra.');
  }
});

// ========================================================================
// 📊 EXPORT CSV BACKEND
// ========================================================================
app.get('/mitra/export/csv', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: allMitra, error } = await supabase
      .from('mitra')
      .select('*')
      .order('tanggal_berakhir', { ascending: true });
    
    if (error) throw error;
    
    let mitraList = filterMitraByFaculty(allMitra || [], req.session.user);
    
    const searchTerm = (req.query.search || '').toLowerCase().trim();
    if (searchTerm) {
      mitraList = mitraList.filter(m => 
        (m.nama_instansi || '').toLowerCase().includes(searchTerm) ||
        (m.nama_kontak || '').toLowerCase().includes(searchTerm) ||
        (m.email_fakultas || '').toLowerCase().includes(searchTerm) ||
        (m.email_mitra_asli || '').toLowerCase().includes(searchTerm) ||  // ✅ TAMBAH: search email_mitra_asli
        (m.kode_mitra || '').toLowerCase().includes(searchTerm)
      );
    }
    
    // ✅ TAMBAH: 'Email Mitra Resmi' di headers
    const headers = ['Kode Mitra','Nama Instansi','Nama Kontak','Jabatan','No HP','Email Penanggung Jawab','Email Mitra Resmi','Alamat','Tanggal Mulai','Tanggal Berakhir','Sisa Hari','Status','File MoU','File MoA','File IA','File PKS'];
    const csvRows = [headers.map(escapeCsv).join(',')];
    
    mitraList.forEach(m => {
      const endDate = new Date(m.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      
      let status;
      if (isNaN(endDate.getTime())) status = 'Invalid';
      else if (diffDays < 0) status = 'Expired';
      else if (diffDays <= 7) status = 'Segera Berakhir';
      else if (diffDays <= 30) status = 'Akan Berakhir';
      else status = 'Aktif';
      
      const formatDate = (dateStr) => {
        if (!dateStr) return '';
        try { return new Date(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }); }
        catch { return dateStr; }
      };
      
      // ✅ TAMBAH: m.email_mitra_asli di row (setelah email_fakultas)
      const row = [
        m.kode_mitra || '', m.nama_instansi || '', m.nama_kontak || '', m.jabatan || '',
        m.no_hp_kontak || '', m.email_fakultas || '', m.email_mitra_asli || '',
        (m.alamat || '').replace(/\n/g, ' ').replace(/\r/g, ''),
        formatDate(m.tanggal_mulai), formatDate(m.tanggal_berakhir),
        isNaN(diffDays) ? '0' : String(diffDays), status,
        m.file_mou ? 'Sudah' : 'Belum', m.file_moa ? 'Sudah' : 'Belum',
        m.file_ia ? 'Sudah' : 'Belum', m.file_pks ? 'Sudah' : 'Belum'
      ];
      csvRows.push(row.map(escapeCsv).join(','));
    });
    
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const filename = `mitra-dudika-${dateStr}_${timeStr}.csv`;
    
    // ✅ AUDIT LOG: Export CSV
    await logAudit({
      action: 'EXPORT',
      tableName: 'mitra',
      recordName: `Export CSV (${mitraList.length} records)`,
      newData: { total_exported: mitraList.length, search: searchTerm || null },
      user: req.session.user,
      req
    });
    
    console.log(`📊 [EXPORT CSV] User: ${req.session.user.email} | Total: ${mitraList.length}`);
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('' + csvRows.join('\n'));
  } catch (err) {
    console.error('❌ Error export CSV:', err.message);
    res.status(500).send('❌ Gagal export CSV: ' + err.message);
  }
});

// ========================================================================
// ➕ TAMBAH MITRA
// ========================================================================
app.get('/mitra/tambah', requireAuth('humas'), async (req, res) => {
  try {
    const { data: fakultas, error } = await supabase
      .from('fakultas')
      .select('id, nama, singkatan')
      .eq('is_active', true)
      .order('urutan', { ascending: true });
    
    if (error) {
      console.error('❌ Error fetch fakultas:', error);
      return res.status(500).send('Gagal memuat data fakultas');
    }
    
    res.render('form-mitra', { 
      mitra: null, action: 'tambah', user: req.session.user, 
      activePage: 'tambah', alertCount: 0, fakultas: fakultas || []
    });
  } catch (err) {
    console.error('❌ Error loading form mitra:', err);
    res.status(500).send('Gagal memuat form tambah mitra.');
  }
});

// ✅ CREATE MITRA + AUDIT LOG
app.post('/mitra', requireAuth('humas'), async (req, res) => {
  try {
    // ✅ TAMBAH: email_mitra_asli di destructuring
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, email_mitra_asli, fakultas_id, tanggal_mulai, tanggal_berakhir } = req.body;
    
    if (fakultas_id) {
      const { data: cekFakultas } = await supabase.from('fakultas').select('id').eq('id', fakultas_id).single();
      if (!cekFakultas) return res.status(400).send('❌ Fakultas tidak valid');
    }
    
    const { count } = await supabase.from('mitra').select('*', { count: 'exact', head: true });
    const kode_mitra = `MITRA-${String((count || 0) + 1).padStart(4, '0')}`;
    
    // ✅ TAMBAH: email_mitra_asli di insertData (opsional, bisa null)
    const insertData = { 
      kode_mitra, nama_instansi, nama_kontak, jabatan, alamat, 
      no_hp_kontak, email_fakultas, 
      email_mitra_asli: email_mitra_asli || null,
      fakultas_id: fakultas_id || null,
      tanggal_mulai, tanggal_berakhir 
    };
    
    const { data: newMitra, error } = await supabase.from('mitra').insert(insertData).select().single();
    if (error) throw error;
    
    // ✅ AUDIT LOG: CREATE mitra
    await logAudit({
      action: 'CREATE',
      tableName: 'mitra',
      recordId: newMitra.id,
      recordName: nama_instansi,
      newData: insertData,
      user: req.session.user,
      req
    });
    
    console.log(`✅ Mitra baru: ${nama_instansi} - Fakultas: ${fakultas_id || '-'}`);
    res.redirect('/mitra');
  } catch (err) {
    console.error('❌ Error insert mitra:', err.message);
    res.status(500).send('Gagal menyimpan data.');
  }
});

// ========================================================================
// 📤 UPLOAD PDF + AUDIT LOG
// ========================================================================
app.post('/mitra/:id/upload', requireAuth('humas', 'admin_fakultas'), upload.single('file_pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    const { jenis_file } = req.body;
    
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra, error: checkError } = await supabase.from('mitra').select('fakultas_id').eq('id', id).single();
      if (checkError || !isSameFaculty(req.session.user.fakultas_id, mitra?.fakultas_id)) {
        return res.status(403).json({ success: false, message: '❌ Anda hanya dapat upload untuk mitra fakultas Anda' });
      }
    }
    
    if (!req.file) throw new Error('File tidak ditemukan');
    if (!['mou', 'moa', 'ia', 'pks'].includes(jenis_file)) throw new Error('Jenis file tidak valid');
    
    const { data: mitraData, error: mitraError } = await supabase
      .from('mitra')
      .select('nama_instansi')
      .eq('id', id)
      .single();
      
    if (mitraError || !mitraData) throw new Error('Data mitra tidak ditemukan');
    
    // ✅ Ambil data lama sebelum upload (untuk audit)
    const fieldName = `file_${jenis_file}`;
    const { data: oldMitraData } = await supabase.from('mitra').select(fieldName).eq('id', id).single();
    
    // ✅ PERBAIKAN: Hitung nomor urut per jenis dokumen
    const jenisFile = jenis_file.toUpperCase(); // MOU, MOA, IA, atau PKS
    
    // Hitung berapa file jenis ini yang sudah ada di database
    const { count } = await supabase
      .from('mitra')
      .select('*', { count: 'exact', head: true })
      .not(fieldName, 'is', null);
    
    // // Nomor urut berikutnya (misal: sudah ada 5 MOU, maka berikutnya = 6)
    const nextNumber = (count || 0) + 1;
    const nomorUrut = String(nextNumber).padStart(4, '0'); // Format: 0001, 0002, dst
    
    // Nama file asli (misal: draft_kerjasama.pdf)
    const namaFileAsli = req.file.originalname;
    
    // ✅ Format nama file baru: MOU-0001-draft_kerjasama.pdf
    const newFileName = `${jenisFile}-${namaFileAsli}`;
    
    console.log(`📝 Generated filename: ${newFileName} (urutan ke-${nextNumber})`);
    
    // ✅ Kirim nama file baru ke GAS
    const driveLink = await uploadFileToDrive(
      req.file.buffer, 
      newFileName,              // <-- Gunakan nama file yang sudah diformat
      req.file.mimetype, 
      mitraData.nama_instansi
    );
    
    const { error: dbError } = await supabase.from('mitra').update({ [fieldName]: driveLink }).eq('id', id);
    if (dbError) throw dbError;
    
    // ✅ AUDIT LOG: UPLOAD dokumen
    await logAudit({
      action: 'UPLOAD',
      tableName: 'dokumen',
      recordId: id,
      recordName: `${mitraData.nama_instansi} - ${jenisFile}`,
      oldData: { [fieldName]: oldMitraData?.[fieldName] || null },
      newData: { [fieldName]: driveLink, file_name: newFileName },
      user: req.session.user,
      req
    });
    
    return res.json({
      success: true,
      message: `File ${jenisFile} berhasil disimpan dengan nama: ${newFileName}`,
      previewLink: driveLink,
      jenis_file: jenis_file
    });
  } catch (err) {
    console.error('❌ ERROR UPLOAD:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ========================================================================
// 📄 DETAIL MITRA
// ========================================================================
app.get('/mitra/:id', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error) return res.status(500).send('❌ Database Error');
    if (!mitra) return res.status(404).send('❌ Mitra tidak ditemukan');
    
    if (req.session.user.role === 'admin_fakultas') {
      if (!isSameFaculty(req.session.user.fakultas_id, mitra.fakultas_id)) {
        return res.status(403).send('❌ Akses ditolak: Mitra ini bukan milik fakultas Anda');
      }
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(mitra.tanggal_berakhir);
    endDate.setHours(0, 0, 0, 0);
    
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
    const { data: mitra } = await supabase.from('mitra').select('id').eq('kode_mitra', kode.toUpperCase()).single();
    if (!mitra) return res.status(404).send('❌ Mitra tidak ditemukan');
    res.redirect(`/mitra/${mitra.id}`);
  } catch (err) { res.status(404).send('❌ Mitra tidak ditemukan'); }
});

// ========================================================================
// ✏️ EDIT MITRA
// ========================================================================
app.get('/mitra/:id/edit', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    if (req.session.user.role === 'admin_fakultas') {
      const { data: mitra } = await supabase
        .from('mitra')
        .select('fakultas_id')
        .eq('id', id)
        .single();
      
      if (!isSameFaculty(req.session.user.fakultas_id, mitra?.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengedit mitra fakultas Anda');
      }
    }
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    
    const { data: fakultas } = await supabase
      .from('fakultas').select('id, nama, singkatan')
      .eq('is_active', true).order('urutan', { ascending: true });
    
    res.render('form-mitra', { 
      mitra, action: 'edit', user: req.session.user, 
      activePage: 'tambah', alertCount: 0,
      canEditFakultas: req.session.user.role === 'humas',
      fakultas: fakultas || []
    });
  } catch (err) { 
    console.error('❌ Error loading form edit:', err);
    res.status(500).send('Gagal memuat form edit.'); 
  }
});

// ✅ UPDATE MITRA + AUDIT LOG (dengan old_data & new_data)
app.post('/mitra/:id/update', requireAuth('humas', 'admin_fakultas'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // ✅ Ambil data LAMA (full) untuk audit
    const { data: currentMitra, error: checkError } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (checkError || !currentMitra) return res.status(404).send('❌ Mitra tidak ditemukan');
    
    if (req.session.user.role === 'admin_fakultas') {
      if (!isSameFaculty(req.session.user.fakultas_id, currentMitra.fakultas_id)) {
        return res.status(403).send('❌ Anda hanya dapat mengupdate mitra fakultas Anda');
      }
    }
    
    // ✅ TAMBAH: email_mitra_asli di destructuring
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, email_mitra_asli, fakultas_id, tanggal_mulai, tanggal_berakhir } = req.body;
    
    const updateData = { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, tanggal_mulai, tanggal_berakhir };
    
    if (req.session.user.role === 'humas') {
      updateData.email_fakultas = email_fakultas;
      updateData.email_mitra_asli = email_mitra_asli || null;  // ✅ TAMBAH: email_mitra_asli
      updateData.fakultas_id = fakultas_id || null;
    } else {
      updateData.fakultas_id = currentMitra.fakultas_id;
    }
    
    // ✅ AUDIT LOG: UPDATE mitra
    await logAudit({
      action: 'UPDATE',
      tableName: 'mitra',
      recordId: id,
      recordName: currentMitra.nama_instansi,
      oldData: currentMitra,
      newData: updateData,
      user: req.session.user,
      req
    });
    
    const { error } = await supabase.from('mitra').update(updateData).eq('id', id);
    if (error) throw error;
    res.redirect(`/mitra/${id}`);
  } catch (err) { 
    console.error('❌ Error update:', err.message); 
    res.status(500).send('Gagal update data.'); 
  }
});

// ========================================================================
// 🧪 TEST ALERT
// ========================================================================
app.get('/test-alert', requireAuth('humas'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const formatDateLocal = (date) => date.toISOString().split('T')[0];
    const todayStr = formatDateLocal(today);
    const maxDate = new Date(); maxDate.setDate(today.getDate() + 30);
    const maxDateStr = formatDateLocal(maxDate);

    const { data: allMitra, error } = await supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (error) throw error;

    const mitraInRange = (allMitra || []).filter(m => {
      const endDate = new Date(m.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0);
      const sisa = Math.ceil((endDate - today) / (1000*60*60*24));
      return sisa >= 0 && sisa <= 30;
    }).map(m => {
      const endDate = new Date(m.tanggal_berakhir);
      endDate.setHours(0, 0, 0, 0);
      return { ...m, sisa_hari: Math.ceil((endDate - today) / (1000*60*60*24)) };
    });

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

// ========================================================================
// 👥 USERS MANAGEMENT
// ========================================================================
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

app.get('/users/tambah', requireAuth('humas'), async (req, res) => {
  try {
    const { data: fakultas, error } = await supabase
      .from('fakultas').select('id, nama, singkatan')
      .eq('is_active', true).order('urutan', { ascending: true });
    
    if (error) return res.status(500).send('Gagal memuat data fakultas');
    
    res.render('form-user', { 
      action: 'tambah', user: req.session.user, 
      activePage: 'users', alertCount: 0, fakultas: fakultas || []
    });
  } catch (err) {
    console.error('❌ Error loading form user:', err);
    res.status(500).send('Gagal memuat form tambah user.');
  }
});

// ✅ CREATE USER + AUDIT LOG
app.post('/users', requireAuth('humas'), async (req, res) => {
  try {
    const { name, email, password, role, fakultas_id } = req.body;
    
    if (role === 'admin_fakultas') {
      if (!fakultas_id) return res.status(400).send('❌ Fakultas harus dipilih');
      const { data: cekFakultas } = await supabase.from('fakultas').select('id').eq('id', fakultas_id).eq('is_active', true).single();
      if (!cekFakultas) return res.status(400).send('❌ Fakultas tidak valid');
    }
    
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    
    const insertData = { 
      name, email, password_hash, role, 
      fakultas_id: role === 'admin_fakultas' ? fakultas_id : null, 
      is_active: true 
    };
    
    const { data: newUser, error } = await supabase.from('users').insert(insertData).select().single();
    if (error) {
      if (error.code === '23505') return res.status(400).send('❌ Email sudah terdaftar.');
      throw error;
    }
    
    // ✅ AUDIT LOG: CREATE user
    await logAudit({
      action: 'CREATE',
      tableName: 'users',
      recordId: newUser.id,
      recordName: email,
      newData: { name, email, role, fakultas_id: fakultas_id || null },
      user: req.session.user,
      req
    });
    
    console.log(`✅ User baru: ${email} (${role})`);
    res.redirect('/users');
  } catch (err) {
    console.error('❌ Error adding user:', err);
    res.status(500).send('Gagal menambah user: ' + err.message);
  }
});

// ✅ RESET PASSWORD + AUDIT LOG
app.post('/users/:id/reset-password', apiLimiter, requireAuth('humas'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: targetUser, error } = await supabase.from('users').select('email').eq('id', id).single();
    if (error) throw error;

    const newPassword = generateRandomPassword(12);
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(newPassword, salt);
    
    // ✅ AUDIT LOG: RESET PASSWORD
    await logAudit({
      action: 'RESET_PASSWORD',
      tableName: 'users',
      recordId: id,
      recordName: targetUser.email,
      newData: { action: 'Password reset by admin' },
      user: req.session.user,
      req
    });
    
    await supabase.from('users').update({ password_hash }).eq('id', id);
    
    res.send(`
      <!DOCTYPE html><html><head><title>Password Berhasil Direset</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
      <style>body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #1a3a5c 0%, #0f2439 100%); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; text-align: center; border-top: 5px solid #10b981; }
      .success-icon { font-size: 4rem; margin-bottom: 20px; } h2 { color: #10b981; margin-bottom: 10px; font-size: 1.5rem; }
      .pw-box { background: linear-gradient(135deg, #fef3c7, #fde68a); padding: 20px; border-radius: 12px; font-family: 'Courier New', monospace; font-size: 1.4rem; letter-spacing: 2px; color: #92400e; font-weight: bold; margin: 25px 0; border: 3px dashed #f59e0b; user-select: all; cursor: pointer; }
      .warning { background: #fef3c7; color: #92400e; padding: 15px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 25px; border-left: 4px solid #f59e0b; text-align: left; }
      .btn { background: linear-gradient(135deg, #1a3a5c, #2c5282); color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; display: inline-block; }
      </style></head>
      <body><div class="card"><div class="success-icon">✅</div><h2>Password Berhasil Direset!</h2>
      <p style="color: #64748b; margin: 20px 0;"><strong>${targetUser.email}</strong></p>
      <p style="color: #64748b;">Password baru (klik untuk copy):</p>
      <div class="pw-box" onclick="navigator.clipboard.writeText('${newPassword}'); alert('✅ Password tersalin!')">${newPassword}</div>
      <div class="warning"><strong>⚠️ PENTING:</strong><br>• Password hanya muncul sekali<br>• Segera berikan ke user</div>
      <a href="/users" class="btn">← Kembali</a></div></body></html>
    `);
  } catch (err) {
    console.error('❌ Error reset password:', err);
    res.status(500).send('Gagal reset password: ' + err.message);
  }
});

// ✅ TOGGLE STATUS + AUDIT LOG
app.post('/users/:id/toggle-status', apiLimiter, requireAuth('humas'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: currentUser } = await supabase.from('users').select('is_active, email').eq('id', id).single();
    
    const newStatus = !currentUser.is_active;
    const actionName = newStatus ? 'ACTIVATE' : 'DEACTIVATE';
    
    // ✅ AUDIT LOG: TOGGLE STATUS
    await logAudit({
      action: actionName,
      tableName: 'users',
      recordId: id,
      recordName: currentUser.email,
      oldData: { is_active: currentUser.is_active },
      newData: { is_active: newStatus },
      user: req.session.user,
      req
    });
    
    await supabase.from('users').update({ is_active: newStatus }).eq('id', id);
    res.redirect('/users');
  } catch (err) {
    console.error('❌ Error toggle status:', err);
    res.status(500).send('Gagal mengubah status user.');
  }
});

// ========================================================================
// 🔑 CHANGE PASSWORD
// ========================================================================
app.get('/change-password', requireAuth('humas', 'admin_fakultas', 'guest'), (req, res) => {
  res.render('change-password', { user: req.session.user, error: null, success: null, activePage: 'change-password', alertCount: 0 });
});

// ✅ CHANGE PASSWORD + AUDIT LOG
app.post('/change-password', requireAuth('humas', 'admin_fakultas', 'guest'), async (req, res) => {
  try {
    const { old_password, new_password, confirm_password } = req.body;
    const userId = req.session.user.id;
    const { data: user, error } = await supabase.from('users').select('password_hash, email').eq('id', userId).single();
    if (error) throw error;

    const isMatch = await bcrypt.compare(old_password, user.password_hash);
    if (!isMatch) return res.render('change-password', { user: req.session.user, error: '❌ Password lama salah!', success: null, activePage: 'change-password', alertCount: 0 });
    if (new_password !== confirm_password) return res.render('change-password', { user: req.session.user, error: '❌ Password baru dan konfirmasi tidak cocok!', success: null, activePage: 'change-password', alertCount: 0 });
    if (new_password.length < 8) return res.render('change-password', { user: req.session.user, error: '❌ Password minimal 8 karakter!', success: null, activePage: 'change-password', alertCount: 0 });

    const salt = await bcrypt.genSalt(10);
    const new_password_hash = await bcrypt.hash(new_password, salt);
    await supabase.from('users').update({ password_hash: new_password_hash }).eq('id', userId);

    // ✅ AUDIT LOG: CHANGE PASSWORD (user ganti password sendiri)
    await logAudit({
      action: 'CHANGE_PASSWORD',
      tableName: 'users',
      recordId: userId,
      recordName: user.email,
      newData: { action: 'User changed own password' },
      user: req.session.user,
      req
    });

    res.render('change-password', { user: req.session.user, error: null, success: '✅ Password berhasil diubah!', activePage: 'change-password', alertCount: 0 });
  } catch (err) {
    console.error('❌ Error change password:', err);
    res.status(500).send('Terjadi kesalahan sistem.');
  }
});

// ========================================================================
// 📜 AUDIT LOG (KHUSUS HUMAS)
// ========================================================================
app.get('/audit-log', requireAuth('humas'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const { action, table, user: userFilter } = req.query;
    
    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (action) query = query.eq('action', action);
    if (table) query = query.eq('table_name', table);
    if (userFilter) query = query.ilike('user_email', `%${userFilter}%`);

    const { data: logs, error, count } = await query;
    if (error) throw error;

    res.render('audit-log', {
      logs: logs || [],
      currentPage: page,
      totalPages: Math.ceil((count || 0) / limit),
      filters: { 
        action: action || '', 
        table: table || '', 
        user: userFilter || '' 
      },
      user: req.session.user,
      activePage: 'audit-log',
      alertCount: 0
    });
  } catch (err) {
    console.error('❌ Error audit log:', err);
    res.status(500).send('Gagal memuat audit log: ' + err.message);
  }
});

// ========================================================================
// 🚀 START SERVER
// ========================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server aktif di http://localhost:${PORT}`);
  console.log(`📱 Akses dari HP di: http://192.168.1.9:${PORT}`);
});