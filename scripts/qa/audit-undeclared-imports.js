const fs = require('fs');
const path = require('path');

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const usesPath = /\bpath\.(resolve|join|normalize|extname|basename|dirname)\b/.test(content);
  const requiresPath = /require\(['"]path['"]\)/.test(content);
  const usesFs = /\bfs\.(existsSync|readFileSync|writeFileSync|statSync|createReadStream|createWriteStream|unlinkSync|mkdirSync)\b/.test(content);
  const requiresFs = /require\(['"]fs['"]\)/.test(content);
  const usesCrypto = /\bcrypto\.(createHash|createHmac|randomBytes|timingSafeEqual)\b/.test(content);
  const requiresCrypto = /require\(['"]crypto['"]\)/.test(content);

  const issues = [];
  if (usesPath && !requiresPath) issues.push('uses path without require("path")');
  if (usesFs && !requiresFs) issues.push('uses fs without require("fs")');
  if (usesCrypto && !requiresCrypto) issues.push('uses crypto without require("crypto")');

  if (issues.length > 0) {
    console.log(filePath + ': ' + issues.join(', '));
  }
}

function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && !['node_modules', '.git', '.storage'].includes(item.name)) {
      scan(full);
    } else if (item.isFile() && item.name.endsWith('.js')) {
      checkFile(full);
    }
  }
}

console.log('=== CHECKING FOR UNDECLARED BUILT-IN IMPORTS ===');
scan(path.resolve(__dirname, '../../routes'));
scan(path.resolve(__dirname, '../../services'));
scan(path.resolve(__dirname, '../../middleware'));
scan(path.resolve(__dirname, '../../models'));
scan(path.resolve(__dirname, '../../utils'));
console.log('=== DONE ===');
