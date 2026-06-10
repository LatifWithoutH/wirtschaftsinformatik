require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

console.log('🔍 Memulai Tes Koneksi Google Drive (Metode File)...');

// 1. Cek apakah file kredensial ada
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials/drive.json';
const fullPath = path.resolve(credPath);

if (!fs.existsSync(fullPath)) {
  console.error(`❌ File kredensial tidak ditemukan di: ${fullPath}`);
  console.log('💡 Pastikan file credentials/drive.json sudah ada dan .env sudah diset.');
  process.exit(1);
}

console.log(`✅ File kredensial ditemukan: ${fullPath}`);

try {
  // 2. Inisialisasi Auth Google menggunakan keyFile
  const auth = new google.auth.GoogleAuth({
    keyFile: fullPath,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  console.log('✅ Objek Auth Google berhasil dibuat dari file JSON.');

  // 3. Tes Koneksi ke Drive API
  async function testDriveConnection() {
    try {
      const drive = google.drive({ version: 'v3', auth });
      
      // Cek Folder ID
      if (!process.env.DRIVE_BASE_FOLDER_ID) {
        throw new Error('DRIVE_BASE_FOLDER_ID tidak ditemukan di .env');
      }

      console.log(`📂 Mencoba akses Folder ID: ${process.env.DRIVE_BASE_FOLDER_ID}...`);

      // Coba list 1 file untuk tes izin akses
      const res = await drive.files.list({
        q: `'${process.env.DRIVE_BASE_FOLDER_ID}' in parents`,
        pageSize: 1,
        fields: 'files(id, name)'
      });

      console.log('✅ Koneksi ke Google Drive BERHASIL!');
      console.log('📄 File pertama di folder:', res.data.files.length > 0 ? res.data.files[0].name : '(Folder Kosong)');
      console.log('🎉 SETUP SELESAI. Silakan restart server utama (npx nodemon server.js)');
      
    } catch (apiError) {
      console.error('❌ Gagal konek ke Drive API. Error:', apiError.message);
      
      if (apiError.message.includes('File not found')) {
        console.log('💡 Tips: Cek DRIVE_BASE_FOLDER_ID di .env. Pastikan ID benar.');
        console.log('💡 Tips: Pastikan Service Account (email di drive.json) sudah di-invite sebagai "Editor" di folder Google Drive tersebut.');
      } else if (apiError.message.includes('invalid_grant')) {
        console.log('💡 Tips: Kredensial invalid. Cek apakah file JSON benar-benar dari Google Cloud Console.');
      } else {
        console.log('💡 Detail Error:', apiError.errors);
      }
    }
  }

  testDriveConnection();

} catch (err) {
  console.error('💥 Error Fatal:', err.message);
}