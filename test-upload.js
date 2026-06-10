require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

console.log('🔍 Tes Upload Langsung ke Folder...');

async function testUpload() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    const drive = google.drive({ version: 'v3', auth });

    // Kita buat file dummy kecil untuk tes
    const fileMetadata = {
      name: 'TEST_HUBUNGAN_BERHASIL.txt',
      parents: [process.env.DRIVE_BASE_FOLDER_ID] // Masuk ke folder spesifik
    };
    
    const media = {
      mimeType: 'text/plain',
      body: 'Jika file ini muncul di Google Drive, berarti penghubung sudah jadi! ✅'
    };

    console.log('🚀 Mencoba upload file tes...');
    
    const res = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });

    console.log('✅ SUKSES! File berhasil diupload.');
    console.log('📄 Nama File:', res.data.name);
    console.log('🔗 Link:', res.data.webViewLink);
    console.log('🎉 SILAKAN CEK FOLDER GOOGLE DRIVE ANDA SEKARANG!');

  } catch (error) {
    console.error('❌ GAGAL:', error.message);
    if (error.message.includes('File not found')) {
      console.log('💡 Penyebab: ID Folder salah ATAU Robot belum di-invite sebagai Editor ke folder tersebut.');
    } else if (error.message.includes('quota')) {
      console.log('💡 Penyebab: Robot belum di-share ke folder (masih pakai kuota sendiri yg 0GB).');
    }
  }
}

testUpload();
