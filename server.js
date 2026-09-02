const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!connectionString) {
  console.warn('DATABASE_URL no está configurada — el guardado compartido de escenarios fallará hasta que se conecte una base de datos Postgres.');
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('railway.internal') || connectionString.includes('rlwy.net')
        ? { rejectUnauthorized: false }
        : false,
    })
  : null;

async function ensureSchema() {
  if (!pool) return;
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  // A single JSONB column holds every field beyond nombre/autor — the scenario's
  // shape (comisión %, superávit %, efectividad por calor de sala, lotes, ...)
  // lives entirely in the frontend, so the server never needs to know its keys.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commission_scenarios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre TEXT NOT NULL,
      autor TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      params JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}

function toClient(row) {
  var params = row.params || {};
  return Object.assign({}, params, {
    id: row.id,
    nombre: row.nombre,
    autor: row.autor,
    createdAt: row.created_at,
  });
}

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, db: Boolean(pool) });
});

app.get('/api/scenarios', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const { rows } = await pool.query(
      'SELECT id, nombre, autor, created_at, params FROM commission_scenarios ORDER BY created_at DESC LIMIT 200'
    );
    res.json(rows.map(toClient));
  } catch (err) {
    console.error('GET /api/scenarios failed', err);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/scenarios', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'db_unavailable' });
  const body = req.body || {};
  const { nombre, autor, ...rest } = body;
  if (
    typeof nombre !== 'string' || !nombre.trim() ||
    typeof autor !== 'string' || !autor.trim() ||
    !Array.isArray(rest.lotes)
  ) {
    return res.status(400).json({ error: 'invalid_argument' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO commission_scenarios (nombre, autor, params)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, autor, created_at, params`,
      [nombre.trim().slice(0, 200), autor.trim().slice(0, 120), JSON.stringify(rest)]
    );
    res.status(201).json(toClient(rows[0]));
  } catch (err) {
    console.error('POST /api/scenarios failed', err);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/api/scenarios/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'db_unavailable' });
  try {
    await pool.query('DELETE FROM commission_scenarios WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/scenarios/:id failed', err);
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`comisiones-syc escuchando en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('No se pudo preparar el esquema de base de datos', err);
    process.exit(1);
  });
