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
const usuariosConectados = Object.create(null); // { socketId: { nombre, sala, registrado, color, ultimoMensaje } }
const cuentasRegistradas = Object.create(null); // { usuario: { password, color } }
const reportesMensajes = Object.create(null);   // { msgId: Set(socketId) }
const salasPrivadas = Object.create(null); // { claveSala: { nombre, propietario, miembros: Set(usuario) } }

const LIMITE_BYTES_ARCHIVO = 2 * 1024 * 1024; // 2 MB exactos[cite: 16]
const TIPOS_IMAGEN_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const PALABRAS_OFENSIVAS = [
  'asshole', 'bitch', 'cabron', 'cabrona', 'culo', 'fuck', 'idiota',
  'imbecil', 'mierda', 'pendeja', 'pendejo', 'puta', 'puto', 'shit',
  'estupido', 'estupida', 'zorra'
];

// Limita entradas; el escape HTML se realiza en el cliente mediante textContent.
function sanitizar(texto) {
  if (typeof texto !== 'string') return '';
  return texto.trim().slice(0, 500);
}

function contieneLenguajeOfensivo(texto) {
  const normalizado = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return PALABRAS_OFENSIVAS.some((palabra) => {
    const letrasConSeparadores = palabra.split('').map((letra) => `${letra}+`).join('[^a-z0-9]*');
    return new RegExp(`(^|[^a-z0-9])${letrasConSeparadores}($|[^a-z0-9])`).test(normalizado);
  });
}

function limpiarNombreSala(nombre) {
  if (typeof nombre !== 'string') return '';
  return nombre.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function claveSalaPrivada(sala) {
  return sala.toLowerCase();
}

function detectarTipoImagen(datos) {
  if (datos.length >= 3 && datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) {
    return 'image/jpeg';
  }
  if (datos.length >= 8 &&
      datos.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (datos.length >= 6 &&
      (datos.subarray(0, 6).toString('ascii') === 'GIF87a' ||
       datos.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (datos.length >= 12 &&
      datos.subarray(0, 4).toString('ascii') === 'RIFF' &&
      datos.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// Emitir lista de usuarios de una sala específica[cite: 16]
function actualizarUsuariosSala(sala) {
  const lista = Object.values(usuariosConectados)
    .filter((u) => u.sala === sala)
    .map((u) => ({ nombre: u.nombre, registrado: u.registrado }));
  io.to(sala).emit('lista-usuarios', lista);
}

io.on('connection', (socket) => {
  function entrarEnSala(salaDestino, callback) {
    const identidad = socket.data.identidad;
    if (!identidad) return;

    const usuarioPrevio = usuariosConectados[socket.id];
    if (usuarioPrevio && usuarioPrevio.sala) {
      socket.leave(usuarioPrevio.sala);
      io.to(usuarioPrevio.sala).emit('sistema', `${usuarioPrevio.nombre} salió de la sala.`);
      actualizarUsuariosSala(usuarioPrevio.sala);
    }

    socket.join(salaDestino);
    usuariosConectados[socket.id] = {
      nombre: identidad.nombre,
      sala: salaDestino,
      registrado: identidad.registrado,
      color: identidad.color,
      cuentaId: identidad.cuentaId,
      ultimoMensaje: usuarioPrevio ? usuarioPrevio.ultimoMensaje : 0
    };

    const salaPrivada = salaDestino === 'Global'
      ? null
      : salasPrivadas[claveSalaPrivada(salaDestino)];
    io.to(salaDestino).emit('sistema', `${identidad.nombre} se unió a la sala: ${salaDestino}`);
    actualizarUsuariosSala(salaDestino);

    if (typeof callback === 'function') {
      callback({
        ok: true,
        sala: salaDestino,
        esPropietario: Boolean(salaPrivada && salaPrivada.propietario === identidad.cuentaId)
      });
    }
  }

  // 1. Registro e inicio de sesión[cite: 16]
  socket.on('autenticar', (datos, callback) => {
    const responder = (resultado, identidad) => {
      if (identidad) socket.data.identidad = identidad;
      if (typeof callback === 'function') callback(resultado);
    };

    if (socket.data.identidad) {
      return responder({ ok: false, error: 'Ya has iniciado sesión en esta conexión.' });
    }

    if (!datos || typeof datos !== 'object') {
      return responder({ ok: false, error: 'Datos de inicio de sesión inválidos.' });
    }

    const { modo, usuario, password } = datos;
    const userLimpio = sanitizar(usuario).slice(0, 20);
    if (!userLimpio) return responder({ ok: false, error: 'Nombre inválido.' });
    if (contieneLenguajeOfensivo(userLimpio)) {
      return responder({ ok: false, error: 'Ese nombre contiene palabras ofensivas y no está permitido. Elige otro nombre.' });
    }

    if (modo === 'registro') {
      if (typeof password !== 'string' || password.length < 4) {
        return responder({ ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });
      }
      if (cuentasRegistradas[userLimpio.toLowerCase()]) {
        return responder({ ok: false, error: 'Ese usuario ya existe. Inicia sesión.' });
      }
      cuentasRegistradas[userLimpio.toLowerCase()] = {
        nombre: userLimpio,
        password,
        color: '#38bdf8'
      };
      const identidad = {
        nombre: userLimpio,
        registrado: true,
        color: '#38bdf8',
        cuentaId: userLimpio.toLowerCase()
      };
      return responder(
        { ok: true, nombre: identidad.nombre, registrado: true, color: identidad.color },
        identidad
      );
    }

    if (modo === 'login') {
      const cuenta = cuentasRegistradas[userLimpio.toLowerCase()];
      if (!cuenta || cuenta.password !== password) {
        return responder({ ok: false, error: 'Usuario o contraseña incorrectos.' });
      }
      return responder({ ok: true, nombre: cuenta.nombre, registrado: true, color: cuenta.color }, {
        nombre: cuenta.nombre,
        registrado: true,
        color: cuenta.color,
        cuentaId: userLimpio.toLowerCase()
      });
    }

    if (modo === 'invitado') {
      const identidad = { nombre: `${userLimpio} (Invitado)`, registrado: false, color: '#94a3b8' };
      return responder({ ok: true, ...identidad }, identidad);
    }

    return responder({ ok: false, error: 'Modo de inicio de sesión inválido.' });
  });

  // 2. Entrar al chat / cambiar de sala (Global o Privada)[cite: 16]
  socket.on('unirse-sala', (datos, callback) => {
    const identidad = socket.data.identidad;
    const responder = (resultado) => {
      if (typeof callback === 'function') callback(resultado);
    };
    if (!identidad || !datos || typeof datos !== 'object' || typeof datos.sala !== 'string') {
      return responder({ ok: false, error: 'Solicitud para entrar a la sala inválida.' });
    }

    const salaSolicitada = datos.sala.trim();
    if (salaSolicitada === 'Global') {
      return entrarEnSala('Global', responder);
    }
    if (!identidad.registrado || !identidad.cuentaId || !/^Privada:\s+/i.test(salaSolicitada)) {
      return responder({ ok: false, error: 'No tienes permiso para entrar a esa sala privada.' });
    }

    const nombreSala = limpiarNombreSala(salaSolicitada.replace(/^Privada:\s+/i, ''));
    if (!nombreSala) {
      return responder({ ok: false, error: 'El nombre de la sala privada no es válido.' });
    }

    const salaClave = claveSalaPrivada(`Privada: ${nombreSala}`);
    const salaPrivada = salasPrivadas[salaClave];
    if (!salaPrivada || !salaPrivada.miembros.has(identidad.cuentaId)) {
      return responder({ ok: false, error: 'No tienes invitación para esa sala privada.' });
    }

    entrarEnSala(salaPrivada.nombre, responder);
  });

  socket.on('crear-sala-privada', (datos, callback) => {
    const identidad = socket.data.identidad;
    const responder = (resultado) => {
      if (typeof callback === 'function') callback(resultado);
    };
    if (!identidad || !identidad.registrado || !identidad.cuentaId ||
        !datos || typeof datos.nombre !== 'string') {
      return responder({ ok: false, error: 'Debes iniciar sesión con una cuenta para crear salas privadas.' });
    }

    const nombre = limpiarNombreSala(datos.nombre);
    if (!nombre) {
      return responder({ ok: false, error: 'Escribe un nombre válido para la sala.' });
    }

    const sala = `Privada: ${nombre}`;
    const salaClave = claveSalaPrivada(sala);
    if (salasPrivadas[salaClave]) {
      return responder({ ok: false, error: 'Ya existe una sala con ese nombre. Para entrar, necesitas una invitación.' });
    }

    salasPrivadas[salaClave] = {
      nombre: sala,
      propietario: identidad.cuentaId,
      miembros: new Set([identidad.cuentaId])
    };
    entrarEnSala(sala, responder);
  });

  socket.on('invitar-a-sala', (datos, callback) => {
    const identidad = socket.data.identidad;
    const user = usuariosConectados[socket.id];
    const responder = (resultado) => {
      if (typeof callback === 'function') callback(resultado);
    };
    if (!identidad || !identidad.registrado || !identidad.cuentaId ||
        !user || !datos || typeof datos.sala !== 'string' || typeof datos.usuario !== 'string') {
      return responder({ ok: false, error: 'No se pudo procesar la invitación.' });
    }

    const salaPrivada = salasPrivadas[claveSalaPrivada(user.sala)];
    if (!salaPrivada || salaPrivada.propietario !== identidad.cuentaId) {
      return responder({ ok: false, error: 'Solo el propietario puede invitar usuarios a esta sala.' });
    }
    if (claveSalaPrivada(datos.sala.trim()) !== claveSalaPrivada(user.sala)) {
      return responder({ ok: false, error: 'La invitación no corresponde a tu sala actual.' });
    }

    const cuentaId = datos.usuario.trim().toLowerCase();
    const cuenta = cuentasRegistradas[cuentaId];
    if (!cuenta) {
      return responder({ ok: false, error: 'No existe una cuenta registrada con ese nombre.' });
    }

    salaPrivada.miembros.add(cuentaId);
    for (const [socketId, usuario] of Object.entries(usuariosConectados)) {
      if (usuario.cuentaId === cuentaId) {
        io.to(socketId).emit('invitacion-sala', { sala: salaPrivada.nombre });
      }
    }
    responder({ ok: true, usuario: cuenta.nombre });
  });

  // 3. Actualizar perfil (solo usuarios registrados)[cite: 16]
  socket.on('actualizar-perfil', (datos, callback) => {
    const responder = (resultado) => {
      if (typeof callback === 'function') callback(resultado);
    };
    const user = usuariosConectados[socket.id];
    if (!user || !user.registrado || !datos || typeof datos !== 'object') {
      return responder({ ok: false, error: 'Inicia sesión para editar tu perfil.' });
    }
    const nombreLimpio = sanitizar(datos.nuevoNombre).slice(0, 20);
    if (contieneLenguajeOfensivo(nombreLimpio)) {
      return responder({ ok: false, error: 'Ese nombre contiene palabras ofensivas y no está permitido. Elige otro nombre.' });
    }
    if (nombreLimpio) user.nombre = nombreLimpio;
    if (typeof datos.nuevoColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(datos.nuevoColor)) {
      user.color = datos.nuevoColor;
    }
    socket.data.identidad.nombre = user.nombre;
    socket.data.identidad.color = user.color;

    actualizarUsuariosSala(user.sala);
    responder({ ok: true, nombre: user.nombre, color: user.color });
  });

  // 4. Envío de mensajes y archivos (máx 2 MB) con seguridad anti-spam[cite: 16]
  socket.on('mensaje', (datos) => {
    const user = usuariosConectados[socket.id];
    if (!user || !datos || typeof datos !== 'object') return;
    const { texto, archivo } = datos;

    // Seguridad: Rate limiting (máximo 1 mensaje cada 600ms)[cite: 16]
    const ahora = Date.now();
    if (ahora - user.ultimoMensaje < 600) {
      return socket.emit('sistema', '⚠️ Vas muy rápido. Espera un momento.');
    }
    user.ultimoMensaje = ahora;

    const textoLimpio = typeof texto === 'string' ? sanitizar(texto) : '';
    if (contieneLenguajeOfensivo(textoLimpio)) {
      return socket.emit('alerta-moderacion', 'Tu mensaje contiene lenguaje ofensivo y no se envió. Por favor, escribe otro mensaje.');
    }

    let archivoValidado = null;

    // Solo se permiten imágenes rasterizadas validadas por su firma binaria.
    if (archivo) {
      if (!user.registrado) {
        return socket.emit('sistema', '🔒 Inicia sesión para desbloquear el envío de imágenes.');
      }
      if (typeof archivo !== 'object' ||
          typeof archivo.nombre !== 'string' ||
          typeof archivo.tipo !== 'string' ||
          typeof archivo.dataUrl !== 'string' ||
          !Number.isInteger(archivo.tamano) ||
          archivo.tamano < 0 ||
          archivo.tamano > LIMITE_BYTES_ARCHIVO) {
        return socket.emit('sistema', '❌ La imagen supera el límite de 2 MB o los datos no son válidos.');
      }

      const coincidencia = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(archivo.dataUrl);
      if (!coincidencia ||
          coincidencia[1].toLowerCase() !== archivo.tipo.toLowerCase() ||
          !TIPOS_IMAGEN_PERMITIDOS.has(coincidencia[1].toLowerCase())) {
        return socket.emit('sistema', '❌ Solo se permiten imágenes JPG, PNG, GIF o WEBP.');
      }

      const datosArchivo = Buffer.from(coincidencia[2], 'base64');
      if (datosArchivo.toString('base64') !== coincidencia[2] ||
          datosArchivo.length !== archivo.tamano ||
          datosArchivo.length > LIMITE_BYTES_ARCHIVO) {
        return socket.emit('sistema', '❌ El archivo no tiene un tamaño válido.');
      }

      if (detectarTipoImagen(datosArchivo) !== coincidencia[1].toLowerCase()) {
        return socket.emit('sistema', '❌ El contenido del archivo no coincide con una imagen válida.');
      }

      archivoValidado = {
        nombre: sanitizar(archivo.nombre).slice(0, 60),
        tipo: coincidencia[1].toLowerCase(),
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