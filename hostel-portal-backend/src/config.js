import 'dotenv/config';

const need = (key) => {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
  return process.env[key];
};

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: need('DATABASE_URL'),
  dbSsl: process.env.DB_SSL === 'true',
  jwtSecret: need('JWT_SECRET'),
  academicYear: process.env.ACADEMIC_YEAR || '2026-27',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || '',
  bucket: process.env.STORAGE_BUCKET || 'documents',
  supabaseAnonKey: need('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
};
