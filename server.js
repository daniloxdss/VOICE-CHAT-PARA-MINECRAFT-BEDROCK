const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { crypto } = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// Almacenamiento en memoria para conexiones y emparejamiento
const pins = {};           // PIN -> { browserWs, mcWs, peerId, username: null, position: null }
const peers = {};          // peerId -> { browserWs, pin, username: null, position: null }

// Helper para generar PINs unicos de 5 digitos
function generatePin() {
    let pin;
    do {
        pin = Math.floor(10000 + Math.random() * 90000).toString();
    } while (pins[pin]);
    return pin;
}

wss.on('connection', (ws, req) => {
    const url = req.url;

    // Capturar errores de WebSocket para que el servidor no se caiga
    // si Minecraft Bedrock envía paquetes/frames malformados o códigos de cierre inválidos.
    ws.on('error', (err) => {
        console.log(`[WS Error] Error controlado: ${err.message}`);
    });

    // --- DETECTAR CONEXION DESDE MINECRAFT BEDROCK ---
    // Minecraft suele conectarse a una ruta como /mc/PIN o simplemente podemos parsear la URL
    if (url.startsWith('/mc/')) {
        const pin = url.split('/mc/')[1];
        console.log(`[MC] Intentando conectar con PIN: ${pin}`);

        if (!pins[pin]) {
            console.log(`[MC] PIN ${pin} no existe. Cerrando conexion.`);
            ws.close();
            return;
        }

        const session = pins[pin];
        session.mcWs = ws;
        const peerId = session.peerId;

        console.log(`[MC] Emparejado con éxito con el navegador del Peer: ${peerId}`);

        // Avisar al navegador que Minecraft se conecto
        if (session.browserWs && session.browserWs.readyState === WebSocket.OPEN) {
            session.browserWs.send(JSON.stringify({ type: 'mc-connected' }));
        }

        // Suscribirse a eventos de Minecraft (opcional, por si queremos rastrear eventos)
        ws.send(JSON.stringify({
            header: {
                version: 1,
                requestId: "subscribe-travel",
                messageType: "commandRequest",
                purpose: "subscribe"
            },
            body: {
                eventName: "PlayerTravelled"
            }
        }));

        // Bucle de sondeo (polling) de posicion: enviamos /querytarget @s cada 500ms
        const positionInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(positionInterval);
                return;
            }
            // Consultar coordenadas del jugador local
            ws.send(JSON.stringify({
                header: {
                    version: 1,
                    requestId: `pos-${Date.now()}`,
                    messageType: "commandRequest",
                    purpose: "commandRequest"
                },
                body: {
                    commandLine: "querytarget @s",
                    version: 1
                }
            }));
        }, 500);

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // Procesar respuesta de comandos
                if (data.body && data.body.statusCode === 0 && data.body.details) {
                    const details = JSON.parse(data.body.details);
                    if (details && details.length > 0) {
                        const playerInfo = details[0];
                        const pos = playerInfo.position; // [x, y, z]
                        const name = playerInfo.name;

                        // Actualizar datos del peer
                        session.username = name;
                        session.position = pos;
                        peers[peerId].username = name;
                        peers[peerId].position = pos;

                        // Enviar coordenadas actualizadas al navegador del propio jugador
                        if (session.browserWs && session.browserWs.readyState === WebSocket.OPEN) {
                            session.browserWs.send(JSON.stringify({
                                type: 'my-position',
                                position: pos,
                                username: name
                            }));
                        }

                        // Broadcast de posiciones a todos los demas navegadores para que calculen el audio
                        broadcastPositions();
                    }
                }
            } catch (e) {
                // Silenciar errores de parseo de mensajes no-JSON o respuestas raras de MC
            }
        });

        ws.on('close', () => {
            console.log(`[MC] Minecraft cerro conexion para PIN: ${pin}`);
            clearInterval(positionInterval);
            if (pins[pin]) {
                pins[pin].mcWs = null;
                if (pins[pin].browserWs && pins[pin].browserWs.readyState === WebSocket.OPEN) {
                    pins[pin].browserWs.send(JSON.stringify({ type: 'mc-disconnected' }));
                }
            }
        });

        return;
    }

    // --- DETECTAR CONEXION DESDE EL NAVEGADOR WEB ---
    let myPeerId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                // Registrar nuevo navegador y generar PIN
                case 'register-browser':
                    myPeerId = data.peerId;
                    const pin = generatePin();
                    
                    pins[pin] = {
                        browserWs: ws,
                        mcWs: null,
                        peerId: myPeerId,
                        username: null,
                        position: null
                    };

                    peers[myPeerId] = {
                        browserWs: ws,
                        pin: pin,
                        username: null,
                        position: null
                    };

                    console.log(`[Web] Registrado Peer: ${myPeerId} con PIN: ${pin}`);
                    
                    ws.send(JSON.stringify({
                        type: 'registered',
                        pin: pin,
                        activePeers: Object.keys(peers).filter(id => id !== myPeerId)
                    }));
                    break;

                // Reenviar senalizacion WebRTC (Offer, Answer, ICE Candidate) al peer correspondiente
                case 'signal':
                    const targetId = data.target;
                    if (peers[targetId] && peers[targetId].browserWs.readyState === WebSocket.OPEN) {
                        peers[targetId].browserWs.send(JSON.stringify({
                            type: 'signal',
                            sender: myPeerId,
                            signal: data.signal
                        }));
                    }
                    break;
            }
        } catch (e) {
            console.error("[Web] Error procesando mensaje del navegador:", e);
        }
    });

    ws.on('close', () => {
        if (myPeerId && peers[myPeerId]) {
            const pin = peers[myPeerId].pin;
            console.log(`[Web] Navegador desconectado. Peer: ${myPeerId}, PIN: ${pin}`);
            
            // Avisar a los demas peers que este se fue
            Object.keys(peers).forEach(id => {
                if (id !== myPeerId && peers[id].browserWs.readyState === WebSocket.OPEN) {
                    peers[id].browserWs.send(JSON.stringify({
                        type: 'peer-disconnected',
                        peerId: myPeerId
                    }));
                }
            });

            // Cerrar socket de Minecraft asociado si seguia abierto
            if (pins[pin] && pins[pin].mcWs) {
                pins[pin].mcWs.close();
            }

            delete pins[pin];
            delete peers[myPeerId];
            broadcastPositions();
        }
    });
});

// Envia la lista de posiciones actualizadas a todos los navegadores conectados
function broadcastPositions() {
    const list = {};
    Object.keys(peers).forEach(id => {
        if (peers[id].position) {
            list[id] = {
                username: peers[id].username,
                position: peers[id].position
            };
        }
    });

    Object.keys(peers).forEach(id => {
        const ws = peers[id].browserWs;
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'positions-update',
                peers: list
            }));
        }
    });
}

const PORT = 8000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de Voz por Proximidad corriendo en: http://localhost:${PORT}`);
});
