const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Guarda los usuarios conectados: { socketId: "Nombre" }
const usuariosConectados = {};

io.on("connection", (socket) => {
  console.log("Socket conectado:", socket.id);

  // Cuando un usuario ingresa su nombre y entra al chat
  socket.on("nuevo-usuario", (nombre) => {
    usuariosConectados[socket.id] = nombre;

    // Avisa a los demás que alguien se unió
    socket.broadcast.emit("sistema", `${nombre} se unió al chat`);

    // Envía la lista actualizada de usuarios conectados a todos
    io.emit("lista-usuarios", Object.values(usuariosConectados));
  });

  // Cuando alguien envía un mensaje
  socket.on("mensaje", (datos) => {
    io.emit("mensaje", {
      id: socket.id,
      nombre: datos.nombre,
      texto: datos.texto,
      hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Indicador de "está escribiendo..." (se envía a todos menos al que escribe)
  socket.on("escribiendo", (nombre) => {
    socket.broadcast.emit("escribiendo", nombre);
  });

  socket.on("dejo-de-escribir", () => {
    socket.broadcast.emit("dejo-de-escribir");
  });

  // Cuando alguien cierra la pestaña o pierde conexión
  socket.on("disconnect", () => {
    const nombre = usuariosConectados[socket.id];
    if (nombre) {
      delete usuariosConectados[socket.id];
      io.emit("sistema", `${nombre} salió del chat`);
      io.emit("lista-usuarios", Object.values(usuariosConectados));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});