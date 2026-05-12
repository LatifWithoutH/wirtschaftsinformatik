require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// ✅ Inisialisasi Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 🔹 SETUP MULTER (Upload Handler)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
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

// 🔹 CRON JOB: Cek & Kirim Alert Setiap Hari Jam 08:00 WIB
cron.schedule('0 8 * * *', async () => {
  console.log('🔍 [Cron Job] Memulai pengecekan alert...');
  
  try {
    const today = new Date();
    const thresholds = [30, 14, 7];
    
    for (const days of thresholds) {
      const targetDate = new Date();
      targetDate.setDate(today.getDate() + days);
      const targetStr = targetDate.toISOString().split('T')[0];
      
      const { data: mitraList, error } = await supabase
        .from('mitra')
        .select('*')
        .eq('tanggal_berakhir', targetStr);
      
      if (error) { console.error('❌ Error query alert:', error); continue; }
      if (!mitraList || mitraList.length === 0) {
        console.log(`ℹ️ Tidak ada mitra yang berakhir dalam ${days} hari`);
        continue;
      }
      
      console.log(`📧 Ditemukan ${mitraList.length} mitra untuk alert ${days} hari`);
      
      for (const mitra of mitraList) {
        const endDate = new Date(mitra.tanggal_berakhir);
        const sisa_hari = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
        const subject = `⚠️ Alert: Kerja Sama "${mitra.nama_instansi}" Berakhir dalam ${days} Hari`;
        
        const recipients = [mitra.email_fakultas];
        if (process.env.EMAIL_HUMAS) recipients.push(process.env.EMAIL_HUMAS);
        
        await sendAlertEmail({
          to: recipients,
          subject: subject,
          mitra: { ...mitra, sisa_hari }
        });
      }
    }
    console.log('✅ [Cron Job] Pengecekan alert selesai');
  } catch (err) {
    console.error('💥 [Cron Job] Error:', err.message);
  }
}, { scheduled: true, timezone: "Asia/Jakarta" });

// 🔹 HOME
app.get('/', (req, res) => res.send('✅ SI Mitra DUDIKA terhubung ke Supabase!'));

// 🔹 DASHBOARD
app.get('/mitra', async (req, res) => {
  try {
    const { data: mitraList, error } = await supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (error) throw error;
    const today = new Date();
    const mitraDenganStatus = mitraList.map(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
      let status, color;
      if (diffDays <= 7) { status = 'Segera Berakhir'; color = 'red'; }
      else if (diffDays <= 30) { status = 'Akan Berakhir'; color = 'orange'; }
      else { status = 'Aktif'; color = 'green'; }
      return { ...mitra, sisa_hari: diffDays, status, color };
    });
    res.render('dashboard', { mitra: mitraDenganStatus });
  } catch (err) {
    console.error('❌ Error fetch mitra:', err.message);
    res.status(500).send('Gagal memuat data mitra');
  }
});

// 🔹 FORM Tambah Mitra
app.get('/mitra/tambah', (req, res) => res.render('form-mitra', { mitra: null, action: 'tambah' }));

// 🔹 POST Simpan Data Mitra + Generate kode_mitra
app.post('/mitra', async (req, res) => {
  try {
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir } = req.body;
    const { count } = await supabase.from('mitra').select('*', { count: 'exact', head: true });
    const kode_mitra = `MITRA-${String((count || 0) + 1).padStart(4, '0')}`;
    const { error } = await supabase.from('mitra').insert({ kode_mitra, nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir });
    if (error) throw error;
    res.redirect('/mitra');
  } catch (err) {
    console.error('❌ Error insert mitra:', err.message);
    res.status(500).send('Gagal menyimpan data');
  }
});

// 🔹 UPLOAD PDF
app.post('/mitra/:id/upload', upload.single('file_pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    const { jenis_file } = req.body;
    if (!req.file) throw new Error('File tidak ditemukan');
    if (!['mou', 'moa', 'ia', 'pks'].includes(jenis_file)) throw new Error('Jenis file tidak valid');
    const fileName = `mitra-${id}-${jenis_file}-${Date.now()}.pdf`;
    const { error: uploadError } = await supabase.storage.from('dokumen-mitra').upload(fileName, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) throw uploadError;
    const { data: { publicUrl } } = supabase.storage.from('dokumen-mitra').getPublicUrl(fileName);
    const fieldName = `file_${jenis_file}`;
    const { error: dbError } = await supabase.from('mitra').update({ [fieldName]: publicUrl }).eq('id', id);
    if (dbError) throw dbError;
    console.log(`✅ Upload sukses: ${jenis_file.toUpperCase()} untuk mitra ${id}`);
    res.redirect(`/mitra/${id}`);
  } catch (err) {
    console.error('❌ Error upload:', err.message);
    res.status(500).send(`Gagal upload: ${err.message}`);
  }
});

// 🔹 DETAIL MITRA
app.get('/mitra/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('🔍 Mencari mitra dengan ID:', id);
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error) { console.error('❌ Supabase Error:', error); return res.status(500).send(`❌ Database Error: ${error.message}`); }
    if (!mitra) { console.warn('⚠️ Mitra tidak ditemukan untuk ID:', id); return res.status(404).send('❌ Mitra tidak ditemukan'); }
    console.log('✅ Data mitra ditemukan:', mitra.nama_instansi);
    const today = new Date();
    const endDate = new Date(mitra.tanggal_berakhir);
    if (isNaN(endDate.getTime())) { console.error('❌ Invalid date:', mitra.tanggal_berakhir); return res.status(500).send('❌ Format tanggal_berakhir tidak valid'); }
    const diffDays = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
    let status, color;
    if (diffDays <= 7) { status = 'Segera Berakhir'; color = 'red'; }
    else if (diffDays <= 30) { status = 'Akan Berakhir'; color = 'orange'; }
    else { status = 'Aktif'; color = 'green'; }
    console.log(`📊 Status: ${status} (${diffDays} hari)`);
    res.render('detail-mitra', { mitra: { ...mitra, sisa_hari: diffDays, status, color } });
  } catch (err) {
    console.error('💥 Unexpected Error:', err);
    res.status(500).send(`💥 Gagal memuat detail mitra: ${err.message}`);
  }
});

// 🔹 Redirect by Kode Mitra
app.get('/mitra/kode/:kode', async (req, res) => {
  try {
    const { kode } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('id').eq('kode_mitra', kode.toUpperCase()).single();
    if (error || !mitra) throw new Error('Kode mitra tidak ditemukan');
    res.redirect(`/mitra/${mitra.id}`);
  } catch (err) { res.status(404).send('❌ Mitra dengan kode tersebut tidak ditemukan'); }
});

// 🔹 FORM Edit & UPDATE (Opsional)
app.get('/mitra/:id/edit', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    res.render('form-mitra', { mitra, action: 'edit' });
  } catch (err) { res.status(500).send('Gagal memuat form edit'); }
});

app.post('/mitra/:id/update', async (req, res) => {
  try {
    const { id } = req.params;
    const { nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir } = req.body;
    const { error } = await supabase.from('mitra').update({ nama_instansi, nama_kontak, jabatan, alamat, no_hp_kontak, email_fakultas, tanggal_mulai, tanggal_berakhir }).eq('id', id);
    if (error) throw error;
    res.redirect(`/mitra/${id}`);
  } catch (err) { console.error('❌ Error update:', err.message); res.status(500).send('Gagal update data'); }
});

// 🔹 ROUTE: /test-alert — SUPER DEBUG
app.get('/test-alert', async (req, res) => {
  console.log('🧪 [SUPER DEBUG] Memulai test alert...');
  try {
    const today = new Date();
    const formatDateLocal = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };
    const todayStr = formatDateLocal(today);
    const maxDate = new Date(); maxDate.setDate(today.getDate() + 30);
    const maxDateStr = formatDateLocal(maxDate);
    console.log(`📅 Rentang alert: ${todayStr} s/d ${maxDateStr}`);
    
    const { data: allMitra, error } = await supabase.from('mitra').select('*').order('tanggal_berakhir', { ascending: true });
    if (error) { console.error('❌ Query error:', error); return res.status(500).send(`❌ Database error: ${error.message}`); }
    
    const inRange = allMitra?.filter(m => {
      const endDate = new Date(m.tanggal_berakhir);
      const sisa = Math.ceil((endDate - today) / (1000*60*60*24));
      return sisa >= 0 && sisa <= 30;
    }) || [];
    
    let html = `<!DOCTYPE html><html><head><title>🔍 Super Debug</title><style>
      body{font-family:monospace;padding:20px;background:#f9f9f9}.header{background:#007bff;color:white;padding:15px;border-radius:8px;margin-bottom:20px}
      .summary{background:#fff;padding:15px;border-radius:8px;margin-bottom:20px;border-left:4px solid #28a745}
      table{width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden}
      th,td{padding:10px;border:1px solid #ddd;text-align:left;font-size:12px}th{background:#f5f5f5}
      .match{background:#d4edda}.nomatch{background:#f8d7da}.code{background:#f0f0f0;padding:2px 6px;border-radius:3px}
      .btn{padding:8px 16px;background:#007bff;color:white;text-decoration:none;border-radius:4px;display:inline-block;margin:5px 0}
    </style></head><body>
      <div class="header"><h2>🔍 Super Debug - Test Alert SI Mitra DUDIKA</h2>
      <p>Server Time: <strong>${new Date().toLocaleString('id-ID')}</strong></p>
      <p>Rentang Alert: <code>${todayStr}</code> s/d <code>${maxDateStr}</code> (30 hari ke depan)</p></div>
      <div class="summary"><strong>📊 Ringkasan:</strong><br>
      • Total mitra: <strong>${allMitra?.length || 0}</strong><br>
      • Dalam rentang alert: <strong>${inRange.length}</strong><br>
      • Tepat 30/14/7 hari: <strong>${inRange.filter(m => [30,14,7].includes(Math.ceil((new Date(m.tanggal_berakhir)-today)/(1000*60*60*24)))).length}</strong></div>
      <h3>🗄️ Semua Data Mitra</h3><table><thead><tr><th>ID</th><th>Kode</th><th>Instansi</th><th>Email</th><th>Berakhir</th><th>Sisa</th><th>Status</th><th>File</th></tr></thead><tbody>`;
    
    allMitra?.forEach(mitra => {
      const endDate = new Date(mitra.tanggal_berakhir);
      const diffDays = Math.ceil((endDate - today) / (1000*60*60*24));
      const isInRange = diffDays >= 0 && diffDays <= 30;
      const isExact = [30,14,7].includes(diffDays);
      let status, color;
      if (diffDays <= 7) { status = '🔴 Segera'; color = '#dc3545'; }
      else if (diffDays <= 30) { status = '🟡 Akan'; color = '#ffc107'; }
      else if (diffDays < 0) { status = '⚫ Expired'; color = '#6c757d'; }
      else { status = '🟢 Aktif'; color = '#28a745'; }
      const files = [mitra.file_mou?'MoU':'', mitra.file_moa?'MoA':'', mitra.file_ia?'IA':'', mitra.file_pks?'PKS':''].filter(Boolean);
      html += `<tr class="${isInRange?'match':'nomatch'}"><td><code>${mitra.id?.slice(0,8)}...</code></td><td>${mitra.kode_mitra||'-'}</td><td><strong>${mitra.nama_instansi}</strong></td><td><a href="mailto:${mitra.email_fakultas}">${mitra.email_fakultas}</a></td><td><code>${mitra.tanggal_berakhir}</code><br><small>Type: ${typeof mitra.tanggal_berakhir}</small></td><td style="font-weight:bold;color:${color}">${diffDays} hari</td><td><span style="background:${color};color:white;padding:3px 8px;border-radius:10px;font-size:11px">${status}</span>${isExact?'<br>✅ Threshold!':''}</td><td>${files.join(', ')||'-'}</td></tr>`;
    });
    
    html += `</tbody></table>`;
    if (inRange.length > 0) {
      const testMitra = inRange[0];
      const sisa = Math.ceil((new Date(testMitra.tanggal_berakhir) - today) / (1000*60*60*24));
      html += `<div style="margin-top:30px;padding:20px;background:#d4edda;border-radius:8px;border-left:4px solid #28a745"><h3>🎯 Test Kirim Email</h3><p><strong>Mitra:</strong> ${testMitra.nama_instansi}<br><strong>Email:</strong> ${testMitra.email_fakultas}<br><strong>Sisa:</strong> ${sisa} hari</p><form method="POST" action="/test-alert/send"><input type="hidden" name="mitra_id" value="${testMitra.id}"><button type="submit" class="btn">📧 Kirim Email Test</button></form></div>`;
    }
    html += `<p style="margin-top:30px"><a href="/mitra" class="btn">← Dashboard</a></p></body></html>`;
    res.send(html);
  } catch (err) {
    console.error('💥 Super Debug Error:', err);
    res.status(500).send(`<pre>💥 Error: ${err.message}\n\n${err.stack}</pre>`);
  }
});

// 🔹 POST: Kirim Email Test
app.post('/test-alert/send', async (req, res) => {
  try {
    const { mitra_id } = req.body;
    const { data: mitra, error } = await supabase.from('mitra').select('*').eq('id', mitra_id).single();
    if (error || !mitra) return res.status(404).send('Mitra tidak ditemukan');
    const today = new Date();
    const endDate = new Date(mitra.tanggal_berakhir);
    const sisa_hari = Math.ceil((endDate - today) / (1000*60*60*24));
    const subject = `🧪 [TEST] Alert: "${mitra.nama_instansi}" Berakhir dalam ${sisa_hari} Hari`;
    const sent = await sendAlertEmail({ to: mitra.email_fakultas, subject, mitra: { ...mitra, sisa_hari } });
    res.send(sent ? `✅ Email terkirim ke ${mitra.email_fakultas}<br><a href="/test-alert">← Kembali</a>` : `❌ Gagal kirim. Cek terminal.`);
  } catch (err) { res.status(500).send(`Error: ${err.message}`); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server aktif di http://localhost:${PORT}`));