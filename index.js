require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const GHL_API_KEY        = process.env.GHL_API_KEY;
const GHL_LOCATION_ID    = process.env.GHL_LOCATION_ID;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACADEMY_ID         = process.env.ACADEMY_ID;
const SUPERADMIN_TOKEN   = process.env.SUPERADMIN_TOKEN;
const PORT               = process.env.PORT || 3001;

// ── POST /webhook/student-registered ─────────────────
// Llamado desde Supabase Database Webhook cuando se inserta un nuevo perfil
app.post('/webhook/student-registered', async (req, res) => {
  const record = req.body?.record;
  if (!record) return res.status(400).json({ error: 'No record' });

  const { name, email, belt = 'white' } = record;
  if (!email) return res.status(400).json({ error: 'No email' });

  try {
    const response = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        firstName: name?.split(' ')[0] || name,
        lastName:  name?.split(' ').slice(1).join(' ') || '',
        email,
        tags: ['alumno', `cinturon-${belt}`, 'tatami-app'],
        customFields: [
          { key: 'belt', field_value: belt },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('GHL error:', data);
      return res.status(500).json({ error: data });
    }

    console.log(`✅ Contacto creado en GHL: ${email} (${name})`);
    return res.json({ success: true, ghl_id: data.contact?.id });

  } catch (err) {
    console.error('Error conectando con GHL:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/ghl-contact-converted ──────────────
// Llamado desde GHL cuando un contacto pasa a "Cliente" en el pipeline
app.post('/webhook/ghl-contact-converted', async (req, res) => {
  const { email, firstName, lastName, phone, tags } = req.body;
  if (!email) return res.status(400).json({ error: 'No email' });

  const name = [firstName, lastName].filter(Boolean).join(' ') || email;

  try {
    // 1. Crear usuario en Supabase Auth con invitación (manda email para poner contraseña)
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { name, academy_id: ACADEMY_ID, role: 'student' },
      }),
    });

    const authData = await authRes.json();
    if (!authRes.ok) {
      // Si el usuario ya existe, no es un error
      if (authData.msg?.includes('already been registered')) {
        console.log(`ℹ️ Usuario ya existe en Supabase: ${email}`);
        return res.json({ success: true, note: 'already exists' });
      }
      console.error('Supabase auth error:', authData);
      return res.status(500).json({ error: authData });
    }

    const userId = authData.id;

    // 2. Crear perfil en tabla profiles
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        id: userId,
        name,
        email,
        academy_id: ACADEMY_ID,
        role: 'student',
        belt: 'white',
        stripes: 0,
      }),
    });

    if (!profileRes.ok) {
      const profileErr = await profileRes.json();
      // Perfil ya existe — no es un error, el usuario ya estaba en la app
      if (profileErr.code === '23505') {
        console.log(`ℹ️ Perfil ya existe: ${email}`);
        return res.json({ success: true, note: 'profile already exists' });
      }
      console.error('Supabase profile error:', profileErr);
      return res.status(500).json({ error: profileErr });
    }

    // 3. Mandar email de invitación para que el alumno ponga su contraseña
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email_confirm: true }),
    });

    console.log(`✅ Usuario creado en app desde GHL: ${email} (${name})`);
    return res.json({ success: true, user_id: userId });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/create-academy ────────────────────────
// Crea academia + usuario admin en una sola llamada
app.post('/admin/create-academy', async (req, res) => {
  // Protección básica con token
  const token = req.headers['x-admin-token'];
  if (!SUPERADMIN_TOKEN || token !== SUPERADMIN_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { academyName, ownerName, ownerEmail, ownerPassword } = req.body;
  if (!academyName || !ownerName || !ownerEmail || !ownerPassword) {
    return res.status(400).json({ error: 'Faltan campos: academyName, ownerName, ownerEmail, ownerPassword' });
  }

  try {
    // 1. Crear academia
    const academyRes = await fetch(`${SUPABASE_URL}/rest/v1/academies`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ name: academyName }),
    });
    const academyData = await academyRes.json();
    if (!academyRes.ok) {
      console.error('Error creando academia:', academyData);
      return res.status(500).json({ error: 'Error creando academia', detail: academyData });
    }
    const academyId = academyData[0].id;

    // 2. Crear usuario admin en Supabase Auth
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: { name: ownerName, academy_id: academyId, role: 'admin' },
      }),
    });
    const authData = await authRes.json();
    if (!authRes.ok) {
      console.error('Error creando usuario:', authData);
      return res.status(500).json({ error: 'Error creando usuario', detail: authData });
    }
    const userId = authData.id;

    // 3. Crear perfil del admin
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        id: userId,
        name: ownerName,
        email: ownerEmail,
        academy_id: academyId,
        role: 'admin',
        belt: 'black',
        stripes: 0,
      }),
    });
    if (!profileRes.ok) {
      const profileErr = await profileRes.json();
      console.error('Error creando perfil:', profileErr);
      return res.status(500).json({ error: 'Error creando perfil', detail: profileErr });
    }

    const studentLink = `https://marvelous-donut-8bd463.netlify.app?academy_id=${academyId}`;
    const adminLink   = `https://marvelous-donut-8bd463.netlify.app`;
    console.log(`✅ Academia creada: ${academyName} (${academyId})`);
    return res.json({ success: true, academyId, studentLink, adminLink });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'tatami-webhook-server' }));

app.listen(PORT, () => console.log(`🚀 Webhook server corriendo en puerto ${PORT}`));
