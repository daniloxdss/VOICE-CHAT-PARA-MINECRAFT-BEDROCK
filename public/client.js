// Generador simple de UUID
function generateUUID() {
    return 'peer_' + Math.random().toString(36).substr(2, 9);
}

const myPeerId = generateUUID();
let ws;
let localStream;
const peerConnections = {}; // peerId -> RTCPeerConnection
const peerAudioElements = {}; // peerId -> HTMLAudioElement
const peerPositions = {}; // peerId -> { username, position: [x,y,z] }
let myPosition = null;

// Configuración de servidores STUN públicos (gratuitos de Google) para atravesar NAT
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Elementos de la interfaz
const pinDisplay = document.getElementById('pin-display');
const mcCommandDisplay = document.getElementById('mc-command');
const statusMc = document.getElementById('status-mc');
const btnCopy = document.getElementById('btn-copy');
const btnMic = document.getElementById('btn-mic');
const micText = document.getElementById('mic-text');
const micIconOn = document.getElementById('mic-icon-on');
const micIconOff = document.getElementById('mic-icon-off');
const playersList = document.getElementById('players-list');
const audioContainer = document.getElementById('audio-container');
const micVisualizer = document.getElementById('mic-visualizer');

// --- 1. ACCESO AL MICRÓFONO ---
async function initMicrophone() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Micrófono accedido con éxito.");
        setupVisualizer(localStream);
        initWebSocket();
    } catch (err) {
        alert("Error al acceder al micrófono. Por favor acepta los permisos de audio.");
        console.error(err);
    }
}

// Visualizador simple de volumen del micrófono
function setupVisualizer(stream) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 64;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function update() {
        if (!localStream) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
        }
        const average = sum / bufferLength;
        // Escalar valor para el CSS (ancho de la barra)
        const volumeWidth = Math.min(100, (average / 128) * 100);
        micVisualizer.style.width = volumeWidth + '%';
        requestAnimationFrame(update);
    }
    update();
}

// --- 2. WEBSOCKET E HILO DE SEÑALIZACIÓN ---
function initWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const wsUrl = wsProtocol + window.location.host;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("Conectado al servidor WebSocket de señalización.");
        // Registrar este navegador
        ws.send(JSON.stringify({
            type: 'register-browser',
            peerId: myPeerId
        }));
    };

    ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case 'registered':
                const pin = data.pin;
                pinDisplay.innerText = pin;
                
                // Generar comando de conexión de Minecraft
                // Usamos el host del servidor actual (ej: voice.famidash.com o IP local)
                const host = window.location.host;
                const command = `/connect ${host}/mc/${pin}`;
                mcCommandDisplay.innerText = command;

                // Conectarse a los peers que ya estaban en la sala
                data.activePeers.forEach(peerId => {
                    initiatePeerConnection(peerId, true);
                });
                break;

            case 'mc-connected':
                statusMc.innerText = "Conectado";
                statusMc.className = "status-badge connected";
                break;

            case 'mc-disconnected':
                statusMc.innerText = "Desconectado";
                statusMc.className = "status-badge disconnected";
                myPosition = null;
                updatePlayersUI();
                break;

            case 'my-position':
                myPosition = data.position; // [x,y,z]
                updatePlayersUI();
                break;

            case 'positions-update':
                // Recibir posiciones actualizadas de todos los peers
                Object.keys(data.peers).forEach(id => {
                    if (id !== myPeerId) {
                        peerPositions[id] = data.peers[id];
                    }
                });
                updateAudioVolumes();
                updatePlayersUI();
                break;

            case 'signal':
                handleSignalingMessage(data.sender, data.signal);
                break;

            case 'peer-disconnected':
                closePeerConnection(data.peerId);
                break;
        }
    };

    ws.onclose = () => {
        console.log("WebSocket desconectado. Reintentando en 3 segundos...");
        statusMc.innerText = "Desconectado";
        statusMc.className = "status-badge disconnected";
        setTimeout(initWebSocket, 3000);
    };
}

// --- 3. CONEXIÓN WEBRTC (P2P AUDIO MESH) ---
function initiatePeerConnection(peerId, isOfferor) {
    if (peerConnections[peerId]) return;

    console.log(`Iniciando conexion WebRTC con Peer: ${peerId} (Offeror: ${isOfferor})`);
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[peerId] = pc;

    // Agregar micrófono local al canal P2P
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // Enviar ICE Candidates locales al servidor para que los envíe al otro peer
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'signal',
                target: peerId,
                signal: { candidate: event.candidate }
            }));
        }
    };

    // Cuando recibimos el stream de audio del otro peer
    pc.ontrack = (event) => {
        console.log(`[Audio] Recibido stream de audio del Peer: ${peerId}`);
        const remoteStream = event.streams[0];
        
        // Crear elemento de audio para este peer si no existe
        if (!peerAudioElements[peerId]) {
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.srcObject = remoteStream;
            audioContainer.appendChild(audio);
            peerAudioElements[peerId] = audio;
        } else {
            peerAudioElements[peerId].srcObject = remoteStream;
        }
        updateAudioVolumes();
    };

    // Si somos el oferente, creamos la oferta WebRTC
    if (isOfferor) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                    type: 'signal',
                    target: peerId,
                    signal: { sdp: pc.localDescription }
                }));
            } catch (err) {
                console.error("Error creando oferta WebRTC:", err);
            }
        };
    }
}

async function handleSignalingMessage(senderId, signal) {
    // Si no tenemos conexión con el remitente, la creamos (este caso es el receptor)
    if (!peerConnections[senderId]) {
        initiatePeerConnection(senderId, false);
    }

    const pc = peerConnections[senderId];

    if (signal.sdp) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            if (pc.remoteDescription.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({
                    type: 'signal',
                    target: senderId,
                    signal: { sdp: pc.localDescription }
                }));
            }
        } catch (err) {
            console.error("Error al procesar SDP:", err);
        }
    } else if (signal.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (err) {
            console.error("Error al procesar ICE Candidate:", err);
        }
    }
}

function closePeerConnection(peerId) {
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    if (peerAudioElements[peerId]) {
        peerAudioElements[peerId].remove();
        delete peerAudioElements[peerId];
    }
    if (peerPositions[peerId]) {
        delete peerPositions[peerId];
    }
    updatePlayersUI();
    console.log(`Conexión cerrada con Peer: ${peerId}`);
}

// Variables para el simulador de pruebas solo
let simDistance = 0;
const simDistanceSlider = document.getElementById('sim-distance');
const simDistVal = document.getElementById('sim-dist-val');

if (simDistanceSlider) {
    simDistanceSlider.addEventListener('input', (e) => {
        simDistance = parseInt(e.target.value);
        simDistVal.innerText = simDistance;
        updateAudioVolumes();
        updatePlayersUI();
    });
}

// --- 4. CÁLCULO DE AUDIO POR PROXIMIDAD ---
function updateAudioVolumes() {
    Object.keys(peerAudioElements).forEach(peerId => {
        const audio = peerAudioElements[peerId];
        const peerData = peerPositions[peerId];

        let dist = 0;

        // Si usamos el modo simulador (valor mayor a 0 en la barra de pruebas)
        if (simDistance > 0) {
            dist = simDistance;
        } else {
            // Si yo no tengo posición en el juego, o el otro peer tampoco, volumen normal (sin proximidad)
            if (!myPosition || !peerData || !peerData.position) {
                audio.volume = 1.0;
                return;
            }

            const p1 = myPosition;
            const p2 = peerData.position;

            // Distancia euclidiana 3D
            const dx = p1[0] - p2[0];
            const dy = p1[1] - p2[1];
            const dz = p1[2] - p2[2];
            dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        }

        // Lógica de volumen:
        // Distancia máxima audible: 30 bloques de Minecraft
        const maxDist = 30.0;
        
        if (dist > maxDist) {
            audio.volume = 0.0; // Demasiado lejos
        } else {
            // Caída lineal de volumen
            audio.volume = 1.0 - (dist / maxDist);
        }

        console.log(`[Audio] Distancia al Peer ${peerId}: ${dist.toFixed(1)} bloques. Volumen: ${(audio.volume * 100).toFixed(0)}%`);
    });
}

// --- 5. INTERFAZ GRÁFICA DE USUARIO (UI) ---
function updatePlayersUI() {
    playersList.innerHTML = '';
    const activeIds = Object.keys(peerConnections);

    if (activeIds.length === 0) {
        playersList.innerHTML = '<li class="empty-list">Esperando a otros jugadores...</li>';
        return;
    }

    activeIds.forEach(id => {
        const li = document.createElement('li');
        li.className = 'player-item';

        const pData = peerPositions[id];
        const hasMc = pData && pData.position;
        let name = hasMc ? pData.username : `Navegador (${id.substr(5, 4)})`;
        
        let dist = 0;
        let distText = '';

        if (simDistance > 0) {
            distText = `<span class="player-dist">${simDistance}m (Simulado)</span>`;
        } else if (myPosition && hasMc) {
            const dx = myPosition[0] - pData.position[0];
            const dy = myPosition[1] - pData.position[1];
            const dz = myPosition[2] - pData.position[2];
            dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            distText = `<span class="player-dist">${dist.toFixed(0)}m</span>`;
        }

        li.innerHTML = `
            <div class="player-info">
                <span class="player-status-mc ${hasMc ? 'online' : ''}"></span>
                <span class="player-name">${name}</span>
            </div>
            ${distText}
        `;
        playersList.appendChild(li);
    });
}

// Silenciar / Activar micrófono
let micMuted = false;
btnMic.addEventListener('click', () => {
    if (!localStream) return;
    
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !micMuted;
    });

    if (micMuted) {
        btnMic.className = 'btn btn-muted';
        micText.innerText = 'Activar Micrófono';
        micIconOn.classList.add('hidden');
        micIconOff.classList.remove('hidden');
        micVisualizer.style.width = '0%';
    } else {
        btnMic.className = 'btn btn-primary';
        micText.innerText = 'Silenciar Micrófono';
        micIconOn.classList.remove('hidden');
        micIconOff.classList.add('hidden');
    }
});

// Botón de Copiar Comando
btnCopy.addEventListener('click', () => {
    const text = mcCommandDisplay.innerText;
    if (text === 'Generando comando...') return;
    
    navigator.clipboard.writeText(text).then(() => {
        const oldColor = btnCopy.style.color;
        btnCopy.style.color = '#00ffcc';
        setTimeout(() => {
            btnCopy.style.color = oldColor;
        }, 1000);
    }).catch(err => {
        console.error('Error al copiar:', err);
    });
});

// Inicializar al cargar
window.addEventListener('DOMContentLoaded', () => {
    initMicrophone();

    // Huevo de pascua / Modo Desarrollador:
    // Si entras con http://localhost:8000/?dev=true, se muestra el simulador
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('dev') === 'true' || urlParams.get('dev') === '1') {
        const devPanel = document.getElementById('dev-panel');
        if (devPanel) devPanel.classList.remove('hidden');
    }
});
