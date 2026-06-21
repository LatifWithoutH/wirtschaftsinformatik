// ========================================================================
// 🛡️ BRUTE-FORCE TESTER v2.0 - SI MITRA DUDIKA
// ========================================================================
// Fitur:
// ✅ Deteksi via HTTP Status Code (paling akurat - cek 429)
// ✅ Deteksi via text matching (backup)
// ✅ Deteksi countdown timer (bukti visual)
// ✅ Deteksi tombol disabled (bukti form terkunci)
// ✅ Screenshot otomatis saat rate limited
// ✅ Statistik hasil di akhir test
// ✅ Log rapi ke file dengan emoji
// ========================================================================

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ========================================================================
// 🔧 KONFIGURASI
// ========================================================================
const CONFIG = {
    BASE_URL: 'https://si-mitra-dudika.onrender.com',
    EMAIL: 'guest@uniba.ac.id',          // Email yang terdaftar (bisa juga email palsu)
    WRONG_PASSWORD: 'passwordSalah123!',
    ATTEMPTS: 10,                         // Jumlah percobaan login
    DELAY_MS: 1500,                       // Delay antar percobaan (ms)
    LOG_FILE: './docs/login-rate-limit-test.log',
    SCREENSHOT_DIR: './docs/screenshots/rate-limit-test',
    RATE_LIMIT_THRESHOLD: 5,              // Sesuai konfigurasi di server.js (max: 5)
};

// ========================================================================
// 🎨 HELPER: Warna untuk console
// ========================================================================
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

const log = {
    info: (msg) => console.log(`${colors.cyan}ℹ️  ${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
    attempt: (n, total) => console.log(`\n${colors.bold}${colors.magenta}━━━ Percobaan ${n}/${total} ━━━${colors.reset}`),
};

// ========================================================================
// 🚀 FUNGSI UTAMA
// ========================================================================
async function testRateLimit() {
    console.log(`${colors.bold}${colors.blue}`);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   🛡️  BRUTE-FORCE TESTER v2.0                      ║');
    console.log('║   SI Mitra DUDIKA - UNIBA Surakarta                ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(colors.reset);

    log.info(`Target     : ${CONFIG.BASE_URL}`);
    log.info(`Email      : ${CONFIG.EMAIL}`);
    log.info(`Percobaan  : ${CONFIG.ATTEMPTS} kali`);
    log.info(`Threshold  : ${CONFIG.RATE_LIMIT_THRESHOLD} percobaan gagal`);
    log.info(`Delay      : ${CONFIG.DELAY_MS}ms antar percobaan`);
    console.log('');

    // Pastikan folder screenshot ada
    if (!fs.existsSync(CONFIG.SCREENSHOT_DIR)) {
        fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });
    }
    if (!fs.existsSync('./docs')) {
        fs.mkdirSync('./docs', { recursive: true });
    }

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1280, height: 800 },
        args: ['--no-sandbox']
    });

    const page = await browser.newPage();
    const results = [];
    const logs = [];

    // ========================================================================
    // 📊 INTERCEPT RESPONSE - Tangkap HTTP Status Code
    // ========================================================================
    let lastResponseStatus = 200;
    let lastResponseUrl = '';

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/login') && response.request().method() === 'POST') {
            lastResponseStatus = response.status();
            lastResponseUrl = url;
        }
    });

    // ========================================================================
    // 🔄 LOOP PERCOBAAN LOGIN
    // ========================================================================
    for (let i = 1; i <= CONFIG.ATTEMPTS; i++) {
        log.attempt(i, CONFIG.ATTEMPTS);

        try {
            // Reset status code
            lastResponseStatus = 200;

            // 1. Buka halaman login
            await page.goto(`${CONFIG.BASE_URL}/login`, {
                waitUntil: 'networkidle2',
                timeout: 15000
            });

            // 2. Tunggu form muncul
            await page.waitForSelector('#email', { timeout: 5000 });

            // 3. Clear input (jaga-jaga kalau ada value lama)
            await page.evaluate(() => {
                document.querySelector('#email').value = '';
                document.querySelector('#password').value = '';
            });

            // 4. Ketik email & password salah
            await page.type('#email', CONFIG.EMAIL, { delay: 30 });
            await page.type('#password', CONFIG.WRONG_PASSWORD, { delay: 30 });

            // 5. Klik submit & tunggu navigasi
            await Promise.allSettled([
                page.click('button[type="submit"]'),
                page.waitForNavigation({
                    waitUntil: 'networkidle2',
                    timeout: 8000
                }).catch(() => {}) // Abaikan timeout jika tidak ada navigasi
            ]);

            // Tunggu sebentar agar DOM stabil
            await new Promise(r => setTimeout(r, 500));

            // ========================================================================
            // 🔍 DETEKSI MULTI-LAYER
            // ========================================================================
            
            // LAYER 1: Cek HTTP Status Code (PALING AKURAT)
            let result = 'UNKNOWN';
            let detectionMethod = '';
            let details = {};

            if (lastResponseStatus === 429) {
                result = 'RATE LIMITED';
                detectionMethod = 'HTTP 429';
                details.httpStatus = 429;
            } 
            // LAYER 2: Cek teks di halaman
            else {
                const bodyText = await page.evaluate(() => document.body.innerText);
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('#errorMsg, .error');
                    return el ? el.innerText.toLowerCase() : '';
                });

                // Cek berbagai kemungkinan pesan
                if (errorMsg.includes('dikunci') || errorMsg.includes('terlalu banyak') || 
                    errorMsg.includes('coba lagi nanti') || errorMsg.includes('rate limit')) {
                    result = 'RATE LIMITED';
                    detectionMethod = 'Text: "dikunci/terlalu banyak"';
                    details.errorText = errorMsg.substring(0, 80);
                }
                else if (bodyText.toLowerCase().includes('password salah') || 
                         bodyText.toLowerCase().includes('email tidak ditemukan')) {
                    result = 'LOGIN FAILED';
                    detectionMethod = 'Text: "password salah"';
                }
                else if (bodyText.toLowerCase().includes('dashboard')) {
                    result = 'LOGIN SUCCESS';
                    detectionMethod = 'Redirect ke dashboard';
                }
            }

            // LAYER 3: Cek countdown timer (bukti visual tambahan)
            if (result === 'RATE LIMITED') {
                const hasCountdown = await page.evaluate(() => {
                    return !!document.querySelector('#countdownTimer, #timeLeft, .countdown-container');
                });
                const isButtonDisabled = await page.evaluate(() => {
                    const btn = document.querySelector('#submitBtn');
                    return btn ? btn.disabled : false;
                });
                const countdownText = await page.evaluate(() => {
                    const el = document.querySelector('#timeLeft');
                    return el ? el.textContent : null;
                });

                details.hasCountdown = hasCountdown;
                details.isButtonDisabled = isButtonDisabled;
                details.countdownValue = countdownText;

                // Ambil screenshot saat rate limited
                const screenshotPath = path.join(
                    CONFIG.SCREENSHOT_DIR, 
                    `attempt-${String(i).padStart(2, '0')}-rate-limited.png`
                );
                await page.screenshot({ path: screenshotPath, fullPage: true });
                details.screenshot = screenshotPath;
            }

            // ========================================================================
            // 📝 CATAT HASIL
            // ========================================================================
            const timestamp = new Date().toISOString();
            const logEntry = {
                attempt: i,
                timestamp,
                result,
                detectionMethod,
                httpStatus: lastResponseStatus,
                details
            };
            results.push(logEntry);

            // Log ke console dengan warna
            const statusIcon = result === 'RATE LIMITED' ? '🔒' : 
                              result === 'LOGIN FAILED' ? '❌' : 
                              result === 'LOGIN SUCCESS' ? '✅' : '❓';
            
            console.log(`  ${statusIcon} Hasil     : ${colors.bold}${result}${colors.reset}`);
            console.log(`  📡 HTTP      : ${lastResponseStatus}`);
            console.log(`  🔍 Deteksi   : ${detectionMethod}`);
            if (details.countdownValue) {
                console.log(`  ⏱️  Timer     : ${details.countdownValue}`);
            }
            if (details.isButtonDisabled !== undefined) {
                console.log(`  🔐 Tombol    : ${details.isButtonDisabled ? 'DISABLED ✅' : 'ENABLED ❌'}`);
            }
            if (details.screenshot) {
                console.log(`  📸 Screenshot: ${details.screenshot}`);
            }

            // Log ke file (plain text)
            const logLine = `[${timestamp}] Attempt ${i}: ${result} (HTTP ${lastResponseStatus}) via ${detectionMethod}`;
            logs.push(logLine);

            // Delay antar percobaan
            if (i < CONFIG.ATTEMPTS) {
                log.info(`Menunggu ${CONFIG.DELAY_MS}ms sebelum percobaan berikutnya...`);
                await new Promise(r => setTimeout(r, CONFIG.DELAY_MS));
            }

        } catch (err) {
            log.error(`Error di percobaan ${i}: ${err.message}`);
            const errorLog = `[${new Date().toISOString()}] Attempt ${i}: ERROR - ${err.message}`;
            logs.push(errorLog);
            results.push({
                attempt: i,
                timestamp: new Date().toISOString(),
                result: 'ERROR',
                error: err.message
            });
        }
    }

    // ========================================================================
    // 📊 STATISTIK HASIL
    // ========================================================================
    console.log(`\n${colors.bold}${colors.blue}`);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   📊 HASIL AKHIR TEST                              ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(colors.reset);

    const stats = {
        total: results.length,
        loginFailed: results.filter(r => r.result === 'LOGIN FAILED').length,
        rateLimited: results.filter(r => r.result === 'RATE LIMITED').length,
        loginSuccess: results.filter(r => r.result === 'LOGIN SUCCESS').length,
        errors: results.filter(r => r.result === 'ERROR').length,
        unknown: results.filter(r => r.result === 'UNKNOWN').length,
    };

    console.log(`  Total Percobaan    : ${stats.total}`);
    console.log(`  ❌ Login Gagal     : ${stats.loginFailed} (seharusnya ${CONFIG.RATE_LIMIT_THRESHOLD})`);
    console.log(`  🔒 Rate Limited    : ${stats.rateLimited} (seharusnya ${stats.total - CONFIG.RATE_LIMIT_THRESHOLD})`);
    console.log(`  ✅ Login Sukses    : ${stats.loginSuccess}`);
    console.log(`  💥 Error           : ${stats.errors}`);
    console.log(`  ❓ Unknown         : ${stats.unknown}`);

    // ========================================================================
    // ✅ VERDIKT
    // ========================================================================
    console.log(`\n${colors.bold}`);
    const expectedRateLimited = stats.total - CONFIG.RATE_LIMIT_THRESHOLD;
    
    if (stats.rateLimited >= expectedRateLimited && stats.loginFailed === CONFIG.RATE_LIMIT_THRESHOLD) {
        console.log(`${colors.green}🎉 VERDIKT: RATE LIMITER BEKERJA DENGAN SEMPURNA!${colors.reset}`);
        console.log(`   Sistem berhasil memblokir setelah ${CONFIG.RATE_LIMIT_THRESHOLD} percobaan gagal.`);
        console.log(`   Brute-force attack TIDAK MUNGKIN dilakukan.`);
    } 
    else if (stats.rateLimited > 0) {
        console.log(`${colors.yellow}⚠️  VERDIKT: RATE LIMITER BEKERJA SEBAGIAN${colors.reset}`);
        console.log(`   Ditemukan ${stats.rateLimited} pemblokiran, tapi tidak sesuai ekspektasi.`);
        console.log(`   Periksa konfigurasi di server.js.`);
    }
    else {
        console.log(`${colors.red}🚨 VERDIKT: RATE LIMITER TIDAK BEKERJA!${colors.reset}`);
        console.log(`   Tidak ada pemblokiran yang terdeteksi.`);
        console.log(`   Pastikan 'loginLimiter' middleware sudah dipasang di route POST /login.`);
    }
    console.log(colors.reset);

    // ========================================================================
    // 💾 SIMPAN LOG
    // ========================================================================
    const logContent = [
        '================================================================',
        'BRUTE-FORCE TEST REPORT - SI MITRA DUDIKA',
        `Tanggal      : ${new Date().toLocaleString('id-ID')}`,
        `Target       : ${CONFIG.BASE_URL}`,
        `Email        : ${CONFIG.EMAIL}`,
        `Percobaan    : ${CONFIG.ATTEMPTS} kali`,
        `Threshold    : ${CONFIG.RATE_LIMIT_THRESHOLD} percobaan`,
        '================================================================',
        '',
        'HASIL DETAIL:',
        ...logs,
        '',
        '================================================================',
        'STATISTIK:',
        `Total Percobaan : ${stats.total}`,
        `Login Gagal     : ${stats.loginFailed}`,
        `Rate Limited    : ${stats.rateLimited}`,
        `Login Sukses    : ${stats.loginSuccess}`,
        `Error           : ${stats.errors}`,
        '================================================================',
    ].join('\n');

    fs.writeFileSync(CONFIG.LOG_FILE, logContent);
    log.success(`Log lengkap tersimpan di: ${CONFIG.LOG_FILE}`);
    log.success(`Screenshot tersimpan di: ${CONFIG.SCREENSHOT_DIR}/`);

    await browser.close();
    console.log(`\n${colors.bold}🏁 Test selesai! Browser ditutup.${colors.reset}\n`);
}

// ========================================================================
// 🚀 JALANKAN TEST
// ========================================================================
testRateLimit().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});