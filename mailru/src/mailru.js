// Dynamic port of transport/mailru/mailru.go in openflux-server: tunnels
// packets through the "cursor" field of Mail.ru's public-document coauthoring
// WebSocket, with the same constants, timings and message shapes.
//
// The Go<->JS packet boundary (write()/emit()) carries raw bytes as
// ArrayBuffers; mailru's own wire format needs those bytes as base64 text
// spliced into the cursor field, so this script calls the host's
// base64.encode/decode explicitly at that one seam - fast (native Go
// codec, no hand-rolled JS base64) and the only place bytes<->text
// conversion happens at all.

// Mail.ru turns away a browser that is too old, so the user agent follows the
// browsers' four-week release cycle (newest first) and the next candidate is
// tried after a 409/403 on the WebSocket upgrade.
var ACCEPT_LANGUAGE = "ru-RU,ru;q=0.9,en;q=0.8"; // the document server's nginx answers 409 without it
var uaIdx = 0;

function weeksSince(epochMs) {
  var days = Math.floor((Date.now() - epochMs) / 86400000);
  return Math.floor(Math.max(days - 42, 0) / 28);
}

function userAgents() {
  var ff = 143 + weeksSince(Date.UTC(2025, 8, 16));
  var ch = 140 + weeksSince(Date.UTC(2025, 8, 2));
  var firefox = function (v) {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:" + v + ".0) Gecko/20100101 Firefox/" + v + ".0";
  };
  var chrome = function (v) {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + ".0.0.0 Safari/537.36";
  };
  return [firefox(ff), chrome(ch), firefox(ff - 1), chrome(ch - 1), firefox(155)];
}

function userAgent() {
  var list = userAgents();
  return list[uaIdx % list.length];
}
var CURSOR_RE = /"cursor":"[^;]+;([^"]+)"/g;
var KEEPALIVE_MS = 10000; // transport.DefaultConfig().KeepAliveInterval

// The document server drops a cursor whose number is not the real byte length of its payload ("access deny").
var KEEPALIVE_RAW = "---KA---";
var KEEPALIVE_B64 = "LS0tS0EtLS0="; // base64 of KEEPALIVE_RAW

function cursorMessage(b64, byteLength) {
  return '42["message",{"type":"cursor","cursor":"' + byteLength + ";" + b64 + '"}]';
}

var MAX_RECONNECT_ATTEMPTS = 999999; // transport.DefaultConfig().MaxReconnectAttempts

var weblink = "";
var running = false;
var sock = null;
var baseUserID = "";
var userID = null;
var userCounter = 0;
var connectedAt = null;
var keepAliveTimer = null;
var docInfo = null; // the live session's fetchDocInfo result (editor user id for saveChanges)
var connectGen = 0; // bumped by every connectToDoc: a stale attempt closes what it opened
var reconnectTimer = null; // at most one reconnect pending

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = "0" + s;
  return s;
}

function randUserID() {
  return pad(Math.floor(Math.random() * 1000000000), 10);
}

// cursorPayloads: the base64 payload of every cursor entry in a server
// message, in order, without the keep-alive entries (a batched message may
// carry several, a peer's keep-alive among them).
function cursorPayloads(text) {
  var out = [];
  var m;
  CURSOR_RE.lastIndex = 0;
  while ((m = CURSOR_RE.exec(text)) !== null) {
    if (m[1] && m[1] !== KEEPALIVE_RAW && m[1] !== KEEPALIVE_B64) out.push(m[1]);
  }
  return out;
}

// normalizeWeblink accepts either a bare weblink ("AbCdEfGh1/IjKlMnOp2") or
// a full public URL, same as NewMailruDocsTransport.
function normalizeWeblink(link) {
  link = String(link).trim();
  var prefixes = [
    "https://cloud.mail.ru/public/",
    "http://cloud.mail.ru/public/",
    "https://cloud.mail.ru/",
    "http://cloud.mail.ru/",
  ];
  for (var i = 0; i < prefixes.length; i++) {
    if (link.indexOf(prefixes[i]) === 0) {
      return link.slice(prefixes[i].length).replace(/^\/+|\/+$/g, "");
    }
  }
  return link;
}

// reconnectBackoff: exponential with jitter, capped at 15s - identical
// formula to reconnectBackoff() in mailru.go.
function reconnectBackoff(n) {
  if (n < 1) n = 1;
  var shift = n - 1;
  if (shift > 5) shift = 5;
  var d = 500 * Math.pow(2, shift);
  if (d > 15000) d = 15000;
  d += Math.floor(Math.random() * (d / 2 + 1));
  return d;
}

function scheduleReconnect(attempt) {
  var next = attempt + 1;
  if (!running || next >= MAX_RECONNECT_ATTEMPTS) return;
  if (reconnectTimer) return; // one is already pending: a second would open a duplicate session
  var d = reconnectBackoff(next);
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    if (!running) return;
    connectToDoc(next);
  }, d);
}

// fetchDocInfo POSTs to Mail.ru's public-document editor API and returns
// the fields needed to open the collaborative WebSocket - same endpoint,
// headers and field extraction as fetchDocInfo() in mailru.go.
async function fetchDocInfo(link) {
  var body = JSON.stringify({
    "x-email": "anonym",
    public: "/" + link,
    platform: "desktop_web",
  });
  var res = await http.fetch({
    url: "https://cloud.mail.ru/api/v4/r7/edit",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": userAgent(),
      "Accept-Language": ACCEPT_LANGUAGE,
      "X-Api-Version": "4",
      Referer: "https://cloud.mail.ru/public/" + link + "?weblink=" + link,
    },
    body: body,
  });
  if (res.status !== 200) {
    throw new Error("mailru: api returned status " + res.status);
  }
  var data = JSON.parse(res.body);
  var doc = data.document;
  if (!doc) throw new Error("mailru: document object missing");
  var editorConfig = data.editorConfig;
  if (!editorConfig) throw new Error("mailru: editorConfig object missing");

  var apiBase = data.api || "";
  var wsBase = apiBase.replace("https://", "wss://");
  return {
    token: data.token || "",
    docKey: doc.key,
    wsURL: wsBase + "/doc/" + doc.key + "/c/?EIO=4&transport=websocket",
    fileType: doc.fileType,
    docUrl: doc.url,
    docTitle: doc.title,
    // document.permissions is an object of booleans, not a number -
    // sending it as anything else makes the editor server reject the auth
    // message with "access deny" (same caveat as the native transport).
    permissions: doc.permissions || {},
    callbackUrl: editorConfig.callbackUrl || "",
    editorUserId: (editorConfig.user && editorConfig.user.id) || "",
  };
}

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(function () {
    if (!sock) return;
    try {
      sock.send(cursorMessage(KEEPALIVE_B64, KEEPALIVE_RAW.length));
    } catch (e) {
      // Same as the native keep-alive: a write that fails means a dead
      // connection - close it so the reconnect (via onclose) happens.
      setState("reconnecting", String(e));
      try {
        sock.close();
      } catch (e2) {}
    }
  }, KEEPALIVE_MS);
}

function handleMessage(text) {
  // Socket.IO ping/pong.
  if (text === "2") {
    if (sock) {
      try {
        sock.send("3");
      } catch (e) {}
    }
    return;
  }
  if (text === "3") return;

  if (text.indexOf('"type":"auth"') !== -1 && text.indexOf('"result":1') !== -1) {
    return; // auth ack - fire-and-forget, same as the native transport
  }

  if (text.indexOf("cursor") !== -1) {
    // One server message may carry several cursor entries (it batches them
    // under load), a peer's keep-alive among them: deliver every payload, in
    // order.
    var payloads = cursorPayloads(text);
    for (var i = 0; i < payloads.length; i++) {
      var bytes;
      try {
        bytes = base64.decode(payloads[i]); // cursor field is base64 text -> bytes
      } catch (e) {
        continue;
      }
      emit(bytes);
    }
  }
}

function onSocketClose(attempt) {
  sock = null;
  docInfo = null;
  var next = attempt;
  // A connection that had been up for >15s gets the fast (attempt=1)
  // backoff on its next try instead of continuing to climb - identical to
  // the `next = -1` branch in mailru.go's read-error handler.
  if (connectedAt !== null && Date.now() - connectedAt > 15000) {
    next = -1;
  }
  if (running) setState("reconnecting");
  scheduleReconnect(next);
}

function connectToDoc(attempt) {
  if (!running) return;
  var myGen = ++connectGen;

  (async function () {
    try {
      var info = await fetchDocInfo(weblink);
      if (myGen !== connectGen || !running) return; // superseded while fetching
      var newSock = await ws.open(info.wsURL, {
        "User-Agent": userAgent(),
        "Accept-Language": ACCEPT_LANGUAGE,
        Origin: "https://docs.datacloudmail.ru",
      });
      if (myGen !== connectGen || !running) {
        try {
          newSock.close();
        } catch (e) {}
        return;
      }

      sock = newSock;
      docInfo = info;
      if (userID === null) {
        userID = baseUserID + pad(userCounter++ % 1000, 3);
      }

      sock.onmessage = handleMessage;
      sock.onclose = function () {
        if (sock !== newSock) return; // a socket we already replaced or dropped on purpose
        onSocketClose(attempt);
      };

      // Auth fires immediately, same as the native transport: Mail.ru's
      // coauthoring server buffers these until its own session state
      // catches up, and waiting for an explicit ack here only stretches
      // the outage window on every reconnect.
      sock.send('40{"token":"' + info.token + '"}');

      var authMsg = {
        type: "auth",
        docid: info.docKey,
        documentCallbackUrl: info.callbackUrl,
        token: "fghhfgsjdgfjs",
        user: { id: info.editorUserId, username: userID, indexUser: -1 },
        editorType: 0,
        lastOtherSaveTime: -1,
        block: [],
        documentFormatSave: 65,
        view: false,
        isCloseCoAuthoring: false,
        openCmd: {
          c: "open",
          id: info.docKey,
          userid: info.editorUserId,
          format: info.fileType,
          url: info.docUrl,
          title: info.docTitle,
          lcid: 25,
          nobase64: true,
          convertToOrigin: ".pdf.xps.oxps.djvu",
        },
        lang: "ru",
        mode: "edit",
        permissions: info.permissions,
        IsAnonymousUser: false,
        timezoneOffset: -180,
        coEditingMode: "fast",
        jwtOpen: info.token,
        time: 1000,
        supportAuthChangesAck: true,
      };
      sock.send('42' + JSON.stringify(["message", authMsg]));

      connectedAt = Date.now();
      setState("connected");
    } catch (e) {
      if (/\b(409|403)\b/.test(String(e))) uaIdx++;
      setState("reconnecting", String(e));
      scheduleReconnect(attempt);
    }
  })();
}

var Transport = {
  info: function () {
    return {
      name: "mailru",
      version: "1.2.0",
      cookieDomain: "https://cloud.mail.ru/",
      mtu: 0, // unbounded - native mailru never fragments either
      reliable: false,
      ordered: false,
      halfDuplex: false,
      minIntervalMs: 0,
      params: [
        {
          key: "url",
          label: "Mail.ru public document link or weblink",
          type: "url",
          required: true,
        },
      ],
    };
  },

  open: function (cfg) {
    var raw = (cfg.params && cfg.params.url) || cfg.url || "";
    weblink = normalizeWeblink(raw);
    baseUserID = randUserID();
    running = true;
    startKeepAlive();
    connectToDoc(0);
  },

  write: function (bytes) {
    if (!sock) throw new Error("mailru: not connected");
    sock.send(cursorMessage(base64.encode(bytes), bytes.byteLength));
  },

  close: function () {
    running = false;
    connectGen++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (sock) {
      try {
        sock.close();
      } catch (e) {}
    }
    sock = null;
  },

  // Generic cookie exchange (see host.go / transport.go FetchCookies /
  // ApplyCookies): Go reads cookies straight out of the shared jar with no
  // help from this script, but only the script can make an already-open
  // socket pick up freshly applied cookies - so it reacts to this event by
  // forcing a reconnect, same as ApplyCookies forcing t.session = nil in
  // the native transport.
  onEvent: function (kind) {
    if (kind === "cookiesApplied") {
      userID = null;
      docInfo = null;
      connectGen++; // drop an attempt in flight: the one below starts from the new cookies
      var old = sock;
      sock = null; // its onclose is ignored (sock !== newSock): one reconnect, below
      if (old) {
        try {
          old.close();
        } catch (e) {}
      }
      setState("reconnecting");
      scheduleReconnect(0);
    }
  },
};
