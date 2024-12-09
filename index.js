const dgram = require("dgram");
const crypto = require("crypto");
const cp = require("child_process");

const token = require("./token.json");
const selfMute = false;
const selfDeafen = false;
const intents = (1 << 9) + (1 << 15);

// const guildId = "1309396066482786315";
// const channelId = "1309396066482786319";
const guildId = "875581360071376926";
const channelId = "875581360071376930";

let extraFfmpegArgs = [];
let playing;
let loop = false;
let noLoop = false;

main();

async function main() {
    console.log("Connecting to gateway");
    const gateway = await connectGateway({
        token,
        intents
    });

    console.log(`Joining ${channelId} in ${guildId}`);
    const voiceChannel = await joinVoiceChannel(gateway, {
        guildId,
        channelId,
        selfMute,
        selfDeafen
    });

    console.log(`Connecting to voice channel gateway at ${voiceChannel.endpoint}`);
    const voiceGateway = await connectVoiceGateway({
        endpoint: voiceChannel.endpoint,
        guildId: voiceChannel.guildId,
        userId: gateway.user.id,
        sessionId: gateway.sessionId,
        token: voiceChannel.token
    });

    const udpConnection = createUdpConnection(voiceGateway.address, voiceGateway.port);

    console.log(`Performing IP discovery at ${voiceGateway.address}:${voiceGateway.port}`);
    const ipDiscovery = await performIpDiscovery(udpConnection);

    console.log("Selecting protocol");
    const protocol = await selectProtocol(voiceGateway, {
        address: ipDiscovery.address,
        port: ipDiscovery.port,
        mode: "aead_aes256_gcm_rtpsize",
        audioCodec: "opus"
    });

    console.log("Ready");

    // udpConnection.connection.addListener("message", msg => console.log("Receiving UDP data:", msg.toString()));

    gateway.connection.addEventListener("message", msg => {
        const json = JSON.parse(msg.data);

        if (json.op === 0) {
            if (json.t === "MESSAGE_CREATE") {
                if (json.d.guild_id !== voiceChannel.guildId) return;
                const [command, ...args] = json.d.content.split(" ");

                if (command === "!play") {
                    if (playing && !playing.getStatus().stopped) {
                        noLoop = true;
                        playing.stop();
                        playing.once("stopped", startPlaying);
                    } else startPlaying();
                    function startPlaying() {
                        playing = play(args.join(" "), voiceGateway, udpConnection, protocol.secretKeyBuffer);
                    }
                }

                if (command === "!stop") {
                    if (playing && !playing.getStatus().stopped) {
                        noLoop = true;
                        playing.stop();
                    }
                }

                if (command === "!loop") {
                    loop = !loop;
                    if (loop && playing) {
                        if (!playing.getStatus().stopped) {
                            playing.once("stopped", startPlaying);
                        } else startPlaying();
                        function startPlaying() {
                            if (!noLoop) {
                                playing = play(playing.getStatus().input, voiceGateway, udpConnection, protocol.secretKeyBuffer);
                            } else noLoop = false;
                            playing.once("stopped", () => {
                                if (loop) startPlaying();
                            });
                        }
                    }
                }

                if (command === "!replay") {
                    if (!playing) return;
                    if (!playing.getStatus().stopped) {
                        noLoop = true;
                        playing.stop();
                        playing.once("stopped", startPlaying);
                    } else startPlaying();
                    function startPlaying() {
                        playing = play(playing.getStatus().input, voiceGateway, udpConnection, protocol.secretKeyBuffer);
                    }
                }

                if (command === "!args") {
                    extraFfmpegArgs = args;
                }
            }
        }
    });
}

function connectGateway(identify) {
    return new Promise((resolve, reject) => {
        const gateway = new WebSocket("wss://gateway.discord.gg?v=10&encoding=json");

        let heartbeatInterval;
        let seq = null;

        gateway.addEventListener("open", () => {

        });

        gateway.addEventListener("close", () => {
            clearInterval(heartbeatInterval);
        });

        gateway.addEventListener("message", messageListener);

        function messageListener(msg) {
            const json = JSON.parse(msg.data);

            if (json.s) seq = json.s;

            if (json.op === 10) {
                heartbeatInterval = setInterval(() => send(1, seq), json.d.heartbeat_interval);
                send(2, {
                    token: identify.token,
                    properties: {},
                    intents: identify.intents
                });
            }
            if (json.op === 0) {
                if (json.t === "READY") {
                    gateway.removeEventListener("message", messageListener);
                    resolve({
                        connection: gateway,
                        send,
                        sessionId: json.d.session_id,
                        user: json.d.user
                    });
                }
            }
        }

        function send(op, data) {
            gateway.send(JSON.stringify({
                op,
                d: data
            }));
        }
    });
}

function joinVoiceChannel(gateway, options = {}) {
    return new Promise((resolve, reject) => {
        gateway.send(4, {
            guild_id: options.guildId,
            channel_id: options.channelId,
            self_mute: options.selfMute,
            self_deaf: options.selfDeafen,
        });

        gateway.connection.addEventListener("message", messageListener);

        function messageListener(msg) {
            const json = JSON.parse(msg.data);

            if (json.op === 0) {
                if (json.t === "VOICE_SERVER_UPDATE") {
                    if (json.d.guild_id !== options.guildId) return;
                    gateway.connection.removeEventListener("message", messageListener);
                    resolve({
                        token: json.d.token,
                        guildId: json.d.guild_id,
                        endpoint: json.d.endpoint
                    });
                }
            }
        }
    });
}

function connectVoiceGateway(options = {}) {
    return new Promise((resolve, reject) => {
        const gateway = new WebSocket(`wss://${options.endpoint}?v=8`);

        let heartbeatInterval;
        let seqAck = null;

        gateway.addEventListener("open", () => {

        });

        gateway.addEventListener("close", () => {
            clearInterval(heartbeatInterval);
        });

        gateway.addEventListener("message", messageListener);

        function messageListener(msg) {
            const json = JSON.parse(msg.data);

            if (json.seq) seqAck = json.seq;

            if (json.op === 8) {
                heartbeatInterval = setInterval(() => send(3, { t: Date.now(), seq_ack: seqAck }), json.d.heartbeat_interval);
                send(0, {
                    server_id: options.guildId,
                    user_id: options.userId,
                    session_id: options.sessionId,
                    token: options.token
                });
            }
            if (json.op === 2) {
                gateway.removeEventListener("message", messageListener);
                resolve({
                    connection: gateway,
                    send,
                    address: json.d.ip,
                    port: json.d.port,
                    ssrc: json.d.ssrc,
                    modes: json.d.modes
                });
            }
        }

        function send(op, data) {
            gateway.send(JSON.stringify({
                op,
                d: data
            }));
        }
    });
}

function createUdpConnection(address, port) {
    const socket = dgram.createSocket("udp4");

    function send(data, callback) {
        socket.send(data, port, address, callback);
    }

    return {
        connection: socket,
        send,
        address,
        port
    }
}

function performIpDiscovery(udpConnection, ssrc) {
    return new Promise((resolve, reject) => {
        const ipDiscoveryRequest = Buffer.alloc(74);
        ipDiscoveryRequest[1] = 0x01;
        ipDiscoveryRequest.writeUInt16BE(70, 2);
        ipDiscoveryRequest.writeUInt32BE(ssrc, 4);
        ipDiscoveryRequest.write(udpConnection.address, 8);
        ipDiscoveryRequest.writeUInt16BE(udpConnection.port, 72);

        udpConnection.send(ipDiscoveryRequest);

        udpConnection.connection.addListener("message", messageListener);

        function messageListener(msg) {
            if (msg[1] !== 2) return;
            const address = msg.subarray(8, 72).toString();
            const port = msg.readUInt16BE(72);
            udpConnection.connection.removeListener("message", messageListener);
            resolve({
                address,
                port
            });
        }
    });
}

function selectProtocol(voiceGateway, options) {
    return new Promise((resolve, reject) => {
        voiceGateway.send(1, {
            protocol: "udp",
            data: {
                address: options.address,
                port: options.port,
                mode: options.mode
            }
        });

        voiceGateway.connection.addEventListener("message", messageListener);

        function messageListener(msg) {
            const json = JSON.parse(msg.data);

            if (json.op === 4) {
                voiceGateway.connection.removeEventListener("message", messageListener);
                if (json.d.mode !== options.mode) return reject(`${json.d.mode} was selected instead of ${options.mode}`);
                if (json.d.audio_codec !== options.audioCodec) return reject(`${json.d.audio_codec} was selected instead of ${options.audioCodec}`);
                resolve({
                    secretKey: json.d.secret_key,
                    secretKeyBuffer: Buffer.from(json.d.secret_key),
                    mode: json.d.mode,
                    audioCodec: json.d.audio_codec
                })
            }
        }
    });
}

function setSpeaking(voiceGateway, speaking, current) {
    if (speaking === current) return;
    voiceGateway.send(5, {
        speaking: speaking ? 1 : 0,
        delay: 0,
        ssrc: voiceGateway.ssrc
    });
}

function createPacket(data, sequence, timestamp, ssrc, secretKey, nonce) {
    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 0x80;
    rtpHeader[1] = 0x78;
    rtpHeader.writeUInt16BE(sequence, 2);
    rtpHeader.writeUInt32BE(timestamp, 4);
    rtpHeader.writeUInt32BE(ssrc, 8);

    const encryptedData = encryptData(data, rtpHeader, secretKey, nonce);

    const packet = Buffer.concat([
        rtpHeader,
        encryptedData
    ]);

    return packet;
}

function encryptData(data, rtpHeader, secretKey, nonce) {
    const nonceBuffer = Buffer.alloc(12);
    nonceBuffer.writeUInt32BE(nonce);

    const noncePadding = nonceBuffer.subarray(0, 4);

    const cipher = crypto.createCipheriv("aes-256-gcm", secretKey, nonceBuffer);
    cipher.setAAD(rtpHeader);

    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag(), noncePadding]);
}

function sendData(data, udpConnection, sequence = 0, timestamp = 0, ssrc, secretKey, nonce) {
    return new Promise((resolve, reject) => {
        const packet = createPacket(data, sequence, timestamp, ssrc, secretKey, nonce);
        udpConnection.send(packet, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function ffmpeg(input, args = []) {
    ffmpegProcess = cp.spawn("ffmpeg", [
        "-i", input,
        ...args,
        "-"
    ]);

    return ffmpegProcess;
}

// TODO: find way to play new media without fucking timestamp
let nonce = 0;
let sequence = 0;
let timestamp = 0;
function play(input, voiceGateway, udpConnection, secretKey) {
    const listeners = [];
    const silenceFrame = Buffer.from([248, 255, 254]);
    const queue = [];
    let packetsPlayed = 0;
    let time = null;
    let building = true;
    let playing = false;
    let stopped = false;
    let duration = null;
    let playedDuration = 0;
    let stopping = false;
    let speaking = false;

    setSpeaking(voiceGateway, false);

    const ffmpegProcess = ffmpeg(input, [
        "-c:a", "libopus",
        "-f", "opus",
        "-ar", "48000",
        "-ac", "2",
        ...extraFfmpegArgs
    ]);

    ffmpegProcess.stdout.on("data", data => {
        if (stopping || stopped) return;

        const pageSegments = data.readUInt8(26);
        const table = data.slice(27, 27 + pageSegments);

        let sizes = [];
        let totalSize = 0;
        let i = 0;
        while (i < pageSegments) {
            let size = 0;
            let x = 255;
            while (x === 255) {
                x = table.readUInt8(i++);
                size += x;
            }
            sizes.push(size);
            totalSize += size;
        }

        let start = 27 + pageSegments;
        for (const size of sizes) {
            const segment = data.slice(start, start + size);
            duration += 20;
            queue.push(segment);
            if (queue.length === 1) send();
            start += size;
        }
    });

    ffmpegProcess.stdout.on("close", () => {
        console.log(`Finished building, ${duration / 1000} seconds of playback`);
        building = false;
        if (!playing) {
            stopped = true;
            call("stopped");
        }
    });

    function send() {
        if (!queue.length) {
            if (!building && !stopped && !stopping) stop();
            return;
        }

        if (!playing) {
            console.log(`Playing ${input} with args ${extraFfmpegArgs.join(" ")}`);
            playing = true;
            call("playing");
        }

        nonce++;
        sequence++;
        timestamp += (48000 / 100) * 2;
        if (nonce >= 2 ** 32) nonce = 0;
        if (sequence >= 2 ** 16) sequence = 0;
        if (timestamp >= 2 ** 32) timestamp = 0;

        setSpeaking(voiceGateway, true, speaking);
        speaking = true;

        if (time === null) time = Date.now();
        time += 20;
        
        const data = queue[0];
        return sendData(data, udpConnection, sequence, timestamp, voiceGateway.ssrc, secretKey, nonce).then(() => {
            playedDuration += 20;
            packetsPlayed++;
            queue.shift();
            const timeout = time - Date.now();
            console.log("Packet:", packetsPlayed, "Size:", data.byteLength, "Timestamp:", timestamp, "Next packet:", timeout, "Played:", playedDuration, "Remaining:", queue.length * 20);
            if (timeout > 0) setTimeout(send, timeout); else send();
        });
    }

    function stop() {
        stopping = true;
        queue.splice(0, queue.length);

        let silentTime = null;
        let silenceFramesSent = 0;
        
        (function sendSilenceFrame() {
            if (silentTime === null) silentTime = Date.now();
            silentTime += 20;

            sendData(silenceFrame, udpConnection, sequence, timestamp, voiceGateway.ssrc, secretKey, nonce).then(() => {
                console.log("Sent silence frame");
                silenceFramesSent++;
                packetsPlayed++;
                if (silenceFramesSent >= 5) {
                    stopping = false;
                    stopped = true;
                    if (building) ffmpegProcess.kill("SIGKILL");
                    setSpeaking(voiceGateway, false);
                    call("stopped");
                } else {
                    const timeout = silentTime - Date.now();
                    if (timeout > 0) setTimeout(sendSilenceFrame, timeout); else sendSilenceFrame();
                }
            });
        })();
    }

    function getStatus() {
        return {
            input,
            packetsPlayed,
            playing,
            building,
            stopping,
            stopped,
            duration,
            playedDuration,
            queue,
        }
    }

    function call(event, ...args) {
        for (let listenerIndex = listeners.length - 1; listenerIndex >= 0; listenerIndex--) {
            const listener = listeners[listenerIndex];
            if (listener.event.toLowerCase() !== event.toLowerCase()) continue;
            listener.callback(...args);
            if (listener.once) listeners.splice(listenerIndex, 1);
        }
    }

    function on(event, callback) {
        listeners.push({ event, callback, once: false });
    }

    function once(event, callback) {
        listeners.push({ event, callback, once: true });
    }

    return {
        call,
        on,
        once,
        stop,
        getStatus
    };
}