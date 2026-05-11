import { initPostgres, getPool, closePool } from './dist/config/postgres.js';

initPostgres({
  host: 'localhost',
  port: 5433,
  database: 'astra',
  user: 'astra',
  password: process.env.PG_PASSWORD || 'astra',
  useSocket: false,
  maxConnections: 2,
});

const pool = getPool();

// Check if standalone_user exists
const { rows: before } = await pool.query(
  "SELECT id, email FROM users WHERE id = $1",
  ["standalone_user"],
);
console.log("Before:", before);

// Try inserting
try {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    ["standalone_user", "standalone@local", "standalone", "Standalone User"],
  );
  console.log("INSERT succeeded");
} catch (err) {
  console.error("INSERT failed:", err.message);
}

const { rows: after } = await pool.query(
  "SELECT id, email FROM users WHERE id = $1",
  ["standalone_user"],
);
console.log("After:", after);

await closePool();
