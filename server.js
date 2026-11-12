const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Límite de 2.5 MB en transporte para permitir archivos Base64 de hasta 2 MB
const io = new Server(server, {
  maxHttpBufferSize: 2.5 * 1024 * 1024
});

app.use(express.static('public'));

// Almacenamiento en memoria
const usuariosConectados = {}; // { socketId: { nombre, sala, registrado, color, ultimoMensaje } }
const cuentasRegistradas = {}; // { usuario: { password, color } }
const reportesMensajes = {};   // { msgId: Set(socketId) }

const LIMITE_BYTES_ARCHIVO = 2 * 1024 * 1024; // 2 MB exactos[cite: 16]

// Sanitización básica en servidor para seguridad contra XSS[cite: 16]
function sanitizar(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .slice(0, 500);
}

// Emitir lista de usuarios de una sala específica[cite: 16]
function actualizarUsuariosSala(sala) {
  const lista = Object.values(usuariosConectados)
    .filter((u) => u.sala === sala)
    .map((u) => ({ nombre: u.nombre, registrado: u.registrado }));
  io.to(sala).emit('lista-usuarios', lista);
}

io.on('connection', (socket) => {
  // 1. Registro e inicio de sesión[cite: 16]
  socket.on('autenticar', ({ modo, usuario, password }, callback) => {
    const userLimpio = sanitizar(usuario).slice(0, 20);
    if (!userLimpio) return callback({ ok: false, error: 'Nombre inválido.' });

    if (modo === 'registro') {
      if (!password || password.length < 4) {
        return callback({ ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });
      }
      if (cuentasRegistradas[userLimpio.toLowerCase()]) {
        return callback({ ok: false, error: 'Ese usuario ya existe. Inicia sesión.' });
      }
      cuentasRegistradas[userLimpio.toLowerCase()] = {
        nombre: userLimpio,
        password,
        color: '#38bdf8'
      };
      return callback({ ok: true, nombre: userLimpio, registrado: true, color: '#38bdf8' });
    }

    if (modo === 'login') {
      const cuenta = cuentasRegistradas[userLimpio.toLowerCase()];
      if (!cuenta || cuenta.password !== password) {
        return callback({ ok: false, error: 'Usuario o contraseña incorrectos.' });
      }
      return callback({ ok: true, nombre: cuenta.nombre, registrado: true, color: cuenta.color });
    }

    // Modo invitado[cite: 16]
    return callback({ ok: true, nombre: `${userLimpio} (Invitado)`, registrado: false, color: '#94a3b8' });
  });

  // 2. Entrar al chat / cambiar de sala (Global o Privada)[cite: 16]
  socket.on('unirse-sala', ({ nombre, sala, registrado, color }) => {
    const usuarioPrevio = usuariosConectados[socket.id];
    const salaDestino = registrado ? (sanitizar(sala) || 'Global') : 'Global';

    if (usuarioPrevio && usuarioPrevio.sala) {
      socket.leave(usuarioPrevio.sala);
      io.to(usuarioPrevio.sala).emit('sistema', `${usuarioPrevio.nombre} salió de la sala.`);
      actualizarUsuariosSala(usuarioPrevio.sala);
    }

    socket.join(salaDestino);
    usuariosConectados[socket.id] = {
      nombre: sanitizar(nombre),
      sala: salaDestino,
      registrado: Boolean(registrado),
      color: color || '#38bdf8',
      ultimoMensaje: 0
    };

    io.to(salaDestino).emit('sistema', `${nombre} se unió a la sala: ${salaDestino}`);
    actualizarUsuariosSala(salaDestino);
  });

  // 3. Actualizar perfil (solo usuarios registrados)[cite: 16]
  socket.on('actualizar-perfil', ({ nuevoNombre, nuevoColor }, callback) => {
    const user = usuariosConectados[socket.id];
    if (!user || !user.registrado) {
      return callback({ ok: false, error: 'Inicia sesión para editar tu perfil.' });
    }
    const nombreLimpio = sanitizar(nuevoNombre).slice(0, 20);
    if (nombreLimpio) user.nombre = nombreLimpio;
    if (/^#[0-9A-Fa-f]{6}$/.test(nuevoColor)) user.color = nuevoColor;

    actualizarUsuariosSala(user.sala);
    callback({ ok: true, nombre: user.nombre, color: user.color });
  });

  // 4. Envío de mensajes y archivos (máx 2 MB) con seguridad anti-spam[cite: 16]
  socket.on('mensaje', ({ texto, archivo }) => {
    const user = usuariosConectados[socket.id];
    if (!user) return;

    // Seguridad: Rate limiting (máximo 1 mensaje cada 600ms)[cite: 16]
    const ahora = Date.now();
    if (ahora - user.ultimoMensaje < 600) {
      return socket.emit('sistema', '⚠️ Vas muy rápido. Espera un momento.');
    }
    user.ultimoMensaje = ahora;

    const textoLimpio = sanitizar(texto);
    let archivoValidado = null;

    // Validación de archivo de máximo 2 MB (solo usuarios registrados)[cite: 16]
    if (archivo) {
      if (!user.registrado) {
        return socket.emit('sistema', '🔒 Inicia sesión para desbloquear el envío de archivos.');
      }
      if (archivo.tamano > LIMITE_BYTES_ARCHIVO) {
        return socket.emit('sistema', '❌ El archivo supera el límite de 2 MB.');
      }
      archivoValidado = {
        nombre: sanitizar(archivo.nombre).slice(0, 60),
        tipo: archivo.tipo,
        dataUrl: archivo.dataUrl
      };
    }

    if (!textoLimpio && !archivoValidado) return;

    const msgId = `${socket.id}-${ahora}`;
    io.to(user.sala).emit('mensaje', {
      msgId,
      id: socket.id,
      nombre: user.nombre,
      color: user.color,
      registrado: user.registrado,
      texto: textoLimpio,
      archivo: archivoValidado,
      hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // 5. Reporte de mensajes malvados[cite: 16]
  socket.on('reportar-mensaje', (msgId) => {
    const user = usuariosConectados[socket.id];
    if (!user || !msgId) return;

    if (!reportesMensajes[msgId]) reportesMensajes[msgId] = new Set();
    reportesMensajes[msgId].add(socket.id);

    // Si alcanza 2 reportes, se oculta en la sala[cite: 16]
    if (reportesMensajes[msgId].size >= 2) {
      io.to(user.sala).emit('mensaje-oculto', msgId);
      io.to(user.sala).emit('sistema', '🛡️ Un mensaje fue ocultado por reportes de la comunidad.');
    } else {
      socket.emit('sistema', '🚩 Reporte enviado. Si otro usuario lo reporta, se ocultará.');
    }
  });

  // 6. Indicador de escribiendo por sala
  socket.on('escribiendo', () => {
    const user = usuariosConectados[socket.id];
    if (user) socket.to(user.sala).emit('escribiendo', user.nombre);
  });

  socket.on('dejo-de-escribir', () => {
    const user = usuariosConectados[socket.id];
    if (user) socket.to(user.sala).emit('dejo-de-escribir');
  });

  // 7. Desconexión
  socket.on('disconnect', () => {
    const user = usuariosConectados[socket.id];
    if (user) {
      const sala = user.sala;
      delete usuariosConectados[socket.id];
      io.to(sala).emit('sistema', `${user.nombre} se desconectó.`);
      actualizarUsuariosSala(sala);
    }
  });
});

// Actualización y limpieza periódica cada 5 minutos (300,000 ms)[cite: 16]
setInterval(() => {
  const salasActivas = new Set(Object.values(usuariosConectados).map((u) => u.sala));
  salasActivas.forEach((sala) => {
    actualizarUsuariosSala(sala);
    io.to(sala).emit('sincronizacion-5min', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });
  console.log('[Sincronización 5 min] Estado de salas actualizado.');
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});