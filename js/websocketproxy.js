const debug = true;

export const GunProxy = function () {
  const proxy = {};
  proxy.trystero_room = {};
  proxy.peerjs_peer = {};
  proxy.peerjs_conn = {};
  proxy.selfId = null;

  proxy.initialize = function (conf, joinRoom) {
    var config = {};
    config.trystero_enabled = conf.trystero_enabled ?? true;
    config.trystero_app_id = conf.trystero_app_id || "gun_dht";
    config.trystero_mesh_id = conf.trystero_mesh_id || "graph_universal_node";
    // For torrent strategy, we might want to pass trackers
    config.trystero_trackers = conf.trackers || [];

    if (joinRoom === undefined) config.trystero_enabled = false;

    config.peerjs_enabled = conf.peerjs_enabled ?? false;
    config.peerjs_mesh_id = conf.peerjs_mesh_id || "graph_universal_node";

    config.hyperdht_enabled = conf.hyperdht_enabled ?? false;
    config.hyperdht_hash = conf.hyperdht_hash || "graph_universal_node";

    proxy.queue = [];
    proxy.connected = false;

    if (config.trystero_enabled) {
      const trysteroConfig = { appId: config.trystero_app_id };
      if (config.trystero_trackers.length > 0) {
        trysteroConfig.trackers = config.trystero_trackers;
      }
      
      proxy.trystero_room = joinRoom(trysteroConfig, config.trystero_mesh_id);
      
      proxy.trystero_room.onPeerJoin(id => {
        console.log(`[Proxy] Trystero ID: ${id} joined`);
        proxy.connected = true;
        // Flush queue
        if (proxy.queue.length > 0) {
          console.log(`[Proxy] Flushing ${proxy.queue.length} queued messages`);
          proxy.queue.forEach(msg => proxy.sender(msg));
          proxy.queue = [];
        }
        proxy.peerListeners.join.forEach(fn => fn(id));
      });
      
      proxy.trystero_room.onPeerLeave(id => {
        console.log(`[Proxy] Trystero ID: ${id} left`);
        proxy.peerListeners.leave.forEach(fn => fn(id));
      });
      
      const [sendMsg, onMsg] = proxy.trystero_room.makeAction('gun-protocol');
      onMsg(proxy.receiver);
      proxy.addSender(sendMsg);
    }

    // ... (WebSocketProxy definitions)
    const WebSocketProxy = function (url) {
      // ... same as before
      const websocketproxy = {
        url: url || 'ws:proxy',
        readyState: 1,
        bufferedAmount: 0,
        send: (msg) => proxy.sender(msg),
        close: () => {},
        onopen: () => {},
        onmessage: () => {},
        onerror: () => {}
      };
      proxy.proxyurl = websocketproxy.url;
      return websocketproxy;
    };

    return WebSocketProxy;
  };

  proxy.listeners = [];
  proxy.addListener = (listener) => proxy.listeners.push(listener);

  proxy.receiver = function (data) {
    if (debug) console.log('[Proxy] Receiver:', data);
    proxy.listeners.forEach(fn => fn(data));
  };

  proxy.senders = [];
  proxy.addSender = (sender) => proxy.senders.push(sender);

  proxy.sender = function (msg) {
    if (!proxy.connected && proxy.senders.length > 0) {
      if (debug) console.log('[Proxy] Not connected to peers, queuing message');
      proxy.queue.push(msg);
      return;
    }
    if (debug) console.log('[Proxy] Sender:', msg);
    proxy.senders.forEach(fn => fn(msg));
  };

  proxy.peerListeners = { join: [], leave: [] };
  proxy.onPeerJoin = (fn) => proxy.peerListeners.join.push(fn);
  proxy.onPeerLeave = (fn) => proxy.peerListeners.leave.push(fn);
  proxy.getSelfId = () => proxy.trystero_room ? proxy.trystero_room.selfId : null;

  proxy.attachGun = function (gun) {
    if (gun._.opt.peers[proxy.proxyurl] && gun._.opt.peers[proxy.proxyurl].wire) {
        proxy.addListener(gun._.opt.peers[proxy.proxyurl].wire.onmessage);
        console.log('[Proxy] Gun attached successfully');
    } else {
        console.warn('[Proxy] Gun not ready yet, retrying attachment...');
        setTimeout(() => proxy.attachGun(gun), 500);
    }
  };

  proxy.shutdown = function () {
    if (proxy.peerjs_conn.close) proxy.peerjs_conn.close();
    if (proxy.trystero_room.leave) proxy.trystero_room.leave();
  };

  return proxy;
};
