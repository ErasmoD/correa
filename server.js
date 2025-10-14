// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'public')));

// --- Utilidades de persistencia simple ---
function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      users: [
        { id: 1, username: 'admin', password: 'admin', role: 'admin', name: 'Administrador' },
        { id: 2, username: 'user1', password: 'pass1', role: 'employee', name: 'Operador 1' },
        { id: 3, username: 'user2', password: 'pass2', role: 'employee', name: 'Operador 2' }
      ],
      turns: [
        { id: 1, name: 'Turno Mañana', start: '06:00', end: '14:00', days: ['L','M','X','J','V'], area: 'Ruta A', assignedTo: 2, status: 'active' }
      ],
      requests: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- Autenticación simple (demo) ---
function makeToken(user) {
  const payload = { id: user.id, username: user.username, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 8 };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
function parseToken(token) {
  try {
    const json = Buffer.from(token, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch(e){ return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'Sin token' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Formato token inválido' });
  const token = parts[1];
  const payload = parseToken(token);
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
  req.user = payload;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// --- Rutas API ---
// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const data = readData();
  const user = data.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
  const token = makeToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
});

// Obtener perfil
app.get('/api/me', authMiddleware, (req, res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ id: user.id, username: user.username, role: user.role, name: user.name });
});

// Listar turnos
app.get('/api/turns', authMiddleware, (req, res) => {
  const data = readData();
  let turns = data.turns;
  if (req.query.assignedTo) {
    turns = turns.filter(t => String(t.assignedTo) === String(req.query.assignedTo));
  }
  res.json(turns);
});

// Crear turno (admin)
app.post('/api/turns', authMiddleware, adminOnly, (req, res) => {
  const data = readData();
  const t = req.body;
  const id = data.turns.length ? Math.max(...data.turns.map(x => x.id)) + 1 : 1;
  const newTurn = { id, ...t };
  data.turns.push(newTurn);
  writeData(data);
  res.json(newTurn);
});

// Editar turno (admin)
app.put('/api/turns/:id', authMiddleware, adminOnly, (req, res) => {
  const data = readData();
  const id = Number(req.params.id);
  const idx = data.turns.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Turno no encontrado' });
  data.turns[idx] = { ...data.turns[idx], ...req.body };
  writeData(data);
  res.json(data.turns[idx]);
});

// Eliminar turno (admin)
app.delete('/api/turns/:id', authMiddleware, adminOnly, (req, res) => {
  const data = readData();
  const id = Number(req.params.id);
  data.turns = data.turns.filter(t => t.id !== id);
  writeData(data);
  res.json({ ok: true });
});

// Confirmar asistencia (empleado)
app.post('/api/turns/:id/confirm', authMiddleware, (req, res) => {
  const data = readData();
  const id = Number(req.params.id);
  const t = data.turns.find(x => x.id === id && x.assignedTo === req.user.id);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado o no asignado a ti' });
  t.confirmed = true;
  writeData(data);
  res.json({ ok: true, turn: t });
});

// Solicitud de reasignación
app.post('/api/requests', authMiddleware, (req, res) => {
  const data = readData();
  const { turnId, reason, swapWith } = req.body;
  const id = data.requests.length ? Math.max(...data.requests.map(r => r.id)) + 1 : 1;
  const request = {
    id, turnId, requesterId: req.user.id, reason: reason || '', swapWith: swapWith || null,
    status: 'pending', createdAt: new Date().toISOString(), adminComment: null
  };
  data.requests.push(request);
  writeData(data);
  res.json(request);
});

// Listar solicitudes
app.get('/api/requests', authMiddleware, (req, res) => {
  const data = readData();
  if (req.user.role === 'admin') return res.json(data.requests);
  const mine = data.requests.filter(r => r.requesterId === req.user.id);
  res.json(mine);
});

// Decidir solicitudes (admin)
app.post('/api/requests/:id/decision', authMiddleware, adminOnly, (req, res) => {
  const data = readData();
  const id = Number(req.params.id);
  const { decision, comment } = req.body;
  const r = data.requests.find(x => x.id === id);
  if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'Decision inválida' });
  r.status = decision === 'approve' ? 'approved' : 'rejected';
  r.adminComment = comment || null;
  r.decidedAt = new Date().toISOString();

  if (r.status === 'approved') {
    const turn = data.turns.find(t => t.id === r.turnId);
    if (turn) {
      if (r.swapWith) turn.assignedTo = r.swapWith;
      else turn.assignedTo = null;
    }
  }
  writeData(data);
  res.json(r);
});

// Listar usuarios (admin)
app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  const data = readData();
  res.json(data.users.map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name })));
});

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Servidor ReAsignaTurnos ejecutándose en http://localhost:${PORT}`);
});
