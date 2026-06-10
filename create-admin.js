require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function createAdmin() {
  const email = 'humas@uniba.ac.id';
  const password = 'admin123';
  const hash = await bcrypt.hash(password, 10);
  
  const { error } = await supabase.from('users').insert({
    email,
    password_hash: hash,
    role: 'humas',
    fakultas_id: null
  });

  if (error) console.error('❌ Gagal:', error.message);
  else console.log('✅ Akun berhasil! Email: humas@uniba.ac.id | Password: admin123');
}
createAdmin();
