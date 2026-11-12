const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  // Recibe el objeto { nombre, texto } desde el cliente
  socket.on("mensaje", (datos) => {
    console.log(`Mensaje de ${datos.nombre} (${socket.id}):`, datos.texto);

    // Reenvía el ID del socket emisor, el nombre y el texto a todos
    io.emit("mensaje", {
      id: socket.id,
      nombre: datos.nombre,
      texto: datos.texto
    });
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

// Usa el puerto del servidor en la nube o el 3000 en local
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});