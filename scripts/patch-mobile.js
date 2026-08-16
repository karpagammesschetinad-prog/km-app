const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'mobile');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'login.html');
files.forEach(file => {
  let c = fs.readFileSync(path.join(dir, file), 'utf8');
  // Fix absolute paths to relative
  c = c.replace(/src="\/js\//g, 'src="js/').replace(/href="\/css\//g, 'href="css/').replace(/href="\/icons\//g, 'href="icons/');
  // Inject api.js before main.js
  c = c.replace('<script src="js/main.js"></script>', '<script src="js/api.js"></script>\n<script src="js/main.js"></script>');
  fs.writeFileSync(path.join(dir, file), c);
  console.log('Patched:', file);
});
