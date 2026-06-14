require('dotenv').config();
const { google } = require('googleapis');
const { Readable } = require('stream');

console.log('🕵️‍♂️ [VERBOSE LOG] Memulai investigasi upload ke Google Drive...');
console.log('------------------------------------------------------------');

// 1. Cek Konfigurasi Awal
console.log('1️⃣ Mengecek kredensial...');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('❌ ERROR: GOOGLE_APPLICATION_CREDENTIALS tidak ditemukan di .env');
  process.exit(1);
}
console.log(`   ✅ Path JSON: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);

if (!process.env.DRIVE_BASE_FOLDER_ID) {
  console.error('❌ ERROR: DRIVE_BASE_FOLDER_ID tidak ditemukan di .env');
  process.exit(1);
}
console.log(`   ✅ Folder ID: ${process.env.DRIVE_BASE_FOLDER_ID}`);

// 2. Inisialisasi Auth
console.log('\n2️⃣ Membuat koneksi autentikasi (Google Auth)...');
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  console.log('   ✅ Objek Auth berhasil dibuat.');

  // Cek identitas robot
  auth.getClient().then(client => {
    console.log(`   🤖 Identitas Robot: ${client.credentials.client_email}`);
  });

  const drive = google.drive({ version: 'v3', auth });

  // 3. Proses Upload
  console.log('\n3️⃣ Menyiapkan file pancingan (test-verbose.txt)...');
  const bufferStream = new Readable();
  bufferStream.push('Halo! Ini adalah tes upload verbose untuk melacak proses.');
  bufferStream.push(null);

  const fileMetadata = {
    name: 'test-verbose-log.txt',
    parents: [process.env.DRIVE_BASE_FOLDER_ID]
  };

  const media = {
    mimeType: 'text/plain',
    body: bufferStream
  };

  console.log('   🚀 Mengirim permintaan upload ke Google API...');
  console.log('   (Tahap ini mungkin memakan waktu beberapa detik...)');

  drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  })
  .then(response => {
    console.log('\n✅✅✅ SUKSES BESAR! ✅✅✅');
    console.log('   📄 File Name:', response.data.name);
    console.log('   🆔 File ID:', response.data.id);
    console.log('   🔗 Link:', response.data.webViewLink);
    console.log('\n💡 Kesimpulan: Jembatan upload sudah terbuka. Silakan restart server utama.');
  })
  .catch(error => {
    console.error('\n❌❌❌ GAGAL UPLOAD ❌❌❌');
    console.error('   Pesan Error:', error.message);
    
    if (error.message.includes('storage quota')) {
      console.log('\n🔍 ANALISIS MASALAH:');
      console.log('   - Robot berhasil login (Auth OK).');
      console.log('   - Robot bisa melihat folder (View OK).');
      console.log('   - Tapi Google menolak penyimpanan karena Robot dianggap "tamu tanpa kamar".');
      console.log('\n🛠️ SOLUSI MANUAL (WAJIB DILAKUKAN DI BROWSER):');
      console.log('   1. Buka Google Drive akun latifsmart123@gmail.com');
      console.log('   2. Klik kanan folder target -> Share (Bagikan).');
      console.log('   3. Masukkan email robot: si-mitra-uploader@si-mitra-uniba.iam.gserviceaccount.com');
      console.log('   4. PASTIKAN pilih peran: EDITOR (Bukan Viewer).');
      console.log('   5. Klik Send/Bagikan.');
      console.log('   6. Tunggu 1 menit, lalu jalankan script ini lagi.');
    } else {
      console.log('\n🔍 Detail Error Lengkap:', error.errors);
    }
  });

} catch (err) {
  console.error('❌ Error saat inisialisasi:', err.message);
}