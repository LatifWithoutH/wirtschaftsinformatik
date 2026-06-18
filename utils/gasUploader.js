// 📂 FILE: utils/gasUploader.js (v3 - SIMPLE)

const GAS_TIMEOUT_MS = 60000;
const MAX_RETRIES    = 2;     

/**
 * Upload file PDF ke Google Drive via GAS
 * TANPA validasi jenis file - terima semua PDF!
 */
async function uploadFileToDrive(fileBuffer, fileName, mimeType, namaInstansi, kodeMitra) {
    const startTime = Date.now();
    const folderName = namaInstansi || 'Mitra Tanpa Nama';
    
    console.log(`📤 [GAS] Upload PDF: ${fileName} → folder "${folderName}"`);

    if (!fileBuffer || fileBuffer.length === 0) throw new Error('File buffer kosong');
    if (!process.env.GAS_WEB_APP_URL) throw new Error('GAS_WEB_APP_URL belum diset');
    if (!process.env.GAS_SECRET_TOKEN) throw new Error('GAS_SECRET_TOKEN belum diset');

    const base64File = fileBuffer.toString('base64');
    
    // ✨ PAYLOAD SIMPLE - TANPA jenis_file!
    const payload = {
        fileName,
        fileBase64: base64File,
        mimeType,           // harus 'application/pdf'
        nama_instansi: folderName,
        kode_mitra: kodeMitra || 'NO-CODE',
        token: process.env.GAS_SECRET_TOKEN
    };

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`🔄 [GAS] Attempt ${attempt}/${MAX_RETRIES}...`);
            const result = await callGAS(payload);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            
            const responseData = result.data || result; 
            
            console.log(`✅ [GAS] Sukses dalam ${duration}s`);
            
            return responseData.previewLink;
            
        } catch (error) {
            lastError = error;
            console.warn(`⚠️  [GAS] Attempt ${attempt} gagal: ${error.message}`);
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, attempt * 2000));
        }
    }
    throw new Error(`Upload gagal: ${lastError.message}`);
}

async function callGAS(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);

    try {
        const response = await fetch(process.env.GAS_WEB_APP_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body   : JSON.stringify(payload),
            signal : controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.trim().startsWith('<!DOCTYPE')) throw new Error('GAS return HTML');
        
        const result = JSON.parse(text);
        if (!result.success) throw new Error(result.error?.message || 'GAS menolak');
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') throw new Error('Timeout 60s');
        throw error;
    }
}

module.exports = { uploadFileToDrive };