import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { HttpError } from './utils.js';

const supabase = config.supabaseUrl
  ? createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } })
  : null;

const bucket = () => {
  if (!supabase) throw new HttpError(500, 'File storage is not configured');
  return supabase.storage.from(config.bucket);
};

export async function putFile(path, buffer, contentType) {
  const { error } = await bucket().upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}

// Short-lived link to open a private file.
export async function signedUrl(path, seconds = 60) {
  const { data, error } = await bucket().createSignedUrl(path, seconds);
  if (error) throw new Error(`Could not create link: ${error.message}`);
  return data.signedUrl;
}

// PLACEHOLDER: connect a real scanner here (ClamAV daemon or a scanning API).
// Return false to reject the file.
export async function scanForVirus(_buffer) {
  return true;
}
