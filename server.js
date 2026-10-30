// Dependency-free WebSocket game server. Run with: npm start
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const MISSION_SECONDS = Math.max(1, Number(process.env.MISSION_SECONDS || 180));
const FILE = path.join(__dirname, 'index.html');
const rooms = new Map();
const clients = new Map();
const roles = ['ENGINEER', 'HACKER', 'SCIENTIST', 'NAVIGATOR', 'COMMANDER'];
const puzzles = [
  { title: 'Restore the generator', story: 'The campus generator is offline. Follow the power trace through the circuit.', clues: ['ENGINEER: The circuit increases by two amps at each junction.', 'HACKER: Every value on the amber trace is even.', 'SCIENTIST: Continue the sequence 2, 4, 6 by adding two.', 'NAVIGATOR: The missing fuse is the next number after 6 in this trace.', 'COMMANDER: The trace has four junctions; the last one is still dark.'], answer: '8', options: ['6', '8', '10', '12'], objective: 'Connect the final fuse and restart the generator.' },
  { title: 'Decode the security system', story: 'Security lockdown is blocking the campus relay. Compare your team’s clues.', clues: ['ENGINEER: The first digit is the sum of 2 and 3.', 'HACKER: The second digit is one less than the first.', 'SCIENTIST: The last digit is the sum of the first two.', 'NAVIGATOR: Enter the digits in the order: first, second, last.', 'COMMANDER: The code has three different digits and is below 600.'], answer: '549', options: ['459', '549', '594', '945'], objective: 'Enter the three digit access code.' },
  { title: 'Emergency power restoration', story: 'Three labeled switches must be activated in the order shown by the relay plan.', clues: ['ENGINEER: The steady-feed switch is labeled 2.', 'HACKER: The surge switch is labeled 4.', 'SCIENTIST: The reserve switch is labeled 1.', 'NAVIGATOR: Activate steady feed, then surge, then reserve.', 'COMMANDER: Enter switch labels as one three-digit sequence.'], answer: '241', options: ['124', '214', '241', '421'], objective: 'Activate the switches in the correct order.' }
];

function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function safeName(s) { return String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18); }
function frame(data, opcode = 1) {
  const body = Buffer.from(data); let head;
  if (body.length < 126) { head = Buffer.from([0x80 | opcode, body.length]); }
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}
function send(ws, obj) { if (!ws.destroyed) ws.write(frame(JSON.stringify(obj))); }
function publicRoom(r) {
  return { code: r.code, host: r.host, players: [...r.players.values()].map(p => ({ id:p.id, name:p.name, role:p.role, connected:p.connected })), phase:r.phase, level:r.level, remaining:r.remaining, score:r.score, solved:r.solved, startedAt:r.startedAt, endAt:r.endAt, lastResult:r.lastResult };
}
function broadcast(r) { const state = publicRoom(r); const activePlayers=[...r.players.values()]; for (const [index,p] of activePlayers.entries()) if (p.ws) { const base=r.phase==='playing'?puzzles[r.level]:null; const clue=base?roles.map((role,i)=>({role,text:base.clues[i]})).filter((_,i)=>i%activePlayers.length===index).map(x=>x.text).join(' · '):null; send(p.ws, { type:'state', state, puzzle:base?{...base,clue}:null }); } }
function roomError(ws, message) { send(ws, { type:'error', message }); }
function attach(ws, buffer = Buffer.alloc(0)) {
  ws.buffer = buffer;
  ws.on('data', chunk => {
    ws.buffer = Buffer.concat([ws.buffer, chunk]);
    while (ws.buffer.length >= 2) {
      const b = ws.buffer; const opcode = b[0] & 15; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; const big = b.readBigUInt64BE(2); if (big > 1_000_000n) return ws.destroy(); len = Number(big); off = 10; }
      const masked = Boolean(b[1] & 128); if (masked) off += 4;
      if (len > 1_000_000) return ws.destroy();
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len); if (masked) { const key = b.subarray(off - 4, off); payload = Buffer.from(payload); for (let i=0;i<len;i++) payload[i] ^= key[i%4]; }
      ws.buffer = b.subarray(off + len);
      if (opcode === 8) { ws.end(frame('', 8)); return; }
      if (opcode === 9) { ws.write(frame(payload, 10)); continue; }
      if (opcode !== 1) continue;
      try { handle(ws, JSON.parse(payload.toString())); } catch { roomError(ws, 'That action could not be processed.'); }
    }
  });
  ws.on('close', () => disconnect(ws)); ws.on('error', () => disconnect(ws));
}
function handle(ws, m) {
  const current = clients.get(ws);
  if (m.type === 'create' || m.type === 'join' || m.type === 'reconnect') {
    const name = safeName(m.name); if (name.length < 2) return roomError(ws, 'Choose a nickname with at least 2 characters.');
    let r, p;
    if (m.type === 'create') { let c; do { c = code(); } while (rooms.has(c)); r = { code:c, host:null, players:new Map(), phase:'lobby', level:0, remaining:MISSION_SECONDS, score:0, solved:[], timer:null, endAt:null, startedAt:null, lastResult:null, actionAt:new Map() }; rooms.set(c,r); }
    else { r = rooms.get(String(m.code || '').toUpperCase()); if (!r) return roomError(ws, 'Room code not found. Check it and try again.'); }
    if (m.type === 'reconnect') { p = r.players.get(String(m.id)); if (!p || p.name !== name) return roomError(ws, 'Your reconnect session has expired. Join the room again.'); clearTimeout(p.disconnectTimeout); p.disconnectTimeout=null; if (p.ws) { clients.delete(p.ws); p.ws.end(frame('',8)); } }
    else {
      if (r.phase !== 'lobby') return roomError(ws, 'This mission has already started.');
      if (r.players.size >= 5) return roomError(ws, 'This room is full (5/5 players).');
      if ([...r.players.values()].some(x => x.name.toLowerCase() === name.toLowerCase())) return roomError(ws, 'That nickname is already in this room.');
      p = { id:crypto.randomUUID(), name, role:roles.find(role => ![...r.players.values()].some(x => x.role === role)), ws, connected:true };
      r.players.set(p.id,p); if (!r.host) r.host = p.id;
    }
    p.ws=ws; p.connected=true; clients.set(ws,{r,p}); send(ws,{type:'welcome',id:p.id,code:r.code}); broadcast(r); return;
  }
  if (!current) return roomError(ws, 'Join a room before taking that action.');
  const {r,p}=current;
  if (m.type === 'leave') { clearTimeout(p.disconnectTimeout); r.players.delete(p.id); clients.delete(ws); ws.end(frame('',8)); if (!r.players.size) return removeRoom(r); if (r.host === p.id) r.host = [...r.players.values()].find(x=>x.connected)?.id || null; broadcast(r); return; }
    if (m.type === 'start') { if (p.id !== r.host) return roomError(ws,'Only the host can start the mission.'); if (r.players.size < 2) return roomError(ws,'Invite at least one more player before starting.'); if (r.phase !== 'lobby') return; r.phase='playing'; r.startedAt=Date.now(); r.endAt=r.startedAt+MISSION_SECONDS*1000; r.remaining=MISSION_SECONDS; r.level=0; r.score=0; r.solved=[]; r.timer=setInterval(()=>{ if (r.phase!=='playing') return; r.remaining=Math.max(0,Math.ceil((r.endAt-Date.now())/1000)); if (!r.remaining) finish(r,false); else broadcast(r); },1000); broadcast(r); return; }
  if (m.type === 'solve') {
      if (r.phase !== 'playing') return roomError(ws,'The mission is not active.');
    if (Date.now() >= r.endAt) { r.remaining=0; finish(r,false); return; }
    if (r.solved.includes(r.level)) return;
    const now=Date.now(), last=r.actionAt.get(p.id)||0; if (now-last<700) return roomError(ws,'Wait a moment before trying again.'); r.actionAt.set(p.id,now);
    const answer=String(m.answer||'').trim().toUpperCase();
    if (answer === puzzles[r.level].answer) { r.solved.push(r.level); r.score+=100+Math.floor(r.remaining/3); r.lastResult={ok:true,by:p.name,level:r.level}; if (r.level===2) finish(r,true); else { r.level++; broadcast(r); } }
    else { r.lastResult={ok:false,by:p.name,level:r.level}; broadcast(r); }
  }
}
function finish(r, won) { clearInterval(r.timer); r.timer=null; r.phase=won?'won':'lost'; r.remaining=won?r.remaining:0; if(won) r.score+=Math.max(0,r.remaining)*2; r.lastResult={ok:won,final:true,elapsed:Math.floor((Date.now()-r.startedAt)/1000)}; broadcast(r); }
function removeRoom(r) { clearInterval(r.timer); rooms.delete(r.code); }
function disconnect(ws) { const c=clients.get(ws); if(!c)return; clients.delete(ws); const {r,p}=c; p.ws=null; p.connected=false; p.disconnectTimeout=setTimeout(()=>{ if(!p.connected){r.players.delete(p.id);if(r.host===p.id)r.host=[...r.players.values()].find(x=>x.connected)?.id||null;if(!r.players.size)removeRoom(r);else broadcast(r); } },60000); if(r.host===p.id)r.host=[...r.players.values()].find(x=>x.connected)?.id||null; broadcast(r); }
const server=http.createServer((req,res)=>{ if(req.url==='/config.js'){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store'});return fs.createReadStream(path.join(__dirname,'config.js')).pipe(res);} if(req.url==='/'||req.url==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return fs.createReadStream(FILE).pipe(res);} res.writeHead(404);res.end('Not found'); });
server.on('upgrade',(req,socket,head)=>{ if(req.url!=='/ws'||!req.headers['sec-websocket-key']){socket.destroy();return;} const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n'); attach(socket,head); });
server.listen(PORT,HOST,()=>console.log(`Campus Blackout running at http://localhost:${PORT}`));
