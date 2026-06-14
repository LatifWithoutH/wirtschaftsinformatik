require('dotenv').config();
const { google } = require('googleapis');

console.log('👁️ Memulai Tes View (Hanya Membaca) ke Google Drive...');

// 1. Setup Auth menggunakan file JSON
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'] // Mode Baca Saja
});

const drive = google.drive({ version: 'v3', auth });
const folderId = process.env.DRIVE_BASE_FOLDER_ID;

async function testView() {
  try {
    console.log(`📂 Mencoba mengakses Folder ID: ${folderId}`);

    // 2. List semua file di dalam folder tersebut
    const res = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: 'files(id, name, mimeType, createdTime)',
      pageSize: 10
    });

    const files = res.data.files;

    if (files.length === 0) {
      console.log('⚠️ Koneksi Berhasil, tapi Folder masih KOSONG.');
      console.log('💡 Tips: Coba upload 1 file manual via browser ke folder ini, lalu jalankan script lagi.');
    } else {
      console.log(`✅ SUKSES! Ditemukan ${files.length} file di folder:`);
      files.forEach((file) => {
        console.log(`   📄 ${file.name} (${file.mimeType})`);
      });
    }
    
    console.log('\n🎉 Tes View Selesai. Jembatan Izin Baca Sudah Terbentuk!');

  } catch (error) {
    console.error('❌ GAGAL VIEW:', error.message);
    if (error.message.includes('File not found')) {
      console.log('💡 Penyebab Umum:');
      console.log('   1. Folder ID salah.');
      console.log('   2. Service Account BELUM di-share sebagai "Editor" atau "Viewer" di folder tersebut via Browser Google Drive.');
    }
  }
}

testView();
