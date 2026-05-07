import Gun from 'gun';
import WebTorrent from 'webtorrent';
import * as mm from 'https://esm.sh/music-metadata@10.6.0?bundle';
import { config } from '../config.js';
import { GunProxy } from '../websocketproxy.js';
import { joinRoom } from 'https://esm.run/@trystero-p2p/torrent';

// Initialize P2P Proxy for Gun
const proxy = new GunProxy();
const WebSocketProxy = proxy.initialize({
    trystero_enabled: true,
    trystero_app_id: 'film-tv-v1',
    trystero_mesh_id: 'global-discovery',
    trackers: config.trackers
}, joinRoom);

const safeBtoa = (str) => btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1)));

const gun = Gun({
    peers: [...config.gunRelays, 'proxy:websocket'],
    WebSocket: WebSocketProxy
});

// Attach Gun internal listeners to the proxy
proxy.attachGun(gun);

// ── Single WebTorrent instance, created immediately at page load ──────────────
const client = new WebTorrent({
    maxConns: 55,
});
client.on('error', (err) => console.error('[WebTorrent] Error:', err));
client.on('warning', (w) => console.warn('[WebTorrent] Warning:', w));

// Expose on window for debugging
window._wt = client;

// ── Service Worker + streaming server ─────────────────────────────────────────
// swReady resolves once the SW is activated and createServer() is called.
// All stream() calls await this promise so we never get 404s from the Python server.
let _swReadyResolve;
const swReady = new Promise(resolve => { _swReadyResolve = resolve; });

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.min.js', { scope: './' })
        .then(reg => {
            const activate = (worker) => {
                if (!worker) {
                    console.warn('[P2P] SW worker is null — resolving anyway');
                    _swReadyResolve();
                    return;
                }
                if (worker.state === 'activated') {
                    console.log('[P2P] SW ready — creating WebTorrent server');
                    client.createServer({ controller: reg });
                    _swReadyResolve();
                } else {
                    console.log('[P2P] SW state:', worker.state, '— waiting for activation');
                    worker.addEventListener('statechange', e => activate(e.target), { once: true });
                }
            };
            activate(reg.active || reg.waiting || reg.installing);
        })
        .catch(err => {
            console.error('[P2P] SW registration failed:', err);
            _swReadyResolve(); // unblock streaming
        });
} else {
    console.warn('[P2P] Service Workers not supported — streamTo() will fail');
    _swReadyResolve();
}

const coverCache = new Map();
const getNode = (mode, id) => gun.get('film-tv-v1').get(mode).get(id);

export const p2pService = {
    addLink: (mode, id, linkData) => {
        const node = gun.get('film-tv-v1').get(mode).get(id);
        const linkId = safeBtoa(linkData.url).replace(/[+/=]/g, '');
        node.get('links').get(linkId).put({
            ...linkData,
            timestamp: Date.now(),
            views: 0
        });
    },

    incrementView: (mode, id, linkId) => {
        const linkNode = getNode(mode, id).get('links').get(linkId);
        linkNode.get('views').once((v = 0) => {
            linkNode.get('views').put(v + 1);
        });
    },

    subscribeLinks: (mode, id, callback) => {
        return getNode(mode, id).get('links').map().on(callback);
    },

    addMusicEntry: (title, artist, initialLink = null, album = '', format = '', bitrate = '') => {
        const id = safeBtoa(`${artist.toLowerCase()}_${title.toLowerCase()}`).replace(/[+/=]/g, '');
        // Store streamLink directly in the index entry for fast UI access
        const entry = { 
            title, artist, id, album, format, bitrate, 
            timestamp: Date.now(),
            streamLink: (initialLink && initialLink.type === 'stream') ? initialLink.url : null
        };
        if (initialLink) {
            p2pService.addLink('music', id, initialLink);
        }
        gun.get('film-tv-v1').get('music-index').get(id).put(entry);
        return id;
    },

    subscribeMusicIndex: (callback) => {
        return gun.get('film-tv-v1').get('music-index').map().on(callback);
    },

    inspectMagnet: (magnet) => {
        return new Promise((resolve, reject) => {
            if (coverCache.has(magnet)) {
                return resolve(coverCache.get(magnet));
            }

            let torrent = client.torrents.find(t => t.magnetURI === magnet || t.infoHash === magnet);
            
            const onReady = async (t) => {
                try {
                    const supportedExts = ['.mp4', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac'];
                    const audioExts = ['.mp3', '.flac', '.wav', '.ogg'];
                    const imageExts = ['.jpg', '.jpeg', '.png'];
                    
                    const mediaFiles = t.files.filter(f => supportedExts.some(ext => f.name.toLowerCase().endsWith(ext)));
                    const audioFile = t.files.find(f => audioExts.some(ext => f.name.toLowerCase().endsWith(ext)));
                    const coverFile = t.files.filter(f => imageExts.some(ext => f.name.toLowerCase().endsWith(ext)))
                                           .sort((a, b) => b.length - a.length)[0];

                    if (mediaFiles.length === 0) {
                        reject('No playable files');
                        return;
                    }

                    let audioMeta = {};
                    if (audioFile) {
                        try {
                            const buffer = await audioFile.arrayBuffer({ start: 0, end: 2 * 1024 * 1024 });
                            const metadata = await mm.parseBuffer(new Uint8Array(buffer), {
                                mimeType: 'audio/' + audioFile.name.split('.').pop(),
                                size: audioFile.length
                            });
                            audioMeta = {
                                title: metadata.common.title,
                                artist: metadata.common.artist,
                                album: metadata.common.album,
                                bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : null,
                                format: metadata.format.container || audioFile.name.split('.').pop().toUpperCase()
                            };
                            if (metadata.common.picture && metadata.common.picture.length > 0) {
                                const pic = metadata.common.picture[0];
                                const blob = new Blob([pic.data], { type: pic.format });
                                const reader = new FileReader();
                                audioMeta.coverUrl = await new Promise(res => {
                                    reader.onload = () => res(reader.result);
                                    reader.readAsDataURL(blob);
                                });
                            }
                        } catch (e) { console.warn('[P2P] Metadata parse error:', e); }
                    }

                    const result = {
                        infohash: t.infoHash,
                        files: mediaFiles.map(f => f.name),
                        audioMeta
                    };

                    if (coverFile && !audioMeta.coverUrl) {
                        coverFile.getBlob(async (err, blob) => {
                            if (err || !blob) {
                                coverCache.set(magnet, result);
                                resolve(result);
                            } else {
                                const reader = new FileReader();
                                const base64 = await new Promise(res => {
                                    reader.onload = () => res(reader.result);
                                    reader.readAsDataURL(blob);
                                });
                                const finalResult = { ...result, coverUrl: base64 };
                                coverCache.set(magnet, finalResult);
                                resolve(finalResult);
                            }
                        });
                    } else {
                        coverCache.set(magnet, result);
                        resolve(result);
                    }
                } catch (e) { reject(e); }
            };

            if (torrent) {
                if (torrent.metadata) onReady(torrent);
                else torrent.on('metadata', () => onReady(torrent));
            } else {
                client.add(magnet, { announce: config.trackers, deselect: true }, onReady);
            }
        });
    },

    // stream(magnet, videoElement)
    // Waits for SW to be ready before calling file.streamTo() to avoid 404s.
    stream: async (magnet, videoElement) => {
        await swReady;  // ensure SW server is up before we set player.src

        // Extract infoHash for reliable torrent lookup.
        // WebTorrent normalises magnetURI on add (tracker order etc.), so
        // t.magnetURI === magnet often fails even for the same torrent.
        const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        const infoHash  = hashMatch ? hashMatch[1].toLowerCase() : null;

        let torrent = infoHash
            ? client.torrents.find(t => t.infoHash === infoHash)
            : client.torrents.find(t => t.magnetURI === magnet);

        const startStreaming = async (t) => {
            const supportedExts = ['.mp4', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac'];
            const file = t.files.find(f =>
                supportedExts.some(ext => f.name.toLowerCase().endsWith(ext)));
            if (!file) { console.warn('[WebTorrent] No playable file'); return; }

            console.log(`[WebTorrent] Torrent status: done=${t.done}, progress=${(t.progress*100).toFixed(1)}%, pieces=${t.pieces.length}`);
            
            const useBlob = async () => {
                try {
                    const blob = await file.blob();
                    const url = URL.createObjectURL(blob);
                    console.log('[WebTorrent] Switching to blob URL:', url);
                    const prev = videoElement._blobUrl;
                    videoElement.src = url;
                    if (prev) URL.revokeObjectURL(prev);
                    videoElement._blobUrl = url;
                } catch (e) {
                    console.warn('[WebTorrent] Blob switch failed:', e);
                }
            };

            if (t.done) {
                await useBlob();
            } else {
                file.select();
                const criticalEnd = Math.min(t.pieces.length - 1, 20);
                t.critical(0, criticalEnd);
                
                // If it finishes while we are watching, switch to blob for better stability
                t.once('done', () => {
                    console.log('[WebTorrent] Download finished, upgrading to blob...');
                    useBlob();
                });

                console.log('[WebTorrent] Streaming via SW:', file.streamURL);
                file.streamTo(videoElement);
            }
        };

        if (torrent) {
            if (torrent.ready) startStreaming(torrent);
            else torrent.once('ready', () => startStreaming(torrent));
        } else {
            client.add(magnet, { announce: config.trackers }, startStreaming);
        }
    },

    getTorrentStats: (magnet) => {
        const torrent = client.torrents.find(t => t.magnetURI === magnet || t.infoHash === magnet);
        if (!torrent) return null;
        return {
            peers: torrent.numPeers,
            downloadSpeed: torrent.downloadSpeed,
            progress: torrent.progress
        };
    },

    getMagnetLinkForMusic: (id) => {
        return new Promise((resolve) => {
            let found = false;
            gun.get('film-tv-v1').get('music').get(id).get('links').map().once((data) => {
                if (!found && data && data.type === 'magnet') {
                    found = true;
                    resolve(data.url);
                }
            });
            setTimeout(() => { if (!found) resolve(null); }, 5000);
        });
    },

    findLinkByType: async (id, type) => {
        return new Promise(resolve => {
            let found = false;
            gun.get('film-tv-v1').get('music-links').get(id).map().once((data) => {
                if (data && data.type === type && !found) {
                    found = true;
                    resolve(data.url);
                }
            });
            setTimeout(() => { if (!found) resolve(null); }, 2000);
        });
    },

    getMusicEntry: async (id) => {
        return new Promise(resolve => {
            gun.get('film-tv-v1').get('music-index').get(id).once((data) => {
                if (data && data.title) resolve(data);
                else resolve(null);
            });
            setTimeout(() => resolve(null), 3000);
        });
    },

    fetchMetadata: async (url) => {
        if (!url) return null;
        try {
            // Official Spotify oEmbed (No proxy needed, CORS allowed)
            if (url.includes('spotify.com')) {
                const encodedUrl = encodeURIComponent(url);
                const oembedEndpoint = `https://open.spotify.com/oembed?url=${encodedUrl}`;
                const response = await fetch(oembedEndpoint);
                if (response.ok) {
                    const data = await response.json();
                    let cover = data.thumbnail_url;
                    if (cover) {
                        cover = cover.replace('ab67616d00001e02', 'ab67616d0000b273');
                    }
                    let artist = data.author_name;
                    let title = data.title;

                    // Fallback for title/artist split
                    if (!artist && title && title.includes(' - ')) {
                        const parts = title.split(' - ');
                        artist = parts[0];
                        title = parts[1];
                    }

                    return { title, artist, cover };
                }
            }
            return null;
        } catch (e) {
            console.warn('[P2P] Metadata fetch failed:', e);
            return null;
        }
    },

    // Room Functionality
    createRoom: (roomId, name) => {
        const roomNode = gun.get('film-tv-v1').get('rooms').get(roomId);
        roomNode.put({
            id: roomId,
            name: name,
            createdAt: Date.now(),
            playback: { status: 'stopped', currentTime: 0, timestamp: Date.now() }
        });
        return roomId;
    },

    getRoom: (roomId, callback) => {
        return gun.get('film-tv-v1').get('rooms').get(roomId).on(callback);
    },

    joinRoom: (roomId, userData) => {
        // Use sessionStorage instead of localStorage so multiple tabs on localhost
        // get different user IDs and don't overwrite each other in Gun.
        const storageKey = `room_user_${roomId}`;
        let userId = sessionStorage.getItem(storageKey);
        if (!userId) {
            userId = safeBtoa(Math.random().toString()).slice(0, 8);
            sessionStorage.setItem(storageKey, userId);
        }
        localStorage.setItem('active_room', roomId);

        const trysteroId = proxy.getSelfId() || '';
        const userNode = gun.get('film-tv-v1').get('rooms').get(roomId).get('users').get(userId);
        
        const updateData = { 
            ...userData, 
            id: userId, 
            trysteroId: trysteroId || null,
            lastSeen: Date.now() 
        };
        userNode.put(updateData);
        
        console.log(`[P2P] Joined room ${roomId} as ${userData.name} (ID: ${userId}, Trystero: ${trysteroId || 'waiting...'})`);

        // If Trystero ID wasn't ready immediately, try again in 2 seconds
        if (!trysteroId) {
            setTimeout(() => {
                const lateId = proxy.getSelfId();
                if (lateId) {
                    console.log(`[P2P] Late Trystero ID recovery for ${userId}: ${lateId}`);
                    userNode.get('trysteroId').put(lateId);
                }
            }, 2000);
        }

        // Heartbeat
        const interval = setInterval(() => {
            userNode.get('lastSeen').put(Date.now());
        }, 15000);

        return { userId, unsubscribe: () => {
            clearInterval(interval);
            userNode.put(null);
        }};
    },

    subscribeUsers: (roomId, callback) => {
        return gun.get('film-tv-v1').get('rooms').get(roomId).get('users').map().on(callback);
    },

    addToPlaylist: (roomId, item) => {
        const itemId = safeBtoa(Math.random().toString()).slice(0, 8);
        gun.get('film-tv-v1').get('rooms').get(roomId).get('playlist').get(itemId).put({
            ...item,
            addedAt: Date.now()
        });
    },

    subscribePlaylist: (roomId, callback) => {
        return gun.get('film-tv-v1').get('rooms').get(roomId).get('playlist').map().on(callback);
    },

    // Real-time P2P Commands (Trystero actions)
    broadcastPlayback: null,
    onPlaybackCommand: (callback) => {
        if (!proxy.trystero_room) return;
        const [send, listen] = proxy.trystero_room.makeAction('playback-cmd');
        p2pService.broadcastPlayback = send;
        listen(callback);
    },

    updatePlayback: (roomId, playbackData) => {
        const safeData = {
            status: playbackData.status || 'stopped',
            magnet: playbackData.magnet || '',
            title: playbackData.title || '',
            currentTime: Number(playbackData.currentTime) || 0,
            serverTime: Number(playbackData.serverTime) || Date.now(),
            senderTime: Date.now(),
            timestamp: Date.now()
        };
        
        // 1. Update Gun (for late joiners and persistence)
        gun.get('film-tv-v1').get('rooms').get(roomId).get('playback').put(safeData);
        
        // 2. Broadcast via Trystero (for instant P2P sync)
        if (p2pService.broadcastPlayback) {
            console.log('[P2P] Broadcasting real-time command:', safeData.status);
            p2pService.broadcastPlayback(safeData);
        }
    },

    subscribePlayback: (roomId, callback) => {
        return gun.get('film-tv-v1').get('rooms').get(roomId).get('playback').on(callback);
    },

    // Ping mechanism: remote start/stop "empty player"
    measurePing: async (roomId, targetUserId) => {
        return new Promise(resolve => {
            const pingId = Math.random().toString(36).substring(7);
            const pingNode = gun.get('film-tv-v1').get('rooms').get(roomId).get('pings').get(targetUserId);
            
            const start = performance.now();
            pingNode.put({ id: pingId, type: 'ping', timestamp: Date.now() });
            
            const onPong = (data) => {
                if (data && data.id === pingId && data.type === 'pong') {
                    const rtt = performance.now() - start;
                    pingNode.off();
                    resolve(rtt / 2);
                }
            };
            pingNode.on(onPong);
            setTimeout(() => { pingNode.off(); resolve(200); }, 5000); // Fallback to 200ms
        });
    },

    listenPings: (roomId, userId, onPing) => {
        const pingNode = gun.get('film-tv-v1').get('rooms').get(roomId).get('pings').get(userId);
        pingNode.on((data) => {
            if (data && data.type === 'ping') {
                // Simulate "starting/stopping empty player"
                console.log('[Sync] Remote Ping: Starting temporary empty player...');
                const audio = new Audio(); // Empty audio
                audio.play().then(() => {
                    audio.pause();
                    console.log('[Sync] Remote Ping: Stopped temporary empty player.');
                    pingNode.put({ id: data.id, type: 'pong', timestamp: Date.now() });
                }).catch(e => {
                    pingNode.put({ id: data.id, type: 'pong', timestamp: Date.now() });
                });
                onPing && onPing(data);
            }
        });
    },

    onPeerLeave: (callback) => {
        proxy.onPeerLeave(callback);
    },

    getSelfId: () => proxy.getSelfId(),

    removeUserByTrysteroId: (roomId, trysteroId) => {
        if (!trysteroId) return;
        const usersNode = gun.get('film-tv-v1').get('rooms').get(roomId).get('users');
        usersNode.map().once((user, id) => {
            if (user && user.trysteroId === trysteroId) {
                console.log(`[P2P] Removing disconnected user ${user.name} (${id})`);
                usersNode.get(id).put(null);
            }
        });
    },

    removeUserById: (roomId, userId) => {
        if (!userId) return;
        gun.get('film-tv-v1').get('rooms').get(roomId).get('users').get(userId).put(null);
        console.log(`[P2P] Removed user ${userId} from room ${roomId}`);
    }
};
