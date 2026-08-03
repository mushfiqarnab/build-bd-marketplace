// generate-context.js
const fs = require('fs');
const path = require('path');

// 🛡️ Strict exclusions to prevent memory bloat and focus only on architecture
const EXCLUDED_DIRS = ['node_modules', '.git', 'uploads', 'logs', 'coverage'];
const EXCLUDED_FILES = ['.env', 'package-lock.json', 'package.json', 'generate-context.js'];
const ALLOWED_EXTENSIONS = ['.js', '.md', '.json'];

let output = '# 🏗️ BUILD-BD MARKETPLACE - MASTER ARCHITECTURAL MANIFEST\n\n';

function scanDirectory(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(file)) scanDirectory(fullPath);
    } else {
      if (!EXCLUDED_FILES.includes(file) && ALLOWED_EXTENSIONS.includes(path.extname(file))) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const relativePath = path.relative(__dirname, fullPath);
        output += `\n\n## 📄 FILE: ${relativePath}\n\`\`\`javascript\n${content}\n\`\`\`\n`;
      }
    }
  }
}

console.log('🔄 Compiling architectural matrix...');
scanDirectory(__dirname);
fs.writeFileSync('master-context.txt', output);
console.log('✅ Matrix compiled successfully: master-context.txt');