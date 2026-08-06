const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATABASE SETUP =====
const DB_PATH = path.join(__dirname, 'data', 'leads.db');
let db = null;

function dbRun(sql, params = []) { db.run(sql, params); dbSave(); }
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}
function dbAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}
function dbSave() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDB() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','ops','sales')),
      phone TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      phone TEXT NOT NULL,
      source TEXT DEFAULT '抖音',
      product_interest TEXT DEFAULT '',
      grade TEXT DEFAULT 'B' CHECK(grade IN ('A','B','C')),
      assigned_to TEXT DEFAULT '',
      status TEXT DEFAULT '新线索' CHECK(status IN ('新线索','已联系','沟通中','报价中','已成交','已丢单')),
      created_by TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Migrate new columns if not exist
  try { db.run("ALTER TABLE leads ADD COLUMN pool_status TEXT DEFAULT 'private'"); } catch(e) {}
  try { db.run("ALTER TABLE leads ADD COLUMN pool_returned_at TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE leads ADD COLUMN locked INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE leads ADD COLUMN tags TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN daily_claim_limit INTEGER DEFAULT 10"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN is_locked INTEGER DEFAULT 0"); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reached_dm INTEGER DEFAULT 0,
      got_budget INTEGER DEFAULT 0,
      got_timeline INTEGER DEFAULT 0,
      found_pain INTEGER DEFAULT 0,
      found_competition INTEGER DEFAULT 0,
      next_action TEXT DEFAULT '',
      effective_score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      lead_id TEXT DEFAULT '',
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Create indexes
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to)');
    db.run('CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_leads_grade ON leads(grade)');
    db.run('CREATE INDEX IF NOT EXISTS idx_follow_ups_lead ON follow_ups(lead_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)');
  } catch(e) {}

  // New tables for v4.0 features
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sales_targets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      target_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, year, month)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quality_alerts (
      id TEXT PRIMARY KEY,
      followup_id TEXT DEFAULT '',
      lead_id TEXT DEFAULT '',
      risk_type TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('high','medium','low')),
      description TEXT NOT NULL,
      is_resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reminder_config (
      id TEXT PRIMARY KEY,
      rule_key TEXT UNIQUE NOT NULL,
      rule_name TEXT NOT NULL,
      rule_value TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Default reminder config
  const cfgCount = dbGet('SELECT COUNT(*) as cnt FROM reminder_config');
  if (cfgCount && cfgCount.cnt === 0) {
    const defaults = [
      ['new_lead_alert','新线索首次提醒','30','新线索分配后，多少分钟后未跟进则提醒（分钟）'],
      ['a_grade_remind','A级客户跟进间隔','4','A级高意向客户超过多少小时未跟进则提醒'],
      ['b_grade_remind','B级客户跟进间隔','24','B级中意向客户超过多少小时未跟进则提醒'],
      ['c_grade_remind','C级客户跟进间隔','72','C级低意向客户超过多少小时未跟进则提醒'],
      ['daily_lead_target','每日线索录入目标','10','业务员每天应该主动跟进/新增的线索数目标'],
      ['followup_remind_1','第1次跟进提醒','1','首次跟进后多少天自动提醒二次跟进'],
      ['followup_remind_2','第2次跟进提醒','3','第二次跟进后多少天自动提醒三次跟进'],
      ['quote_follow_remind','报价后跟进提醒','2','报报价后多少天自动提醒跟进'],
      ['reactivate_remind','沉睡客户激活','7','超过多少天未联系自动提醒激活'],
    ];
    const stmt = db.prepare('INSERT INTO reminder_config (id, rule_key, rule_name, rule_value, description) VALUES (?,?,?,?,?)');
    defaults.forEach(d => stmt.run(['RC' + Date.now().toString(36)+Math.random().toString(36).slice(2,5), ...d]));
    stmt.free();
  }

  dbSave();

  // Seed default users
  const adminCount = dbGet('SELECT COUNT(*) as cnt FROM users');
  if (adminCount && adminCount.cnt === 0) {
    const adminHash = crypto.createHash('sha256').update('admin123').digest('hex');
    const opsHash = crypto.createHash('sha256').update('ops123').digest('hex');
    const sales1Hash = crypto.createHash('sha256').update('123456').digest('hex');
    const sales2Hash = crypto.createHash('sha256').update('123456').digest('hex');

    dbRun("INSERT INTO users (id, username, password, display_name, role, phone) VALUES ('U001','admin',?,?,?,?)", [adminHash, '管理员', 'admin', '']);
    dbRun("INSERT INTO users (id, username, password, display_name, role, phone) VALUES ('U002','yunying',?,?,?,?)", [opsHash, '运营-小王', 'ops', '']);
    dbRun("INSERT INTO users (id, username, password, display_name, role, phone) VALUES ('U003','zhangwei',?,?,?,?)", [sales1Hash, '张伟', 'sales', '138****1111']);
    dbRun("INSERT INTO users (id, username, password, display_name, role, phone) VALUES ('U004','liming',?,?,?,?)", [sales2Hash, '李明', 'sales', '139****2222']);

    console.log('默认账号已创建');
  }

  // Seed knowledge base
  const kbCount = dbGet('SELECT COUNT(*) as cnt FROM knowledge_base');
  if (kbCount && kbCount.cnt === 0) {
    const kbs = [
      ['产品知识','商用电磁炉核心卖点','1. 热效率95%以上 vs 燃气40-50%\n2. 智能温控±1℃精确控温\n3. 不锈钢304材质，使用寿命10年+\n4. 无明火=更安全，降低后厨温度\n5. 适用场景：酒店宴会厨房、食堂大锅灶','电磁炉,大锅灶,节能'],
      ['产品知识','自动炒菜机介绍','1. 一键编程，标准化出品\n2. 节约50%以上厨师人力成本\n3. 高峰期出餐效率提升300%\n4. 适用场景：连锁中餐、企业食堂、中央厨房','炒菜机,自动化,降本增效'],
      ['产品知识','冷柜冰箱选型指南','1. 风冷vs直冷的区别和适用场景\n2. 能效等级选择建议\n3. 四门vs六门容量测算\n4. 压缩机品牌（恩布拉科vs丹佛斯）','冷柜,冰箱,冷链'],
      ['话术技巧','如何挖掘客户预算','1. 不要直接问"您的预算是多少"\n2. 引导式提问："之前大概看过什么价位的设备？"\n3. 区间法："市场价一般在5-8万，您觉得这个区间合适吗？"\n4. 项目导向："这个项目大概的投入规模是？"','谈判,预算,技巧'],
      ['话术技巧','异议处理3步法','1. 先认可："理解您的顾虑..."\n2. 再解释："很多客户刚开始也有这个疑问，后来发现..."\n3. 举案例："我们有个客户XX酒店，当时也是担心这一点..."\n4. 促行动："要不我先给您做个方案看看？"','异议处理,沟通,技巧'],
      ['行业知识','酒店后厨设备配置标准','一份完整的酒店后厨配置方案应包含：\n1. 热厨区：商用电磁灶/燃气灶+蒸柜\n2. 冷厨区：冷柜/操作台\n3. 洗涤区：洗碗机/消毒柜\n4. 排烟系统\n5. 不锈钢工作台/货架\n6. 出菜通道规划','酒店,配置方案,后厨'],
      ['合规知识','销售合规红线','以下行为严格禁止：\n1. 虚假承诺保修期限和服务响应\n2. 未经授权报价低于公司底价\n3. 诋毁同行竞品\n4. 承诺超出公司允许的折扣/返点\n5. 未经审批私自承诺交货日期\n6. 向客户透露其他客户成交价格','合规,红线,禁止'],
    ];
    const stmt = db.prepare('INSERT INTO knowledge_base (id, category, title, content, tags) VALUES (?,?,?,?,?)');
    kbs.forEach(kb => stmt.run(['KB' + Date.now().toString(36)+Math.random().toString(36).slice(2,5), ...kb]));
    stmt.free();
    console.log('知识库已初始化');
  }

  console.log('数据库初始化完成');
}

// ===== WEBSOCKET =====
const clients = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth' && data.userId) {
        if (!clients.has(data.userId)) clients.set(data.userId, new Set());
        clients.get(data.userId).add(ws);
        ws._userId = data.userId;
        const unread = dbGet('SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND is_read=0', [data.userId]);
        sendToUser(data.userId, { type: 'unread_count', count: unread ? unread.cnt : 0 });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (ws._userId && clients.has(ws._userId)) {
      clients.get(ws._userId).delete(ws);
      if (clients.get(ws._userId).size === 0) clients.delete(ws._userId);
    }
  });
});

function sendToUser(userId, data) {
  if (clients.has(userId)) {
    const msg = JSON.stringify(data);
    clients.get(userId).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }
}

function notifyUser(userId, leadId, type, message) {
  const id = 'N' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
  dbRun('INSERT INTO notifications (id, user_id, lead_id, type, message) VALUES (?,?,?,?,?)', [id, userId, leadId, type, message]);
  const unread = dbGet('SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND is_read=0', [userId]);
  sendToUser(userId, {
    type: 'new_lead_assigned',
    notification: { id, leadId, type, message },
    unreadCount: unread ? unread.cnt : 0
  });
}

// ===== AUTH =====
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: '未登录' });
  const user = dbGet('SELECT * FROM users WHERE id=?', [token]);
  if (!user) return res.status(401).json({ error: '登录已过期' });
  req.user = user;
  next();
}

// ===== API =====

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  const user = dbGet('SELECT * FROM users WHERE username=? AND password=?', [username, hash]);
  if (!user) return res.status(401).json({ error: '账号或密码错误' });
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser, token: user.id });
});

app.get('/api/me', auth, (req, res) => {
  const { password: _, ...safeUser } = req.user;
  res.json(safeUser);
});

// Leads
app.get('/api/leads', auth, (req, res) => {
  const { status, grade, assigned, search, overdue } = req.query;
  let sql = 'SELECT l.*, u.display_name as creator_name FROM leads l LEFT JOIN users u ON l.created_by=u.id WHERE 1=1';
  const params = [];

  if (req.user.role === 'sales') {
    sql += ' AND l.assigned_to=?';
    params.push(req.user.display_name);
  }
  if (status && status !== 'all') { sql += ' AND l.status=?'; params.push(status); }
  if (grade && grade !== 'all') { sql += ' AND l.grade=?'; params.push(grade); }
  if (assigned && assigned !== 'all') { sql += ' AND l.assigned_to=?'; params.push(assigned); }
  if (search) { sql += ' AND (l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ?)'; params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  if (overdue === '1') {
    sql += " AND l.status NOT IN ('已成交','已丢单') AND l.updated_at < datetime('now','localtime','-24 hours')";
  }
  sql += " ORDER BY CASE WHEN l.grade='A' THEN 1 WHEN l.grade='B' THEN 2 ELSE 3 END, l.updated_at DESC";
  const leads = dbAll(sql, params);

  // Role-based phone masking
  leads.forEach(l => {
    if (!canSeePhone(req.user, l)) {
      l.phone = maskPhone(l.phone);
      l._phone_masked = true;
    } else {
      l._phone_masked = false;
    }
  });

  res.json(leads);
});

app.get('/api/leads/:id', auth, (req, res) => {
  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });
  if (!canSeePhone(req.user, lead)) {
    lead.phone = maskPhone(lead.phone);
    lead._phone_masked = true;
  } else {
    lead._phone_masked = false;
  }
  const followUps = dbAll(
    'SELECT f.*, u.display_name as user_name FROM follow_ups f LEFT JOIN users u ON f.user_id=u.id WHERE f.lead_id=? ORDER BY f.created_at DESC',
    [req.params.id]
  );
  res.json({ lead, followUps });
});

function canSeePhone(user, lead) {
  if (user.role === 'admin') return true;
  if (user.role === 'ops') {
    return lead.created_by === user.id;
  }
  if (user.role === 'sales') {
    return lead.assigned_to === user.display_name;
  }
  return false;
}

function maskPhone(phone) {
  if (!phone || phone.length < 7) return '****';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

app.post('/api/leads', auth, (req, res) => {
  const { name, company, phone, source, product_interest, grade, assigned_to, notes } = req.body;
  if (!name || !company || !phone) return res.status(400).json({ error: '请填写客户姓名、公司和电话' });

  const id = 'L' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
  dbRun(
    'INSERT INTO leads (id, name, company, phone, source, product_interest, grade, assigned_to, status, created_by, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, name, company, phone, source || '抖音', product_interest || '', grade || 'B', assigned_to || '', '新线索', req.user.id, notes || '']
  );

  if (assigned_to) {
    const salesUser = dbGet("SELECT id FROM users WHERE display_name=? AND role='sales'", [assigned_to]);
    if (salesUser) {
      notifyUser(salesUser.id, id, 'new_lead',
        `🔔 新线索！${name} - ${company}，意向产品：${product_interest || '未指定'}，等级：${grade || 'B'}级，请立即跟进！`);
    }
  }
  res.json({ id, message: '线索创建成功' });
});

app.put('/api/leads/:id', auth, (req, res) => {
  const { name, company, phone, source, product_interest, grade, assigned_to, status, notes } = req.body;
  const old = dbGet('SELECT * FROM leads WHERE id=?', [req.params.id]);
  if (!old) return res.status(404).json({ error: '线索不存在' });

  dbRun(
    "UPDATE leads SET name=?, company=?, phone=?, source=?, product_interest=?, grade=?, assigned_to=?, status=?, notes=?, updated_at=datetime('now','localtime') WHERE id=?",
    [name, company, phone, source, product_interest, grade, assigned_to, status, notes, req.params.id]
  );

  if (assigned_to && assigned_to !== old.assigned_to) {
    const salesUser = dbGet("SELECT id FROM users WHERE display_name=? AND role='sales'", [assigned_to]);
    if (salesUser) {
      notifyUser(salesUser.id, req.params.id, 'reassigned', `📋 线索已转派给你：${name} - ${company}`);
    }
  }
  res.json({ message: '更新成功' });
});

app.delete('/api/leads/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可删除' });
  dbRun('DELETE FROM leads WHERE id=?', [req.params.id]);
  res.json({ message: '删除成功' });
});

// Follow-ups
app.post('/api/leads/:id/followup', auth, (req, res) => {
  const { content, reached_dm, got_budget, got_timeline, found_pain, found_competition, next_action, new_status } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '请填写跟进内容' });

  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });

  let score = 0;
  if (reached_dm) score++;
  if (got_budget) score++;
  if (got_timeline) score++;
  if (found_pain) score++;
  if (found_competition) score++;

  const fid = 'F' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
  dbRun(
    'INSERT INTO follow_ups (id, lead_id, user_id, content, reached_dm, got_budget, got_timeline, found_pain, found_competition, next_action, effective_score) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [fid, req.params.id, req.user.id, content.trim(), reached_dm?1:0, got_budget?1:0, got_timeline?1:0, found_pain?1:0, found_competition?1:0, next_action||'', score]
  );

  const newStatus = new_status || (lead.status === '新线索' ? '已联系' : lead.status);
  dbRun("UPDATE leads SET status=?, updated_at=datetime('now','localtime') WHERE id=?", [newStatus, req.params.id]);

  res.json({ id: fid, effective_score: score, message: '跟进记录已保存' });
});

// Stats
app.get('/api/stats', auth, (req, res) => {
  const filterAssigned = req.user.role === 'sales' ? 'AND assigned_to=?' : '';
  const params = req.user.role === 'sales' ? [req.user.display_name] : [];

  const total = dbGet(`SELECT COUNT(*) as cnt FROM leads WHERE 1=1 ${filterAssigned}`, params);
  const byStatus = dbAll(`SELECT status, COUNT(*) as cnt FROM leads WHERE 1=1 ${filterAssigned} GROUP BY status`, params);
  const byGrade = dbAll(`SELECT grade, COUNT(*) as cnt FROM leads WHERE 1=1 ${filterAssigned} GROUP BY grade`, params);
  const overdue = dbGet(`SELECT COUNT(*) as cnt FROM leads WHERE status NOT IN ('已成交','已丢单') AND updated_at < datetime('now','localtime','-24 hours') ${filterAssigned}`, params);

  const todayStart = new Date().toISOString().slice(0,10) + ' 00:00:00';
  const todayLeads = dbGet(`SELECT COUNT(*) as cnt FROM leads WHERE created_at >= ? ${filterAssigned}`, [todayStart, ...params]);

  res.json({ total: total.cnt, byStatus, byGrade, overdue: overdue.cnt, todayLeads: todayLeads.cnt });
});

// AI Analysis
app.get('/api/leads/:id/analyze', auth, (req, res) => {
  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.id]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });

  const followUps = dbAll(
    'SELECT f.*, u.display_name as user_name FROM follow_ups f LEFT JOIN users u ON f.user_id=u.id WHERE f.lead_id=? ORDER BY f.created_at ASC',
    [req.params.id]
  );

  // Build analysis
  const now = new Date();
  const created = new Date(lead.created_at);
  const updated = new Date(lead.updated_at);
  const daysSinceCreated = Math.floor((now - created) / 86400000);
  const hoursSinceUpdated = Math.floor((now - updated) / 3600000);
  const followCount = followUps.length;

  // Score trends
  let scores = followUps.map(f => f.effective_score);
  let avgScore = scores.length > 0 ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : 0;
  let scoreTrend = 'stable';
  if (scores.length >= 2) {
    const recent = scores.slice(-Math.min(3, scores.length));
    const older = scores.slice(0, Math.max(0, scores.length - recent.length));
    const recentAvg = recent.reduce((a,b) => a+b, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((a,b) => a+b, 0) / older.length : recentAvg;
    if (recentAvg > olderAvg + 1) scoreTrend = 'improving';
    else if (recentAvg < olderAvg - 1) scoreTrend = 'declining';
  }

  // Info gaps
  let hasReachedDM = false, hasGotBudget = false, hasGotTimeline = false, hasFoundPain = false, hasFoundCompetition = false;
  followUps.forEach(f => {
    if (f.reached_dm) hasReachedDM = true;
    if (f.got_budget) hasGotBudget = true;
    if (f.got_timeline) hasGotTimeline = true;
    if (f.found_pain) hasFoundPain = true;
    if (f.found_competition) hasFoundCompetition = true;
  });

  const gaps = [];
  if (!hasReachedDM) gaps.push({ field: '决策人', icon: '👤', desc: '尚未确认是否触达到最终决策人，建议下次跟进时确认对方采购权限' });
  if (!hasGotBudget) gaps.push({ field: '预算', icon: '💰', desc: '尚未了解客户预算范围，报价环节可能被动。建议在沟通中自然询问预算区间' });
  if (!hasGotTimeline) gaps.push({ field: '采购时间', icon: '📅', desc: '未明确客户采购时间节点，无法把握跟进节奏。建议了解项目紧急程度' });
  if (!hasFoundPain) gaps.push({ field: '痛点需求', icon: '🎯', desc: '未深入挖掘客户核心痛点，产品推荐缺乏针对性' });
  if (!hasFoundCompetition) gaps.push({ field: '竞品情报', icon: '🏢', desc: '不了解客户是否在看竞品，无法做差异化竞争策略' });

  // Urgency score (0-100)
  let urgency = 0;
  if (lead.grade === 'A') urgency += 40;
  else if (lead.grade === 'B') urgency += 25;
  else urgency += 10;
  if (hoursSinceUpdated > (lead.grade === 'A' ? 4 : lead.grade === 'B' ? 24 : 72)) urgency += 30;
  if (followCount >= 3) urgency += 15;
  if (avgScore >= 3) urgency += 15;
  urgency = Math.min(100, urgency);

  // Conversion probability estimate
  let convProb = 5;
  if (lead.grade === 'A') convProb += 30;
  else if (lead.grade === 'B') convProb += 15;
  if (hasReachedDM) convProb += 15;
  if (hasGotBudget) convProb += 10;
  if (hasGotTimeline) convProb += 10;
  if (hasFoundPain) convProb += 10;
  if (hasFoundCompetition) convProb += 5;
  if (scoreTrend === 'improving') convProb += 10;
  if (scoreTrend === 'declining') convProb -= 15;
  if (daysSinceCreated > 30 && lead.status === '新线索') convProb -= 20;
  if (lead.status === '报价中') convProb += 10;
  if (hoursSinceUpdated > 72) convProb -= 15;
  convProb = Math.max(0, Math.min(95, convProb));

  // Recommendations
  const recommendations = [];
  if (lead.status === '新线索' && hoursSinceUpdated > 24) {
    recommendations.push({ type: 'urgent', action: '⚡ 立即首次触达', detail: '该线索超过24小时未跟进，黄金窗口即将关闭。马上电话联系，介绍公司优势和产品线' });
  }
  if (gaps.length > 0) {
    const gapFields = gaps.map(g => g.field).join('、');
    recommendations.push({ type: 'info', action: '🔍 补充关键信息', detail: `下次沟通重点了解：${gapFields}。围绕这些核心要素展开对话，不要只停留在产品介绍层面` });
  }
  if (lead.grade === 'A' && !hasGotTimeline) {
    recommendations.push({ type: 'strategy', action: '🎯 锁定采购节奏', detail: 'A级客户必须明确其决策流程和采购时间表。可以提出上门勘测或方案演示，推动客户进入下一步' });
  }
  if (lead.grade === 'A' && lead.status !== '报价中' && lead.status !== '已成交') {
    recommendations.push({ type: 'strategy', action: '📊 尽快进入报价阶段', detail: `高意向客户已跟进${daysSinceCreated}天，建议整理针对性方案报价，创造紧迫感推动成交` });
  }
  if (scoreTrend === 'declining') {
    recommendations.push({ type: 'warning', action: '⚠️ 跟进质量下滑', detail: '最近几次跟进质量评分下降，可能业务员出现疲劳或客户热度降低。建议换一个角度切入，比如发送行业案例或成功故事' });
  }
  if (lead.status === '已丢单') {
    recommendations.push({ type: 'reactivate', action: '🔄 尝试激活', detail: '如果丢单时间不长（30天内），可以以"有新优惠政策/新产品"为由重新联系，或邀请参加产品体验活动' });
  }
  if (lead.status === '已成交') {
    recommendations.push({ type: 'maintain', action: '🤝 维护转介绍', detail: '已成交客户是宝贵资源。安排定期回访了解使用情况，争取转介绍新客户。提供老客户专属优惠方案' });
  }
  if (recommendations.length === 0) {
    recommendations.push({ type: 'info', action: '✅ 跟进节奏良好', detail: '当前跟进策略基本到位，继续保持稳定节奏，重点推进客户决策' });
  }

  // Conversation summary
  const totalWords = followUps.reduce((sum, f) => sum + (f.content ? f.content.length : 0), 0);

  // Timeline analysis
  let timelineAnalysis = '';
  if (followCount === 0) {
    timelineAnalysis = '尚无跟进记录，无法分析沟通模式。建议立即开始首次跟进。';
  } else if (followCount <= 2) {
    timelineAnalysis = '跟进次数较少，尚处于关系建立阶段。建议增加沟通频率，先建立信任再深入挖掘需求。';
  } else {
    // Check follow-up intervals
    let intervals = [];
    for (let i = 1; i < followUps.length; i++) {
      const prev = new Date(followUps[i-1].created_at);
      const curr = new Date(followUps[i].created_at);
      intervals.push(Math.floor((curr - prev) / 3600000));
    }
    const avgInterval = intervals.reduce((a,b) => a+b, 0) / intervals.length;
    if (avgInterval < 24) {
      timelineAnalysis = `跟进频率高（平均${Math.round(avgInterval)}小时间隔），节奏紧凑。注意不要给客户压迫感，每次沟通应有明确目的和新信息提供。`;
    } else if (avgInterval < 72) {
      timelineAnalysis = `跟进节奏适中（平均${Math.round(avgInterval)}小时间隔），频率合理。建议保持这个节奏，每次跟进尝试推进一个关键节点。`;
    } else {
      timelineAnalysis = `跟进间隔偏长（平均${Math.round(avgInterval)}小时间隔），客户可能觉得不被重视。建议缩短跟进间隔，尤其是${lead.grade}级客户。`;
    }
  }

  res.json({
    summary: {
      daysSinceCreated,
      hoursSinceUpdated,
      followCount,
      totalWords,
      avgScore: parseFloat(avgScore),
      scoreTrend,
      urgency,
      conversionProbability: convProb,
    },
    infoGaps: gaps,
    recommendations,
    timelineAnalysis,
    followUps: followUps.map(f => ({
      time: f.created_at,
      user: f.user_name,
      content: f.content,
      score: f.effective_score,
      nextAction: f.next_action,
    })),
    leadSummary: {
      name: lead.name,
      company: lead.company,
      grade: lead.grade,
      status: lead.status,
      productInterest: lead.product_interest,
      assignedTo: lead.assigned_to,
    }
  });
});

// Performance
app.get('/api/performance', auth, (req, res) => {
  if (req.user.role === 'sales') return res.status(403).json({ error: '无权访问' });

  const reps = dbAll("SELECT * FROM users WHERE role='sales'");
  const result = reps.map(r => {
    const leads = dbAll('SELECT * FROM leads WHERE assigned_to=?', [r.display_name]);
    const total = leads.length;
    const won = leads.filter(l => l.status === '已成交').length;
    const followed = leads.filter(l => {
      const c = dbGet('SELECT COUNT(*) as cnt FROM follow_ups WHERE lead_id=?', [l.id]);
      return (c && c.cnt > 0);
    }).length;
    const avgScore = dbGet(
      "SELECT ROUND(AVG(CAST(effective_score AS FLOAT)), 1) as avg FROM follow_ups WHERE lead_id IN (SELECT id FROM leads WHERE assigned_to=?) AND effective_score > 0",
      [r.display_name]
    );

    return {
      id: r.id, name: r.display_name, phone: r.phone,
      total, won, followed,
      followRate: total > 0 ? Math.round(followed / total * 100) : 0,
      convRate: total > 0 ? Math.round(won / total * 100) : 0,
      avgScore: (avgScore && avgScore.avg) || 0,
      monthlyWon: won,
    };
  });

  result.sort((a, b) => b.convRate - a.convRate || b.won - a.won);
  res.json(result);
});

// Notifications
app.get('/api/notifications', auth, (req, res) => {
  const list = dbAll('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const unread = list.filter(n => !n.is_read).length;
  res.json({ list, unread });
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
  dbRun('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ message: 'ok' });
});

app.put('/api/notifications/read-all', auth, (req, res) => {
  dbRun('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
  res.json({ message: 'ok' });
});

// Users (admin)
app.post('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { username, password, display_name, role, phone } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: '请填写完整信息' });

  const exist = dbGet('SELECT id FROM users WHERE username=?', [username]);
  if (exist) return res.status(400).json({ error: '账号已存在' });

  const id = 'U' + Date.now().toString(36).toUpperCase();
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  dbRun('INSERT INTO users (id, username, password, display_name, role, phone) VALUES (?,?,?,?,?,?)', [id, username, hash, display_name, role||'sales', phone||'']);
  res.json({ id, message: '创建成功' });
});

app.put('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { username, display_name, role, phone, password } = req.body;

  const old = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!old) return res.status(404).json({ error: '用户不存在' });

  const newUsername = username || old.username;
  const newDisplayName = display_name || old.display_name;
  const newRole = role || old.role;
  const newPhone = phone !== undefined ? phone : old.phone;

  if (password) {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    dbRun('UPDATE users SET username=?, display_name=?, role=?, phone=?, password=? WHERE id=?', [newUsername, newDisplayName, newRole, newPhone, hash, req.params.id]);
  } else {
    dbRun('UPDATE users SET username=?, display_name=?, role=?, phone=? WHERE id=?', [newUsername, newDisplayName, newRole, newPhone, req.params.id]);
  }

  if (display_name && display_name !== old.display_name) {
    dbRun('UPDATE leads SET assigned_to=? WHERE assigned_to=?', [display_name, old.display_name]);
  }
  res.json({ message: '更新成功' });
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const user = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  dbRun("UPDATE leads SET assigned_to='未分配' WHERE assigned_to=?", [user.display_name]);
  dbRun('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ message: '已删除' });
});

app.get('/api/users', auth, (req, res) => {
  const users = dbAll('SELECT id, username, display_name, role, phone, created_at FROM users ORDER BY role, display_name');
  res.json(users);
});

// ===== AI 智能分析 =====
app.get('/api/analyze/:leadId', auth, (req, res) => {
  try {
  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });

  const followUps = dbAll(
    "SELECT f.*, u.display_name as user_name FROM follow_ups f LEFT JOIN users u ON f.user_id=u.id WHERE f.lead_id=? ORDER BY f.created_at ASC",
    [req.params.leadId]
  );

  // Build analysis
  const daysSinceCreation = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000);
  const totalFollowUps = followUps.length;
  const avgScore = followUps.length > 0
    ? (followUps.reduce((sum, f) => sum + (f.effective_score || 0), 0) / followUps.length).toFixed(1)
    : 0;

  // Check what signals are missing
  const hasReachedDM = followUps.some(f => f.reached_dm);
  const hasBudget = followUps.some(f => f.got_budget);
  const hasTimeline = followUps.some(f => f.got_timeline);
  const hasPain = followUps.some(f => f.found_pain);
  const hasCompetition = followUps.some(f => f.found_competition);

  const missingSignals = [];
  if (!hasReachedDM) missingSignals.push('未触达到决策人');
  if (!hasBudget) missingSignals.push('不了解客户预算');
  if (!hasTimeline) missingSignals.push('不清楚采购时间节点');
  if (!hasPain) missingSignals.push('未挖掘客户核心痛点');
  if (!hasCompetition) missingSignals.push('不了解竞品情况');

  // Grade-based urgency
  let urgencyLevel, urgencyText, urgencyColor;
  if (lead.grade === 'A') {
    if (daysSinceCreation > 1 && totalFollowUps < 2) {
      urgencyLevel = '极高'; urgencyText = '该客户为A级高意向客户，但跟进频率严重不足！A级客户流失率通常呈指数增长，每延迟1小时转化概率下降约5-8%。'; urgencyColor = '#dc2626';
    } else if (totalFollowUps >= 2) {
      urgencyLevel = '高'; urgencyText = 'A级客户跟进节奏尚可，但需要在关键决策点（预算确认/时间节点/决策人承诺）上有明确推进。'; urgencyColor = '#d97706';
    } else {
      urgencyLevel = '需加快'; urgencyText = '新录入A级客户，黄金4小时内必须完成首次有效触达，抢占先机。'; urgencyColor = '#d97706';
    }
  } else if (lead.grade === 'B') {
    if (totalFollowUps === 0) {
      urgencyLevel = '中'; urgencyText = 'B级客户虽不急迫但仍有明确需求，24小时内未跟进可能被竞品截胡。'; urgencyColor = '#d97706';
    } else if (totalFollowUps >= 1 && !hasTimeline) {
      urgencyLevel = '中'; urgencyText = '已建立联系，但缺少关键信息（采购时间/预算），需要在下次沟通中重点突破这两个维度。'; urgencyColor = '#d97706';
    } else {
      urgencyLevel = '低'; urgencyText = '跟进节奏正常，保持定期沟通，等待客户采购窗口。'; urgencyColor = '#10b981';
    }
  } else {
    urgencyLevel = '维护'; urgencyText = 'C级客户当下需求不明确，建议定期（每月1-2次）发送行业资讯/案例保持存在感，等待需求产生时自然转化。'; urgencyColor = '#3b82f6';
  }

  // Next actions based on status
  let nextActions = [];
  if (lead.status === '新线索') {
    nextActions = [
      '立即电话联系，确认客户身份和采购意向',
      '添加客户微信，发送公司和产品介绍资料',
      '预约现场勘测或视频会议演示',
      '24小时内完成首次跟进记录',
    ];
  } else if (lead.status === '已联系' || lead.status === '沟通中') {
    nextActions = ['确定客户决策人身份和联系方式'];
    if (!hasBudget) nextActions.push('通过提问引导客户透露预算范围（如："您这个项目大概的投入预算区间是？"）');
    if (!hasTimeline) nextActions.push('明确客户采购时间节点（如："设备大概什么时候需要到位？"）');
    if (!hasPain) nextActions.push('深挖客户痛点（如："目前后厨设备遇到的最大问题是？出品效率还是能耗？"）');
    if (!hasCompetition) nextActions.push('了解竞品情况（如："您之前有没有看过其他品牌？觉得怎么样？"）');
    nextActions.push('���送针对性产品方案和报价');
  } else if (lead.status === '报价中') {
    if (totalFollowUps >= 2) {
      nextActions = [
        '确认客户是否已收到报价方案',
        '询问客户对价格/配置的反馈意见',
        hasCompetition ? '针对竞品优劣势做差异化对比' : '了解客户还在对比哪些品牌',
        '设定明确的下一步推进时间点（不要"有空再聊"）',
        '制造合理紧迫感（产能排期/促销活动/涨价预告）',
      ];
    } else {
      nextActions = ['加速推进，报价后72小时是黄金逼单��口'];
    }
  } else {
    nextActions = ['回顾整体跟进过程，分析成功/失败关键因素', '记录经验教训，优化后续跟进策略'];
  }

  // Sales strategy recommendations (industry-specific)
  const strategies = [];
  if (lead.product_interest) {
    const products = lead.product_interest;
    if (products.includes('电磁炉') || products.includes('炒菜机')) {
      strategies.push('强调热效率95%以上 vs 燃气灶仅40-50%，长期省30-50%能源成本，用ROI数据说话');
    }
    if (products.includes('炒菜机')) {
      strategies.push('自动炒菜机核心卖点：降低厨师人力成本、出品标准化、高峰期效率提升300%。邀请客户现场观看演示。');
    }
    if (products.includes('冷柜') || products.includes('冰箱')) {
      strategies.push('冷链设备重点：能效等级、温控精确度、售后响应速度。提供能耗对比表和3年TCO测算。');
    }
    if (products.includes('消毒柜') || products.includes('工作台')) {
      strategies.push('强调不锈钢304材质、符合食药监标准、模块化定制能力。附赠卫生达标检查清单增加专业感。');
    }
  }
  if (lead.source === '抖音' || lead.source === '快手') {
    strategies.push('短视频线索特点是"冲动型意向"，决策快但也容易凉。速度是第一竞争力，用视频通话或实地考察快速建立信任。');
  }
  if (lead.source === '老客户介绍') {
    strategies.push('老客户介绍线索转化率通常是冷线索的5-10倍。请老客户帮忙在中间说句话，甚至安排三方通话。');
  }

  res.json({
    lead: { name: lead.name, company: lead.company, grade: lead.grade, status: lead.status, product: lead.product_interest, source: lead.source },
    overview: {
      daysSinceCreation,
      totalFollowUps,
      avgScore: parseFloat(avgScore),
      followUpGap: totalFollowUps === 0 ? '尚无任何跟进记录' : `最近跟进距今${Math.floor((Date.now() - new Date(lead.updated_at).getTime())/3600000)}小时`,
    },
    urgency: { level: urgencyLevel, text: urgencyText, color: urgencyColor },
    signalScan: {
      checked: { reachedDM: hasReachedDM, budget: hasBudget, timeline: hasTimeline, pain: hasPain, competition: hasCompetition },
      missing: missingSignals,
      completeness: Math.round(([hasReachedDM, hasBudget, hasTimeline, hasPain, hasCompetition].filter(Boolean).length / 5) * 100),
    },
    nextActions,
    strategies,
    followUpHistory: followUps.map(f => ({
      time: f.created_at,
      user: f.user_name,
      content: f.content,
      score: f.effective_score,
      signals: [f.reached_dm && '决策人', f.got_budget && '预算', f.got_timeline && '时间', f.found_pain && '痛点', f.found_competition && '竞品'].filter(Boolean),
    })),
  });
  } catch(e) {
    console.error('AI analysis error:', e.stack || e);
    res.status(500).json({ error: '分析失败: ' + (e.message || String(e)) });
  }
});

// ===== 2. 公海池 (Public Pool) =====
app.get('/api/pool', auth, (req, res) => {
  let sql = "SELECT * FROM leads WHERE pool_status='public' ORDER BY pool_returned_at DESC";
  let leads = dbAll(sql);
  leads.forEach(l => { if (!canSeePhone(req.user, l)) { l.phone = maskPhone(l.phone); l._phone_masked = true; } else { l._phone_masked = false; } });
  res.json(leads);
});

app.post('/api/leads/:id/release', auth, (req, res) => {
  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });
  if (lead.assigned_to !== req.user.display_name && req.user.role !== 'admin') {
    return res.status(403).json({ error: '只能释放自己的线索' });
  }
  dbRun("UPDATE leads SET pool_status='public', pool_returned_at=datetime('now','localtime'), assigned_to='' WHERE id=?", [req.params.leadId]);
  // Notify all sales
  const salesUsers = dbAll("SELECT id FROM users WHERE role='sales' AND is_locked=0");
  salesUsers.forEach(u => {
    notifyUser(u.id, req.params.leadId, 'pool_release', `🌊 客户【${lead.name} - ${lead.company}】已释放到公海池，可以领取跟进！`);
  });
  res.json({ message: '已释放到公海' });
});

app.post('/api/leads/:id/claim', auth, (req, res) => {
  if (req.user.role !== 'sales') return res.status(403).json({ error: '仅业务员可领取' });
  if (req.user.is_locked === 1) return res.status(403).json({ error: '账号已锁定，无法领取' });

  const lead = dbGet('SELECT * FROM leads WHERE id=?', [req.params.leadId]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });
  if (lead.pool_status !== 'public') return res.status(400).json({ error: '该线索不在公海池' });

  // Check daily claim limit
  const todayClaims = dbGet(
    "SELECT COUNT(*) as cnt FROM leads WHERE assigned_to=? AND pool_returned_at >= date('now','localtime') AND pool_status='private'",
    [req.user.display_name]
  );
  const limit = req.user.daily_claim_limit || 10;
  if (todayClaims.cnt >= limit) return res.status(400).json({ error: `今日已领取${todayClaims.cnt}条，达到每日上限${limit}条` });

  dbRun(
    "UPDATE leads SET pool_status='private', assigned_to=?, status=COALESCE(NULLIF(status,''),'已联系'), updated_at=datetime('now','localtime') WHERE id=?",
    [req.user.display_name, req.params.leadId]
  );

  res.json({ message: '领取成功，请尽快联系客户！' });
});

// ===== 3. 重复客户筛查 =====
app.get('/api/duplicates', auth, (req, res) => {
  if (req.user.role === 'sales') return res.status(403).json({ error: '无权访问' });

  // Find leads with same phone (different leads)
  const byPhone = dbAll(`
    SELECT phone, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM leads
    WHERE phone != ''
    GROUP BY phone
    HAVING cnt > 1
  `);

  // Find leads with same company
  const byCompany = dbAll(`
    SELECT company, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
    FROM leads
    WHERE company != ''
    GROUP BY company
    HAVING cnt > 1
  `);

  // Get lead details
  const phoneResults = byPhone.map(p => {
    const ids = p.ids.split(',');
    const leads = dbAll("SELECT id, name, company, phone, assigned_to, status, created_at FROM leads WHERE id IN (" + ids.map(()=>'?').join(',') + ")", ids);
    return { type: 'phone', value: p.phone, count: p.cnt, leads };
  });

  const companyResults = byCompany.map(c => {
    const ids = c.ids.split(',');
    const leads = dbAll("SELECT id, name, company, phone, assigned_to, status, created_at FROM leads WHERE id IN (" + ids.map(()=>'?').join(',') + ")", ids);
    return { type: 'company', value: c.company, count: c.cnt, leads };
  });

  res.json({
    byPhone: phoneResults,
    byCompany: companyResults,
    totalDuplicateLeads: phoneResults.reduce((s, p) => s + p.leads.length, 0) + companyResults.reduce((s, c) => s + c.leads.length, 0)
  });
});

// ===== 4. 详细客户统计 =====
app.get('/api/stats/detailed', auth, (req, res) => {
  const allLeads = dbAll('SELECT * FROM leads');
  const allFollowUps = dbAll('SELECT * FROM follow_ups');
  const allUsers = dbAll("SELECT * FROM users");

  // Per employee stats
  const perEmployee = allUsers.filter(u => u.role === 'sales').map(u => {
    const myLeads = allLeads.filter(l => l.assigned_to === u.display_name);
    const byGrade = { A: 0, B: 0, C: 0 };
    const byStatus = {};
    const bySource = {};
    let totalPhones = 0;

    myLeads.forEach(l => {
      byGrade[l.grade] = (byGrade[l.grade] || 0) + 1;
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      bySource[l.source] = (bySource[l.source] || 0) + 1;
      if (l.phone && l.phone.length >= 7) totalPhones++;
    });

    const won = myLeads.filter(l => l.status === '已成交').length;
    const lost = myLeads.filter(l => l.status === '已丢单').length;
    const overdue = myLeads.filter(l => l.status !== '已成交' && l.status !== '已丢单' && new Date(l.updated_at) < new Date(Date.now() - 24*3600000)).length;

    return {
      id: u.id, name: u.display_name, phone: u.phone, isLocked: u.is_locked === 1,
      total: myLeads.length, won, lost, overdue,
      byGrade, byStatus, bySource,
      totalPhones,
      convRate: myLeads.length > 0 ? Math.round(won / myLeads.length * 100) : 0,
    };
  });

  // Global stats
  const globalStats = {
    totalLeads: allLeads.length,
    totalFollowUps: allFollowUps.length,
    avgFollowUps: allLeads.length > 0 ? (allFollowUps.length / allLeads.length).toFixed(1) : 0,
    byGrade: { A: allLeads.filter(l => l.grade === 'A').length, B: allLeads.filter(l => l.grade === 'B').length, C: allLeads.filter(l => l.grade === 'C').length },
    byStatus: {},
    bySource: {},
  };
  allLeads.forEach(l => {
    globalStats.byStatus[l.status] = (globalStats.byStatus[l.status] || 0) + 1;
    globalStats.bySource[l.source] = (globalStats.bySource[l.source] || 0) + 1;
  });

  res.json({ globalStats, perEmployee });
});

// ===== 5. 客户继承 (员工离职/换号) =====
app.post('/api/users/:id/lock', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const user = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  dbRun('UPDATE users SET is_locked=? WHERE id=?', [req.body.locked ? 1 : 0, req.params.id]);
  res.json({ message: req.body.locked ? '账号已锁定' : '账号已解锁' });
});

app.post('/api/leads/transfer', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { fromUser, toUser, leadIds } = req.body;
  if (!fromUser || !toUser) return res.status(400).json({ error: '请选择转出来源和目标' });

  let ids = leadIds;
  if (!ids || ids.length === 0) {
    // Transfer all leads from fromUser
    const allLeads = dbAll('SELECT id FROM leads WHERE assigned_to=?', [fromUser]);
    ids = allLeads.map(l => l.id);
  }
  if (ids.length === 0) return res.json({ message: '没有需要转移的线索', transferred: 0 });

  const placeholders = ids.map(() => '?').join(',');
  dbRun(`UPDATE leads SET assigned_to=?, updated_at=datetime('now','localtime') WHERE id IN (${placeholders})`, [toUser, ...ids]);

  // Notify new owner
  const newOwner = dbGet("SELECT id FROM users WHERE display_name=?", [toUser]);
  if (newOwner) {
    notifyUser(newOwner.id, '', 'transfer', `🔄 您接收到${ids.length}条客户（从${fromUser}转来），请尽快梳理状态`);
  }

  res.json({ message: `成功转移${ids.length}条线索到${toUser}`, transferred: ids.length });
});

// ===== 6. AI 销冠话术生成 =====
app.post('/api/ai/generate-script', auth, (req, res) => {
  try {
    const { leadId, scenario } = req.body;
    const lead = dbGet('SELECT * FROM leads WHERE id=?', [leadId]);
    if (!lead) return res.status(404).json({ error: '线索不存在' });

    // Find best follow-ups (high score, won deals) for similar leads
    const bestFollowUps = dbAll(`
      SELECT f.*, u.display_name as user_name
      FROM follow_ups f
      LEFT JOIN leads l ON f.lead_id = l.id
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.effective_score >= 4 AND l.status = '已成交'
      ORDER BY f.effective_score DESC, f.created_at DESC
      LIMIT 10
    `);

    // Industry-specific winning patterns
    const industryPatterns = {
      '酒店': { emphasis: '卫生达标、出品稳定、能源成本、服务响应速度', hook: '我们已服务XX酒店集团3年以上' },
      '餐饮': { emphasis: '出品标准化、出餐效率、人工成本', hook: '我们的客户XX餐饮日均出餐量提升了200%' },
      '食堂': { emphasis: '食品安全、能耗、耐用性、政府合规', hook: '我们的客户包括XX中学、XX医院等事业单位' },
      '火锅': { emphasis: '桌面电磁炉稳定、清洁卫生、节省空间', hook: '海底捞、呷哺呷哺都在用我们的产品' },
    };

    // Detect industry
    let industry = '餐饮';
    const company = lead.company || '';
    if (company.includes('酒店') || company.includes('宾馆') || company.includes('度假')) industry = '酒店';
    else if (company.includes('食堂') || company.includes('学校') || company.includes('医院')) industry = '食堂';
    else if (company.includes('火锅') || company.includes('麻辣')) industry = '火锅';

    const pattern = industryPatterns[industry];
    const product = lead.product_interest || '商用设备';

    const scripts = {
      '首次触达': `📞 ${lead.name}总，您好！我是[业务员姓名]，通过[来源]了解到您${industry}对${product}有兴趣。\n\n我们专注${industry}后厨设备${10}年，目前${pattern.hook}。\n\n方便请教您3个问题吗：\n1. 您采购主要是为了开店/升级/扩充？\n2. 大概什么时间需要到位？\n3. 预算范围方便说吗？\n\n我可以根据您的实际情况给您出一份针对性的方案。`,

      '需求挖掘': `${lead.name}总，理解了您的情况。${industry}的${product}配置，核心要看的3点：\n\n① ${pattern.emphasis} —— 您目前最关心哪个？\n② 预算 + 采购时间节点 —— 决定我们给您什么档次方案\n③ 现有设备/竞品 —— 您现在用什么品牌？觉得哪里不满意？\n\n您透露这3点，我可以马上帮您做个对比方案，比您一家一家找效率高得多。`,

      '异议处理': `${lead.name}总，理解您${req.body.concern || '对价格的考虑'}。\n\n${industry}设备是用5年以上的长期投资，便宜设备2年就出问题，停工维修的成本反而更高。我们的设备平均使用寿命${10}年以上，质保3年终身维护。\n\n算笔账：${product}贵${5}千/台，但每年省电费/维修费${3}千，3年回本。之后净赚。\n\n要不我先给您出个免费方案？不买没关系，您有个参考。`,

      '逼单成交': `${lead.name}总，方案您也看过了。刚好这个月我们厂家有个补贴活动：\n\n✅ 老客户介绍新客户 → 双方各延保1年\n✅ 本月签单 → 享厂家9折优惠\n✅ 大宗采购(超10万) → 免费勘测+安装\n\n活动这周五截止，您看是这周还是下周来签？要不要我先把意向协议发您把优惠锁定？`,
    };

    const scenarios = Object.keys(scripts);
    const selectedScenario = scenario || '首次触达';
    const generatedScript = scripts[selectedScenario] || scripts['首次触达'];

    res.json({
      scenario: selectedScenario,
      script: generatedScript,
      availableScenarios: scenarios,
      industry,
      bestPractices: bestFollowUps.slice(0, 3).map(f => ({
        user: f.user_name,
        score: f.effective_score,
        excerpt: f.content.substring(0, 100) + (f.content.length > 100 ? '...' : '')
      })),
      tips: [
        `💡 该客户为${lead.grade}级${lead.grade==='A'?'(需加快跟进节奏)':''}`,
        `💡 ${pattern.hook}，可用于破冰`,
        `💡 通过5维度信号（决策人/预算/时间/痛点/竞品）评估沟通质量`,
      ]
    });
  } catch(e) {
    res.status(500).json({ error: '生成失败: ' + (e.message || String(e)) });
  }
});

// ===== 1. AI质检 =====
app.get('/api/quality-check', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可访问' });
  const results = { alerts: [], stats: { total: 0, high: 0, medium: 0, low: 0 } };

  // Scan recent follow-ups (last 7 days)
  const recentFollowUps = dbAll(`
    SELECT f.*, l.name as lead_name, l.company, u.display_name as user_name
    FROM follow_ups f
    LEFT JOIN leads l ON f.lead_id = l.id
    LEFT JOIN users u ON f.user_id = u.id
    WHERE f.created_at >= datetime('now','localtime','-7 days')
    ORDER BY f.created_at DESC
  `);

  recentFollowUps.forEach(f => {
    const risks = [];
    const content = (f.content || '').toLowerCase();

    // Check: Too brief (less than 10 chars)
    if (f.content.length < 15) {
      risks.push({ type: '跟进疏漏', level: 'high', desc: '跟进内容过短(<15字)，可能未进行有效沟通。客户：' + f.lead_name + '，业务员：' + f.user_name });
    }

    // Check: No decision maker reached
    if (!f.reached_dm && f.effective_score > 0) {
      risks.push({ type: '跟进疏漏', level: 'medium', desc: '未触达到决策人，后续跟进建议优先确认决策人身份。客户：' + f.lead_name });
    }

    // Check: No budget info
    if (!f.got_budget && f.effective_score >= 2) {
      risks.push({ type: '信息缺失', level: 'low', desc: '多次跟进仍未了解客户预算，建议下次沟通重点突破。客户：' + f.lead_name });
    }

    // Check: Risky language
    const riskyWords = ['保证', '绝对', '最便宜', '最低价', '返点', '回扣', '其他客户', '底价', '内部价'];
    riskyWords.forEach(w => {
      if (content.includes(w)) {
        risks.push({ type: '违规话术', level: 'high', desc: `跟进内容包含风险词"${w}"，可能涉及过度承诺或信息泄露。客户：${f.lead_name}，业务员：${f.user_name}` });
      }
    });

    // Check: No next action
    if (!f.next_action && f.effective_score >= 3) {
      risks.push({ type: '跟进疏漏', level: 'medium', desc: '高质量跟进但未记录下一步计划，建议补充。客户：' + f.lead_name });
    }

    risks.forEach(r => {
      const aid = 'QA' + Date.now().toString(36)+Math.random().toString(36).slice(2,5);
      const existing = dbGet("SELECT COUNT(*) as cnt FROM quality_alerts WHERE followup_id=? AND risk_type=?", [f.id, r.type]);
      if (!existing || existing.cnt === 0) {
        dbRun('INSERT INTO quality_alerts (id, followup_id, lead_id, risk_type, risk_level, description) VALUES (?,?,?,?,?,?)',
          [aid, f.id, f.lead_id, r.type, r.level, r.desc]);
      }
    });
  });

  const alerts = dbAll('SELECT * FROM quality_alerts WHERE is_resolved=0 ORDER BY risk_level DESC, created_at DESC LIMIT 50');
  results.alerts = alerts;
  results.stats.total = alerts.length;
  results.stats.high = alerts.filter(a => a.risk_level === 'high').length;
  results.stats.medium = alerts.filter(a => a.risk_level === 'medium').length;
  results.stats.low = alerts.filter(a => a.risk_level === 'low').length;

  res.json(results);
});

app.put('/api/quality-check/:id/resolve', auth, (req, res) => {
  dbRun('UPDATE quality_alerts SET is_resolved=1 WHERE id=?', [req.params.id]);
  res.json({ message: '已处理' });
});

// ===== 2. 知识库 + 微信智能回复 =====
app.get('/api/knowledge', auth, (req, res) => {
  const kb = dbAll('SELECT * FROM knowledge_base ORDER BY category, title');
  res.json(kb);
});

app.post('/api/knowledge', auth, (req, res) => {
  const { category, title, content, tags } = req.body;
  const id = 'KB' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  dbRun('INSERT INTO knowledge_base (id, category, title, content, tags) VALUES (?,?,?,?,?)',
    [id, category, title, content, tags || '']);
  res.json({ id, message: '知识条目已添加' });
});

app.delete('/api/knowledge/:id', auth, (req, res) => {
  dbRun('DELETE FROM knowledge_base WHERE id=?', [req.params.id]);
  res.json({ message: '已删除' });
});

app.post('/api/ai/smart-reply', auth, (req, res) => {
  const { leadId, customerMessage, chatHistory } = req.body;
  try {
    const lead = dbGet('SELECT * FROM leads WHERE id=?', [leadId]);
    if (!lead) return res.status(404).json({ error: '线索不存在' });

    // Detect customer identity from chat
    const allText = (chatHistory || customerMessage || lead.notes || '') + '|' + (lead.name || '') + '|' + (lead.company || '');
    let identity = { surname: '', gender: '', role: '', honorific: '' };

    // Extract surname from lead name
    if (lead.name) identity.surname = lead.name.charAt(0);

    // Detect keywords
    const text = allText.toLowerCase();
    if (text.includes('老婆') || text.includes('老板娘') || text.includes('夫人')) { identity.role = '老板娘'; identity.gender = 'female'; }
    else if (text.includes('老板')) { identity.role = '老板'; identity.gender = 'male'; }
    else if (text.includes('经理') || text.includes('采购') || text.includes('主管')) { identity.role = '经理/采购'; }
    else if (lead.company?.includes('酒店') || lead.company?.includes('宾馆')) { identity.role = '酒店负责人'; }

    if (identity.gender === 'female' || text.includes('女士') || text.includes('小姐') || text.includes('姐')) identity.gender = 'female';
    else if (identity.gender !== 'female') identity.gender = 'male';

    if (identity.gender === 'male') identity.honorific = identity.surname ? `${identity.surname}总` : '先生';
    else identity.honorific = identity.surname ? `${identity.surname}姐` : '女士';

    // Generate smart reply
    const replies = [];

    // Get knowledge for context
    const product = lead.product_interest || '';
    let relevantKB = [];
    if (product.includes('电磁炉') || product.includes('炒菜机') || product.includes('冷柜') || product.includes('消毒柜') || product.includes('工作台')) {
      relevantKB = dbAll("SELECT * FROM knowledge_base WHERE tags LIKE '%' || ? || '%' LIMIT 2", [product.slice(0,4)]);
    }
    if (relevantKB.length === 0) relevantKB = dbAll('SELECT * FROM knowledge_base LIMIT 2');

    // Generate reply based on lead status and context
    if (lead.status === '新线索' || lead.status === '已联系') {
      replies.push({
        type: '初次沟通/破冰',
        content: `${identity.honorific}您好！我是商厨设备的小[姓]，之前看到您在[平台]上了解过我们的${product || '商用设备'}。\n\n[公司名]刚好下个月有厂家补贴活动，${lead.grade==='A'?'名额不多':''}想跟您约个时间简单聊聊您的需求，方便给您出个免费的配置方案参考。您看明天上午还是下午方便？`
      });
    }
    if (lead.status === '沟通中' || lead.status === '报价中') {
      const kbRef = relevantKB.length > 0 ? `\n\n另外关于${product}，我们还有个细节想跟您当面聊一下——[参考知识库：${relevantKB[0].title}]` : '';
      replies.push({
        type: '推进转化',
        content: `${identity.honorific}，上次跟您聊的方案我这边做了优化。\n\n基于您的需求，我建议[配置方案]，理由是：\n1. [卖点1]\n2. [卖点2]\n3. [卖点3]${kbRef}\n\n您看这周五方便过来看看样机吗？或者我带着方案去您那边也行。`
      });
    }
    replies.push({
      type: '日常维护/关怀',
      content: `${identity.honorific}，最近天气热多注意身体！[产品相关提醒或行业动态]\n\n有需要随时找我，不用客气。周末愉快！`
    });

    // Follow-up prompt if overdue
    const lastUpdate = new Date(lead.updated_at);
    const hoursSince = Math.floor((Date.now() - lastUpdate) / 3600000);
    if (hoursSince > 24 && lead.status !== '已成交' && lead.status !== '已丢单') {
      replies.push({
        type: '超时跟进提醒',
        content: `${identity.honorific}，抱歉打扰一下！上次跟您聊到${product || '后厨设备'}的事，不知道您这边考虑得怎么样了？有什么需要我再解释的地方随时说，别客气。`
      });
    }

    res.json({ identity, replies, relevantKB });
  } catch(e) {
    res.status(500).json({ error: '生成失败: ' + (e.message || String(e)) });
  }
});

// ===== 3. 过程绩效 =====
app.get('/api/performance/process', auth, (req, res) => {
  if (req.user.role === 'sales') {
    const stats = calcProcessStats(req.user.display_name);
    return res.json({ employees: [stats] });
  }

  const reps = dbAll("SELECT * FROM users WHERE role='sales'");
  const employees = reps.map(r => calcProcessStats(r.display_name));
  res.json({ employees });
});

function calcProcessStats(displayName) {
  const leads = dbAll('SELECT * FROM leads WHERE assigned_to=?', [displayName]);
  const followUps = dbAll(`
    SELECT f.* FROM follow_ups f
    JOIN leads l ON f.lead_id = l.id
    WHERE l.assigned_to=?
  `, [displayName]);

  const activeLeads = leads.filter(l => l.status !== '已成交' && l.status !== '已丢单');
  const wonLeads = leads.filter(l => l.status === '已成交');
  const sevenDaysAgo = new Date(Date.now() - 7*86400000).toISOString().replace('T',' ').slice(0,19);

  const recentFollowUps = followUps.filter(f => f.created_at >= sevenDaysAgo);
  const recentCalledLeads = new Set(recentFollowUps.map(f => f.lead_id)).size;

  return {
    name: displayName,
    totalLeads: leads.length,
    activeLeads: activeLeads.length,
    wonLeads: wonLeads.length,
    followUps7d: recentFollowUps.length,
    calledLeads7d: recentCalledLeads,
    totalFollowUps: followUps.length,
    avgFollowLength: followUps.length > 0 ? Math.round(followUps.reduce((s,f)=>s+(f.content||'').length,0)/followUps.length) : 0,
    avgScore: followUps.length > 0 ? (followUps.reduce((s,f)=>s+(f.effective_score||0),0)/followUps.length).toFixed(1) : '0',
    activeChats: recentFollowUps.filter(f=>f.content.length>=20).length,
    effectiveChats: recentFollowUps.filter(f=>f.effective_score>=3).length,
    passiveReplies: recentFollowUps.filter(f=>f.content.length<20).length,
    followRate: leads.length > 0 ? Math.round(activeLeads.filter(l=>followUps.some(f=>f.lead_id===l.id)).length/leads.length*100) : 0,
    conversionRate: leads.length > 0 ? Math.round(wonLeads.length/leads.length*100) : 0,
  };
}

// ===== 4. 结果绩效（销售目标） =====
app.get('/api/performance/results', auth, (req, res) => {
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || (now.getMonth() + 1);

  let targets = [];
  if (req.user.role === 'sales') {
    targets = dbAll('SELECT * FROM sales_targets WHERE user_id=? AND year=? AND month=?', [req.user.id, year, month]);
  } else {
    targets = dbAll('SELECT * FROM sales_targets WHERE year=? AND month=?', [year, month]);
  }

  const reps = req.user.role === 'sales'
    ? [req.user]
    : dbAll("SELECT * FROM users WHERE role='sales'");

  const results = reps.map(r => {
    const target = targets.find(t => t.user_id === r.id);
    const leads = dbAll('SELECT * FROM leads WHERE assigned_to=?', [r.display_name]);
    const wonLeads = leads.filter(l => l.status === '已成交');
    const monthWon = wonLeads.filter(l => {
      const d = new Date(l.updated_at);
      return d.getFullYear() == year && (d.getMonth()+1) == month;
    });
    const targetAmount = target ? target.target_amount : 0;

    return {
      id: r.id,
      name: r.display_name,
      target: targetAmount,
      achieved: monthWon.length,
      progress: targetAmount > 0 ? Math.round(monthWon.length / targetAmount * 100) : 0,
      totalLeads: leads.length,
      totalWon: wonLeads.length,
    };
  });

  res.json({ year, month, results });
});

app.post('/api/targets', auth, (req, res) => {
  if (req.user.role === 'sales') return res.status(403).json({ error: '无权设置目标' });
  const { userId, year, month, target } = req.body;
  const id = 'TG' + Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  try {
    dbRun('INSERT OR REPLACE INTO sales_targets (id, user_id, year, month, target_amount) VALUES (?,?,?,?,?)',
      [id, userId, year, month, target]);
  } catch(e) {
    dbRun('UPDATE sales_targets SET target_amount=? WHERE user_id=? AND year=? AND month=?',
      [target, userId, year, month]);
  }
  res.json({ message: '目标已设置' });
});

// ===== 5. AI 自动打标签 =====
app.post('/api/ai/auto-tag', auth, (req, res) => {
  const { leadId } = req.body;
  const lead = dbGet('SELECT * FROM leads WHERE id=?', [leadId]);
  if (!lead) return res.status(404).json({ error: '线索不存在' });

  const followUps = dbAll('SELECT * FROM follow_ups WHERE lead_id=? ORDER BY created_at ASC', [leadId]);
  const allText = (lead.notes||'') + ' ' + followUps.map(f=>f.content).join(' ');

  const tags = [];

  // Intent level from follow-up quality
  const avgScore = followUps.length > 0 ? followUps.reduce((s,f)=>s+(f.effective_score||0),0)/followUps.length : 0;
  if (avgScore >= 4) tags.push({ tag: '高意向', confidence: 90, color: '#ef4444' });
  else if (avgScore >= 2) tags.push({ tag: '中意向', confidence: 75, color: '#f59e0b' });
  else if (followUps.length === 0) tags.push({ tag: '待首次跟进', confidence: 85, color: '#3b82f6' });
  else tags.push({ tag: '低意向', confidence: 60, color: '#94a3b8' });

  // Decision role
  if (allText.includes('老板') || allText.includes('总')) tags.push({ tag: '决策人-老板', confidence: 70, color: '#8b5cf6' });
  else if (allText.includes('经理') || allText.includes('采购')) tags.push({ tag: '决策人-经理/采购', confidence: 65, color: '#8b5cf6' });
  else if (allText.includes('厨师')) tags.push({ tag: '决策人-厨师长', confidence: 60, color: '#8b5cf6' });

  // Industry
  const company = lead.company || '';
  if (company.includes('酒店')) tags.push({ tag: '酒店行业', confidence: 80, color: '#06b6d4' });
  else if (company.includes('食堂') || company.includes('学校') || company.includes('医院')) tags.push({ tag: '团餐行业', confidence: 80, color: '#06b6d4' });
  else if (company.includes('火锅') || company.includes('餐厅') || company.includes('餐饮')) tags.push({ tag: '社会餐饮', confidence: 75, color: '#06b6d4' });

  // Urgency
  const hoursSinceCreation = Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 3600000);
  if (lead.grade === 'A' && hoursSinceCreation < 24) tags.push({ tag: '急需跟进', confidence: 85, color: '#dc2626' });
  if (lead.grade === 'A' && hoursSinceCreation > 48 && followUps.length <= 1) tags.push({ tag: '有流失风险', confidence: 80, color: '#dc2626' });

  // Budget signal
  if (followUps.some(f => f.got_budget)) tags.push({ tag: '已确认预算', confidence: 95, color: '#10b981' });

  // Save tags to lead
  const tagStr = tags.map(t => t.tag).join(',');
  dbRun('UPDATE leads SET tags=? WHERE id=?', [tagStr, leadId]);

  res.json({ leadId, tags, totalTags: tags.length, message: `已自动分析并标注 ${tags.length} 个标签` });
});

// ===== AI 自动优化提醒规则 =====
app.post('/api/ai/optimize-reminders', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  try {
    const leads = dbAll("SELECT * FROM leads WHERE status IN ('已成交','已丢单')");
    const followUps = dbAll('SELECT f.*, l.grade, l.status as lead_status FROM follow_ups f JOIN leads l ON f.lead_id=l.id WHERE l.status IN ("已成交","已丢单")');
    const config = [];
    const values = {};

    // Analyze optimal A-grade follow-up interval
    const wonLeads = leads.filter(l => l.status === '已成交');
    wonLeads.forEach(l => {
      const myFU = followUps.filter(f => f.lead_id === l.id).sort((a,b) => new Date(a.created_at)-new Date(b.created_at));
      if (myFU.length >= 2) {
        const gaps = [];
        for (let i = 1; i < myFU.length; i++) {
          gaps.push(Math.round((new Date(myFU[i].created_at) - new Date(myFU[i-1].created_at)) / 3600000));
        }
        const avgGap = gaps.reduce((s,g) => s+g, 0) / gaps.length;
        if (!values[l.grade]) values[l.grade] = [];
        values[l.grade].push(avgGap);
      }
    });

    // Also analyze follow-ups with high effective scores
    const highScoreFU = followUps.filter(f => f.effective_score >= 4);
    const todayVolume = dbGet("SELECT COUNT(*) as cnt FROM leads WHERE created_at >= date('now','localtime')");

    const suggestions = [
      {
        key: 'a_grade_remind',
        current: dbGet("SELECT rule_value FROM reminder_config WHERE rule_key='a_grade_remind'").rule_value,
        suggested: values.A && values.A.length > 0 ? Math.max(1, Math.round(values.A.reduce((s,v)=>s+v,0)/values.A.length)) : 4,
        reason: values.A && values.A.length > 0 ? `基于${values.A.length}条A级成交数据分析，最佳跟进间隔为${Math.round(values.A.reduce((s,v)=>s+v,0)/values.A.length)}h` : '数据分析样本不足，保持当前值',
      },
      {
        key: 'b_grade_remind',
        current: dbGet("SELECT rule_value FROM reminder_config WHERE rule_key='b_grade_remind'").rule_value,
        suggested: values.B && values.B.length > 0 ? Math.max(4, Math.round(values.B.reduce((s,v)=>s+v,0)/values.B.length)) : 24,
        reason: values.B && values.B.length > 0 ? `基于${values.B.length}条B级成交数据分析` : '数据分析样本不足',
      },
      {
        key: 'daily_lead_target',
        current: dbGet("SELECT rule_value FROM reminder_config WHERE rule_key='daily_lead_target'").rule_value,
        suggested: Math.max(5, Math.round((todayVolume?.cnt||0) / 5)),
        reason: `当前团队${dbAll("SELECT COUNT(*) as cnt FROM users WHERE role='sales'").length||5}名业务员，建议每人每日${Math.max(5,Math.round((todayVolume?.cnt||0)/5))}条跟进目标`,
      },
    ];

    suggestions.forEach(s => {
      config.push({ rule_key: s.key, current: parseInt(s.current), suggested: s.suggested, reason: s.reason });
    });

    res.json({ suggestions: config, applyUrl: '/api/reminder-config' });
  } catch(e) {
    res.status(500).json({ error: '分析失败: '+(e.message||String(e)) });
  }
});

// ===== 运营监控看板 =====
app.get('/api/ops-monitor', auth, (req, res) => {
  if (!['admin','ops'].includes(req.user.role)) return res.status(403).json({ error: '无权访问' });

  const today = new Date().toISOString().slice(0,10);
  const salesUsers = dbAll("SELECT * FROM users WHERE role='sales' ORDER BY display_name");

  const result = salesUsers.map(u => {
    const leads = dbAll('SELECT * FROM leads WHERE assigned_to=?', [u.display_name]);
    const todayFU = dbGet("SELECT COUNT(*) as cnt FROM follow_ups WHERE lead_id IN (SELECT id FROM leads WHERE assigned_to=?) AND created_at >= ?", [u.display_name, today]);
    const todayInput = dbGet('SELECT COUNT(*) as cnt FROM leads WHERE assigned_to=? AND created_at >= ?', [u.display_name, today]);
    const lastFUTime = dbGet("SELECT MAX(created_at) as last_time FROM follow_ups WHERE lead_id IN (SELECT id FROM leads WHERE assigned_to=?)", [u.display_name]);

    const active = leads.filter(l => l.status !== '已成交' && l.status !== '已丢单');
    const won = leads.filter(l => l.status === '已成交');
    const overdue = active.filter(l => {
      const updated = new Date(l.updated_at);
      const hrs = (Date.now() - updated) / 3600000;
      return (l.grade === 'A' && hrs > 4) || (l.grade === 'B' && hrs > 24) || (l.grade === 'C' && hrs > 72);
    });

    return {
      id: u.id, name: u.display_name, isLocked: u.is_locked === 1,
      totalLeads: leads.length, activeLeads: active.length, wonLeads: won.length,
      todayFU: todayFU?.cnt || 0, todayInput: todayInput?.cnt || 0,
      overdue: overdue.length,
      lastActivity: lastFUTime?.last_time ? formatDt(lastFUTime.last_time) : '无记录',
      status: u.is_locked ? 'locked' : (overdue.length > 3 ? 'danger' : overdue.length > 0 ? 'warning' : 'good'),
      stageStats: {
        newLeads: leads.filter(l => l.status === '新线索').length,
        contacted: leads.filter(l => l.status === '已联系').length,
        communicating: leads.filter(l => l.status === '沟通中').length,
        quoting: leads.filter(l => l.status === '报价中').length,
        won: won.length,
        lost: leads.filter(l => l.status === '已丢单').length,
      },
    };
  });

  res.json({
    summary: {
      totalSales: salesUsers.length,
      totalLeads: result.reduce((s,r) => s + r.totalLeads, 0),
      totalWon: result.reduce((s,r) => s + r.wonLeads, 0),
      totalOverdue: result.reduce((s,r) => s + r.overdue, 0),
      totalTodayActivity: result.reduce((s,r) => s + r.todayFU + r.todayInput, 0),
    },
    sales: result
  });
});

function formatDt(dt) {
  const diff = Math.floor((Date.now() - new Date(dt).getTime()) / 3600000);
  if (diff < 1) return '刚刚';
  if (diff < 24) return diff + '小时前';
  return Math.floor(diff/24) + '天前';
}

// ===== REMINDER CONFIG =====
app.get('/api/reminder-config', auth, (req, res) => {
  const config = dbAll('SELECT * FROM reminder_config ORDER BY rule_key');
  res.json(config);
});

app.put('/api/reminder-config/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  dbRun('UPDATE reminder_config SET rule_value=? WHERE id=?', [req.body.value, req.params.id]);
  res.json({ message: '已更新' });
});

// ===== SMART REMINDERS (今日待办) =====
app.get('/api/reminders/today', auth, (req, res) => {
  const config = {};
  dbAll('SELECT * FROM reminder_config').forEach(c => { config[c.rule_key] = parseInt(c.rule_value) || parseInt(c.rule_value); });

  const today = new Date().toISOString().slice(0,10);
  const userFilter = req.user.role === 'sales' ? `AND l.assigned_to='${req.user.display_name}'` : '';
  const userId = req.user.id;
  const displayName = req.user.display_name;

  const items = [];

  // 1. New leads not contacted within threshold
  const newLeadTimeout = config.new_lead_alert || 30;
  const newLeads = dbAll(`
    SELECT l.* FROM leads l
    WHERE l.status='新线索' AND NOT EXISTS (SELECT 1 FROM follow_ups f2 WHERE f2.lead_id=l.id)
    AND datetime(l.created_at) < datetime('now','localtime','-' || ? || ' minutes')
    ${req.user.role==='sales' ? "AND l.assigned_to='"+displayName+"'" : ''}
    ORDER BY l.grade='A' DESC, l.created_at ASC
    LIMIT 20
  `, [newLeadTimeout]);

  newLeads.forEach(l => {
    const minutes = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 60000);
    items.push({
      type: 'new_lead', priority: l.grade === 'A' ? 'urgent' : l.grade === 'B' ? 'high' : 'normal',
      title: `🆕 新线索未跟进`,
      leadId: l.id, leadName: l.name, leadCompany: l.company, grade: l.grade,
      desc: `已分配${minutes}分钟未联系，${l.grade==='A'?'错过黄金窗口！':''}请立即联系`,
      action: '跟进', score: l.grade==='A'?100:l.grade==='B'?70:40
    });
  });

  // 2. Overdue follow-ups by grade
  const gradeThresholds = { A: config.a_grade_remind || 4, B: config.b_grade_remind || 24, C: config.c_grade_remind || 72 };
  Object.entries(gradeThresholds).forEach(([grade, hours]) => {
    const leads = dbAll(`
      SELECT l.*, f.effective_score as last_score FROM leads l
      LEFT JOIN (SELECT lead_id, effective_score FROM follow_ups ORDER BY created_at DESC LIMIT 1) f ON f.lead_id = l.id
      WHERE l.grade=? AND l.status NOT IN ('已成交','已丢单')
      AND datetime(l.updated_at) < datetime('now','localtime','-' || ? || ' hours')
      ${req.user.role==='sales' ? "AND l.assigned_to='"+displayName+"'" : 'AND l.assigned_to!=""'}
      ORDER BY l.updated_at ASC
      LIMIT 30
    `, [grade, hours]);

    leads.forEach(l => {
      const hoursSince = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 3600000);
      items.push({
        type: 'overdue', priority: grade === 'A' ? 'urgent' : grade === 'B' ? 'high' : 'normal',
        title: `⏰ ${grade}级客户超时未跟进`,
        leadId: l.id, leadName: l.name, leadCompany: l.company, grade, status: l.status,
        desc: `已${hoursSince}小时未联系${l.status==='报价中'?'，报价可能已凉':l.status==='沟通中'?'，客户可能已找竞品':''}`,
        action: '立即跟进', score: grade==='A'?95:grade==='B'?65:35
      });
    });
  });

  // 3. Quoted leads need follow-up
  const quotedSQL = req.user.role === 'sales'
    ? " AND l.assigned_to=? "
    : " AND l.assigned_to != '' ";
  const quotedParams = req.user.role === 'sales' ? [config.quote_follow_remind||2, displayName] : [config.quote_follow_remind||2];
  const quotedLeads = dbAll(`
    SELECT l.* FROM leads l
    WHERE l.status='报价中'
    AND datetime(l.updated_at) < datetime('now','localtime','-' || ? || ' days')
    ${quotedSQL}
    ORDER BY l.grade='A' DESC, l.updated_at ASC
    LIMIT 20
  `, quotedParams);

  quotedLeads.forEach(l => {
    const days = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 86400000);
    items.push({
      type: 'quote', priority: l.grade === 'A' ? 'urgent' : 'high',
      title: `💰 报价待跟进`,
      leadId: l.id, leadName: l.name, leadCompany: l.company, grade: l.grade,
      desc: `已报价${days}天未跟进，建议立即联系了解反馈`,
      action: '跟进报价', score: 85
    });
  });

  // 4. Dormant clients reactivation
  const dormantLeads = dbAll(`
    SELECT l.* FROM leads l
    WHERE l.status IN ('已联系','沟通中') AND l.status NOT IN ('已成交','已丢单')
    AND datetime(l.updated_at) < datetime('now','localtime','-' || ? || ' days')
    ${req.user.role==='sales' ? "AND l.assigned_to='"+displayName+"'" : "AND l.assigned_to!=''"}
    ORDER BY l.grade='A' DESC, l.updated_at ASC
    LIMIT 20
  `, [(config.reactivate_remind || 7)]);

  dormantLeads.forEach(l => {
    const days = Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 86400000);
    items.push({
      type: 'dormant', priority: 'normal',
      title: `💤 沉睡客户`,
      leadId: l.id, leadName: l.name, leadCompany: l.company, grade: l.grade,
      desc: `已${days}天未联系，建议发送行业资讯或优惠活动激活`,
      action: '激活', score: 30
    });
  });

  // 5. Daily activity reminder
  let todayFollowUps = { cnt: 0 };
  let todayLeadsInput = { cnt: 0 };
  const target = config.daily_lead_target || 10;

  if (req.user.role === 'sales') {
    todayFollowUps = dbGet('SELECT COUNT(*) as cnt FROM follow_ups WHERE user_id=? AND created_at >= ?', [userId, today]) || { cnt: 0 };
    todayLeadsInput = dbGet('SELECT COUNT(*) as cnt FROM leads WHERE assigned_to=? AND created_at >= ?', [displayName, today]) || { cnt: 0 };

    const todayTotal = (todayFollowUps.cnt || 0) + (todayLeadsInput.cnt || 0);

    if (todayTotal < target) {
      items.push({
        type: 'daily_quota', priority: todayTotal === 0 ? 'urgent' : 'high',
        title: `📊 今日工作量不足`,
        leadId: '', leadName: '', leadCompany: '', grade: '',
        desc: `今日跟进${todayTotal}条，距每日目标${target}条还差${target-todayTotal}条，加油！`,
        action: '去跟进', score: todayTotal===0?90:60
      });
    }
  }

  // Sort by priority score descending
  items.sort((a, b) => b.score - a.score);

  res.json({
    total: items.length,
    urgent: items.filter(i => i.priority === 'urgent').length,
    high: items.filter(i => i.priority === 'high').length,
    todayCount: todayFollowUps ? (todayFollowUps.cnt || 0) : 0,
    todayInput: todayLeadsInput ? (todayLeadsInput.cnt || 0) : 0,
    target: config.daily_lead_target || 10,
    items: items.slice(0, 30)
  });
});

// Force reminder check now
app.post('/api/reminders/check-now', auth, (req, res) => {
  checkReminders();
  res.json({ message: '已触发提醒检查' });
});

// ===== AUTO REMINDER =====
function checkReminders() {
  const config = {};
  dbAll('SELECT * FROM reminder_config').forEach(c => { config[c.rule_key] = parseInt(c.rule_value) || parseInt(c.rule_value); });

  const gradeThresholds = { A: config.a_grade_remind || 4, B: config.b_grade_remind || 24, C: config.c_grade_remind || 72 };
  const newLeadTimeout = config.new_lead_alert || 30;

  // New leads not contacted
  const newLeads = dbAll(`
    SELECT l.*, u.id as uid FROM leads l
    JOIN users u ON l.assigned_to = u.display_name
    WHERE l.status='新线索' AND NOT EXISTS (SELECT 1 FROM follow_ups f2 WHERE f2.lead_id=l.id)
    AND datetime(l.created_at) < datetime('now','localtime','-' || ? || ' minutes')
    AND l.assigned_to != ''
  `, [newLeadTimeout]);

  newLeads.forEach(lead => {
    const recent = dbGet("SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND lead_id=? AND type='new_lead_reminder' AND created_at > datetime('now','localtime','-30 minutes')", [lead.uid, lead.id]);
    if (!recent || recent.cnt === 0) {
      notifyUser(lead.uid, lead.id, 'new_lead_reminder',
        `🔔 新线索待联系！【${lead.name} - ${lead.company}】${lead.grade}级客户，已${Math.floor((Date.now()-new Date(lead.created_at))/60000)}分钟未触达，速联系！`);
    }
  });

  // Grade-based overdue
  Object.entries(gradeThresholds).forEach(([grade, hours]) => {
    const leads = dbAll(`
      SELECT l.*, u.id as uid FROM leads l
      JOIN users u ON l.assigned_to = u.display_name
      WHERE l.grade=? AND l.status NOT IN ('已成交','已丢单')
      AND datetime(l.updated_at) < datetime('now','localtime','-' || ? || ' hours')
      AND l.assigned_to != ''
    `, [grade, hours]);

    leads.forEach(lead => {
      const recent = dbGet("SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND lead_id=? AND type='reminder' AND created_at > datetime('now','localtime','-2 hours')", [lead.uid, lead.id]);
      if (!recent || recent.cnt === 0) {
        const gradeLabel = grade === 'A' ? '🔥 A级(高意向)' : grade === 'B' ? '🟡 B级(中意向)' : '🔵 C级(低意向)';
        const statusHint = lead.status === '报价中' ? '报价已发，速跟进反馈！' : lead.status === '沟通中' ? '沟通中断可能有流失风险' : '';
        notifyUser(lead.uid, lead.id, 'reminder',
          `⏰ ${gradeLabel}客户【${lead.name} - ${lead.company}】${Math.floor((Date.now()-new Date(lead.updated_at))/3600000)}小时未跟进${statusHint}`);
      }
    });
  });

  // Quoted leads reminder
  const quotedDays = config.quote_follow_remind || 2;
  const quotedLeads = dbAll(`
    SELECT l.*, u.id as uid FROM leads l
    JOIN users u ON l.assigned_to = u.display_name
    WHERE l.status='报价中'
    AND datetime(l.updated_at) < datetime('now','localtime','-' || ? || ' days')
    AND l.assigned_to != ''
  `, [quotedDays]);

  quotedLeads.forEach(lead => {
    const recent = dbGet("SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND lead_id=? AND type='quote_reminder' AND created_at > datetime('now','localtime','-4 hours')", [lead.uid, lead.id]);
    if (!recent || recent.cnt === 0) {
      notifyUser(lead.uid, lead.id, 'quote_reminder',
        `💰 报价跟进提醒：【${lead.name} - ${lead.company}】已报价${Math.floor((Date.now()-new Date(lead.updated_at))/86400000)}天未跟进，建议立即联系了解客户反馈！`);
    }
  });

  // Daily activity check for ALL sales
  const salesUsers = dbAll("SELECT * FROM users WHERE role='sales' AND is_locked=0");
  const today = new Date().toISOString().slice(0,10);
  const target = config.daily_lead_target || 10;

  salesUsers.forEach(u => {
    const todayCount = dbGet('SELECT COUNT(*) as cnt FROM follow_ups WHERE user_id=? AND created_at >= ?', [u.id, today]);
    const todayInput = dbGet('SELECT COUNT(*) as cnt FROM leads WHERE assigned_to=? AND created_at >= ?', [u.display_name, today]);
    const total = (todayCount?.cnt || 0) + (todayInput?.cnt || 0);

    if (total < target && new Date().getHours() >= 15) { // After 3pm
      const recent = dbGet("SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND type='daily_quota' AND created_at > datetime('now','localtime','-3 hours')", [u.id]);
      if (!recent || recent.cnt === 0) {
        notifyUser(u.id, '', 'daily_quota',
          `📊 今日工作量提醒：已完成${total}条，距目标${target}条还差${target-total}条。${total===0?'今天还没有开始跟进，动起来！🥊':''}`);
      }
    }
  });

  // Auto-release
  const overdueToRelease = dbAll(`
    SELECT * FROM leads
    WHERE pool_status='private' AND status NOT IN ('已成交','已丢单')
    AND (
      (grade='A' AND updated_at < datetime('now','localtime','-12 hours')) OR
      (grade='B' AND updated_at < datetime('now','localtime','-72 hours')) OR
      (grade='C' AND updated_at < datetime('now','localtime','-168 hours'))
    )
    AND assigned_to != ''
  `);

  overdueToRelease.forEach(lead => {
    dbRun("UPDATE leads SET pool_status='public', pool_returned_at=datetime('now','localtime'), assigned_to='' WHERE id=?", [lead.id]);
    salesUsers.forEach(u => {
      notifyUser(u.id, lead.id, 'pool_release',
        `🌊 【${lead.name} - ${lead.company}】超时自动进入公海，可领取！`);
    });
  });
}

// ===== START =====
const PORT = process.env.PORT || 3456;

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 线索管理系统已启动: http://localhost:${PORT}`);

    // Start reminder checker
    setInterval(checkReminders, 5 * 60 * 1000);
    setTimeout(checkReminders, 10000);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
