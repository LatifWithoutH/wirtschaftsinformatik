require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

// Gunakan service_role key agar bypass RLS saat setup awal
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

// 👥 Daftar akun yang akan dibuat
const accounts = [
  { email: 'humas@uniba.ac.id',      password: 'Humas2026!', role: 'humas',           fakultas_id: null },
  { email: 'admin.fti@uniba.ac.id',  password: 'Fti2026!',   role: 'admin_fakultas', fakultas_id: 'fti' },
  { email: 'admin.fek@uniba.ac.id',  password: 'Fek2026!',   role: 'admin_fakultas', fakultas_id: 'fek' },
  { email: 'guest.dosen@uniba.ac.id',password: 'Guest123!',  role: 'guest',           fakultas_id: null }
];

async function seedAccounts() {
  console.log('🌱 Memulai pembuatan akun (mode UPSERT)...');
  
  for (const acc of accounts) {
    try {
      // Hash password (selalu generate hash baru)
      const password_hash = await bcrypt.hash(acc.password, 10);
      
      // Upsert: insert baru ATAU update jika email sudah ada
      const { error } = await supabase
        .from('users')
        .upsert({ 
          email: acc.email, 
          password_hash, 
          role: acc.role, 
          fakultas_id: acc.fakultas_id 
        }, { 
          onConflict: 'email',
          ignoreDuplicates: false
        });

      if (error) {
        console.error(`❌ Gagal ${acc.email}:`, error.message);
      } else {
        console.log(`✅ ${acc.email} → Role: ${acc.role} [${error ? 'updated' : 'inserted'}]`);
      }
    } catch (err) {
      console.error(`💥 Error ${acc.email}:`, err.message);
    }
  }
  
  console.log('\n🏁 Selesai! Cek tabel "users" di Supabase Dashboard.');
  console.log('💡 Jangan lupa hapus file ini setelah selesai setup.');
}

seedAccounts();
