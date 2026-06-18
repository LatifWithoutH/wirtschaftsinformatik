const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 🔹 KONFIGURASI
const BASE_URL = 'http://localhost:3000';
const LOGIN_EMAIL = 'humas@uniba.ac.id';
const LOGIN_PASSWORD = 'akugantipass'; // Ganti dengan password asli humas
const OUTPUT_DIR = './docs/screenshots';

// 🔹 DAFTAR HALAMAN
const pages = [
  { url: '/dashboard', name: '01-dashboard', waitFor: 'body' },
  { url: '/mitra', name: '02-daftar-mitra', waitFor: 'table' },
  { url: '/mitra/tambah', name: '03-tambah-mitra', waitFor: 'form' },
  { url: '/users', name: '04-manajemen-user', waitFor: 'table' },
  { url: '/users/tambah', name: '05-tambah-user', waitFor: 'form' },
  { url: '/test-alert', name: '06-test-alert', waitFor: 'table' },
  { url: '/change-password', name: '07-ganti-password', waitFor: 'form' },
];

//  FUNGSI UTAMA
async function captureAllScreenshots() {
  console.log('🚀 Memulai capture screenshots...\n');
  
  // Buat folder output jika belum ada
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  try {
    // 1. LOGIN
    console.log('🔐 Login ke sistem...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2' });
    
    // Ganti selector ini sesuai dengan ID/nama form login kamu
    await page.type('#email', LOGIN_EMAIL);
    await page.type('#password', LOGIN_PASSWORD);
    
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);
    
    console.log('✅ Login berhasil!\n');
    
    // 2. CAPTURE SETIAP HALAMAN
    for (const p of pages) {
      console.log(` Capture: ${p.name}...`);
      
      try {
        await page.goto(`${BASE_URL}${p.url}`, { 
          waitUntil: 'networkidle2',
          timeout: 30000 
        });
        
        // ✅ PERBAIKAN: Tunggu elemen spesifik muncul (bukan timeout manual)
        await page.waitForSelector(p.waitFor, { timeout: 5000 }).catch(() => {
          console.log(`⚠️ Elemen '${p.waitFor}' tidak ditemukan, lanjut screenshot...`);
        });
        
        // Delay kecil agar chart/animasi selesai render (opsional)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Screenshot full page
        const screenshotPath = path.join(OUTPUT_DIR, `${p.name}.png`);
        await page.screenshot({ 
          path: screenshotPath, 
          fullPage: true 
        });
        
        console.log(`✅ Tersimpan: ${screenshotPath}\n`);
        
      } catch (err) {
        console.error(`❌ Gagal capture ${p.url}:`, err.message);
      }
    }
    
    console.log(' Selesai! Semua screenshot tersimpan di folder:', OUTPUT_DIR);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await browser.close();
  }
}

// Jalankan
captureAllScreenshots();