// 📂 FILE: utils/gasUploader.js
// Helper untuk lempar file ke Google Drive via GAS Web App

async function uploadFileToDrive(fileBuffer, fileName, mimeType) {
    console.log(`🚀 [GAS Bridge] Mengirim ${fileName} ke Google Drive...`);

    // 1. Ubah Buffer file jadi format Base64 (teks)
    const base64File = fileBuffer.toString('base64');

    // 2. Siapkan data yang mau dikirim ke GAS
    const payload = {
        fileName: fileName,
        fileBase64: base64File,
        mimeType: mimeType
    };

    try {
        // 3. Kirim POST request ke URL GAS Web App
        // (Node.js v22 udah support native fetch, jadi gak perlu install node-fetch)
        const response = await fetch(process.env.GAS_WEB_APP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' }, // Trik biar gak kena CORS
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        // 4. Cek balasan dari GAS
        if (result.success) {
            console.log(`✅ [GAS Bridge] Sukses! Link: ${result.previewLink}`);
            return result.previewLink; // Kembalikan link Drive-nya
        } else {
            throw new Error(result.error || 'Gagal upload ke Drive');
        }
    } catch (error) {
        console.error('❌ [GAS Bridge] Error:', error.message);
        throw error;
    }
}

// Biar bisa dipanggil dari file lain (test-tampilan.js)
module.exports = { uploadFileToDrive };
