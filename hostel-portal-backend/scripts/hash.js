// Make a bcrypt hash for a password:  node scripts/hash.js MyPassword123
// Then:  update users set password_hash = '<hash>' where email = 'admin@college.edu';
import bcrypt from 'bcryptjs';
const pw = process.argv[2];
if (!pw) { console.error('Usage: node scripts/hash.js Abhi@12345'); process.exit(1); }
console.log(bcrypt.hashSync(pw, 10));
