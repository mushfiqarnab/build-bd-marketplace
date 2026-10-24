// Microscopic Deep Audit Scanner for Build-BD Marketplace
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const findings = {
  security: [],
  backendLogic: [],
  middleware: [],
  frontend: []
};

function addFinding(domain, severity, file, line, rule, detail, codeSnippet) {
  findings[domain].push({
    severity,
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    line,
    rule,
    detail,
    snippet: codeSnippet ? codeSnippet.trim() : ''
  });
}

function scanDir(dir, filter) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== '.storage') {
        results = results.concat(scanDir(full, filter));
      }
    } else if (!filter || filter(full)) {
      results.push(full);
    }
  }
  return results;
}

// 1. Audit Middlewares & server.js
function auditServerAndMiddleware() {
  const serverPath = path.join(ROOT, 'server.js');
  if (fs.existsSync(serverPath)) {
    const content = fs.readFileSync(serverPath, 'utf8');
    const lines = content.split('\n');
    
    // Check helmet
    const helmetIndex = lines.findIndex(l => l.includes('helmet('));
    const expressJsonIndex = lines.findIndex(l => l.includes('express.json('));
    const corsIndex = lines.findIndex(l => l.includes('cors('));
    const mongoSanitizeIndex = lines.findIndex(l => l.includes('mongoSanitize('));
    
    if (helmetIndex === -1) {
      addFinding('security', 'HIGH', serverPath, 1, 'HELMET_MISSING', 'Helmet middleware not found in server.js');
    }
    if (corsIndex !== -1 && helmetIndex !== -1 && corsIndex < helmetIndex) {
      // CORS before helmet is standard, check cors config
    }
    if (mongoSanitizeIndex === -1) {
      addFinding('security', 'HIGH', serverPath, 1, 'MONGO_SANITIZE_MISSING', 'express-mongo-sanitize middleware missing from server.js');
    }
    
    // Check error handling middleware at the end
    const lastUse = lines.map((l, i) => ({ l, i })).filter(x => x.l.includes('app.use(')).pop();
    if (lastUse && !lines.slice(lastUse.i - 20, lastUse.i + 20).join('\n').includes('(err, req, res, next)')) {
      addFinding('middleware', 'MEDIUM', serverPath, lastUse.i + 1, 'CENTRAL_ERROR_HANDLER', 'Central error handler might not be last in chain');
    }
  }

  // Audit middleware files
  const mwFiles = scanDir(path.join(ROOT, 'middleware'), f => f.endsWith('.js'));
  for (const mf of mwFiles) {
    const content = fs.readFileSync(mf, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // Check for JWT algorithm verification
      if (line.includes('jwt.verify') && !line.includes('algorithms:')) {
        addFinding('security', 'HIGH', mf, idx + 1, 'JWT_NO_ALGORITHM_PIN', 'jwt.verify called without explicitly pinning algorithms (vulnerable to alg: none / symmetric confusion)', line);
      }
      // Check for timing safe comparison
      if ((line.includes('===') || line.includes('==')) && (line.includes('secret') || line.includes('signature') || line.includes('token') || line.includes('hash'))) {
        if (!line.includes('crypto.timingSafeEqual') && !line.includes('typeof') && !line.includes('undefined')) {
          addFinding('security', 'LOW', mf, idx + 1, 'TIMING_ATTACK', 'Possible non-constant-time secret/token comparison', line);
        }
      }
    });
  }
}

// 2. Audit Routes for Security & Logic
function auditRoutes() {
  const routeFiles = scanDir(path.join(ROOT, 'routes'), f => f.endsWith('.js'));
  for (const rf of routeFiles) {
    const content = fs.readFileSync(rf, 'utf8');
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      
      // Check for NoSQL Injection: direct req.body/req.query inside find/findOne/update
      // e.g. { username: req.body.username } is safe, but find(req.body) or find(req.query) is NoSQL injection
      if (/find\s*\(\s*req\.(body|query)\s*\)/.test(line) || /findOne\s*\(\s*req\.(body|query)\s*\)/.test(line)) {
        addFinding('security', 'CRITICAL', rf, lineNum, 'NOSQL_INJECTION', 'Directly passing unvalidated req.body/req.query object to Mongoose find query', line);
      }
      
      // Check for Mass Assignment: Model.create(req.body) or Model.findByIdAndUpdate(..., req.body)
      if (/(create|findByIdAndUpdate|updateOne|updateMany)\s*\([^,)]*,\s*req\.body\s*[,)]/.test(line) ||
          /create\s*\(\s*req\.body\s*[,)]/.test(line)) {
        addFinding('security', 'HIGH', rf, lineNum, 'MASS_ASSIGNMENT', 'Unfiltered req.body passed directly to create/update query', line);
      }

      // Check for regex injection: new RegExp(req.query/req.body without escape)
      if (/new\s+RegExp\s*\(\s*req\.(query|body|params)\./.test(line) && !content.includes('escapeRegExp') && !line.includes('escape')) {
        addFinding('security', 'HIGH', rf, lineNum, 'REGEX_INJECTION', 'Unsanitized user input passed to new RegExp (ReDoS/Injection risk)', line);
      }
      
      // Check for float financial operations
      if ((line.includes('parseFloat') || line.includes('Number(') && line.includes('.')) && 
          (line.includes('price') || line.includes('amount') || line.includes('bdt') || line.includes('BDT') || line.includes('escrow') || line.includes('fee'))) {
        if (!line.includes('// safe') && !line.includes('parseInt') && !line.includes('Math.round') && !line.includes('Math.floor')) {
          addFinding('backendLogic', 'MEDIUM', rf, lineNum, 'FLOAT_MONEY_MATH', 'Possible floating point financial calculation', line);
        }
      }
      
      // Check for unhandled division: / [variable] without check
      if (/\/\s*[a-zA-Z0-9_.]+(?!\s*100)(?!\s*1000)(?!\s*60)(?!\s*24)(?!\s*3600)(?!\s*10000)/.test(line) && 
          (line.includes('rate') || line.includes('split') || line.includes('divide') || line.includes('average'))) {
        // flag for manual review
      }
      
      // Check for missing await on async Mongoose calls
      if (/(?<!await\s+)(?<!return\s+)\b(User|Project|Bid|Contract|EscrowLedger|MaterialOrder|DomesticWorkerProfile)\.(create|updateOne|updateMany|findByIdAndUpdate|save)\(/.test(line)) {
        addFinding('backendLogic', 'HIGH', rf, lineNum, 'MISSING_AWAIT', 'Possible missing await on database mutation', line);
      }
      
      // Check for transaction usage on multi-document financial updates
      if ((line.includes('lockedEscrow') || line.includes('availableBalance') || line.includes('escrowStatus')) && line.includes('save(')) {
        // check if surrounding lines use session
        const window = lines.slice(Math.max(0, idx - 15), Math.min(lines.length, idx + 15)).join('\n');
        if (!window.includes('session') && !window.includes('transaction') && !window.includes('runInTransaction')) {
          addFinding('backendLogic', 'MEDIUM', rf, lineNum, 'MUTATION_WITHOUT_SESSION', 'Financial state mutation without explicit Mongoose session/transaction in context', line);
        }
      }
      
      // Check for IDOR: finding by ID and updating without verifying owner/user
      if (/\.(findByIdAndUpdate|updateOne)\s*\(\s*(req\.params\.id|req\.body\.id)/.test(line)) {
        const window = lines.slice(Math.max(0, idx - 10), Math.min(lines.length, idx + 10)).join('\n');
        if (!window.includes('userId') && !window.includes('created_by') && !window.includes('buyer') && !window.includes('contractor') && !window.includes('requireRole') && !window.includes('req.user')) {
          addFinding('security', 'HIGH', rf, lineNum, 'IDOR_RISK', 'Direct update by ID without visible user ownership verification or role check', line);
        }
      }
    });
  }
}

// 3. Audit Frontend
function auditFrontend() {
  const feFiles = scanDir(path.join(ROOT, 'frontend'), f => f.endsWith('.js') || f.endsWith('.html'));
  
  for (const ff of feFiles) {
    const content = fs.readFileSync(ff, 'utf8');
    const lines = content.split('\n');
    const isHtml = ff.endsWith('.html');
    const isJs = ff.endsWith('.js');
    
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      
      // Check innerHTML in JS
      if (isJs && /\.innerHTML\s*=/.test(line)) {
        addFinding('frontend', 'CRITICAL', ff, lineNum, 'INNER_HTML_USED', 'innerHTML assignment detected (violates zero-innerHTML / CSP requirement)', line);
      }
      
      // Check eval / Function
      if (isJs && (/\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line))) {
        addFinding('frontend', 'CRITICAL', ff, lineNum, 'EVAL_USED', 'eval or new Function detected in frontend', line);
      }
      
      // Check inline scripts or event handlers in HTML
      if (isHtml) {
        if (/<script\b(?![^>]*src=)[^>]*>[\s\S]*?/.test(line) && !line.includes('type="application/json"')) {
          addFinding('frontend', 'CRITICAL', ff, lineNum, 'INLINE_SCRIPT', 'Inline <script> detected in HTML (violates Helmet CSP)', line);
        }
        if (/\son[a-z]+\s*=/i.test(line)) {
          addFinding('frontend', 'HIGH', ff, lineNum, 'INLINE_EVENT_HANDLER', 'Inline on* event handler detected in HTML (violates Helmet CSP)', line);
        }
      }
      
      // Check for forbidden word "কার্যদিবস"
      if (line.includes('কার্যদিবস')) {
        addFinding('frontend', 'HIGH', ff, lineNum, 'FORBIDDEN_BANGLA_WORD', 'Forbidden word "কার্যদিবস" found (must use calendar days "দিন")', line);
      }
      
      // Check for hardcoded localhost / IP
      if (/(http:\/\/localhost|http:\/\/127\.0\.0\.1|https:\/\/localhost)/.test(line)) {
        addFinding('frontend', 'MEDIUM', ff, lineNum, 'HARDCODED_URL', 'Hardcoded localhost/IP URL in frontend code', line);
      }
    });
  }
}

// Execute scans
auditServerAndMiddleware();
auditRoutes();
auditFrontend();

console.log(JSON.stringify(findings, null, 2));
